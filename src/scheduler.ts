import { BUILTIN_TOOLS, READ_ONLY_TOOLS, type BuiltinToolName } from "./schemas.ts";

export const DEFAULT_CONCURRENCY = 4;
export const HARD_MAX_CONCURRENCY = 8;

export class SchedulerError extends Error {}

export function isReadOnlyTools(tools: readonly BuiltinToolName[]): boolean {
  return tools.every((tool) => (READ_ONLY_TOOLS as readonly string[]).includes(tool));
}

export function hasWriteCapability(tools: readonly BuiltinToolName[]): boolean {
  return !isReadOnlyTools(tools);
}

export function validateTools(tools: readonly string[]): string | undefined {
  if (tools.length === 0) return "At least one tool is required.";
  const unknown = tools.filter((tool) => !(BUILTIN_TOOLS as readonly string[]).includes(tool));
  if (unknown.length > 0) return `Unknown built-in tool(s): ${unknown.join(", ")}.`;
  return undefined;
}

export function validateParallelTools(tools: readonly string[]): string | undefined {
  const invalid = tools.filter((tool) => !(READ_ONLY_TOOLS as readonly string[]).includes(tool));
  if (invalid.length > 0) {
    return `Parallel mode only permits read-only tools (read, grep, find, ls); received: ${invalid.join(", ")}.`;
  }
  return undefined;
}

export interface Lease {
  readonly writeCapable: boolean;
  release(): void;
}

export class Scheduler {
  private readonly active = new Map<string, boolean>();
  private writeActive = false;

  constructor(private readonly defaultConcurrency = DEFAULT_CONCURRENCY) {
    if (defaultConcurrency < 1 || defaultConcurrency > HARD_MAX_CONCURRENCY) {
      throw new SchedulerError(`Concurrency must be between 1 and ${HARD_MAX_CONCURRENCY}.`);
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  get activeWriteCount(): number {
    return this.writeActive ? 1 : 0;
  }

  acquire(id: string, writeCapable: boolean, requestedLimit = this.defaultConcurrency): Lease {
    const limit = Math.min(requestedLimit, HARD_MAX_CONCURRENCY);
    if (requestedLimit < 1) throw new SchedulerError("Concurrency must be at least 1.");
    if (this.active.has(id)) throw new SchedulerError(`Run ${id} is already active.`);
    if (this.active.size >= limit) {
      throw new SchedulerError(`Concurrency limit reached (${limit}).`);
    }
    if (writeCapable && this.writeActive) {
      throw new SchedulerError("A write-capable child is already running; parallel writes are not allowed.");
    }

    this.active.set(id, writeCapable);
    if (writeCapable) this.writeActive = true;

    let released = false;
    return {
      writeCapable,
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(id);
        if (writeCapable) this.writeActive = false;
      },
    };
  }

  clear(): void {
    this.active.clear();
    this.writeActive = false;
  }
}
