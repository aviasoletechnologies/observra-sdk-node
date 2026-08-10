import { GatewayTransport } from "./base.js";

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  thought?: boolean;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GenerateContentParams {
  model: string;
  /** A plain string is wrapped into a single user turn, matching the real SDK. */
  contents: string | GeminiContent[];
}

/** The direct gateway response, plus a `.text` convenience accessor matching
 * the real `@google/genai` SDK's own response shape - nothing is removed or
 * hidden, just added on top. */
export interface GenerateContentResponse {
  candidates?: { content: GeminiContent }[];
  text: string;
  [key: string]: unknown;
}

function toContents(contents: string | GeminiContent[]): GeminiContent[] {
  return typeof contents === "string" ? [{ role: "user", parts: [{ text: contents }] }] : contents;
}

function withConvenienceAccessors(raw: Record<string, unknown>): GenerateContentResponse {
  const candidates = raw.candidates as { content: GeminiContent }[] | undefined;
  const text = (candidates?.[0]?.content?.parts ?? [])
    // "thought" parts are the model's internal reasoning, not its answer.
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text as string)
    .join("");
  return { ...raw, text } as GenerateContentResponse;
}

/**
 * Native Gemini shape - `client.models.generateContent({model, contents})` ->
 * `response.text`, matching the real `@google/genai` SDK and the Python SDK's
 * screenshot exactly. Also reachable via the OpenAI-compatible shape (Phase 1)
 * since the gateway accepts both protocols for this provider - this class is
 * purely additive.
 */
export class Gemini {
  readonly models: { generateContent: (params: GenerateContentParams) => Promise<GenerateContentResponse> };

  constructor(options: { apiKey: string }) {
    const transport = new GatewayTransport("gemini", options.apiKey);
    this.models = {
      generateContent: async (params: GenerateContentParams) => {
        const raw = (await transport.post(`/v1beta/models/${params.model}:generateContent`, {
          contents: toContents(params.contents),
        })) as Record<string, unknown>;
        return withConvenienceAccessors(raw);
      },
    };
  }
}
