# Dashboard interaction acceptance, 2026-09-27

## Status and scope

Both interaction phases are accepted: `production-v1` passed eight steps with three screenshots,
and the single `isolated-v1` run passed seven steps with five screenshots and exit code zero.
The results and all eight screenshots received independent review. Final operational closeout
passed on September 27 at 12:08:44 UTC, including temporary-task and credential removal and
production-state readback.

The documentation branch is based on `e38dbbc`. The actual production UI and runtime remain the
sealed `a6ae2995407037683e5be120f76e928aad212c4b` release; the later main changes are documentation
only. This work changes no product source. The earlier
[cutover browser record](2026-09-27-ci-and-production-cutover.md) retains its original six-step scope.

No real model, PowerToys build/UI scenario, new E2E Task, recording generation, or actual GitHub
publication is part of this acceptance. Private identities, machine addresses, credentials,
filesystem paths, and raw operational receipts remain outside the repository.

## Production observations

The existing production Dashboard completed eight browser steps with three screenshots:

- The native action-context request completed in 3.895 seconds. Other actions displayed seven
  disabled external operations, each with its native guard reason. The panel did not remain in
  its initial loading state.
- An existing PNG preview opened and closed, returning focus to the originating control.
- The real Play recording button started an existing 30-second MP4. Recorded playback time
  advanced by 0.15905 seconds. The HTML media API then demonstrated a stable pause and a seek to
  22.5 seconds. These observations do not establish pointer operation of browser-native controls.
- Close preview removed the video element and revoked its blob URL. Positive and negative
  controls distinguished a live preview URL from the disposed URL.

Independent review confirmed served index bytes matched the sealed release, all eight steps
passed, and all three screenshots showed the expected guarded actions, PNG dialog, and sought
video frame. The video screenshot displayed the retained clip at approximately 22 of 30 seconds.

The temporary authenticated session logged out, its current context was signed out, the browser
closed, and no owned Edge process remained. Independent before/after comparison matched every
retained digest for four Tasks, four Reports, and 47 evidence records. Four leases remained
released and ActionIntents remained zero. Production write, media, and webhook settings stayed
disabled. The three production Scheduled Tasks remained enabled and running.

After browser/session/process cleanup was confirmed, the follow-up dispatch for the business-state
summary and exact temporary-task cleanup returned `QEMU guest agent is not running`. That failed
dispatch remains an unknown-result receipt. The channel recovered with the same Windows boot,
QEMU process, and production generations; no VM or service restart occurred. Read-only inspection
found no output or helper for the old nonce, and the temporary task remained Ready. A fresh-nonce
conditional continuation then removed the exact temporary task and empty directory and confirmed
the business-state comparison. This does not identify the channel failure's root cause or accept
VM reboot behavior.

## Isolated preview recovery

The fixture used the native Server, current compiled Dashboard, a fresh SQLite database,
and a synthetic report. Dependency injection sets `enableExternalWrites=true` only to permit
local mocked preparation. There is no GitHub configuration or token, no Worker, and no actor
execution permission. Production flags were not changed.

The single run completed seven steps and produced five independently inspected screenshots:

- Zero selected findings prevented Preview and produced zero preparation POSTs.
- Closing a dirty draft displayed a confirmation with Keep editing. Returning to the editor,
  saving the draft, closing, and reopening retained its values.
- The predefined HTTP 503 occurred before native `createIntent`, with zero intents, an unchanged
  idempotency-record count, and an unchanged report digest. Recover preview used the identical
  payload and idempotency key, then native preparation stored exactly one intent.
- Edit feedback with an empty summary showed a client-side error and produced no preparation
  POST. Correcting the summary produced a new key, intent ID, and payload digest. Exactly two
  intents were stored, and the first intent's complete JSON remained unchanged.
- Confirmation remained disabled and was not clicked. Exactly three preparation POSTs comprised
  one injected failure and two native preparations. Execute, reconcile, import, upload, and
  outbound counts remained zero.

The synthetic session was revoked and a subsequent session read was unauthenticated. The browser
closed, the fixture stopped, and its child exited with code zero. Final independent readback
confirmed both temporary Scheduled Tasks, the empty temporary directory, and the generated
fixture credential were removed. No browser, fixture process, or fixture listener remained.
The isolated databases and receipts were retained. All original production business digests
still matched, all four leases remained released, and production ActionIntents remained zero.
The three permanent services and their generations were preserved. The VM retained its 4 GiB
configuration; the idle memory observation is not a capacity result.

## Historical observations and limits

The cutover screenshot captured action availability before its request completed. It did not
prove a persistent loading defect. The later response and guarded panel are separate observations;
the original screenshot and its limited claim remain unchanged. No product patch was needed to
wait for and inspect the response.

Existing PNG/MP4 playback does not establish new evidence capture, upload, GitHub playback, or
PowerToys feature behavior. The production action observations do not exercise external writes.
The isolated phase retains its synthetic inputs and independent evidence; it is not a real
repository workflow.

VM reboot/power-loss and abnormal-shutdown acceptance, long-term and concurrent capacity,
current-release real-model/PowerToys execution, actual publication, and the historical
Peek/Launcher/external HTTP 401 cases remain outside this follow-up.
