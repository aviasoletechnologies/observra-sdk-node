import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import { requireConfig } from "../config.js";
import { ATTR, OBSERVRA_SPAN_KIND, type ObservraSpanKind } from "../tracing/conventions.js";

/**
 * LangChain's core package moves fast enough that patching blind against an
 * untested version risks silently breaking against an internal API that
 * moved (plan.md requirement #7) - skip + warn rather than patch blind.
 * Tested against 0.x and 1.x; a 2.0 major bump is where the patched
 * entrypoints could realistically move.
 */
export function isLangChainCoreVersionSupported(version: string): boolean {
  return parseInt(version, 10) < 2;
}

/** Reference technique: openinference-instrumentation-langchain patches the
 * same two entrypoints (chat model invoke, tool invoke) - not copied, this
 * is a from-scratch implementation against our own span conventions/exporter. */
function patchInvoke(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto: any,
  kind: ObservraSpanKind,
  nameOf: (self: unknown) => string,
): void {
  const original: (...args: unknown[]) => Promise<unknown> = proto.invoke;
  if (typeof original !== "function") return;

  proto.invoke = async function observraPatchedInvoke(this: unknown, ...args: unknown[]) {
    // observra.configure() not called - trace-free passthrough, never block
    // framework usage on the SDK being configured.
    let tracer;
    try {
      tracer = requireConfig().tracer;
    } catch {
      return original.apply(this, args);
    }

    return tracer.startActiveSpan(`langchain.${kind.toLowerCase()}.${nameOf(this)}`, { kind: SpanKind.INTERNAL }, async (span: Span) => {
      applyCallAttributes(span, kind, nameOf(this), args[0]);
      try {
        const result = await original.apply(this, args);
        applyResultAttributes(span, kind, result);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        try {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        } catch {
          // telemetry must never break the caller's real request
        }
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

function applyCallAttributes(span: Span, kind: ObservraSpanKind, name: string, input: unknown): void {
  try {
    if (kind === OBSERVRA_SPAN_KIND.TOOL) {
      span.setAttribute(ATTR.TOOL_NAME, name);
      span.setAttribute(ATTR.TOOL_PARAMETERS, typeof input === "string" ? input : JSON.stringify(input));
    } else {
      span.setAttribute(ATTR.INPUT_VALUE, typeof input === "string" ? input : JSON.stringify(input));
    }
  } catch {
    // telemetry must never break the caller's real request
  }
}

function applyResultAttributes(span: Span, kind: ObservraSpanKind, result: unknown): void {
  try {
    const text = typeof result === "string" ? result : JSON.stringify(result);
    span.setAttribute(kind === OBSERVRA_SPAN_KIND.TOOL ? ATTR.TOOL_RESULT : ATTR.OUTPUT_VALUE, text);
  } catch {
    // telemetry must never break the caller's real request
  }
}

let patched = false;

/**
 * Patches LangChain.js's chat-model call entrypoint (`BaseChatModel.prototype.invoke`)
 * and tool-execution entrypoint (`StructuredTool.prototype.invoke`) into
 * child spans - every LangChain chat model (ChatOpenAI, ChatGroq, ChatAnthropic,
 * ...) and every tool inherits these prototype methods, so patching the base
 * classes covers all of them without per-provider code. Idempotent.
 *
 * Uses dynamic `import()`, not `require()` - @langchain/core ships separate
 * CJS and ESM builds behind its exports map's "require"/"import" conditions,
 * and a real user's own `import {BaseChatModel} from "@langchain/core/..."`
 * resolves through the "import" condition. `require()` would resolve
 * through "require" instead, landing on a *different* module instance with
 * a *different* prototype object - patching that one would silently do
 * nothing to the classes real user code actually extends.
 */
export async function instrumentLangChain(): Promise<void> {
  if (patched) return;
  patched = true;

  const { BaseChatModel } = (await import("@langchain/core/language_models/chat_models")) as {
    BaseChatModel: { prototype: unknown };
  };
  const { StructuredTool } = (await import("@langchain/core/tools")) as { StructuredTool: { prototype: unknown } };

  patchInvoke(BaseChatModel.prototype, OBSERVRA_SPAN_KIND.LLM, (self) => (self as { constructor: { name: string } }).constructor.name);
  patchInvoke(StructuredTool.prototype, OBSERVRA_SPAN_KIND.TOOL, (self) => (self as { name?: string }).name ?? "tool");
}
