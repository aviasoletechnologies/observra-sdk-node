# Observra Node.js SDK — Phase-wise Implementation Plan

Standalone package, separate from the `Observra-App` monorepo (plain folder for now,
no git init yet). Package manager: pnpm. Language: TypeScript.

Package name: `observra` (npm). Import name: `observra`.

Mirrors `docs/OBSERVRA_PYTHON_SDK_IMPLEMENTATION_STEPS.md` in the main repo -
same gateway contract, same production requirements, adapted to Node/TS idioms
where the ecosystem differs (native `fetch` instead of `httpx`, `@opentelemetry/*`
Node packages instead of the Python OTel SDK, no thread-safety section since
Node is single-threaded — async/Promise-safety takes its place).

---

## Why the phasing differs from the Python plan

The Python plan built one provider (Gemini) first, then would add others one at
a time. That doesn't fit here: **you asked for every provider the gateway
supports**, and the gateway's own protocol matrix (`packages/types/src/protocols.ts`
in the main repo) means most of that work is already shared:

| Protocol support | Providers | Client shape needed |
|---|---|---|
| OpenAI-only | `openai`, `groq`, `azure`, `ollama`, `openrouter`, `together`, `fireworks`, `deepseek`, `xai`, `mistral`, `nim`, `lmstudio`, `cohere`, `huggingface`, `vertex`, `bedrock` (16 total) | **One** shared OpenAI-shaped client class, parameterized by provider slug |
| OpenAI + native | `anthropic` | OpenAI-shaped (free, via the shared class) **+** its own native `messages.create` shape |
| OpenAI + native | `gemini` | OpenAI-shaped (free, via the shared class) **+** its own native `models.generateContent` shape (matches the screenshot) |

So Phase 1 gets all 16 OpenAI-protocol providers at once by building the shared
transport + one client class. Phase 2 adds the two native shapes on top. No
provider after that needs a new phase — new providers the gateway adds later
just need one line in a lookup table, as long as they stay OpenAI-protocol-only.

---

## Production requirements (apply across every phase, not optional polish)

Same contract as the Python SDK, restated for Node:

1. **Fail-open, always** — tracing/guardrail/export code never throws into the
   caller's real request, except the one deliberate `guardrailMode: "block"` ->
   `GuardrailViolation`. A gateway-unreachable error is real and must surface
   (gateway is the only upstream, ADR-001) — a telemetry-export failure must not.
2. **Isolated tracer provider** — never call the OTel API's global
   `trace.setGlobalTracerProvider()`. Build a private `TracerProvider` instance,
   get a tracer directly off it. A host app's own OTel setup must be unaffected.
3. **Bounded memory** — the span queue (`BatchSpanProcessor`'s own
   `maxQueueSize`/`maxExportBatchSize`) must stay bounded, same as the SDK's own
   default. Guardrail regex scanning must have a bounded cost per payload (cap
   scanned size).
4. **Retry only the export path** — `GatewayExporter` retries with capped
   backoff + jitter; the LLM call itself gets whatever retry policy the
   gateway/provider-adapter defines server-side, no silent client-side retry
   layered on top of the actual model call.
5. **Secrets handling** — `gatewayKey`/`apiKey` never logged, never in span
   attributes, never in thrown error messages. Guardrail-redacted text uses the
   same masking before it's placed on a span attribute. TLS only by default;
   plaintext `http://` gateway URLs refused unless `insecure: true` is passed
   explicitly (matches the screenshot's `insecure=True` local-dev escape hatch).
6. **Async-safety, not thread-safety** — Node has no threads, but `configure()`'s
   singleton must still be safe under concurrent in-flight requests (no mutation
   after first call). Same escape hatch as Python: `configure()` can return a
   config object for callers that need multiple configs (multi-tenant worker
   process), and provider clients accept an explicit `config` override instead
   of forcing one global config to be the only option.
7. **Versioned, pinned framework instrumentation** — each
   `instrumentation/<framework>.ts` module declares the exact framework version
   range it's tested against, checked at `instrument()` time; skip + warn rather
   than patch blind if the installed version is outside range.
8. **Public API stability** — strict semver. Only `configure`, the provider
   client classes, `instrument`, and `GuardrailViolation` are the stable
   surface — everything else lives under non-exported internal modules.
   Full TypeScript types shipped (`.d.ts`), no `any` in the public surface.
9. **Performance budget** — SDK-added synchronous overhead (span creation +
   attribute setting + guardrail check, excluding the network call itself)
   under ~1–2ms for typical payload sizes, enforced by a benchmark test that
   fails on regression.
10. **Internal observability** — a small namespaced internal logger (not
    `console.log` sprinkled around), default silent unless the host app opts
    in, so normal operation produces no output.

---

## Target end-state usage

```ts
import * as observra from "observra";

observra.configure({
  gatewayUrl: "http://localhost:8787",
  gatewayKey: "obs_...",
  insecure: true, // local dev only - refused in production without this
});

// Any of the 16 OpenAI-protocol providers, same shape:
const groq = new observra.Groq({ apiKey: process.env.GROQ_API_KEY! });
const response = await groq.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  messages: [{ role: "user", content: "Say hello in one line." }],
});
console.log(response.choices[0].message.content);

// Native-shape Gemini, matches the Python SDK's screenshot exactly:
const gemini = new observra.Gemini({ apiKey: process.env.GEMINI_API_KEY! });
const geminiResponse = await gemini.models.generateContent({
  model: "gemini-3.1-flash-lite",
  contents: "Summarize this support ticket: the customer can't reset their password.",
});
console.log(geminiResponse.text);
```

---

## Phase 0 — Package setup

1. `package.json` — name `observra`, `type: "module"`, dual ESM+CJS build via
   `tsup` (matches what npm consumers actually expect from an SDK package).
   Minimum Node 18 (native `fetch`, no polyfill dependency).
2. Dependency baseline:
   - `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` (tracing core - no
     Node auto-instrumentation package needed, spans are created manually)
   - `zod` (config validation - TS equivalent of the Python plan's `pydantic`)
   - No HTTP client dependency - native `fetch` (Node 18+) covers it, same
     "stdlib first" reasoning as the Python plan's own dependency choices.
3. Dev tooling: `typescript` (strict mode), `eslint`, `vitest` (matches the
   main repo's test runner), `tsup` (build), `msw` or a hand-rolled
   `fetch`-mocking helper for tests (mock gateway calls without a real server).
4. Package layout:
   ```
   observra-nodejs-sdk/
     src/
       index.ts
       config.ts
       tracing/
       guardrails/
       providers/
         base.ts          # shared transport, every provider reuses this
         openaiCompatible.ts  # the one class covering all 16 OpenAI-protocol providers
         gemini.ts
         anthropic.ts
       instrumentation/
     test/
     examples/
     package.json
     tsconfig.json
   ```

Deliverable: package builds (`tsup`), type-checks (`tsc --noEmit`), empty test
suite runs.

---

## Phase 1 — Config + shared transport + all 16 OpenAI-protocol providers

The highest-leverage phase: one implementation, sixteen providers unlocked.

1. `config.ts` — `ObservraConfig` (zod-validated): `gatewayUrl`, `gatewayKey`,
   `serviceName`, `environment`, `insecure`, default guardrail mode.
   `observra.configure(...)` sets a module-level singleton; also reads env vars
   (`OBSERVRA_GATEWAY_URL`, `OBSERVRA_GATEWAY_KEY`) for zero-code-change
   container deploys. Fail fast: instantiating a provider client before
   `configure()` (and no env vars set) throws immediately, not on first call.
   Refuse plaintext `http://` unless `insecure: true`.
2. `providers/base.ts` — `GatewayTransport`, the one piece of shared plumbing:
   - Builds the request URL as `{gatewayUrl}/{provider}/v1/chat/completions`.
   - Injects `X-Gateway-Key` and `X-Provider-Key` headers.
   - Injects `traceparent` from the active span context (stubbed until Phase 3
     wires real tracing in; provider-agnostic either way).
   - Wraps the call in a span (`kind: LLM"`), records token/latency attributes
     from the response.
   - Runs the guardrail check (stubbed until Phase 4) on outbound/inbound body.
   - Provider-agnostic - contains zero per-provider logic.
3. `providers/openaiCompatible.ts` — one class, constructed with a `provider`
   slug (`"groq"`, `"together"`, `"azure"`, ...) plus `apiKey`. Exposes
   `.chat.completions.create(...)` matching the real OpenAI Node SDK's method
   shape exactly, so migrating existing OpenAI-SDK code is a one-line import
   swap. Streaming variant included (async iterator over SSE chunks).
4. Thin named exports per provider (`observra.Groq`, `observra.OpenAI`,
   `observra.Together`, `observra.Fireworks`, `observra.DeepSeek`,
   `observra.XAI`, `observra.Mistral`, `observra.NIM`, `observra.LMStudio`,
   `observra.Cohere`, `observra.HuggingFace`, `observra.Vertex`,
   `observra.Bedrock`, `observra.Azure`, `observra.Ollama`,
   `observra.OpenRouter`) — each is a ~3-line subclass/factory over
   `openaiCompatible.ts` with its provider slug baked in. No new logic per
   provider; this is purely a DX/naming convenience layer.

Deliverable: integration test (mocked `fetch`) proving each of the 16 provider
exports reaches the correct gateway route (`/{provider}/v1/chat/completions`)
with correct headers; a real smoke test against the local gateway using the
Groq key already proven working in this session.

---

## Phase 2 — Native-shape providers (Gemini, Anthropic)

1. `providers/gemini.ts` — `Gemini` class, own constructor (`apiKey`), own
   method shape: `client.models.generateContent({ model, contents })` ->
   `response.text` / `response.candidates` - matches the real `@google/genai`
   Node SDK's shape and the Python SDK's screenshot 1:1. Internally reuses
   `GatewayTransport` with `provider: "gemini"`, native-protocol request body.
   Function-calling: detects `functionCall` parts, opens a child `TOOL` span
   (parent = the LLM span), same as the Python plan's mechanics.
2. `providers/anthropic.ts` — `Anthropic` class, `client.messages.create({...})`
   shape, content-block parsing (`tool_use`/`tool_result`), same tool-span
   pattern.
3. Both also get the OpenAI-shaped path for free from Phase 1 (the gateway
   accepts OpenAI protocol for these two as well) - native classes are purely
   additive, not a replacement.

Deliverable: mocked-response tests confirming native request/response shapes
round-trip correctly for both providers, tool-call detection produces the
correct child span.

---

## Phase 3 — Tracing core

1. `tracing/context.ts` — W3C Trace Context generation/propagation
   (`traceId`, `spanId`, `traceparent` string), using `@opentelemetry/api`'s
   own `context`/`propagation` APIs (Node's `AsyncLocalStorage`-backed context
   manager handles the "current active span" tracking across `await`
   boundaries automatically - the Node equivalent of Python's `contextvars`).
2. `tracing/conventions.ts` — span attribute name constants, modeled on
   OpenInference semantic conventions, single source of truth (same as the
   Python plan) - `llm.model_name`, `llm.provider`, `llm.token_count.prompt`,
   etc., span kinds `LLM`/`TOOL`/`CHAIN`/`AGENT`.
3. `tracing/tracer.ts` — wraps `@opentelemetry/sdk-trace-base`'s
   `BasicTracerProvider` (not the global one - see Requirement #2 above).
4. `tracing/exporter.ts` — custom `SpanExporter` POSTing finished spans to the
   gateway's span-ingest endpoint. **Same blocking dependency as the Python
   plan**: this endpoint doesn't exist on the gateway yet (confirmed - no
   `ingest` route anywhere in `apps/gateway` or `apps/dashboard` as of this
   writing). Stub behind an interface now; do not block Phases 0-2 on it.
   Track resolving it as a cross-SDK (Python + Node) shared dependency, not
   duplicated design work per SDK.

Deliverable: unit test proving a span's `traceparent` round-trips; fake
exporter test confirming attribute names match `conventions.ts`.

---

## Phase 4 — Guardrails

1. `guardrails/patterns.ts` — built-in regex set (email, phone, SSN-shaped,
   API-key/token-shaped), shipped as data.
2. `guardrails/check.ts` — `checkPayload(payload, mode): CheckResult` with
   modes `block` | `redact` | `warn`.
3. `guardrails/policyClient.ts` — optional org/environment policy fetch from
   the gateway at client init, TTL-cached in-process; falls back to built-in
   patterns only if unreachable (never hard-fails client construction).

Deliverable: tests per mode (block throws, redact masks + continues, warn logs
+ tags span without altering payload), plus the policy-fetch-fails-gracefully
path.

### Guardrails cannot be enforced on streamed OUTPUT

An unavoidable consequence of streaming (Phase 1), not an implementation
shortcut:

| Direction | Non-streaming | Streaming (`stream: true`) |
|---|---|---|
| Outbound (request) | block / redact / warn — fully enforced | **identical**, runs before anything is sent |
| Inbound (response) | block / redact / warn — fully enforced | **advisory only** — tags the span, cannot alter output |

By the time a streamed chunk exists it has already been handed to the
caller, so retroactive blocking or redaction is impossible - buffering the
whole stream to check it first would defeat the point of streaming. Callers
who need *enforced* output guardrails must not stream. This is documented on
`GatewayTransport.postStream` at the call site too, so it can't be missed by
someone reading only the code.

---

## Phase 5 — Framework instrumentation

1. `instrumentation/registry.ts` — `observra.instrument()`, detects installed
   agent frameworks (checking `require.resolve` / package.json presence,
   Node's equivalent of Python's `importlib.util.find_spec`), applies matching
   patches, no-ops for frameworks not installed.
2. `instrumentation/langchain.ts` — patches LangChain.js's LLM call entrypoint
   and tool-execution entrypoint into child spans, same conventions as
   Phase 3. Reference `openinference-instrumentation-langchain`'s technique
   (patch points), don't copy code.
3. Repeat pattern for other JS agent frameworks as they become priorities
   (Vercel AI SDK, LlamaIndex.TS) - same structure, framework-specific patch
   points only, each with its own pinned version range (Requirement #7).

### Two distinct integration paths - do not conflate them

An earlier draft of this phase (inherited from the Python plan's wording,
`llm = observra.Gemini(...)  # passed into LangChain like any Gemini client`)
assumed a provider client from Phase 1/2 could be handed to LangChain as its
`llm`. **It cannot.** LangChain only accepts objects extending its own
`BaseChatModel`; `observra.Groq` is a standalone client with its own method
shape and deliberately does not subclass a framework type. Two separate,
both-valid paths:

| Using a framework? | What the user writes | Where spans come from |
|---|---|---|
| No | `observra.Groq` etc. directly (Phase 1/2) | `GatewayTransport`'s own span, Phase 3 |
| Yes | LangChain's own `ChatOpenAI`/`ChatGroq` with `baseURL` pointed at the gateway route + `X-Provider-Key`/`X-Gateway-Key` in `defaultHeaders` (exactly what `apps/docs` already documents) | `observra.instrument()`, this phase |

The framework path never touches this SDK's provider classes at all - it's
LangChain's own client talking to the gateway, with our patches adding spans
around it. Building a `BaseChatModel` subclass to bridge the two is a
possible future addition, deliberately not in scope: it would mean tracking
LangChain's own base-class API as a hard dependency of our provider layer.

Deliverable: two tests. (a) instrumentation correctness against a fake
`BaseChatModel` + real `tool()` - asserts the span tree (agent -> LLM ->
tool -> LLM) with no network and no provider keys needed; (b) the real
framework path end to end - LangChain's own chat model pointed at the local
gateway, real provider call, asserting both a real response and correctly
nested spans.

---

## Phase 6 — Public API assembly

Freeze the public surface in `index.ts`:

```ts
export { configure } from "./config.js";
export { Gemini } from "./providers/gemini.js";
export { Anthropic } from "./providers/anthropic.js";
export { Groq, OpenAI, Together, Fireworks, DeepSeek, XAI, Mistral, NIM,
         LMStudio, Cohere, HuggingFace, Vertex, Bedrock, Azure, Ollama,
         OpenRouter } from "./providers/openaiCompatible.js";
export { instrument } from "./instrumentation/registry.js";
export { GuardrailViolation } from "./guardrails/check.js";
```

Everything else stays out of the package's public entrypoint (internal
modules not re-exported), same enforcement goal as the Python plan's `__all__`.

**No ESLint rule needed** - an earlier draft of this phase called for
`no-restricted-imports` to block deep imports. The `exports` map in
`package.json` already does it at the platform level, and does it better: a
lint rule only binds code we control, whereas the exports map blocks *every*
consumer, including ones who never run our lint config. Verified against a
real `npm pack` → `npm install` of the tarball:

- 22 public exports, exactly the frozen list - nothing missing, nothing extra
- `observra/dist/internal/log.js`, `observra/dist/providers/base.js` and
  `observra/src/index.ts` all fail to import
- A strict-mode TypeScript consumer type-checks clean against the published
  `.d.ts`, with no `any` in the public surface
- The tarball contains only `dist/` + `package.json` - no `src`, no tests,
  and crucially no `.env`

---

## Phase 7 — Examples & docs

1. `examples/basicGroq.ts`, `examples/basicGemini.ts` - direct SDK usage.
2. `examples/langchainAgent.ts` - client inside a LangChain.js agent with a tool.
3. `README.md` - install, configure, minimal usage, link to the Observra
   dashboard. No architecture rationale duplicated here - push "why" into a
   separate `ARCHITECTURE.md` if needed, same split as the Python plan.

---

## Phase 8 — Packaging & release

**Version: `0.1.0` is the first and only release.** The `0.1.0 → 0.2.0 →
0.3.0` ladder above assumed each phase shipped separately; they didn't -
Phases 0-7 all landed before any publish, so there is nothing to stage. One
`0.1.0` containing everything is correct semver for an initial, still-
unstable public API.

**Build: `tsc`, not `tsup`.** `tsconfig.json` already emitted ESM +
`.d.ts` to `dist/`, so a bundler was a dependency for work an installed tool
already did. ESM-only, no CJS build - `type: module`, Node 18+ floor. Add a
dual build when a CJS consumer actually asks.

Ready to publish, verified:

- `npm pack` → 39 files, 23.8 kB: `dist/` + `README.md` + `LICENSE` +
  `package.json`. No `src`, no tests, **no `.env`** (the `files` allowlist is
  what prevents the live provider keys in the package root from shipping -
  npm does not read `.gitignore`).
- Installed the tarball into a clean project and made **real gateway calls
  from the built `dist/`** - native-SDK path, wrapper-class path, and
  streaming all returned live provider responses.
- Deep imports (`observra/dist/internal/...`) blocked by the `exports` map;
  strict-mode TS consumer type-checks clean.
- `@opentelemetry/api` is a `peerDependency`, so a host app running its own
  OpenTelemetry shares one instance instead of getting a second copy (two
  copies silently break context propagation). Doing this before first publish
  matters - changing it after is a breaking change.

Remaining, and deliberately not automated: `npm publish` itself. It is
irreversible (npm's unpublish window is narrow and restricted) and requires
an authenticated npm account, so it is a human action, not a scripted one.

Strict semver from here - instrumentation patches are exactly what breaks on
a framework's minor version bump, so pin supported ranges per instrumentation
module and bump this package's minor version when a range changes.

---

## Span ingest (was an open dependency, now built)

`GatewayExporter`'s target endpoint existed only as a placeholder path while
Phases 0-8 were built. It now exists for real, in the main Observra repo:

- `POST /__observability/spans` on the gateway (`apps/gateway/src/lib/span-
  ingest.ts`) - gateway-key auth, per-span validation, then relay over NATS
  on `spans.events`. Per ADR-007 the gateway stores nothing.
- `services/observation-worker` consumes that subject into the new `spans`
  table (`packages/database/src/schema/spans.ts`, migration `0036`),
  idempotent on the `(trace_id, span_id)` PK and purged on the same
  per-project retention schedule as observations (ADR-003).

No SDK code changed - the exporter's wire shape was already what the gateway
now accepts. Verified end to end: the consumer smoke test's agent/tool spans
land in `spans` and share trace ids with their `observations` rows.

Still open, and shared with the Python SDK: **the dashboard has no trace
view**, so these spans are queryable but not yet rendered as a waterfall.
That's a dashboard feature, not an SDK or gateway gap.
