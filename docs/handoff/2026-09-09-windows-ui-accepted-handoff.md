# Windows UI acceptance completed

The user approved the next slice. Continue from the
[durable journal handoff](2026-09-09-durable-journal-handoff.md), which records implemented code
and the current remote-verification blocker. The accepted M34 results below remain unchanged.

Date: 2026-09-09. This handoff supersedes the Windows UI stop point in the
[resumed handoff](2026-09-09-validation-platform-resumed-handoff.md). M34's scoped
Notepad++ Worker/UI/evidence/Dashboard acceptance is complete. Overall platform
delivery is still incomplete: enforced model execution, Evaluation and deployment
acceptance remain open.

## Current result

- The production ancestry correction and foreground/hit-test guard passed the
  complete Windows driver test file: **67 passed, zero failed or skipped**.
- A new real Worker independently fetched and built Notepad++ commit
  `2f50e44ffe9aa607a0e50e1f2ab143e0daed1391` for each of two fresh attempts.
- The positive case passed all six steps. The single New action produced `new 2`,
  preserved `new 1`, and did not create `new 3`.
- The deliberate negative case retained `expected: false, actual: true` for the
  created second tab. Outcomes were `passed, passed, passed, failed, not_run,
  not_run`. This is a successful negative control, not a reported Notepad++ defect.
- All ten original evidence assets (eight PNGs and two step files) matched their
  sizes, hashes and ownership. The real Dashboard downloaded every asset and
  verified expanded checks, result identity, source commit and unchanged history.
- The coordinator independently viewed all eight original PNGs and all eighteen
  unique Dashboard captures. The other two captures were exact duplicates by hash.
- Both results retain `sourceState: original`, `modelState: not_requested` and
  `reproductionConclusion: inconclusive`. No real Issue reproduction is claimed.

The consolidated [acceptance receipt](../../artifacts/m34-native-acceptance-20260909/verification/native-ui-acceptance-v3.json)
has SHA-256 `c98a51a3b0dbb875bda6243504333090d3df4742d6b00ed4cdd21cbd244fd061`.

| Identity | Positive | Negative |
| --- | --- | --- |
| Run | `8a635d1b-4faf-426e-8501-ee98721a90da` | `4fc4ede6-cf55-47dc-989f-d13352def6de` |
| Job | `40730073-66d0-4778-93be-ae61a136c7fd` | `23aba97f-28ca-45c4-911d-051d5b91952a` |
| Attempt | `2ce01d67-584e-49d1-b336-fed028e19688` | `da6de3de-9bf7-45c3-99e5-295a2015cddd` |
| Result | `79824efd-1a16-4bd1-ae53-554e18851569` | `e42f2dcf-9a52-4861-ad78-3d310d814e8c` |

Fixture: `7adc51e6-c1ba-493b-83b1-80dedc3b0bab`.
Repository fixture: `a77336af-74e6-4782-bd63-511abfdee9eb`.
The repository and source commit are real; the Issue, assignment, credentials,
Profiles, Runs and database are synthetic acceptance data. Terminal Job status
`succeeded` means a result was accepted, not that every validation check passed.

## Source and verification identity

- Frozen source: `artifacts/m32-source-20260908-m34-focus-v8.tar.gz`, 1,131 files,
  SHA-256 `db79e995c697adfcf294c636ed4c4b91df0abe49a361bd46950b1fdece96b272`.
- Manifest: `artifacts/m32-evaluations-20260908/source-m34-focus-v8.json`, SHA-256
  `17a6c3e1398ccd103c06c97b70187a0ecf1e97944e9a826316bcb25701357141`.
- Production driver: `apps/worker/src/ui/windows-driver-entry.ps1`, SHA-256
  `b49c4a9acf00bbdef28ba3ff136873f06873a9f17b0b81abc716ace6f0f2610a`.
- Native report: `artifacts/m34-native-acceptance-20260909/verification/native-full-focus-v1/receipt.json`.
- Final typecheck and formatting: `worker-typecheck-v8-run3.json` and
  `biome-v8-run3.log` in the same verification directory.
- Readiness receipt: `native-integration-ready-v8.json`, SHA-256
  `0bd7b754150fcf0a139aaefa603f8fe4bc340665ff17b576f7a791df41308ccd`.

The new Worker bundle and copied driver were checked against v8 before and after
real execution. The unchanged ProcessHost was explicitly associated with its
original build through all 34 native source files. Server/shared and Dashboard
reuse the original clean v7 assets through 871 identical relevant source inputs,
873 runtime assets and 58 Dashboard assets. The original 616 Server tests, 55
lease tests and 165 mocked cache-environment tests were inherited through explicit
hash associations; they were not presented as new executions.

This final handoff and the latest documentation updates postdate v8. Do not claim
that the complete final documentation tree equals the capture. The tested
production driver, test and fixture code have not changed since the successful
native run and real Worker acceptance. No commit or push was performed; preserve
untracked source files when transferring the working tree, not only HEAD or diff.

## Closed runtime and durable evidence

The Windows client finished at `2026-09-09T08:13:11.639Z` with confirmed service,
ProcessHost, attempt-directory and desktop-lease cleanup. The Dashboard browser
and context closed independently. Its only POST was the new fixture's normal
login; all other browser operations were scoped reads.

Server v3 stopped explicitly at `2026-09-09T08:17:01.962Z`, with HTTP/SQLite closed,
its Worker credential revoked, both cases verified, zero active attempts, zero
outbound attempts and unchanged source/spec/Dashboard/configuration. The owned
SSH forward was stopped. Port 3288 had no local or remote listener afterward.
There is no live v3 instance to resume.

Durable local records:

- `artifacts/m34-native-acceptance-20260909/verification/fixture-public-v3/`:
  complete copied public Server records, including `server-stopped.json`.
- `artifacts/m34-native-acceptance-20260909/verification/worker-positive-v3/` and
  `worker-negative-v3/`: original assets and Server evidence verification.
- `artifacts/m34-native-acceptance-20260909/dashboard-preparation/acceptance-v4-run1/`:
  actual Dashboard receipt, ten downloads and twenty captures. Receipt SHA-256:
  `7965ed35576f5bf5f603ce67f347936050e1317ff9c8ef292eabd9c2efbbb858`.
- `D:/AR/m34ui-0909-v3/public/`: immutable client parameters, lifecycle reports and
  process observations. Its closed `private/` credentials must not be read or reused.

The earlier v1/v2 failed Runs and all diagnostic/native failures remain unchanged.
`verification/focus-regression-diagnostics.md` records the focused preparation
failures, callback timing distinction and the one early run whose ephemeral test
PNGs were removed by the previous cleanup behavior. Do not claim those missing
PNGs were preserved. Final native harness runs explicitly retained synthetic
evidence under their checked temporary roots. Source v6 contains a generated
PowerShell cache and must not be used.

## Authority and next work

The user approved this machine for the scoped local Windows builds and native/UI
verification in this task. Native UI requires idle keyboard/mouse input and the
existing `D:/AR/SharedDesktopLocks` lease. Earlier keyboard activity was confirmed
by the user. Foreground acquisition remains an observed environment condition;
the guard fails closed when foreground or the physical invocation point cannot
be verified. It is not OS isolation or an atomic guarantee about provider input.
Server/SQLite verification remains on Linux `ssh test-env`.

Never access, enumerate or inspect metadata beneath
`apps/worker/.tmp-ui-driver-V7AOfu/`. Preserve existing private-configuration
exclusions. No real PR/Issue writes, provider/model calls, account creation,
firewall/registry changes, sandbox setup or VM provisioning were performed or
authorized by this acceptance. Closed fixtures and credentials are not reusable.

Next, continue the execution-foundation track from
[the foundation design](../design/2026-09-09-windows-execution-foundations.md):

Update on 2026-09-10: the former execution-foundation roadmap below was superseded by
[one Worker per VM](../design/2026-09-10-single-worker-vm.md). Its unused WindowsAttempt code was
removed. Preserve this UI acceptance, but do not continue the former adapter/signing roadmap.

1. Implement durable lifecycle journal/CAS storage and recovery around the already
   tested lease contracts and injected orchestration ports.
2. Establish the supported native/VM enforcement adapter and its deployment
   boundary. Signed prepared/closed evidence, invocation bindings, Server challenge
   consumption, renewal and transactional admission remain unimplemented.
3. Complete genuine model/Evaluation and deployment acceptance, including OIDC,
   multi-user operation and persistent storage. The default adapter remains
   unavailable and Evaluation still reports `executionAccepted: false` until
   actual enforcement and authenticated execution evidence are accepted.

The accepted M26 Web scenario and M33 real Issue timing work need not be repeated.
