/**
 * Span attribute name constants, modeled on OpenInference's semantic
 * conventions - single source of truth. Every other module imports from
 * here, never hardcodes a string, so a renamed attribute only changes in
 * one place.
 */
export const ATTR = {
  LLM_PROVIDER: "llm.provider",
  LLM_MODEL_NAME: "llm.model_name",
  LLM_TOKEN_COUNT_PROMPT: "llm.token_count.prompt",
  LLM_TOKEN_COUNT_COMPLETION: "llm.token_count.completion",
  LLM_LATENCY_MS: "llm.latency_ms",
  INPUT_VALUE: "input.value",
  OUTPUT_VALUE: "output.value",
  TOOL_NAME: "tool.name",
  TOOL_PARAMETERS: "tool.parameters",
  TOOL_RESULT: "tool.result",
  SERVICE_NAME: "service.name",
  GUARDRAIL_VIOLATION: "guardrail.violation",
  GUARDRAIL_ACTION: "guardrail.action",
} as const;

export const OBSERVRA_SPAN_KIND = {
  LLM: "LLM",
  TOOL: "TOOL",
} as const;

export type ObservraSpanKind = (typeof OBSERVRA_SPAN_KIND)[keyof typeof OBSERVRA_SPAN_KIND];
