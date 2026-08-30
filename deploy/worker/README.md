# Windows Worker Deployment

The Worker is an outbound-only Windows service. It connects to the central Server over HTTPS with a unique mTLS client certificate. It does not receive GitHub credentials and does not access the Server database.

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
    AgenticReview.ProcessHost.exe  # required only when execution is enabled
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

Execution is disabled by default, and this milestone explicitly rejects `-EnableExecution`. A
later release can remove that guard only after the Codex executor and native ProcessHost client
are present and have completed their security review.

The installer uses the virtual service account `NT SERVICE\AgenticReview.Worker`, removes inherited access from the secret directory, and grants that account only the filesystem permissions it needs.
