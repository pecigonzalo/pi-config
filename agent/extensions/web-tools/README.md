# web-tools extension

Local Pi extension package for web-oriented read tools.

## Implemented

- `webfetch`: read-only URL fetch + normalization into `markdown`, `text`, or `html`
- `websearch`: lightweight MCP-backed web search (Exa MCP) that returns normalized titles, URLs, and snippets

## Configuration

### `webfetch`

No extra configuration.

### `websearch`

Optional:

- `EXA_API_KEY` (passed through to the hosted Exa MCP endpoint when present; unauthenticated free-tier access may still work without it)
- `EXA_MCP_URL` (defaults to `https://mcp.exa.ai/mcp`)
- `WEBSEARCH_TIMEOUT_SECONDS` (defaults to `15`)

## Verify

```bash
cd agent/extensions/web-tools
bun test
```

## Deferred

- `repo_clone`
- `lsp`
