# Windows model execution lifecycle

Status: `proposed_not_accepted`.

This draft defines the remaining lifecycle and evidence contracts for an accepted Windows Evaluation execution boundary. It does not implement or enable that boundary. No production gate, capability, setup operation, account, firewall rule, registry value, model session, or test is changed by this document. Proposed type and operation names below are project design names, not existing Codex APIs.

## Current facts and scope

The parent-owned relay, review and summary invocation factories, fresh attempt directories, bounded app-server transport, output collection, and invocation receipt plumbing already exist. They should be extended through their existing ownership paths. They are not evidence that the OS confined execution. See [startup composition](./2026-09-08-evaluation-model-startup.md), [runtime composition](../../apps/worker/src/execution/evaluation-model-runtime.ts#L59), and [attempt home selection](../../apps/worker/src/execution/prepared-codex-output-runner.ts#L465).

The current [profile executor](../../apps/worker/src/execution/profile-job-executor.ts#L158) rejects Evaluation before workspace preparation, and the [review executor](../../apps/worker/src/execution/review-executor.ts#L125) independently rejects Evaluation model execution. [Runtime capabilities](../../apps/worker/src/execution/runtime-capabilities.ts#L28) do not advertise Evaluation. [Session observations](../../apps/worker/src/execution/codex-app-server-session-policy.ts#L766) and [invocation settlement](../../apps/worker/src/execution/model-invocation-coordinator.ts#L401) retain `executionAccepted: false`. These restrictions remain unchanged.

The [official Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox) describes the elevated implementation as dedicated low-privilege accounts with ACL, firewall, and local-policy enforcement. The unelevated implementation uses a restricted token of the current user and weaker environment-level networking restrictions. This proposal does not treat the latter as an accepted fallback for Evaluation.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) documents `windowsSandbox/setupStart` with `{ "mode": "elevated" }`, an initial `started` response, and a later `windowsSandbox/setupCompleted` notification carrying mode, success, and error. The documented setup surface does not establish an API for selecting a caller-owned SID, exporting credentials, transferring sandbox identity between `CODEX_HOME` directories, or creating an isolated identity lease for one attempt. Those capabilities must be confirmed before an adapter relies on them. Setup completion and `windowsSandbox/readiness` are diagnostic inputs, not execution acceptance. The production [transport allowlist](../../apps/worker/src/execution/codex-app-server-transport.ts#L11) deliberately has no setup method.

The recorded fresh-home preflight returned `updateRequired`; this remains unresolved. There is also concrete local evidence that environment replacement is not identity isolation. In the M34 build observation, replacing `USERPROFILE`, `APPDATA`, and `LOCALAPPDATA` changed .NET ApplicationData to the proposed home's `AppData/Roaming`, left LocalApplicationData empty, and left UserProfile at the existing operating-system user profile. Creating the expected AppData directories allowed the subsequent MSBuild attempt to run. See [environment observation](../../artifacts/m34-windows-acceptance-20260909/build-environment-observation.json) and [second build preflight](../../artifacts/m34-windows-acceptance-20260909/build-preflight-result-v2.json). That result establishes a build-environment correction, not a new SID or an execution boundary.

The boundary must cover both Profile commands and model-controlled subprocesses, as required by the [Evaluation design](./2026-09-08-prompt-profile-evaluations.md#L119). Current [Profile commands](../../apps/worker/src/execution/validation-check-runner.ts#L590) use an ordinary [launch specification](../../apps/worker/src/execution/validation-check-runner.ts#L767). The [native protocol](../../native/process-host/internal/protocol/types.go#L34) carries no security-principal lease, and the [launcher](../../native/process-host/internal/host/process_windows.go#L154) uses `CreateProcessW`. Its optional process identity is PID plus [creation FILETIME](../../native/process-host/internal/host/process_windows.go#L189), not a Windows security identity.

## Installation ownership and execution ownership

Separate three owners:

1. A deployment administrator owns the approved host installation, immutable tool root, any privileged setup, and the accepted boundary policy version. Installation is an explicit deployment action and is never triggered by a claimed repository task.
2. A privileged execution service owns attempt identity allocation, credential material, ACL and network enforcement, process handles, revocation, and recovery. Its signing key and journal must be inaccessible to the Worker task principal, model, and repository commands. It authenticates the trusted Worker service identity and an independently issued Server challenge. The exact service transport and deployment mechanism remain to be implemented and accepted.
3. The Worker owns the existing lease, source preparation, parent relay, invocation protocol, result collection, and terminal submission. Executable task content does not receive the Worker's Server credential, upstream provider credentials, the execution service's authority key, or authority to provision identities.

An installation record may describe supported modes and reviewed policy measurements. It never authorizes an individual attempt. Reusing an installation must not mean reusing a model home, writable user profile, bearer, credential blob, or unrevoked access to another attempt.

The trusted service may use multiple low-privilege principals for Profile commands and Codex-managed tools if required by the actual supported implementation. They must share the same accepted boundary policy and be enumerated in the attempt lease. A promise that only one of those process families is confined is insufficient. The entire application/controller process that handles untrusted model or repository data also needs an explicit access policy; confining shell tools alone does not settle that question.

This design trusts the approved host administrator and the privileged execution service. A signed software report is not hardware-backed remote attestation and does not prove safety against a compromised kernel or administrator. Deployment acceptance must state that limit. If the required threat model cannot trust those components, a separate infrastructure authority and isolation architecture are required.

## Compatibility choices that must be resolved

The preferred native integration requires a documented, supportable way to associate an attempt's fresh model home with an elevated sandbox lifecycle while keeping credentials private and revocable. Before implementing that adapter, establish:

- What installation and credential state setup creates, who owns it, and whether it is bound to a user, machine, home, or a combination.
- Whether an authorized broker can select or safely obtain the identity used by model subprocesses, observe the actual token and policy, and revoke its access without reading or copying existing password files.
- Whether setup can target a newly allocated attempt home without loading an existing provider configuration or exposing setup credentials to task commands.
- How concurrent homes interact, which identities or rules are shared, and what supported cleanup and upgrade operations exist.
- How the equivalent Profile-command principal is created and launched, and how both process families are included in the same cancellation, network, and filesystem policy.

No undocumented parameters will be added to `windowsSandbox/setupStart` to pretend these operations exist. Copying existing sandbox password blobs, transferring a live home, or making the entire Worker model home accessible to tasks is forbidden. Changing an environment variable is not an identity transition.

If native per-attempt homes cannot be made compatible with the supported setup lifecycle, a concrete alternative is a dedicated, recoverable Windows VM generation for one attempt, followed by destruction or reset before reuse. The base image would contain approved OS/tool prerequisites, not copied per-attempt sandbox credentials. Any required setup would run through an explicitly approved provisioning path inside that new generation and target its new home. The same generation would contain both the Profile-command and model execution policy; trusted controller credentials would remain protected from those principals. A VM does not by itself separate a high-privilege Worker from low-privilege task processes inside the guest.

That alternative requires a real execution-service/guest adapter, authenticated control transport, ownership and reset receipts, and a supported integration with the existing Worker runtime measurements. None is presently claimed to exist. Hypervisor availability, image licensing/provisioning, reset behavior, and the fresh-home setup compatibility are external acceptance prerequisites. Selecting this option does not authorize installing or configuring virtualization now.

## Proposed attempt lease and durable state

`WindowsAttemptExecutionLeaseV1` is a non-secret descriptor issued by the privileged execution service. It contains opaque credential lease references, never passwords, serialized tokens, or password-file paths. The service keeps secret material in its protected native/OS store and exposes only operations scoped to this descriptor.

| Field group | Required binding |
| --- | --- |
| Authority | Registered execution authority ID and key ID; host installation ID; authority generation; policy schema/version/digest |
| Boundary | Boundary instance ID and generation; native or VM adapter kind; OS build/architecture; approved deployment acceptance record digest |
| Ownership | Worker node ID, Worker instance ID, service process identity, repository ID, job ID, run attempt ID, lease generation, lease expiry, and a fresh Server challenge |
| Source | Evaluation/cell/arm identity where applicable; authorization ID/digest; plan and execution-manifest digests; source manifest/revision digest; selected commit; Profile and Prompt identities and digests |
| Principals | Non-secret SID plus boundary generation for each task principal; allowed role; opaque credential lease ID; immutable checkout/control/temp/profile/home root policy digests |
| Runtime | Worker bundle, Node, ProcessHost, Codex, and execution-adapter measurements; launch-policy and relay-policy digests; supported invocation scope version |
| Journal | Unique lease ID, monotonically increasing state sequence, issued/expiry times, and previous-record digest |

A SID alone is not a globally unique attempt identity. It is interpreted with the authority, boundary instance, generation, and lease. A process is bound using an owned native handle and its creation identity; a caller-provided PID is insufficient.

The initial state machine is:

`reserved -> provisioning -> prepared -> active -> revoking -> execution_closed -> retention_cleanup -> released`

An error after acquiring an OS resource transitions to `quarantined` until independent reconciliation proves its state. A reservation that acquired no resource can close with a recorded failure. State transitions are append-only and use compare-and-swap over lease ID, generation, owner, and sequence. Durable intent is recorded before each side effect, followed by its observed outcome. A crash between the two is an unresolved operation, not a successful cleanup.

The broker verifies current Server ownership before activation and each new process launch. Lease renewal cannot change source, identity, roots, runtime, or policy. A new Worker instance or lease generation cannot adopt an active execution lease. Stale callbacks may complete resource revocation but cannot publish an accepted result or reactivate the lease. Duplicate close requests are idempotent for the same intent; a different intent cannot replay the prior response as success.

## Launch, cancellation, and recovery

Before task execution, the service observes the actual principal/token, canonical root identities, effective access policy, network enforcement, and approved runtime deployment. It does not sign expected caller input as if it were an observation. Task launch accepts an opaque lease reference and role through a new versioned native adapter, not arbitrary username/password fields in `ProcessLaunchSpec`. Registered executable resolution, Job Object ownership, output bounds, and the existing timeout/cancellation paths remain required.

Profile setup/build/test/launch/cleanup commands and model processes must all pass through the accepted adapter. The Profile's cleanup phase is still task code and receives no administrative cleanup rights. Trusted Git/source preparation and result/evidence retention are explicitly parent-owned operations with their own bounded access; their credentials are not inherited by task children. Network rules must prevent upstream mutations and access to control/provider credentials while allowing only the frozen command-network policy and the scoped parent relay. Actual negative network tests are required; environment proxy settings are not enforcement evidence.

On cancellation, expiry, lost ownership, or fatal supervision failure:

1. Fence new launches and relay/provider authorization immediately.
2. Terminate and drain every owned process family, including application descendants and Codex-created children; verify membership and an empty tree through trusted handles/OS observations.
3. Revoke task access to retained control/output/evidence files and revoke every credential/network capability associated with the execution lease.
4. Record `execution_closed` only after those facts are confirmed. Preserve any bounded failure evidence without promoting stale model output to success.
5. After terminal submission reaches a known outcome, perform the existing deferred workspace cleanup and the service-owned identity cleanup. Confirm the principal/credential policy required by the selected adapter, remaining handles, directory ownership, and any VM reset/destruction before `released`.

Execution closure and retention cleanup are deliberately distinct. The current Worker retains workspaces through terminal reporting. Server completion may consume a verified execution-closure record while parent-only evidence remains available; it must not depend on deleting that evidence first. A later retention-cleanup failure quarantines the boundary and drains further admission without rewriting an immutable accepted execution result. The ordinary Profile `cleanupState` is not a claim that OS identity cleanup or VM destruction completed.

On restart, the execution service reconciles every non-released journal entry against actual process handles/creation identities, principals, credential leases, policy state, roots, and boundary generation. It contacts the Server for current ownership, closes unresolved activity, and records the outcome before advertising reusable capacity. Missing records, uncertain process membership, access-revocation failure, unknown principals, or failed reset cause quarantine. A new Worker must not repair uncertainty by re-running a model or copying another home. Existing [invocation ownership rules](../../apps/worker/src/execution/model-invocation-coordinator.ts#L168) already require restart fencing to belong to the attempt lifecycle.

## Independent evidence and Server consumption

The proposed evidence has four separate sources:

| Fact | Trusted source and limit |
| --- | --- |
| Frozen source, authority, job, and current lease | Server-owned plan, authorization, and lease records; authenticated challenges are generated by the Server |
| Installation qualification | Deployment authority's reviewed acceptance record, bound to actual OS/adapter/tool/policy measurements and negative-test artifact digests; this does not prove a later attempt was confined |
| Actual attempt isolation and closure | Privileged execution service's direct OS/control-plane observations, signed with its separately registered protected key; Worker and task credentials cannot produce this signature |
| Requested/observed model, request/response and collected output | Existing parent invocation, relay, provider-observation and immutable receipt chain; this does not prove filesystem or network confinement |

Use proposed `WindowsAttemptPreparedEvidenceV1` and `WindowsAttemptClosedEvidenceV1` records. A prepared record binds the complete lease descriptor to a fresh Server challenge and the observed enforcement facts. A closed record binds the same descriptor, all launch identities and role assignments, actual closure/revocation facts, the proposed result digest, and the relevant invocation opening/seal/submission identities and digests. Required summaries also bind the original Prompt and frozen composed-input/ScopeV2 receipt. Sensitive upstream headers and credentials are excluded from all evidence.

An invocation can be attached only to an already prepared active execution lease. The service records that attachment before the model turn and binds its process family and relay policy to the opening. This avoids accepting a valid isolation record from one process together with model receipts from another. Profile-only executions still require their own prepared/closed records; they cannot inherit proof from a model invocation that did not run.

The Server registers eligible authority keys through deployment administration, independently of normal Worker registration. It verifies canonical signed bytes, schema and algorithm, key eligibility/revocation, authority and boundary generation, one-use challenge, expiry, state sequence, and exact equality with its current ownership and frozen plan records. It independently validates the existing model invocation receipts and their actual output binding. An expired installation qualification, changed tool/policy, missing closure fact, wrong source, wrong invocation, different attempt, old lease generation, unknown key, or stale Worker instance cannot create the internal acceptance brand. A signature authenticates its issuer; the Server still checks every semantic binding.

Successful consumption is transactional with terminal fencing and the accepted result. Exact lost-response replay may return the same receipt after current permission/ownership checks; a modified payload or new attempt cannot reuse it. Historical result JSON, digests, and legacy receipt meanings remain unchanged. A new versioned evidence reference and persistence path will need explicit contracts and migration work rather than silently assigning stronger meaning to existing V1/V2 fields.

The [current Server reader](../../apps/server/src/database/validation-results.ts#L258) explicitly provides collection consistency only, and [required-model completion](../../apps/server/src/database/validation-results.ts#L593) remains rejected. Later replacement of those unconditional rejection points requires all of the following together: an approved adapter/deployment qualification, verified per-attempt prepared evidence, exact runtime and invocation bindings, verified execution closure, and current Server fencing. Worker execution guards may only become checks for a trusted prepared lease through the accepted adapter. Evaluation capability may only be published when that adapter can allocate such leases and its qualification is current. Neither operator payloads, model output, Profile fields, `ready`, setup success, runtime registration, nor a manually configured Boolean can grant these capabilities.

## Smallest useful implementation slices

1. **Pure contracts and validators:** introduce the proposed descriptor/evidence schemas, canonical digest rules, principal-role/root bindings, current-lease matching, and typed rejection reasons. Specify independent key registration and challenge ownership. Keep the production adapter unavailable and all Evaluation gates unchanged.
2. **Pure lifecycle orchestration:** implement an append-only intent/outcome journal, CAS transitions, cancellation/revocation ordering, retention-cleanup distinction, quarantine admission, and restart reconciliation interfaces. An unavailable OS adapter must return a typed failure; simulated state-machine cases are implementation verification, not boundary acceptance.
3. **Dormant integration:** route eligible future launch roles through an explicit execution-lease dependency and extend receipt binding/Server verification behind the unchanged rejection boundary. Preserve ordinary execution behavior and historical bytes. Establish contract cases for forged signatures, replay, changed source/runtime, another attempt, partial closure, and failure after terminal acknowledgement.
4. **Adapter implementation after the compatibility decision:** implement either the supported native identity operations or the authenticated single-attempt VM/guest adapter. This requires actual interface confirmation; do not synthesize Codex identity APIs. Code and deployment packaging can progress separately from permission to install or run them.
5. **Real acceptance before activation:** use the selected authorized Windows environment to verify token/principal ownership, KnownFolder behavior, cross-attempt access denial, parent/control/provider credential denial, forbidden network denial, allowed relay behavior, process-tree cancellation, crash recovery, cleanup/quarantine, and reset/reuse. Then exercise the actual frozen Prompt/provider/model and Server receipt/result path, including both required Evaluation arms. A model-free Issue measurement or a successful application build is not a substitute.

Slices 1-3 can proceed as design and code without running setup or a model. They should not be reported as blocked solely because an acceptance machine is unavailable. Actual sandbox setup, privileged policy changes, real credentials, negative OS enforcement tests, VM provisioning/reset, and model/provider execution require the corresponding approved environment and authorization. The pinned runtime's current `updateRequired` response and the unconfirmed home/identity lifecycle are specific unresolved dependencies, not permission to weaken the boundary.
