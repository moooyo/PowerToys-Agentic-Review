# CI correction and production cutover, 2026-09-27

## Status and scope

The user authorized correction of the main-branch CI failure, reconciliation of current status
documents, and production deployment with backup and rollback preparation. The implementation
base is `b690dd982488ed75e4448ae099187447f4af69ef`. The deployed runtime release is
`a6ae2995407037683e5be120f76e928aad212c4b`. Production cutover, scoped read-only browser
acceptance, and temporary-resource cleanup are complete. The three permanent production
components remained enabled and running at the final observation on September 27 at 10:53:39 UTC.
No local software verification, real model invocation, PowerToys build/UI exercise, or actual
repository PR/Issue mutation is part of this work.

## CI failure and correction

[CI run 36304015077](https://github.com/moooyo/PowerToys-Agentic-Review/actions/runs/36304015077)
passed Linux type checking, tests, and builds, plus the Windows Worker and ProcessHost Linux jobs.
Its lint step failed with 4,335 errors. Remote diagnosis reproduced that count: all error-level
diagnostics came from tracked design documents, while the application, shared-package, and
deployment-tool directories had none. The minified Material dependency bundle alone contributed
4,058 errors, including its formatting diagnostic. This does not change the failed CI outcome.

The lint boundary now names generated output paths explicitly. Composite HTML, generated SVG,
generated icon/font assets, and third-party bundles are excluded from source linting. Their
author inputs remain checked: prototype JavaScript, JSX, CSS, shell/viewer templates, JSON data,
and generator scripts. No recommended rule is disabled globally and no production source
directory is excluded. SVG output uses XML validation; its CDATA is not rewritten to accommodate
an HTML/CSS parser. Dependency code is not manually lint-fixed; the Material bundle is rebuilt
through its existing generator, retaining dependency license notices.

Authored sources receive formatting/import-order corrections, explicit assignment statements,
side-effect-only `forEach` callbacks, valid accessible names/headings, and button types. Intentional
ASCII control-character filtering is retained with narrowly documented local lint suppressions.
The atlas template now uses a valid `null` placeholder expression. Its generator requires exactly
one marker, tolerates whitespace around the expression, and preserves payload backslashes and
escaped script terminators when replacing it.

The first attempt to collect every diagnostic as one JSON report was stopped to avoid exhausting
the remote host's memory; its empty report is incomplete evidence, regardless of wrapper status.
The retained summary and bounded reports account for all errors without truncating their totals.
Remote full-tree Biome now passes across 1,344 checked files with zero errors, 2,304 warnings,
and 596 informational diagnostics. Warnings remain visible. The authored-source corrections
received an independent static behavior review. No production runtime source code changed.

The existing bundle/asset generators, three prototype composers, and atlas publisher completed.
Eight generated files changed. Offline checks passed for seven HTML documents, eight embedded
JavaScript programs, unique DOM IDs, static ARIA references, explicit button types, and 55 SVG
documents parsed as XML. These are syntax and document-structure checks, not browser interaction
acceptance. Isolated generator cases also covered the legal placeholder, payload escaping,
missing/duplicate-marker rejection of atlas output, and generated SVG validity. The full-tree
lint check still passed after regeneration. Published CI outcomes are recorded separately below.

The correction was published as `d55690934c170b6f11ee22b1d32b5f8ab8650049`.
[CI run 36310037038](https://github.com/moooyo/PowerToys-Agentic-Review/actions/runs/36310037038)
then failed two existing tests at their default five-second deadline: complete Playwright runtime
copy/manifest/import verification on Windows and the exact two-MiB request-body boundary on Linux.
The Windows log also retained an `ENOTEMPTY` teardown error after the timeout. That run remains
failed; production startup was held.

Only those two large checks now receive explicit 30-second limits. Their complete-package and
exact-byte boundary assertions remain unchanged. Worker teardown waits for the original complete
check to settle before deleting its captured temporary roots, with a separate bounded cleanup
deadline. The original promise is still returned to the test runner, so assertion failures and
timeouts remain failures. Temporary-root ownership is captured before asynchronous allocation,
preventing a late check or teardown from taking a later test's directories. No global test timeout
or production behavior changes. The complete Dashboard test file passed all 94 cases remotely;
the full-size boundary case took about 1.19 seconds. Both Worker tests passed on Windows, with
the complete package check taking about 3.38 seconds and no owned temporary directory remaining.
Both projects' type checks and the changed-test lint passed.

[CI run 36310776052](https://github.com/moooyo/PowerToys-Agentic-Review/actions/runs/36310776052)
completed successfully for `a6ae2995407037683e5be120f76e928aad212c4b`. Node Linux Checks,
Windows Worker Checks, and ProcessHost Linux Checks all passed, including full tests, builds,
lint, native checks, and deployment-script checks. Production activation began only after an
independent readback confirmed that exact commit and all three successful jobs.

The source archive identifies all 1,856 tracked files. The 1,299 application output files are
reused from the verified `d556909` build: only two tests and two Markdown files changed, and the
complete source comparison confirms unchanged production sources, package manifests, and lockfile.
Every reused output was hash-verified. The release receipt explicitly records this lineage rather
than claiming a new compilation. Windows additionally verified its production dependency closure,
with 78 external packages and 104 links whose targets remain inside the final release.

## Status reconciliation

README, architecture, the active backlog, and the historical-scenario guide distinguish the
completed four-GiB synthetic acceptance from production cutover and broader acceptance. They now
record executed webhook duplicate tests and the existing `investigation-v5` upgrade boundary.
Historical failures, real-application exclusions, and the original external HTTP 401 remain.

## Production deployment and rollback preparation

The old production processes were stopped at baseline. Inspection used copies of both formal
database sets, including their WAL/SHM sidecars, without opening the originals through SQLite.
All four tasks and attempts were completed, all four leases released, and no pending action,
intake, progress publication, or active relay record required replay. Historical failed relay
records are preserved.

A protected complete backup contains 270 files and 51 directories, with matching source-before,
source-after, and destination hashes. Existing accounts, reports, evidence, configuration,
Worker journals, relay state, and replaced task definitions are retained. Worker journals stay
at their original bound path. The narrowly reviewed parent ACL change preserved all 88 child
directory ACLs, effective rules, and owners.

The production deployment uses the exact CI-accepted release, a dedicated limited Server account,
Scheduled Task supervision, and the existing interactive Worker identity. Nine exact superseded
component task definitions were preserved and disabled; unrelated historical tasks were untouched.
The new tasks were held disabled until the CI gate passed.

The Server started under its dedicated identity in Session 0. Native sign-in confirmed the original
account ID, version, and unchanged password digest without a bootstrap reset. All four existing
tasks, four report exports, and 47 evidence records matched the retained baseline. All four leases
remain released, the 22 delivery records remain terminal, and no new action intent or task appeared.

The persisted scheduler setting overrides the environment default, so the empty deployment was
changed from two static slots to one through the native administrator API and then read back.
The Worker runs in the existing interactive session with a static role and one concurrent task.
Its original CLI profile, trusted execution mappings, executable pins, plan environment, and
compiler selection are preserved. A final configuration comparison found omitted static execution
settings in the first preparation helper; the idle Worker was stopped cooperatively, those exact
settings were restored, and a fresh generation passed readiness. The earlier generation remains
in its history. No model or PowerToys task was used as a deployment probe.

The existing peer-restricted Dashboard access path has a new owned relay generation. Health and
Dashboard requests returned HTTP 200, and served index bytes matched the release. These requests
used the established private peer path; no local desktop network probe was run and no new SSH
forward was created. Server, Worker, and relay remain running with bounded supervision.

Six read-only browser steps passed in the existing interactive Worker session, with three
screenshots independently inspected. The Dashboard showed the four retained tasks, an existing
report, and its historical image evidence. This was not a new application or E2E execution.
The action-availability capture still showed loading, so panel readiness was not established;
video playback and publishing were not exercised. The temporary login was revoked and the
browser closed. An earlier launch under SYSTEM failed before authentication, with a separate
diagnostic recording Edge exit code 1002. Both receipts remain; they do not establish Session 0
as the definitive cause. The successful run used the same frozen helper in the interactive session.

The VM remains at four GiB. Worker subprocess memory retains the prior two-GiB ceiling; this is
a configured guard, not measured real-model capacity. GitHub read credentials are preserved and
their expected identity was confirmed by GET. Outbound writes, media uploads, webhook intake,
and E2E remain held. The previous ephemeral webhook tunnel is not restarted or retargeted.

A reviewed private stop/rollback procedure can cooperatively stop the new components, disable
their tasks, and conditionally restore the recorded parent ACL to the original stopped baseline.
It does not overwrite new data, start old single-use launchers, or re-enable external writes.
The protected backup and old release remain available; rollback itself was not executed.

Final native readback reconfirmed the retained account and data, one static slot, no occupied
leases, and an idle Worker heartbeat. The final process inventory contained five production Node
processes and one idle ProcessHost with its expected console host, with no model/task children or
Edge processes. The exact temporary browser task, empty temporary directory, and owned transfer
resources were removed. The three permanent tasks, their required identities and rights, and all
production data were retained. Twenty-five final operational receipts were exported with matching
per-file hashes; private handoff and machine memory were updated, and exclusive worker ownership
was released. No further acceptance job or monitoring loop remains active.

The last guest available-memory observation was about 1.26 GiB while idle. This single sample
does not establish production workload capacity or change the remaining acceptance below.

## Remaining acceptance

This work does not establish VM reboot/power-loss recovery, the full abnormal-shutdown matrix,
long-term or concurrent capacity, current-release real-model/PowerToys behavior, live publication,
or historical Peek/Launcher/HTTP 401 closure. The completed checks and production deployment
must retain those separate boundaries.
