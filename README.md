# observra

Node.js SDK for the [Observra](https://observra.in) AI gateway. Routes your LLM
calls through the gateway so every request shows up in your dashboard — tokens,
latency, cost, errors — without changing how you call your provider.

Requires Node 18+.

## Install

```bash
npm install observra
```

## Setup

You need two things from the [Observra dashboard](https://dashboard.observra.in):

- **Gateway key** (`obs_...`) — identifies your application to Observra
- Your own **provider key** (OpenAI, Groq, Anthropic, …) — Observra forwards it and never stores it

```ts
import * as observra from "observra";

observra.configure({
  gatewayUrl: "https://gateway.observra.in",
  gatewayKey: process.env.OBSERVRA_GATEWAY_KEY,
});
```

`gatewayUrl` and `gatewayKey` also read from `OBSERVRA_GATEWAY_URL` /
`OBSERVRA_GATEWAY_KEY`, so containers need no code change.

## Two ways to use it

### 1. Keep your own provider SDK (recommended)

Call `instrument()` once. Your existing client code is untouched — no
`baseURL`, no headers.

```ts
import OpenAI from "openai";
import * as observra from "observra";

observra.configure({ gatewayKey: process.env.OBSERVRA_GATEWAY_KEY });
await observra.instrument();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const res = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Say hello in one word." }],
});
console.log(res.choices[0].message.content);
```

Works the same for `groq-sdk`, `@anthropic-ai/sdk`, `@google/genai`,
`@mistralai/mistralai`, and any agent framework built on them (LangChain,
Google ADK, …) — they all issue their calls over `fetch`, which is what
`instrument()` hooks.

### 2. Use Observra's clients

No provider SDK dependency at all.

```ts
import * as observra from "observra";

observra.configure({ gatewayKey: process.env.OBSERVRA_GATEWAY_KEY });

const client = new observra.Groq({ apiKey: process.env.GROQ_API_KEY });
const res = await client.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Say hello in one word." }],
});
```

Available: `OpenAI`, `Anthropic`, `Gemini`, `Groq`, `Azure`, `Ollama`,
`OpenRouter`, `Together`, `Fireworks`, `DeepSeek`, `XAI`, `Mistral`, `NIM`,
`LMStudio`, `Cohere`, `HuggingFace`, `Vertex`, `Bedrock`.

`Gemini` and `Anthropic` also keep their native shapes
(`.models.generateContent(...)`, `.messages.create(...)`).

These return the provider's raw response typed as `unknown`, so you cast it
yourself. If you want your provider SDK's own types, use option 1.

## Streaming

```ts
const stream = await client.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Count to three." }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
}
```

## Guardrails

Scans requests and responses for PII and secret-shaped strings.

```ts
observra.configure({
  gatewayKey: process.env.OBSERVRA_GATEWAY_KEY,
  guardrailMode: "block", // "warn" (default) | "redact" | "block"
});
```

| Mode | Behavior |
|---|---|
| `warn` | Records the violation on the trace, changes nothing |
| `redact` | Masks matches with `[REDACTED]` before sending/returning |
| `block` | Throws `observra.GuardrailViolation` before any network call |

**Streaming caveat:** on a streamed response, output guardrails are advisory
only. A chunk is already in your hands by the time it can be inspected, so
`redact`/`block` cannot apply to it. Requests are still fully enforced. Don't
stream if you need enforced output guardrails.

## Errors

Anything the gateway or provider rejects arrives as `GatewayError`, with the
upstream message intact:

```ts
try {
  await client.chat.completions.create({ ... });
} catch (err) {
  if (err instanceof observra.GatewayError) {
    console.error(err.status, err.message); // e.g. 429, "quota exceeded"
  }
}
```

Telemetry never does this — a tracing or guardrail-internal failure is
swallowed and logged, never surfaced as a failed LLM call. Set
`NODE_DEBUG=observra` to see those internal logs.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `gatewayUrl` | `OBSERVRA_GATEWAY_URL` | Must be `https://` unless `insecure: true` |
| `gatewayKey` | `OBSERVRA_GATEWAY_KEY` | Required |
| `serviceName` | `observra-app` | Shown on your traces |
| `guardrailMode` | `"warn"` | `"warn"` \| `"redact"` \| `"block"` |
| `insecure` | `false` | Allows plaintext `http://` — local dev only |

## Shutting down

Spans are batched, so some are usually still queued when your code finishes.
On a normal exit the SDK flushes them for you and there is nothing to do.

If your app calls `process.exit()` — scripts, CLIs, job runners — await
`shutdown()` first:

```ts
await observra.shutdown();
process.exit(0);
```

`process.exit()` skips Node's `beforeExit` event and destroys the event loop
on the spot. Without `shutdown()` you lose the queued spans, and if a
telemetry request is still in flight the process aborts on a libuv assertion
(`!(handle->flags & UV_HANDLE_CLOSING)`) instead of exiting. No library hook
can prevent that from the inside — `exit` handlers cannot await — so this one
call is the fix.

`shutdown()` never throws, and is safe to call twice or before `configure()`.

## Examples

Runnable, in [`examples/`](./examples):

- [`native-sdk.ts`](./examples/native-sdk.ts) — your own SDK + `instrument()`
- [`wrapper-classes.ts`](./examples/wrapper-classes.ts) — Observra clients, incl. streaming
- [`langchain-agent.ts`](./examples/langchain-agent.ts) — LangChain agent with a tool

## Notes

- `@opentelemetry/api` is a peer dependency. If your app already runs OpenTelemetry, the SDK uses your instance rather than a second copy.
- `instrument()` rewrites only requests bound for known provider hosts. Traffic to anything else is untouched, and trace context is only ever sent to your gateway.
