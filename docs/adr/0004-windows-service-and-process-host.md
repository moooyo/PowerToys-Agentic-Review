# ADR 0004: Run Workers as Windows Services with a Native Process Host

- Status: Amended by ADR 0029. One externally managed Windows Worker process and native ProcessHost
  remain selected; the unpublished ServiceHost and installer were removed.
- Date: 2026-08-30

## Context

Remote workers must survive logoff and machine restart, run without an interactive user, and stop Codex plus all descendant build and test processes when a lease is lost. Node.js process termination alone cannot reliably enforce a Windows process-tree boundary.

## Decision

Run each headless TypeScript Worker under one dedicated Windows identity. An external service
manager may provide automatic startup and restart, but the repository does not currently ship a
native service wrapper.

Ship a small, independently versioned native `ProcessHost.exe`. It creates Codex or a validation
command suspended, applies process-count plus per-process and total-job memory limits to a Windows
Job Object, assigns the process, and only then resumes it. The Job Object enables
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The TypeScript Worker communicates with it over a bounded,
versioned NDJSON protocol using explicit replacement environments and resource limits.

On service stop, the worker enters draining state, stops claiming jobs, reports its state to the Server, and ends or cancels active attempts within a configured grace period. Lease loss, cancellation, timeout, ProcessHost control-channel loss, or forced service shutdown closes the Job Object and terminates the complete process tree.

ProcessHost is a platform adapter, not a Node addon. Application scheduling, execution policy,
registration, shutdown, and recovery remain in the single TypeScript Worker. The deployment-owned
service manager is responsible for preventing overlapping local Worker instances.

The service advertises headless capabilities only. GUI automation and visible desktop interaction are not supported from Session 0; any future interactive worker must be a separate worker type and process model.

The Job Object is a process-lifetime and resource-control boundary, not an isolation boundary for
malicious code running under the same Windows token. ADR 0029 permits build and test execution only
for revisions admitted as trusted code.

## Consequences

- Workers start at boot and operate without a signed-in user.
- Node.js upgrades do not require rebuilding a Node ABI-specific addon.
- Codex, compiler, and test descendants have a reliable kernel-enforced lifetime boundary.
- Manual Windows deployment includes ProcessHost in addition to the Node.js Worker and Codex CLI.
- ProcessHost source, binaries, and protocol require explicit maintenance.
- Job Objects alone do not authorize code; Server admission policy does.
