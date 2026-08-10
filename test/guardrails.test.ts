import { describe, it, expect, beforeAll } from "vitest";
import { checkPayload, checkStructured, GuardrailViolation } from "../src/guardrails/check.js";
import { configure, Groq, GuardrailViolation as GuardrailViolationFromIndex } from "../src/index.js";

const SAMPLE = "Contact me at jane.doe@example.com or 555-123-4567, SSN 123-45-6789.";

describe("guardrails: checkPayload (pure, no network)", () => {
  it("block mode throws GuardrailViolation", () => {
    expect(() => checkPayload(SAMPLE, "block")).toThrow(GuardrailViolation);
  });

  it("redact mode masks and continues (no throw)", () => {
    const result = checkPayload(SAMPLE, "redact");
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.redactedText).not.toContain("jane.doe@example.com");
    expect(result.redactedText).not.toContain("123-45-6789");
    expect(result.redactedText).toContain("[REDACTED]");
  });

  it("warn mode tags violations without altering payload", () => {
    const result = checkPayload(SAMPLE, "warn");
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.redactedText).toBe(SAMPLE);
  });

  it("clean text produces no violations in any mode", () => {
    const result = checkPayload("Say hello in one word.", "block");
    expect(result.violations.length).toBe(0);
  });
});

describe("guardrails: live block mode through the real gateway", () => {
  beforeAll(() => {
    configure({
      gatewayUrl: "http://localhost:8787",
      gatewayKey: process.env.OBS_GATEWAY_KEY ?? "obs_OW-AwB1vOnuq7EIUpF2kQgN6NQenBIz1",
      insecure: true,
      guardrailMode: "block",
    });
  });

  it("prevents the request from ever reaching the network", async () => {
    const client = new Groq({ apiKey: "irrelevant-should-never-be-used" });
    await expect(
      client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "My SSN is 123-45-6789, please help." }],
      }),
    ).rejects.toBeInstanceOf(GuardrailViolationFromIndex);
  });
});

describe("guardrails: checkStructured (bodies, not serialized JSON)", () => {
  // Regression: redaction used to run over JSON.stringify(body) and parse the
  // result back. JSON.stringify emits no whitespace, so the email pattern's
  // [^\s@] ran through quotes and braces - one address swallowed the whole
  // document and the re-parse threw a SyntaxError at the caller.
  const BODY = {
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: "bob@example.com" }],
    temperature: 0.7,
  };

  it("redacts without destroying the body's structure", () => {
    const { value } = checkStructured(BODY, "redact") as { value: typeof BODY };

    expect(value.model).toBe("llama-3.3-70b-versatile");
    expect(value.temperature).toBe(0.7);
    expect(value.messages).toHaveLength(1);
    expect(value.messages[0].role).toBe("user");
    expect(value.messages[0].content).toBe("[REDACTED]");
  });

  it("survives a round-trip through JSON, which the old form did not", () => {
    const { value } = checkStructured(BODY, "redact");
    expect(() => JSON.parse(JSON.stringify(value))).not.toThrow();
  });

  it("leaves the body untouched in warn and block modes", () => {
    expect(checkStructured(BODY, "warn").value).toBe(BODY);
    expect(() => checkStructured(BODY, "block")).toThrow(GuardrailViolation);
  });

  it("finds matches at any depth, and reports each label once", () => {
    const nested = {
      messages: [
        { role: "user", content: [{ type: "text", text: "ssn 123-45-6789" }] },
        { role: "user", content: "another ssn 987-65-4321" },
      ],
    };
    const { violations } = checkStructured(nested, "warn");
    expect(violations.map((v) => v.label)).toEqual(["ssn"]);
  });

  it("passes clean bodies through as the same object", () => {
    const clean = { model: "m", messages: [{ role: "user", content: "hello" }] };
    const result = checkStructured(clean, "redact");
    expect(result.violations).toEqual([]);
    expect(result.value).toBe(clean);
  });

  it("preserves non-string leaves exactly", () => {
    const mixed = { a: 1, b: true, c: null, d: [1, "x@y.com", false] };
    const { value } = checkStructured(mixed, "redact") as { value: typeof mixed };
    expect(value.a).toBe(1);
    expect(value.b).toBe(true);
    expect(value.c).toBeNull();
    expect(value.d[0]).toBe(1);
    expect(value.d[2]).toBe(false);
  });

  it("does not let a payload key pollute Object.prototype", () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "content": "hi"}');
    checkStructured(hostile, "redact");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
