# Split Installer Profile v2

`installerprofile` defines the immutable non-secret selection paired with outer-package v2. It fixes
the package metadata root, installation root, trusted-configuration root, Control data root, and
Executor data root. It accepts only bootstrap schema v4 and
`agentic-review-worker-auth-v1`, with no Worker client-certificate fields.

The profile deliberately contains no Token, Token digest, credential payload, alternate credential
path, service start switch, slot count, or execution option. The fixed Worker authentication file is
provisioned separately at `C:\ProgramData\AgenticReview\Control\worker-auth-v1.json` after package
verification and before Control starts. Provisioning may use one same-directory temporary file,
which is write-through, owner/DACL-checked, replaced into the fixed path, and deleted on failure.

The package is a validation contract, not a complete installer. The production SCM adapter,
destination transaction, crash recovery, service creation, activation readiness, and rollback
consumer remain deferred. A future v2 consumer must accept only
`stagedpackage.BearerTokenInstallerV2Package`; ordinary `StagedPackageEvidence` and historical v1
packages are not sufficient installer inputs.
