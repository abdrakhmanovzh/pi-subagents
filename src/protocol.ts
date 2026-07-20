import type { ChildProgress } from "./child-process.ts";
import type { UsageStats } from "./results.ts";

export interface ProtocolState {
  output: string;
  usage: UsageStats;
  error?: string;
  sawAssistant: boolean;
  settled: boolean;
}

export function createUsage(model?: string): UsageStats {
  return {
    model,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    durationMs: 0,
  };
}

export function createProtocolState(model?: string): ProtocolState {
  return {
    output: "",
    usage: createUsage(model),
    sawAssistant: false,
    settled: false,
  };
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      );
    })
    .map((part) => part.text)
    .join("\n");
}

function toolProgressText(toolName: string, args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const value = (key: string): string | undefined => {
    const item = input[key];
    if (typeof item !== "string") return undefined;
    const oneLine = item.replace(/\s+/g, " ").trim();
    return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 119)}…`;
  };

  switch (toolName) {
    case "read": return `Reading ${value("path") ?? "file"}…`;
    case "grep": return `Searching for ${value("pattern") ?? "pattern"}…`;
    case "find": return `Finding ${value("pattern") ?? "files"}…`;
    case "ls": return `Listing ${value("path") ?? "."}…`;
    case "bash": return `Running ${value("command") ?? "command"}…`;
    case "edit": return `Editing ${value("path") ?? "file"}…`;
    case "write": return `Writing ${value("path") ?? "file"}…`;
    default: return `Running ${toolName}…`;
  }
}

function addUsage(target: UsageStats, message: unknown): void {
  if (!message || typeof message !== "object") return;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage) return;
  target.inputTokens += typeof usage.input === "number" ? usage.input : 0;
  target.outputTokens += typeof usage.output === "number" ? usage.output : 0;
  target.cacheReadTokens += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  target.cacheWriteTokens += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
  const cost = usage.cost;
  if (cost && typeof cost === "object" && typeof (cost as { total?: unknown }).total === "number") {
    target.cost += (cost as { total: number }).total;
  }
}

export function applyProtocolEvent(
  state: ProtocolState,
  event: unknown,
  onProgress?: (progress: ChildProgress) => void,
): void {
  if (!event || typeof event !== "object") return;
  const typed = event as {
    type?: unknown;
    message?: unknown;
    error?: unknown;
    toolName?: unknown;
    args?: unknown;
  };

  if (typed.type === "message_end" && typed.message) {
    const message = typed.message as {
      role?: unknown;
      model?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (message.role === "assistant") {
      state.sawAssistant = true;
      state.usage.turns += 1;
      addUsage(state.usage, message);
      if (!state.usage.model && typeof message.model === "string") state.usage.model = message.model;
      const text = messageText(message);
      if (text) state.output = text;
      if (message.stopReason === "error") {
        state.error = typeof message.errorMessage === "string" ? message.errorMessage : "Child model request failed.";
      }
      onProgress?.({ text: state.output, eventType: "message_end" });
    }
  }

  if (typed.type === "tool_execution_start" && typeof typed.toolName === "string") {
    onProgress?.({
      text: toolProgressText(typed.toolName, typed.args),
      eventType: "tool_execution_start",
      toolName: typed.toolName,
    });
  }

  if (typed.type === "extension_error") {
    state.error = typeof typed.error === "string" ? typed.error : "Child extension failed.";
  }

  if (typed.type === "agent_settled") state.settled = true;
}

export function parseProtocolLine(
  state: ProtocolState,
  line: string,
  onProgress?: (progress: ChildProgress) => void,
): boolean {
  if (!line.trim()) return true;
  try {
    applyProtocolEvent(state, JSON.parse(line), onProgress);
    return true;
  } catch {
    return false;
  }
}

export function needsInput(output: string): boolean {
  return /^\s*NEEDS_INPUT:\s*\S/i.test(output);
}
