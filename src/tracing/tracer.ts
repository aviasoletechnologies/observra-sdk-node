import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { Tracer } from "@opentelemetry/api";
import { GatewayExporter } from "./exporter.js";
import { ATTR } from "./conventions.js";

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

  // Node's equivalent of Python's atexit hook - flush buffered spans before
  // process exit so nothing sits in the queue unexported. "beforeExit" (not
  // "exit") because it still allows async work.
  process.once("beforeExit", () => {
    provider.shutdown().catch(() => {
      // Shutdown is telemetry cleanup, not the caller's request - never throw.
    });
  });

  return provider.getTracer("observra");
}
