# pi-subagents

Generic child-agent execution primitives for [Pi](https://github.com/badlogic/pi-mono).

`pi-subagents` defines no roles, agents, chains, or workflows. The parent supplies every child prompt, model, tool set, working directory, and piece of context.

## Install

From GitHub:

```bash
pi install git:github.com/abdrakhmanovzh/pi-subagents
```

From a local checkout:

```bash
git clone https://github.com/abdrakhmanovzh/pi-subagents.git
pi install ./pi-subagents
```

Restart Pi or run `/reload` after installation. Releases are distributed through GitHub; this package is not published to npm.

## Tools

### `spawn_agent`

Runs one isolated Pi child process. A child receives project context files such as `AGENTS.md`, but does not receive the parent conversation, extensions, skills, prompt templates, or themes.

```json
{
  "prompt": "Inspect the authentication code and identify concrete bugs.",
  "tools": ["read", "grep", "find", "ls"],
  "contextFiles": ["src/auth.ts"],
  "thinkingLevel": "high",
  "timeoutMs": 300000
}
```

Optional fields:

- `systemPrompt`: additional child instructions
- `contextText`: explicit context included with the task
- `contextFiles`: file references resolved relative to the child working directory
- `model`: Pi model pattern or `provider/model`
- `thinkingLevel`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`
- `cwd`: child working directory; relative paths resolve from the parent working directory
- `timeoutMs`: execution timeout; defaults to 30 minutes
- `keepAlive`: keep an RPC child available for an explicit follow-up

Models, thinking level, and working directory inherit from the parent when omitted.

#### Follow-ups

Start a resumable child:

```json
{
  "keepAlive": true,
  "prompt": "Inspect this module and remember its main invariants.",
  "tools": ["read", "grep"],
  "contextFiles": ["src/module.ts"]
}
```

Use the returned `runId` in a later call:

```json
{
  "runId": "RETURNED_RUN_ID",
  "prompt": "Which invariant is most fragile?",
  "tools": ["read", "grep"]
}
```

A follow-up must retain the original model, thinking level, tools, and working directory. Resumable children are in-memory and are terminated when the parent session reloads, switches, or exits.

### `spawn_agents`

Runs independent read-only children concurrently and preserves task order:

```json
{
  "maxConcurrency": 3,
  "tasks": [
    {
      "taskId": "api",
      "prompt": "Review the API layer.",
      "tools": ["read", "grep", "find"]
    },
    {
      "taskId": "storage",
      "prompt": "Review the storage layer.",
      "tools": ["read", "grep", "find"]
    }
  ]
}
```

Parallel mode permits only `read`, `grep`, `find`, and `ls`. A batch containing `bash`, `edit`, or `write` is rejected before any child starts. Default concurrency is 4; the hard maximum is 8.

## Results

Each child returns a structured envelope:

```json
{
  "runId": "...",
  "status": "completed",
  "output": "...",
  "usage": {
    "model": "provider/model",
    "turns": 1,
    "inputTokens": 100,
    "outputTokens": 20,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "cost": 0.001,
    "durationMs": 1200
  }
}
```

Statuses are `completed`, `failed`, `cancelled`, and `needs_input`. Children are instructed to prefix an unavoidable clarification question with `NEEDS_INPUT:` so it can be mapped to `needs_input` without opening child UI.

Outputs over 50 KiB are truncated in the result. The complete output is written to a temporary file reported as `outputFile` and removed when the parent session shuts down.

## Management

```text
/subagents
/subagents cancel RUN_ID
```

The command lists active, idle resumable, and recent runs. Cancelling an active or idle resumable run invalidates its run ID.

## Safety model

- Child processes use `shell: false` and inherit normal Pi provider authentication.
- Children cannot load this extension recursively.
- Only Pi's selected built-in tools are exposed.
- Parallel batches are always read-only.
- Two write-capable children are never allowed to execute concurrently.
- Invalid tools, models, working directories, and context paths fail before launch.
- Parent abort cancels the active child or parallel batch.

## Development

Requires Node.js 22.19 or newer and pnpm.

```bash
pnpm install
pnpm check
```

`pnpm check` runs strict TypeScript checking and the unit/integration test suite.

## License

MIT
