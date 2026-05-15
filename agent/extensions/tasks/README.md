# Tasks extension: persisted child-session behavior

This README documents the **implemented runtime behavior** for task delegation and task-session persistence.

## 1) Tasks config files (separate, merged)

The extension reads defaults from two files:

- Global: `~/.pi/agent/tasks.json`
- Project: nearest `.pi/tasks.json` (searched upward from the current working directory)

Both files are independent. When both exist, defaults are merged field-wise with project values taking precedence.

`tasks.json` can also define named effort presets:

```json
{
  "context": {
    "mode": "fresh | fork",
    "project": true,
    "skills": true
  },
  "persist": true,
  "efforts": {
    "balanced": {
      "provider": "github-copilot",
      "model": "gpt-5.3-codex"
    },
    "smart": {
      "provider": "github-copilot",
      "model": "gpt-5.4",
      "thinkingLevel": "high"
    }
  }
}
```

Efforts are merged by name with project values overriding global ones.

## 2) Unified context model + persist

Resolution uses the same model across agent/profile/tasks defaults:

- `context.mode`
- `context.project`
- `context.skills`
- `persist`

## 3) Runtime `task()` overrides

At runtime, `task()` supports a named `effort` preset plus **context mode shorthand**:

- `effort: "balanced" | "smart" | ...`

- `context: "fresh" | "fork"`

Each effort resolves to a concrete model and may also set `thinkingLevel`.

`persist` is config-driven (agent/profile/tasks defaults) and is **not** a supported runtime override.

## 4) `fresh` vs `fork`

- `fresh`: create a new child session file with a fresh session header.
- `fork`: create a persisted child session forked from the parent session snapshot.

`fork` requires a valid parent session and effective `persist=true`.

## 5) Persisted child sessions per step

When effective `persist=true`, each step gets its own child session file under Pi's **normal** session hierarchy (`~/.pi/agent/sessions`). Child transcript files are no longer stored under the extension's `task-runs/.../steps/...` directory layout.

Behavior by mode:

- **single**: one child session.
- **parallel**: each step gets an independent child session.
- **chain**: each step also gets an independent child session (step output chaining via `{previous}` is separate from session forking).

For `fork`, each step is forked from the parent snapshot (not from sibling child sessions).

Persisted child sessions are seeded with:

- a task-oriented session name (`task: ...`) for easier discovery in `/resume`
- a `parentSession` header pointing back to the originating parent session
- a hidden `tasks.parent-link` custom entry with parent/task linkage metadata

If `persist=false`, step execution uses non-persisted sessions and cannot be reopened later.

## 6) Metadata model and visibility

For persisted steps, the parent session appends hidden custom metadata entries of type:

- `tasks.child-session` (created + terminal status, child session identity, parent link, origin preview, optional terminal-backend metadata; current backend implementation: WezTerm)

Each child session also gets a hidden custom metadata entry of type:

- `tasks.parent-link` (parent session path/id + task linkage)

User-visible task results include compact child-session summaries (session id/status, and expanded path in detailed views).

## 7) `/tasks` command surface

Supported commands:

- `/tasks` or `/tasks list` (current session)
- `/tasks parent`
- `/tasks toggle`
- `/tasks show <selector>`
- `/tasks open <selector>`
- `/tasks attach <selector>`
- `/tasks view <selector>`
- `/tasks origin <selector>`
- `/tasks steer <selector> <message>`

Semantics:

- `/tasks` commands operate on task runs reconstructed from metadata in the current parent session.
- `parent`: from the current session, open its parent session (via `parentSession` in the child header, or `run.json` fallback for persisted fresh child sessions).
- `show`: inspect run/step metadata, origin preview, actions, and warnings.
- `open`: open selected persisted child session inside the current Pi UI when auto-open is available.
- `attach`: for completed tasks, open the persisted child session in a new terminal window using the configured terminal backend. For already-running externally hosted tasks, open/switch to the terminal workspace first and then focus the existing terminal target.
- `view`: open an in-TUI overlay viewer for a task run. The viewer shows metadata plus a recent transcript preview and supports steering shortcuts for live RPC-backed tasks. When no live controller is available, the viewer becomes read-only.
- `origin`: reveal the recorded parent-session origin for the task. In the current parent session this navigates to the recorded source entry; otherwise it shows the source session path and origin preview.
- `steer`: if the child task is currently running under a live RPC controller in this session, queue a steering message without opening the child session.
- `toggle`: toggle a persistent below-editor task widget for the current session. When enabled, the widget stays visible even with no task runs and continues to update as runs change.

Interactive runtime behavior:

- when the parent session has UI, persisted child sessions are launched under a live RPC controller so `/tasks steer ...` and richer inspection can talk to the running task process
- `/tasks` in the TUI opens an interactive task browser; `Ctrl+Shift+T` opens the current-session task browser directly
- `/tasks toggle` enables or hides the below-editor task widget for the current session
- textual `/tasks list` output includes attach guidance and per-run `/tasks attach <selector>` hints for attachable runs so it is clear how to open a child session in a terminal window
- the viewer overlay keeps the parent session active while inspecting child state. Shortcut hints in the overlay: `Ctrl+O` open, `Ctrl+A` attach, `Ctrl+G` origin, `Enter`/`Ctrl+S` steer when live control is available, `Esc` close
- in non-interactive contexts, task execution falls back to the legacy JSON-stream capture mode and live steering is unavailable
- `/tasks attach ...` uses a terminal-backend interface. Select it with `PI_TASKS_TERMINAL_BACKEND=auto|wezterm|disabled`. Today `wezterm` is implemented; the abstraction keeps room for alternatives such as tmux later.
- with WezTerm, task attach uses a fixed domain plus a workspace per parent session. Completed tasks open with `wezterm start --domain <domain> --workspace <session-workspace> --new-tab -- ...`; running externally hosted tasks open/attach that workspace first and then focus the existing pane when possible. You can override the domain with `PI_TASKS_WEZTERM_DOMAIN` (default: `pi`).
- `/tasks attach ...` avoids dual writers: completed tasks open in a new terminal window, but a running child can only be focused if it already has recorded external-terminal metadata; otherwise the command refuses and points you at `/tasks steer ...`

Selector resolution order:

1. numeric list index (index-first behavior)
2. run id prefix
3. child session id prefix
4. exact child session file basename

High-level stale/missing handling:

- missing child-session path/file is treated as stale metadata and surfaced as warning/error.
- created-without-terminal metadata is treated as running if live, otherwise interrupted.
