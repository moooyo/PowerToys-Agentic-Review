# Windows Worker Deployment

The supported Worker direction is the unpublished split Control/Executor Windows profile under
`deploy/worker/split`. The former single-service mTLS installer, WinSW template, and environment
example were removed before publication and are not compatibility inputs.

The current Worker authenticates to the Linux Server with one per-Worker Bearer Token. It has no
Worker client certificate, Server binding receipt, candidate certificate, signer host, or Linux
Worker deployment path.

There is not yet a production installer. ADR 0026 defines the next installer as clean-install-only:
it accepts only the current split profile, refuses every existing or partial installation, and has
no upgrade, migration, fallback parser, rollback generation, or transaction journal.

See `split/README.md` for the reusable split launch inputs and Token provisioning helper.
