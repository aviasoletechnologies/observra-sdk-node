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
   * Ask the gateway to run prompt-injection detection on calls from this
   * process. Mirrors the Python SDK's `prompt_injection_detection`.
   *
   * Leave it unset and the header is omitted entirely, which is not the same
   * as passing `false`: the gateway treats an absent header as "use whatever
   * the application is configured for", and an explicit `false` as "skip the
   * scan for this call". Defaulting to `false` here would silently switch off
   * server-side detection for every application whose SDK was upgraded, so
   * `undefined` has to stay distinct from `false` all the way to the wire.
   */
  promptInjectionDetection?: boolean;
}

export interface ObservraConfig {
  gatewayUrl: string;
  gatewayKey: string;
  serviceName?: string;
  tracer: Tracer;
  guardrailMode: GuardrailMode;
  /** undefined = send no header at all; see ConfigureOptions above. */
  promptInjectionDetection?: boolean;
}

/**
 * The gateway reads this to decide whether to scan a request
 * (apps/gateway/src/lib readSdkPromptInjectionFlag). Exported as a constant
 * because both integration paths - the wrapper transport and the fetch patch -
 * have to send the identical name, and a typo in one of them would be a
 * silently half-working feature.
 */
export const PROMPT_INJECTION_HEADER = "X-Observra-Prompt-Injection-Detection";

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
    // No ?? default on purpose - see ConfigureOptions.promptInjectionDetection.
    promptInjectionDetection: options.promptInjectionDetection,
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
