# Synthetic Windows investigation lifecycle acceptance

This opt-in harness starts the actual prebuilt `apps/server/dist/main.js` and
`apps/worker/dist/worker.mjs` entry points. It runs only on the authorized remote Windows worker.
The Server also runs on Windows for this isolated exercise; this does not establish Linux
production deployment acceptance.

The native `synthetic-cli.go` fixture implements the bounded Codex JSONL/final-result interface.
It makes no model calls and imports no networking packages. Every result is synthetic reporter
analysis. During cancellation and shutdown cases, it creates a nested native child, allowing
the production ProcessHost to demonstrate owned process-tree termination. Neither executable
claims to be the real Codex CLI.

## Required prepared tools

- Node.js 24.20.x and the workspace's installed dependencies.
- Built shared packages, Server, Worker, and Dashboard from the exact accepted source snapshot.
- A native Windows `AgenticReview.ProcessHost.exe` and a complete Git installation under one
  canonical trusted tools directory, separate from mutable acceptance data.
- Go to compile the small offline CLI fixture. No extra Go modules are needed.
- Windows PowerShell and permission to inspect the fixture's native process creation times.

Perform preparation and execution on the authorized Windows worker. Example commands, using
paths appropriate to that machine:

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:GOTOOLCHAIN = 'local'
$env:GOPROXY = 'off'
go build -trimpath -o 'D:\AcceptanceTools\synthetic-investigation-cli.exe' '.\deploy\investigation-acceptance\synthetic-cli.go'
node '.\deploy\investigation-acceptance\run.mjs' --repo-root 'D:\Source\PowerToys-Agentic-Review' --tools-root 'D:\AcceptanceTools' --process-host 'D:\AcceptanceTools\AgenticReview.ProcessHost.exe' --git 'D:\AcceptanceTools\git\cmd\git.exe' --source-revision '2d0c36e' --output 'D:\AcceptanceRuns\synthetic-lifecycle-unique-run'
```

Build ProcessHost separately using the native project's documented build command. The tools and
all required package build outputs must already exist. `--synthetic-cli` can select another
prepared fixture executable. The output parent must exist and the output directory must be new.
The harness records binary and source hashes, never overwrites previous evidence, and performs
no recursive deletion.

Archive deployments without `.git` require `--source-revision`. This is recorded only as a
`declaredBaseRevision`, not as a claim that the archive exactly equals that commit. Both archives
and checkouts produce `source-manifest.json`: sorted product source/configuration/documentation
paths, byte lengths, and hashes identify the actual transferred snapshot, including current
changes. `runtime-manifest.json` separately hashes every file in all six package/application
`dist` trees, including Server implementation modules and shared package output. Installed
third-party `node_modules` files are outside that manifest; preserve the frozen-install/build
receipt alongside the hashed lockfile to establish deployment provenance. A checkout additionally
records its resolved HEAD; the source manifest remains the actual snapshot identity.

## Scenarios and scope

1. Bootstrap an isolated password administrator, grant only repository/task permissions through
   real HTTP account APIs, then authenticate again after session revocation.
2. Run two consecutive `issue-investigate` snapshot-only tasks on one production Worker process.
3. Hold a synthetic CLI after the first accepted checkpoint, request cancellation through the
   normal task API, and verify the partial report and owned nested-process cleanup.
4. Hold another task, gracefully stop Worker and Server, restart both, preserve the exact durable
   checkpoint, and resume into a new attempt without rewriting the historical partial report.
5. Verify complete export and pagination of 137 findings and more than 2 MiB of report data,
   reporter-evidence reference integrity, recheck counts, retained partial findings, empty owned
   attempt directories, native process identity closure, all five static resource leases released,
   and zero persisted action intents. The queued tasks and held running tasks are observed through
   the native HTTP API.

Complete Issue inputs are seeded only into a fresh synthetic SQLite database before Server
startup. No GitHub credentials are passed. External writes are false, the Worker repository
checkout allowlist is empty, and the account has no source execution or action capability.
The harness never calls upstream import or action-intent endpoints.

Windows Node child-process termination does not deliver POSIX signals. `ipc-signals.mjs` uses
the private parent IPC channel to invoke the entry points' existing SIGTERM handlers. This tests
application shutdown behavior, not SCM restart policies, console signal delivery, abrupt process
crashes, or orphan-directory recovery after a hard kill. The receipt also excludes real models,
Git source operations, runtime artifact upload, UI execution, and deployment capacity benchmarks.
Synthetic reporter statements must never be described as captured command or screenshot evidence.

Failures leave their receipt, logs, databases, and report data for diagnosis. Normal cleanup targets
only child handles created by the harness and owned attempt directories cleaned by the production
Worker. The harness never terminates processes by executable name or deletes shared data.

## Optional short capacity observation

`--capacity-policy` enables a separate 60-second observation, sampled every six seconds, around
the first two successful synthetic tasks. All shared packages and application outputs remain
prebuilt. The existing Go fixture still speaks the current `InvestigationModelTurnDeltaV1`
protocol; no PowerToys build, real model, or extra application process is introduced.

Create a JSON file outside the checkout containing explicit thresholds for this small workload.
The following policy is suitable only as a declared short acceptance target, not a production
capacity claim:

```json
{
  "minimumDurationSeconds": 60,
  "minimumCompletedTasks": 2,
  "minimumCompletionsPerHour": 30,
  "maximumFailedTasks": 0,
  "maximumBlockedTasks": 0,
  "maximumCancelledTasks": 0,
  "minimumAvailableBytes": "2147483648",
  "maximumDatabaseGrowthBytes": "268435456",
  "maximumWalBytes": "134217728"
}
```

Add the policy argument to the normal prebuilt harness command:

```powershell
node '.\deploy\investigation-acceptance\run.mjs' --repo-root 'D:\Source\PowerToys-Agentic-Review' --tools-root 'D:\AcceptanceTools' --process-host 'D:\AcceptanceTools\AgenticReview.ProcessHost.exe' --git 'D:\AcceptanceTools\git\cmd\git.exe' --source-revision '2d0c36e' --capacity-policy 'D:\AcceptanceInputs\synthetic-capacity-policy.json' --output 'D:\AcceptanceRuns\synthetic-lifecycle-capacity-unique-run'
```

The harness authenticates an independent observer session and waits for its actual baseline while
both tasks are queued and the Worker has not started. It then starts the one Worker, checks both
complete reports, and waits for the capacity receipt before cancellation or restart scenarios.
This keeps deliberately cancelled/interrupted tasks and the deliberate Server restart outside
the capacity window. Cached samples cannot extend the window; the shared collector permits at
most its bounded two-minute grace for a final independent sample. A failed baseline prevents
Worker startup. Harness failure aborts pending sampling, waits for observer logout, and retains
the failed receipt before stopping the isolated Server.

`capacity-workload.json` binds the two task identities, source/runtime manifests, synthetic scope,
and thresholds. `capacity-receipt.json` contains the real operations snapshots, its independent
run ID, workload-manifest digest, evaluation, and logout result. Generated credentials remain only
in the harness process environment and memory; the observation does not publish them in receipts.
The static tasks do not use the separate E2E desktop cleanup journal, so their cleanup evidence is
owned process/workspace closure plus each native resource lease's recorded release.

This observation checks the current synthetic flow and storage thresholds for two completions.
It does not satisfy sustained production throughput, retention expiry, physical disk reclamation,
UI readiness, or a real deployment's operational acceptance.

## Real CLI companion

`run-real-cli.mjs` performs one real `issue-investigate` model workflow against an already frozen
public Issue. It starts the same production Server and Worker entries, with a separate fresh
database and built-in password administrator. GitHub credentials, external writes, action
capabilities, and repository execution remain unavailable. Model provider network traffic belongs
to the user's installed CLI. This companion checks execution, contracts, export, pagination, and
cleanup; it does not score model quality or independently verify remote model identity.

First obtain read-only raw GitHub API captures outside this script: a public repository response,
one non-PR Issue response, and all Issue comment pages flattened into an array. Preserve each raw
JSON file. `prepare-public-issue.mjs` performs an offline conversion and checks repository/Issue
identity, URL, public visibility, comment count, and duplicate comment IDs. It records raw byte
hashes and uses the built domain content-digest function. If the captured comment count changed,
recapture instead of truncating. A null Markdown body becomes an empty string; other text and
comment order remain intact.

```powershell
node '.\deploy\investigation-acceptance\prepare-public-issue.mjs' --repo-root 'D:\Source\PowerToys-Agentic-Review' --repository-json 'D:\AcceptanceInputs\repository.json' --issue-json 'D:\AcceptanceInputs\issue.json' --comments-json 'D:\AcceptanceInputs\comments.json' --captured-at '2026-09-16T08:00:00.000Z' --output 'D:\AcceptanceInputs\frozen-issue.json'
```

Use the actual capture timestamp. The output is a `FrozenPublicIssueAcceptanceV1` object containing
`capture`, `repository`, `workItem`, and the complete `InvestigationInputSnapshotV1`. The converter
never fetches upstream data or invents GitHub numeric identities.

Configure the real CLI login under its dedicated Windows account before running this companion.
Supply a JSON file containing only the documented non-secret environment values, for example:

```json
{
  "USERPROFILE": "C:\\Users\\worker",
  "CODEX_HOME": "C:\\Users\\worker\\.codex"
}
```

For Copilot, use `COPILOT_HOME` and `--cli-engine copilot`. Add `APPDATA`/`LOCALAPPDATA` only when
required by the configured CLI. The script reads this explicit path configuration, never the
CLI's authentication or provider files, and does not copy login storage. The operator must first
verify the CLI's static configuration, disabled hooks, and unmanaged-tool policy for the installed
version. `--static-config-verified true` records that preparation; it is not a bypass or an
independent policy attestation. If applicable, `--disabled-mcp-servers` points to a JSON array of
server names to disable. No model runs unless this preparation flag is explicitly supplied.

Launch the companion as the intended Windows account. Environment paths do not impersonate that
account: Node, Worker, ProcessHost, and the CLI inherit the actual launcher token. A Guest Agent
service launch may therefore run as SYSTEM. The receipt records `whoami /user`; it must not be
described as dedicated-account acceptance if the observed execution account differs.

```powershell
node '.\deploy\investigation-acceptance\run-real-cli.mjs' --repo-root 'D:\Source\PowerToys-Agentic-Review' --tools-root 'D:\AcceptanceTools' --process-host 'D:\AcceptanceTools\AgenticReview.ProcessHost.exe' --git 'D:\AcceptanceTools\git\cmd\git.exe' --cli 'D:\AcceptanceTools\codex.exe' --cli-engine codex --model-environment 'D:\AcceptanceInputs\cli-environment.json' --worker-path 'C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0' --static-config-verified true --fixture 'D:\AcceptanceInputs\frozen-issue.json' --source-revision '2d0c36e' --output 'D:\AcceptanceRuns\real-cli-unique-run'
```

`--cli-model` optionally pins the configured model argument. Defaults are 16 rounds, ten minutes,
200,000 reported tokens, and 32 MiB retained report data. Bounded overrides are `--max-rounds`,
`--max-duration-ms`, and `--max-tokens`. A failed, blocked, interrupted, or incomplete actual run
remains failed acceptance with its original report and logs; the harness does not rewrite the
outcome, retry models automatically, or substitute synthetic data.

The default coverage requirement is one accepted analysis round: a valid complete product
result may finish in one round. `--max-rounds` accepts 1 through 64. Use
`--min-accepted-rounds 2` only when this run explicitly requires multiple accepted rounds;
the minimum defaults to 1 and must not exceed `--max-rounds`. Invalid combinations are
rejected before any process or model starts. The receipt and summary record `productResult`
separately from `roundCoverage`. Unmet explicit coverage remains failed acceptance with
`ROUND_COVERAGE_NOT_OBSERVED`, even when the product completed correctly. A round count
does not independently prove specific discovery/finalization phases. No additional model
call is forced, and existing historical failed receipts remain unchanged.

The pure assessment checks require no Server, Worker, or model. Run them on the designated
verification environment with `node --test deploy/investigation-acceptance/real-cli-assessment.test.mjs`.

`--codex-transport exec|app-server` selects the Codex transport and defaults to `exec`.
`app-server` requires the Codex engine and an explicit `--cli-model`; invalid transport
combinations are rejected before setup. The selected transport is recorded as
`cli.configuredTransport` and passed to the Worker. Use `app-server` when the run requires
live response-boundary usage control.

`--scope-json <absolute path>` optionally supplies a complete `InvestigationCoverage`
object for the new Task. The harness validates its shared schema, retains `task-scope.json`
and the input path/raw SHA-256/canonical digest, and forwards it to the normal Task API.
The API still requires pending units bound to the frozen Issue subject, including a complete
`issue_snapshot` unit. This option does not modify the frozen fixture or model output.
Without it, the Server's existing default scope remains in use. A requested multi-stage
analysis does not guarantee multiple accepted rounds; the coverage requirement still records
the actual result without an automatic retry.

`--worker-path` optionally supplies the entire trusted executable search path through
`INVESTIGATION_WORKER_PATH`. Omit it to retain the runtime's existing default; the companion does
not replace that default with the launcher's full PATH. A CLI-owned external authentication
helper invoked as `powershell` needs the standard WindowsPowerShell directory in that explicit
path, for example `C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0` as above.
Use the actual Windows installation directory. This deployment setting leaves provider/authentication
files, task authorization, and model tool restrictions unchanged, and its explicit value is recorded
in the receipt.

## Native publication companion

**Historical acceptance material, 2026-09-16: the completed run's single-use authorization is
consumed.** `run-publication.mjs`, `publication-approval.json`, and `publication-approval.md` are
retained at their original paths to document that fixed run. They are not reusable deployment
configuration or an unspent approval. The original JSON bytes, including the historical
`draft_pending_user_approval` status, remain unchanged; the
[approval and execution record](./publication-approval.md) records the subsequent approval and result.

The companion is fixed to the exact run ID, targets, and payloads in `publication-approval.json`:
two conversation-comment POST attempts to `moooyo/PowerToys` PR #3 and Issue #5. It never calls an
upstream POST directly. The actual `apps/server/dist/main.js` imported complete snapshots through
its read-only import API, prepared native `ActionIntent` records, and owned authorized GitHub
transport execution.

Any future publication acceptance requires new explicit user approval of its exact targets,
operations, content, and execution scope after preparation of a new reviewable draft. Preserve
these historical files and their consumed approval; do not repurpose the original draft, copy an
approval receipt, or treat the examples below as authority to rerun the fixed harness. The following
details describe the completed run's procedure and receipt format.

The default mode starts the isolated Server with `externalWrites=false`, registers the repository,
imports complete source snapshots through read-only upstream requests, checks current targets,
and saves exact local payload materials. Current production guards also block external native
intent preparation while that gate is false. The receipt therefore reports
`local_materials_prepared_native_intent_blocked`; it does not claim that a native intent exists.
Those internal preparation operations were within that task's development/test authorization.
Their description does not authorize future external mutations.

A matching user approval receipt permits the Server gate to become true. Without `--execute true`,
that phase only creates native prepared intents and reports `native_prepared_no_external_writes`.
The preparation account has only `repository:manage`, `action:prepare`, the exact repository ID,
and the `comment` capability. It has no `action:execute`, task creation, or source execution grant.
No Worker or model is launched. Product guards and defaults remain unchanged.

The run used a protected output directory outside source, plus a separate protected GitHub token
file. The program passed that file path to the Server. Its independent read-only preflight read
the same token into process memory solely for GitHub GET requests; it never printed the token,
copied it into output, or read CLI authentication/provider files. Local bootstrap account secrets
stayed in the protected output directory so the same prepared database and actor could be continued.

Historical invocation shape, retained for interpreting the receipts:

```powershell
node '.\deploy\investigation-acceptance\run-publication.mjs' --repo-root 'D:\Source\PowerToys-Agentic-Review' --draft 'D:\Source\PowerToys-Agentic-Review\deploy\investigation-acceptance\publication-approval.json' --github-token-path 'D:\Secrets\publication-token.txt' --output 'D:\AcceptanceRuns\publication-single-run'
```

External execution required both `--execute true` and `--approval-receipt <absolute path>` against
the same prepared output directory. The approval receipt was created only after the user explicitly
approved the exact draft, marker rule, two-target single-run budget, and incidental comment-event
effects. The following structure documents that historical receipt; placeholders are not approval:

```json
{
  "schemaVersion": "InvestigationPublicationUserApprovalV1",
  "status": "approved",
  "approvedDraftSha256": "<SHA-256 of the exact reviewed publication-approval.json bytes>",
  "runId": "investigation-publication-20260916-v1",
  "approvedBy": "user",
  "authorizationSource": "explicit-current-task-user-message",
  "userApprovalText": "<the actual explicit user approval>",
  "approvedAt": "<actual ISO timestamp>",
  "includesNativeMarkerRule": true,
  "includesIncidentalAutomationEffects": true,
  "maximumRuns": 1,
  "maximumPostAttemptsPerTarget": 1,
  "operationIds": [
    "investigation-publication-20260916-v1-pr3-comment",
    "investigation-publication-20260916-v1-issue5-comment"
  ]
}
```

After validation, execution created an exclusive `<runId>.consumed.json` receipt beside the
approval file. Preserve that consumption record with the original approval. Copying approval to
bypass consumption is outside the approved scope. The run state separately reserves each
confirmation before sending it and refuses a second confirmation for that intent. A failed or
unresolved attempt also consumes the run. The companion never creates a replacement intent,
retries a GitHub POST, or deletes a comment.

Before each confirmation, GET requests recheck publisher/repository IDs, target state/title and
recorded revisions, complete conversation comments, the absence of the run/native marker, default
branch identity, and the inspected automation configuration. Native context and transport guards
also recheck current authority and source identity. The exact native ID, payload digest, generated
marker, and expanded request body are saved before confirmation.

Only an `unknown` or `executing` result uses the native reconcile API, whose upstream operations
are GET-only. A failure or unresolved result stops the remaining target. Successful delivery is
checked through full comment pagination and an exact comment GET: body, native marker, author,
target, and the single new comment must all match. Terminal `succeeded` is not described as a new
remote reconciliation exercise.

There is no proxy or test injection into the production Server. The receipt therefore separates
the observed native confirmation count, the transport-derived maximum POST-attempt count, and
the independently observed new-comment count. It does not claim a directly measured network POST
count. Preserve the native transport binary/source identity and build evidence with the receipt.
No repository setting, workflow, branch, review, label, merge, or comment cleanup is authorized.

## Resume an existing real CLI task

`resume-real-cli.mjs` resumes the exact incomplete task in a prior `run-real-cli.mjs` database.
It neither copies the database nor creates a replacement task. Wait for the original run to stop
under its budget and finish its receipt. Confirm both old Server and Worker are stopped before
recovering credentials. The companion refuses queued/running tasks, other active tasks, uncleared
attempt directories, and prior receipts without successful owned-process closure. It never calls
the cancellation API.

The original harness used a random application password without retaining it. As the trusted
operating-system account, prepare a new protected UTF-8 password file and run the native offline
administrator recovery tool against the original account database. The recovery tool preserves
the existing account ID and permissions and revokes prior sessions. Record its successful JSON
output outside the old proof directory. Do not put the password on the command line.

```powershell
$resetJson = & node 'D:\Source\PowerToys-Agentic-Review\apps\server\dist\investigation\password-admin-main.js' --database 'D:\AcceptanceRuns\real-cli-run5\accounts.sqlite' --username acceptance-admin --password-path 'D:\Secrets\resume-admin-password.txt'
if ($LASTEXITCODE -ne 0) { throw 'Native administrator recovery failed.' }
[System.IO.File]::WriteAllText('D:\AcceptanceInputs\resume-admin-reset.json', ($resetJson -join [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
```

The example preserves the native JSON as UTF-8 without a byte-order mark, including on Windows
PowerShell 5.1. The companion reads the reset JSON as a receipt, not as a
command to execute, and never performs the password reset itself.

```powershell
node '.\deploy\investigation-acceptance\resume-real-cli.mjs' --repo-root 'D:\Source\PowerToys-Agentic-Review' --tools-root 'D:\AcceptanceTools' --previous-run 'D:\AcceptanceRuns\real-cli-run5' --task-id '<existing-task-id>' --output 'D:\AcceptanceRuns\real-cli-resume-proof' --admin-password-path 'D:\Secrets\resume-admin-password.txt' --admin-reset-receipt 'D:\AcceptanceInputs\resume-admin-reset.json' --model-environment 'D:\AcceptanceInputs\cli-environment.json' --process-host 'D:\AcceptanceTools\AgenticReview.ProcessHost.exe' --git 'D:\AcceptanceTools\git\cmd\git.exe' --cli 'D:\AcceptanceTools\codex.exe' --source-revision '2d0c36e' --previous-processes-stopped true --static-config-verified true
```

The explicit CLI environment file and executable hash must match the prior receipt. Engine,
configured model, disabled MCP servers, and `--worker-path` default to the retained configuration;
an explicit replacement value must be identical. The existing `acceptance-admin` is authenticated
through real HTTP and gains task create/cancel permissions without changing its ID. The Server uses
the original `investigation.sqlite` and `accounts.sqlite`, a new in-memory Worker credential with
the original Worker ID and exact repository scope, and `externalWrites=false` with no GitHub token.

For incomplete analysis, default cumulative budget limits are 12 rounds and 3,600,000 ms, with at least 250,000 tokens and
the prior token budget; the default also leaves 50,000 tokens beyond already consumed tokens.
`--max-rounds`, `--max-duration-ms`, and `--max-tokens` are bounded overrides. Every budget field
must remain nondecreasing, and analysis continuation must have actual remaining work capacity. Source, scope,
profile, prompt references, findings, plans, and runtime evidence cannot be rewritten to make a
resume pass. The report-byte budget remains unchanged.

If the accepted checkpoint already has `stopReason:"complete"`, recovery defaults to delivery only
and retains the existing budget. Native `/resume` restores a new delivery attempt without running
another model round. This branch has an independent 120-second delivery deadline and does not
require unused model budget. Explicit budget overrides remain nondecreasing, but do not authorize
model execution from the completed checkpoint. The receipt requires unchanged analysis/runtime,
complete stop reason, model rounds, and token consumption, with `realModel:false` and the check
`complete-checkpoint-delivered-without-model-rerun-or-analysis-change`.

A prior failed finalization may leave a valid checkpoint without any sealed report. In that case,
the database must have zero task reports and `latestReportRef:null`; a missing original `report.json`
is valid and remains absent. When sealed reports exist, their latest ID/version/digest must match
the task reference. Any existing old export must match that sealed report and remain byte-identical.
The helper never fabricates a historical report to satisfy these checks.

Before starting the new Worker, the proof records the exact original checkpoint and verifies that
native `/resume` preserves its complete analysis/runtime and all frozen task fields apart from
budget/state timestamps. After execution it verifies the original finding history and plan IDs, every
existing historical report's byte hash, the prior receipt and any existing export, one new attempt under the same Worker
ID, unchanged frozen input, complete report validity, and owned-process/workspace cleanup. New logs
and receipts go only into the new proof directory; original evidence files are not overwritten.
An original finding must remain in the final set or retain all of its original candidate identities
with an explicit, evidenced withdrawal/merge disposition. The preserved pre-resume checkpoint and
any existing old report retain the original finding content. A delivery-only attempt preserves the
entire original analysis exactly. Silent removal is a failed acceptance condition.
