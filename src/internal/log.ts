import { debuglog } from "node:util";

/**
 * Internal diagnostic logging - Node's stdlib equivalent of Python's
 * `logging.getLogger("observra")` (plan.md requirement #10): namespaced,
 * silent by default, opt-in via NODE_DEBUG=observra (no dependency needed
 * for what Node already ships). Never used for anything that affects
 * control flow - purely diagnostic.
 */
export const log = debuglog("observra");
