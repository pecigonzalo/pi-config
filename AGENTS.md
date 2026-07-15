# Pi Configuration

This is the personal Pi coding agent configuration directory (`~/.pi`).

## Development checks

This repository uses Bun, Oxfmt, Oxlint, and TypeScript for TypeScript files.

- Use `bun run format` to format `agent/**/*.ts`.
- Use `bun run format:check` to check formatting.
- Use `bun run lint` to run Oxlint.
- Use `bun run lint:fix` for safe lint fixes.
- Use `bun run typecheck` for TypeScript checking.
- Use `bun run test` for the test suite.
- Use `bun run check` for the complete validation suite.

Do not use Prettier or ESLint directly, and do not run Oxfmt or Oxlint over the whole repository.

## Preferences

### Pi Extensions

- Keep local Pi extensions self-contained: put extension dependencies, scripts, tests, and package metadata inside the extension package when possible.
- Top-level shortcuts may point into extension packages, but avoid adding extension-specific dependencies to the global package unless necessary.
