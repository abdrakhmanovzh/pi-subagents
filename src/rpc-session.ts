import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  buildChildPrompt,
  getPiInvocation,
  type ChildExecution,
  type ChildProgress,
  type ChildRequest,
  type PiInvocation,
  type SpawnProcess,
} from "./child-process.ts";
import { applyProtocolEvent, createProtocolState, needsInput, type ProtocolState } from "./protocol.ts";

interface ActivePrompt {
  requestId: string;
  resolve: (execution: ChildExecution) => void;
  state: ProtocolState;
  startedAt: number;
  error?: string;
  cancelled: boolean;
  timedOut: boolean;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  onProgress?: (progress: ChildProgress) => void;
}

export function buildRpcArgs(request: ChildRequest): PiInvocation {
  const args = [
    "--mode",
    "rpc",
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
  return getPiInvocation(args);
}

function configKey(request: ChildRequest): string {
  return JSON.stringify({
    model: request.model,
    thinkingLevel: request.thinkingLevel,
    tools: request.tools,
    cwd: request.cwd,
  });
}

export class RpcChildSession {
  private readonly child: ChildProcess;
  private readonly config: string;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private active: ActivePrompt | undefined;
  private disposed = false;
  private closed = false;
  private stderr = "";
  private terminateTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly initialRequest: ChildRequest,
    spawnProcess: SpawnProcess = spawn,
  ) {
    this.config = configKey(initialRequest);
    const invocation = buildRpcArgs(initialRequest);
    this.child = spawnProcess(invocation.command, invocation.args, {
      cwd: initialRequest.cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.once("error", (error) => {
      this.closed = true;
      this.finishWithError(error.message);
    });
    this.child.once("close", (code) => {
      this.closed = true;
      this.clearTerminationTimers();
      if (this.active) {
        this.finishWithError(this.stderr.trim() || `RPC child exited with code ${code ?? "unknown"}.`);
      }
    });
  }

  get isUsable(): boolean {
    return !this.disposed && !this.closed;
  }

  async prompt(
    request: ChildRequest,
    signal: AbortSignal | undefined,
    onProgress?: (progress: ChildProgress) => void,
  ): Promise<ChildExecution> {
    if (!this.isUsable) throw new Error("RPC child session is no longer available.");
    if (configKey(request) !== this.config) throw new Error("Follow-up must keep the original model, thinking level, tools, and cwd.");
    if (request.systemPrompt !== undefined && request.systemPrompt !== this.initialRequest.systemPrompt) {
      throw new Error("Follow-up cannot replace the original system prompt.");
    }
    if (this.active) throw new Error("RPC child session is already running.");

    const requestId = randomUUID();
    return new Promise<ChildExecution>((resolve) => {
      const active: ActivePrompt = {
        requestId,
        resolve,
        state: createProtocolState(request.model),
        startedAt: Date.now(),
        cancelled: false,
        timedOut: false,
        signal,
        onProgress,
        timeout: setTimeout(() => {
          active.timedOut = true;
          active.error = `Child timed out after ${request.timeoutMs}ms.`;
          this.terminate();
        }, request.timeoutMs),
      };
      const abortListener = () => {
        active.cancelled = true;
        active.error = "Child was cancelled.";
        this.terminate();
      };
      active.abortListener = abortListener;
      this.active = active;

      if (signal) {
        if (signal.aborted) {
          abortListener();
          return;
        }
        signal.addEventListener("abort", abortListener, { once: true });
      }

      try {
        this.send({ id: requestId, type: "prompt", message: buildChildPrompt(request) });
      } catch (error) {
        this.finishWithError(error instanceof Error ? error.message : String(error));
      }

      active.state.usage.model = request.model;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.active.error = this.active.error ?? "Child session was disposed.";
    this.terminate(true);
  }

  private send(command: Record<string, unknown>): void {
    if (!this.child.stdin?.writable) throw new Error("RPC child stdin is closed.");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private consume(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    const active = this.active;
    if (!active || !line.trim()) return;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const typed = event as { type?: unknown; id?: unknown; success?: unknown; error?: unknown };
    if (typed.type === "response" && typed.id === active.requestId && typed.success === false) {
      this.finishWithError(typeof typed.error === "string" ? typed.error : "RPC prompt was rejected.");
      return;
    }

    applyProtocolEvent(active.state, event, active.onProgress);
    if (active.state.settled) this.finish();
  }

  private finishWithError(error: string): void {
    if (!this.active) return;
    this.active.error = error;
    this.finish();
  }

  private finish(): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    clearTimeout(active.timeout);
    if (active.signal && active.abortListener) active.signal.removeEventListener("abort", active.abortListener);
    active.state.usage.durationMs = Date.now() - active.startedAt;
    const error = active.error ?? active.state.error;
    active.resolve({
      output: active.state.output,
      usage: active.state.usage,
      exitCode: this.child.exitCode,
      cancelled: active.cancelled,
      timedOut: active.timedOut,
      needsInput: !error && needsInput(active.state.output),
      ...(error ? { error } : {}),
    });
  }

  private terminate(immediate = false): void {
    if (this.closed) return;
    if (!immediate) {
      try {
        this.send({ type: "abort" });
      } catch {
        // The process may already be closing.
      }
      if (!this.terminateTimer) {
        this.terminateTimer = setTimeout(() => this.kill(), 250);
      }
      return;
    }
    this.kill();
  }

  private kill(): void {
    if (this.closed) return;
    try {
      this.child.kill();
    } catch {
      // The child may already be gone.
    }
    if (!this.killTimer) {
      this.killTimer = setTimeout(() => {
        if (!this.closed) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // The child may already be gone.
          }
        }
      }, 5000);
    }
  }

  private clearTerminationTimers(): void {
    if (this.terminateTimer) clearTimeout(this.terminateTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.terminateTimer = undefined;
    this.killTimer = undefined;
  }
}
