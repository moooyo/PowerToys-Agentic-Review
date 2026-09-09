# Model runtime and consecutive-task integration

Date: 2026-09-10 (Asia/Shanghai). The user confirmed that the product is unreleased, requested no
old-data rebuild/conversion/migration work, authorized local Windows testing, and has no real
provider. Development maintains the current schema directly. Existing data and artifacts are intact.

## Implemented

The Evaluation app-server path now follows the single-Worker VM design. It no longer creates named
permission profiles or checks/provisions an internal Windows sandbox for each fresh task home.
Startup and thread creation use `danger-full-access`; the actual turn explicitly selects
`externalSandbox`. Summary sessions disable shell tools and select no environments. The obsolete
command-network proxy and `commandNetworkDomains` option are removed; deployment owns VM networking.

Parent relay routing, actual model/configuration matching, frozen input/output binding, cancellation,
process identity, transport drain and closure checks remain. The ordinary exec backend is unchanged.
The implementation uses the captured Codex 0.145.0 schema and official
[thread](https://learn.chatgpt.com/docs/app-server#threads) and
[turn](https://learn.chatgpt.com/docs/app-server#turns) documentation.

Two new integration cases connect actual WorkerService, HttpWorkerApi, HTTP authentication,
RPC/SQLite ownership, ProfileJobExecutor/ReviewJobExecutor, invocation records, result persistence,
score previews and assessment history. One Worker processes both arms sequentially with different
Prompt/Profile configurations and independent registrations/aliases for the same observed model.
Another case fails the first model call and verifies the next task still succeeds. Deferred cleanup
must follow terminal reporting and finish before reuse. Checkout/build and prepared-model execution
are injected synthetic boundaries; this complete WorkerService test does not launch actual Codex.

## Verification

- Linux `test-env`: **2,136 tests across 46 exact files passed**, zero failed/skipped/todo tests.
  Shared and Server builds and Worker/Server typechecks passed. Biome checked 14 changed TypeScript
  files without errors, warnings or modifications.
- Initial Worker packaging failed in its nested typecheck with no diagnostic output. That failed
  receipt is retained. Separate build-only verification of unchanged source passed Worker typecheck
  and actual Worker/web-driver packaging. The first failure's cause was not established.
- Authorized local Windows: actual Codex 0.145.0 and the newly built ProcessHost passed review and
  summary against an owned loopback Responses service. Each made exactly one synthetic request,
  returned strict JSON, and confirmed CLI exit, streams/transport drain, Host close and socket closure.
- Captured RPC contains no Windows sandbox setup/readiness operation. Both turns use externalSandbox.
  Summary reports empty runtime workspace roots and shell disabled. It still advertises plan,
  user-input and orchestrator skill-list/read tools; the fixture validates their observed shape,
  and no tool or command was executed.

Windows run1 passed review but an overly narrow fixture tool assertion aborted summary. Its
`CLEANUP_UNCONFIRMED` and incomplete lifecycle fields remain in the original report. A root follow-up
observed the recorded Host/CLI PIDs absent; that does not change the original failed assertions.
Run2 changed only the fixture's observed-tool allowance and passed all closure checks for both cases.
The raw requests, responses, notifications, source inputs and failures are retained.

## Source and evidence

Final source `m37-model-v5` contains 1,135 captured files:

- Archive `artifacts/m32-source-20260908-m37-model-v5.tar.gz`, SHA256
  `6ec4325496c3635d0261056567ecb96ea4234c5e88761584d6f58433033fa24c`.
- Manifest `artifacts/m32-evaluations-20260908/source-m37-model-v5.json`, SHA256
  `6a901ece1bb47efa46bb253b37f55fc0c1d297c87f6c803f205b315cc4c6ecd7`.
- Full-suite receipt: `artifacts/m37-model-continuation-20260910/verification/verify-run5-20260910/verification/tests/verification-receipt.json`,
  SHA256 `a0c6e392120b9840e3b62b33d1115ea76f6a422706f98ec0056e7c628dbd3843`.
- Successful sibling `build-verification/build-receipt.json`, SHA256
  `c9b9ed416e706b795a88b707bc4ccac62817cf6181ad8224b07b4c3aab6955ed`.
- Windows `artifacts/m37-model-continuation-20260910/windows-protocol-run2/report.json`, SHA256
  `d5baa8e928e8ccab1f67d906a9a076e3d8c78d188f70b0ddc2ef482fecad03c3`.
- Worker bundle SHA256 `18b99bb22453531a482d3b22360e5ac3c3672c49147747c083158a904e4a94b2`.
- ProcessHost SHA256 `f8dc79466770e9630e18ae9e0be826d044178b686157b528db2a5743642c07f6`.
- Pinned CLI SHA256 `83751f15cb6a0a7b97df67752c001e3fe1c20e18ffbfec3ff63567296205eb6c`.

All 64 production source inputs in the Windows bundle match the final v5 manifest; only tests and
formatting changed after that bundle's source capture. Remote source hashes matched before/after
tests and build-only verification. This handoff and final status edits postdate the tested capture.

## Continuation and scope

No real provider, model-quality comparison or dedicated VM deployment was exercised. The Windows
protocol fixture and complete synthetic WorkerService tests establish complementary scopes, not
one native Worker-main-to-Server run with a real provider. No provider credentials were fabricated
or recovered from closed fixtures. Further product/deployment integration can proceed without
restoring the retired OS-proof or legacy-data migration projects.

Server/SQLite verification stays on `ssh test-env`. Local authorization covered owned Windows
builds and controlled CLI tests. No accounts, firewall, registry, VM provisioning, desktop automation
or actual PR/Issue writes were performed. Never access or enumerate `apps/worker/.tmp-ui-driver-V7AOfu/`,
read old private configuration, reuse closed credentials or overwrite failed runs. No commit or push
was performed; transfers must include untracked files.
