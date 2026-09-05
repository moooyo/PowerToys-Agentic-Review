# Windows E2E Live Validation Handoff

Status date: 2026-09-06. **Real Windows E2E accepted; deletion of five local private copies is
explicitly authorized but remains blocked by execution review.**

This continues the [acceptance preparation handoff](./2026-09-05-windows-e2e-acceptance-preparation.md).
The production source, healthy full success, independent active cancellation, cache reuse, and
recovered cleanup outcomes below are established through manually correlated evidence. Test
services and remote credentials/data are closed out. The user approved deletion of the five local
private copies on 2026-09-06, but execution review still rejected the exact-file deletion command.
No further authorization is needed; the remaining cleanup requires manual removal or an external
execution-policy change.

## Authorization

- Local Windows verification was explicitly authorized for this task. Other tasks retain the
  default `test-env` policy unless separately authorized.
- The approved target is [moooyo/kiss-translator-m3 PR #1](https://github.com/moooyo/kiss-translator-m3/pull/1),
  GitHub repository ID `1132386004`, base branch `dev`.
  Immutable base SHA: `174d9b6a6f4f301c8d99378c44ce742d53b70446`;
  head SHA: `d32380d8401a4d0d34f9622bfc87f676fd037214`.
  Its content, commits, and base branch remained unchanged. Authorized GitHub mutations were
  self-assignment for the request lifecycle and restoration of its original state, not review
  publication, comments, pushes, approval, or merge.
- Keep credentials private and leave unrelated account credential stores unchanged.

## Production source and fixes

Production commit: `3cf2ef9b04b03ea5e0849ed3d609e49042eb9e98`.
[CI run 33943477556](https://github.com/moooyo/PowerToys-Agentic-Review/actions/runs/33943477556)
is fully green.

- Codex 0.145.0 uses the compatible `--config approval_policy="never"` exec argument and a
  provider-compatible model-output regex. Strict application validation and the trusted schema
  digest remain authoritative.
- A dedicated persistent Codex home has read-only canonical-path/separation checks. Only allowed
  model/provider/auth settings are loaded. `--ignore-user-config` and project trust `untrusted`
  suppress other configuration while preserving trusted-code admission and `AGENTS.md` loading.
  Provider headers reach only native Codex; tool shells receive seven explicit non-secret variables.
- Git fetches the immutable `baseSha` and PR head with full history, without a `main` assumption;
  fetch auto-maintenance is disabled. Polling resolves canonical PR identities and scopes replay
  observations to active request sources. Node/PATH launch handling and startup ProcessHost cleanup
  are corrected.
- Active disk accounting tolerates confirmed unlink churn while retaining reservations, path
  identity checks, and limits. The live settings are 120,000 ms per scan and 500,000 entries.
  Fixed `cleanup_safe` Git operations do not monitor the attempt they are dismantling.
- Git forces `core.longpaths=true`. When removal still fails, `reservation.removeCheckout` recovers
  only the fixed checkout target, retains bounded stderr, and requires strict prune, worktree
  metadata, and shared-cache postconditions. Guards and deadlines remain enforced. Production uses
  the trusted Node backend; the optional native adapter is not connected by `main`, and missing
  recovery capability fails closed.

Earlier focused checks include real Windows junction cleanup and production-Git-argv regressions.
Earlier remote gates recorded 1,159 tests and 11 Windows-only skips, but two full-build attempts
exited 137 with kernel-global OOM. Their records remain in `artifacts/local-e2e/final-remote-checks/`
(`final-summary.json` and `round-2/`). Later green CI establishes the full build; it does not relabel
those earlier failures.

## Verified full-success round

- Bundle SHA-256: `F8D0E4FD5080CD10594FDAEFD54A73BEDC32149DF2103C86A54CA3149A6599BB`.
- Worker PID: `16576`; creation: `2026-09-05T04:02:23.9268090Z`.
- Worker instance: `8b4637f2-bc4c-4338-b5f7-c7cfed77ba93`.
- Job: `cbddfdee-b509-44df-83c0-c9bfdad0313e`.
- Attempt: `ed2b6863-5d56-41a6-983f-f9a3dd6ad776`.
- Accepted result: `30c41852-af2c-4dd8-b469-6a14fc8a19ab` at `04:21:38Z`.
- Digest: `b4345da5bfe003098c44a04357d8dc1d4cfa0c0df5d36fd106a89cf04edaf5df`.

The database contains exactly one accepted result for this attempt, and the Dashboard matches its
digest. The target PR uses **pnpm 9.14.4**, matching its CI pin; Agentic Review itself uses pnpm
11.24.x. All times below are UTC on 2026-09-05.

| Command | Start | End | Exit |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile --store-dir <attempt-temp>/pnpm-store` | 04:08:47 | 04:10:30 | 0 |
| `pnpm run build:web` | 04:10:30 | 04:10:52 | 0 |
| `pnpm run test:ci` | 04:10:52 | 04:11:25 | 0 |

Tests report 107 Jest suites, 832 Jest tests, and 10 script tests. Exact command/process records and
separate stdout/stderr files are under:

```text
artifacts/local-e2e/evidence-recovery/attempt-a06b4a99564dc966f369dfd4bb5efcb11526003c0ff65cea060ce900819aafe3/
```

At `04:21:51Z`, actual Git cleanup exited 255 with `Result too large`; fixed-target recovery emitted
a warning and completed its checks. Workspaces then numbered zero, the worktree listing was
bare-only, and heartbeats after `04:22Z` reported the same Worker online with `maxSlots=1` and
`activeSlots=0`. Its claim loop continued without drain. This establishes healthy recovered cleanup
for this success round while retaining the underlying Git warning.

Evidence under `artifacts/local-e2e/evidence-recovery/` includes `success-dashboard-result.json`,
`server-state-after-success.json`, `worker-after-success.json`, and `worktrees-after-success.txt`.
The correlated collector capture is `artifacts/local-e2e/32-verified-success-completed.json`.

## Verified final quick cancellation

- Job: `daf1b26c-5480-4448-add8-3b0337cc5d98`.
- Attempt: `75fa7bca-e687-47ea-a0ee-e08cd712a2f9`.
- The previous request epoch closed at `04:23:00Z`; this was a fresh request on the same production
  Worker instance, with the same persistent shared Git repository.
- Processes `38272` and `23344` were active when self-assignment was withdrawn.
- State reached `cancel_requested` at `04:24:53Z`, then `cancelled` with `CANCELLED_BY_SERVER` at
  `04:25:10Z`.
- There are zero accepted `review_results` rows for this cancellation. The attempt's failure digest
  is present; it is not a successful review digest and must not be described as absent.

The attempt directory is gone and the worktree listing is bare-only. The Worker continued its claim
loop at `04:25:10.523Z` and reported healthy status at `04:25:30Z`, without drain. The same Worker
instance and correlated shared Git records establish reuse across the success and cancellation
rounds. Final GitHub assignees are `[]`; base ref `dev`, base SHA, and head SHA match their original
values.

Evidence under `artifacts/local-e2e/evidence-recovery/` includes `cancel-active-processes.json`,
`cancel-states.jsonl`, `worker-after-cancel.json`, `worktrees-after-cancel.txt`, and `github-after.json`.
The collector captures are `33-verified-cancel-active.json` and `34-verified-cancel-completed.json`
under `artifacts/local-e2e/`. The evidence index is
`artifacts/local-e2e/evidence-recovery/evidence-manifest.json`.

The automatic manifest remains `unverified` by design; the acceptance conclusion here comes from
manual association of the source/bundle, exact jobs and attempts, command records, database rows,
Git state, process identities, and healthy Worker observations. Two observed `commandLine` strings
are truncated, but process identity and parent-chain data are complete; command execution logs and
Git records are not truncated. The completed native full-tree audit is recorded in the manifest's
`independentAudit`: all 262 observed success-run and nine cancellation-run process identities were
gone while the Worker was still alive, and `requiredRuntimeEvidenceGaps=[]`. The final manual decision is recorded in
`artifacts/local-e2e/evidence-recovery/acceptance-decision.json`.

## Retained earlier rounds

| Evidence directory | Job / attempt | Outcome |
| --- | --- | --- |
| `evidence-final/` | `d3f4b707-efb2-45b3-b2a9-9b0b6fa8fb04` / `35b93ae1-432c-4e56-86fd-557bf6fc78e4` | Accepted result, then Git 255 and Worker drain. |
| `evidence-release/` | `38bd77e7-25b7-4070-99b5-2e47b40c447b` / `07d336e7-6684-4a9b-b1ca-1400b3278ba5` | Accepted result, then unhealthy Git cleanup/drain. |
| `evidence-recovery/` diagnostic cancel | `cef32b18-92e5-4c3d-bdd3-524af7286c1b` / `f9b5b70c-ee90-4c13-8c4f-0b1f700c067b` | Real active cancellation, zero accepted results, Git 255 recovered, Worker online without drain. |

For the diagnostic cancel, Node processes `38996` and `12644` were active at self-assignment
withdrawal. State changed to `cancel_requested` at `04:07:08Z`, then `cancelled` with
`CANCELLED_BY_SERVER` at `04:07:25Z`. Recovery followed the actual Git 255 / `Result too large`
warning at `04:07:37Z`, with empty workspace and bare-only worktree metadata. The files
`diagnostic-cancel-active-processes.json`, `diagnostic-cancel-states.jsonl`,
`diagnostic-cleanup-recovery.json`, and `server-state-after-diagnostic-cancel.json` retain that proof.
It supports the recovery path but does not replace the final fresh quick-cancel sequence.

Keep the earlier schema, scan-timeout, disk-snapshot, and startup failure evidence. Also retain
`evidence-final/partial-success-process-audit.json`: 305 observed earlier process identities were
gone while the old Worker remained live, which did not erase its drain or make that round healthy.

## Closeout and blocked local private copies

After the healthy runtime observations, the test Worker and observer were stopped, along with
temporary Server PID `1709629` and tunnel PID `33544`. The test Worker credential was revoked;
the remote token and temporary runtime database were removed. Evidence is
`evidence-recovery/worker-credential-revocation.json` and `evidence-recovery/remote-cleanup.json`
under `artifacts/local-e2e/`.

The user explicitly approved deletion of these five local copies on 2026-09-06:

```text
D:\Code\PowerToys-Agentic-Review\artifacts\local-e2e\data\Profile\auth.json
D:\Code\PowerToys-Agentic-Review\artifacts\local-e2e\data\Profile\floway-token
D:\Code\PowerToys-Agentic-Review\artifacts\local-e2e\data\Profile\config.toml
D:\Code\PowerToys-Agentic-Review\artifacts\local-e2e\data\Operator\session.cookie
C:\ProgramData\AgenticReview\Worker\worker-auth-v1.json
```

Before that approval, automatic review rejected local deletion twice, including exact-file,
non-recursive deletion. After the explicit approval, it again rejected a command limited to these
five files, with file-type and path checks, before process creation. Each refusal returned only
**blocked by policy**. A subsequent read-only check confirmed all five copies still exist.
No alternate execution route was attempted. The remaining action is manual deletion by the user
or an external execution-policy change, followed by an absence check; do not request the same
authorization again. The original user credential store is outside this cleanup scope.

The read-only inventory is `artifacts/local-e2e/cleanup-inventory.json`; current blocked disposition
is recorded in `artifacts/local-e2e/evidence-recovery/local-cleanup.json` and
`artifacts/local-e2e/current-round.json`. The earlier inventory listed four credential files; the
five-file disposition above also includes the private profile's `config.toml`.

Automatic approval review blocked deletion of this non-secret diagnostic fixture:

```text
C:\Users\moooyo\AppData\Local\Temp\agentic-review-git-remove-repro-b738ebf1a44c49788ed85bb0e47fef71
```

It remains **blocked by policy**; no bypass was attempted. It is separate from the credential
inventory and must be disclosed as retained. Artifacts are local and uncommitted: do not publish
whole directories containing private configuration, process environments, or credential stores.
