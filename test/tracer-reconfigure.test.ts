import { describe, it, expect, vi, afterEach } from "vitest";
import { configure } from "../src/index.js";
import { requireConfig } from "../src/config.js";
import { SPAN_INGEST_PATH } from "../src/tracing/exporter.js";

/**
 * configure() builds a fresh TracerProvider. Replacing the module's reference
 * to the old one without flushing it discarded everything still sitting in its
 * BatchSpanProcessor queue - and shutdown()/the beforeExit hook can only reach
 * the LAST provider, so those spans were gone for good.
 *
 * It failed silently: the observation still carried a trace id (that comes from
 * the span context, exported or not), so the only symptom was spans quietly
 * missing from the `spans` table. Any app that calls configure() more than once
 * - switching keys, tests, per-tenant setup - lost telemetry with no signal.
 */
describe("configure() called more than once", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("flushes spans buffered by the provider it replaces", async () => {
    const exported: string[] = [];
    globalThis.fetch = (async (input: unknown, init: { body?: string }) => {
      const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
      if (url.includes(SPAN_INGEST_PATH) && init?.body) {
        for (const span of JSON.parse(init.body) as { name: string }[]) exported.push(span.name);
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    configure({ gatewayUrl: "http://localhost:8787", gatewayKey: "obs_first", insecure: true });
    requireConfig().tracer.startActiveSpan("buffered-under-first-provider", (span) => span.end());

    // BatchSpanProcessor batches on a timer (5s by default), so the span is
    // still queued - which is exactly the state that used to be discarded.
    expect(exported).toEqual([]);

    configure({ gatewayUrl: "http://localhost:8787", gatewayKey: "obs_second", insecure: true });

    await vi.waitFor(() => {
      expect(exported).toContain("buffered-under-first-provider");
    });
  });
});
