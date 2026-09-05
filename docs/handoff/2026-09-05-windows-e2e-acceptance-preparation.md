# Windows E2E Acceptance Preparation Handoff

Status date: 2026-09-05

Starting commit: `f4dadbc36bda55aa679590af538e2d397ecdcaf6`

## Outcome and remaining objective

The remaining objective from the worker-cache-governance handoff is still the real Windows E2E
exercise. No Windows release acceptance has been claimed. The existing baseline CI for `f4dadbc`
passed all three jobs in [run 33931137962](https://github.com/moooyo/PowerToys-Agentic-Review/actions/runs/33931137962).

The continuation found that the old collector could present unrelated or insufficient observations
as evidence of Codex validation, workspace cleanup, or descendant termination. The runbook also
omitted the supported way to create and cancel jobs without Dashboard mutations.

## Changes

- The PowerShell 7 collector always reports `acceptanceStatus = 'unverified'`; all nine acceptance
  criteria require manual correlation with actual run evidence.
- Captures identify the exact GitHub repository ID and SHA-256-derived run-attempt directories.
  Missing roots, links, absent inputs, and unavailable observations stay explicit. Root-wide
  recursive HEAD scans and log-keyword assertions were removed.
- Windows process observations use the configured ProcessHost executable, PID/parent PID, and
  creation time. Parent links inconsistent with process creation times are excluded. No command
  lines, environment variables, or log contents are copied into reports.
- `baseline`, `active`, `completed`, and `cancelled` captures use distinct output paths. Exclusive
  file creation prevents overwriting earlier evidence or input files.
- The runbook now covers reviewer assignment/review requests, withdrawing all active requests,
  opening a new request epoch for a second job, and cancelling its active lease through GitHub.
  It distinguishes an accepted immutable result from idempotent HTTP retries and requires actual
  Codex-launched command evidence and before/after process and workspace correlation.
- Standalone collector regression checks were added to Windows CI.

## Verification and constraints

Verification runs only on `test-env` unless local verification is explicitly authorized. The current
`test-env` is Debian Linux, not a Windows Worker. No local tests, builds, or runtime probes were run.

The portable collector regressions passed on `test-env` using PowerShell 7.6.5. Biome checked 198
files without changes. The regression suite includes a Windows-only process observation case for
native CI; a Linux pass cannot establish Windows process inspection or the release exercise.

Remote working files are under `/tmp/agentic-e2e-acceptance-20260905-01`. The temporary PowerShell
runtime is under `/tmp/agentic-pwsh-7.6.5`; its official release archive digest was verified before use.

## Required inputs to continue the real run

The user has been asked for a Windows Worker connection, deployment configuration path, and a
permitted public PR against `main`. Those inputs were not available during this preparation.
The checkout contains only the deployment template, and no Windows SSH target was identified.

Once those inputs are available, follow `deploy/worker/worker-e2e-runbook.md`. Establish how the
pinned Codex CLI authenticates in the fresh per-attempt `CODEX_HOME` and `USERPROFILE` with keyring
storage and a replacement environment. The repository does not import `auth.json` or inject an API
key. Also prepare actual command/exit/output and process-lifecycle capture before scheduling;
ordinary Worker logs do not retain Codex command output.

Do not substitute fixture results, the collector report, Linux verification, or native unit tests
for the outstanding real Windows registration, PR execution, cancellation, and cleanup evidence.
