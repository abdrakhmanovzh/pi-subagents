import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

interface ToolResult {
  details?: unknown;
  isError?: boolean;
}

interface CapturedTool {
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

function captureTools(): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const api = {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool as unknown as CapturedTool);
    },
    registerCommand() {},
    on() {},
    getThinkingLevel() {
      return "medium";
    },
  } as unknown as ExtensionAPI;
  extension(api);
  return tools;
}

const context = {
  cwd: process.cwd(),
  model: undefined,
  modelRegistry: { getAll: () => [] },
};

test("rejects an entire parallel batch containing write tools", async () => {
  const tool = captureTools().get("spawn_agents");
  assert.ok(tool);
  const result = await tool.execute(
    "call",
    {
      tasks: [
        { prompt: "read", tools: ["read"] },
        { prompt: "write", tools: ["write"] },
      ],
      maxConcurrency: 2,
    },
    undefined,
    undefined,
    context,
  );

  assert.equal(result.isError, true);
  assert.deepEqual((result.details as { results: unknown[] }).results, []);
  assert.match((result.details as { error: string }).error, /only permits read-only/);
});

test("returns a structured failure for a stale run id", async () => {
  const tool = captureTools().get("spawn_agent");
  assert.ok(tool);
  const result = await tool.execute(
    "call",
    { runId: "missing", prompt: "continue", tools: ["read"] },
    undefined,
    undefined,
    context,
  );

  assert.equal(result.isError, true);
  const details = result.details as { runId: string; status: string; error: string };
  assert.deepEqual(
    { runId: details.runId, status: details.status },
    { runId: "missing", status: "failed" },
  );
  assert.match(details.error, /Unknown child run/);
});
