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
      "context": "fresh | fork",
      "interactive": false,
      "resumeSessionId": "optional-live-worker-session-id"
    }
  ]
}
```

`mode` defaults to `single` for one step. Set `mode` explicitly for multiple steps. Every call
runs in the background and reports its result later -- see [section 4](#4-background-delegation-interactive-workers-and-resume).
`interactive` and `resumeSessionId` are also covered there.

Each effort resolves to a concrete model and may also set `thinkingLevel`.

Each step must define worker behavior with either `agent`, a behavior-bearing `profile`, or `prompt`.
Use `agent: "reviewer"` for reviews, `agent: "thinker"` for planning, and `agent: "implementer"` for implementation. Generic workers without an agent require a behavioral `prompt`; do not send bare `{ "task": "..." }` steps.

`persist` is config-driven (agent/profile/tasks defaults) and is **not** a supported runtime override.

## 4) Background delegation, interactive workers, and resume

Every `task` call runs in the background: the tool call itself returns an acknowledgment
immediately, and the real result is delivered later as a new message steered into the
delegating session (`pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`) --
interrupting whatever the delegating agent is doing if it's still streaming, or starting a new
turn if it's idle.

Delivery differs by mode:

- **single**: one pingback once the worker finishes.
- **parallel**: one pingback *per step*, as each one individually finishes -- not a single
  aggregated summary. The delegating agent already knows how many steps are running.
- **chain**: steps run sequentially in the background (each needs the previous step's real
  output for `{previous}`), with a single pingback once the whole chain settles or stops early
  on a failing step.

### Interactive workers

Set `interactive: true` on a step, an agent's frontmatter, or a profile to keep a worker's
session alive after its first turn instead of auto-finishing. An interactive worker only truly
finishes when it calls the `task_complete` tool. If it calls `ask_caller` instead, its session
stays alive and pauses, and the pingback tells the delegating agent to reply with
`resumeSessionId` (below) instead of starting a fresh delegation.

If its turn just ends without calling either, **no pingback is sent at all** -- the session
stays alive (`awaitingReply: true` internally) but silently, with nothing reported back. A
natural pause hasn't actually asked the delegating agent for anything, so pinging back there
would just invite it to nudge the worker forward with a fresh `resumeSessionId` call; if the
worker doesn't reliably comply, that nudge-pause cycle repeats with no real progress. This
mirrors how `pi-interactive-subagents` handles the same case: only an explicit `subagent_done`/
`caller_ping` call writes its exit sidecar and wakes the parent -- a natural pause just updates
an internal "waiting" status with no proactive notification. Precedence for the `interactive`
default: step > agent > profile > `false`.

Every worker (interactive or not) gets two tools it doesn't need to ask for:

- `task_complete(summary)`: reports the final answer and ends the session.
- `ask_caller(message)`: asks the caller something and pauses, without ending the session.

These are always reachable regardless of a step's own `tools`/`excludeTools` configuration,
including an explicit empty tools allowlist.

### Resuming a paused worker

To continue a worker that's still live (interactive and paused, or one that called
`ask_caller`), set `resumeSessionId` on a single-mode step to that worker's session id (from an
earlier result or pingback) and `task` to the reply. All other step fields are ignored. If the
worker is idle, this prompts it and finalizes exactly like a fresh run once that turn settles;
if it's still mid-turn (rare -- something else is already awaiting it), the reply is just
steered in, and whoever is already waiting delivers the eventual pingback.
`resumeSessionId` is only supported with `mode: "single"`.

## 5) `fresh` vs `fork`

- `fresh`: create a new child session file with a fresh session header.
- `fork`: create a persisted child session forked from the parent session snapshot.

`fork` requires a valid parent session and effective `persist=true`.

## 6) Persisted child sessions per step

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

## 7) Metadata model and visibility

For persisted steps, the parent session appends hidden custom metadata entries of type:

- `tasks.child-session` (created + terminal status, child session identity, parent link, origin preview)

User-visible task results include compact child-session summaries (session id/status, and expanded path in detailed views).

## 8) `/tasks` command surface

Supported commands (`/task ...` is accepted as a singular alias for `/tasks ...`):

- `/tasks` or `/tasks list` (current session)
- `/tasks parent`
- `/tasks toggle`
- `/tasks view <selector>`
- `/tasks open <selector>`
- `/tasks origin <selector>`
- `/tasks steer <selector> <message>`

Semantics:

- `/tasks` commands operate on task runs reconstructed from metadata in the current parent session.
- `parent`: from the current session, open its parent session via `parentSession` in the child session header.
- `view`: inspect a task run -- metadata, origin preview, available actions, warnings, and (when a controller is running) a recent transcript preview read straight from the live worker process's message history. Always a plain read-only notification, in the TUI or otherwise; use `open`/`origin`/`steer` to actually act on a run.
- `open`: "open" and "attach" are the same command, not two separate verbs -- which one happens depends on whether the step's worker process has exited. Finished: opens the persisted child session inside the current Pi UI, same as before. Still running: attaches the current terminal to the live worker instead (TUI only) -- an interactive view with a live-updating transcript where typed messages are delivered straight into the same running process, never a second session object and never a write to the worker's own session file (which its own RPC child process is still writing to -- two independent writers on one file would risk corrupting it). Esc detaches without affecting the worker. Outside the TUI, running steps fall back to a message pointing at `steer`/`resumeSessionId` instead, since attaching needs a real terminal to render into.
  - Unlike `steer` (a fire-and-forget delivery -- see below), a message sent from attach while the worker is idle goes through the same completion-tracking path a `resumeSessionId` call uses (`resumeWorkerRun`): if that message is what makes the worker call `task_complete`, attach still closes the loop -- the controller gets disposed and a pingback is delivered to the delegating session, exactly as if the parent had resumed it itself. (Detection of `task_complete`/`ask_caller` always happens on the parent's own event watcher regardless of who is driving the worker at the time -- see below -- but only whoever is actually awaiting that turn finalizes it and delivers the result; a raw steer/prompt call with nothing awaiting it would let detection fire into a completion signal nobody reads.) A message sent while the worker is still mid-turn is delivered via a plain `steer()` with no completion tracking, same as `/tasks steer`, since nothing is awaiting that specific turn.
- `origin`: reveal the recorded parent-session origin for the task. In the current parent session this navigates to the recorded source entry; otherwise it shows the source session path and origin preview.
- `steer`: if the task step is currently live, deliver it one message without opening a session -- `deliverToLiveSession` (`task-live.ts`) calls `steer()` while the worker is mid-turn (queued for after its current tool calls settle), or `prompt()` while it's idle. This matters because an interactive worker can be "live" (its controller still registered) while genuinely idle -- paused on `ask_caller` or a natural turn-end. `steer()` alone is a pure queue push with no run trigger, so delivering into a paused worker that way would just sit there unprocessed; `prompt()` is what actually starts the next turn.
- `toggle`: toggle a persistent below-editor task widget for the current session. When enabled, the widget stays visible even with no task runs and continues to update as runs change.

`view` and `steer` deliberately never wait for the main session to be idle -- that would defeat their purpose, since a task step only exists to inspect or steer *while it's running*, and the main session stays busy (from Pi's perspective) for the whole duration of the delegating `task` tool call. `parent` and `origin` always wait for idle first, since they're structural session-replacement operations that genuinely need the current turn to settle. `open` only waits when the target step has actually finished (the same structural-replacement case); attaching to a still-running step skips the wait for the same reason `view`/`steer` do.

Interactive runtime behavior:

- every task step runs as a separate `pi --mode rpc` child process (`task-rpc-worker.ts`), not in-process -- the delegating parent talks to it over stdin/stdout JSON-lines, translating a worker's config into the same CLI flags the old subprocess model used (`--model`, `--tools`/`--no-tools`/`--exclude-tools`, `--system-prompt`/`--append-system-prompt`, `--no-context-files`, `--no-skills`/`--skill`, `--approve`/`--no-approve`, `--session`/`--no-session`). This exists specifically so a human inspecting a live worker never disposes the delegating parent's own session: pi's session-replacement machinery (`/tasks open`, `/resume`, fork, new session) always tears down whatever session is "current" in a terminal before replacing it, and a human inspects a worker from the same terminal as the delegating parent -- with each worker in its own OS process, opening or steering one never touches the parent's session object, so the parent stays fully live and responsive throughout. A live controller registry (`task-live.ts`) tracks which steps currently have a running child process so `/tasks steer` and `resumeSessionId` can reach them directly.
- `task_complete`/`ask_caller` are registered globally (like `task` itself, since every worker process loads the same "tasks" extension), but their own `execute()` bodies are just static acknowledgments -- a worker's child process has no access to the delegating parent's live controller registry (different process, different memory). Completion/ping detection instead happens on the *parent* side: the worker's `RpcWorkerHandle` watches every event the child emits and reacts to `tool_execution_start` events named `task_complete`/`ask_caller`, well before (and independent of) the tool's own `execute()` finishing.
- a session shutting down only closes *its own* live controller, if it has one -- never every controller process-wide. `session_shutdown` fires on every session switch (`/tasks open`, `/resume`, fork, new session), not just process exit, and an interactive worker is meant to outlive its delegating parent's own session lifecycle.
- a pingback survives the delegating session itself going away in the meantime (unrelated to the worker's own process staying up -- the parent's session can still legitimately go away for its own reasons, e.g. process exit or `/resume` to something else). `deliverTaskPingback` falls back to writing the result straight into the delegating session's own file via `SessionManager.appendCustomMessageEntry` (a plain file writer, unaffected by extension-runtime staleness) when live delivery fails, so the result is visible next time that session is reopened or resumed instead of being silently lost.
- when the parent session has real UI, a running worker's own dialogs (select/confirm/input/editor) and status/widget updates are relayed straight to the parent's UI, prefixed with the worker's task label, via the child's `extension_ui_request` events; dialogs from concurrently-running steps are serialized so only one shows at a time. Without a real parent UI, nothing is relayed and the worker's own extension host auto-resolves its dialogs to their default after a timeout.
- `/tasks` in the TUI opens an interactive task browser (a plain select menu: pick a run, then an action); `Ctrl+Shift+T` opens the current-session task browser directly
- `/tasks toggle` enables or hides the below-editor task widget for the current session

Selector resolution order:

1. numeric list index (index-first behavior)
2. run id prefix
3. child session id prefix
4. exact child session file basename

High-level stale/missing handling:

- missing child-session path/file is treated as stale metadata and surfaced as warning/error.
- created-without-terminal metadata is treated as running if live, otherwise interrupted.
