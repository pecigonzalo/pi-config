# Topology and project structure

Make the Pulumi program's resource graph and operational boundaries obvious. Organize around infrastructure capabilities and ownership rather than mirroring provider service catalogs.

## Graph topology

Pulumi discovers resources while the TypeScript program executes. Values that decide whether a resource exists, how many instances are created, which component is selected, or which loop iterations run must therefore be plain and synchronously known.

Use `pulumi.Input<T>` for properties on resources that will already exist. Do not branch or loop on `Output<T>`, and do not register resources in `apply`, promises, or callbacks. If a provider result should influence a later deployment's topology, establish an explicit project or stack boundary and consume a deliberately exported value as configuration through an appropriate workflow; do not conceal a two-phase deployment in one program.

Keep the graph declarative. Prefer dataflow dependencies over `dependsOn`, and reserve explicit dependencies for ordering Pulumi cannot infer.

## Files and composition roots

Keep `index.ts` short enough to read as a composition of capabilities. Centralize typed configuration loading and runtime validation in `config.ts`. Separate pure naming, policy, and args builders from resource construction.

```text
infra/
├── index.ts
├── config.ts
├── components/
├── policies/
└── tests/
```

Do not create structure without a concrete responsibility. A small project may keep these concerns in fewer files.

## Projects and stacks

A project is a deployment and code boundary; a stack is an isolated instance of that project. Keep resources together when they share ownership, permissions, lifecycle, change cadence, and blast radius. Split projects when those concerns materially differ, not merely to reduce source file size.

Use stacks for environment-specific instances such as development and production. Keep stack configuration explicit and validated. Avoid environment-name conditionals scattered through resource modules; resolve environment policy once and pass typed domain values into components.

Export only values that form a deliberate cross-stack API. Treat exported names and types as compatibility contracts. Parameterize stack reference coordinates rather than hardcoding organization, project, and stack names. Validate referenced outputs and preserve secret status. Numerous or cyclic stack references signal misplaced boundaries or excessive coupling.

## Providers

Rely on parent-based provider inheritance within a component. Use explicit provider resources for multi-account, multi-region, or multi-cluster deployments and pass provider selection through `ResourceOptions` or component options rather than ambient globals. Keep provider configuration near the composition root so deployment targets remain reviewable.

Provider-version changes can alter schemas and replacement behavior. Pin versions according to repository policy and review upgrades with a preview for every affected stack.

## See also

- [Organizing Pulumi projects and stacks](https://www.pulumi.com/docs/iac/guides/basics/organizing-projects-stacks/)
- [Pulumi projects](https://www.pulumi.com/docs/iac/concepts/projects/)
- [Pulumi stacks and stack references](https://www.pulumi.com/docs/iac/concepts/stacks/)
- [Pulumi providers](https://www.pulumi.com/docs/iac/concepts/resources/providers/)
- [Triggering dependent stack updates](https://www.pulumi.com/docs/deployments/guides/dependent-stack-updates/)
