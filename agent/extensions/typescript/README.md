# TypeScript Extension

A Pi extension that adds a `typescript` tool: a CodeMode-style, one-shot TypeScript runtime for batched analysis, artifact generation, and limited host-orchestrated workflows.

## What it is

Instead of making the model call many small tools step by step, this tool lets it execute a short TypeScript program in a Bun runtime and return a compact result.

This is useful for tasks like:

- codebase analysis across many files
- structured extraction and summarization
- local data transformation
- artifact generation
- delegated sub-work through the host bridge

## Tool name

- `typescript`

## Tool parameters

```ts
{
  code: string;
  profile?: "analysis" | "orchestrator";
  timeout?: number; // 1..120, default 30
  cwd?: string;     // relative to current cwd unless absolute
}
```

The `code` value is a **function body**, not a full module.

That means this works:

```ts
const { readdir } = await import("node:fs/promises");
const entries = await readdir(".");
return entries;
```

But top-level module syntax like this does **not** work:

```ts
import { readdir } from "node:fs/promises";
```

## Profiles

### `analysis`

Use for:

- read/analyze/report tasks
- compact summaries
- artifact generation

Bridge capabilities:

- `host.message.info()`
- `host.message.warn()`
- `host.capabilities()`
- `host.help()`
- `host.artifact.write()`

Blocked:

- `host.task.run()`
- `host.todo.*`

### `orchestrator`

Use for:

- analysis plus delegated sub-work
- workflows that need host-mediated orchestration

Bridge capabilities:

- everything in `analysis`
- `host.task.run()`

Still blocked:

- `host.todo.*` (not implemented yet)

## Host bridge

The runtime exposes a small `host` object.

### `host.capabilities()`

Returns the active capability names for the current profile.

### `host.help()`

Returns a compact description of the available host bridge.

### `host.message`

```ts
await host.message.info(text);
await host.message.warn(text);
```

Used for progress and visibility.

### `host.artifact.write`

```ts
const artifact = await host.artifact.write(name, content);
```

Writes an artifact into the run's controlled artifact directory.

Returns metadata like:

```ts
{
  name: string;
  path: string;
  size: number;
}
```

### `host.task.run`

```ts
const result = await host.task.run({
  agent: "scout",
  task: "Summarize the top-level files in this repo",
  cwd: ".",           // optional
  agentScope: "user", // optional, effectively restricted to user for MVP
});
```

Notes:

- available only in `orchestrator`
- intended for focused delegation to user agents
- project-local agents are not enabled in the MVP bridge path

### `host.todo.*`

Planned, but **not implemented yet**.

## Runtime globals

Inside the tool, the runtime exposes:

- `host`
- `state`
- `console`

`state` is an in-run mutable object for sharing temporary data during the execution.

## Examples

### Simple computation

```ts
return { ok: true, sum: 1 + 2 };
```

### File analysis

```ts
const { readdir } = await import("node:fs/promises");
const entries = await readdir(".", { withFileTypes: true });
return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
```

### Artifact generation

```ts
await host.message.info("Generating report");
const artifact = await host.artifact.write(
  "report.md",
  "# Report\n\nHello from TypeScript",
);
return { artifactName: artifact.name, size: artifact.size };
```

### Delegated orchestration

```ts
const result = await host.task.run({
  agent: "scout",
  task: "List top-level files and summarize them briefly.",
});
return {
  agent: result.agent,
  exitCode: result.exitCode,
  output: result.output,
};
```

## Sandbox behavior

The tool supports three sandbox modes in its result details:

- `dedicated` — the tool applied its own sandbox
- `inherited` — Pi was already sandboxed, so the tool reused the outer session sandbox
- `none` — unsandboxed fallback (development only)

### Inherited sandbox mode

If Pi is already running in a sandboxed session, the tool does **not** try to nest another macOS sandbox.
Instead, it inherits the outer session sandbox.

This is tracked via environment variables set by the permissions extension:

- `PI_SANDBOX_ACTIVE=1`
- `PI_SANDBOX_REASON=...`
- `PI_SANDBOX_TMPDIR=...`

### Unsandboxed fallback

Implicit unsandboxed fallback is disabled.

If dedicated sandboxing fails and there is no inherited sandbox, the tool fails closed unless this explicit opt-in is set:

```bash
PI_CODEMODE_ALLOW_UNSANDBOXED=1
```

That fallback is for development only.

## Audit trail

Tool results include structured details for:

- code executed
- result / error
- logs
- artifacts
- bridge calls
- sandbox mode and reason
- exit code
- cwd and timeout

The custom renderer shows:

- a call preview with profile/timeout/code preview
- result summary
- artifacts
- bridge calls with durations
- logs
- expanded sandbox metadata

## Prompt guidance

The tool is intentionally described to the model as a **CodeMode-style** runtime.

It is meant for:

- batched local operations
- analysis over many inputs
- compact result generation
- limited host bridge orchestration

It should **not** be preferred for trivial one-step tasks where direct tools are simpler.

## Current status

Implemented:

- one-shot Bun execution
- `analysis` and `orchestrator` profiles
- inherited sandbox mode
- `host.message.*`
- `host.artifact.write()`
- `host.task.run()`
- custom rendering and audit details

Not implemented yet:

- `host.todo.*`
- persistent CodeMode sessions/workers

## Files

Main implementation lives in:

- `agent/extensions/typescript/typescript.ts`

Package metadata:

- `agent/extensions/typescript/package.json`

Tests:

- `agent/extensions/typescript/typescript.test.ts`
