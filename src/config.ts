import type { Tracer } from "@opentelemetry/api";
import { createTracer } from "./tracing/tracer.js";
import type { GuardrailMode } from "./guardrails/check.js";

// Observra's hosted gateway. Defaulting here means the common case -
// a customer on the hosted platform - needs only a gateway key, and the URL
// only ever appears in config for self-hosted deployments.
export const DEFAULT_GATEWAY_URL = "https://gateway.observra.in";

export interface ConfigureOptions {
  /** Defaults to the hosted gateway; set it only when self-hosting. */
  gatewayUrl?: string;
  gatewayKey?: string;
  serviceName?: string;
  /** Allow a plaintext http:// gateway URL - local dev only, refused otherwise. */
  insecure?: boolean;
  /** "warn" (log only, default) | "redact" (mask before send/return) | "block" (throw GuardrailViolation). */
  guardrailMode?: GuardrailMode;
  /**
   * Ask the gateway to enforce its prompt-injection firewall more strictly
   * than this application's dashboard setting for calls from this process.
   *
   * Strictness only. The gateway resolves the real policy from the gateway
   * key and ignores anything here that would weaken it - otherwise whoever
   * holds the key could turn the firewall off by sending a header, which
   * defeats the point of having one. Leave it unset to use the configured
   * policy, which is the normal case.
   *
   * Deliberately narrower than the config the gateway holds: a scanned-roles
   * list or a score threshold sent from here could only ever *reduce* what is
   * checked, so there is nothing for the gateway to honour and no reason to
   * send them.
   */
  firewallMode?: FirewallMode;
}

/** Ordered least to most strict; the gateway takes whichever of its own
 * policy and this is stricter. */
export type FirewallMode = "log" | "flag" | "block";

export interface ObservraConfig {
  gatewayUrl: string;
  gatewayKey: string;
  serviceName?: string;
  tracer: Tracer;
  guardrailMode: GuardrailMode;
  firewallMode?: FirewallMode;
}

let activeConfig: ObservraConfig | null = null;

/**
 * Sets the module-level config once at process startup. Falls back to
 * OBSERVRA_GATEWAY_URL / OBSERVRA_GATEWAY_KEY env vars so it also works with
 * zero code changes in a container. Also builds the private tracer bundle
 * here (auto-registered exporter + processor at configure() time) - the
 * caller never wires OTel manually.
 */
export function configure(options: ConfigureOptions = {}): ObservraConfig {
  const gatewayUrl = (
    options.gatewayUrl ||
    process.env.OBSERVRA_GATEWAY_URL ||
    DEFAULT_GATEWAY_URL
  ).replace(/\/+$/, "");
  const gatewayKey = options.gatewayKey ?? process.env.OBSERVRA_GATEWAY_KEY;

  if (!gatewayKey) throw new Error("observra.configure(): gatewayKey is required (or set OBSERVRA_GATEWAY_KEY)");
  if (gatewayUrl.startsWith("http://") && !options.insecure) {
    throw new Error(
      "observra.configure(): plaintext http:// gateway URL refused - pass insecure: true for local dev only",
    );
  }

  activeConfig = {
    gatewayUrl,
    gatewayKey,
    serviceName: options.serviceName,
    tracer: createTracer({ gatewayUrl, gatewayKey, serviceName: options.serviceName }),
    guardrailMode: options.guardrailMode ?? "warn",
    firewallMode: options.firewallMode,
  };
  return activeConfig;
}

/**
 * Fail fast at client-construction time, not deep inside a request - a
 * provider client built before configure() is a programming error.
 */
export function requireConfig(): ObservraConfig {
  if (!activeConfig) {
    throw new Error("observra: call observra.configure(...) before creating a provider client");
  }
  return activeConfig;
}
