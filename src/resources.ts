import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ChildRequest } from "./child-process.ts";
import type { BuiltinToolName } from "./schemas.ts";
import { validateTools } from "./scheduler.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

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
    const resolved = resolveChildModel(requestedModel, modelRegistry);
    if (!resolved.model) return { ok: false, error: resolved.error };
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

type RegisteredModel = ReturnType<ModelRegistry["getAll"]>[number];

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function resolveChildModel(
  reference: string,
  modelRegistry: ModelRegistry,
): { model: RegisteredModel; thinkingLevel?: string } | { model?: undefined; error: string } {
  const availableModels = modelRegistry.getAll();
  if (availableModels.length === 0) {
    return { error: "No models available. Check your installation or add models to models.json." };
  }

  const normalizedReference = reference.toLowerCase();
  const exactCanonical = availableModels.find(
    (candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === normalizedReference,
  );
  if (exactCanonical) return { model: exactCanonical };
  const exactBareMatches = availableModels.filter((candidate) => candidate.id.toLowerCase() === normalizedReference);
  if (exactBareMatches.length === 1 && exactBareMatches[0]) return { model: exactBareMatches[0] };

  const slash = reference.indexOf("/");
  const prefix = slash === -1 ? undefined : reference.slice(0, slash);
  const knownProvider = prefix
    ? availableModels.find((candidate) => candidate.provider.toLowerCase() === prefix.toLowerCase())?.provider
    : undefined;

  let pattern = knownProvider && slash !== undefined ? reference.slice(slash + 1) : reference;
  let thinkingLevel: string | undefined;
  const colon = pattern.lastIndexOf(":");
  const suffix = colon === -1 ? undefined : pattern.slice(colon + 1);
  if (colon !== -1 && suffix && THINKING_LEVELS.has(suffix)) {
    pattern = pattern.slice(0, colon);
    thinkingLevel = suffix;
  }

  const candidates = knownProvider
    ? availableModels.filter((candidate) => candidate.provider === knownProvider)
    : availableModels;
  const normalizedPattern = pattern.toLowerCase();
  const exactMatches = candidates.filter(
    (candidate) =>
      candidate.id.toLowerCase() === normalizedPattern ||
      `${candidate.provider}/${candidate.id}`.toLowerCase() === normalizedPattern,
  );
  const exactMatch = exactMatches[0];
  if (exactMatches.length === 1 && exactMatch) return { model: exactMatch, thinkingLevel };

  const matches = candidates.filter(
    (candidate) =>
      candidate.id.toLowerCase().includes(normalizedPattern) ||
      candidate.name?.toLowerCase().includes(normalizedPattern),
  );
  if (matches.length > 0) {
    const aliases = matches.filter((candidate) => !/-\d{8}$/.test(candidate.id));
    const preferred = aliases.length > 0 ? aliases : matches;
    preferred.sort((a, b) => b.id.localeCompare(a.id));
    return { model: preferred[0]!, thinkingLevel };
  }

  return { error: `Model "${reference}" not found.` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
