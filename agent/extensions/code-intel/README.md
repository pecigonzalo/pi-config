# code-intel

Pi extension for compact codebase orientation.

Current actions:

- `code_intel` with `action: "repo_map"` for an Aider-style ranked map
- `code_intel` with `action: "outline", path: "..."` for file symbols/imports
- `code_intel` with `action: "symbols", query: "..."` for repo-wide symbol search
  - supports simple filters in `query`: `kind:<kind>`, `file:<path-substring>`, `name:<symbol>`
- `code_intel` with `action: "slice", path: "...", symbol: "..."` for targeted symbol bodies
  - optional `sliceMode: "implementation" | "declaration" | "any"` (default: `"any"`)
- `code_intel` with `action: "enclosing_symbol", path: "...", line: 123` for location context
- `code_intel` with `action: "status"` for backend availability
- `/code-intel map [tokens]`
- `/code-intel status`

The current backend prefers available project/git metadata, uses `tree-sitter tags` when the CLI/parsers/queries are configured, and falls back to deterministic syntax-pattern matching. It is intentionally compact and approximate; later phases will add LSP-backed precision.

`repo_map`/`symbols` report when no supported source files were analyzed (for example, unsupported extensions), when files are using generic fallback patterns instead of language-specific extraction, and whether Tree-sitter tags contributed definitions/references.

Repo analysis is cached under `${XDG_CACHE_HOME:-~/.cache}/pi-code-intel/<project-hash>/` and invalidated by file size/mtime, backend availability, and cache version.
