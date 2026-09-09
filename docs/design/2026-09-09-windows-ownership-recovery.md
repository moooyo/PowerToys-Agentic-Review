# Windows ownership recovery for transient descendants

Status: the ancestry and foreground corrections passed the complete 67-test native suite.
M34's real Worker positive/negative Notepad++ and Dashboard acceptance is complete; see the
[accepted handoff](../handoff/2026-09-09-windows-ui-accepted-handoff.md). Enforcement and broader
platform acceptance remain separate work.

## Recorded failure

The [paused handoff](../handoff/2026-09-09-validation-platform-paused-handoff.md) records a real
readiness regression: short-lived metadata helpers caused `ownership_lost` before the persistent
launcher's healthy GUI could execute any step. The original failing report and blocked Notepad++
Run remain unchanged. A successful build or terminal Job submission does not establish UI acceptance.

## Ownership rules

The [driver](../../apps/worker/src/ui/windows-driver-entry.ps1) now separates the required held
process chain from other descendants. The root is always required. Once a window or TCP listener
has been selected, its owner and complete held ancestor chain are also required. A missing identity,
cycle, creation-order mismatch or dead required process fails; a selected owner cannot fall back
to root-only validation.

Discovery uses the first parent snapshot and retains every successfully acquired process handle.
Unprovable non-required candidates and their descendants are ineligible. Retired PID identities
are never reopened or replaced, and the cumulative 128-identity limit remains in force.

A second snapshot confirms both recorded parent edges, session, creation order and current
liveness. Before publication, the entire candidate tree is pruned to convergence. If `R -> A -> B`
was admitted and A then exits, B cannot remain eligible merely because A was previously admitted.
The required chain is checked again before replacing the live set; a failed refresh leaves the
previous set unpublished as a new observation.

Window and UIA operations recheck held ancestry at use time. TCP verification protects the selected
listener during its second refresh and rechecks the chain after the final listener-table read.
Root creation FILETIME, pinned window PID/TID, UIA ancestry, unique selectors, interactive-session
requirements and watchdog behavior remain active.

These checks are successive observations, not an atomic OS process-tree snapshot. Existing HWND
reuse limitations are unchanged. A visible owned sibling that disappears during window enumeration
can still cause the existing enumeration path to block; this change addresses transient descendants
in ownership refresh, not every possible GUI-provider or window-enumeration race.

## Verification layers

- The original native readiness regression remains unchanged.
- New native cases exercise helper exit after pinning, selected owner exit, intermediate ancestor
  exit while the root and GUI remain alive, and a stable descendant TCP listener. Handshakes and
  cleanup are bounded; simultaneous assertion and cleanup failures are retained together.
- [Deterministic ownership tests](../../apps/worker/src/ui/windows-ownership-algorithm.test.ts)
  compile the actual production methods with test-only OS observations. They cover 22 cases,
  including reverse enumeration during pruning, retired identities, required ancestry, TCP
  confirmation and failure before live-set replacement. No synthetic process-tree input is added
  to the production protocol. An explicit SDK path enables this optional test layer.
- Full embedded production and fixture C# can be compiled against .NET Framework 4.8 references
  using C# 5 on the Linux verification host. This checks compiler compatibility, not Windows APIs,
  PowerShell execution, UIA behavior or application acceptance.

Source-bound reports are retained under `artifacts/m34-ancestry-20260909/verification/` and
`artifacts/m34-native-acceptance-20260909/verification/`. The user subsequently authorized the
current Windows machine for scoped builds and native/UI verification. The idle-input native run
passed 65 tests. Server/SQLite verification remains on Linux `ssh test-env`. New application
acceptance must use fresh execution identities and retain all old results, the shared desktop
lease, production ownership checks and actual evidence.

## Foreground correction after real application execution

Real Worker fixture v2 successfully built the pinned Notepad++ source, but its New toolbar Invoke
returned without creating the second tab. The original result and its four assets were read back
through the Dashboard and remain failed. Both standalone diagnostic applications started in the
background: the original driver reproduced the missing tab, while focusing the verified top-level
window before the single Invoke passed all six unchanged assertions. The production correction
also passed that six-step diagnostic, including physical hit testing. This is not Worker acceptance.

For a click, the driver now attempts one UIA SetFocus only when the pinned window is not foreground.
It verifies the exact root element and complete held ownership before and after that call. A
bounded foreground confirmation stays within the existing step watchdog. Synchronous provider
queries remain bounded by that watchdog; the polling deadline does not promise that an individual
provider query returns in one second.

After activation, the original locator must still identify the same unique element. The driver
rechecks enabled/non-secret/visible state, obtains the current InvokePattern, and validates finite
physical bounds. Immediately before the single Invoke, WindowFromPhysicalPoint must resolve the
rectangle center inside the pinned native root, with a live owned process chain, and the pinned
window must still be foreground. Another top-level window at that point blocks the action, even
when it belongs to the same fixture process. No second Invoke or direct input fallback is added.

This is a conservative project guard, not a universal UIA contract. Microsoft's
[public toolbar proxy](https://github.com/dotnet/wpf/blob/22c053cf86737384a222d37c79e211639ff20f91/src/Microsoft.DotNet.Wpf/src/UIAutomation/UIAutomationClientSideProviders/MS/Internal/AutomationProxies/WindowsToolbar.cs#L639)
sets the hot item before using a helper that injects a click at the button's screen-coordinate
center. The installed provider version was not identified. UIA SetFocus does not itself guarantee
foreground activation, and Invoke returning does not prove the expected application effect.
The final hit/foreground checks neither prove same-window control hit identity nor eliminate a
race before input inside an external provider. Effect assertions and owned evidence remain required.

The new native fixtures cover a background target becoming foreground before exactly one click,
and a separate owned TopMost window blocking the click center without invoking the target. Explicit
native harness evidence retention preserves the generated synthetic evidence under its checked
temporary root. Test setup failures and diagnostic failures remain separate from production Run
results and must not be converted into passes.

The final complete run is
`artifacts/m34-native-acceptance-20260909/verification/native-full-focus-v1/receipt.json`:
67 passed, zero failed/skipped, confirmed ProcessHost closure and desktop lease release. The
earlier focused preparation failures remain retained and described in
`artifacts/m34-native-acceptance-20260909/verification/focus-regression-diagnostics.md`.
Foreground acquisition is still an observed environment condition, not an unconditional OS
guarantee. No further fixture display-style change was made after the successful full run.
