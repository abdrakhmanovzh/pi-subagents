import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { prepareChildRequest } from "../src/resources.ts";

const modelRegistry = {
  getAll: () => [
    {
      provider: "test",
      id: "model",
      name: "Test Model",
    },
  ],
} as unknown as ModelRegistry;

const defaults = {
  cwd: process.cwd(),
  model: "test/model",
  thinkingLevel: "medium",
};

const input = {
  prompt: "test",
  tools: ["read"] as const,
};

test("normalizes model, cwd, and context files before launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-test-"));
  try {
    await writeFile(join(directory, "context.txt"), "context", "utf8");
    const result = await prepareChildRequest(
      { ...input, cwd: directory, contextFiles: ["context.txt"] },
      defaults,
      modelRegistry,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.request.cwd, directory);
    assert.equal(result.request.model, "test/model");
    assert.equal(result.request.thinkingLevel, "medium");
    assert.equal(result.request.timeoutMs, 30 * 60 * 1000);
    assert.deepEqual(result.request.contextFiles, [join(directory, "context.txt")]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid models before launch", async () => {
  const result = await prepareChildRequest({ ...input, model: "missing/model" }, defaults, modelRegistry);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Unknown provider|not found|No models match/i);
});

test("rejects inaccessible working directories and context files", async (t) => {
  await t.test("cwd", async () => {
    const result = await prepareChildRequest({ ...input, cwd: "/definitely/missing/pi-subagents" }, defaults, modelRegistry);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Working directory is not accessible/);
  });

  await t.test("context file", async () => {
    const result = await prepareChildRequest({ ...input, contextFiles: ["definitely-missing.txt"] }, defaults, modelRegistry);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Context file is not accessible/);
  });
});
