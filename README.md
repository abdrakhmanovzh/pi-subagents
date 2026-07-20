# pi-subagents

Child-agent execution primitives and focused exploration and review roles for [Pi](https://github.com/badlogic/pi-mono).

`pi-subagents` provides generic child execution alongside two narrow presets. `explore` performs fast read-only codebase discovery, while `review` performs an independent correctness review. The generic tools still let the parent supply every child prompt, model, tool set, working directory, and piece of context.

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

### `explore`

Runs a focused read-only codebase explorer using `openai-codex/gpt-5.6-terra` with medium thinking. The role is instructed to return concise evidence with exact file and line references for handoff.

```json
{
  "prompt": "Trace how authentication state reaches API route handlers.",
  "contextFiles": ["src/auth.ts"],
  "timeoutMs": 300000
}
```

The explorer has `read`, `grep`, `find`, and `ls`. Independent `explore` calls can execute in parallel.

### `review`

Runs an independent reviewer using `openai-codex/gpt-5.6-sol` with high thinking. The reviewer prioritizes correctness bugs, regressions, security and data-loss risks, and missing tests. It does not receive edit or write tools.

```json
{
  "prompt": "Review the current authentication changes against this requirement: expired sessions must return 401.",
  "includeDiff": true,
  "contextFiles": ["src/auth.ts", "test/auth.test.ts"]
}
```

The reviewer has only `read`, `grep`, `find`, and `ls`. Independent review calls can execute in parallel. Set `includeDiff` to include a bounded copy of the tracked working-tree diff against `HEAD` without granting the child shell access. Untracked files must still be supplied through `contextFiles`.

Both roles accept optional `contextText`, `contextFiles`, `cwd`, and `timeoutMs`. `review` additionally accepts `includeDiff`. Their model, thinking level, tools, and system prompt are fixed by the role. Fixed model identifiers must resolve exactly; fuzzy model matches are rejected.

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

Generic `spawn_agent` calls execute sequentially because they can include `bash`, `edit`, or `write`. Use `spawn_agents` for concurrent independent read-only work. The extension also tells the parent agent not to issue multiple write-capable `spawn_agent` calls in one turn.

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

Use the returned `runId` with `continue_agent`:

```json
{
  "runId": "RETURNED_RUN_ID",
  "prompt": "Which invariant is most fragile?"
}
```

`continue_agent` reuses the original model, thinking level, tools, system prompt, and working directory automatically. It accepts optional `contextText`, `contextFiles`, and `timeoutMs`. Use `close_agent` with the `runId` to cancel an active persistent child or close an idle one. Resumable children are in-memory and are terminated when the parent session reloads, switches, or exits.

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

Statuses are `completed`, `failed`, `cancelled`, `timed_out`, and `needs_input`. A failed single child causes `spawn_agent`, `continue_agent`, `explore`, or `review` to throw a tool error. Parallel batches preserve each child envelope and its optional `taskId` so the parent can inspect partial successes and failures. Children are instructed to prefix an unavoidable clarification question with `NEEDS_INPUT:` so it can be mapped to `needs_input` without opening child UI.

While a child runs, progress updates identify its current tool action, such as the file being read or the pattern being searched.

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
