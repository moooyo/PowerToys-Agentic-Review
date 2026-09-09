# Same-process Codex turn output

The app-server path keeps configuration observation, thread creation and turn output on one
owned process. It supplements the interactive ProcessHost transport; it does not infer operating
system confinement from requested configuration or from a successfully parsed result.

## Attempt ownership

`JobExecutionContext.attemptSignal` identifies the original Worker attempt across derived contexts.
`signal` still controls the current execution budget. Profile and summary executors preserve the
original owner when creating child cancellation signals. The prepared runner claims the invocation
before its first asynchronous opening and refuses another dispatch for the same owner and attempt.
Recording recovery retries the retained close intent; it never creates another model process.

## Launch and input

`buildCodexAppServerLaunchSpec` starts the pinned app-server through dedicated interactive stdin
and requests process identity capture. It uses a replacement environment, bounded arguments and
disjoint checkout/control directories. The selected named permission profile and approval policy
are fixed after other overrides. Legacy sandbox overrides are rejected because they can supersede
named permissions. The caller still owns fresh-home preparation and actual session-policy checks.

The prompt and output schema travel through `turn/start`. They are not placed in process arguments
or represented as an exec result file. Transport activity includes stdout responses and stderr
bytes, so the existing progress watchdog need not depend on model notifications alone. A failed
activity observer terminates and drains its process without exposing callback error details.

## Output and closure

The output collector binds notifications to the actual thread and turn identities. It buffers
bounded early notifications while the turn-start response is pending. Item lifecycle records are
authoritative: the pinned CLI can emit empty `turn.items` with `itemsView: notLoaded`.

A successful turn must have complete supported item lifecycles and an unambiguous final message.
An explicit final-answer phase is preferred. Providers without phases require exactly one unphased
assistant message with no later item. Final JSON must pass strict parsing, the frozen schema and
protected-value checks. Commands and file-change observations remain evidence, not assertions that
the requested validation succeeded.

The single-turn driver attaches transport consumers synchronously so the parent can retain the
actual process and drain promise before sending any RPC. Turn completion does not settle that
promise. Physical process exit and both streams must be confirmed independently; success also
requires normal transport closure, complete notification delivery and valid final output.

## Integration boundary

The driver does not select a provider, authorize a thread, measure effective launch policy, register
a runtime or enable evaluation execution. The prepared runner now provides an explicit backend
with a separate session-policy observer, and a parent factory binds frozen invocation inputs.
Production startup, actual command/network confinement and deployed Windows application acceptance
remain separate integration work. Controlled synthetic-provider runs establish protocol
compatibility only. They do not establish real model behavior or permit external PR/Issue writes.
See [session policy and parent composition](./2026-09-08-codex-app-server-session-policy.md).

The pinned 0.145.0 CLI rejects `tools.view_image` under strict configuration. The diagnostic
controlled run stopped before initialization with zero provider requests and confirmed closure.
Removing that unsupported field from a synthetic probe does not establish that the tool is
disabled. Actual advertised tools must be recorded; a parent-controlled final-only response is
the probe's boundary. Production policy observation must resolve supported tool controls before
model execution can be accepted.
