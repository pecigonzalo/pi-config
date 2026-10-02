# MCP Extension

Shared mcporter-backed MCP integration for Pi.

## Status: disabled

Since the Pi 1.0 upgrade this extension is disabled by configuration (`-extensions/mcp/index.ts` in `agent/settings.json`) and its source is retained only for reference. It conflicts with Pi's built-in `/mcp` command. Normal MCP operation now uses Pi's built-in MCP support: servers in `~/.pi/agent/mcp.json`, `/mcp` in sessions, and the `pi mcp` CLI (`add`, `remove`, `list`, `login`, `logout`). Servers keep-alive via Pi's own lifecycle, so mcporter is not needed.

## Historical scope

- Owned the `mcporter` dependency and shared service helpers.
- Used Pi's MCP config at `~/.pi/agent/mcp.json` by default, independent of the current working directory.
- Registered `/mcp status`, a read-only diagnostic command for configured servers and daemon status.
- Let the TypeScript extension expose `host.mcp.*` without depending on mcporter directly.

Reconsider re-enabling only if built-in MCP cannot cover a needed workflow (for example, mcporter-only features). Do not use `bunx mcporter` or `host.mcp` as the normal path.
