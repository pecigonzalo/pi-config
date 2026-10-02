# web-tools extension

Local Pi extension package for web-oriented read tools.

## Implemented

- `webfetch`: read-only URL fetch + normalization into `markdown`, `text`, or `html`
- `websearch`: web search through the built-in MCP integration (`mcp__exa__web_search_exa`) that returns normalized titles, URLs, and snippets

## Configuration

### `webfetch`

No extra configuration.

### `websearch`

`websearch` calls the `exa` MCP server through Pi's built-in MCP support, so the server must be configured in `agent/mcp.json`:

```json
{
  "mcpServers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp",
      "description": "Search the public web with Exa",
      "timeout": 15
    }
  }
}
```

Unauthenticated free-tier access works without credentials. For authenticated access, add an `Authorization: Bearer ${EXA_API_KEY}` header; Pi fails to connect the server when the referenced variable is unset, so only add it when the key is available.

`domains` is applied client-side: the hosted `web_search_exa` tool accepts only `query`, `numResults`, and `objective`, so the tool requests extra results and filters them by hostname.

## Verify

```bash
cd agent/extensions/web-tools
bun test
```

## Deferred

- `repo_clone`
- `lsp`
