# Windows Worker Deployment

The pre-release Worker is deployed manually to one trusted Windows machine. The repository does not
ship a Worker package, installer, native service wrapper, upgrade protocol, or release-signature
flow.

## Required payload

Install the following trusted, pinned files:

- Node.js 24.20.x;
- Git for Windows;
- Codex CLI;
- `apps/worker/dist/worker.mjs` and its source map/metadata;
- `native/process-host/AgenticReview.ProcessHost.exe`; and
- the fixed Worker authentication profile described in `apps/worker/README.md`.

Create that profile from an elevated PowerShell session with
`deploy/worker/provision-worker-auth.ps1`. The script masks Token input and applies the private file
and directory ACLs required by ADR 0025.

Configure absolute executable paths, expected versions, and SHA-256 digests through the Worker
environment. Store mutable data, shared repositories, attempt workspaces, temporary files, and the
Codex profile in separate configured directories.

## Launch

Build the TypeScript Worker and Windows ProcessHost from a trusted release checkout. Copy the
resulting files to the Worker machine, create the authentication profile, set the required
environment, and launch:

```powershell
node --enable-source-maps .\dist\worker.mjs
```

Use an external Windows service manager or scheduled-task policy if automatic restart is required.
It must guarantee that only one Worker process uses the configured data directories at a time and
must preserve graceful process shutdown. The current repository does not prescribe a specific
service manager.

## Distribution and signing

"Distribution" means automatically delivering a Worker release bundle to one or more machines.
That capability is not part of the MVP. Manual deployment from a trusted checkout does not require
an Ed25519 package signature. If automatic distribution is added later, its manifest, signature,
upgrade, rollback, and recovery contracts must be designed as a separate feature.
