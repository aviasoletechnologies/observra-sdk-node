import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { Tracer } from "@opentelemetry/api";
import { GatewayExporter } from "./exporter.js";
import { ATTR } from "./conventions.js";
import { abortInternalTraffic } from "../internal/lifecycle.js";

/**
 * Builds a private TracerProvider instance - deliberately never calls
 * trace.setGlobalTracerProvider(). A host app embedding this SDK may run its
 * own OTel stack; this SDK must be safe to drop into that environment
 * without conflict (plan.md requirement #2). BatchSpanProcessor's default
 * maxQueueSize/maxExportBatchSize are left as-is (bounded, not overridden to
 * unbounded) - plan.md requirement #3.
 */
export function createTracer(options: {
  gatewayUrl: string;
  gatewayKey: string;
  serviceName?: string;
}): Tracer {
  const resource = resourceFromAttributes({
    [ATTR.SERVICE_NAME]: options.serviceName ?? "observra-app",
  });

  const provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new GatewayExporter(options.gatewayUrl, options.gatewayKey))],
  });

  // Flush whatever the outgoing provider still had queued before dropping the
  // only reference to it. Overwriting activeProvider on its own orphaned that
  // queue: shutdown() and the beforeExit hook can only ever flush the LAST
  // provider, so every span buffered under an earlier configure() was silently
  // discarded. Nothing surfaced the loss - the observation still carried a
  // trace id, because that comes from the span context whether or not the span
  // is ever exported - so ADR-006 correlation just had holes in it.
  //
  // Not awaited: createTracer is synchronous and on the caller's configure()
  // path, and this is the old provider's flush - the new one is already usable.
  // provider.shutdown() never rejects here (the exporter swallows its own
  // errors), and the catch is belt-and-braces so telemetry cleanup can never
  // fail a caller's configure().
  const previous = activeProvider;
  if (previous) void Promise.resolve(previous.shutdown()).catch(() => {});

  activeProvider = provider;
  return provider.getTracer("observra");
}

let activeProvider: BasicTracerProvider | null = null;

// Node's equivalent of Python's atexit hook - flush buffered spans before
// process exit so nothing sits in the queue unexported. "beforeExit" (not
// "exit") because it still allows async work.
//
// Registered once for the module, not once per createTracer() call: an app
// that calls configure() repeatedly (tests do) otherwise piles up a listener
// each time and trips Node's MaxListenersExceededWarning.
//
// This covers a natural exit ONLY. Node does not emit "beforeExit" when
// process.exit() is called, and an "exit" handler cannot run async work, so
// no hook can rescue an app that exits explicitly - it must await shutdown().
process.once("beforeExit", () => {
  void shutdown();
});

/**
 * Flushes buffered spans and closes the SDK's connections to the gateway.
 *
 * Await this before process.exit(). Two things go wrong otherwise, both
 * because process.exit() skips "beforeExit" and destroys the event loop
 * immediately: buffered spans are silently dropped, and a still-open pooled
 * connection makes libuv abort the process (see internal/lifecycle.ts).
 *
 * Safe to call more than once, safe to call before configure(), and never
 * throws - telemetry cleanup must not fail the caller's shutdown path.
 *
 * One-way, by design: it aborts the SDK's internal traffic permanently, so
 * spans stop being exported and guardrail rules stop refreshing after it.
 * That is correct for a process on its way out, but it does mean this is not
 * a "pause" - a process that keeps running after calling it keeps working,
 * silently untelemetered.
 */
export async function shutdown(): Promise<void> {
  const provider = activeProvider;
  activeProvider = null;
  try {
    await provider?.shutdown();
  } catch {
    // Telemetry cleanup is not the caller's business - never throw.
  }
  abortInternalTraffic();
}
