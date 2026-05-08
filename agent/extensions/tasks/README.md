# Tasks extension: persisted child-session behavior

This README documents the **implemented runtime behavior** for task delegation and task-session persistence.

## 1) Tasks config files (separate, merged)

The extension reads defaults from two files:

- Global: `~/.pi/agent/tasks.json`
- Project: nearest `.pi/tasks.json` (searched upward from the current working directory)

Both files are independent. When both exist, defaults are merged field-wise with project values taking precedence.

## 2) Unified context model + persist

Defaults are represented as:

```json
{
  "context": {
    "mode": "fresh | fork",
    "project": true,
    "skills": true
  },
  "persist": true
}
```

Resolution uses the same model across agent/profile/tasks defaults:

- `context.mode`
- `context.project`
- `context.skills`
- `persist`

## 3) Runtime `task()` overrides

At runtime, `task()` only exposes **context mode shorthand**:

- `context: "fresh" | "fork"`

`persist` is config-driven (agent/profile/tasks defaults) and is **not** a supported runtime override.

## 4) `fresh` vs `fork`

- `fresh`: create a new child session file with a fresh session header.
- `fork`: create a persisted child session forked from the parent session snapshot.

`fork` requires a valid parent session and effective `persist=true`.

## 5) Persisted child sessions per step

When effective `persist=true`, each step gets its own child session file under Pi's normal session hierarchy (`~/.pi/agent/sessions`).

Path shape:

- parent-derived: `~/.pi/agent/sessions/.../task-runs/<parent-id-or-stem>/<runId>/steps/<step-label>/child-session.jsonl`
- fallback (no parent session file): `~/.pi/agent/sessions/task-runs/<parent-id-or-detached>/<runId>/steps/<step-label>/child-session.jsonl`

Behavior by mode:

- **single**: one child session.
- **parallel**: each step gets an independent child session.
- **chain**: each step also gets an independent child session (step output chaining via `{previous}` is separate from session forking).

For `fork`, each step is forked from the parent snapshot (not from sibling child sessions).

If `persist=false`, step execution uses non-persisted sessions and cannot be reopened later.

## 6) Metadata model and visibility

For persisted steps, the parent session appends hidden custom metadata entries of type:

- `tasks.child-session` (created + terminal status)

User-visible task results include compact child-session summaries (session id/status, and expanded path in detailed views).

## 7) `/tasks` command surface

Supported commands:

- `/tasks` or `/tasks list` (current scope)
- `/tasks parent`
- `/tasks recent`
- `/tasks show <selector>`
- `/tasks open <selector>`
- `/tasks recent show <selector>`
- `/tasks recent open <selector>`

Semantics:

- **current scope**: reconstruct task runs from metadata in the current parent session.
- **recent scope**: reconstruct persisted task runs from recent session files.
- `parent`: from the current session, open its parent session (via `parentSession` in the child header, or `run.json` fallback for persisted fresh child sessions).
- `show`: inspect run/step metadata and warnings.
- `open`: open selected persisted child session (or provide manual open path/instructions if auto-open is unavailable).

Selector resolution order:

1. numeric list index (index-first behavior)
2. run id prefix
3. child session id prefix
4. exact child session file basename

High-level stale/missing handling:

- missing child-session path/file is treated as stale metadata and surfaced as warning/error.
- created-without-terminal metadata is treated as running if live, otherwise interrupted.
