# Windows Worker Deployment

The supported Worker direction is the unpublished split Control/Executor Windows profile under
`deploy/worker/split`. All WinSW templates and the former single-service mTLS deployment inputs
were removed before publication and are not compatibility inputs.

The current Worker authenticates to the Linux Server with one per-Worker Bearer Token. It has no
Worker client certificate, Server binding receipt, candidate certificate, signer host, or Linux
Worker deployment path.

There is not yet a production installer. ADR 0026 defines the next installer as clean-install-only:
it accepts only the current split profile, refuses every existing or partial installation, and has
no upgrade, migration, fallback parser, rollback generation, or transaction journal.

ServiceHost is the native Windows service binary for both roles. See `split/README.md` for the
remaining Token provisioning helper and clean-installer direction.
