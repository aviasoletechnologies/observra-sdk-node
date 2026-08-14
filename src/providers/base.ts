import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { requireConfig, PROMPT_INJECTION_HEADER } from "../config.js";
import { traceparentFromContext, otelContext } from "../tracing/context.js";
import { ATTR } from "../tracing/conventions.js";
import {
  checkPayload,
  checkStructured,
  GuardrailViolation,
  type CheckResult,
  type StructuredCheckResult,
  type GuardrailMatch,
  type GuardrailMode,
} from "../guardrails/check.js";
import { getRules } from "../guardrails/rules.js";
import type { GuardrailPattern } from "../guardrails/patterns.js";
import { log } from "../internal/log.js";

/**
 * Providers don't all shape their error bodies like OpenAI's
 * {error:{message}} - Cohere, for instance, returns {id, message} directly.
 * Try the known shapes, then fall back to the raw body so nothing is ever
 * silently swallowed into a generic "request failed" string.
 */
function extractErrorMessage(json: unknown, status: number): string {
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (obj.error && typeof obj.error === "object") {
      const message = (obj.error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    return JSON.stringify(json);
  }
  return `gateway request failed with status ${status}`;
}

/** Same error type whether the rule was enforced locally or by the gateway -
 * otherwise the class a caller catches depends on cache warmth. */
function throwIfGuardrailBlocked(json: unknown): void {
  if (!json || typeof json !== "object") return;
  const { error } = json as { error?: { code?: string; rules?: string[]; rule?: string } };
  if (error?.code !== "guardrail_blocked" && error?.code !== "ai_guardrail_blocked") return;
  // guardrail_blocked carries `rules` (regex, can match several at once);
  // ai_guardrail_blocked carries a single `rule`.
  const labels = error.rules ?? (error.rule ? [error.rule] : []);
  throw new GuardrailViolation(labels.map((label) => ({ label })));
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Span instrumentation must never be able to break the real call (plan.md
 * requirement #1) - every span.* call here is wrapped individually so a
 * tracing bug can only lose an attribute, never abort or duplicate the
 * actual gateway request. */
function safeSetAttribute(span: Span, key: string, value: string | number): void {
  try {
    span.setAttribute(key, value);
  } catch {
    // telemetry must never break the caller's real request
  }
}

function extractModelName(body: unknown): string | undefined {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).model === "string") {
    return (body as Record<string, unknown>).model as string;
  }
  return undefined;
}

/** Token counts, in each shape this SDK's providers actually return:
 * OpenAI-compat {usage:{prompt_tokens,completion_tokens}}, Anthropic native
 * {usage:{input_tokens,output_tokens}}, Gemini native
 * {usageMetadata:{promptTokenCount,candidatesTokenCount}}. First match wins. */
const TOKEN_KEYS = {
  [ATTR.LLM_TOKEN_COUNT_PROMPT]: [
    ["usage", "prompt_tokens"],
    ["usage", "input_tokens"],
    ["usageMetadata", "promptTokenCount"],
  ],
  [ATTR.LLM_TOKEN_COUNT_COMPLETION]: [
    ["usage", "completion_tokens"],
    ["usage", "output_tokens"],
    ["usageMetadata", "candidatesTokenCount"],
  ],
} as const;

function applyTokenAttributes(span: Span, result: unknown): void {
  if (!result || typeof result !== "object") return;
  const obj = result as Record<string, Record<string, unknown> | undefined>;
  for (const [attr, paths] of Object.entries(TOKEN_KEYS)) {
    for (const [outer, key] of paths) {
      const value = obj[outer]?.[key];
      if (typeof value === "number") {
        safeSetAttribute(span, attr, value);
        break;
      }
    }
  }
}

/**
 * Isolates "guardrail internals crashed" from "guardrail deliberately
 * blocked" (plan.md requirement #1: everything fails open except the one
 * deliberate GuardrailViolation throw). A bug in the regex engine itself
 * must never take down the real request - it just skips the check.
 */
function safeCheckPayload(text: string, mode: GuardrailMode): CheckResult {
  try {
    return checkPayload(text, mode);
  } catch (err) {
    if (err instanceof GuardrailViolation) throw err;
    log("guardrail check failed, skipping: %s", err);
    return { violations: [], redactedText: text };
  }
}

/** Structured sibling of safeCheckPayload, for anything with a shape.
 * Same isolation rule: only a deliberate GuardrailViolation escapes. */
function safeCheckStructured(value: unknown, mode: GuardrailMode, patterns?: GuardrailPattern[]): StructuredCheckResult {
  try {
    return patterns ? checkStructured(value, mode, patterns) : checkStructured(value, mode);
  } catch (err) {
    if (err instanceof GuardrailViolation) throw err;
    log("guardrail check failed, skipping: %s", err);
    return { violations: [], value };
  }
}

interface OrgRulesResult {
  value: unknown;
  /** Labels of rules that redacted something, for the gateway audit header
   * (see prepareCall). Block never contributes here - it throws before
   * anything is returned, so there is nothing left to send or report. */
  redactedLabels: string[];
}

/**
 * Applies the organization's dashboard-configured rules (fetched via
 * guardrails/rules.ts's cache) on top of the SDK's own built-in check.
 * Block and redact are each their own pattern set with their own mode -
 * a wire rule carries its action per-rule, unlike guardrailMode which is one
 * setting for the whole SDK - so block is checked (and can throw) before
 * redact ever touches the value. Never blocks on the network: getRules()
 * always returns instantly from whatever is already cached.
 */
function applyOrgRules(span: Span, value: unknown): OrgRulesResult {
  const { gatewayUrl, gatewayKey } = requireConfig();
  const rules = getRules(gatewayUrl, gatewayKey);

  // failOnMatch:false is "must APPEAR" - an absence can't be judged from one
  // string leaf, and treating it as a match inverts the verdict. Gateway owns these.
  const usable = rules.filter((r) => r.failOnMatch !== false);

  const blockRules = usable.filter((r) => r.action === "block");
  const redactRules = usable.filter((r) => r.action === "redact");

  if (blockRules.length > 0) {
    applyGuardrailAttributes(span, "block", safeCheckStructured(value, "block", blockRules));
  }
  if (redactRules.length === 0) return { value, redactedLabels: [] };
  const redacted = safeCheckStructured(value, "redact", redactRules);
  applyGuardrailAttributes(span, "redact", redacted);
  return { value: redacted.value, redactedLabels: redacted.violations.map((v) => v.label) };
}

function applyGuardrailAttributes(span: Span, mode: GuardrailMode, result: { violations: GuardrailMatch[] }): void {
  if (result.violations.length === 0) return;
  safeSetAttribute(span, ATTR.GUARDRAIL_VIOLATION, result.violations.map((v) => v.label).join(","));
  safeSetAttribute(span, ATTR.GUARDRAIL_ACTION, mode);
}

interface PreparedCall {
  body: unknown;
  /** Labels of rules that redacted the OUTBOUND body, client-side, before the
   * gateway ever saw it - the gateway's own audit record has no way to know
   * this happened unless told. Reported via a request header (see doFetchRaw)
   * so the gateway's copy of events stays accurate instead of silently
   * showing already-redacted text with no note that it was changed. */
  redactedLabels: string[];
}

/** Shared opening move for both post() and postStream(): tag the span with
 * provider/model, then run the outbound guardrail check (the one direction
 * where block/redact is still enforceable for streams too). */
function prepareCall(span: Span, provider: string, body: unknown, mode: GuardrailMode): PreparedCall {
  safeSetAttribute(span, ATTR.LLM_PROVIDER, provider);
  const model = extractModelName(body);
  if (model) safeSetAttribute(span, ATTR.LLM_MODEL_NAME, model);

  // Structured, not stringified: redacting serialized JSON and re-parsing it
  // destroyed the body (see checkStructured's doc comment).
  const check = safeCheckStructured(body, mode);
  applyGuardrailAttributes(span, mode, check);
  const builtInLabels = mode === "redact" ? check.violations.map((v) => v.label) : [];

  const org = applyOrgRules(span, check.value);
  return { body: org.value, redactedLabels: [...builtInLabels, ...org.redactedLabels] };
}

/** Shared error path - records the exception without ever letting a
 * telemetry failure mask or replace the real one. */
function recordSpanError(span: Span, err: unknown): void {
  try {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
  } catch {
    // telemetry must never break the caller's real request
  }
}

/**
 * Shared plumbing every provider client reuses - builds the gateway URL,
 * injects auth headers, wraps the call in a span, and returns the response
 * body untouched (the SDK hands back the direct provider/gateway response,
 * no wrapping envelope). Provider-agnostic: contains zero per-provider logic.
 */
export class GatewayTransport {
  private readonly baseUrl: string;
  private readonly gatewayKey: string;
  private readonly providerKey: string;
  private readonly provider: string;

  constructor(provider: string, providerKey: string) {
    const config = requireConfig();
    this.provider = provider;
    this.baseUrl = `${config.gatewayUrl}/${provider}`;
    this.gatewayKey = config.gatewayKey;
    this.providerKey = providerKey;
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const { tracer, guardrailMode } = requireConfig();
    return tracer.startActiveSpan(`${this.provider}.chat`, { kind: SpanKind.CLIENT }, async (span) => {
      const start = Date.now();
      try {
        const prepared = prepareCall(span, this.provider, body, guardrailMode);
        const rawResult = await this.doFetch(path, prepared.body, traceparentFromContext(), prepared.redactedLabels);

        const inboundCheck = safeCheckStructured(rawResult, guardrailMode);
        applyGuardrailAttributes(span, guardrailMode, inboundCheck);
        const result = applyOrgRules(span, inboundCheck.value).value;

        applyTokenAttributes(span, result);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        recordSpanError(span, err);
        throw err;
      } finally {
        safeSetAttribute(span, ATTR.LLM_LATENCY_MS, Date.now() - start);
        span.end();
      }
    });
  }

  /**
   * Streaming variant. Returns an async iterable of parsed SSE chunks, so
   * `for await (const chunk of stream)` works the same as the real provider
   * SDKs' streaming interface.
   *
   * Guardrail asymmetry, stated plainly: the OUTBOUND check still blocks or
   * redacts exactly as it does for a normal call (it runs before anything is
   * sent). The INBOUND check cannot - by the time a chunk exists, it has
   * already been handed to the caller, so retroactive blocking/redaction is
   * impossible. Streamed output is therefore scanned only to TAG the span
   * (advisory), never to alter what the caller already received. Callers who
   * need enforced output guardrails must not stream.
   */
  async *postStream(path: string, body: unknown): AsyncGenerator<unknown, void, undefined> {
    const { tracer, guardrailMode } = requireConfig();
    const span = tracer.startSpan(`${this.provider}.chat.stream`, { kind: SpanKind.CLIENT });
    const start = Date.now();

    try {
      const prepared = prepareCall(span, this.provider, body, guardrailMode);

      // Trace context is taken from the span we just opened, not the ambient
      // active one - a generator's body runs outside the caller's context,
      // so `traceparentFromContext()` with no argument would miss it.
      const traceparent = traceparentFromContext(trace.setSpan(otelContext.active(), span));
      const res = await this.doFetchRaw(path, prepared.body, traceparent, prepared.redactedLabels);

      const collected: string[] = [];
      for await (const chunk of parseSSE(res)) {
        collected.push(JSON.stringify(chunk));
        yield chunk;
      }

      // Advisory only, and "warn" is what makes that true. Passing the
      // configured mode here threw GuardrailViolation *after* every chunk had
      // already been yielded - the caller got the whole response AND an
      // exception, and nothing was withheld by the throw. Streamed output
      // cannot be blocked or redacted (the bytes are already with the
      // caller), so it is detected and recorded, never enforced. The
      // attribute records "warn" because warning is genuinely all that
      // happened, whatever the configured mode is.
      const inboundCheck = safeCheckPayload(collected.join(""), "warn");
      applyGuardrailAttributes(span, "warn", inboundCheck);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      recordSpanError(span, err);
      throw err;
    } finally {
      // Runs even if the caller abandons the loop early (`break`), because
      // an abandoned generator gets .return() called on it - so the span is
      // always closed and never leaks.
      safeSetAttribute(span, ATTR.LLM_LATENCY_MS, Date.now() - start);
      span.end();
    }
  }

  private async doFetch(
    path: string,
    body: unknown,
    traceparent: string | undefined,
    redactedLabels: string[] = [],
  ): Promise<unknown> {
    const res = await this.doFetchRaw(path, body, traceparent, redactedLabels);
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throwIfGuardrailBlocked(json);
      throw new GatewayError(extractErrorMessage(json, res.status), res.status, json);
    }
    return json;
  }

  /** Shared request builder - returns the raw Response so the streaming path
   * can read the body incrementally instead of buffering it as JSON.
   * redactedLabels: which rule(s) the SDK already redacted out of this body
   * client-side, reported to the gateway via a header - see PreparedCall. */
  private doFetchRaw(
    path: string,
    body: unknown,
    traceparent: string | undefined,
    redactedLabels: string[] = [],
  ): Promise<Response> {
    // Read per request, not captured in the constructor: a long-lived client
    // built before a later configure() would otherwise keep sending the old
    // setting forever. guardrailMode in post() above is read the same way, and
    // the Python SDK's transport also reads it off the live config per request.
    const { promptInjectionDetection } = requireConfig();
    return fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Gateway-Key": this.gatewayKey,
        "X-Provider-Key": this.providerKey,
        ...(traceparent ? { traceparent } : {}),
        ...(redactedLabels.length > 0 ? { "X-Observra-Guardrail-Applied": redactedLabels.join(",") } : {}),
        // Spread only when the caller actually set it - an absent header and a
        // "false" header mean different things to the gateway.
        ...(promptInjectionDetection !== undefined
          ? { [PROMPT_INJECTION_HEADER]: String(promptInjectionDetection) }
          : {}),
      },
      body: JSON.stringify(body),
    });
  }
}

/**
 * Parses a Server-Sent Events body into JSON chunks. Buffers across network
 * reads because an SSE event is not guaranteed to arrive whole in one chunk -
 * splitting naively per read drops or corrupts events under real network
 * conditions.
 */
async function* parseSSE(res: Response): AsyncGenerator<unknown, void, undefined> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text || null;
    }
    throwIfGuardrailBlocked(parsed);
    throw new GatewayError(extractErrorMessage(parsed, res.status), res.status, parsed);
  }
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const chunk = parseSSEEvent(rawEvent);
        if (chunk === DONE) return;
        if (chunk !== undefined) yield chunk;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const DONE = Symbol("sse-done");

function parseSSEEvent(rawEvent: string): unknown | typeof DONE | undefined {
  for (const line of rawEvent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return DONE;
    if (!data) continue;
    try {
      return JSON.parse(data);
    } catch {
      // A non-JSON data line isn't fatal - some providers emit comments or
      // keepalives. Skip it rather than killing the stream.
      return undefined;
    }
  }
  return undefined;
}
