# CI correction and production cutover, 2026-09-27

## Status and scope

The user authorized correction of the main-branch CI failure, reconciliation of current status
documents, and production deployment with backup and rollback preparation. The implementation
base is `b690dd982488ed75e4448ae099187447f4af69ef`. Verification and deployment are in progress;
their final source, CI, and deployment receipts must be recorded before claiming completion.
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
lint check still passed after regeneration. The next CI run remains a separate release gate.

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
Both projects' type checks and the changed-test lint passed. The next full CI result remains pending.

## Status reconciliation

README, architecture, the active backlog, and the historical-scenario guide distinguish the
completed four-GiB synthetic acceptance from production cutover and broader acceptance. They now
record executed webhook duplicate tests and the existing `investigation-v5` upgrade boundary.
Historical failures, real-application exclusions, and the original external HTTP 401 remain.

## Deployment preparation

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

The production target will use the exact CI-accepted release, a dedicated Server account,
Scheduled Task supervision, the existing interactive Worker identity, and serial static work
within the existing four-GiB VM ceiling. Outbound writes, media upload, webhook intake, and E2E
remain held during deployment readiness checks. No bootstrap reset or historical Task rerun is
planned. Production startup, existing-account readback, access-path checks, and final operational
state are pending their actual receipts.

## Remaining acceptance

This work does not establish VM reboot/power-loss recovery, the full abnormal-shutdown matrix,
long-term or concurrent capacity, current-release real-model/PowerToys behavior, live publication,
or historical Peek/Launcher/HTTP 401 closure. The completed checks and production deployment
must retain those separate boundaries.
