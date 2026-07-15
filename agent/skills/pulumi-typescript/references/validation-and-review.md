# Validation and review

Validate pure logic quickly, component behavior structurally, and provider behavior with real deployments where necessary. Treat `pulumi preview` as the final semantic review, not as a substitute for type-checking and tests.

## Verification sequence

Run the repository's own commands in this order when available:

1. Format or formatting check.
2. Lint.
3. Type-check with `tsc --noEmit` or the project equivalent.
4. Unit and component tests.
5. Policy and security checks configured by the repository.
6. `pulumi preview` for every affected stack when credentials and configuration are available.

Never run `pulumi up` from a verification workflow without explicit approval. If preview cannot run, report why and identify the unverified stacks.

## Test by boundary

- Unit-test configuration parsers, naming functions, policy generation, finite-choice mappings, and provider args builders as pure functions.
- Use Pulumi mocks to assert component invariants: resource types, logical names, parent relationships, required security properties, provider selection, and registered outputs.
- Use integration tests or ephemeral stacks for provider defaults, permissions, eventual consistency, and cloud behavior that mocks cannot establish.
- Avoid snapshots of whole provider argument objects when focused assertions express the contract more clearly and survive provider upgrades.
- Test runtime rejection of malformed external configuration; compile-time types alone are insufficient.

## Preview review

Compare preview with the intended architecture and baseline. Investigate every unexpected operation, especially:

- `delete`, `replace`, or delete-before-replace operations;
- logical-name, type-token, parent, provider, project, or stack identity changes;
- physical-name changes and stateful resource recreation;
- provider-version or provider-configuration changes;
- changes to protection, retention, or deletion behavior;
- secret values becoming plaintext or newly exported;
- broad diffs caused by defaults, drift, or `ignoreChanges`;
- changed stack outputs and cross-stack API compatibility.

For production, prefer a reviewed preview artifact in CI and deploy the reviewed plan according to repository controls. Re-run preview when configuration, provider versions, or source changes after review.

## Code review checklist

- [ ] `index.ts` reads as a composition of infrastructure capabilities.
- [ ] The abstraction is the lowest level that removes meaningful complexity.
- [ ] Custom component interfaces are focused; provider-facing objects use generated `<Resource>Args`.
- [ ] Provider constants, string enums, and string unions are chosen intentionally and external values are validated.
- [ ] `Input<T>` is used for resource properties, while plain synchronous values control topology.
- [ ] No resource is created in `apply`, a promise, or another deferred callback.
- [ ] Dependencies follow outputs; every exceptional `dependsOn` has a real hidden dependency.
- [ ] Component children have the correct parent, stable names, minimal outputs, and one `registerOutputs` call.
- [ ] Project, stack, provider, and stack-reference boundaries reflect ownership and lifecycle.
- [ ] Aliases preserve identity and secrets remain protected.
- [ ] Tests cover the relevant boundary and preview contains no unexplained destructive operation.

## See also

- [Pulumi testing](https://www.pulumi.com/docs/iac/guides/testing/)
- [Pulumi preview](https://www.pulumi.com/docs/iac/cli/commands/pulumi_preview/)
- [Pulumi policy as code](https://www.pulumi.com/docs/insights/policy/)
- [Pulumi IaC best practices series](https://www.pulumi.com/blog/series/iac-best-practices/)
