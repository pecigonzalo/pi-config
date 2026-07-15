# code-intel

Pi extension for compact codebase orientation.

Current actions:

- `code_intel` with `action: "repo_map"` for an Aider-style ranked map
- `code_intel` with `action: "outline", path: "..."` for file symbols/imports
- `code_intel` with `action: "symbols", query: "..."` for repo-wide symbol search
  - supports simple filters in `query`: `kind:<kind>`, `file:<path-substring>`, `name:<symbol>`, `decl:<true|false>`, `backend:<tree|syntax>`
- `code_intel` with `action: "slice", path: "...", symbol: "..."` for targeted symbol bodies
  - optional `sliceMode: "implementation" | "declaration" | "any"` (default: `"any"`)
- `code_intel` with `action: "enclosing_symbol", path: "...", line: 123` for location context
- `code_intel` with `action: "definition" | "references" | "hover", path: "...", line: 123, column: 45` for LSP-backed semantic lookup when `lsp-manager` is loaded
- `code_intel` with `action: "status"` for backend availability
- `/code-intel map [tokens]`
- `/code-intel status`

## Recommended workflows

To understand a named function, locate it with `symbols`, inspect its body with `slice`, find usages with LSP-backed `references`, run `enclosing_symbol` at relevant usage locations, and `slice` those callers:

```text
symbols → slice → references → enclosing_symbol → slice
```

For an unfamiliar subsystem, start broad and narrow before reading source:

```text
repo_map → outline or symbols → slice → references
```

Before editing, use a small `read` range only when you still need exact imports, adjacent setup, or replacement context. Avoid this broad-read pattern:

```text
symbols → read hundreds of lines
```

Use targeted text search for usages only when LSP references are unavailable or the usage is dynamic, generated, or stored outside supported source files.

The current backend prefers LSP document symbols for structural actions when available, uses `tree-sitter tags` when the CLI/parsers/queries are configured, and falls back to deterministic syntax-pattern matching. It is intentionally compact and approximate.

When the sibling `lsp-manager` extension is loaded, `definition`, `references`, and `hover` use live language-server data. These semantic actions require LSP; structural actions such as `outline`, `symbols`, and `slice` retain Tree-sitter/syntax fallback support.

`repo_map`/`symbols` report when no supported source files were analyzed (for example, unsupported extensions), when files are using generic fallback patterns instead of language-specific extraction, and whether Tree-sitter tags contributed definitions/references.

Repo analysis is cached under `${XDG_CACHE_HOME:-~/.cache}/pi-code-intel/<project-hash>/` and invalidated by file size/mtime, backend availability, and cache version.
