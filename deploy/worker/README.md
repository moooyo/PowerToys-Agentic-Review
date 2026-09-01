# Legacy Windows Worker Deployment Scaffold

This directory contains the older, single-service, execution-disabled deployment scaffold. It is
kept for control-loop development only and does not implement the ADR 0007 split Control/Executor
installation. It must not be used to enable production execution.

The legacy Worker is an outbound-only Windows service. It connects to the central Server over HTTPS
with a unique mTLS client certificate. It does not receive GitHub credentials and does not access
the Server database.

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

Run an elevated PowerShell session:

```powershell
.\install-worker.ps1 `
  -PackageDirectory C:\Temp\AgenticReviewWorker `
  -ServerUrl https://workers.example.internal `
  -WorkerNodeId powertoys-worker-01 `
  -ClientCertificatePath C:\Enrollment\worker-cert.pem `
  -ClientPrivateKeyPath C:\Enrollment\worker-key.pem `
  -CaCertificatePath C:\Enrollment\worker-ca.pem `
  -StartService
```

Execution is disabled, and this installer explicitly rejects `-EnableExecution`. The native Windows
ServiceHost composition and split role bundle foundations now exist, but the role business
supervisors still emit no ARWX `Ready`. A replacement production installer must compile and sign the
release profile, package the Control and Executor bundles plus native binaries, create both service
identities and protected data roots, provision non-exportable keys, apply service and filesystem
ACLs and firewall policy, and install machine-enforced Codex policy. Native Windows x64 and arm64
verification under ADR 0007 remains mandatory before Claim authority can be enabled.

This legacy installer uses the virtual service account `NT SERVICE\AgenticReview.Worker`, removes
inherited access from its secret directory, and grants that account only the filesystem permissions
needed by the disabled control loop. The production design instead requires the distinct restricted
`NT SERVICE\AgenticReview.Worker.Control` and `NT SERVICE\AgenticReview.Worker.Executor` identities.
