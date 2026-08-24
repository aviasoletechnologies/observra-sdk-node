import { log } from "../internal/log.js";
import { internalSignal } from "../internal/lifecycle.js";
import type { GuardrailPattern } from "./patterns.js";

/**
 * Client-side cache of an application's guardrail rules, fetched from the
 * gateway so the SDK enforces the rules the customer configured in the
 * dashboard rather than a hardcoded list that can silently disagree with them.
 *
 * Three properties this has to hold, in priority order:
 *
 *  1. It can never break or delay a real request. The gateway evaluates every
 *     request itself, so a failed or stale fetch costs a fast local rejection
 *     at worst - never correctness. Every path here fails open.
 *  2. It never blocks on the network mid-request. A stale copy is served while
 *     a refresh runs in the background, so no caller ever waits on the rules
 *     endpoint.
 *  3. It holds nothing across processes. Rules live in this module only, and
 *     are gone when the process exits.
 */

export type RuleAction = "block" | "redact";

/** Wire shape of GET /__observability/guardrails. */
interface WireRule {
  name: string;
  pattern: string;
  flags: string;
  failOnMatch: boolean;
  action: RuleAction;
}

/** A rule compiled and ready to run, carrying its own action - unlike the
 * SDK's former built-ins, where one global mode applied to every pattern. */
export interface CompiledRule extends GuardrailPattern {
  action: RuleAction;
  failOnMatch: boolean;
}

const RULES_PATH = "/__observability/guardrails";
const DEFAULT_TTL_MS = 60_000;

// A rules fetch that hangs must not keep a short-lived process alive or delay
// a refresh forever - the gateway is authoritative anyway, so giving up is
// always safe.
const FETCH_TIMEOUT_MS = 5_000;

interface CacheEntry {
  rules: CompiledRule[];
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<void> | null = null;

/** Test seam - resets module state between cases. */
export function resetRulesCache(): void {
  cache = null;
  inFlight = null;
}

/** A rule whose pattern doesn't compile is skipped, not fatal: one bad regex
 * saved in the dashboard must not disable every other rule for the app. */
function compile(wire: WireRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of wire) {
    if (typeof rule?.pattern !== "string" || typeof rule?.name !== "string") continue;
    if (rule.action !== "block" && rule.action !== "redact") continue;
    try {
      // 'g' is stripped: these are reused across many strings and a global
      // regex carries lastIndex between calls, which makes .test() alternate
      // true/false on identical input. Redaction re-adds it on a fresh copy.
      const flags = [...new Set((rule.flags ?? "").replace(/g/g, ""))].join("");
      compiled.push({
        label: rule.name,
        pattern: new RegExp(rule.pattern, flags),
        action: rule.action,
        failOnMatch: rule.failOnMatch !== false,
      });
    } catch (err) {
      log("guardrail rule %s has an invalid pattern, skipping: %s", rule.name, err);
    }
  }
  return compiled;
}

async function fetchRules(gatewayUrl: string, gatewayKey: string): Promise<void> {
  // Checked up front, not just via the listener below: adding a listener to an
  // already-aborted signal never fires it, so a refresh kicked off after
  // shutdown() would otherwise run completely unaborted - the very in-flight
  // request that crashes the process at exit. The exporter avoids this by
  // passing internalSignal straight to fetch(); this path cannot, because it
  // also needs its own timeout signal.
  if (internalSignal.aborted) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // Also give up if the process is exiting - a pooled connection still open
  // when the event loop is destroyed crashes the process (see lifecycle.ts).
  const abortOnExit = () => controller.abort();
  internalSignal.addEventListener("abort", abortOnExit);
  try {
    const res = await fetch(`${gatewayUrl}${RULES_PATH}`, {
      headers: { "X-Gateway-Key": gatewayKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      // A gateway too old to serve rules 404s here. That is not an error
      // worth surfacing - it just means no client-side rules, and the
      // gateway keeps enforcing on its own.
      log("guardrail rules fetch returned %d, keeping previous rules", res.status);
      return;
    }
    const body = (await res.json()) as { rules?: WireRule[]; refreshAfterSeconds?: number };
    const ttlMs = typeof body.refreshAfterSeconds === "number" && body.refreshAfterSeconds > 0
      ? body.refreshAfterSeconds * 1000
      : DEFAULT_TTL_MS;

    cache = { rules: compile(body.rules ?? []), expiresAt: Date.now() + ttlMs };
    log("guardrail rules loaded: %d rule(s)", cache.rules.length);
  } catch (err) {
    // Network failure, timeout, malformed JSON - all the same answer. Keep
    // whatever we already had; the gateway is still enforcing.
    log("guardrail rules fetch failed, keeping previous rules: %s", err);
  } finally {
    clearTimeout(timer);
    internalSignal.removeEventListener("abort", abortOnExit);
  }
}

/** Starts a refresh unless one is already running. Never rejects, never
 * awaited on the request path. */
function refresh(gatewayUrl: string, gatewayKey: string): Promise<void> {
  inFlight ??= fetchRules(gatewayUrl, gatewayKey).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The rules to apply right now. Returns immediately, always.
 *
 * On a cold cache that means an empty list rather than a wait: making the
 * first call of a process pay a network round-trip to learn about a
 * convenience check is the wrong trade, and the gateway evaluates that same
 * request regardless. Call primeRules() at startup to close that window.
 */
export function getRules(gatewayUrl: string, gatewayKey: string): CompiledRule[] {
  if (!cache) {
    void refresh(gatewayUrl, gatewayKey);
    return [];
  }
  // Stale-while-revalidate: serve the expired copy and refresh behind it, so
  // expiry never turns into latency on somebody's request.
  if (Date.now() >= cache.expiresAt) void refresh(gatewayUrl, gatewayKey);
  return cache.rules;
}

/** Awaitable first load, for startup. Safe to call more than once, and safe
 * to skip - getRules() works either way. */
export function primeRules(gatewayUrl: string, gatewayKey: string): Promise<void> {
  return refresh(gatewayUrl, gatewayKey);
}
