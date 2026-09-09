# Model-free validation Worker

Status: implemented and verified through component regression, real Windows factory startup and
a connected Windows WorkerService/Linux Server acceptance. This change does not enable evaluation
execution or establish filesystem/network isolation. See the
[delivery record](../../artifacts/m32-evaluations-20260908/model-free-worker-service-delivery-notes.md)
for exact scope, retained harness failure and independent acceptance evidence.

## Problem and intended behavior

Profile validation currently initializes a persistent Codex home, reads a provider profile and
requires a Codex executable even when the selected workflow does not request a model. Compilation,
test probes and UI checks should be deployable without those dependencies. Such a Worker must also
be excluded from tasks that require a model, rather than claiming them and silently omitting review.

`WORKER_MODEL_EXECUTION_ENABLED=false` selects the explicit model-free startup path. The existing
model-enabled mode remains the default. The disabled configuration has no Codex executable, SHA,
version, persistent profile or evaluation-model fields. It retains the common ProcessHost, Git,
workspace and validation resource settings. Existing resource environment names remain compatible;
the disabled runtime represents their values as validation limits, not a fabricated model identity.

Optional summaries and evaluation-model configuration conflict with disabled model execution and
must be rejected before configuration causes file reads. Direct startup composition repeats the
relevant checks. The disabled path does not initialize/read a persistent Codex home or provider,
verify a Codex binary, register the built-in Codex command, or construct review, summary or model
invocation factories. The existing per-attempt workspace can retain an empty `codex-home` layout
directory for shared identity/cleanup invariants; no provider data is put there or exposed to the
validation command environment.

Headless, Web and Windows desktop validation retain their independent driver readiness, disk and
process budgets, evidence handling and cleanup. The setting does not make an unavailable target
ready. It does not authorize evaluation commands to bypass their separate execution boundary.

## Capability and scheduling semantics

The Worker derives the reserved `modelExecution: "disabled"` label from startup configuration.
Deployment labels cannot override it through another value or letter case. The existing
`codexVersion: "not-configured"` value describes the absence of a configured model client; it is
not a measured version or an execution attestation.

An absent opt-out label retains compatibility with existing Workers. The Server's shared capability
matching path rejects a disabled Worker for every legacy model task, ordinary static PR review and
Issue triage, and any evaluation with a frozen required-model declaration. Ordinary PR UI and Issue
validation can run without their optional summaries. Profile-only evaluation is also classified as
not requiring a model, but still must pass every existing evaluation execution/admission gate.

Admission, claim, polling and diagnostics use the same classification. The Worker independently
rejects model-required input before workspace or command preparation. Full envelope/source/lease
validation remains separate; the small model-requirement classifier only consumes validated input
and never supplies authorization. Existing plans, serialized contexts, migration history and model
requirements are not rewritten by this Worker configuration change.

## Acceptance requirements

- Verify configuration without Codex paths, version, persistent profile or provider files; reject
  conflicting summary/evaluation configuration before filesystem access.
- Verify that disabled startup does not call model binary/provider/home preparation or construct
  model executors, including failure and cleanup paths.
- Verify runtime-derived labels and preservation of ordinary target readiness.
- Verify real owner/admission/claim behavior with a mixed Worker fleet: model tasks remain pending
  or go to a compatible Worker, while model-free validation can be claimed normally.
- Verify mandatory-model rejection in the Worker before any workspace or child process activity.
- Retain actual execution, source identity, cancellation and result/evidence checks when accepting
  a deployment; unit configuration checks alone do not accept target execution.

This is a model orchestration choice, not an operating-system sandbox. Registered profile commands
still execute deployment-trusted code. Evaluation purpose restrictions, actual model isolation,
Windows application isolation and deployment acceptance remain independent work. No test may write
to any real repository PR or Issue without the user's approval of the exact target, operation and
content, as required by the repository AGENTS.md.
