# Prepared model invocation lifecycle

## Parent-owned execution

The common `PreparedCodexOutputRunner` now accepts an optional `PreparedModelInvocation` from
its parent attempt owner. It snapshots the complete expected scope, actual stdin prompt,
authoritative output schema and execution context before asynchronous opening. The returned
opening must match the complete scope and both input digests. A template digest cannot stand
in for the different prompt that a validation summary composes with runner context.

The parent must retain one stable attempt signal throughout this workflow. A module-level weak
map reserves the Job/attempt/Worker instance/lease-generation tuple before opening. A fresh
wrapper, invocation nonce or runner instance cannot dispatch it again under that same owner.
The reservation is retained after success or failure and becomes collectible with its signal.
This is an in-process ownership rule, not authentication against a caller that invents another
owner signal. Worker lease fencing remains responsible for process restarts and new attempts.

## Relay launch configuration

The relay branch replaces the entire provider configuration and provider environment. It selects
the exact requested model, one internal Responses provider and the parent's canonical loopback
relay URL. Only an ephemeral relay Bearer value enters the CLI environment; the bare token and
complete Bearer value are protected from retained model output and command diagnostics. Upstream
headers remain in the parent relay authorization callback.

The CLI uses the fresh `codexHomeDirectory` already created by the attempt workspace provider
as `CODEX_HOME`, not the persistent upstream provider profile. This home must be inside the
attempt and disjoint from its checkout and control directories. Pre-existing `config.toml` or
`auth.json` prevents launch. The provider owns the home and the separate schema/result directory.
This change avoids deliberately pointing the CLI at upstream credentials; it does not prove
that the Windows account cannot read some other path, keyring, machine policy or network endpoint.
The ordinary review path retains its current persistent-profile behavior.

## Completion, cancellation and retry

The runner opens collection before process dispatch. It gives the coordinator the actual
`ManagedProcess` and a rejecting promise derived from the single stdout/stderr consumers.
`Promise.allSettled` returning successfully cannot certify successful stream draining.
An attachment failure leaves the runner responsible for terminating and observing that process.
Cancellation has a bounded teardown wait; a termination acknowledgement alone is not completion.
If the process has already exited while its streams are draining, rejection of a subsequent
termination request does not invalidate independently confirmed exit and stream closure. Progress
callback failures trigger cancellation without abandoning those stream consumers, and the disk
monitor closes in `finally` even if the initial or final process-count callback fails.

After a successful process exit, the runner reads the stable bounded result file, validates the
model JSON against its authoritative schema and rejects protected values. Only then does it
select the original canonical model-output digest for closure. Failed or invalid model output
selects null. The coordinator independently confirms process completion, stream draining and
relay closure before constructing its seal and ledger upload.

An uncertain seal or submission transport receives one bounded replay on the same retained
session, using the same close intent and retained ledger. There is no second model process and
no change from a selected output digest to null. Other collection failures are not retried as
new dispatches. Unconfirmed process or relay cleanup requests Worker drain through the existing
node-health callback.

A successful prepared result retains its raw JSON, its own digest and the matching collection
receipt separately. Collection failure or an unbound/mismatched output cannot return a successful
prepared result. The receipt still has `executionAccepted: false`; neither this runner result nor
collection consistency supplies a PR decision or trusted evaluation score.

## Remaining composition and acceptance

This is the production common runner's lifecycle integration point. `main.ts` does not yet create
these per-attempt sessions, and evaluation capability, claim and completion gates remain disabled.
Runtime measurements and an accepted command/network boundary must be composed before enabling
that path. Synthetic ProcessHost and provider tests do not accept a real Codex or Windows runtime.

The next result version must retain the bounded original model object independently of Worker
execution evidence. The Server must recompute that object's digest and bind it to the stored
attempt invocation; a caller-supplied pair of raw/enriched digests cannot prove a transformation.
Existing V1 results must not acquire verified identity or scores retroactively. Real Windows
application and deployment acceptance remain open, and real repository writes require explicit
approval of the exact target, operation and content.
