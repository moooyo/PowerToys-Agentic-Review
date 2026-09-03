# Split Windows Worker Installation Inputs

This directory contains the fixed-path Worker Token provisioning helper for the split
Control/Executor Windows Worker. The WinSW launch templates were removed before publication.
`AgenticReview.ServiceHost.exe` is the native service binary for both roles.

ADR 0026 selects a clean-install-only Windows installer. The withdrawn transaction and store
packages are not future prerequisites. No supported path reads an old installer record, upgrades or
migrates an existing Worker, resumes an interrupted transaction, or rolls back to an earlier
generation. An ordinary install must reject any existing or partial Worker service or fixed root.

## Retained files

```text
deploy/worker/split/
  README.md
  provision-worker-auth.ps1
```

The fixed services are `AgenticReview.Worker.Control` and
`AgenticReview.Worker.Executor`. Both services run
`C:\Program Files\AgenticReview\Worker\native\AgenticReview.ServiceHost.exe`. Control uses
`C:\ProgramData\AgenticReview\TrustedConfig\control-service-host.json`, Executor uses the matching
`executor-service-host.json`, and Control depends on Executor.

The future clean installer must create the exact virtual service accounts and restricted service
SIDs, place and verify the selected release roots, create the role data roots, register the two
native services against the same ServiceHost payload with their role-specific configuration, and
start Executor before Control. It must not recreate the withdrawn journal, cross-version store,
upgrade fence, fallback parser, or rollback plan.

## Worker Token

The Linux Server stores only the SHA-256 digest of the per-Worker Token. Plaintext storage on the
Windows Worker is the fixed local Control file:

```text
C:\ProgramData\AgenticReview\Control\worker-auth-v1.json
```

The Token is ordinary local configuration. It is not a signed package payload, command-line value,
environment variable, registry value, client certificate, receipt, or Executor input.

After a future installer creates the fixed Control data root, provision or rotate the file with:

```powershell
$token = Read-Host 'Worker Token' -AsSecureString
.\provision-worker-auth.ps1 -WorkerNodeId 'worker-node-001' -Token $token
```

If `-Token` is omitted, the helper prompts securely. `-ValidateOnly` validates input without
writing. The helper writes canonical UTF-8 without a BOM or trailing newline, performs a
same-directory write-through replacement, verifies the fixed owner and inherited DACL, and never
prints the Token. The caller must serialize provisioning operations.

## Remaining implementation

The repository still needs a Windows-only clean installer. Its minimum flow is:

1. proves the fixed services and roots are absent;
2. verifies the expanded current staging tree and selects the current typed package gate;
3. materializes the three fixed roots and calls `installerdestination.Verify`;
4. creates the Control and Executor data roots;
5. provisions local configuration, including the Token file before Control starts;
6. creates and reads back the two native ServiceHost services; and
7. starts Executor and then Control.

A future narrow run marker may authorize best-effort cleanup of objects created by the same failed
invocation. It is not a transaction journal and cannot authorize resume, adoption, upgrade,
rollback, or service start. Residue without that marker remains a hard failure.

Actual authenticated release material and privileged Windows amd64/arm64 install verification
remain external release work. No Linux Worker or installer validation is required.
