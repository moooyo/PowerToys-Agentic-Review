# Task / Report / Loop verification

**14306 tests passed, 0 failed, and 61 existing platform/opt-in skips.** All six package typechecks, shared/server builds, the root build, and the changed-file Biome check passed.

Verified source snapshot: snapshot-006  
Source archive SHA256: `7f7b7df09b9fc74fae68ddb8289ddf33558ca9fc35c8ba78be099edad1d90315`

| Package | Passed | Skipped | Failed | Typecheck |
| --- | ---: | ---: | ---: | --- |
| contracts | 1660 | 0 | 0 | Passed |
| domain | 337 | 0 | 0 | Passed |
| codex | 222 | 0 | 0 | Passed |
| server | 5927 | 1 | 0 | Passed |
| worker | 2492 | 60 | 0 | Passed |
| dashboard | 3668 | 0 | 0 | Passed |

Server full-suite duration: 525.15 seconds. Packages ran serially with Vitest `--maxWorkers=2 --no-file-parallelism`. The 137-hypothesis Server/Worker restart and complete-report roundtrip actually ran and passed.

## Commands

- `pnpm run build:shared` and `pnpm --filter @agentic-review/server build:only`
- `pnpm --filter @agentic-review/<package> typecheck:only` for all six packages
- `pnpm --filter @agentic-review/<package> test:only --maxWorkers=2 --no-file-parallelism` for all six packages
- `pnpm build`
- `pnpm exec biome check <110 changed TypeScript/JavaScript files>`: 0 errors, 383 warnings, 2 informational diagnostics. Automatic edits were limited to formatting and import organization.

The production build completed with Vite's standard >500 kB chunk advisory. Its runtime JavaScript contains none of the checked sample/preview fixture markers; source maps were excluded from this check.

## Browser and execution scope

Chromium ran on test-env in a loopback-only network namespace. The final production static entry completed real HTTP sign-in, received an HttpOnly cookie, and rendered the seeded report in Connected mode. The final development entry rendered the fork's P1 sample report. Both had zero page errors and zero console warnings/errors.

Earlier targeted regressions on snapshot-004 passed for independent P0/Approve versus Merge, mobile header controls, explicit resume-budget changes, and logout without stale-scope requests. The later static-import changes received the final entry checks.

Browser data was synthetic and directly inserted into a dedicated temporary database. No production investigation, real model, real GitHub write, or native Windows UI execution was claimed. All temporary browser/server processes and synthetic databases were cleaned. No local repository tests, builds, or runtime probes ran; local checksum and file-transfer checks were performed.

The contracts/domain/codex dist directories were copied to the local workspace after archive/path checks. All 288 copied files match the final root-build outputs. Artifact archive SHA256: `53563583863257b078af38f57c1b9f759f1037e4440483befe69e614784da119`.

The JSON documentation example was regenerated using the current fixture and action-policy evaluator; both schemas and result semantics passed. Its synthetic data and placeholder digests are explicitly identified.

## Evidence

- Machine-readable details: [verification.json](verification.json)
- [Production report](production-report.png) and [development report](development-report.png)
- Full remote logs: `/var/tmp/powertoys-task-report-loop-20260915-0a4b2ad2acb94707874b4b95838ec1d4/logs/snapshot-006`
- Local log copy: `C:\Users\moooyo\AppData\Local\Temp\powertoys-task-report-loop-0a4b2ad2acb94707874b4b95838ec1d4\snapshot-006`
- Previous failed snapshots and their logs remain preserved under the same verification root.
