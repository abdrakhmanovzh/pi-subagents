import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];
export type ReadOnlyToolName = (typeof READ_ONLY_TOOLS)[number];

export const ThinkingLevelSchema = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
);

const ToolSchema = StringEnum(BUILTIN_TOOLS);
const ReadOnlyToolSchema = StringEnum(READ_ONLY_TOOLS);

const ContextFields = {
  systemPrompt: Type.Optional(Type.String()),
  contextText: Type.Optional(Type.String()),
  contextFiles: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
};

export const SpawnAgentParameters = Type.Object({
  runId: Type.Optional(Type.String()),
  keepAlive: Type.Optional(Type.Boolean({ description: "Keep the child RPC session alive and return a runId for explicit follow-ups." })),
  prompt: Type.String({ minLength: 1 }),
  tools: Type.Array(ToolSchema, { minItems: 1 }),
  ...ContextFields,
});

export const ParallelTask = Type.Object({
  taskId: Type.Optional(Type.String()),
  prompt: Type.String({ minLength: 1 }),
  tools: Type.Array(ReadOnlyToolSchema, { minItems: 1 }),
  ...ContextFields,
});

export const SpawnAgentsParameters = Type.Object({
  tasks: Type.Array(ParallelTask, { minItems: 1, maxItems: 8 }),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});

export type SpawnAgentInput = Static<typeof SpawnAgentParameters>;
export type ParallelTaskInput = Static<typeof ParallelTask>;
export type SpawnAgentsInput = Static<typeof SpawnAgentsParameters>;
