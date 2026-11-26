---
name: permissions
description: Explains the active Pi permission policy, why a tool call was blocked or needs confirmation, and what to do instead of retrying. Load this when a tool call is blocked, a command asks for confirmation, or a path is rejected as outside the project.
---

# Permissions

Pi evaluates a rule-based permission policy in front of tool calls. Rules are checked in order and the first match wins. The active mode sets the defaults.

| Mode | Behaviour |
|---|---|
| `plan` | Read-only. Writes and edits are blocked, bash always asks. |
| `workspace-write` | Bash asks unless a rule allows it. Paths outside the project follow `externalPath`. |
| `auto` | Like `workspace-write`, but a classifier may auto-approve a low-risk ask instead of prompting. |
| `full-access` | No path restriction and no bash confirmation. |

## When a call is blocked or asks

A block is final for that call. Do not retry it, rephrase it, or split it into smaller calls to slip past the rule. Tell the user what was blocked and ask how to proceed.

An ask means the user decides. "Allow once" covers that call only. The other options scope the approval to the session, to the whole tool, to a path, or permanently.

## Protected resources

Some paths are protected regardless of other rules: `.env` files and key material, `.aws`/`.ssh`/`.gnupg`, Git hooks and config, shell startup files, editor directories, and the MCP config. Reads ask for confirmation by default; writes always block, except env-file writes, which also ask by default so worktree setup and `cp .env.example .env` can proceed.

While an action is `ask`, env files are not OS-denied for it. Bash prompts when a command names a literal env path (`cat .env`, `cp .env.example .env`); indirect paths such as `cat "$FILE"` are not detected. Set `readAction: "block"` or `envWriteAction: "block"` under `protectedResources` to restore a hard denial in both layers. Other protected resources keep their sandbox denies.

Env templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults`) are read-exempt inside the project by default. To let a project's own env file be read by the agent (for tests, dev servers, or worktree setup), add a workspace-scoped exception instead of unprotecting `.env` globally:

```jsonc
"protectedResources": { "workspaceRead": ["**/.env", "**/.env.*"] }
```

Exceptions only apply to resolved paths inside the workspace, and writes stay protected.

## Sandbox

When the OS sandbox is active, bash writes are limited to the workspace, the session temporary directory, and configured cache paths. The system prompt lists the effective limits. A denied write is a policy decision, not a bug: ask the user instead of retrying with another path.

## Adding rules

Only the user edits `~/.pi/agent/permissions.jsonc`. Ask for a rule instead of working around a block. A rule is `{ tool, match?, action, reason? }` with action `allow`, `block`, or `ask`. `match` accepts a regex, or shorthand such as `"rg *"` for a bash command prefix.

The user can inspect the policy with `/permissions`, `/permissions verbose`, and `/permissions approvals`.

Project-local `.pi/permissions.jsonc` is ignored unless the global config sets `"projectConfig"` to `"trusted"` or `"always"`.
