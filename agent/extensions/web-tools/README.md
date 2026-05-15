# web-tools extension

Local Pi extension package for web-oriented read tools.

## Implemented

- `webfetch`: read-only URL fetch + normalization into `markdown`, `text`, or `html`
- `websearch`: provider-backed web search (Exa) that returns normalized titles, URLs, and snippets

## Configuration

### `webfetch`

No extra configuration.

### `websearch`

Required:

- `EXA_API_KEY`

Optional:

- `EXA_BASE_URL` (defaults to `https://api.exa.ai`)
- `WEBSEARCH_TIMEOUT_SECONDS` (defaults to `15`)

## Verify

```bash
cd agent/extensions/web-tools
bun test
```

## Deferred

- `repo_clone`
- `lsp`
