# Abstractions and components

Use the least powerful abstraction that makes infrastructure intent clearer. An abstraction must encode a domain concept, enforce an invariant, reduce meaningful repetition, establish ownership, or expose a smaller capability API.

## Abstraction ladder

1. Declare a provider resource directly when it is unique and understandable.
2. Extract a typed args object when provider configuration obscures construction.
3. Use a pure args builder for repeated naming, tags, policies, or provider arguments without resource creation.
4. Create a `ComponentResource` when several resources form a reusable capability with shared ownership and lifecycle.
5. Split into a Pulumi project when ownership, permissions, lifecycle, change rate, or blast radius materially differ.
6. Use Automation API only when programmatic orchestration is itself a product requirement.

Do not wrap a provider resource merely to rename all its properties. Do not split projects only because a file is large. Prefer composition over component inheritance.

## Public component interfaces

Name constructor input interfaces `<ComponentName>Args`. Require values without a safe universal default; make a field optional only when the component owns and documents a clear default. Prefer domain choices such as `exposure` over interacting booleans.

Expose focused overrides, not the provider's entire surface. An escape hatch couples callers to provider details and can bypass invariants; add one only for demonstrated use cases and omit fields owned by the component. Accept IDs or narrow capability interfaces when a component references but does not own another resource.

Avoid callbacks, arbitrary functions, `any`, broad index signatures, mutable shared args, and provider resource instances as configuration. Add JSDoc to exported classes, args properties, outputs, and non-obvious defaults or security consequences.

## Component implementation

A component must have high cohesion, own its children, hide implementation details, and expose only outputs consumers need.

```typescript
export interface DataBucketArgs {
  tags?: pulumi.Input<Record<string, pulumi.Input<string>>>;
}

/** A domain-owned bucket component with a small, stable interface. */
export class DataBucket extends pulumi.ComponentResource {
  public readonly bucketArn: pulumi.Output<string>;

  public constructor(
    name: string,
    args: DataBucketArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("acme:storage:DataBucket", name, args, opts);

    const bucket = new aws.s3.BucketV2(
      `${name}-bucket`,
      { tags: args.tags },
      { parent: this },
    );

    this.bucketArn = bucket.arn;
    this.registerOutputs({ bucketArn: this.bucketArn });
  }
}
```

Apply these rules:

- Use a stable `<package>:<module>:<Type>` type token and constructor `(name, args, opts?)`.
- Pass inputs to `super` so Pulumi records component input state.
- Set `{ parent: this }` on every child; provider inheritance follows the resource tree.
- Derive stable child logical names from the component name.
- Declare public outputs `readonly`, assign them before one `registerOutputs` call, and register the same values.
- Expose capabilities such as IDs and endpoints, not every internal resource.
- Keep mandatory security and ownership invariants non-overridable.
- Keep construction deterministic: no untracked randomness, current-time values, network calls, or filesystem-dependent discovery.

## Provider propagation

Callers select a package provider through `ComponentResourceOptions.providers`. The component passes `opts` to `super`, and children inherit the selected provider through `{ parent: this }`.

```typescript
const west = new aws.Provider('west', { region: 'us-west-2' });

new DataBucket('archive', {}, {
  providers: { aws: west },
});
```

A provider resource such as `aws.Provider` represents a configured deployment target. A component is a logical grouping of resources; its `providers` map controls provider propagation to its children and is not itself a provider.

## See also

- [Pulumi component resources](https://www.pulumi.com/docs/iac/concepts/resources/components/)
- [Build a Pulumi component](https://www.pulumi.com/docs/iac/guides/building-extending/components/build-a-component/)
- [Pulumi resource parents](https://www.pulumi.com/docs/iac/concepts/resources/options/parent/)
