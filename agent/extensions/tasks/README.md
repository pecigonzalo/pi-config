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

## Worker transport: why subprocess RPC (and not JSON or in-memory)

Every delegated step runs as its own `pi --mode rpc` child process, driven over stdin/stdout
JSON lines. This is a deliberate, settled decision -- revisit it only with new evidence, not
because the alternatives look simpler. All three options have been tried:

- **JSON one-shot (`pi --mode json -p`)**: fire-and-forget; the parent parses newline-delimited
  JSON events from stdout. Removed. It is strictly weaker than RPC for our needs: no live
  steering, no attach, no inspection while running -- and it shares RPC's core weakness (see
  below) because it uses the same line-framed event stream.

- **In-process `AgentSession` (`createAgentSession()` in the parent's process)**: tried and
  reverted. It looks simplest (no protocol, direct `prompt()`/`steer()`/`subscribe()`) but it
  fundamentally leaks process-global state across the parent and every worker:
  - `process.env.PI_AGENT_NAME` / `PI_PROFILE_NAME` are read env-first by the permissions,
    footer, and typescript extensions. The parent's composition (e.g. orchestrator's
    `defaultProfile: read-only`) bled into workers, so `read-write` workers ran read-only and
    failed every edit/write.
  - Module-level extension state (`activeMainWorker`, baselines, registries) is shared by all
    sessions in the process, so any session can silently rewrite another session's identity.
  - pi's session-replacement machinery disposes whatever session is current in the terminal,
    so inspecting a worker risked tearing down the delegating parent.

  Each of these could be patched individually, but they are all the same root cause: one
  process, many logical sessions, no isolation boundary.

- **Subprocess RPC (current)**: each worker gets its own OS process and therefore its own env,
  so `PI_AGENT_NAME`/`PI_PROFILE_NAME` are composed per worker (`getWorkerProcessEnv`) and the
  permissions/footer/typescript extensions resolve correctly without any precedence hacks.
  Crash isolation is free, live steer/attach/inspect work over the wire, and ephemeral steps
  run via `--no-session`. The cost is a wire protocol and one process per step; both are
  bounded and already paid for.

Known trade-off to remember: RPC events are line-framed JSON, so a single huge event (e.g. a
tool result embedding a screenshot as base64) becomes one very long line. The parent buffers
lines up to `MAX_CHILD_EVENT_LINE_BYTES` before parsing. That cap was once 1 MiB and aborted
image-bearing tasks with "Child emitted an oversized unterminated JSON event line"; it is now
64 MiB. Do not lower it without accounting for image payloads.

The parent's per-step result keeps only a rolling window of the worker's recent activity
(last `MAX_STREAM_MESSAGES` = 25 messages/tools, each capped at `MAX_FINAL_MESSAGE_BYTES`) so
an attached user still sees the task stream in the UI. The worker's full transcript is never
copied into the parent context -- it stays in the child session, reachable via the session id
in the result (or `/tasks open`).

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

- `tasks.child-session` (created + terminal status, child session identity, parent link, origin preview, optional terminal-backend metadata; current backend implementation: WezTerm)

User-visible task results include compact child-session summaries (session id/status, and expanded path in detailed views).

## 7) `/tasks` command surface

Supported commands (`/task ...` is accepted as a singular alias for `/tasks ...`):

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
- `parent`: from the current session, open its parent session via `parentSession` in the child session header.
- `show`: inspect run/step metadata, origin preview, actions, and warnings.
- `open`: open a task step's session. A still-running step attaches to the live worker instead (same as `/tasks attach`) -- opening a second session on its file while the RPC child is writing it would corrupt the transcript. A finished step opens the persisted child session inside the current Pi UI when auto-open is available.
- `attach`: for completed tasks, open the persisted child session in a new terminal window using the configured terminal backend. For already-running externally hosted tasks, open/switch to the terminal workspace first and then focus the existing terminal target.
- `view`: open an in-TUI overlay viewer for a task run. The viewer shows metadata plus a recent transcript preview and supports steering shortcuts for live RPC-backed tasks. When no live controller is available, the viewer becomes read-only.
- `origin`: reveal the recorded parent-session origin for the task. In the current parent session this navigates to the recorded source entry; otherwise it shows the source session path and origin preview.
- `steer`: if the child task is currently running under a live RPC controller in this session, queue a steering message without opening the child session.
- `toggle`: toggle a persistent below-editor task widget for the current session. When enabled, the widget stays visible even with no task runs and continues to update as runs change.

Interactive runtime behavior:

- every step runs under a live RPC controller (see "Worker transport"), so `/tasks steer ...`, attach, and inspection work for any running task; with parent UI, worker dialogs (select/confirm/input/editor) and status/widget updates relay to the parent's UI prefixed with the worker's task label
- `/tasks` in the TUI opens an interactive task browser; `Ctrl+Shift+T` opens the current-session task browser directly
- `/tasks toggle` enables or hides the below-editor task widget for the current session
- textual `/tasks list` output includes attach guidance and per-run `/tasks attach <selector>` hints for attachable runs so it is clear how to open a child session in a terminal window
- the viewer overlay keeps the parent session active while inspecting child state. Shortcut hints in the overlay: `Ctrl+O` open, `Ctrl+A` attach, `Ctrl+G` origin, `Enter`/`Ctrl+S` steer when live control is available, `Esc` close
- task execution has exactly one transport: a spawned `pi --mode rpc` child process per step (see "Worker transport" below). Interactive (TUI) and non-interactive contexts use the same path; only the UI relay differs.
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
