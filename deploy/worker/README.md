# Retired Single-Service Windows Worker Scaffold

The only current product profile uses bootstrap schema 4, the split Control and Executor services,
and the ADR 0025 fixed per-Worker Bearer Token configuration. The root-level single-service script
and WinSW template in this directory are retired source artifacts. They are not a supported
installation path and must not be used to deploy a Worker or enable production execution.

Their obsolete credential inputs do not define a compatibility profile and cannot register against
the Token-only Server authentication path. The selected Worker remains an outbound-only Windows
client of the Linux Server's HTTPS API; it does not receive GitHub credentials and does not access
the Server database.

## Current Worker authentication boundary

ADR 0025 assigns one independently revocable, long-lived Bearer Token to each Worker node. Any
authenticated dashboard user may create a pending node, rotate its Token, or revoke it. The first
successful registration changes the Server-side node state from `pending` to `active`; `revoked` is
terminal. The Server stores only the SHA-256 digest of the Token. Restoring an older Server database
backup intentionally restores the Worker Token state contained in that backup, including the
possibility of reviving a Token revoked after the backup.

The Windows Control service reads the plaintext Token and `workerNodeId` only from the fixed
ordinary configuration file below:

```text
C:\ProgramData\AgenticReview\Control\worker-auth-v1.json
```

The exact canonical JSON profile is defined by ADR 0025. The file is local configuration, not a
release-package payload or signed package input. Production Worker requests use
`Authorization: Bearer <token>` while continuing to validate the Server's HTTPS certificate. No
Worker client certificate, Server binding receipt, active-status assertion, receipt signer, or
signer-host is a deployment prerequisite.

The Worker Bearer Token is not a lease token, a Control-to-Executor capability, a package-signing
credential, an Authenticode identity, a GitHub credential, or a Codex credential. Those boundaries,
including the Windows-local capability signer and package-signature verification, remain separate.

## Package layout

`install-worker.ps1` expects a package with this layout:

```text
package/
  app/
    dist/
      worker.mjs
      worker.mjs.map
  runtime/
    node.exe
  native/
    AgenticReview.ProcessHost.exe  # staged only; this installer cannot enable execution
  winsw/
    AgenticReview.Worker.exe
    worker-service.xml.template
  install-worker.ps1
```

`worker.mjs` is the bundled ESM release artifact and includes all non-native runtime dependencies.
The WinSW executable must be an approved, pinned release renamed to
`AgenticReview.Worker.exe`. The ProcessHost binary must be signed and pinned with the Worker
release before enabling execution.

## Installation

`install-worker.ps1` does not implement the current schema-4 profile and cannot write or validate
`worker-auth-v1.json`. Do not invoke it as an ADR 0025 installation procedure. A supported installer
must provision the fixed Control configuration file and must not offer a second Worker Token source
through an environment variable, command-line argument, registry value, package field, or alternate
path.

Execution is disabled, and this installer explicitly rejects `-EnableExecution`. The native Windows
ServiceHost composition and split role bundle foundations now exist, but the role business
supervisors permit only an authenticated disabled ARWX `Ready` state with zero available slots and
`EXECUTION_DISABLED`. A replacement production installer must compile and sign the release profile,
package the Control and Executor bundles plus native binaries, create both service identities and
protected data roots, provision the Control-to-Executor local capability-signing key and its trust
material, apply service and filesystem ACLs and firewall policy, and install machine-enforced Codex
policy. Package signing and Authenticode validation remain required. Native Windows x64 and arm64
verification under ADR 0007 remains mandatory before Claim authority can be enabled.

No migration or compatibility path is defined from the single-service scaffold. The current design
requires the distinct restricted `NT SERVICE\AgenticReview.Worker.Control` and
`NT SERVICE\AgenticReview.Worker.Executor` identities and the exact Token-storage profile described
above.
