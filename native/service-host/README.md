# AgenticReview ServiceHost and Windows Installer

`AgenticReview.ServiceHost.exe` is the native SCM service binary for the Windows Control and
Executor roles. Scheduling, leases, repository policy, prompt construction, result validation, and
publication remain in TypeScript.

## Runtime boundary

The Windows runtime keeps only the boundaries needed by the selected trusted-local model:

- two restricted virtual-service identities;
- fixed `control.json` and `executor.json` paths;
- Control-only Worker Bearer Token loading;
- normal HTTPS server authentication through the Windows system trust store;
- ACL-restricted Named Pipe transport with SCM PID, pipe PID, retained process, and restricted
  service SID/token verification;
- direct Node launch with a non-breakaway root Job Object, restricted handle inheritance, and
  process/token DACLs;
- per-launch HostControl PID/identity binding; and
- bounded ARWX relay, local RPC, shutdown, and cleanup.

Runtime startup does not load a release profile or manifest and does not reverify install-tree
hashes, Authenticode, or retained filesystem handles. The removed `installverify`, `dataroot`,
`preflight`, and `launchguard` packages are not compatibility surfaces.

The current TypeScript role payloads remain zero-execution foundations. Executor reports
`ready=false`, `availableSlots=0`, and `reasonCode=EXECUTION_DISABLED`; Control does not claim work.

## ServiceHost command line

Only these role selectors are accepted:

```text
AgenticReview.ServiceHost.exe --config C:\ProgramData\AgenticReview\TrustedConfig\control.json
AgenticReview.ServiceHost.exe --config C:\ProgramData\AgenticReview\TrustedConfig\executor.json
AgenticReview.ServiceHost.exe --version
```

## Minimal schema 4

Control:

```json
{"schemaVersion":4,"role":"control","workerNodeId":"powertoys-node:01","serverOrigin":"https://review.example.com"}
```

Executor:

```json
{"schemaVersion":4,"role":"executor","workerNodeId":"powertoys-node:01"}
```

Every service name, SID, pipe name, runtime path, data root, environment entry, ProcessHost path,
policy path, and limit is derived from fixed code constants. No older schema, migration loader, or
fallback parser is retained.

The fixed Control authentication file is canonical JSON:

```json
{"profileId":"agentic-review-worker-auth-v1","token":"arw1_<43-base64url-characters>","workerNodeId":"powertoys-node:01"}
```

## Package and clean installer

`internal/workerpackage` implements the sole package contract:

- canonical `{releaseId, architecture, files}` manifest;
- forward-slash safe relative paths;
- exact file size and SHA-256 checks; and
- one raw Ed25519 signature.

`cmd/workerpackage` creates that manifest and signature from a payload directory. Private keys stay
outside the repository and package.

`internal/workerinstaller` verifies the complete package before mutation. Its Windows adapter then
creates the fixed roots and ACLs, writes local configuration, creates both services with
`SERVICE_SID_TYPE_RESTRICTED`, starts Executor before Control, and selects automatic start.
`cmd/workerinstaller` is the release command. There are no receipts, transaction journals,
rollback generations, upgrades, migrations, or repair/resume modes.

## Verification

Local verification is authorized for this project. Run only one test or build process group at a
time and confirm that its child processes have exited before starting the next group:

```powershell
go test -count=1 -p 1 ./internal/config ./internal/workertransport ./internal/platform ./internal/workerpackage ./internal/workerinstaller ./cmd/workerpackage ./cmd/workerinstaller .
go vet -p 1 ./...
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
go build -p 1 ./...
$env:GOARCH = 'arm64'
go build -p 1 ./...
Remove-Item Env:GOOS, Env:GOARCH
```

An elevated end-to-end installation smoke test still requires a real signed payload and the release
public key. No Linux Worker or `test-env` validation is required.
