# Learning Review extension

A small Pi extension for turning user corrections and advice into **reviewable, source-backed learnings**.

The goal is not to become a large automatic memory system. The goal is to keep a simple loop: capture high-signal learning candidates, preserve evidence, and let the user decide whether they become global rules, project rules, scoped memory, skills, or nothing.

## Current status

This is scaffolding plus a minimal local command surface:

- registers `/learn` with subcommands
- opens a simple picker from bare `/learn` to select a user message explicitly
- scans the current session branch for correction/advice candidates
- stores pending candidates with evidence anchors and nearby context windows
- applies an initial heuristic classification for kind/scope/destination
- can batch-distill raw candidates through the active model on demand, with one JSON repair retry
- supports listing, searching, recalling, routing, accepting, rejecting, distilling, and reclassifying candidates
- includes an opt-in shutdown prompt that can save candidates for later review

It does **not** edit `AGENTS.md` yet.

## Design principles

- Keep it simple. Avoid always-on background agents, large memory dumps, and automatic writes.
- Keep global memory global. Project-specific facts should stay in project memory or project `AGENTS.md` files.
- Treat memory as advisory, not authority. Current user instructions, loaded `AGENTS.md`, repository files, and tool results win.
- Prefer review over automation. Never modify `AGENTS.md` without a final explicit user confirmation.
- Store evidence for every learning. A future model should be able to see why the learning exists.
- Do not inject broad memory by default. Search/recall is preferred over prompt pollution.
- Keep instruction files brief. `AGENTS.md` is curated output, not a raw memory dump.
- Avoid path-scoped prompt injection as a default. Path metadata may help ranking/recall, but should not automatically load more rules into context.

## Non-goals

- No automatic `AGENTS.md` editing.
- No always-on semantic memory injection.
- No whole-session summaries saved as memory.
- No project facts in global memory.
- No background worker pipeline unless a later use case proves it is worth the complexity.

## Command surface

Use subcommands, not dash-delimited commands:

```text
/learn
/learn help
/learn status
/learn review
/learn list [pending|accepted|promoted|rejected]
/learn recall <id>
/learn search <query>
/learn classify [id|all]
/learn distill [id|all]
/learn route <id> <destination>
/learn accept <id>
/learn reject <id>
```

Planned later:

```text
/learn apply <id>
/learn promote <id>
/learn compare-agents <id>
```

## Storage

Pending candidates currently live in the global extension store:

```text
~/.pi/agent/learning-review/candidates.json
```

Project memory support is planned around a project-local path:

```text
<project>/.pi/learning-review/memories.json
```

The global candidate store is a staging area. Accepted project-specific learnings should be written to project-local storage or project `AGENTS.md`, not global memory.

## Configuration

Settings can live in global `~/.pi/agent/settings.json` or project `.pi/settings.json` under either `learning-review` or `learn`.

Default:

```json
{
  "learning-review": {
    "promptOnShutdown": false,
    "shutdownPromptTimeoutMs": 8000,
    "minUserMessages": 3,
    "maxCandidatesPerReview": 20,
    "storeDir": "~/.pi/agent/learning-review",
    "projectMemoryPath": ".pi/learning-review/memories.json"
  }
}
```

`promptOnShutdown` defaults to `false` so this scaffold does not surprise every Pi session on exit.

## Typical workflow

```text
/learn review            # harvest likely candidates from the current session
/learn distill           # normalize pending candidates through the active model
/learn list pending      # inspect distilled suggestions
/learn recall <id>       # check evidence
/learn route <id> ...    # fix destination if needed
/learn accept <id>       # mark useful, or /learn reject <id>
```

Bare `/learn` is the explicit path: it opens a picker for user messages and attempts to distill the selected message immediately.

`/learn classify` is only a cheap fallback/debug command. After `/learn review`, `/learn distill` is the normal next step.

## Candidate lifecycle

```text
user correction/advice or explicit /learn selection
  -> pending raw candidate with evidence and nearby context
  -> /learn distill creates a concise reusable learning or routes to discard
  -> accepted, rejected, or left pending
  -> later: promoted to AGENTS.md, stored as scoped memory, or turned into a skill
```

Future promotion destinations:

| Destination | Use for |
|---|---|
| `global-agents` | stable cross-project behavior rules |
| `project-agents` | shared project conventions that should be versioned |
| `global-memory` | cross-project preferences not ready for `AGENTS.md` |
| `project-memory` | project-specific facts or conventions |
| `skill` | reusable multi-step procedures |
| `discard` | one-off, already covered, stale, or unsafe items |

## Extraction strategy

The scaffold currently uses conservative pattern matching plus small context windows:

- strong corrections: `why did you`, `do not`, `avoid`, `instead of`, `wrong`, `forgot`, etc.
- weak candidates: `I think`, `maybe`, `should`, `can we`, etc. only when a directive word appears
- false-positive suppression: `no worries`, `looks good`, etc.
- evidence context: previous user message, previous assistant response, previous assistant tool calls, next assistant acknowledgement, and nearby entry IDs when available

The current scaffold applies a lightweight heuristic classifier for kind/scope/destination. `/learn distill [id|all]` then batch-normalizes pending candidates into concise reusable learnings and can mark noisy items as `discard`. Future LLM review may also compare candidates with loaded `AGENTS.md` files before any promotion, but it should stay on-demand rather than an always-on background pipeline.

## Safety filters

The scaffold includes a small scanner that rejects candidate text that looks like:

- prompt injection
- system prompt override
- role hijacking
- credentials or private keys
- invisible Unicode tricks

This should be expanded before adding automatic promotion or prompt injection.

## Planned architecture

```text
learning-review/
├── index.ts          # extension entrypoint
├── commands.ts       # /learn subcommands
├── hooks.ts          # optional lifecycle hooks
├── candidates.ts     # correction/advice candidate extraction
├── store.ts          # candidate persistence
├── scanner.ts        # memory safety scanner
├── config.ts         # settings loading
└── types.ts          # shared types
```

Future modules likely needed:

```text
classify.ts           # LLM classification into scope/destination
agents-files.ts       # read and compare relevant AGENTS.md files
patches.ts            # exact, reviewable AGENTS.md patch proposal
ui/review-modal.ts    # interactive accept/edit/reject flow
memory-search.ts      # searchable memory store and recall tool
```

## Open planning questions

1. Should accepted-but-not-promoted global memories ever be injected, or only searchable via a tool?
2. Should project memory be stored inside the repo (`.pi/learning-review`) or under `~/.pi/agent/projects-memory`?
3. Should `/learn review` run an LLM classifier immediately, or first show heuristic candidates and ask before spending tokens?
4. What model should be used for classification/consolidation by default?
5. Should accepted project memories create/update project `AGENTS.md`, project `.pi/AGENTS.md`, or only a memory file?
6. How should we handle repeated rejected candidates so they do not keep reappearing?
7. Should subagents have their own learning review, or should the parent/orchestrator own all learning?
8. How explicit should the shutdown prompt be: save candidates only, or offer full review before exit?
9. Should there be a dry-run patch format before any `AGENTS.md` edit?
10. Should we support importing/analyzing historical sessions as a one-time backfill?
