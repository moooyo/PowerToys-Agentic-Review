# M42 Spectre installation and PowerToys build handoff

Installation, the scoped PowerToys build and seven selected Settings tests passed. This pass
started from local `main` at `bd4def6` and the remote baseline `bdfa577`; final local refs are in
the [delivery receipt](../../artifacts/m42-spectre-build-20260910/delivery.json). No project push
is authorized. These acceptance receipts do not claim a new full CI run. M42 made no GitHub
write or authentication-file read and required no production Worker change.

## Accepted installation and build

The user approved another elevation attempt, and both required Spectre components were installed.
[Verification](../../artifacts/m42-spectre-build-20260910/vs-components-run3/verification.json)
confirms registered components and expected libraries, zero remaining installer processes and no
reboot requirement. Visual Studio remains at `18.7.11925.98`. M41's exit-5007 and canceled-UAC
attempts and its historical handoff remain unchanged.

The checkout is `D:\AR\m40-0910\PowerToys`, pinned to
`3a1e642db52d45f88c0cb702b10663e1f65623f7`. M42 build run 1 failed with `MSB3073` / exit 9009:
the independent helper's minimal `PATH` lacked the standard Windows PowerShell directory. The
replacement artifact helper adds that directory only. The production Worker already uses the
configured account `PATH`; neither its code nor upstream PowerToys source/scripts were changed.

[Build run 2](../../artifacts/m42-spectre-build-20260910/powertoys-build-run2/receipt.json) passed
Restore, Runner and Settings UI compilation, each with zero warnings and zero errors. The clean
source preflight, all three native Host-managed process-tree completions, Host exit 0 and empty
cleanup failures are recorded. All 12 explicit upstream logs are retained with matching hashes in
the [retention receipt](../../artifacts/m42-spectre-build-20260910/powertoys-build-run2/upstream-retained/retention-receipt.json).
The earlier build failure remains separate evidence.

## Accepted selected tests and remaining scope

Settings unit-test helper session `37148` exited 0 after building the current test project and
passing exactly **7/7** existing serialization/mocked-storage tests, with zero skips. The
[run receipt](../../artifacts/m42-spectre-build-20260910/settings-tests-run1/receipt.json) retains
current-assembly hashes and the exact-method verification in `testVerification`, backed by the
[TRX](../../artifacts/m42-spectre-build-20260910/settings-tests-run1/results/powertoys-settings-smoke.trx). All seven
managed process trees completed, Host exited 0 and cleanup had no failures. The pinned source was
unchanged and clean after execution. These seven methods are not the full PowerToys unit-test suite.

No native PowerToys UI was launched, and the personal PowerToys instance was not changed. Actual
UI acceptance still needs an owned interactive environment, verified controls/evidence and state
restoration. Full Worker `main.ts` on the intended Windows VM, Issue triage, deployed OIDC and
broader model-quality/operational coverage remain separate work. M39/M40 model and M41 live
publication acceptance retain their exact recorded scopes; this is not whole-product completion.
