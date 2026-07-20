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

const SharedContextFields = {
  contextText: Type.Optional(Type.String()),
  contextFiles: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
};

const ConfigurableContextFields = {
  systemPrompt: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  ...SharedContextFields,
};

export const RoleAgentParameters = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  ...SharedContextFields,
});

export const ReviewAgentParameters = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  includeDiff: Type.Optional(Type.Boolean({ description: "Include the tracked working-tree diff against HEAD. Defaults to false." })),
  ...SharedContextFields,
});

export const SpawnAgentParameters = Type.Object({
  keepAlive: Type.Optional(Type.Boolean({ description: "Keep the child RPC session alive and return a runId for continue_agent." })),
  prompt: Type.String({ minLength: 1 }),
  tools: Type.Array(ToolSchema, { minItems: 1 }),
  ...ConfigurableContextFields,
});

export const ContinueAgentParameters = Type.Object({
  runId: Type.String(),
  prompt: Type.String({ minLength: 1 }),
  contextText: Type.Optional(Type.String()),
  contextFiles: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const CloseAgentParameters = Type.Object({
  runId: Type.String(),
});

export const ParallelTask = Type.Object({
  taskId: Type.Optional(Type.String({ minLength: 1 })),
  prompt: Type.String({ minLength: 1 }),
  tools: Type.Array(ReadOnlyToolSchema, { minItems: 1 }),
  ...ConfigurableContextFields,
});

export const SpawnAgentsParameters = Type.Object({
  tasks: Type.Array(ParallelTask, { minItems: 1, maxItems: 8 }),
  maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});

export type RoleAgentInput = Static<typeof RoleAgentParameters>;
export type ReviewAgentInput = Static<typeof ReviewAgentParameters>;
export type SpawnAgentInput = Static<typeof SpawnAgentParameters>;
export type ContinueAgentInput = Static<typeof ContinueAgentParameters>;
export type CloseAgentInput = Static<typeof CloseAgentParameters>;
export type ParallelTaskInput = Static<typeof ParallelTask>;
export type SpawnAgentsInput = Static<typeof SpawnAgentsParameters>;
