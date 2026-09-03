# ADR 0004: Run Workers as Windows Services with a Native Process Host

- Status: Amended by ADR 0026. Windows services and Job Objects remain selected; WinSW is only a
  replaceable implementation candidate.
- Date: 2026-08-30

## Context

Remote workers must survive logoff and machine restart, run without an interactive user, and stop Codex plus all descendant build and test processes when a lease is lost. Node.js process termination alone cannot reliably enforce a Windows process-tree boundary.

## Decision

Run each headless TypeScript Worker as a Windows Service under a dedicated, least-privilege service
identity. The current scaffold launches through WinSW, but the production implementation may use a
native SCM host instead.

Ship a small, independently versioned and signed native `ProcessHost.exe`. It creates Codex or a validation command suspended, applies process-count plus per-process and total-job memory limits to a Windows Job Object, assigns the process, and only then resumes it. The Job Object enables `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The TypeScript worker communicates with it over a bounded, versioned NDJSON protocol using explicit replacement environments and resource limits.

On service stop, the worker enters draining state, stops claiming jobs, reports its state to the Server, and ends or cancels active attempts within a configured grace period. Lease loss, cancellation, timeout, ProcessHost control-channel loss, or forced service shutdown closes the Job Object and terminates the complete process tree.

The ProcessHost is a platform adapter, not a Node addon. Application scheduling and execution policy
remain in TypeScript. Whichever service host is selected handles SCM integration, startup, recovery,
shutdown timeout, and service identity. Wrapper-specific logging is required only if WinSW is kept.

The service advertises headless capabilities only. GUI automation and visible desktop interaction are not supported from Session 0; any future interactive worker must be a separate worker type and process model.

The Job Object is a process-lifetime and resource-control boundary, not an isolation boundary for
malicious code running under the same Windows token. Dynamic execution of untrusted pull-request
code remains disabled until commands run under a separate restricted identity or a stronger VM
boundary. Static Codex review also remains disabled until the automation profile, trusted binary
identity checks, executable-root ACLs, and Windows runtime tests are complete.

## Consequences

- Workers start at boot and operate without a signed-in user.
- Node.js upgrades do not require rebuilding a Node ABI-specific addon.
- Codex, compiler, and test descendants have a reliable kernel-enforced lifetime boundary.
- The current Windows package candidate includes WinSW and a native helper in addition to Node.js
  and Codex CLI; ADR 0026 permits removing WinSW.
- ProcessHost source, binaries, protocol, and signing require explicit maintenance.
- Job Objects alone do not authorize public-fork build or test execution.
