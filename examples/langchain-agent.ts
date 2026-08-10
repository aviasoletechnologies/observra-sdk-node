/**
 * Framework path: LangChain's own chat model, pointed at the gateway.
 * `instrument()` wraps LangChain's LLM and tool entrypoints in spans and
 * propagates trace context, so a multi-step run correlates as one trace.
 *
 * Note the LLM is LangChain's ChatOpenAI, NOT an observra client class -
 * LangChain only accepts its own BaseChatModel subclasses.
 *
 * Run:
 *   OBSERVRA_GATEWAY_KEY=obs_... GROQ_API_KEY=gsk_... \
 *   npx tsx examples/langchain-agent.ts
 */
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as observra from "../src/index.js";

const gatewayUrl = process.env.OBSERVRA_GATEWAY_URL ?? "http://localhost:8787";
const gatewayKey = process.env.OBSERVRA_GATEWAY_KEY!;

observra.configure({ gatewayUrl, gatewayKey, serviceName: "example-langchain", insecure: true });
await observra.instrument();

const llm = new ChatOpenAI({
  model: "llama-3.3-70b-versatile",
  apiKey: gatewayKey, // the SDK requires one; the gateway is what checks it
  configuration: {
    baseURL: `${gatewayUrl}/groq/v1`,
    defaultHeaders: {
      "X-Gateway-Key": gatewayKey,
      "X-Provider-Key": process.env.GROQ_API_KEY!,
    },
  },
});

const getWeather = tool(async ({ city }: { city: string }) => `It is 31C and sunny in ${city}.`, {
  name: "get_weather",
  description: "Get the current weather for a city",
  schema: z.object({ city: z.string() }),
});

// Minimal agent loop: ask -> model picks a tool -> run it -> feed result back.
const withTools = llm.bindTools([getWeather]);
const first = await withTools.invoke("What's the weather in Mumbai?");

if (first.tool_calls?.length) {
  const call = first.tool_calls[0];
  const result = await getWeather.invoke(call.args as never);
  const final = await withTools.invoke([
    { role: "user", content: "What's the weather in Mumbai?" },
    first,
    { role: "tool", content: String(result), tool_call_id: call.id! },
  ]);
  console.log(final.content);
} else {
  console.log(first.content);
}
