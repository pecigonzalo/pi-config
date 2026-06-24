# MCP Extension

Shared mcporter-backed MCP integration for Pi.

## Current scope

- Owns the `mcporter` dependency and shared service helpers.
- Uses Pi's MCP config at `~/.pi/agent/mcp.json` by default, independent of the current working directory.
- Registers `/mcp status`, a read-only diagnostic command for configured servers and daemon status.
- Lets the TypeScript extension expose `host.mcp.*` without depending on mcporter directly.

Use the `mcp` skill and `bunx mcporter --config ~/.pi/agent/mcp.json` for normal CLI discovery, configuration, authentication, and ad-hoc calls. mcporter starts daemon-managed keep-alive servers on demand; `/mcp status` is for diagnostics.
