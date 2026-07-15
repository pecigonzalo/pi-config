# README

This repository contains the Pi configuration that wires agent prompts,
custom skills, tools, and plugins needed by the orchestrator.

## Development

Install dependencies with `bun install`. TypeScript files under `agent/**/*.ts`
use Oxfmt for formatting, Oxlint for linting, and TypeScript for type checking.

```sh
bun run format
bun run lint
bun run typecheck
bun run test
bun run check
```

Use `bun run format:check` to verify formatting without changing files. The
formatter and linter intentionally do not process non-TypeScript files.

## Migration note
This configuration is intended to migrate into [dotFiles](https://github.com/pecigonzalo/dotFiles) in the future.
