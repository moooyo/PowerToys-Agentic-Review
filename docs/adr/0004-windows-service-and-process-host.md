# ADR 0004: Run Workers as Windows Services with a Native Process Host

- Status: Accepted
- Date: 2026-08-30

## Context

Remote workers must survive logoff and machine restart, run without an interactive user, and stop Codex plus all descendant build and test processes when a lease is lost. Node.js process termination alone cannot reliably enforce a Windows process-tree boundary.

## Decision

Run each headless TypeScript worker as a Windows Service through WinSW under a dedicated, least-privilege service account.

Ship a small, independently versioned and signed native `ProcessHost.exe`. It creates a Windows Job Object, starts Codex or a validation command under that Job Object, and enables `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The TypeScript worker communicates with it over a narrow, versioned local protocol.

On service stop, the worker enters draining state, stops claiming jobs, reports its state to the Server, and ends or cancels active attempts within a configured grace period. Lease loss, cancellation, timeout, ProcessHost control-channel loss, or forced service shutdown closes the Job Object and terminates the complete process tree.

The ProcessHost is a platform adapter, not a Node addon. Application scheduling and execution policy remain in TypeScript. WinSW handles SCM integration, startup, recovery, shutdown timeout, service identity, and wrapper log rotation.

The service advertises headless capabilities only. GUI automation and visible desktop interaction are not supported from Session 0; any future interactive worker must be a separate worker type and process model.

## Consequences

- Workers start at boot and operate without a signed-in user.
- Node.js upgrades do not require rebuilding a Node ABI-specific addon.
- Codex, compiler, and test descendants have a reliable kernel-enforced lifetime boundary.
- The Windows package includes WinSW and a native helper in addition to Node.js and Codex CLI.
- ProcessHost source, binaries, protocol, signing, and update compatibility require explicit maintenance.

