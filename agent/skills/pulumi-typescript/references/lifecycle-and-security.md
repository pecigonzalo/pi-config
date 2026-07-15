# Lifecycle and security

Treat resource identity and secret handling as stateful contracts. Refactors that look local in TypeScript can replace infrastructure or expose protected values.

## Resource identity

Pulumi identity includes the logical name, resource type, parent path, project, and stack. Changing any of these can create a new URN and cause replacement. Keep logical names stable and omit provider-level physical names unless an external system requires one.

For an identity change within one state, such as renaming, changing a type token, reparenting, or moving resources into or out of a component:

1. Capture a baseline preview.
2. Add aliases that describe every previous name, type, or parent identity.
3. Preview and reject unexpected creates, deletes, and replacements.
4. Apply the migration stack by stack only with explicit approval.
5. Remove transitional aliases only after every relevant stack has migrated.

Aliases preserve identity only within the state being updated. They do not transfer resources between stacks, projects, or other state files.

For a cross-stack or cross-project ownership transfer, use an explicit supported state move or import-and-adoption workflow. Preview the source stack and the destination stack before applying either side: the source must relinquish the resource deliberately, and the destination must adopt the intended existing resource without an unexpected replacement. Review the resulting state before further refactoring.

Use `protect` or provider retention settings selectively for critical stateful resources. Do not use `ignoreChanges` as a permanent mask for unexplained drift.

Derived child names and stable component type tokens are part of the component's compatibility contract. Changing a component's internal resource layout still requires migration planning.

## Configuration and validation

Load and validate configuration once at the program boundary. Use `config.require` for required plaintext values and `config.requireSecret` for secrets. Use runtime schemas or explicit parsers for YAML values, environment variables, and stack-reference outputs; TypeScript annotations do not validate external data.

Keep deployment configuration separate from reusable components. Do not read ambient environment variables deep inside resource modules when a typed argument can make the dependency explicit.

## Secrets and credentials

Keep secrets in Pulumi secret configuration or an external secret manager. Pulumi secret outputs retain their taint through normal transformations; preserve that flow.

Never call techniques that unwrap a secret for logging or plaintext configuration. Do not place secret values in logical names, physical names, tags, command arguments visible in process listings, or diagnostic messages. Do not export a secret unless another stack genuinely requires it and access controls support that contract.

Encrypted entries in `Pulumi.<stack>.yaml` may be committed when repository policy permits; plaintext credentials may not. Prefer short-lived workload or federated credentials over static cloud keys. Use explicit providers to make account, region, and cluster security boundaries visible.

Preview output can still reveal resource metadata and non-secret configuration. Review logs, test fixtures, snapshots, and error messages for accidental disclosure.

## See also

- [Refactoring Pulumi resources with aliases](https://www.pulumi.com/docs/iac/operations/stack-management/refactoring-with-aliases/)
- [`pulumi state move`](https://www.pulumi.com/docs/iac/cli/commands/pulumi_state_move/)
- [Pulumi aliases](https://www.pulumi.com/docs/iac/concepts/resources/options/aliases/)
- [Pulumi secrets](https://www.pulumi.com/docs/iac/concepts/secrets/)
- [Pulumi configuration](https://www.pulumi.com/docs/iac/concepts/config/)
