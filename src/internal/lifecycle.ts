/**
 * Every SDK-internal HTTP call (span export, guardrail rules) carries this
 * signal, so shutdown() can cancel whatever is still in flight instead of
 * waiting out its timeout.
 *
 * Why this matters beyond tidiness: an app that calls process.exit() while
 * one of our telemetry requests is still in flight crashes, because libuv
 * refuses the teardown -
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *
 * There is no hook that saves such an app on its own. "beforeExit" is not
 * emitted by process.exit() at all, and an "exit" handler cannot run async
 * work - aborting from one was measured to change nothing, because the loop
 * is already being destroyed by then. The only thing that actually works is
 * for the request to be finished before exit is called, which is what
 * awaiting shutdown() guarantees.
 */
const controller = new AbortController();

/** Signal for SDK-internal (never customer) HTTP traffic. */
export const internalSignal = controller.signal;

export function abortInternalTraffic(): void {
  controller.abort();
}
