import { describe, it, expect, beforeAll } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { configure, instrument } from "../src/index.js";
import { traceparentFromContext } from "../src/tracing/context.js";
import { requireConfig } from "../src/config.js";

const captured: { llm1?: string; tool?: string; llm2?: string } = {};
let pass = 0;

/** Minimal fake chat model - real integrations (ChatGroq, ChatOpenAI, ...)
 * all extend this same base class and inherit the same patched `invoke`,
 * so exercising it here proves the patch works for any of them. */
class FakeChatModel extends BaseChatModel {
  _llmType() {
    return "fake";
  }
  async _generate(_messages: BaseMessage[]) {
    pass += 1;
    if (pass === 1) {
      captured.llm1 = traceparentFromContext();
      return {
        generations: [{ text: "", message: new AIMessage({ content: "", tool_calls: [{ name: "get_weather", args: { city: "Mumbai" }, id: "call_1" }] }) }],
      };
    }
    captured.llm2 = traceparentFromContext();
    return { generations: [{ text: "72F and sunny in Mumbai", message: new AIMessage("72F and sunny in Mumbai") }] };
  }
}

const getWeather = tool(
  async ({ city }: { city: string }) => {
    captured.tool = traceparentFromContext();
    return `72F and sunny in ${city}`;
  },
  { name: "get_weather", description: "Get current weather for a city", schema: z.object({ city: z.string() }) },
);

describe("LangChain instrumentation", () => {
  beforeAll(async () => {
    configure({ gatewayUrl: "http://localhost:8787", gatewayKey: "obs_test", insecure: true });
    await instrument();
  });

  it("nests LLM/TOOL spans under a parent span without altering behavior", async () => {
    const llm = new FakeChatModel({});
    const tracer = requireConfig().tracer;

    // The "agent" root span stands in for what a real AgentExecutor's own
    // instrumentation (or the calling app's code) would provide - proving
    // that GIVEN an active parent context, the patched LLM/TOOL invoke()
    // calls nest under it correctly is the thing to prove. No AgentExecutor
    // dependency: the instrumentation patches BaseChatModel/StructuredTool
    // directly, so it doesn't matter what orchestrates the calls above them.
    const final = await tracer.startActiveSpan("agent", async (agentSpan) => {
      const first = await llm.invoke("What's the weather in Mumbai?");
      expect((first as AIMessage).tool_calls).toHaveLength(1);
      const toolResult = await getWeather.invoke({ city: "Mumbai" } as never);
      expect(toolResult).toBe("72F and sunny in Mumbai");
      const result = await llm.invoke("tool result: " + toolResult);
      agentSpan.end();
      return result;
    });

    expect(pass).toBe(2);
    expect(captured.llm1).toBeTruthy();
    expect(captured.tool).toBeTruthy();
    expect(captured.llm2).toBeTruthy();

    const traceId = (s: string) => s.split("-")[1];
    const spanId = (s: string) => s.split("-")[2];

    expect(traceId(captured.tool!)).toBe(traceId(captured.llm1!));
    expect(traceId(captured.llm2!)).toBe(traceId(captured.llm1!));
    expect(spanId(captured.tool!)).not.toBe(spanId(captured.llm1!));
    expect(spanId(captured.llm2!)).not.toBe(spanId(captured.llm1!));

    expect((final as AIMessage).content).toBe("72F and sunny in Mumbai");
  });
});
