# background

Run a shell command without blocking the agent's turn. Replaces bash-`sleep`
hacks and polling loops for workflows that need to wait on something (a
build, a deploy, a test run, `gh run watch`, ...): start it in the background
and get woken up with the output once it finishes.

## Tools

- `background_run({ command, timeout? })` — starts `command`, returns
  immediately with a job id. When the command finishes, its output is
  injected back into the conversation (`pi.sendMessage(..., { deliverAs:
  "followUp", triggerTurn: true })`) and the agent is woken up if idle.
- `background_status({ id? })` — lists all jobs, or one by id, without
  blocking: status, elapsed time, and an output tail.
- `background_cancel({ id })` — aborts a running job. No completion message
  is sent for a cancelled job.

`background_run("sleep 300")` reproduces a pure time-based wakeup, so there's
no separate "schedule a message" tool — this is a strict superset.

## Known limitations

- **No OS-level sandbox.** `background_run` executes through the SDK's plain
  `createBashToolDefinition` (the same mechanism as `bash-spawn-hook.ts` in
  the SDK's own examples), not the sandboxed execution path that
  `agent/extensions/permissions` wires into the `bash` tool. That sandbox
  (`@anthropic-ai/sandbox-runtime`) is private to that extension's closure and
  isn't reusable from here. `permissions.ts` does route `background_run`
  through the same *approval* checks as `bash` (see
  `permissions.ts:1479` — `checkBashPermission`), so ask/allow/block rules and
  saved approvals apply identically either way. What doesn't carry over is the
  OS-level jail: a command that would run sandboxed via `bash` runs
  unsandboxed via `background_run`.
- **Best-effort, in-process only.** Pi has no daemon. A job's completion
  message only fires if the same Pi process/session is still running when the
  command exits. If Pi exits first, the job (and its underlying child
  process) is gone; on the next `session_start` for that session, any job
  that never got a resolved entry is marked `status: "unknown"` rather than
  re-armed, since there's nothing left to reattach to.
- **`task` isn't covered.** Subagent delegation via the `task` extension is
  in-process, not a spawned shell command, so it can't be backgrounded through
  this tool. Most of what `typescript`/`task` do (running `tsc`, test suites,
  etc.) is CLI-expressible and works fine through `background_run` directly.
