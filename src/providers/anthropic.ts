import { GatewayTransport } from "./base.js";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Record<string, unknown>[];
}

export interface MessagesCreateParams {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  [key: string]: unknown;
}

/**
 * Native Anthropic shape - `client.messages.create({model, max_tokens,
 * messages})`, matching the real `@anthropic-ai/sdk`. The gateway's
 * AnthropicAdapter already sets `anthropic-version` itself, so the client
 * doesn't send it. Returns the direct gateway/provider response - no
 * wrapping needed, Anthropic's own content-block array is already the
 * ergonomic shape (`response.content[0].text`).
 */
export class Anthropic {
  readonly messages: { create: (params: MessagesCreateParams) => Promise<unknown> };

  constructor(options: { apiKey: string }) {
    const transport = new GatewayTransport("anthropic", options.apiKey);
    this.messages = {
      create: (params: MessagesCreateParams) => transport.post("/v1/messages", params),
    };
  }
}
