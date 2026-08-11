import { describe, it } from "vitest";

/**
 * Live tests need a real gateway on localhost:8787 and real provider API
 * keys from .env - neither exists in CI, where they fail as ECONNREFUSED
 * rather than as a genuine regression. Opt in locally:
 *
 *   OBSERVRA_LIVE=1 pnpm test
 */
const LIVE = Boolean(process.env.OBSERVRA_LIVE);

export const describeLive = LIVE ? describe : describe.skip;
export const itLive = LIVE ? it : it.skip;
