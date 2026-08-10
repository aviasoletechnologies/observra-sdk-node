import { describe, it, expect, beforeAll } from "vitest";
import { configure } from "../src/index.js";
import { traceparentFromContext } from "../src/tracing/context.js";
import { requireConfig } from "../src/config.js";

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

describe("tracing: context propagation across await boundaries", () => {
  beforeAll(() => {
    configure({ gatewayUrl: "http://localhost:8787", gatewayKey: "obs_test", insecure: true });
  });

  it("nests a child span under its parent, sharing trace ID but not span ID", async () => {
    const tracer = requireConfig().tracer;
    let parentTraceparent = "";
    let childTraceparent = "";

    await tracer.startActiveSpan("parent", async (parentSpan) => {
      parentTraceparent = traceparentFromContext() ?? "";
      await new Promise((resolve) => setTimeout(resolve, 5)); // force a real async gap
      await tracer.startActiveSpan("child", async (childSpan) => {
        childTraceparent = traceparentFromContext() ?? "";
        childSpan.end();
      });
      parentSpan.end();
    });

    expect(parentTraceparent).toMatch(TRACEPARENT_RE);
    expect(childTraceparent).toMatch(TRACEPARENT_RE);

    const parentTraceId = parentTraceparent.split("-")[1];
    const childTraceId = childTraceparent.split("-")[1];
    const parentSpanId = parentTraceparent.split("-")[2];
    const childSpanId = childTraceparent.split("-")[2];

    expect(childTraceId).toBe(parentTraceId);
    expect(childSpanId).not.toBe(parentSpanId);
  });
});
