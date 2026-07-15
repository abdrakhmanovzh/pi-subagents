import test from "node:test";
import assert from "node:assert/strict";
import { buildChildPrompt, buildOneShotArgs, getPiInvocation, type ChildRequest } from "../src/child-process.ts";

const request: ChildRequest = {
  prompt: "inspect",
  systemPrompt: "be concise",
  contextText: "context",
  contextFiles: ["/tmp/file.ts"],
  model: "test/model",
  thinkingLevel: "low",
  tools: ["read", "grep"],
  cwd: process.cwd(),
  timeoutMs: 1_000,
};

test("resolves a platform-neutral Pi invocation", () => {
  const invocation = getPiInvocation(["--mode", "json"]);
  assert.ok(invocation.command.length > 0);
  assert.deepEqual(invocation.args.slice(-2), ["--mode", "json"]);
});

test("builds an isolated one-shot invocation", () => {
  const args = buildOneShotArgs(request);
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-skills"));
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,grep"]);
  assert.deepEqual(args.slice(args.indexOf("--append-system-prompt"), args.indexOf("--append-system-prompt") + 2), ["--append-system-prompt", "be concise"]);
  assert.match(args.at(-1) ?? "", /Task:\ninspect/);
});

test("makes clarification requests machine-readable", () => {
  const prompt = buildChildPrompt(request);
  assert.match(prompt, /NEEDS_INPUT: <question>/);
  assert.match(prompt, /Explicit context:\ncontext/);
  assert.match(prompt, /\/tmp\/file.ts/);
});
