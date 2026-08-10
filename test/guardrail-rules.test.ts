import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getRules, primeRules, resetRulesCache } from "../src/guardrails/rules.js";

const GATEWAY = "https://gateway.test";
const KEY = "obs_test";

function ruleBody(rules: unknown[], refreshAfterSeconds = 60) {
  return new Response(JSON.stringify({ refreshAfterSeconds, rules }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SSN_RULE = { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", flags: "", failOnMatch: true, action: "block" };

describe("guardrail rules cache", () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    resetRulesCache();
    vi.useRealTimers();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("fetches rules from the gateway with the gateway key", async () => {
    let seenUrl = "";
    let seenKey: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenKey = new Headers(init?.headers).get("X-Gateway-Key");
      return ruleBody([SSN_RULE]);
    }) as typeof fetch;

    await primeRules(GATEWAY, KEY);

    expect(seenUrl).toBe(`${GATEWAY}/__observability/guardrails`);
    expect(seenKey).toBe(KEY);
    expect(getRules(GATEWAY, KEY).map((r) => r.label)).toEqual(["ssn"]);
  });

  it("compiles each rule with its own action, not one global mode", async () => {
    globalThis.fetch = (async () =>
      ruleBody([SSN_RULE, { name: "email", pattern: "\\S+@\\S+", flags: "i", failOnMatch: true, action: "redact" }])) as typeof fetch;

    await primeRules(GATEWAY, KEY);
    const rules = getRules(GATEWAY, KEY);

    expect(rules.find((r) => r.label === "ssn")?.action).toBe("block");
    expect(rules.find((r) => r.label === "email")?.action).toBe("redact");
  });

  it("strips the g flag so repeated .test() calls stay stateless", async () => {
    // A global regex carries lastIndex between calls, so the same input
    // alternates true/false - a rule would apply to every other request.
    globalThis.fetch = (async () =>
      ruleBody([{ ...SSN_RULE, flags: "gi" }])) as typeof fetch;

    await primeRules(GATEWAY, KEY);
    const [rule] = getRules(GATEWAY, KEY);

    expect(rule.pattern.flags).not.toContain("g");
    expect(rule.pattern.test("123-45-6789")).toBe(true);
    expect(rule.pattern.test("123-45-6789")).toBe(true);
  });

  it("returns an empty list on a cold cache instead of blocking", () => {
    // The first call of a process must not wait on the rules endpoint - the
    // gateway evaluates that same request anyway.
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return ruleBody([SSN_RULE]);
    }) as typeof fetch;

    expect(getRules(GATEWAY, KEY)).toEqual([]);
  });

  it("keeps serving the previous rules when a refresh fails", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return ruleBody([SSN_RULE], 0.001); // expires immediately
      throw new Error("network down");
    }) as typeof fetch;

    await primeRules(GATEWAY, KEY);
    expect(getRules(GATEWAY, KEY).map((r) => r.label)).toEqual(["ssn"]);

    await new Promise((r) => setTimeout(r, 20)); // let it expire
    expect(getRules(GATEWAY, KEY).map((r) => r.label)).toEqual(["ssn"]); // stale, not empty
    await new Promise((r) => setTimeout(r, 20)); // let the failing refresh settle
    expect(getRules(GATEWAY, KEY).map((r) => r.label)).toEqual(["ssn"]);
  });

  it("keeps previous rules when the gateway is too old to serve them", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return ruleBody([SSN_RULE], 0.001);
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    await primeRules(GATEWAY, KEY);
    await new Promise((r) => setTimeout(r, 20));
    await primeRules(GATEWAY, KEY);

    expect(getRules(GATEWAY, KEY).map((r) => r.label)).toEqual(["ssn"]);
  });

  it("never throws when the gateway is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    await expect(primeRules(GATEWAY, KEY)).resolves.toBeUndefined();
    expect(getRules(GATEWAY, KEY)).toEqual([]);
  });

  it("survives a malformed response body", async () => {
    globalThis.fetch = (async () =>
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    await expect(primeRules(GATEWAY, KEY)).resolves.toBeUndefined();
    expect(getRules(GATEWAY, KEY)).toEqual([]);
  });

  it("skips a rule with an invalid pattern but keeps the rest", async () => {
    // One bad regex saved in the dashboard must not disable every other rule.
    globalThis.fetch = (async () =>
      ruleBody([{ name: "broken", pattern: "([unclosed", flags: "", failOnMatch: true, action: "block" }, SSN_RULE])) as typeof fetch;

    await primeRules(GATEWAY, KEY);
    expect(getRules(GATEWAY, KEY).map((r) => r.label)).toEqual(["ssn"]);
  });

  it("ignores rules with an unknown action", async () => {
    globalThis.fetch = (async () =>
      ruleBody([{ ...SSN_RULE, action: "observe" }, SSN_RULE])) as typeof fetch;

    await primeRules(GATEWAY, KEY);
    expect(getRules(GATEWAY, KEY)).toHaveLength(1);
  });

  it("collapses concurrent refreshes into one request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return ruleBody([SSN_RULE]);
    }) as typeof fetch;

    await Promise.all([primeRules(GATEWAY, KEY), primeRules(GATEWAY, KEY), primeRules(GATEWAY, KEY)]);

    expect(calls).toBe(1);
  });

  it("does not refetch while the cache is fresh", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return ruleBody([SSN_RULE], 3600);
    }) as typeof fetch;

    await primeRules(GATEWAY, KEY);
    getRules(GATEWAY, KEY);
    getRules(GATEWAY, KEY);
    getRules(GATEWAY, KEY);

    expect(calls).toBe(1);
  });
});
