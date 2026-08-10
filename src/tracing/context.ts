import { context as otelContext, defaultTextMapSetter, type Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

// Needed for correct parent/child span nesting across `await` boundaries -
// without a context manager, "current active span" doesn't propagate through
// async code at all (Node's equivalent of Python's contextvars). Idempotent:
// setGlobalContextManager no-ops (with a diag warning) if a host app already
// registered its own - we never clobber one. This is a narrower mutation
// than setting the global TracerProvider (which we deliberately never do,
// see tracer.ts) - there is only one correct context manager per process,
// and none of our own spans would nest correctly without setting one if the
// host app hasn't already.
otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const propagator = new W3CTraceContextPropagator();

/** The `traceparent` header string for the given (or current active) span context. */
export function traceparentFromContext(ctx: Context = otelContext.active()): string | undefined {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, defaultTextMapSetter);
  return carrier.traceparent;
}

export { otelContext };
