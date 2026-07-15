import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_OUTPUT_BYTES = 50 * 1024;

export type RunStatus = "completed" | "failed" | "cancelled" | "needs_input";

export interface UsageStats {
  model?: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  durationMs: number;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  output?: string;
  error?: string;
  usage?: UsageStats;
  outputFile?: string;
}

export interface ParallelResult {
  results: RunResult[];
  usage: UsageStats;
}

export function truncateOutput(output: string, maxBytes = MAX_OUTPUT_BYTES): {
  output: string;
  truncated: boolean;
  omittedBytes: number;
} {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= maxBytes) return { output, truncated: false, omittedBytes: 0 };

  let truncated = output.slice(0, maxBytes);
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
  return {
    output: `${truncated}\n\n[Output truncated; ${bytes - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`,
    truncated: true,
    omittedBytes: bytes - Buffer.byteLength(truncated, "utf8"),
  };
}

export class ArtifactStore {
  private readonly directories = new Set<string>();

  async save(output: string, runId: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-subagents-"));
    this.directories.add(directory);
    const filePath = join(directory, `${runId}.txt`);
    await writeFile(filePath, output, "utf8");
    return filePath;
  }

  async cleanup(): Promise<void> {
    const directories = [...this.directories];
    this.directories.clear();
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  }
}

export function aggregateUsage(results: readonly RunResult[]): UsageStats {
  const total: UsageStats = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    durationMs: 0,
  };
  const models = new Set<string>();

  for (const result of results) {
    const usage = result.usage;
    if (!usage) continue;
    if (usage.model) models.add(usage.model);
    total.turns += usage.turns;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.cost += usage.cost;
    total.durationMs += usage.durationMs;
  }

  if (models.size === 1) total.model = models.values().next().value;
  return total;
}
