import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const DIST = pathToFileURL(join(process.cwd(), "dist", "index.js")).href;

/**
 * Regression guard for the libuv teardown crash QA reported:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *
 * An app that called process.exit() straight after an instrumented request
 * aborted the whole process, because our telemetry request was still in
 * flight when the event loop was destroyed. Awaiting shutdown() first is what
 * fixes it - so this asserts the documented shutdown path exits cleanly.
 *
 * Runs in a child process because the failure mode is a native abort: it
 * kills the process outright, so it cannot be observed in-process.
 */
async function exitCodeOf(script: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "observra-exit-"));
  const file = join(dir, "case.mjs");
  await writeFile(file, script);
  try {
    await run(process.execPath, [file]);
    return 0;
  } catch (err) {
    return (err as { code?: number }).code ?? -1;
  }
}

/** A throwaway gateway: enough for configure() + one chat call to succeed. */
const harness = `
import http from "node:http";
import * as observra from ${JSON.stringify(DIST)};
const srv = http.createServer((req, res) => {
  const send = (b) => { res.writeHead(200, {"content-type":"application/json"}); res.end(b); };
  if (req.url.startsWith("/__observability/guardrails")) return send(JSON.stringify({ rules: [] }));
  if (req.url.startsWith("/__observability/spans")) return setTimeout(() => send("{}"), 200);
  return setTimeout(() => send(JSON.stringify({ choices: [], usage: {} })), 50);
});
await new Promise((r) => srv.listen(0, r));
const url = "http://127.0.0.1:" + srv.address().port;
observra.configure({ gatewayUrl: url, gatewayKey: "gk_test", insecure: true });
await observra.instrument();
await new observra.OpenAI({ apiKey: "sk-test" }).chat.completions.create({
  model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }],
});
`;

describe("process.exit() after an instrumented request", () => {
  it("exits cleanly when shutdown() is awaited first", async () => {
    // Repeated because the crash is a race - a single clean run proves little.
    for (let i = 0; i < 5; i++) {
      expect(await exitCodeOf(`${harness}\nawait observra.shutdown();\nprocess.exit(0);`)).toBe(0);
    }
  });

  it("shutdown() is safe to call twice and without configure()", async () => {
    expect(
      await exitCodeOf(
        `import * as observra from ${JSON.stringify(DIST)};\n` +
          `await observra.shutdown();\nawait observra.shutdown();\nprocess.exit(0);`,
      ),
    ).toBe(0);
  });
});
