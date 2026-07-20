import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { BuiltinToolName } from "./schemas.ts";
import type { UsageStats } from "./results.ts";
import { createProtocolState, needsInput, parseProtocolLine } from "./protocol.ts";

export interface ChildRequest {
  prompt: string;
  systemPrompt?: string;
  contextText?: string;
  contextFiles?: readonly string[];
  model?: string;
  thinkingLevel?: string;
  tools: readonly BuiltinToolName[];
  cwd: string;
  timeoutMs: number;
}

export interface ChildProgress {
  text: string;
  eventType: string;
  toolName?: string;
}

export interface ChildExecution {
  output: string;
  usage: UsageStats;
  exitCode: number | null;
  cancelled: boolean;
  timedOut: boolean;
  needsInput: boolean;
  error?: string;
}

export interface PiInvocation {
  command: string;
  args: string[];
}

export type SpawnProcess = typeof spawn;

export function getPiInvocation(extraArgs: readonly string[] = []): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...extraArgs] };
  }

  const executableName = process.execPath.split(/[\\/]/).pop()?.toLowerCase();
  if (executableName && !/^(node|bun)(\.exe)?$/.test(executableName)) {
    return { command: process.execPath, args: [...extraArgs] };
  }

  return { command: process.platform === "win32" ? "pi.cmd" : "pi", args: [...extraArgs] };
}

export function buildChildPrompt(request: ChildRequest): string {
  const sections = [
    "Execution protocol:\nIf required information is missing and you cannot proceed, respond with exactly `NEEDS_INPUT: <question>`. Do not attempt to contact the user directly.",
  ];
  if (request.contextText) sections.push(`Explicit context:\n${request.contextText}`);
  if (request.contextFiles && request.contextFiles.length > 0) {
    sections.push(`Explicit context files:\n${request.contextFiles.map((file) => `- ${file}`).join("\n")}`);
  }
  sections.push(`Task:\n${request.prompt}`);
  return sections.join("\n\n");
}

export function buildOneShotArgs(request: ChildRequest): string[] {
  const args = [
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--tools",
    request.tools.join(","),
  ];
  if (request.model) args.push("--model", request.model);
  if (request.thinkingLevel) args.push("--thinking", request.thinkingLevel);
  if (request.systemPrompt) args.push("--append-system-prompt", request.systemPrompt);
  args.push("-p", buildChildPrompt(request));
  return args;
}

export async function runOneShot(
  request: ChildRequest,
  signal: AbortSignal | undefined,
  onProgress?: (progress: ChildProgress) => void,
  spawnProcess: SpawnProcess = spawn,
): Promise<ChildExecution> {
  const invocation = getPiInvocation(buildOneShotArgs(request));
  const state = createProtocolState(request.model);
  const startedAt = Date.now();
  let stderr = "";
  let cancelled = false;
  let timedOut = false;
  let exitCode: number | null = null;
  let closed = false;
  let killTimer: NodeJS.Timeout | undefined;

  const child = spawnProcess(invocation.command, invocation.args, {
    cwd: request.cwd,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const terminate = () => {
    if (closed) return;
    try {
      child.kill();
    } catch {
      // The process may have exited between the state check and kill.
    }
    killTimer = setTimeout(() => {
      if (!closed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process is already gone.
        }
      }
    }, 5000);
  };

  const abortListener = () => {
    cancelled = true;
    terminate();
  };
  if (signal) {
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let buffer = "";
  let malformedLines = 0;

  try {
    child.stdout?.on("data", (data: Buffer) => {
      buffer += stdoutDecoder.write(data);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!parseProtocolLine(state, line, onProgress)) malformedLines += 1;
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += stderrDecoder.write(data);
    });
    exitCode = await waitForClose(child, (error) => {
      stderr += error.message;
    });
    buffer += stdoutDecoder.end();
    stderr += stderrDecoder.end();
    if (buffer.trim() && !parseProtocolLine(state, buffer, onProgress)) malformedLines += 1;
  } finally {
    closed = true;
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener("abort", abortListener);
    state.usage.durationMs = Date.now() - startedAt;
  }

  let error = state.error;
  if (cancelled) error = "Child was cancelled.";
  else if (timedOut) error = `Child timed out after ${request.timeoutMs}ms.`;
  else if (exitCode !== 0) error = stderr.trim() || `Child exited with code ${exitCode ?? "unknown"}.`;
  else if (!state.settled || !state.sawAssistant) {
    const malformed = malformedLines > 0 ? ` (${malformedLines} malformed JSON event${malformedLines === 1 ? "" : "s"})` : "";
    error = `Child exited before producing a complete result${malformed}.`;
  }

  return {
    output: state.output,
    usage: state.usage,
    exitCode,
    cancelled,
    timedOut,
    needsInput: !error && needsInput(state.output),
    ...(error ? { error } : {}),
  };
}

function waitForClose(child: ChildProcess, onError: (error: Error) => void): Promise<number | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };
    child.once("error", (error) => {
      onError(error);
      finish(1);
    });
    child.once("close", finish);
  });
}
