import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess, spawn } from "node:child_process";
import { runOneShot, type ChildProgress, type ChildRequest, type SpawnProcess } from "../src/child-process.ts";
import { RpcChildSession } from "../src/rpc-session.ts";

const request: ChildRequest = {
  prompt: "test",
  tools: ["read"],
  cwd: process.cwd(),
  timeoutMs: 1_000,
  model: "test/model",
};

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;

  close(code: number | null): void {
    if (this.exitCode !== null || this.killed) return;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null);
    });
    return true;
  }
}

function fakeSpawn(child: FakeChild, setup?: (child: FakeChild) => void): SpawnProcess {
  return ((..._args: Parameters<typeof spawn>) => {
    setup?.(child);
    return child as unknown as ChildProcess;
  }) as SpawnProcess;
}

function assistantEvent(text: string, stopReason = "stop"): Record<string, unknown> {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "test/model",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        cost: { total: 0.25 },
      },
      stopReason,
      ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
    },
  };
}

function writeEvent(child: FakeChild, event: unknown): void {
  child.stdout.write(`${JSON.stringify(event)}\n`);
}

test("collects JSON events, output, and usage without forwarding token deltas", async () => {
  const child = new FakeChild();
  const progress: ChildProgress[] = [];
  const execution = runOneShot(request, undefined, (event) => progress.push(event), fakeSpawn(child, () => {
    queueMicrotask(() => {
      child.stdout.write("not json\n");
      writeEvent(child, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "d" } });
      writeEvent(child, { type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
      writeEvent(child, assistantEvent("done"));
      writeEvent(child, { type: "agent_settled" });
      child.close(0);
    });
  }));

  const result = await execution;
  assert.equal(result.output, "done");
  assert.equal(result.error, undefined);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.cost, 0.25);
  assert.deepEqual(progress, [
    { text: "Reading src/index.ts…", eventType: "tool_execution_start", toolName: "read" },
    { text: "done", eventType: "message_end" },
  ]);
});

test("detects clarification requests", async () => {
  const child = new FakeChild();
  const result = await runOneShot(request, undefined, undefined, fakeSpawn(child, () => {
    queueMicrotask(() => {
      writeEvent(child, assistantEvent("NEEDS_INPUT: Which directory should I inspect?"));
      writeEvent(child, { type: "agent_settled" });
      child.close(0);
    });
  }));

  assert.equal(result.needsInput, true);
  assert.equal(result.error, undefined);
});

test("fails when the child exits without a complete JSON result", async () => {
  const child = new FakeChild();
  const result = await runOneShot(request, undefined, undefined, fakeSpawn(child, () => {
    queueMicrotask(() => {
      child.stdout.write("malformed\n");
      child.close(0);
    });
  }));

  assert.match(result.error ?? "", /before producing a complete result/);
  assert.match(result.error ?? "", /malformed JSON event/);
});

test("maps model errors, cancellation, and timeout", async (t) => {
  await t.test("model error", async () => {
    const child = new FakeChild();
    const result = await runOneShot(request, undefined, undefined, fakeSpawn(child, () => {
      queueMicrotask(() => {
        writeEvent(child, assistantEvent("", "error"));
        writeEvent(child, { type: "agent_settled" });
        child.close(0);
      });
    }));
    assert.equal(result.error, "provider failed");
  });

  await t.test("cancellation", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const running = runOneShot(request, controller.signal, undefined, fakeSpawn(child));
    controller.abort();
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(result.error, "Child was cancelled.");
  });

  await t.test("timeout", async () => {
    const child = new FakeChild();
    const result = await runOneShot({ ...request, timeoutMs: 5 }, undefined, undefined, fakeSpawn(child));
    assert.equal(result.timedOut, true);
    assert.match(result.error ?? "", /timed out/);
  });
});

test("routes explicit follow-ups through one RPC child", async () => {
  const child = new FakeChild();
  const prompts: string[] = [];
  const session = new RpcChildSession(request, fakeSpawn(child, () => {
    let buffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const command = JSON.parse(line) as { type: string; message?: string };
        if (command.type !== "prompt") continue;
        prompts.push(command.message ?? "");
        writeEvent(child, assistantEvent(prompts.length === 1 ? "first" : "second"));
        writeEvent(child, { type: "agent_settled" });
      }
    });
  }));

  const first = await session.prompt(request, undefined);
  const second = await session.prompt({ ...request, prompt: "follow up" }, undefined);
  assert.equal(first.output, "first");
  assert.equal(second.output, "second");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /follow up/);
  session.dispose();
});

test("handles RPC stdin errors without leaving the session usable", async () => {
  const child = new FakeChild();
  const session = new RpcChildSession(request, fakeSpawn(child));
  const running = session.prompt(request, undefined);
  child.stdin.emit("error", new Error("broken pipe"));

  const result = await running;
  assert.equal(result.error, "broken pipe");
  assert.equal(session.isUsable, false);
});

test("rejects RPC follow-up configuration changes", async () => {
  const child = new FakeChild();
  const session = new RpcChildSession(request, fakeSpawn(child));
  await assert.rejects(
    session.prompt({ ...request, tools: ["grep"] }, undefined),
    /must keep the original model, thinking level, tools, and cwd/,
  );
  session.dispose();
});
