import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { configure, instrument, Groq, GatewayError } from "../src/index.js";
import { rewriteToGateway } from "../src/instrumentation/routing.js";
import { checkPayload } from "../src/guardrails/check.js";
import { requireConfig } from "../src/config.js";

function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return env;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = parseEnvFile(path.resolve(process.cwd(), ".env"));
const GATEWAY_URL = "http://localhost:8787";
const GATEWAY_KEY = "obs_OW-AwB1vOnuq7EIUpF2kQgN6NQenBIz1";

describe("robustness: idempotency of setup calls", () => {
  it("configure() called repeatedly stays consistent and does not leak state", () => {
    const a = configure({ gatewayUrl: "https://a.example.com", gatewayKey: "obs_a" });
    expect(a.gatewayUrl).toBe("https://a.example.com");

    const b = configure({ gatewayUrl: "https://b.example.com", gatewayKey: "obs_b" });
    expect(b.gatewayUrl).toBe("https://b.example.com");
    expect(requireConfig().gatewayKey).toBe("obs_b");
  });

  it("instrument() is safe to call many times (no double-patching)", async () => {
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true });
    const fetchBefore = globalThis.fetch;
    await instrument();
    const fetchAfterFirst = globalThis.fetch;
    await instrument();
    await instrument();
    const fetchAfterThird = globalThis.fetch;

    // First call may patch; subsequent calls must not wrap again - otherwise
    // every instrument() call adds a layer and headers get processed N times.
    expect(fetchAfterThird).toBe(fetchAfterFirst);
    expect(typeof fetchBefore).toBe("function");
  });
});

describe("robustness: routing edge cases", () => {
  it("does not overwrite a traceparent the caller already set", () => {
    const headers = new Headers({ authorization: "Bearer k", traceparent: "00-11111111111111111111111111111111-2222222222222222-01" });
    const result = rewriteToGateway("https://api.groq.com/openai/v1/chat/completions", headers, GATEWAY_URL, GATEWAY_KEY);
    expect(result!.headers.get("traceparent")).toBe("00-11111111111111111111111111111111-2222222222222222-01");
  });

  it("leaves unrelated hosts completely untouched (no hijacking, no key leakage)", () => {
    for (const url of ["https://example.com/api", "https://github.com/x", "http://localhost:3000/health", "https://api.stripe.com/v1/charges"]) {
      expect(rewriteToGateway(url, new Headers({ authorization: "Bearer secret" }), GATEWAY_URL, GATEWAY_KEY)).toBeNull();
    }
  });

  it("never leaves the provider key in Authorization after rewriting", () => {
    // Critical: the gateway reads `Authorization: Bearer` as the GATEWAY key
    // (server.ts extractGatewayKeyToken), so a leftover provider key there
    // would be misread as an Observra credential and rejected.
    const result = rewriteToGateway(
      "https://api.openai.com/v1/chat/completions",
      new Headers({ authorization: "Bearer sk-provider-secret" }),
      GATEWAY_URL,
      GATEWAY_KEY,
    );
    expect(result!.headers.get("authorization")).toBeNull();
    expect(result!.headers.get("X-Provider-Key")).toBe("sk-provider-secret");
  });

  it("handles each provider's own auth header style", () => {
    const gemini = rewriteToGateway(
      "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent",
      new Headers({ "x-goog-api-key": "AIza-key" }),
      GATEWAY_URL,
      GATEWAY_KEY,
    );
    expect(gemini!.headers.get("X-Provider-Key")).toBe("AIza-key");
    expect(gemini!.headers.get("x-goog-api-key")).toBeNull();

    const anthropic = rewriteToGateway(
      "https://api.anthropic.com/v1/messages",
      new Headers({ "x-api-key": "sk-ant-key" }),
      GATEWAY_URL,
      GATEWAY_KEY,
    );
    expect(anthropic!.headers.get("X-Provider-Key")).toBe("sk-ant-key");
    expect(anthropic!.headers.get("x-api-key")).toBeNull();
  });

  it("rewrites correctly with no auth header at all (e.g. local Ollama)", () => {
    const result = rewriteToGateway("https://ollama.com/api/chat", new Headers(), GATEWAY_URL, GATEWAY_KEY);
    expect(result).not.toBeNull();
    expect(result!.headers.get("X-Gateway-Key")).toBe(GATEWAY_KEY);
    expect(result!.headers.get("X-Provider-Key")).toBeNull();
  });

  it("preserves query strings and path segments exactly", () => {
    const result = rewriteToGateway(
      "https://api.groq.com/openai/v1/chat/completions?foo=bar&baz=1",
      new Headers(),
      GATEWAY_URL,
      GATEWAY_KEY,
    );
    expect(result!.url).toBe(`${GATEWAY_URL}/groq/openai/v1/chat/completions?foo=bar&baz=1`);
  });
});

describe("robustness: fail-open guarantees (plan.md requirement #1)", () => {
  beforeAll(() => {
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true });
  });

  it("raw checkPayload propagates an internal pattern failure (transport is what contains it)", () => {
    // Documents the boundary precisely: the pure function does NOT swallow a
    // broken pattern - safeCheckPayload in providers/base.ts is the layer
    // that contains it. Asserting this here means a future refactor that
    // moves the try/catch (or drops it) is visible rather than silent.
    const exploding = [
      { label: "boom", pattern: { test: () => { throw new Error("regex engine exploded"); } } as unknown as RegExp },
    ];
    expect(() => checkPayload("hello", "warn", exploding)).toThrow(/regex engine exploded/);
  });

  it("a failing guardrail POLICY fetch never blocks a real call (live fail-open)", async () => {
    // resolveGuardrailPatterns() targets /__observability/guardrail-policy,
    // which does not exist on the gateway - it 404s on every single call.
    // If that failure were not contained, no request would ever succeed.
    // This asserts the containment end to end, not in a mock.
    const client = new Groq({ apiKey: env.GROQ_API_KEY });
    const response = (await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "Say hello in one word." }],
    })) as { choices: { message: { content: string } }[] };

    expect(response.choices[0].message.content).toBeTruthy();
  });

  it("real calls still succeed even though the span exporter has no endpoint to POST to", async () => {
    // GatewayExporter targets /__observability/spans, which does not exist
    // on the gateway - every export 404s. That must never surface.
    const client = new Groq({ apiKey: env.GROQ_API_KEY });
    const response = (await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "Say hello in one word." }],
    })) as { choices: { message: { content: string } }[] };

    expect(response.choices[0].message.content).toBeTruthy();
  });

  it("an invalid gateway key produces a clean GatewayError, not a crash", async () => {
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: "obs_definitely_invalid", insecure: true });
    const client = new Groq({ apiKey: env.GROQ_API_KEY });

    await expect(
      client.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(GatewayError);

    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true }); // restore
  });

  it("an unreachable gateway rejects promptly instead of hanging", async () => {
    configure({ gatewayUrl: "http://127.0.0.1:9", gatewayKey: GATEWAY_KEY, insecure: true }); // port 9 = discard
    const client = new Groq({ apiKey: env.GROQ_API_KEY });

    const start = Date.now();
    await expect(
      client.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(15_000);

    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true }); // restore
  });
});

describe("streaming (plan.md Phase 1: async iterator over SSE chunks)", () => {
  beforeAll(() => {
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true });
  });

  it("streams real SSE chunks from a live provider through the gateway", async () => {
    const client = new Groq({ apiKey: env.GROQ_API_KEY });

    const stream = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "Count: one two three" }],
      stream: true,
    });

    expect(Symbol.asyncIterator in stream).toBe(true);

    const chunks: unknown[] = [];
    let text = "";
    for await (const chunk of stream) {
      chunks.push(chunk);
      const delta = (chunk as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
      if (delta) text += delta;
    }

    // More than one chunk is the whole point - a single chunk would mean we
    // buffered the response rather than streaming it.
    expect(chunks.length).toBeGreaterThan(1);
    expect(text.length).toBeGreaterThan(0);
    // [DONE] is a stream terminator, not data - it must never be yielded.
    expect(chunks).not.toContain("[DONE]");
  });

  it("reassembles events split across network read boundaries", async () => {
    // Feeds an SSE body one byte at a time, so every event is split across
    // reads. Naive per-read parsing drops or corrupts events here; this is
    // the failure that only shows up under real network conditions.
    const body = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const bytes = new TextEncoder().encode(body);
    const trickle = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(trickle, { status: 200, headers: { "content-type": "text/event-stream" } });

    try {
      const client = new Groq({ apiKey: "test" });
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

      let text = "";
      const chunks: unknown[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
        text += (chunk as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "";
      }

      expect(chunks.length).toBe(2);
      expect(text).toBe("Hello"); // proves nothing was dropped or duplicated
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces an HTTP error as GatewayError instead of an empty stream", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), { status: 402 });

    try {
      const client = new Groq({ apiKey: "test" });
      const stream = await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });

      // A failure must throw on iteration, not silently yield zero chunks -
      // an empty stream is indistinguishable from a legitimate empty reply.
      await expect((async () => {
        for await (const _ of stream) { /* drain */ }
      })()).rejects.toBeInstanceOf(GatewayError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("closes its span when the caller abandons the stream early", async () => {
    // `break` mid-iteration triggers the generator's .return(), which must
    // still run the finally block - otherwise spans leak on every early exit.
    const client = new Groq({ apiKey: env.GROQ_API_KEY });
    const stream = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "Count slowly to twenty" }],
      stream: true,
    });

    let seen = 0;
    for await (const _chunk of stream) {
      seen += 1;
      if (seen === 2) break;
    }

    expect(seen).toBe(2);
    // Reaching here without a hang or unhandled rejection is the assertion:
    // the generator was finalized cleanly.
  });
});
