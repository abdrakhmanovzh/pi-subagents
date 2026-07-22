import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runOneShot, type ChildRequest } from "./child-process.ts";
import { prepareChildRequest, type ChildDefaults } from "./resources.ts";
import { RpcChildSession } from "./rpc-session.ts";
import {
  CloseAgentParameters,
  ContinueAgentParameters,
  ReviewAgentParameters,
  RoleAgentParameters,
  SpawnAgentParameters,
  SpawnAgentsParameters,
  type CloseAgentInput,
  type ContinueAgentInput,
  type ParallelTaskInput,
  type ReviewAgentInput,
  type RoleAgentInput,
  type SpawnAgentsInput,
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

const EXPLORE_MODEL = "openai-codex/gpt-5.6-terra";
const EXPLORE_TOOLS = ["read", "grep", "find", "ls"] as const;
const EXPLORE_SYSTEM_PROMPT = `You are a codebase explorer. Investigate the requested area without modifying files.

Return:
- relevant files and symbols
- exact path and line references
- how the components connect
- uncertainties or missing information

Keep the result concise for handoff to another agent. Do not design or implement changes unless explicitly requested.`;

const REVIEW_MODEL = "openai-codex/gpt-5.6-sol";
const REVIEW_TOOLS = ["read", "grep", "find", "ls"] as const;
const MAX_REVIEW_DIFF_BYTES = 100 * 1024;
const REVIEW_SYSTEM_PROMPT = `You are an independent code reviewer. Review the change against the stated requirement without modifying files.

Prioritize:
1. correctness bugs
2. regressions
3. security and data-loss risks
4. missing tests

Cite exact paths and lines. Do not report style preferences unless they create a concrete maintenance risk. If there are no findings, state that explicitly.`;

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
  const status = execution.timedOut
    ? "timed_out"
    : execution.cancelled
      ? "cancelled"
      : execution.error
        ? "failed"
        : execution.needsInput
          ? "needs_input"
          : "completed";
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
  runChild: typeof runOneShot,
  input: { runId?: string; keepAlive?: boolean },
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
          (progress) => onUpdate?.(progress.text || "Running…", { runId, eventType: progress.eventType, toolName: progress.toolName }),
        )
      : await runChild(
          request,
          run.controller.signal,
          (progress) => onUpdate?.(progress.text || "Running…", { runId, eventType: progress.eventType, toolName: progress.toolName }),
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

function expansionHint(theme: Theme, description: string): string {
  return theme.fg("dim", keyText("app.tools.expand")) + theme.fg("muted", ` ${description}`);
}

function requireExactModel(request: ChildRequest, expectedModel: string): void {
  if (request.model !== expectedModel) {
    throw new Error(`Required role model ${expectedModel} is unavailable; resolved ${request.model ?? "no model"}.`);
  }
}

function throwIfFailed(result: RunResult): void {
  if (result.status === "failed") {
    throw new Error(`Child ${result.runId} failed: ${result.error ?? "Unknown error."}`);
  }
}

async function readDiffPrefix(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, MAX_REVIEW_DIFF_BYTES));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const decoder = new StringDecoder("utf8");
    const text = size > offset ? decoder.write(buffer.subarray(0, offset)) : decoder.end(buffer.subarray(0, offset));
    if (size <= offset) return text;
    return `${text}\n\n[Diff truncated; ${size - offset} bytes omitted.]`;
  } finally {
    await file.close();
  }
}

async function addReviewDiff(
  pi: ExtensionAPI,
  request: ChildRequest,
  signal: AbortSignal | undefined,
): Promise<ChildRequest> {
  const diffPath = join(tmpdir(), `pi-subagents-review-${randomUUID()}.diff`);
  try {
    const diff = await pi.exec("git", ["diff", "--no-ext-diff", `--output=${diffPath}`, "HEAD", "--"], {
      cwd: request.cwd,
      signal,
      timeout: 10_000,
    });
    if (diff.killed || diff.code !== 0) {
      const reason = diff.killed ? "git was interrupted" : diff.stderr.trim() || `git exited with code ${diff.code}`;
      throw new Error(`Unable to collect review diff: ${reason}.`);
    }

    const context = await readDiffPrefix(diffPath) || "(No tracked changes against HEAD.)";
    return {
      ...request,
      contextText: [request.contextText, `Tracked working-tree diff against HEAD:\n${context}`].filter(Boolean).join("\n\n"),
    };
  } finally {
    await rm(diffPath, { force: true });
  }
}

function renderRunResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): Text {
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
  } else if (details.output || details.error) {
    if (details.output) text += `\n${theme.fg("dim", compact(details.output, 160))}`;
    text += `\n${expansionHint(theme, "to show full result")}`;
  }
  return new Text(text, 0, 0);
}

export default function (pi: ExtensionAPI, runChild: typeof runOneShot = runOneShot): void {
  const manager = new RunManager();

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Run one generic child Pi agent with explicit prompt, context, model, tools, cwd, and timeout. Calls with bash, edit, or write are write-capable and run sequentially. Use spawn_agents for parallel read-only work.",
    promptSnippet: "Run one generic child agent with explicit capabilities and context",
    promptGuidelines: [
      "Do not issue multiple write-capable spawn_agent calls in one assistant turn. A spawn_agent call is write-capable when tools includes bash, edit, or write. Wait for its result before starting another. Use spawn_agents for parallel read-only tasks.",
    ],
    executionMode: "sequential",
    parameters: SpawnAgentParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const defaults: ChildDefaults = {
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: pi.getThinkingLevel(),
      };
      const prepared = await prepareChildRequest(params, defaults, ctx.modelRegistry);
      if (!prepared.ok) throw new Error(prepared.error);

      const result = await executeSingle(
        manager,
        runChild,
        params,
        prepared.request,
        signal,
        DEFAULT_CONCURRENCY,
        (text, details) => {
          onUpdate?.({ content: [{ type: "text", text }], details });
        },
      );
      throwIfFailed(result);
      return { content: [{ type: "text", text: resultText(result) }], details: result };
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
      return renderRunResult(result, options, theme);
    },
  });

  pi.registerTool({
    name: "continue_agent",
    label: "Continue Agent",
    description: "Continue a persistent child created by spawn_agent with keepAlive. The original model, tools, system prompt, and working directory are reused automatically.",
    promptSnippet: "Continue a persistent child agent by runId without repeating its configuration",
    executionMode: "sequential",
    parameters: ContinueAgentParameters,
    async execute(_toolCallId, params: ContinueAgentInput, signal, onUpdate, ctx) {
      const existing = manager.getPersistent(params.runId);
      if (!existing) throw new Error(`Unknown child run: ${params.runId}.`);

      const prepared = await prepareChildRequest(
        {
          prompt: params.prompt,
          contextText: params.contextText,
          contextFiles: params.contextFiles,
          systemPrompt: existing.request.systemPrompt,
          model: existing.request.model,
          thinkingLevel: existing.request.thinkingLevel,
          tools: existing.request.tools,
          cwd: existing.request.cwd,
          timeoutMs: params.timeoutMs ?? existing.request.timeoutMs,
        },
        {
          cwd: existing.request.cwd,
          model: existing.request.model,
          thinkingLevel: existing.request.thinkingLevel,
        },
        ctx.modelRegistry,
      );
      if (!prepared.ok) throw new Error(prepared.error);

      const result = await executeSingle(
        manager,
        runChild,
        { runId: params.runId },
        prepared.request,
        signal,
        DEFAULT_CONCURRENCY,
        (text, details) => onUpdate?.({ content: [{ type: "text", text }], details }),
      );
      throwIfFailed(result);
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("continue_agent ")) +
          theme.fg("accent", compact(args.prompt ?? "…")) +
          theme.fg("dim", ` [${args.runId}]`),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderRunResult(result, options, theme);
    },
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    description: "Cancel an active persistent child or close an idle one by runId.",
    promptSnippet: "Cancel or close a persistent child agent by runId",
    executionMode: "sequential",
    parameters: CloseAgentParameters,
    async execute(_toolCallId, params: CloseAgentInput) {
      if (!manager.cancel(params.runId)) throw new Error(`Unknown child run: ${params.runId}.`);
      const details = { runId: params.runId, closed: true };
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  pi.registerTool({
    name: "explore",
    label: "Explore",
    description: `Explore a codebase with the read-only ${EXPLORE_MODEL} child agent. Returns concise evidence with file and line references for handoff.`,
    promptSnippet: "Explore a codebase with a fast read-only child agent",
    promptGuidelines: [
      "Use explore for focused codebase discovery that would otherwise consume the parent context. Multiple explore calls can run in parallel for independent areas.",
    ],
    executionMode: "parallel",
    parameters: RoleAgentParameters,
    async execute(_toolCallId, params: RoleAgentInput, signal, onUpdate, ctx) {
      const prepared = await prepareChildRequest(
        {
          ...params,
          systemPrompt: EXPLORE_SYSTEM_PROMPT,
          model: EXPLORE_MODEL,
          thinkingLevel: "medium",
          tools: EXPLORE_TOOLS,
        },
        { cwd: ctx.cwd },
        ctx.modelRegistry,
      );
      if (!prepared.ok) throw new Error(prepared.error);
      requireExactModel(prepared.request, EXPLORE_MODEL);

      const result = await executeSingle(
        manager,
        runChild,
        {},
        prepared.request,
        signal,
        DEFAULT_CONCURRENCY,
        (text, details) => onUpdate?.({ content: [{ type: "text", text }], details }),
      );
      throwIfFailed(result);
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("explore ")) +
          theme.fg("accent", compact(args.prompt ?? "…")) +
          theme.fg("dim", ` [${EXPLORE_MODEL}; read-only]`),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderRunResult(result, options, theme);
    },
  });

  pi.registerTool({
    name: "review",
    label: "Review",
    description: `Review code independently with the ${REVIEW_MODEL} child agent. Prioritizes concrete correctness, regression, security, and test findings without editing files.`,
    promptSnippet: "Review code with a strong independent child agent",
    promptGuidelines: [
      "Use review after implementation when an independent correctness pass is valuable. Include the requirement and relevant change scope in its prompt or context. Set includeDiff to true when reviewing current tracked working-tree changes.",
    ],
    executionMode: "parallel",
    parameters: ReviewAgentParameters,
    async execute(_toolCallId, params: ReviewAgentInput, signal, onUpdate, ctx) {
      const { includeDiff, ...reviewInput } = params;
      const prepared = await prepareChildRequest(
        {
          ...reviewInput,
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          model: REVIEW_MODEL,
          thinkingLevel: "high",
          tools: REVIEW_TOOLS,
        },
        { cwd: ctx.cwd },
        ctx.modelRegistry,
      );
      if (!prepared.ok) throw new Error(prepared.error);
      requireExactModel(prepared.request, REVIEW_MODEL);
      const request = includeDiff ? await addReviewDiff(pi, prepared.request, signal) : prepared.request;

      const result = await executeSingle(
        manager,
        runChild,
        {},
        request,
        signal,
        DEFAULT_CONCURRENCY,
        (text, details) => onUpdate?.({ content: [{ type: "text", text }], details }),
      );
      throwIfFailed(result);
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("review ")) +
          theme.fg("accent", compact(args.prompt ?? "…")) +
          theme.fg("dim", ` [${REVIEW_MODEL}; no edits]`),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderRunResult(result, options, theme);
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
      if (validationError) throw new Error(validationError);

      const defaults: ChildDefaults = {
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: pi.getThinkingLevel(),
      };
      const prepared = await Promise.all(params.tasks.map((task) => prepareChildRequest(task, defaults, ctx.modelRegistry)));
      const preparationError = prepared.find((result) => !result.ok);
      if (preparationError && !preparationError.ok) throw new Error(preparationError.error);
      const requests = prepared.map((result) => {
        if (!result.ok) throw new Error(result.error);
        return result.request;
      });

      const results: Array<RunResult | undefined> = new Array(params.tasks.length);
      await mapWithConcurrency(params.tasks, limit, async (task: ParallelTaskInput, index) => {
        const result = await executeSingle(
          manager,
          runChild,
          {},
          requests[index]!,
          _signal,
          limit,
          (text, details) => {
            onUpdate?.({ content: [{ type: "text", text: `Task ${task.taskId ?? index + 1}: ${text}\n${batchProgress(results)}` }], details: { taskId: task.taskId, results, progress: details } });
          },
        );
        if (task.taskId !== undefined) result.taskId = task.taskId;
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
      const details = result.details as { results?: Array<RunResult | undefined>; usage?: UsageStats } | undefined;
      if (!details?.results) {
        const text = result.content.find((part) => part.type === "text");
        return new Text(theme.fg("warning", compact(text?.text ?? "Running…")), 0, 0);
      }

      const finished = details.results.flatMap((child, index) => child ? [{ child, index }] : []);
      const running = details.results.length - finished.length;
      const counts = finished.reduce<Record<string, number>>((total, { child }) => {
        total[child.status] = (total[child.status] ?? 0) + 1;
        return total;
      }, {});
      const summaryParts = Object.entries(counts).map(([status, count]) => `${count} ${status}`);
      if (running > 0) summaryParts.push(`${running} running`);
      const summary = summaryParts.join(", ") || "no tasks started";
      const failed = finished.filter(({ child }) => ["failed", "cancelled", "timed_out"].includes(child.status)).length;
      const needsInput = finished.some(({ child }) => child.status === "needs_input");
      const color = running > 0
        ? "warning"
        : failed === 0
          ? (needsInput ? "warning" : "success")
          : failed === finished.length
            ? "error"
            : "warning";
      const usage = details.usage ?? aggregateUsage(finished.map(({ child }) => child));
      let text = theme.fg(color, summary) + theme.fg("dim", ` · ${usageText(usage)}`);
      const progress = result.content.find((part) => part.type === "text")?.text.split("\n")[0]?.trim();
      if (options.isPartial && progress && !progress.startsWith("Parallel:")) {
        text += `\n${theme.fg("dim", compact(progress, 160))}`;
      }
      if (options.expanded) {
        for (const { child, index } of finished) {
          const label = child.taskId ?? String(index + 1);
          text += `\n${theme.fg("accent", `${label}. ${child.status}`)} ${theme.fg("dim", child.runId)}`;
          if (child.output) text += `\n${child.output}`;
          if (child.error) text += `\n${theme.fg("error", child.error)}`;
          if (child.outputFile) text += `\n${theme.fg("dim", `Full output: ${child.outputFile}`)}`;
        }
      } else if (finished.some(({ child }) => child.output || child.error)) {
        text += `\n${expansionHint(theme, "to show finished results")}`;
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

