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

## Nested delegation

Child workers cannot delegate with `task` by default. To allow a specific agent
or profile to delegate, set `allowDelegation: true` in its frontmatter. The
existing task-depth limit still applies. This policy also prevents generic
workers from delegating.

## 2) Unified context model + persist

Resolution uses the same model across agent/profile/tasks defaults:

- `context.mode`
- `context.project`
- `context.skills`
- `persist`

## 3) Runtime `task()` API

Runtime calls use a compact `mode + steps` shape:

```json
{
  "mode": "single | parallel | chain",
  "steps": [
    {
      "task": "Work request; chain steps may use {previous}",
      "agent": "optional-agent",
      "profile": "optional-profile",
      "effort": "balanced",
      "context": "fresh | fork"
    }
  ]
}
```

`mode` defaults to `single` for one step. Set `mode` explicitly for multiple steps.

Each effort resolves to a concrete model and may also set `thinkingLevel`.

Each step must define worker behavior with either `agent`, a behavior-bearing `profile`, or `prompt`.
Use `agent: "reviewer"` for reviews, `agent: "thinker"` for planning, and `agent: "implementer"` for implementation. Generic workers without an agent require a behavioral `prompt`; do not send bare `{ "task": "..." }` steps.

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

If `persist=false`, step execution uses non-persisted sessions and cannot be reopened later.

## 6) Metadata model and visibility

For persisted steps, the parent session appends hidden custom metadata entries of type:

- `tasks.child-session` (created + terminal status, child session identity, parent link, origin preview)

User-visible task results include compact child-session summaries (session id/status, and expanded path in detailed views).

## 7) `/tasks` command surface

Supported commands (`/task ...` is accepted as a singular alias for `/tasks ...`):

- `/tasks` or `/tasks list` (current session)
- `/tasks parent`
- `/tasks toggle`
- `/tasks view <selector>`
- `/tasks open <selector>`
- `/tasks attach <selector>`
- `/tasks origin <selector>`
- `/tasks steer <selector> <message>`

Semantics:

- `/tasks` commands operate on task runs reconstructed from metadata in the current parent session.
- `parent`: from the current session, open its parent session via `parentSession` in the child session header.
- `view`: inspect a task run -- metadata, origin preview, actions, warnings, and (when a controller is running) a recent transcript preview read straight from the live `AgentSession`'s message history. In the TUI this opens an interactive overlay with buttons for the other actions (open/attach/origin/steer); outside the TUI it falls back to a plain text notification with the same content. This is the one "inspect" verb -- there is no separate `show` command, since `view`'s non-TUI fallback already covers what a plain text dump would show.
- `open`: open a task step's session. A still-running step opens as the live attach view (same as `/tasks attach`; a subscribe-only overlay that never session-replaces, because replacing the current session would dispose the delegating parent). A finished step opens as a real persisted child session inside the current Pi UI when auto-open is available.
- `attach`: open a live view onto a running task step -- built from the same message/tool-call rendering pi's own interactive mode uses, subscribed directly to the worker's `AgentSession` (no subprocess, no wire protocol). Type a line and press Enter to steer the worker directly from the view; `Esc` detaches back to the parent -- the worker keeps running in the background either way. Only available while the step is actually running; a completed step has nothing live to attach to (use `open` to resume it as a normal session).
- `origin`: reveal the recorded parent-session origin for the task. In the current parent session this navigates to the recorded source entry; otherwise it shows the source session path and origin preview.
- `steer`: if the task step is currently running, send it one message (`controller.session.steer(...)`) without opening the live view.
- `toggle`: toggle a persistent below-editor task widget for the current session. When enabled, the widget stays visible even with no task runs and continues to update as runs change.

`view`, `attach`, and `steer` deliberately never wait for the main session to be idle -- that would defeat their purpose, since a task step only exists to inspect or steer *while it's running*, and the main session stays busy (from Pi's perspective) for the whole duration of the delegating `task` tool call. `parent` and `origin` always wait for idle first, since those are structural session-replacement operations that genuinely need the current turn to settle. `open` only waits when the target step has actually finished (the same structural-replacement case); attaching to a still-running step skips the wait for the same reason `view`/`attach`/`steer` do.

Interactive runtime behavior:

- every task step runs as a real, in-process `AgentSession` -- the same session type, and the same `prompt()`/`steer()`/`subscribe()` primitives, that a normal interactive `pi` session uses. There is no subprocess, no pty, and no RPC-over-pipes protocol; a live controller registry (`task-live.ts`) tracks which steps are currently running so `/tasks attach` and `/tasks steer` can reach them directly.
- when the parent session has real UI, a running worker's own dialogs (select/confirm/input/editor) and status/widget updates are relayed straight to the parent's UI, prefixed with the worker's task label; dialogs from concurrently-running steps are serialized so only one shows at a time. Without a real parent UI, a worker's dialogs auto-resolve to their default (no relay).
- `/tasks` in the TUI opens an interactive task browser; `Ctrl+Shift+T` opens the current-session task browser directly
- `/tasks toggle` enables or hides the below-editor task widget for the current session
- textual `/tasks list` output includes attach guidance; per-run `/tasks attach <selector>` hints appear for runs with an actually-running step
- the viewer overlay keeps the parent session active while inspecting child state. Shortcut hints in the overlay: `Ctrl+O` open, `Ctrl+A` attach, `Ctrl+G` origin, `Enter`/`Ctrl+S` steer when live control is available, `Esc` close

Selector resolution order:

1. numeric list index (index-first behavior)
2. run id prefix
3. child session id prefix
4. exact child session file basename

High-level stale/missing handling:

- missing child-session path/file is treated as stale metadata and surfaced as warning/error.
- created-without-terminal metadata is treated as running if live, otherwise interrupted.
