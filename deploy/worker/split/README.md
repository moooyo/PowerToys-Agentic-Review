# Clean Windows Worker Installation

The only supported installation is a clean install on Windows. The installer refuses to start if
either fixed service or any fixed Worker root already exists.

## Package

`worker-package.json` contains only:

```json
{"releaseId":"2026.09.04.1","architecture":"amd64","files":[{"relativePath":"app/control.mjs","size":1234,"sha256":"<lowercase-sha256>"}]}
```

`worker-package.sig` is the raw 64-byte Ed25519 signature over the exact canonical manifest. The
installer public key is compiled into the release build. The package contains no Worker node ID,
Server origin, Token, certificate, local key, target root, or receipt.

Build a package with an external Ed25519 private key:

```powershell
go run ./cmd/workerpackage -root D:\release\worker -release-id 2026.09.04.1 -architecture amd64 -private-key D:\release-secrets\worker-ed25519.key -manifest D:\release\worker\worker-package.json -signature D:\release\worker\worker-package.sig
```

The manifest must include the fixed ServiceHost, Node, Control and Executor bundles, ProcessHost,
Codex, Git, and `trusted/codex-requirements.toml` entries.

## Local install input

Create an administrator-readable local file that is not part of the package:

```json
{"serverOrigin":"https://review.example.com","workerNodeId":"worker-node-001","token":"arw1_<43-base64url-characters>"}
```

The Token is written only to
`C:\ProgramData\AgenticReview\Control\worker-auth-v1.json`. Executor cannot read the Control data
root and receives no Server client.

## Installer

Build the Windows installer with the 32-byte Ed25519 public key encoded as 64 lowercase hex
characters:

```powershell
go build -trimpath -ldflags "-X main.compiledReleasePublicKeyHex=<public-key-hex>" -o AgenticReview.WorkerInstaller.exe ./cmd/workerinstaller
```

Run it from an elevated PowerShell session:

```powershell
.\AgenticReview.WorkerInstaller.exe -package D:\release\worker -config D:\local\worker-install.json
```

The installer verifies the manifest signature, architecture, required entries, sizes, and hashes
before the first write. It then creates the fixed roots and ACLs, writes the minimal schema-4 role
configs and Token, creates both services as disabled restricted virtual-account services, switches
them to manual start, starts Executor then Control, and finally selects automatic start.

If a mutation fails, the installer makes one best-effort attempt to stop and disable any created
services. It deliberately leaves files and service records for explicit administrator cleanup; a
normal rerun refuses that partial state.
