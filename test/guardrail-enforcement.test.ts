import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { configure } from "../src/index.js";
import { GatewayTransport, GatewayError } from "../src/providers/base.js";
import { GuardrailViolation } from "../src/guardrails/check.js";
import { primeRules, resetRulesCache } from "../src/guardrails/rules.js";

const GATEWAY_URL = "https://gateway.enforcement.test";
const GATEWAY_KEY = "obs_test";

function rulesResponse(rules: unknown[]) {
  return new Response(JSON.stringify({ refreshAfterSeconds: 3600, rules }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const BLOCK_SSN = { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", flags: "", failOnMatch: true, action: "block" };
const REDACT_EMAIL = { name: "email", pattern: "\\S+@\\S+", flags: "i", failOnMatch: true, action: "redact" };
const MUST_APPEAR_BLOCK = { name: "disclaimer", pattern: "disclaimer", flags: "", failOnMatch: false, action: "block" };
const MUST_APPEAR_REDACT = { name: "disclaimer", pattern: "disclaimer", flags: "", failOnMatch: false, action: "redact" };

function blockResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 403, headers: { "content-type": "application/json" } });
}

/**
 * Proves getRules() output actually changes what goes over the wire, not
 * just that the cache holds the right rules (guardrail-rules.test.ts already
 * covers that). Org rules are per-application, dynamic, and dashboard-owned -
 * this is the seam where they take effect on a real request.
 */
describe("GatewayTransport enforces cached org guardrail rules", () => {
  let realFetch: typeof globalThis.fetch;
  let providerCalls: unknown[] = [];

  beforeEach(() => {
    realFetch = globalThis.fetch;
    resetRulesCache();
    providerCalls = [];
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true, guardrailMode: "warn" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function primeWith(rules: unknown[]): Promise<void> {
    globalThis.fetch = (async () => rulesResponse(rules)) as typeof fetch;
    await primeRules(GATEWAY_URL, GATEWAY_KEY);
  }

  it("blocks an outbound body matching a cached block rule before it reaches the provider", async () => {
    await primeWith([BLOCK_SSN]);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      providerCalls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    await expect(transport.post("/chat", { messages: [{ content: "my ssn is 123-45-6789" }] })).rejects.toThrow(
      GuardrailViolation,
    );
    expect(providerCalls).toHaveLength(0); // blocked before send, not after
  });

  it("redacts an outbound body matching a cached redact rule instead of blocking it", async () => {
    await primeWith([REDACT_EMAIL]);
    let sentBody: string | null = null;
    let sentHeaders: Headers | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = init?.body as string;
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    const result = await transport.post("/chat", { messages: [{ content: "reach me at bob@example.com" }] });

    expect(result).toEqual({ ok: true });
    expect(sentBody).not.toContain("bob@example.com");
    expect(sentBody).toContain("[REDACTED]");
    // The gateway sees only the redacted body - this header is its one signal
    // that a redaction happened before the request reached it (see base.ts's
    // PreparedCall doc comment).
    expect(sentHeaders!.get("X-Observra-Guardrail-Applied")).toBe("email");
  });

  it("sends no guardrail-applied header when nothing was redacted", async () => {
    await primeWith([REDACT_EMAIL]);
    let sentHeaders: Headers | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    await transport.post("/chat", { messages: [{ content: "say hello" }] });

    expect(sentHeaders!.get("X-Observra-Guardrail-Applied")).toBeNull();
  });

  it("blocks an inbound response matching a cached block rule", async () => {
    await primeWith([BLOCK_SSN]);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ content: "your ssn is 123-45-6789" }] }), { status: 200 })) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    await expect(transport.post("/chat", { messages: [] })).rejects.toThrow(GuardrailViolation);
  });

  it("leaves the request untouched when no cached rule matches", async () => {
    await primeWith([BLOCK_SSN, REDACT_EMAIL]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    const result = await transport.post("/chat", { messages: [{ content: "say hello" }] });
    expect(result).toEqual({ ok: true });
  });

  it("does nothing extra when no org rules are cached (cold cache)", async () => {
    // No primeWith() call - cache stays cold, getRules() returns [].
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    const result = await transport.post("/chat", { messages: [{ content: "my ssn is 123-45-6789" }] });
    expect(result).toEqual({ ok: true }); // built-in guardrailMode is "warn", org cache is empty
  });

  // See applyOrgRules in base.ts.
  it("does not block a failOnMatch:false body that CONTAINS the required pattern", async () => {
    await primeWith([MUST_APPEAR_BLOCK]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    // Reading this rule as "block on match" would reject the one prompt that
    // actually complies with it.
    const result = await transport.post("/chat", { messages: [{ content: "here is the disclaimer" }] });
    expect(result).toEqual({ ok: true });
  });

  it("does not redact a failOnMatch:false rule's required pattern out of the body", async () => {
    await primeWith([MUST_APPEAR_REDACT]);
    let sentBody: string | null = null;
    let appliedHeader: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = init?.body as string;
      appliedHeader = new Headers(init?.headers).get("X-Observra-Guardrail-Applied");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    await transport.post("/chat", { messages: [{ content: "here is the disclaimer" }] });

    // Masking it would delete the very text the rule requires, and then
    // report that to the gateway - whose own scan would see it missing.
    expect(sentBody).toContain("disclaimer");
    expect(sentBody).not.toContain("[REDACTED]");
    expect(appliedHeader).toBeNull();
  });

  it("maps a gateway guardrail_blocked 403 to GuardrailViolation, carrying every rule name", async () => {
    globalThis.fetch = (async () =>
      blockResponse({
        error: { message: "Request blocked by a configured guardrail rule", code: "guardrail_blocked", rules: ["ssn", "email"] },
      })) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    await expect(transport.post("/chat", { messages: [{ content: "hi" }] })).rejects.toMatchObject({
      name: "GuardrailViolation",
      violations: [{ label: "ssn" }, { label: "email" }],
    });
  });

  it("maps ai_guardrail_blocked, which carries a single rule", async () => {
    globalThis.fetch = (async () =>
      blockResponse({
        error: { message: "Response blocked by a configured AI guardrail", code: "ai_guardrail_blocked", rule: "toxicity" },
      })) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    await expect(transport.post("/chat", { messages: [{ content: "hi" }] })).rejects.toThrow(GuardrailViolation);
  });

  it("leaves an ordinary 403 as a GatewayError", async () => {
    globalThis.fetch = (async () =>
      blockResponse({ error: { message: "IP address not allowed for this environment" } })) as typeof fetch;

    const transport = new GatewayTransport("groq", "provider_key");
    await expect(transport.post("/chat", { messages: [{ content: "hi" }] })).rejects.toThrow(GatewayError);
  });
});
