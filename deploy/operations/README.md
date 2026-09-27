# Production operations and deferred acceptance

This directory prepares the next deployment. The initial implementation was written while the
designated Windows Worker was unavailable. The subsequent [four-GiB workflow handoff](../../docs/handoff/2026-09-27-four-gib-workflow-acceptance.md)
records the completed prebuilds, targeted tests, native lifecycle, short capacity observation,
Dashboard checks, isolated hosting, backup/restore, failure gates, and cleanup. Broader production
and real-application acceptance retain their separate scope.

## Components

- [Windows hosting](WINDOWS.md): separate Server boot and interactive Worker logon tasks, private
  configuration, exact entry hashes, bounded restart attempts, and cooperative shutdown. Scheduled
  Tasks are the selected host; this is not a native SCM service or an automatic upgrade protocol.
- [Capacity observations](../../docs/operations/capacity.md): an administrator-only, read-only
  `GET /api/operations/status` snapshot exposes task/lease counts, logical evidence quotas,
  SQLite pages, database/WAL/SHM file lengths, and available filesystem bytes without paths.
- `capacity.mjs`: checks Server liveness and the exact served Dashboard index, samples operations,
  and evaluates explicit throughput and storage thresholds. It creates no workload and never
  triggers a Worker, model, PR, Issue, webhook redelivery, or publication.
- `acceptance.mjs`: prepares a complete pending checklist and checks recorded evidence digests.
  A submitted pass becomes `ready_for_review`, never an automatically accepted deployment.
- [Historical scenarios](../../docs/operations/historical-scenarios.md): independent Peek,
  Launcher, external HTTP 401, cached relay duplicate, and native Server duplicate cases. Their
  previous outcomes remain historical; all new runs start as `not_run`.

## Execution order when the Worker is available

1. Build and run the required checks on the designated environment against the final source tree.
   Run the Server and Worker suites, shared production-source boundary checks, the operations Node
   tests, and Windows PowerShell checks. Keep failures and exact source/build receipts. The linked
   handoff records the checks already executed; it does not claim a full-suite pass.
2. Record a source manifest and hashes of the complete prebuilt runtime, including Dashboard assets,
   shared packages, Worker, and ProcessHost. Retain the dependency lockfile and actual build receipt.
   A Git revision or one entry hash alone does not establish a build-to-source relationship.
3. Run `deploy/investigation-acceptance/run.mjs` with a fresh output directory and the existing
   explicitly synthetic CLI. This uses native Server/Worker entries and isolated data, covers
   cancellation/restart/checkpoint recovery, and disables external writes. Follow its README;
   never substitute a production database or copy old publication approval files.
4. Rehearse the new Windows host in an isolated deployment. Exercise registration, boot/logon,
   cooperative stop, bounded unexpected-exit recovery, and an unconfirmed shutdown. An active
   interactive desktop is required for application/UI acceptance. Do not infer it from task or
   process existence.
5. Stop all owned writers and prepare a protected backup before a production cutover. Include
   Server and account databases, retained SQLite sidecars, source/evidence data, Worker journals,
   relay state, and configuration. Hash the backup and rehearse restoration into fresh isolated
   roots with intake/external writes disabled. Preserve the existing deployment for rollback.
   Never copy only a live `.sqlite` file, manually delete WAL files, or replay dedup tombstones.
6. Deploy the exact built payload and check the current Dashboard against the native API. Exercise
   the new publication preparation flow, error correction, navigation, permissions, and retained
   drafts. Actual GitHub dispatch requires approval of the exact targets, operations, content,
   and run scope. None of the scripts here supplies that approval or performs those mutations.
7. Run the selected historical UI cases using their original sealed inputs and independent source
   builds. Recover missing exact inputs from retained evidence before execution. Missing inputs,
   Worker, desktop, or authorization mean `not_run`/`blocked`, not a successful simpler substitute.
8. Declare a representative sustained workload and capacity targets, then sample while that
   workload actually runs. Keep workload definition, raw samples, terminal outcomes, retention
   observations, and cleanup receipts. Review the complete packet before accepting the deployment.

## Capacity collection

Copy `capacity.example.json` to a protected operations directory and replace every deployment
value. Its one-hour/100-task/disk thresholds are illustrative, not approved product capacity.
Choose targets for the intended workload before running it. The observer credentials file contains
only `username` and `password` for an existing administrator; keep it outside source and evidence.
The client logs in separately, does not reuse the operator's browser session, rotates its own
session before expiry during long observations, and logs out afterward.
Only the fixed login/logout routes use POST. It does not disable TLS checks or follow redirects.

```powershell
node '.\deploy\operations\capacity.mjs' --config 'D:\PrivateOperations\capacity.json' --output 'D:\Acceptance\capacity-run-1.json'
```

The output must not already exist. A receipt is reserved before network work. A process interruption
can leave `running`, which is incomplete evidence. Observation failure or unconfirmed logout cannot
pass. A login failure is retained as a failed receipt without a confirmed observer session. Keep it and use a new output name for an
explicit subsequent run. Inspect the protected Server logs for authentication/availability diagnosis;
the helper deliberately avoids echoing response bodies or secrets.

The observer uses decimal strings and BigInt for physical byte metrics. Missing WAL files count as
absent files; unavailable measurements fail acceptance. Repeated cached timestamps do not extend
the observation window. Duration uses the Server's monotonic uptime; wall-clock changes invalidate
the window. Server generation changes, regressing counters, unknown task states,
insufficient actual completions, and threshold breaches prevent a passing receipt. The default
recommended interval is 30 seconds to limit SQL aggregate work.

The receipt identifies its normalized origin, run ID, requested duration, interval, policy, and
raw observations. A bounded two-minute grace permits the final independent Server sample to cover
the requested window; repeated cached responses cannot keep the collector alive indefinitely.

The result describes global instance throughput. Do not attribute unrelated concurrent work to a
specific scenario. Terminal blocked tasks can be resumed; their falling counters invalidate that
capacity window. Sampling cannot establish inter-sample peaks, physical allocated blocks, peak
memory, or power-loss durability. Logical evidence cleanup does not imply SQLite file compaction.

## Acceptance packets

Prepare a fresh packet for the final full revision:

```powershell
node '.\deploy\operations\acceptance.mjs' --mode prepare --source-revision '<full-40-character-Git-revision>' --output 'D:\Acceptance\pending.json'
```

Each result starts as `not_run`. Record the actual scenario status, unique `runId`, observation
times, and evidence entries `{ "kind": "...", "path": "relative/file.json", "sha256": "..." }`.
Use only the kinds declared by that scenario in the two catalogs. Keep actual evidence under a
protected root outside the repository. Do not include credential files. Failed and blocked runs
must retain their own outcomes; new attempts use new packets instead of rewriting old receipts.

```powershell
node '.\deploy\operations\acceptance.mjs' --mode summarize --input 'D:\Acceptance\results.json' --evidence-root 'D:\Acceptance\evidence' --output 'D:\Acceptance\review-summary.json'
```

The summarizer rejects unknown/duplicate scenarios, missing required evidence, changed hashes,
absolute paths, escapes outside the evidence root, and unbounded evidence files. Omitted scenarios
remain `not_run`. Hash-valid reported passes are only ready for review: independently check that
their contents bind to the current source/release, exact target and inputs, native observations,
required controls, and cleanup. No hash proves the truth of a model or human assertion.

The active checklist includes latest-release identity, native lifecycle, deployed Dashboard,
managed restart, backup/restore, sustained capacity, and the six historical cases. A complete code
change and a complete accepted deployment remain separate milestones.
