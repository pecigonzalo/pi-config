---
name: mcp
description: Discover, configure, and call MCP (Model Context Protocol) servers. Use this when interacting with MCP tools/resources, inspecting schemas, authenticating MCP servers, trying ad-hoc MCP endpoints, or generating typed MCP clients/CLIs.
allowed-tools: Bash(bunx mcporter:*), Bash(npx -y mcporter:*), Read, Grep
---

# MCP via mcporter

Use Pi's MCP config at `~/.pi/agent/mcp.json` so CLI calls match `/mcp status` and `host.mcp`.

Prefer:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json <command>
```

If Bun is unavailable, use `npx -y mcporter --config ~/.pi/agent/mcp.json <command>`.

## Discovery

Start by listing configured servers:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json list
```

Inspect likely servers compactly before loading full schemas:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json list <server> --brief
bunx mcporter --config ~/.pi/agent/mcp.json list <server.tool> --brief
```

Load full schemas only when needed to call a tool accurately:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json list <server> --schema
bunx mcporter --config ~/.pi/agent/mcp.json list <server.tool> --schema
```

## Calling tools

Use shell-friendly key/value arguments for simple calls:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json call <server.tool> query="React hooks docs" limit:5
```

Use function-call syntax for nested or complex arguments:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json call 'server.tool(name: "value", options: { limit: 5 })'
```

For file-backed text arguments, use `key=@path`.

## TypeScript workflows

For batched or programmatic MCP workflows, prefer the `typescript` tool's `host.mcp` bridge once the relevant server or tool is known:

```ts
const tools = await host.mcp.listTools({ server: "deep-wiki" });
const result = await host.mcp.call({
  server: "deep-wiki",
  tool: "read_wiki_contents",
  args: { repoName: "owner/repo" },
});
return result.text ?? result.raw;
```

Use the mcporter CLI for discovery, config, auth, and ad-hoc exploration; use `host.mcp` for composed workflows inside TypeScript.

## Resources

List or read MCP resources:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json resource <server>
bunx mcporter --config ~/.pi/agent/mcp.json resource <server> <uri>
```

## Config and auth

Inspect and manage MCP configuration:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json config list
bunx mcporter --config ~/.pi/agent/mcp.json config get <server>
bunx mcporter --config ~/.pi/agent/mcp.json config add <name> <url-or-command>
bunx mcporter --config ~/.pi/agent/mcp.json config import <kind>
```

Authenticate OAuth-backed servers:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json auth <server-or-url>
```

Use `--no-browser` on headless hosts and keep the process alive until the browser redirect completes.

## Ad-hoc servers

Try HTTP or stdio servers without editing config:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json list https://mcp.example.com/mcp --brief
bunx mcporter --config ~/.pi/agent/mcp.json list --http-url https://mcp.example.com/mcp --name example --brief
bunx mcporter --config ~/.pi/agent/mcp.json call 'https://mcp.example.com/mcp.tool(arg: "value")'
bunx mcporter --config ~/.pi/agent/mcp.json list --stdio "bun run ./server.ts" --name local-tools
```

Add `--persist config/mcporter.json` when the server should become reusable by name.

## Daemon diagnostics

mcporter can keep configured `lifecycle: "keep-alive"` servers warm and starts daemon-managed servers on demand. Check status only when diagnosing connection or startup issues:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json daemon status
```

## Generated TypeScript clients and CLIs

For stable or repeated workflows, generate typed clients or dedicated CLIs instead of hand-writing calls:

```bash
bunx mcporter --config ~/.pi/agent/mcp.json emit-ts <server> --mode client --out clients/<server>.ts
bunx mcporter --config ~/.pi/agent/mcp.json generate-cli <server> --bundle dist/<server>.js
```
