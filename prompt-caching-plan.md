# Prompt Caching — Plan

## What we are building

Right now, if your app sends the exact same prompt to the AI twice, it pays
for and waits on two real API calls — even though the answer will be
identical.

We want the SDK to remember what it already asked. Same prompt, same
settings → skip the real call, return the saved answer instantly, for free.

**Example:** an app has a "summarize this FAQ page" feature. 50 different
users hit the same FAQ in one day. Without caching: 50 real AI calls, 50
times the cost. With caching: 1 real call, 49 instant free replays.

## Does the gateway need to change?

**No.** This is answered up front because it's the question that started
this doc.

A cache hit means the SDK returns an answer *before it ever calls `fetch()`
at all* — the gateway never sees the request, the same way it never sees a
request that gets blocked by a guardrail before send. Nothing about the
gateway's routing, auth, or event pipeline needs to know this feature
exists.

The one real consequence, not a blocker but worth being honest about: a
cache hit produces **no `GatewayEvent`**, because no request reached the
gateway. That means:

- No dashboard "observation" row for that call.
- No cost/latency numbers recorded for it (which is arguably correct — it
  really did cost $0 and take 0ms).
- No trace-context correlation with whatever the cache-hit content was
  originally generated as part of.

If we later want cache hits to be *visible* in the dashboard (so a customer
can see "how much am I saving from caching"), that's a real feature, but it
is separate from making caching work, and it would need a small gateway or
dashboard change at that point — not now. Flagged as future, not built here.

## The real design decisions

These are the things that actually determine whether this feature is safe
to ship, not implementation detail.

### 1. Opt-in, not automatic

Caching must **not** be on by default. Some prompts should never be
cached — "what's the weather," "roll a die," anything with `temperature`
set high on purpose for variety. The SDK cannot tell the difference between
"this should always give the same answer" and "this should surprise me
every time."

Decision: caching is off unless explicitly turned on, either globally
(`configure({ promptCache: { enabled: true } })`) or per call. Per-call is
the safer default to design around — a customer opts a *specific* call path
into caching, not their whole app.

### 2. Cache key

A hash of everything that actually determines the answer: `model` +
`messages` + the sampling parameters that affect determinism
(`temperature`, `top_p`, etc.) + any tool definitions passed. Two requests
that differ in any of those are different requests, full stop — no fuzzy
matching, no "close enough."

Deliberately **not** included in the key: `stream: true/false`. Same prompt
asked once streamed and once not should hit the same cache entry — see
streaming below.

### 3. Where the cache lives

**In-memory, per-process, `Map`-based**, same category of thing as the
guardrail-rules cache already in this SDK (`src/guardrails/rules.ts`) — no
new dependency, gone when the process restarts, not shared across multiple
server instances.

This is a real limitation for a multi-instance deployment (each server
process has its own cache, so the "50 users hit the same FAQ" example only
saves calls *within one process*). A Redis-backed store would fix that, but
it's a second, bigger feature — pulling in a Redis dependency for
everyone, including the many users who run a single process. Not building
that now; the in-memory cache should be written behind a small interface so
a pluggable store can be added later without an API break, but only that
interface — no second implementation until someone actually needs it.

### 4. TTL and eviction

Every cache entry needs an expiry — "cache forever" is how a customer ships
a support bot that repeats yesterday's stale answer. Default TTL:
configurable, sensible default around 5 minutes. Also needs a max entry
count (bounded `Map`, oldest evicted first) so a long-running process with
highly varied prompts can't leak memory unboundedly.

### 5. Interaction with guardrails

The cached value is whatever the SDK returned *after* guardrails already
ran on it (redaction already applied, etc.) — first call: check, then
cache the checked result. Cache hit: return the already-checked result
directly, no re-check.

This is intentionally simple and has one accepted edge case: if an org's
guardrail rules change between the original call and a later cache hit, the
cache hit still returns the OLD (pre-change) redaction behavior until that
entry expires. Treated as acceptable — the TTL bounds how long that can
last, and re-checking on every cache hit would erase most of the point of
caching (skipping work).

### 6. Streaming

A cached entry stores the fully assembled response (all chunks joined), not
a token-by-token replay. On a cache hit for a `stream: true` call, the SDK
still returns an async iterable (so calling code doesn't need to branch on
cache vs. no-cache) — but it yields the complete cached text as one chunk
immediately, rather than a real word-by-word stream. Documented plainly as
"a cache hit does not preserve the typing effect," since that's a visible,
real difference from a live response.

### 7. What "success" gets cached

Only a genuinely successful response. Provider errors, guardrail blocks,
and network failures are never cached — caching a failure would mean every
retry of a transient error instantly fails again from cache, which is
strictly worse than no caching at all.

## What this will not do (v1)

- No cross-process/shared cache (no Redis backing) — in-memory only.
- No dashboard visibility into cache hits/savings.
- No automatic cache-on-by-default heuristics (e.g. "cache if temperature
  is 0"). Explicit opt-in only.
- No cache invalidation API ("clear the cache for X") beyond TTL expiry and
  process restart — add if a real need shows up.

## Open questions for you

1. Per-call opt-in (`create({ ..., cache: true })`) vs. global config
   (`configure({ promptCache: { enabled: true } })`) vs. both? Leaning
   "both, call-level overrides global" — matches how `guardrailMode` already
   works.
2. Default TTL — is 5 minutes a reasonable starting default, or should
   there be no default at all (require the customer to set one explicitly)?
3. Should a cache hit still open an OpenTelemetry span (tagged
   `cache.hit: true`, zero cost/latency) so it at least shows up in a trace
   view, even without a dashboard observation row? This costs nothing and
   seems worth doing, but flagging it since it's a judgment call, not a
   requirement.

---

# For the engineer building it (once the above is confirmed)

## New module: `src/cache/promptCache.ts`

Mirrors the shape of `src/guardrails/rules.ts` (this SDK already has one
working example of an in-memory, TTL'd, per-process cache — reuse the
pattern, don't invent a new one):

```ts
interface CacheEntry {
  response: unknown;        // the already guardrail-checked response
  streamChunks?: unknown[]; // only set for a stream:true call
  expiresAt: number;
}

interface PromptCacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
}
```

`PromptCacheStore` is the pluggable-store seam from decision #3 — one
in-memory implementation shipped, interface exported so a future Redis
store can implement it without changing call sites.

## Cache key

```ts
function cacheKey(provider: string, body: unknown): string {
  // hash of { model, messages, temperature, top_p, tools, ... } —
  // NOT stream, NOT stream-only fields.
}
```

Use Node's built-in `crypto.createHash("sha256")` — no new dependency.

## Wiring point

`GatewayTransport.post()` / `postStream()` in `src/providers/base.ts`,
same place guardrails were wired in (`prepareCall`) — after the outbound
guardrail check (so the key reflects the post-redaction body, keeping the
cache key stable regardless of what the raw user input contained), before
`doFetch`/`doFetchRaw`:

```
prepareCall() → [cache lookup] → hit? return cached, skip fetch entirely
                                → miss? doFetch() as today → [cache store]
```

## Non-goals reminder for implementation

Do not build a Redis-backed store, a cache-clear API, or dashboard
visibility as part of the first pass — those are explicitly deferred above.
Building the interface seam is enough; building the second implementation
before it's needed is exactly the kind of premature abstraction to avoid.
