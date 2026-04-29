# Task Architecture: agents, profiles, and model-tiers

Status: draft

## Goals

- Separate three concerns that were previously conflated under "agent":
  - **agent** = role, prompt, behavior
  - **profile** = tools, permissions, isolation/capability envelope
  - **model-tier** = named model strength/cost preset
- Support both:
  - predefined role-based workers such as `orchestrator` and `thinker`
  - fully composed workers where behavior is mostly defined at call time
- Allow agents to be restricted to `main`, `task`, or `both`.
- Keep runtime composition first-class for both `pi` and `task()`.
- Preserve explicit skill loading and strict failure on missing required skills.

---

## Core concepts

### 1. Agent

An **agent** describes role and behavior.

It answers:
- how should this worker behave?
- what is its default role prompt?
- can the user select it directly, or only workflows?

Examples:
- `orchestrator`
- `thinker`
- `implementer`
- `reviewer`

An agent may define:
- prompt/body
- `availability: main | task | both`
- default profile
- default model-tier
- exact default model override
- default skills
- optional tighter overrides on tools/permissions inherited from the profile

### 2. Profile

A **profile** describes the capability envelope.

It answers:
- what tools are visible?
- what permissions policy applies?
- does it inherit project context?
- does it inherit normal skill discovery?
- how isolated is this worker?

Examples:
- `read-only`
- `read-write`
- `isolated`

A profile may define:
- visible tools
- permissions identity / permissions baseline
- `inheritProjectContext`
- `inheritSkills`
- optional prompt/body with operational constraints

Profile prompts should stay short and constraint-oriented.

Good examples:
- "Do not modify files."
- "Do not use bash."
- "Do not rely on project context unless explicitly provided."

### 3. Model-tier

A **model-tier** is a named model preset.

It answers:
- how strong should the model be?
- how expensive / slow is it expected to be?
- what default thinking level should it use?

Examples:
- `light`
- `balanced`
- `heavy`

A model-tier may define:
- model id or selector
- optional provider preference
- optional thinking level
- optional fallback list

Model-tiers do not define behavior or permissions.

---

## Discovery and precedence

### Agents

Discovered from markdown files in:
- project: `.pi/agents/*.md`
- global: `~/.pi/agent/agents/*.md`

### Profiles

Discovered from markdown files in:
- project: `.pi/profiles/*.md`
- global: `~/.pi/agent/profiles/*.md`

### Model-tiers

Discovered from config files in:
- project: `.pi/model-tiers.json`
- global: `~/.pi/agent/model-tiers.json`

Project definitions override global definitions with the same name.

---

## Composition model

A worker invocation is composed from up to six pieces:

1. base pi system prompt
2. selected profile
3. selected agent
4. selected model-tier
5. runtime skills
6. runtime prompt

Not all pieces are required.

Examples:
- role-first worker: agent + agent defaults
- constrained role worker: agent + profile
- generic worker: profile + model-tier + skills + runtime prompt

---

## Prompt merge order

Prompt stacking order is:

1. base pi system prompt
2. profile prompt
3. agent prompt
4. runtime `prompt`

Rationale:
- the profile establishes operational constraints
- the agent establishes role and behavior
- the runtime prompt specializes the current invocation

Profile prompts should not replace agent prompts.
Agent prompts remain the primary behavioral layer.

---

## Runtime precedence

### Profile resolution

Resolution order:
1. runtime `profile`
2. agent default profile
3. no profile

### Model resolution

Resolution order:
1. runtime `model`
2. runtime `modelTier`
3. agent default `model`
4. agent default `modelTier`
5. pi default model selection

Profiles should generally not own model selection.
Profiles are about capabilities, not model strength.

### Skills resolution

Resolution order:
1. runtime `skills`
2. agent default skills
3. inherited skill discovery, only if allowed by the selected profile

If runtime `skills` are provided:
- resolve only those skills
- disable normal inherited skill discovery for that invocation
- fail hard if any explicit skill cannot be resolved

### Tools and permissions resolution

Resolution model:
1. selected profile defines the baseline tools/permissions envelope
2. selected agent may tighten or selectively override that baseline
3. runtime calls do not directly override permissions

This keeps safety and behavior clearly separated.

---

## Availability

Availability belongs to **agents**, not profiles.

Values:
- `main` — selectable only by the user in the main session
- `task` — selectable only via `task()`
- `both` — available in both places

Profiles do not have availability.
Profiles are envelopes, not personas.

---

## Main session UX

The user may compose the main session with:

```bash
pi --agent orchestrator --profile read-only --model-tier heavy
```

Supported selectors:
- `--agent <name>`
- `--profile <name>`
- `--model-tier <name>`
- `--model <provider/model>`

`--model` is the exact override.
`--model-tier` is the named strength preset.

Live session switching should support the same composition model conceptually, for example through commands such as:
- `/agent ...`
- `/profile ...`
- `/model-tier ...`

Exact live-session UX is implementation detail, but the composition semantics should match startup behavior.

---

## Task tool schema

The `task` tool should support three modes:
- single
- parallel
- chain

The single-step shape becomes:

```ts
interface TaskStep {
  task: string;
  agent?: string;
  profile?: string;
  modelTier?: string;
  model?: string;
  skills?: string[];
  prompt?: string;
  cwd?: string;
}
```

Top-level single mode:

```ts
{
  task: string;
  agent?: string;
  profile?: string;
  modelTier?: string;
  model?: string;
  skills?: string[];
  prompt?: string;
  cwd?: string;
  agentScope?: "user" | "project" | "both";
  confirmProjectAgents?: boolean;
}
```

Parallel and chain steps use the same step shape.

### Minimum valid composition

A task invocation must provide enough information to define behavior.

Valid examples:
- `agent + task`
- `agent + profile + task`
- `profile + prompt + task`
- `prompt + skills + task`

Invalid example:
- profile/model-tier only, with no agent and no behavioral prompt

The system should fail clearly when the role/behavior layer is missing.

---

## Example task calls

### Predefined role with defaults

```ts
task({
  agent: "thinker",
  task: "Break down the work into phases.",
})
```

### Override profile

```ts
task({
  agent: "thinker",
  profile: "read-only",
  task: "Investigate the code path and summarize findings.",
})
```

### Override profile and model-tier

```ts
task({
  agent: "thinker",
  profile: "read-only",
  modelTier: "heavy",
  task: "Plan a safe migration strategy.",
})
```

### Exact model override

```ts
task({
  agent: "thinker",
  profile: "read-only",
  model: "openai/gpt-5.4",
  task: "Evaluate trade-offs and recommend an approach.",
})
```

### Role + profile + model-tier + explicit skills

```ts
task({
  agent: "thinker",
  profile: "read-only",
  modelTier: "heavy",
  skills: ["pattern-task-breakdown", "standards-go"],
  task: "Produce a Go-specific implementation plan.",
})
```

### Generic composed worker with no predefined agent

```ts
task({
  profile: "read-only",
  modelTier: "heavy",
  skills: ["standards-code", "standards-go"],
  prompt: "Act as a release-risk analyst. Focus on migration hazards and verification.",
  task: "Review this planned refactor and identify major risks.",
})
```

---

## Permissions integration

The runtime should expose both concepts to permissions-aware extensions:

```ts
env: {
  ...process.env,
  PI_AGENT_NAME: selectedAgentName,
  PI_PROFILE_NAME: selectedProfileName,
}
```

Intended resolution model:
- profile provides the baseline permissions identity
- agent may apply tighter overrides
- exact merge rules are implementation-defined, but agents should not casually widen a restrictive profile

---

## Initial recommended sets

### Agents
- `orchestrator`
- `thinker`
- `implementer`
- `reviewer`

### Profiles
- `read-only`
- `read-write`
- `isolated`

### Model-tiers
- `light`
- `balanced`
- `heavy`

---

## Migration direction

Move from the current flat "all are agents" model to:
- role agents
- capability profiles
- model-tiers

Expected migration steps:
1. revise spec and terminology
2. add profile discovery
3. add model-tier discovery/resolution
4. update task schema to accept `profile` and `modelTier`
5. update main-session selection to accept `--profile` and `--model-tier`
6. update prompt merging to `profile -> agent -> runtime prompt`
7. update permissions integration to include profile identity
8. migrate existing flat agents into the new buckets
9. validate end-to-end behavior

---

## Decision summary

- `agent` means role/behavior
- `profile` means tools/permissions/isolation envelope
- `model-tier` means named model strength preset
- availability is an agent concern
- explicit model beats model-tier
- explicit skills fail hard if unresolved
- generic workers without a predefined agent are supported
