import { log } from "../internal/log.js";
import { BUILT_IN_PATTERNS, type GuardrailPattern } from "./patterns.js";

export type GuardrailMode = "block" | "redact" | "warn";

export interface GuardrailMatch {
  label: string;
}

export interface CheckResult {
  violations: GuardrailMatch[];
  redactedText: string;
}

/**
 * The one deliberate exception this SDK ever throws from inside its own
 * telemetry/safety code (plan.md requirement #1) - a `block`-mode guardrail
 * hit is a product decision, not a bug, so it propagates to the caller
 * instead of being swallowed like every other internal failure.
 */
export class GuardrailViolation extends Error {
  constructor(public readonly violations: GuardrailMatch[]) {
    super(`observra: guardrail blocked this request (${violations.map((v) => v.label).join(", ")})`);
    this.name = "GuardrailViolation";
  }
}

// Bounded cost per payload (plan.md requirement #3) - a pathological huge
// prompt/response can't stall the request path scanning it in full.
const MAX_SCAN_LENGTH = 100_000;

/**
 * Operates on a plain string of prose - a message's text, or a span-attribute
 * value.
 *
 * Do NOT hand this a serialized request body. The patterns are written for
 * prose, where whitespace bounds a match; `JSON.stringify` emits none, so
 * `[^\s@]` in the email pattern runs straight through `"`, `,` and `}` and a
 * single address can swallow the surrounding structure. Use checkStructured
 * for anything with a shape.
 */
export function checkPayload(
  text: string,
  mode: GuardrailMode,
  patterns: GuardrailPattern[] = BUILT_IN_PATTERNS,
): CheckResult {
  const scanText = text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;
  const violations: GuardrailMatch[] = [];
  let redactedText = text;

  for (const p of patterns) {
    if (!p.pattern.test(scanText)) continue;
    violations.push({ label: p.label });
    if (mode === "redact") redactedText = redactedText.replace(globalOf(p.pattern), "[REDACTED]");
  }

  if (violations.length === 0) return { violations, redactedText };

  if (mode === "block") throw new GuardrailViolation(violations);
  if (mode === "warn") {
    log("guardrail warn: %s", violations.map((v) => v.label).join(", "));
  }

  return { violations, redactedText };
}

/** `replace` only rewrites every occurrence when the pattern is global, and
 * the built-ins are declared without /g so `.test()` stays stateless. */
function globalOf(pattern: RegExp): RegExp {
  return pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

export interface StructuredCheckResult {
  violations: GuardrailMatch[];
  /** The original value, or a redacted copy when mode is "redact". */
  value: unknown;
}

/**
 * Scans a request/response body by walking it and checking each string leaf,
 * rather than checking its serialized form.
 *
 * This is the only correct way to redact a body. Redacting the serialized
 * JSON and parsing the result back was how this used to work, and it
 * produced invalid JSON: with no whitespace between tokens, an email match
 * extends across the surrounding quotes and braces, so masking it deletes
 * real structure. `{"model":"m","messages":[{"role":"user","content":
 * "bob@example.com"}],"temperature":0.7}` redacted to `[REDACTED]}` - the
 * whole document - and the JSON.parse that followed threw a SyntaxError at
 * the caller. Walking the parsed value keeps every match inside one string,
 * so structure can never be damaged and no re-parse is needed.
 *
 * Scanning stays bounded overall (not per string), so a body made of many
 * small strings costs no more than one large one.
 */
export function checkStructured(
  value: unknown,
  mode: GuardrailMode,
  patterns: GuardrailPattern[] = BUILT_IN_PATTERNS,
): StructuredCheckResult {
  const seen = new Set<string>();
  let budget = MAX_SCAN_LENGTH;

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (budget <= 0) return node;
      const scanText = node.length > budget ? node.slice(0, budget) : node;
      budget -= scanText.length;

      let out = node;
      for (const p of patterns) {
        if (!p.pattern.test(scanText)) continue;
        seen.add(p.label);
        // Detection-only modes must return the payload untouched - "warn"
        // and "block" never rewrite what the caller sent.
        if (mode === "redact") out = out.replace(globalOf(p.pattern), "[REDACTED]");
      }
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      // Object.create(null): keys come from an untrusted payload, and
      // assigning `__proto__` onto an object literal reaches the prototype
      // setter. JSON.stringify treats a null-prototype object identically.
      const out: Record<string, unknown> = Object.create(null);
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };

  const redacted = walk(value);
  const violations = [...seen].map((label) => ({ label }));

  if (violations.length === 0) return { violations, value };

  // Thrown once, after the whole walk, so the error names every label that
  // matched rather than just the first one encountered.
  if (mode === "block") throw new GuardrailViolation(violations);
  if (mode === "warn") log("guardrail warn: %s", violations.map((v) => v.label).join(", "));

  return { violations, value: mode === "redact" ? redacted : value };
}
