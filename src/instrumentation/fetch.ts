import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { requireConfig } from "../config.js";
import { traceparentFromContext } from "../tracing/context.js";
import { OBSERVRA_INTERNAL_PREFIX } from "../tracing/exporter.js";
import { ATTR } from "../tracing/conventions.js";
import { log } from "../internal/log.js";
import { rewriteToGateway } from "./routing.js";

let patched = false;

/**
 * Three jobs, all driven by the same fact: every JS provider SDK and agent
 * framework ultimately makes its calls over `fetch`, and none of them know
 * anything about this SDK.
 *
 * 1. **Reroute** native provider SDK traffic (`new OpenAI()`, `genai.Client()`,
 *    `new Groq()`, ...) to the gateway, moving the provider key into
 *    `X-Provider-Key` and adding `X-Gateway-Key`. This is what makes the
 *    "no wrapper class" usage work - the customer keeps their own SDK
 *    exactly as-is and observra.instrument() handles routing.
 * 2. **Open a span** for a gateway-bound call that nothing else is already
 *    tracing. Without this, the native-SDK path produced no span and no
 *    trace context at all, so its gateway observation landed with a null
 *    trace_id and correlated with nothing (ADR-006's whole point).
 * 3. **Propagate trace context** on gateway-bound requests. Framework
 *    clients (LangChain's ChatOpenAI and the `openai` SDK under it) issue
 *    their own HTTP requests and would otherwise produce spans that exist
 *    only locally and never correlate with the gateway's own observation
 *    for the same request. The Python SDK's docs solve the identical
 *    problem by patching `httpx`; Node's is `fetch`.
 *
 * `traceparent` is injected ONLY on gateway-bound requests - deliberately
 * narrower than the Python docs' httpx patch, since trace context
 * identifies our own request chain and leaking it to unrelated third-party
 * hosts a framework happens to call is not something a customer opted into.
 *
 * Never overwrites a traceparent the caller already set, and any failure
 * falls through to the original fetch untouched (fail-open, plan.md
 * requirement #1) - a tracing bug must never break real HTTP traffic.
 */
export function instrumentFetch(): void {
  if (patched) return;
  patched = true;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") return;

  globalThis.fetch = function observraPatchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    let route: RoutePlan | null = null;
    try {
      route = planRequest(input, init);
    } catch (err) {
      log("fetch patch failed, passing through: %s", err);
      return originalFetch(input, init);
    }
    if (!route) return originalFetch(input, init);

    if (!route.needsSpan) {
      const call = finalizeCall(route, input, init);
      return call ? originalFetch(call.input, call.init) : originalFetch(input, init);
    }

    // startActiveSpan, so the span is the active one while finalizeCall runs -
    // that is what lets traceparentFromContext() find it and produce a header.
    // Building the request inside the callback rather than before it is the
    // whole mechanism; hoisting it back out silently reintroduces the null
    // trace_id this exists to fix.
    return route.tracer.startActiveSpan(
      `${route.provider}.chat`,
      { kind: SpanKind.CLIENT },
      async (span: Span) => {
        const start = Date.now();
        try {
          const call = finalizeCall(route, input, init);
          safeSet(span, ATTR.LLM_PROVIDER, route.provider);
          const model = modelFromBody(call?.init.body ?? init?.body);
          if (model) safeSet(span, ATTR.LLM_MODEL_NAME, model);

          const response = call ? await originalFetch(call.input, call.init) : await originalFetch(input, init);

          // Token counts are deliberately not read here: getting them means
          // consuming or cloning the response body, which would buffer a
          // streamed response in memory and delay the caller's first byte
          // (ADR-004 - analytics must never degrade customer traffic). The
          // gateway already records tokens for this same request, and the
          // traceparent set above is what joins the two.
          if (!response.ok) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          return response;
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          safeSet(span, ATTR.LLM_LATENCY_MS, Date.now() - start);
          span.end();
        }
      },
    );
  };
}

function safeSet(span: Span, key: string, value: string | number): void {
  try {
    span.setAttribute(key, value);
  } catch {
    // telemetry must never break the caller's real request
  }
}

/** Best-effort model name off an outgoing JSON body - string bodies only.
 * A stream/FormData body is left alone rather than consumed to peek at it. */
function modelFromBody(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const model = (parsed as Record<string, unknown>).model;
      if (typeof model === "string") return model;
    }
  } catch {
    // not JSON, or not a shape we know - no model attribute, no failure
  }
  return undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface RoutePlan {
  config: ReturnType<typeof requireConfig>;
  tracer: ReturnType<typeof requireConfig>["tracer"];
  url: string;
  headers: Headers;
  rerouted: boolean;
  gatewayBound: boolean;
  provider: string;
  needsSpan: boolean;
}

interface PatchedCall {
  input: RequestInfo | URL;
  init: RequestInit;
}

/** Decides routing and whether this call needs its own span, without
 * touching the trace context yet - the span must not exist before we know
 * the request is gateway-bound. */
function planRequest(input: RequestInfo | URL, init?: RequestInit): RoutePlan | null {
  const config = requireConfig(); // throws if configure() was never called -> pass through
  const url = requestUrl(input);

  // Headers can live on `init` or on a Request passed as `input` - merge in
  // that order so `init` still wins, same as fetch's own semantics.
  const headers = new Headers(
    init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined),
  );

  // This SDK's own telemetry traffic (the span exporter) is gateway-bound
  // but must never be traced: a span per export would itself be exported,
  // emitting another span, forever. Bail before anything else touches it.
  if (url.startsWith(`${config.gatewayUrl}${OBSERVRA_INTERNAL_PREFIX}`)) return null;

  const rewritten = rewriteToGateway(url, headers, config.gatewayUrl, config.gatewayKey);
  const finalUrl = rewritten?.url ?? url;
  const gatewayBound = finalUrl.startsWith(config.gatewayUrl);

  // Only open a span when nothing else is already tracing this call, which
  // shows up two different ways:
  //  - an active recording span (GatewayTransport.post, the LangChain patch)
  //  - a traceparent already on the request with NO active span, which is
  //    what postStream does: a generator body runs outside the caller's
  //    context, so it opens a non-active span and injects the header itself
  //    (base.ts). Checking only the active span missed this and opened a
  //    second, unrelated span for every streamed call.
  const alreadyTraced = trace.getActiveSpan()?.isRecording() === true || headers.has("traceparent");

  return {
    config,
    tracer: config.tracer,
    url,
    headers,
    rerouted: rewritten !== null,
    gatewayBound,
    provider: rewritten?.provider ?? "gateway",
    needsSpan: gatewayBound && !alreadyTraced,
  };
}

/** Applies routing + trace context. Called inside the active span (when one
 * was opened) so traceparentFromContext() resolves to it. */
function finalizeCall(route: RoutePlan, input: RequestInfo | URL, init?: RequestInit): PatchedCall | null {
  const rewritten = route.rerouted
    ? rewriteToGateway(route.url, route.headers, route.config.gatewayUrl, route.config.gatewayKey)
    : null;
  const finalUrl = rewritten?.url ?? route.url;
  const finalHeaders = rewritten?.headers ?? route.headers;

  // Only gateway-bound traffic carries our trace context (see doc above).
  if (route.gatewayBound && !finalHeaders.has("traceparent")) {
    const traceparent = traceparentFromContext();
    if (traceparent) finalHeaders.set("traceparent", traceparent);
  }

  if (!rewritten && !finalHeaders.has("traceparent")) return null; // nothing changed

  // A rerouted Request object can't be reused as `input` (its URL is
  // immutable), so pass the new URL as a plain string and carry the body/
  // method across from it.
  if (rewritten && typeof input === "object" && "url" in input) {
    return { input: finalUrl, init: { ...requestToInit(input), ...init, headers: finalHeaders } };
  }
  return { input: rewritten ? finalUrl : input, init: { ...init, headers: finalHeaders } };
}

function requestToInit(request: Request): RequestInit {
  return {
    method: request.method,
    body: request.body,
    // Node's fetch requires this when streaming a body from a Request.
    ...(request.body ? { duplex: "half" } : {}),
  } as RequestInit;
}
