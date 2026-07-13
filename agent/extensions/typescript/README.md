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
- MCP-backed data gathering through the host bridge

## Tool name

- `typescript`

## Tool parameters

```ts
{
  code: string;
  mode?: "analysis" | "orchestrator";
  profile?: string; // existing capability profile; inherits the session when omitted
  timeout?: number; // 1..120, default 30
  cwd?: string;     // relative to current cwd unless absolute
}
```

The `code` value is a **function body**, not a full module. It is transpiled with Bun's
built-in TypeScript transpiler before execution, so:

- **TypeScript syntax works** — type annotations, generics, `as` casts, `satisfies`, etc.
- **Static `import` declarations are rewritten** to `await import()` automatically, so both styles work:

```ts
// static import style (rewritten automatically)
import { readdir } from "node:fs/promises";
const entries = await readdir(".");
return entries;
```

```ts
// dynamic import style (always worked)
const { readdir } = await import("node:fs/promises");
const entries = await readdir(".");
return entries;
```

Note: `export` statements are not meaningful since the code runs as a function body.
Use `return` to surface a result.

## Modes and profiles

`mode` controls CodeMode host bridge capabilities. `profile` selects an existing capability profile and applies its referenced permissions profile as an additional sandbox constraint. A tool call cannot use `profile` to gain access beyond the current session. When `profile` is omitted, CodeMode inherits the current session permissions profile.

### `analysis` mode

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
- `host.mcp.*`

Blocked:

- `host.task.run()`
- `host.todo.*`

### `orchestrator` mode

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

Returns the active capability names for the current mode.

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

### `host.mcp.*`

Host-mediated MCP access is available in `analysis` and `orchestrator` modes. Direct network access follows the selected or inherited permissions profile and sandbox configuration. MCP calls go through the host bridge and are permission-gated by target such as `server.tool`.

```ts
const tools = await host.mcp.listTools({ server: "context7" });
const result = await host.mcp.call({
  server: "context7",
  tool: "resolve-library-id",
  args: { query: "React hooks docs", libraryName: "react" },
});
return result.text;
```

Available methods:

- `host.mcp.servers()`
- `host.mcp.listTools({ server, includeSchema?, disableOAuth? })`
- `host.mcp.call({ server, tool, args?, timeoutMs?, disableOAuth? })`
- `host.mcp.listResources({ server, disableOAuth? })`
- `host.mcp.readResource({ server, uri, disableOAuth? })`

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

- available only in `orchestrator` mode
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

The tool always uses a dedicated sandbox for code execution. The selected capability profile resolves to its permissions profile through the existing permissions system and is intersected with the current session policy; when omitted, the current session permissions profile is inherited. CodeMode does not override that policy with its own access mode.

If the effective policy disables dedicated sandboxing or the sandbox cannot be initialized, the tool fails closed.

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

- a call preview with mode/profile/timeout/code preview
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
- `analysis` and `orchestrator` modes
- existing capability profile resolution for sandbox permissions
- dedicated sandboxed execution
- `host.message.*`
- `host.artifact.write()`
- `host.mcp.*`
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
