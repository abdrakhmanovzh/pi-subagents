import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { resolveCliModel, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ChildRequest } from "./child-process.ts";
import type { BuiltinToolName } from "./schemas.ts";
import { validateTools } from "./scheduler.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ChildInput {
  prompt: string;
  systemPrompt?: string;
  contextText?: string;
  contextFiles?: readonly string[];
  model?: string;
  thinkingLevel?: ChildRequest["thinkingLevel"];
  tools: readonly BuiltinToolName[];
  cwd?: string;
  timeoutMs?: number;
}

export interface ChildDefaults {
  cwd: string;
  model?: string;
  thinkingLevel?: string;
}

export type PreparedRequest =
  | { ok: true; request: ChildRequest }
  | { ok: false; error: string };

export async function prepareChildRequest(
  input: ChildInput,
  defaults: ChildDefaults,
  modelRegistry: ModelRegistry,
): Promise<PreparedRequest> {
  const toolError = validateTools(input.tools);
  if (toolError) return { ok: false, error: toolError };
  if (input.timeoutMs !== undefined && input.timeoutMs < 1) {
    return { ok: false, error: "timeoutMs must be at least 1." };
  }

  const cwd = resolve(defaults.cwd, input.cwd ?? ".");
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) return { ok: false, error: `Working directory is not a directory: ${cwd}.` };
  } catch (error) {
    return { ok: false, error: `Working directory is not accessible: ${cwd} (${errorMessage(error)}).` };
  }

  const contextFiles: string[] = [];
  for (const file of input.contextFiles ?? []) {
    const filePath = isAbsolute(file) ? file : resolve(cwd, file);
    try {
      await stat(filePath);
    } catch (error) {
      return { ok: false, error: `Context file is not accessible: ${filePath} (${errorMessage(error)}).` };
    }
    contextFiles.push(filePath);
  }

  const requestedModel = input.model ?? defaults.model;
  let model: string | undefined;
  let thinkingLevel = input.thinkingLevel ?? defaults.thinkingLevel;
  if (requestedModel) {
    const resolved = resolveCliModel({
      cliModel: requestedModel,
      modelRegistry,
    });
    if (resolved.error || !resolved.model) {
      return { ok: false, error: resolved.error ?? `Model not found: ${requestedModel}.` };
    }
    model = `${resolved.model.provider}/${resolved.model.id}`;
    thinkingLevel = input.thinkingLevel ?? resolved.thinkingLevel ?? defaults.thinkingLevel;
  }

  return {
    ok: true,
    request: {
      prompt: input.prompt,
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
      ...(input.contextText === undefined ? {} : { contextText: input.contextText }),
      ...(contextFiles.length === 0 ? {} : { contextFiles }),
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      tools: input.tools,
      cwd,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
