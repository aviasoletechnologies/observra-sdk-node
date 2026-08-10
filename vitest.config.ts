import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Provider tests hit real upstream APIs through the local gateway -
    // real network latency, and one file's configure() call would race
    // another's if they ran in parallel (configure sets a module singleton).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
