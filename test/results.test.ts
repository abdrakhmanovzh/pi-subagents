import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { ArtifactStore, aggregateUsage, truncateOutput } from "../src/results.ts";

test("does not truncate output under the limit", () => {
  assert.deepEqual(truncateOutput("hello", 10), { output: "hello", truncated: false, omittedBytes: 0 });
});

test("truncates output by UTF-8 byte length", () => {
  const result = truncateOutput("abcdefghij", 5);
  assert.equal(result.truncated, true);
  assert.match(result.output, /Output truncated/);
  assert.equal(result.omittedBytes, 5);

  const unicode = truncateOutput("😀😀", 5);
  assert.equal(unicode.truncated, true);
  assert.ok(unicode.output.startsWith("😀"));
  assert.equal(unicode.omittedBytes, 4);
});

test("removes temporary output artifacts during cleanup", async () => {
  const store = new ArtifactStore();
  const path = await store.save("full output", "run");
  await access(path);
  await store.cleanup();
  await assert.rejects(access(path));
});

test("aggregates usage", () => {
  const result = aggregateUsage([
    { runId: "a", status: "completed", usage: { model: "a", turns: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, cost: 0.1, durationMs: 10 } },
    { runId: "b", status: "failed", usage: { model: "b", turns: 2, inputTokens: 6, outputTokens: 7, cacheReadTokens: 8, cacheWriteTokens: 9, cost: 0.2, durationMs: 20 } },
  ]);
  assert.deepEqual(result, { turns: 3, inputTokens: 8, outputTokens: 10, cacheReadTokens: 12, cacheWriteTokens: 14, cost: 0.30000000000000004, durationMs: 30 });
});
