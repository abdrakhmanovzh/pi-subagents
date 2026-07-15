import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runOneShot, type ChildRequest } from "./child-process.ts";
import { prepareChildRequest, type ChildDefaults } from "./resources.ts";
import { RpcChildSession } from "./rpc-session.ts";
import {
  SpawnAgentParameters,
  SpawnAgentsParameters,
  type SpawnAgentInput,
  type SpawnAgentsInput,
  type ParallelTaskInput,
} from "./schemas.ts";
import {
  DEFAULT_CONCURRENCY,
  HARD_MAX_CONCURRENCY,
  Scheduler,
  hasWriteCapability,
  validateParallelTools,
} from "./scheduler.ts";
import {
  ArtifactStore,
  aggregateUsage,
  MAX_OUTPUT_BYTES,
  type RunResult,
  type UsageStats,
  truncateOutput,
} from "./results.ts";

interface ActiveRun {
  id: string;
  controller: AbortController;
  status: "running" | "completed" | "failed" | "cancelled";
  writeCapable: boolean;
  startedAt: number;
}

interface PersistentRun {
  id: string;
  session: RpcChildSession;
  request: ChildRequest;
  writeCapable: boolean;
}

class RunManager {
  readonly scheduler = new Scheduler();
  readonly artifacts = new ArtifactStore();
  private readonly active = new Map<string, ActiveRun>();
  private readonly persistent = new Map<string, PersistentRun>();
  private readonly recent: RunResult[] = [];

  start(id: string, writeCapable: boolean, requestedLimit = DEFAULT_CONCURRENCY): { controller: AbortController; release: () => void } {
    const lease = this.scheduler.acquire(id, writeCapable, requestedLimit);
    const controller = new AbortController();
    this.active.set(id, { id, controller, status: "running", writeCapable, startedAt: Date.now() });
    return {
      controller,
      release: () => {
        lease.release();
        this.active.delete(id);
      },
    };
  }

  addPersistent(id: string, session: RpcChildSession, request: ChildRequest, writeCapable: boolean): void {
    this.persistent.set(id, { id, session, request, writeCapable });
  }

  getPersistent(id: string): PersistentRun | undefined {
    return this.persistent.get(id);
  }

  removePersistent(id: string, dispose = true): void {
    const run = this.persistent.get(id);
    if (!run) return;
    this.persistent.delete(id);
    if (dispose) run.session.dispose();
  }

  record(result: RunResult): void {
    this.recent.unshift(result);
    if (this.recent.length > 20) this.recent.pop();
  }

  cancel(id: string): boolean {
    const run = this.active.get(id);
    if (run) {
      run.controller.abort();
      return true;
    }
    const persistent = this.persistent.get(id);
    if (!persistent) return false;
    this.removePersistent(id);
    return true;
  }

  list(): Array<Record<string, unknown> | RunResult> {
    const active = [...this.active.values()].map(({ id, status, writeCapable, startedAt }) => ({ id, status, writeCapable, startedAt }));
    const persistent = [...this.persistent.values()]
      .filter(({ id }) => !this.active.has(id))
      .map(({ id, writeCapable, request }) => ({ id, status: "idle", writeCapable, model: request.model, cwd: request.cwd }));
    const recent = this.recent.map(({ runId, status, usage, error, outputFile }) => ({
      id: runId,
      status,
      model: usage?.model,
      durationMs: usage?.durationMs,
      cost: usage?.cost,
      error,
      outputFile,
    }));
    return [...active, ...persistent, ...recent];
  }

  async shutdown(): Promise<void> {
    for (const run of this.active.values()) run.controller.abort();
    for (const run of this.persistent.values()) run.session.dispose();
    this.active.clear();
    this.persistent.clear();
    this.scheduler.clear();
    await this.artifacts.cleanup();
  }
}

function createUsage(usage: UsageStats | undefined): UsageStats {
  return usage ?? {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    durationMs: 0,
  };
}

function resultText(result: unknown): string {
  return JSON.stringify(result);
}

async function completeResult(
  manager: RunManager,
  runId: string,
  execution: Awaited<ReturnType<typeof runOneShot>>,
): Promise<RunResult> {
  const status = execution.cancelled ? "cancelled" : execution.error ? "failed" : execution.needsInput ? "needs_input" : "completed";
  const result: RunResult = {
    runId,
    status,
    usage: createUsage(execution.usage),
  };
  if (execution.output) {
    const truncated = truncateOutput(execution.output, MAX_OUTPUT_BYTES);
    result.output = truncated.output;
    if (truncated.truncated) result.outputFile = await manager.artifacts.save(execution.output, runId);
  }
  if (execution.error) result.error = execution.error;
  return result;
}

function makeFailure(runId: string, error: string): RunResult {
  return { runId, status: "failed", error };
}

async function executeSingle(
  manager: RunManager,
  input: Pick<SpawnAgentInput, "runId" | "keepAlive">,
  request: ChildRequest,
  signal: AbortSignal | undefined,
  requestedLimit = DEFAULT_CONCURRENCY,
  onUpdate?: (text: string, details: unknown) => void,
): Promise<RunResult> {
  const runId = input.runId ?? randomUUID();
  const existing = input.runId ? manager.getPersistent(input.runId) : undefined;
  if (input.runId && !existing) return makeFailure(runId, `Unknown child run: ${input.runId}.`);

  const writeCapable = existing?.writeCapable ?? hasWriteCapability(request.tools);
  let run: ReturnType<RunManager["start"]>;
  try {
    run = manager.start(runId, writeCapable, requestedLimit);
  } catch (error) {
    return makeFailure(runId, error instanceof Error ? error.message : String(error));
  }

  const abortListener = signal ? () => run.controller.abort() : undefined;
  if (signal && abortListener) {
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  }

  let persistent = existing?.session;
  try {
    if (!persistent && input.keepAlive) {
      persistent = new RpcChildSession(request);
      manager.addPersistent(runId, persistent, request, writeCapable);
    }

    const execution = persistent
      ? await persistent.prompt(
          request,
          run.controller.signal,
          (progress) => onUpdate?.(progress.text || "Running…", { runId, eventType: progress.eventType }),
        )
      : await runOneShot(
          request,
          run.controller.signal,
          (progress) => onUpdate?.(progress.text || "Running…", { runId, eventType: progress.eventType }),
        );
    const result = await completeResult(manager, runId, execution);
    manager.record(result);
    if (persistent && (execution.cancelled || execution.timedOut || !persistent.isUsable)) manager.removePersistent(runId);
    return result;
  } catch (error) {
    if (persistent && (!existing || !persistent.isUsable)) manager.removePersistent(runId);
    const result = makeFailure(runId, error instanceof Error ? error.message : String(error));
    manager.record(result);
    return result;
  } finally {
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    run.release();
  }
}

async function mapWithConcurrency<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await fn(item, index);
    }
  });
  await Promise.all(workers);
}

function batchProgress(results: readonly (RunResult | undefined)[]): string {
  const done = results.filter(Boolean).length;
  return `Parallel: ${done}/${results.length} done, ${results.length - done} running…`;
}

function compact(text: string, maxLength = 100): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}

function usageText(usage: UsageStats | undefined): string {
  if (!usage) return "";
  const tokens = usage.inputTokens + usage.outputTokens;
  return `${usage.model ?? "unknown model"} · ${tokens} tokens · $${usage.cost.toFixed(4)} · ${(usage.durationMs / 1000).toFixed(1)}s`;
}

export default function (pi: ExtensionAPI): void {
  const manager = new RunManager();

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Run one generic child Pi agent with explicit prompt, context, model, tools, cwd, and timeout. No predefined roles or workflows.",
    promptSnippet: "Run one generic child agent with explicit capabilities and context",
    executionMode: "parallel",
    parameters: SpawnAgentParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const existing = params.runId ? manager.getPersistent(params.runId) : undefined;
      if (params.runId && !existing) {
        const result = makeFailure(params.runId, `Unknown child run: ${params.runId}.`);
        return { content: [{ type: "text", text: resultText(result) }], details: result, isError: true };
      }

      const defaults: ChildDefaults = existing
        ? { cwd: existing.request.cwd, model: existing.request.model, thinkingLevel: existing.request.thinkingLevel }
        : { cwd: ctx.cwd, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinkingLevel: pi.getThinkingLevel() };
      const prepared = await prepareChildRequest(params, defaults, ctx.modelRegistry);
      if (!prepared.ok) {
        const result = makeFailure(params.runId ?? randomUUID(), prepared.error);
        return { content: [{ type: "text", text: resultText(result) }], details: result, isError: true };
      }

      const result = await executeSingle(
        manager,
        params,
        prepared.request,
        signal,
        DEFAULT_CONCURRENCY,
        (text, details) => {
          onUpdate?.({ content: [{ type: "text", text }], details });
        },
      );
      return { content: [{ type: "text", text: resultText(result) }], details: result, isError: result.status === "failed" };
    },
    renderCall(args, theme) {
      const tools = Array.isArray(args.tools) ? args.tools.join(",") : "?";
      const capability = hasWriteCapability(args.tools) ? "write" : "read-only";
      return new Text(
        theme.fg("toolTitle", theme.bold("spawn_agent ")) +
          theme.fg("accent", compact(args.prompt ?? "…")) +
          theme.fg("dim", ` [${tools}; ${capability}]`),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as RunResult | undefined;
      if (!details?.status) {
        const text = result.content.find((part) => part.type === "text");
        return new Text(theme.fg("warning", compact(text?.text ?? "Running…")), 0, 0);
      }
      const color = details.status === "completed" ? "success" : details.status === "needs_input" ? "warning" : "error";
      let text = theme.fg(color, details.status) + theme.fg("dim", ` · ${usageText(details.usage)}`);
      if (options.expanded) {
        if (details.output) text += `\n${details.output}`;
        if (details.error) text += `\n${theme.fg("error", details.error)}`;
        if (details.outputFile) text += `\n${theme.fg("dim", `Full output: ${details.outputFile}`)}`;
      } else if (details.output) {
        text += `\n${theme.fg("dim", compact(details.output, 160))}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "spawn_agents",
    label: "Spawn Agents",
    description: `Run independent read-only child agents in parallel. Only read, grep, find, and ls are allowed. Default concurrency is ${DEFAULT_CONCURRENCY}; maximum is ${HARD_MAX_CONCURRENCY}.`,
    promptSnippet: "Run independent read-only child agents in parallel",
    executionMode: "parallel",
    parameters: SpawnAgentsParameters,
    async execute(_toolCallId, params: SpawnAgentsInput, _signal, onUpdate, ctx) {
      const requestedLimit = params.maxConcurrency ?? DEFAULT_CONCURRENCY;
      const limit = Math.min(requestedLimit, HARD_MAX_CONCURRENCY);
      const validationError = params.tasks
        .map((task) => validateParallelTools(task.tools))
        .find((error): error is string => Boolean(error));
      if (validationError) {
        return {
          content: [{ type: "text", text: resultText({ results: [], usage: aggregateUsage([]), error: validationError }) }],
          details: { results: [], usage: aggregateUsage([]), error: validationError },
          isError: true,
        };
      }

      const defaults: ChildDefaults = {
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: pi.getThinkingLevel(),
      };
      const prepared = await Promise.all(params.tasks.map((task) => prepareChildRequest(task, defaults, ctx.modelRegistry)));
      const preparationError = prepared.find((result) => !result.ok);
      if (preparationError && !preparationError.ok) {
        const payload = { results: [], usage: aggregateUsage([]), error: preparationError.error };
        return { content: [{ type: "text", text: resultText(payload) }], details: payload, isError: true };
      }
      const requests = prepared.map((result) => {
        if (!result.ok) throw new Error(result.error);
        return result.request;
      });

      const results: Array<RunResult | undefined> = new Array(params.tasks.length);
      await mapWithConcurrency(params.tasks, limit, async (task: ParallelTaskInput, index) => {
        const result = await executeSingle(
          manager,
          {},
          requests[index]!,
          _signal,
          limit,
          (text, details) => {
            onUpdate?.({ content: [{ type: "text", text: `Task ${task.taskId ?? index + 1}: ${text}\n${batchProgress(results)}` }], details: { taskId: task.taskId, results, progress: details } });
          },
        );
        results[index] = result;
        onUpdate?.({ content: [{ type: "text", text: batchProgress(results) }], details: { results } });
      });

      const complete = results.filter((result): result is RunResult => Boolean(result));
      const payload = { results: complete, usage: aggregateUsage(complete) };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
    },
    renderCall(args, theme) {
      const concurrency = args.maxConcurrency ?? DEFAULT_CONCURRENCY;
      return new Text(
        theme.fg("toolTitle", theme.bold("spawn_agents ")) +
          theme.fg("accent", `${args.tasks.length} tasks`) +
          theme.fg("dim", ` [read-only; concurrency ${concurrency}]`),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as { results?: RunResult[]; usage?: UsageStats; error?: string } | undefined;
      if (!details?.results || !details.usage) {
        const text = result.content.find((part) => part.type === "text");
        return new Text(theme.fg("warning", compact(text?.text ?? "Running…")), 0, 0);
      }
      const counts = details.results.reduce<Record<string, number>>((total, child) => {
        total[child.status] = (total[child.status] ?? 0) + 1;
        return total;
      }, {});
      const summary = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ") || "no tasks started";
      let text = theme.fg(details.error ? "error" : "success", summary) + theme.fg("dim", ` · ${usageText(details.usage)}`);
      if (details.error) text += `\n${theme.fg("error", details.error)}`;
      if (options.expanded) {
        for (const [index, child] of details.results.entries()) {
          text += `\n${theme.fg("accent", `${index + 1}. ${child.status}`)} ${theme.fg("dim", child.runId)}`;
          if (child.output) text += `\n${child.output}`;
          if (child.error) text += `\n${theme.fg("error", child.error)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("subagents", {
    description: "List active child runs or cancel one with: /subagents cancel <runId>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "cancel" && parts[1]) {
        const cancelled = manager.cancel(parts[1]);
        ctx.ui.notify(cancelled ? `Cancellation requested for ${parts[1]}.` : `Unknown active run: ${parts[1]}.`, cancelled ? "info" : "warning");
        return;
      }
      const runs = manager.list();
      ctx.ui.notify(runs.length === 0 ? "No active or recent child runs." : JSON.stringify(runs, null, 2), "info");
    },
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdown();
  });
}

