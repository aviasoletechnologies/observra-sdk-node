import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { trace } from "@opentelemetry/api";
import { configure, instrument } from "../src/index.js";
import { requireConfig } from "../src/config.js";

const GATEWAY_URL = "http://localhost:8787";
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * The fetch patch opens a span for gateway-bound calls that nothing else is
 * tracing - that is what gives the native-SDK path a trace_id. These tests
 * pin both halves of that rule: it must trace an untraced call, and it must
 * NOT trace one that already has an active span (which would double-count
 * every wrapper-class and LangChain request).
 *
 * No network: the recorder installed below replaces fetch entirely and never
 * calls through, so these assert the patch's behaviour, not the gateway's.
 */
describe("fetch patch: span opening", () => {
  let sent: Array<{ url: string; traceparent: string | null }> = [];

  beforeAll(async () => {
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: "obs_test", insecure: true });

    // Installed BEFORE instrument() so instrument()'s patch wraps this one
    // and we observe the request as finally sent. Installed after, we would
    // record the pre-patch request and conclude the patch does nothing.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(
        init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined),
      );
      sent.push({ url, traceparent: headers.get("traceparent") });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await instrument();
    // instrument() now makes its own real fetch call - priming guardrail
    // rules from the gateway - which the recorder above just captured as
    // setup noise. Discarding it here, rather than filtering by URL in the
    // recorder, keeps the recorder honest: a test later in this file
    // deliberately fetches /__observability/spans itself to assert the patch
    // leaves it untraced, and a blanket URL filter would hide that call from
    // `sent` too and make that assertion pass for the wrong reason.
    sent = [];
  });

  afterEach(() => {
    sent = [];
  });

  it("opens a span for an untraced gateway-bound call, so a traceparent goes out", async () => {
    await fetch(`${GATEWAY_URL}/groq/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [] }),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].traceparent).toMatch(TRACEPARENT_RE);
  });

  it("reuses the caller's span instead of opening a second one", async () => {
    // Mirrors what GatewayTransport and the LangChain patch do: start a span,
    // then fetch inside it. The patch must join that span, not nest under it.
    const tracer = requireConfig().tracer;
    let outerSpanId = "";

    await tracer.startActiveSpan("caller.span", async (span) => {
      const carrier = trace.getActiveSpan()?.spanContext();
      outerSpanId = carrier?.spanId ?? "";
      await fetch(`${GATEWAY_URL}/groq/openai/v1/chat/completions`, { method: "POST", body: "{}" });
      span.end();
    });

    expect(sent).toHaveLength(1);
    const match = TRACEPARENT_RE.exec(sent[0].traceparent ?? "");
    expect(match).not.toBeNull();
    // Same span id as the caller's = no second span was created for the call.
    expect(match![2]).toBe(outerSpanId);
  });

  it("does not send a traceparent to a non-gateway host", async () => {
    // Trace context identifies our own request chain; leaking it to an
    // unrelated third-party host is not something a customer opted into.
    await fetch("https://example.com/webhook", { method: "POST", body: "{}" });

    expect(sent).toHaveLength(1);
    expect(sent[0].traceparent).toBeNull();
  });

  it("rewrites a native provider origin and traces it in one pass", async () => {
    await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer gsk_fake", "content-type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [] }),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${GATEWAY_URL}/groq/openai/v1/chat/completions`);
    expect(sent[0].traceparent).toMatch(TRACEPARENT_RE);
  });

  it("never traces the SDK's own span-export traffic", async () => {
    // Regression: the exporter POSTs to the gateway, so it is gateway-bound
    // and (running on the batch processor's timer) has no active span. Left
    // unguarded the patch traced it, which emitted a span, which was
    // exported, which emitted another - an unbounded feedback loop. Caught
    // live as a stray `gateway.chat` span with no matching observation.
    await fetch(`${GATEWAY_URL}/__observability/spans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].traceparent).toBeNull();
  });

  it("never overwrites a traceparent the caller already set, and opens no span for it", async () => {
    // Regression: postStream opens a NON-active span and injects the header
    // itself, because a generator's body runs outside the caller's context.
    // Checking only trace.getActiveSpan() missed that and opened a second,
    // unrelated span for every streamed call - visible live as a stray
    // `gateway.chat` span whose trace id matched no observation. An
    // outgoing traceparent means someone is already tracing this call.
    const caller = "00-11111111111111111111111111111111-2222222222222222-01";
    await fetch(`${GATEWAY_URL}/groq/openai/v1/chat/completions`, {
      method: "POST",
      headers: { traceparent: caller },
      body: "{}",
    });

    expect(sent[0].traceparent).toBe(caller);
  });
});
