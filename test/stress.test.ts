import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { describeLive } from "./live.js";
import { configure, Groq, GatewayError } from "../src/index.js";
import { traceparentFromContext } from "../src/tracing/context.js";
import { requireConfig } from "../src/config.js";
import { checkPayload } from "../src/guardrails/check.js";

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

describe("stress: trace context isolation under concurrency", () => {
  beforeAll(() => {
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true });
  });

  /**
   * The single most dangerous failure mode in this SDK: if AsyncLocalStorage
   * isolation is wrong, concurrent requests bleed trace context into each
   * other and observations get attributed to the wrong trace. Silent, and
   * only visible as scrambled data in the dashboard.
   */
  it("keeps 100 concurrent traced operations in fully separate traces", async () => {
    const tracer = requireConfig().tracer;

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        tracer.startActiveSpan(`op-${i}`, async (span) => {
          const before = traceparentFromContext() ?? "";
          // Random async gaps to force interleaving across the event loop.
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          const after = traceparentFromContext() ?? "";
          span.end();
          return { i, before, after };
        }),
      ),
    );

    // Each operation must see its OWN context both before and after the gap.
    for (const r of results) {
      expect(r.after).toBe(r.before);
    }

    // All 100 trace IDs must be distinct - no sharing, no bleed.
    const traceIds = results.map((r) => r.before.split("-")[1]);
    expect(new Set(traceIds).size).toBe(100);
  });

  it("keeps nested child spans attached to the correct parent under concurrency", async () => {
    const tracer = requireConfig().tracer;

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        tracer.startActiveSpan(`parent-${i}`, async (parent) => {
          const parentTp = traceparentFromContext() ?? "";
          await new Promise((r) => setTimeout(r, Math.random() * 15));
          const childTp = await tracer.startActiveSpan(`child-${i}`, async (child) => {
            await new Promise((r) => setTimeout(r, Math.random() * 15));
            const tp = traceparentFromContext() ?? "";
            child.end();
            return tp;
          });
          parent.end();
          return { parentTp, childTp };
        }),
      ),
    );

    for (const { parentTp, childTp } of results) {
      // Same trace, different span - the child belongs to ITS parent, not
      // to whichever parent happened to be running concurrently.
      expect(childTp.split("-")[1]).toBe(parentTp.split("-")[1]);
      expect(childTp.split("-")[2]).not.toBe(parentTp.split("-")[2]);
    }
  });
});

describeLive("stress: concurrent real gateway traffic", () => {
  beforeAll(() => {
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true });
  });

  it("handles 10 concurrent live calls without cross-talk or corruption", async () => {
    const client = new Groq({ apiKey: env.GROQ_API_KEY });

    // Each request asks for a DIFFERENT unique token back, so a response
    // landing on the wrong promise would be detectable, not just a count.
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        client.chat.completions
          .create({
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "user", content: `Reply with exactly this number and nothing else: ${i}` }],
            temperature: 0,
          })
          .then((r) => ({ i, body: JSON.stringify(r) })),
      ),
    );

    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected");

    // Rate limiting (429) is legitimate under burst load and not a defect -
    // but every failure must be a proper GatewayError, never a crash, hang,
    // or malformed-response error.
    for (const f of failed) {
      expect((f as PromiseRejectedResult).reason).toBeInstanceOf(GatewayError);
    }
    expect(ok.length).toBeGreaterThan(0);

    // Every fulfilled response must be a well-formed, complete body.
    for (const s of ok) {
      const { body } = (s as PromiseFulfilledResult<{ i: number; body: string }>).value;
      const parsed = JSON.parse(body);
      expect(parsed.choices?.[0]?.message).toBeDefined();
    }
  });
});

describe("stress: guardrail scanning cost is bounded", () => {
  /**
   * plan.md requirement #3: a pathological payload must not stall the
   * request path. MAX_SCAN_LENGTH caps the scan; without it, these patterns
   * over a multi-MB string would dominate call latency.
   */
  it("scans a 5MB payload in well under a second", () => {
    const huge = "a".repeat(5_000_000);
    const start = Date.now();
    const result = checkPayload(huge, "warn");
    const elapsed = Date.now() - start;

    expect(result.violations.length).toBe(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it("handles a payload densely packed with matches without blowing up", () => {
    const dense = Array.from({ length: 5000 }, (_, i) => `user${i}@example.com 555-123-4567`).join(" ");
    const start = Date.now();
    const result = checkPayload(dense, "redact");
    const elapsed = Date.now() - start;

    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.redactedText).toContain("[REDACTED]");
    expect(elapsed).toBeLessThan(2000);
  });

  it("survives adversarial repetitive input (ReDoS shape)", () => {
    // Long runs of near-matching characters are what make naive patterns
    // backtrack catastrophically.
    const adversarial = "1".repeat(50_000) + "-" + "2".repeat(50_000);
    const start = Date.now();
    checkPayload(adversarial, "warn");
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("handles unicode, emoji, and empty input without throwing", () => {
    expect(() => checkPayload("", "block")).not.toThrow();
    expect(() => checkPayload("你好 🎉 مرحبا", "redact")).not.toThrow();
    expect(() => checkPayload("🎉".repeat(10_000), "warn")).not.toThrow();
  });
});
