# Types and dataflow

Use TypeScript types to make domain intent and Pulumi dependencies visible. Validate external values at runtime; types, casts, and enums do not validate stack configuration or stack outputs.

## Provider Args and component Args

Use provider-generated `<Resource>Args` for provider-facing objects and pure builders. Do not copy provider schemas into local interfaces. Generated types preserve discoverability and reveal provider schema changes during type-checking.

Use a custom `<ComponentName>Args` interface for a component's deliberate domain API. It should be smaller than the underlying provider APIs and own its defaults and invariants.

```typescript
function buildBucketArgs(args: DataBucketArgs): aws.s3.BucketV2Args {
  return {
    tags: args.tags,
  };
}
```

Return fresh objects from pure builders. If a provider escape hatch is justified, constrain it with `Omit` so callers cannot override component-owned fields.

## Finite choices

Choose finite types in this order:

1. Reuse provider-exported constants or enums for provider vocabulary.
2. Use a string enum for stable exported domain vocabulary that needs runtime values.
3. Use a string-literal union for a small TypeScript-only choice.

Never use numeric enums or `const enum` for infrastructure configuration. Prefer one mode over conflicting booleans. Translate domain values to provider values in one exhaustive function rather than leaking provider vocabulary across entry points.

```typescript
export enum Exposure {
  Private = "private",
  Internal = "internal",
  Public = "public",
}

export type RetentionPolicy = "ephemeral" | "retained";
```

## Input and Output boundaries

Use `pulumi.Input<T>` for resource properties when callers may provide either a plain value or another resource's output. Use `pulumi.Output<T>` for component outputs. Pass outputs directly to compatible inputs so Pulumi records dependency edges.

For collections and records, type nested inputs deliberately, for example `pulumi.Input<pulumi.Input<string>[]>` or `pulumi.Input<Record<string, pulumi.Input<string>>>` when individual members may be outputs.

Do not use `Input<T>` for values that shape the resource graph. Resource existence, count, loops, branches, and component selection require plain synchronously known values because Pulumi registers the graph while the program runs. Configuration loaded synchronously may control topology; an `Output<boolean>` may not.

## Transformations and dependencies

Use `pulumi.interpolate` for strings. Use `apply` only to transform an output value and `pulumi.all` only when one transformation requires several outputs.

```typescript
const endpoint = pulumi.interpolate`https://${distribution.domainName}`;
const normalizedArn = role.arn.apply((arn) => arn.toLowerCase());
```

Never create a resource inside `apply`, assign from `apply` into an outer variable, await an `Output`, call `get()` during deployment, or hide resource construction in a promise or callback. These patterns damage preview accuracy and dependency tracking.

Add `dependsOn` only for hidden side effects, such as a resource that requires a policy attachment but consumes none of its outputs. Do not use it to compensate for unclear dataflow.

## See also

- [Pulumi inputs and outputs](https://www.pulumi.com/docs/iac/concepts/inputs-outputs/)
- [Pulumi resource dependencies](https://www.pulumi.com/docs/iac/concepts/resources/options/dependson/)
- [Pulumi TypeScript SDK](https://www.pulumi.com/docs/reference/pkg/nodejs/pulumi/pulumi/)
