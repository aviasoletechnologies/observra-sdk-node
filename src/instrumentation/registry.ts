import { createRequire } from "node:module";
import { log } from "../internal/log.js";
import { requireConfig } from "../config.js";
import { primeRules } from "../guardrails/rules.js";
import { instrumentLangChain, isLangChainCoreVersionSupported } from "./langchain.js";
import { instrumentFetch } from "./fetch.js";

const require = createRequire(import.meta.url);

let instrumented = false;

/**
 * Detects installed agent frameworks (Node's equivalent of Python's
 * `importlib.util.find_spec`) and patches the ones present - no-op for
 * frameworks not installed. Safe to call more than once. New frameworks
 * (LlamaIndex.TS, Vercel AI SDK, ...) plug into this same pattern as they
 * become priorities - each gets its own try*Instrument function, own
 * version-range check, own module.
 *
 * Async: patching must go through dynamic `import()`, not `require()` (see
 * langchain.ts's doc comment on the dual-package hazard this avoids), and
 * `import()` is inherently asynchronous.
 */
export async function instrument(): Promise<void> {
  if (instrumented) return;
  instrumented = true;
  // Framework-agnostic: every JS framework worth instrumenting ultimately
  // makes its provider calls over fetch, and none of them propagate our
  // trace context on their own - see fetch.ts.
  instrumentFetch();
  await tryInstrumentLangChain();
  await primeGuardrailRules();
}

/** Loads the application's guardrail rules once at startup so the first
 * request already has them. Deliberately not fatal and not required: getRules
 * refreshes lazily in the background, and the gateway evaluates every request
 * itself, so a failure here costs a missed local fast-fail and nothing more. */
async function primeGuardrailRules(): Promise<void> {
  try {
    const { gatewayUrl, gatewayKey } = requireConfig();
    await primeRules(gatewayUrl, gatewayKey);
  } catch (err) {
    log("guardrail rules could not be primed: %s", err);
  }
}

async function tryInstrumentLangChain(): Promise<void> {
  let pkg: { version: string };
  try {
    // package.json has no dual-module-instance hazard (it's data, not a
    // class/prototype) - require() here is fine, unlike the actual patch.
    pkg = require("@langchain/core/package.json");
  } catch {
    return; // not installed - nothing to patch
  }

  if (!isLangChainCoreVersionSupported(pkg.version)) {
    log("@langchain/core@%s is outside the tested range - skipping instrumentation", pkg.version);
    return;
  }

  try {
    await instrumentLangChain();
  } catch (err) {
    log("LangChain instrumentation failed to apply: %s", err);
  }
}
