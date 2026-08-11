import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { describeLive } from "./live.js";
import { ChatOpenAI } from "@langchain/openai";
import { configure, instrument } from "../src/index.js";
import { traceparentFromContext } from "../src/tracing/context.js";
import { requireConfig } from "../src/config.js";

function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return env;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = parseEnvFile(path.resolve(process.cwd(), ".env"));
const GATEWAY_URL = "http://localhost:8787";
const GATEWAY_KEY = "obs_OW-AwB1vOnuq7EIUpF2kQgN6NQenBIz1";
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Records the headers that actually leave the process. Installed BEFORE
 * instrument() so instrument()'s own fetch patch wraps this one - i.e. we
 * observe headers *after* its traceparent injection, not before it. Getting
 * this order backwards silently reports "no traceparent" on a working SDK. */
let sentTraceparent = "NOT_SENT";
let sentGatewayKey: string | null = null;

describeLive("LangChain -> gateway (real framework integration path)", () => {
  beforeAll(async () => {
    configure({ gatewayUrl: GATEWAY_URL, gatewayKey: GATEWAY_KEY, insecure: true });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(
        init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined),
      );
      sentTraceparent = headers.get("traceparent") ?? "NOT_SENT";
      sentGatewayKey = headers.get("X-Gateway-Key");
      return originalFetch(input, init);
    };

    await instrument();
  });

  /**
   * The REAL framework integration path (plan.md Phase 5, "Two distinct
   * integration paths"): LangChain's own ChatOpenAI, pointed at the gateway's
   * Groq route - exactly what apps/docs documents for framework users. This
   * SDK's own provider classes are deliberately NOT involved; instrument()
   * is what adds spans and propagates trace context around LangChain's own
   * HTTP client.
   */
  it("makes a real call through the gateway and propagates trace context to it", async () => {
    const llm = new ChatOpenAI({
      model: "llama-3.3-70b-versatile",
      apiKey: GATEWAY_KEY, // the SDK requires one; the gateway is what actually checks it
      configuration: {
        baseURL: `${GATEWAY_URL}/groq/v1`,
        defaultHeaders: {
          "X-Gateway-Key": GATEWAY_KEY,
          "X-Provider-Key": env.GROQ_API_KEY,
        },
      },
    });

    const tracer = requireConfig().tracer;
    let agentTraceparent = "";

    const response = await tracer.startActiveSpan("agent", async (agentSpan) => {
      agentTraceparent = traceparentFromContext() ?? "";
      const result = await llm.invoke("Say hello in one word.");
      agentSpan.end();
      return result;
    });

    // 1. A real reply from a real model through the real gateway.
    expect(typeof response.content).toBe("string");
    expect((response.content as string).length).toBeGreaterThan(0);
    expect(sentGatewayKey).toBe(GATEWAY_KEY);

    // 2. traceparent actually left the process on the outbound request.
    //    Without instrumentFetch() this is "NOT_SENT" - LangChain's own HTTP
    //    client has no knowledge of our active span.
    expect(sentTraceparent).toMatch(TRACEPARENT_RE);
    expect(agentTraceparent).toMatch(TRACEPARENT_RE);

    // 3. It carries the SAME trace as the agent span (so the gateway's own
    //    observation correlates with this trace, ADR-006) but a DIFFERENT
    //    span id - the child LLM span opened by the LangChain patch, not the
    //    agent span itself.
    expect(sentTraceparent.split("-")[1]).toBe(agentTraceparent.split("-")[1]);
    expect(sentTraceparent.split("-")[2]).not.toBe(agentTraceparent.split("-")[2]);
  });
});
