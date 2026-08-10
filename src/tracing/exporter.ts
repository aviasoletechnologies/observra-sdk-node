import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

function toWireSpan(span: ReadableSpan) {
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind: span.kind,
    startTime: hrTimeToMilliseconds(span.startTime),
    endTime: hrTimeToMilliseconds(span.endTime),
    attributes: span.attributes,
    status: span.status,
  };
}

/**
 * POSTs finished spans to the gateway's span-ingest endpoint (ADR-006
 * layer 2 - the work *around* LLM calls: agent runs, tool invocations,
 * chain/retriever steps, none of which the gateway ever sees itself). The
 * gateway authenticates the batch, validates it and relays it over NATS;
 * the observation worker writes it to `spans`, correlated to the
 * `observations` row by trace id.
 *
 * The send stays behind a try/catch that can never fail the export:
 * telemetry failures must never surface to the caller's real request
 * (fail-open, plan.md requirement #1). That also means an older gateway
 * without this route degrades to no span export rather than an error.
 */
/** Reserved gateway namespace for this SDK's own telemetry traffic. The
 * fetch patch skips anything under it: tracing our own span export would
 * emit a span per export, which is itself exported, which emits another -
 * an unbounded feedback loop in any long-running process. */
export const OBSERVRA_INTERNAL_PREFIX = "/__observability/";
export const SPAN_INGEST_PATH = `${OBSERVRA_INTERNAL_PREFIX}spans`;

export class GatewayExporter implements SpanExporter {
  constructor(
    private readonly gatewayUrl: string,
    private readonly gatewayKey: string,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.trySend(spans).finally(() => resultCallback({ code: ExportResultCode.SUCCESS }));
  }

  private async trySend(spans: ReadableSpan[]): Promise<void> {
    try {
      await fetch(`${this.gatewayUrl}${SPAN_INGEST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Gateway-Key": this.gatewayKey },
        body: JSON.stringify(spans.map(toWireSpan)),
      });
    } catch {
      // No real endpoint yet, and even once there is one, an export failure
      // must never affect the caller's real request - see class doc above.
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
