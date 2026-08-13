import { PROMPT_INJECTION_HEADER } from "../config.js";

/**
 * Maps a provider's real API origin to its gateway route segment. The
 * gateway's own adapters already normalize whatever path the native SDK
 * sends (e.g. GroqAdapter explicitly handles `/openai/v1/...`, the prefix
 * groq-sdk uses), so rerouting is a pure origin swap - the path is passed
 * through untouched.
 */
const PROVIDER_ORIGINS: Record<string, string> = {
  "https://api.openai.com": "openai",
  "https://api.anthropic.com": "anthropic",
  "https://api.groq.com": "groq",
  "https://generativelanguage.googleapis.com": "gemini",
  "https://api.together.xyz": "together",
  "https://api.fireworks.ai": "fireworks",
  "https://api.deepseek.com": "deepseek",
  "https://api.x.ai": "xai",
  "https://api.mistral.ai": "mistral",
  "https://api.cohere.com": "cohere",
  "https://router.huggingface.co": "huggingface",
  "https://openrouter.ai": "openrouter",
  "https://ollama.com": "ollama",
};

/**
 * The header each provider's own SDK puts its API key in. We move that key
 * to `X-Provider-Key` and delete the original - critical for the Bearer
 * ones, because the gateway reads `Authorization: Bearer` as the *gateway*
 * key (see extractGatewayKeyToken in apps/gateway/src/server.ts), so
 * leaving it in place would make the gateway mistake a provider key for its
 * own credential and reject the request.
 */
const PROVIDER_KEY_HEADERS = ["authorization", "x-goog-api-key", "x-api-key", "api-key"];

export interface RewrittenRequest {
  url: string;
  headers: Headers;
  /** Gateway route segment the origin mapped to ("groq", "openai", ...) -
   * used to name the span the fetch patch opens for native-SDK calls. */
  provider: string;
}

/** Returns null when the URL isn't a known provider origin - caller passes through untouched. */
export function rewriteToGateway(
  url: string,
  headers: Headers,
  gatewayUrl: string,
  gatewayKey: string,
  promptInjectionDetection?: boolean,
): RewrittenRequest | null {
  const origin = Object.keys(PROVIDER_ORIGINS).find((o) => url.startsWith(o));
  if (!origin) return null;

  const segment = PROVIDER_ORIGINS[origin];
  const rewrittenUrl = `${gatewayUrl}/${segment}${url.slice(origin.length)}`;

  const rewritten = new Headers(headers);
  let providerKey: string | null = null;
  for (const header of PROVIDER_KEY_HEADERS) {
    const value = rewritten.get(header);
    if (!value) continue;
    providerKey = header === "authorization" ? value.replace(/^Bearer\s+/i, "") : value;
    rewritten.delete(header);
    break;
  }

  if (providerKey) rewritten.set("X-Provider-Key", providerKey);
  rewritten.set("X-Gateway-Key", gatewayKey);
  // Set only when configured: the gateway distinguishes an absent header
  // ("use the application's setting") from an explicit "false" ("skip this
  // call"), so the two must not collapse into one on the wire.
  if (promptInjectionDetection !== undefined) {
    rewritten.set(PROMPT_INJECTION_HEADER, String(promptInjectionDetection));
  }
  return { url: rewrittenUrl, headers: rewritten, provider: segment };
}
