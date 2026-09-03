# Split Installer Profile v2

`installerprofile` defines the immutable non-secret selection paired with the current outer-package profile. It fixes
the package metadata root, installation root, trusted-configuration root, Control data root, and
Executor data root. It accepts only bootstrap schema v4 and
`agentic-review-worker-auth-v1`; Worker API credential material remains outside the signed package.

The profile deliberately contains no Token, Token digest, credential payload, alternate credential
path, service start switch, slot count, or execution option. The fixed Worker authentication file is
provisioned separately at `C:\ProgramData\AgenticReview\Control\worker-auth-v1.json` after package
verification and before Control starts. Provisioning may use one same-directory temporary file,
which is write-through, owner/DACL-checked, replaced into the fixed path, and deleted on failure.

The package is a validation contract, not a complete installer. The Windows-only clean installer,
root placement, service creation/read-back, and activation remain deferred. ADR 0026 explicitly
removes upgrade, migration, rollback-journal, and cross-version-store prerequisites. If the clean
installer reuses this profile, its consumer must accept only
`stagedpackage.InstallerPackage`; ordinary `StagedPackageEvidence` is not a sufficient installer
input.
