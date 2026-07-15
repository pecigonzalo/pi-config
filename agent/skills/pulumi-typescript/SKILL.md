---
name: pulumi-typescript
description: Design, write, refactor, or review maintainable Pulumi programs and ComponentResource abstractions in TypeScript. Use for Pulumi TypeScript interfaces, generated resource Args, Input and Output handling, components, project and stack structure, resource identity, secrets, testing, or safe infrastructure refactors.
---

# Pulumi TypeScript

Write Pulumi TypeScript as a readable model of infrastructure. Keep composition roots small, domain boundaries explicit, resource identities stable, and abstractions no stronger than necessary.

## Baseline workflow

1. **Inspect:** Read project, package, TypeScript, stack configuration, provider versions, nearby components, and repository commands. Capture a baseline preview before a state-sensitive refactor when access permits.
2. **Design:** Identify ownership, lifecycle, security boundaries, dependencies, and identity. Choose the lowest useful abstraction and define inputs and outputs first.
3. **Implement:** Keep construction deterministic, preserve Pulumi dataflow, parent component children, use aliases for supported identity changes within one state, and plan explicit state transfers across stacks or projects.
4. **Verify:** Run formatting, linting, type-checking, and tests. Run `pulumi preview` for each affected stack when access permits, then inspect every operation.

## Non-negotiable safety rules

- Never run `pulumi up`, destroy resources, modify state, or rotate secrets without explicit user approval.
- Never create resources inside `apply`, `pulumi.all(...).apply`, promises, event handlers, or other deferred callbacks. Use `apply` only to transform values.
- Pass `pulumi.Output<T>` directly to compatible `pulumi.Input<T>` resource properties. Use `pulumi.interpolate` for strings and `pulumi.all` only for transformations that need multiple outputs.
- **Resource existence, count, loops, branches, component selection, and graph topology must depend on plain synchronously known values.** `pulumi.Input<T>` is suitable for resource properties; an `Output<T>` must not control whether or how many resources are registered.
- Let input/output dataflow infer dependencies. Add `dependsOn` only for a real dependency Pulumi cannot infer.
- Keep logical names, type tokens, parents, projects, and stacks stable. Use aliases for supported identity changes within one state; use an explicit state transfer or import-and-adoption workflow across states. Reject unexplained creates, replacements, or deletes in preview.
- Keep secrets in Pulumi secret configuration or an external secret system. Never unwrap, log, convert to plaintext, or export sensitive values without a justified cross-stack contract.
- Set `parent: this` on every child of a `ComponentResource`, use stable derived child names, and call `registerOutputs` once after assigning public outputs.
- Omit provider physical names unless an external contract requires them. Use explicit providers for multi-account, multi-region, or multi-cluster deployments.
- Parse and validate configuration and external data at the boundary. TypeScript types and assertions are not runtime validation.

## Route detailed work

Read only the references needed for the task:

- Read [Abstractions and components](references/abstractions-and-components.md) before choosing an abstraction, designing a public component API, wrapping provider resources, or implementing/reviewing `ComponentResource`.
- Read [Types and dataflow](references/types-and-dataflow.md) when defining generated provider `<Resource>Args`, custom `<Component>Args`, constants or finite choices, `Input`/`Output` values, transformations, or dependencies.
- Read [Topology and project structure](references/topology-and-project-structure.md) when changing graph shape, files, project or stack boundaries, providers, or stack references.
- Read [Lifecycle and security](references/lifecycle-and-security.md) before renaming, reparenting, moving, importing, protecting, or replacing resources, and whenever configuration, credentials, or secrets are involved.
- Read [Validation and review](references/validation-and-review.md) when writing tests, reviewing a change, preparing CI, or interpreting `pulumi preview`.
- For cross-cutting work, read all applicable references; component refactors usually require abstractions, topology, lifecycle, and validation.

## Baseline review questions

Before finishing, confirm that the entry point communicates the architecture; topology uses only synchronous values; no resource is created in deferred code; dependencies follow outputs; component children have parents; identities and secrets remain safe; generated provider types are used at provider boundaries; and preview shows no unexplained destructive operation.

## Source precedence

Treat the IaC best-practices blog series as architectural context, not as an API reference. Prefer the current Pulumi documentation, Node.js SDK reference, provider schema and generated types, installed CLI help, and repository-pinned package behavior when sources differ. Verify version-sensitive commands, options, package APIs, Pulumi Cloud features, and IAM terminology against current documentation before using them.

## See also

- [Pulumi overview](https://www.pulumi.com/docs/iac/)
- [Organizing Pulumi projects and stacks](https://www.pulumi.com/docs/iac/guides/basics/organizing-projects-stacks/)
- [Pulumi component resources](https://www.pulumi.com/docs/iac/concepts/components/)
- [Pulumi Node.js SDK reference](https://www.pulumi.com/docs/reference/pkg/nodejs/pulumi/pulumi/)
- [Official Pulumi agent skills](https://github.com/pulumi/agent-skills/tree/main/pulumi/skills)
- [Pulumi IaC best practices series](https://www.pulumi.com/blog/series/iac-best-practices/)
