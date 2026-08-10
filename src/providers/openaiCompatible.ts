import { GatewayTransport } from "./base.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export type ChatCompletionStream = AsyncIterable<unknown>;

class ChatCompletions {
  constructor(private readonly transport: GatewayTransport) {}

  /**
   * Returns the direct gateway/provider response body - no wrapping. With
   * `stream: true`, returns an async iterable of SSE chunks instead, matching
   * the real provider SDKs' streaming shape:
   *
   *     const stream = await client.chat.completions.create({ ..., stream: true });
   *     for await (const chunk of stream) { ... }
   *
   * See GatewayTransport.postStream for the guardrail asymmetry that applies
   * to streamed responses.
   */
  create(params: ChatCompletionParams & { stream: true }): Promise<ChatCompletionStream>;
  create(params: ChatCompletionParams): Promise<unknown>;
  create(params: ChatCompletionParams): Promise<unknown> {
    if (params.stream === true) {
      // Wrapped in a Promise (rather than returning the generator directly)
      // so both branches are awaited identically - `await create(...)` works
      // whether or not the caller asked for a stream.
      return Promise.resolve(this.transport.postStream("/v1/chat/completions", params));
    }
    return this.transport.post("/v1/chat/completions", params);
  }
}

class Chat {
  readonly completions: ChatCompletions;
  constructor(transport: GatewayTransport) {
    this.completions = new ChatCompletions(transport);
  }
}

/**
 * One client class covers every provider that only speaks OpenAI protocol at
 * the gateway boundary (16 of the gateway's 18 providers, per
 * packages/types/src/protocols.ts) - the gateway itself normalizes each
 * provider's real wire format, so the client-facing shape is identical
 * regardless of which one is behind it.
 */
export class OpenAICompatibleProvider {
  readonly chat: Chat;

  constructor(provider: string, options: { apiKey: string }) {
    const transport = new GatewayTransport(provider, options.apiKey);
    this.chat = new Chat(transport);
  }
}

function providerClient(provider: string) {
  return class extends OpenAICompatibleProvider {
    constructor(options: { apiKey: string }) {
      super(provider, options);
    }
  };
}

export const OpenAI = providerClient("openai");
export const Groq = providerClient("groq");
export const Azure = providerClient("azure");
export const Ollama = providerClient("ollama");
export const OpenRouter = providerClient("openrouter");
export const Together = providerClient("together");
export const Fireworks = providerClient("fireworks");
export const DeepSeek = providerClient("deepseek");
export const XAI = providerClient("xai");
export const Mistral = providerClient("mistral");
export const NIM = providerClient("nim");
export const LMStudio = providerClient("lmstudio");
export const Cohere = providerClient("cohere");
export const HuggingFace = providerClient("huggingface");
// Vertex (needs X-Vertex-Endpoint) and Bedrock (needs X-Aws-Access-Key-Id/
// X-Aws-Region/session-token, per docs/13-provider-expansion-plan.md) require
// extra per-request headers beyond just the provider key - these exports are
// placeholders until GatewayTransport supports passing extra headers through.
export const Vertex = providerClient("vertex");
export const Bedrock = providerClient("bedrock");
