import { describe, it, expect, afterEach } from "vitest";
import { configure, PROMPT_INJECTION_HEADER } from "../src/config.js";
import { rewriteToGateway } from "../src/instrumentation/routing.js";

/**
 * configure({ promptInjectionDetection }) asks the gateway to scan a request
 * for prompt injection, matching the Python SDK's `prompt_injection_detection`.
 *
 * The gateway reads three distinct states, not two
 * (readSdkPromptInjectionFlag / maybeScanPromptInjection in apps/gateway):
 *
 *   header absent  -> use whatever the application is configured for
 *   "true"         -> scan (and record that the SDK asked for it)
 *   "false"        -> skip the scan for this call
 *
 * So `undefined` must stay distinct from `false` all the way to the wire. If
 * the SDK ever defaulted the option to `false`, every application whose SDK
 * was upgraded would silently stop being scanned - which is why the absent
 * case is asserted here as carefully as the two explicit ones.
 */

const GATEWAY = "http://localhost:8787";
const BASE = { gatewayUrl: GATEWAY, gatewayKey: "obs_test", insecure: true } as const;

function headersFor(promptInjectionDetection?: boolean): Headers {
  const config = configure({ ...BASE, promptInjectionDetection });
  const rewritten = rewriteToGateway(
    "https://api.groq.com/openai/v1/chat/completions",
    new Headers({ authorization: "Bearer gsk_provider" }),
    config.gatewayUrl,
    config.gatewayKey,
    config.promptInjectionDetection,
  );
  if (!rewritten) throw new Error("expected the groq origin to be rerouted");
  return rewritten.headers;
}

describe("promptInjectionDetection: the auto-routed fetch path", () => {
  it("sends no header at all when the option is not set", () => {
    expect(headersFor(undefined).has(PROMPT_INJECTION_HEADER)).toBe(false);
  });

  it("sends 'true' when explicitly enabled", () => {
    expect(headersFor(true).get(PROMPT_INJECTION_HEADER)).toBe("true");
  });

  it("sends 'false' when explicitly disabled, rather than omitting it", () => {
    // Omitting here would mean "use the application's setting" - the opposite
    // of what the caller asked for.
    expect(headersFor(false).get(PROMPT_INJECTION_HEADER)).toBe("false");
  });

  it("still rewrites the provider key and gateway key alongside it", () => {
    const headers = headersFor(true);
    expect(headers.get("X-Gateway-Key")).toBe("obs_test");
    expect(headers.get("X-Provider-Key")).toBe("gsk_provider");
    expect(headers.has("authorization")).toBe(false);
  });
});

describe("promptInjectionDetection: the wrapper-class path", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Captures the headers the transport actually puts on the wire. */
  async function capture(promptInjectionDetection?: boolean): Promise<Record<string, string>> {
    // No instrument() here on purpose: the wrapper class posts through
    // GatewayTransport, which calls fetch itself. This is the path a caller
    // gets from `new observra.Groq(...)` without patching anything global.
    configure({ ...BASE, promptInjectionDetection, guardrailMode: "warn" });

    let sent: Record<string, string> = {};
    globalThis.fetch = (async (_input: unknown, init: { headers?: Record<string, string> }) => {
      sent = { ...(init?.headers ?? {}) };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { Groq } = await import("../src/index.js");
    const client = new Groq({ apiKey: "gsk_provider" });
    await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hello" }],
    });
    return sent;
  }

  it("omits the header when unset", async () => {
    expect(await capture(undefined)).not.toHaveProperty(PROMPT_INJECTION_HEADER);
  });

  it("sends 'true' when enabled", async () => {
    expect((await capture(true))[PROMPT_INJECTION_HEADER]).toBe("true");
  });

  it("sends 'false' when disabled", async () => {
    expect((await capture(false))[PROMPT_INJECTION_HEADER]).toBe("false");
  });
});

describe("both integration paths agree", () => {
  it("uses the identical header name", () => {
    // The two paths build headers independently; a typo in one would be a
    // feature that works through the wrapper and silently not through
    // instrument(), or vice versa.
    expect(PROMPT_INJECTION_HEADER).toBe("X-Observra-Prompt-Injection-Detection");
  });
});
