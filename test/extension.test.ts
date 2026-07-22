import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
  promptGuidelines?: string[];
  executionMode?: string;
  parameters: { properties?: Record<string, unknown> };
  execute: (...args: unknown[]) => Promise<ToolResult>;
  renderResult?: (...args: unknown[]) => { text: string };
}

function captureTools(
  runChild?: RunChild,
  exec: (_command: string, _args: string[]) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> = async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const api = {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool as unknown as CapturedTool);
    },
    registerCommand() {},
    on() {},
    exec,
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

test("serializes generic children and explains the write-capable restriction", () => {
  const tool = captureTools().get("spawn_agent");
  assert.ok(tool);

  assert.equal(tool.executionMode, "sequential");
  assert.match(tool.description, /write-capable and run sequentially/);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /Do not issue multiple write-capable spawn_agent calls/);
  assert.match(tool.promptGuidelines?.join("\n") ?? "", /Use spawn_agents for parallel read-only tasks/);
});

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
  assert.deepEqual(Object.keys(review.parameters.properties ?? {}), ["prompt", "includeDiff", "contextText", "contextFiles", "cwd", "timeoutMs"]);
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

test("can include the tracked working-tree diff in review context", async () => {
  const requests: ChildRequest[] = [];
  const tools = captureTools(
    async (request) => {
      requests.push(request);
      return childExecution();
    },
    async (_command, args) => {
      const output = args.find((arg) => arg.startsWith("--output="));
      assert.ok(output);
      await writeFile(output.slice("--output=".length), `${"a".repeat(100 * 1024)}extra`, "utf8");
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
  );
  const review = tools.get("review");
  assert.ok(review);

  await review.execute(
    "review-call",
    { prompt: "Review the change", includeDiff: true, contextText: "Requirement" },
    undefined,
    undefined,
    context,
  );

  assert.match(requests[0]?.contextText ?? "", /Requirement/);
  assert.match(requests[0]?.contextText ?? "", /Tracked working-tree diff against HEAD/);
  assert.match(requests[0]?.contextText ?? "", /Diff truncated; 5 bytes omitted/);
});

test("rejects an interrupted review diff", async () => {
  const review = captureTools(
    async () => childExecution(),
    async () => ({ stdout: "", stderr: "", code: 0, killed: true }),
  ).get("review");
  assert.ok(review);

  await assert.rejects(
    review.execute("review-call", { prompt: "Review", includeDiff: true }, undefined, undefined, context),
    /Unable to collect review diff: git was interrupted/,
  );
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

test("shows how to expand a completed child result", async () => {
  const tool = captureTools(async () => childExecution({ output: "first line\nsecond line" })).get("explore");
  assert.ok(tool?.renderResult);

  const result = await tool.execute("call", { prompt: "Explore" }, undefined, undefined, context);
  const theme = {
    fg: (color: string, text: string) => `[${color}]${text}`,
    bold: (text: string) => text,
  };
  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme);
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme);

  assert.match(collapsed.text, /to show full result/);
  assert.doesNotMatch(collapsed.text, /first line\nsecond line/);
  assert.match(expanded.text, /first line\nsecond line/);
});

test("shows finished parallel results while other children are still running", () => {
  const tool = captureTools().get("spawn_agents");
  assert.ok(tool?.renderResult);

  const partial = {
    content: [{ type: "text", text: "Task active-task: Reading src/index.ts…\nParallel: 1/2 done, 1 running…" }],
    details: {
      results: [
        {
          runId: "finished-run",
          taskId: "finished-task",
          status: "completed",
          output: "finished child output",
          usage: childExecution().usage,
        },
        undefined,
      ],
    },
  };
  const theme = {
    fg: (color: string, text: string) => `[${color}]${text}`,
    bold: (text: string) => text,
  };
  const collapsed = tool.renderResult(partial, { expanded: false, isPartial: true }, theme);
  const expanded = tool.renderResult(partial, { expanded: true, isPartial: true }, theme);

  assert.match(collapsed.text, /1 completed, 1 running/);
  assert.match(collapsed.text, /Task active-task: Reading src\/index\.ts/);
  assert.match(collapsed.text, /to show finished results/);
  assert.match(expanded.text, /finished-task\. completed/);
  assert.match(expanded.text, /finished child output/);
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

test("preserves task ids and distinguishes timeouts in parallel results", async () => {
  const runChild: RunChild = async (request) => request.prompt === "slow"
    ? childExecution({ timedOut: true, cancelled: true, error: "timed out" })
    : childExecution();
  const tool = captureTools(runChild).get("spawn_agents");
  assert.ok(tool);

  const result = await tool.execute(
    "call",
    {
      tasks: [
        { taskId: "slow-task", prompt: "slow", tools: ["read"] },
        { taskId: "fast-task", prompt: "fast", tools: ["read"] },
      ],
      maxConcurrency: 2,
    },
    undefined,
    undefined,
    context,
  );
  const children = (result.details as { results: Array<{ taskId?: string; status: string }> }).results;
  assert.deepEqual(children.map(({ taskId, status }) => ({ taskId, status })), [
    { taskId: "slow-task", status: "timed_out" },
    { taskId: "fast-task", status: "completed" },
  ]);

  assert.ok(tool.renderResult);
  const rendered = tool.renderResult(
    result,
    { expanded: false, isPartial: false },
    {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => text,
    },
  );
  assert.match(rendered.text, /^\[warning\]/);
});

test("registers focused persistent-child management tools", async () => {
  const tools = captureTools();
  const spawn = tools.get("spawn_agent");
  const continueAgent = tools.get("continue_agent");
  const closeAgent = tools.get("close_agent");
  assert.ok(spawn);
  assert.ok(continueAgent);
  assert.ok(closeAgent);

  assert.equal("runId" in (spawn.parameters.properties ?? {}), false);
  assert.deepEqual(Object.keys(continueAgent.parameters.properties ?? {}), ["runId", "prompt", "contextText", "contextFiles", "timeoutMs"]);
  assert.deepEqual(Object.keys(closeAgent.parameters.properties ?? {}), ["runId"]);
  await assert.rejects(
    continueAgent.execute("call", { runId: "missing", prompt: "continue" }, undefined, undefined, context),
    /Unknown child run: missing/,
  );
  await assert.rejects(
    closeAgent.execute("call", { runId: "missing" }, undefined, undefined, context),
    /Unknown child run: missing/,
  );
});
