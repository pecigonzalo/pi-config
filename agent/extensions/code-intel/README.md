# code-intel

Pi extension for compact codebase orientation.

Current actions:

- `code_intel` with `action: "repo_map"` for an Aider-style ranked map
- `code_intel` with `action: "outline", path: "..."` for file symbols/imports
- `code_intel` with `action: "symbols", query: "..."` for repo-wide symbol search
- `code_intel` with `action: "slice", path: "...", symbol: "..."` for targeted symbol bodies
- `code_intel` with `action: "enclosing_symbol", path: "...", line: 123` for location context
- `code_intel` with `action: "status"` for backend availability
- `/code-intel map [tokens]`
- `/code-intel status`

The current backend prefers available project/git metadata and uses deterministic syntax-pattern matching. It is intentionally compact and approximate; later phases will add persistent indexing and LSP-backed precision.

`repo_map`/`symbols` now report when no supported source files were analyzed (for example, unsupported extensions) and when files are using generic fallback patterns instead of language-specific extraction.
