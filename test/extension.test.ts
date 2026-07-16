import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildExecution, ChildRequest } from "../src/child-process.ts";
import extension from "../src/index.ts";

type RunChild = typeof import("../src/child-process.ts").runOneShot;

interface ToolResult {
  details?: unknown;
}

interface CapturedTool {
  description: string;
  executionMode?: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (...args: unknown[]) => Promise<ToolResult>;
}

function captureTools(runChild?: RunChild): Map<string, CapturedTool> {
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
  extension(api, runChild);
  return tools;
}

function childExecution(overrides: Partial<ChildExecution> = {}): ChildExecution {
  return {
    output: "done",
    usage: {
      model: "test/model",
      turns: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      durationMs: 10,
    },
    exitCode: 0,
    cancelled: false,
    timedOut: false,
    needsInput: false,
    ...overrides,
  };
}

const context = {
  cwd: process.cwd(),
  model: undefined,
  modelRegistry: {
    getAll: () => [
      { provider: "openai-codex", id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ],
  },
};

test("registers focused explore and review roles", () => {
  const tools = captureTools();
  const explore = tools.get("explore");
  const review = tools.get("review");
  assert.ok(explore);
  assert.ok(review);

  assert.match(explore.description, /gpt-5\.6-terra/);
  assert.equal(explore.executionMode, "parallel");
  assert.match(review.description, /gpt-5\.6-sol/);
  assert.equal(review.executionMode, "parallel");

  const roleFields = ["prompt", "contextText", "contextFiles", "cwd", "timeoutMs"];
  assert.deepEqual(Object.keys(explore.parameters.properties ?? {}), roleFields);
  assert.deepEqual(Object.keys(review.parameters.properties ?? {}), roleFields);
});

test("executes roles with fixed capabilities and forwards explicit context", async () => {
  const requests: ChildRequest[] = [];
  const runChild: RunChild = async (request) => {
    requests.push(request);
    return childExecution();
  };
  const tools = captureTools(runChild);
  const explore = tools.get("explore");
  const review = tools.get("review");
  assert.ok(explore);
  assert.ok(review);

  await explore.execute(
    "explore-call",
    {
      prompt: "Trace authentication",
      contextText: "Focus on session expiry.",
      contextFiles: ["package.json"],
      timeoutMs: 1234,
    },
    undefined,
    undefined,
    context,
  );
  await review.execute(
    "review-call",
    {
      prompt: "Review the authentication change",
      contextText: "Expired sessions must return 401.",
      contextFiles: ["package.json"],
      timeoutMs: 5678,
    },
    undefined,
    undefined,
    context,
  );

  assert.equal(requests.length, 2);
  const { systemPrompt: explorePrompt, ...exploreRequest } = requests[0]!;
  assert.match(explorePrompt ?? "", /codebase explorer/);
  assert.deepEqual(exploreRequest, {
    prompt: "Trace authentication",
    contextText: "Focus on session expiry.",
    contextFiles: [join(process.cwd(), "package.json")],
    model: "openai-codex/gpt-5.6-terra",
    thinkingLevel: "medium",
    tools: ["read", "grep", "find", "ls"],
    cwd: process.cwd(),
    timeoutMs: 1234,
  });
  const { systemPrompt: reviewPrompt, ...reviewRequest } = requests[1]!;
  assert.match(reviewPrompt ?? "", /independent code reviewer/);
  assert.deepEqual(reviewRequest, {
    prompt: "Review the authentication change",
    contextText: "Expired sessions must return 401.",
    contextFiles: [join(process.cwd(), "package.json")],
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "high",
    tools: ["read", "grep", "find", "ls"],
    cwd: process.cwd(),
    timeoutMs: 5678,
  });
});

test("rejects fuzzy matches for fixed role models", async () => {
  const roles = [
    { name: "explore", model: "gpt-5.6-terra-preview" },
    { name: "review", model: "gpt-5.6-sol-preview" },
  ] as const;

  for (const role of roles) {
    let childStarted = false;
    const runChild: RunChild = async () => {
      childStarted = true;
      return childExecution();
    };
    const tool = captureTools(runChild).get(role.name);
    assert.ok(tool);
    const fuzzyContext = {
      ...context,
      modelRegistry: {
        getAll: () => [{ provider: "openai-codex", id: role.model, name: role.model }],
      },
    };

    await assert.rejects(
      tool.execute(
        "call",
        { prompt: `Run ${role.name}` },
        undefined,
        undefined,
        fuzzyContext,
      ),
      /Required role model .* is unavailable/,
    );
    assert.equal(childStarted, false);
  }
});

test("propagates in-flight cancellation to both role children", async () => {
  for (const role of ["explore", "review"] as const) {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runChild: RunChild = async (_request, signal) => {
      markStarted?.();
      return new Promise<ChildExecution>((resolve) => {
        const cancel = () => resolve(childExecution({ cancelled: true, error: "Child was cancelled." }));
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
    };
    const tool = captureTools(runChild).get(role);
    assert.ok(tool);
    const controller = new AbortController();
    const running = tool.execute(
      "call",
      { prompt: `Run ${role}` },
      controller.signal,
      undefined,
      context,
    );

    await started;
    controller.abort();
    const result = await running;
    assert.equal((result.details as { status: string }).status, "cancelled");
  }
});

test("throws when either role child fails", async () => {
  for (const role of ["explore", "review"] as const) {
    const runChild: RunChild = async () => childExecution({ error: "provider failed" });
    const tool = captureTools(runChild).get(role);
    assert.ok(tool);

    await assert.rejects(
      tool.execute(
        "call",
        { prompt: `Run ${role}` },
        undefined,
        undefined,
        context,
      ),
      /Child .* failed: provider failed/,
    );
  }
});

test("rejects an entire parallel batch containing write tools", async () => {
  const tool = captureTools().get("spawn_agents");
  assert.ok(tool);

  await assert.rejects(
    tool.execute(
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
    ),
    /only permits read-only/,
  );
});

test("throws for a stale run id", async () => {
  const tool = captureTools().get("spawn_agent");
  assert.ok(tool);

  await assert.rejects(
    tool.execute(
      "call",
      { runId: "missing", prompt: "continue", tools: ["read"] },
      undefined,
      undefined,
      context,
    ),
    /Unknown child run: missing/,
  );
});
