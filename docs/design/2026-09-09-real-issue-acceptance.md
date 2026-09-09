# Real Issue reproduction acceptance

Status: accepted for one disclosed, real reported timing claim. Overall platform delivery remains
in progress; Windows desktop, real model/Evaluation and deployment acceptance remain open.

## Actual report and source

The target is [fishjar/kiss-translator Issue #1064](https://github.com/fishjar/kiss-translator/issues/1064),
GitHub repository ID `667731914`, Issue ID `5295780029`. Its current open state, original title/body,
author and timestamps were retained from a public read. The reported release v2.0.32 resolves to
commit `7dfc03ebc7f10530681109f6a5aec982a5573936`.

The attached timedtext screenshot shows a speech event at `3839000` ms with `dDurationMs: 3000`,
followed by an append-newline event at `3848630` ms. The reported VTT ends at `3842000` ms.
The experiment uses a disclosed transcription of the two visible events, not a claimed original
JSON attachment or complete video transcript. A separate punctuation-space control checks the
visual ambiguity of spaces after Japanese full stops.

## Execution and deterministic conclusion

The production Windows WorkerService registered, claimed one mapped ordinary Issue validation job,
checked out the exact source, and ran the trusted probe through the native ProcessHost. The probe
verified the hashes of all 17 original modules in its import closure, then used Node's module VM to
call `prepareTimedTextEvents` and `runBuiltinSegmentation` without rewriting or substituting their
implementation. The VM is a controlled adapter for reviewed source, not a claim of OS-level
confinement for arbitrary repository programs. No model, package installation or target build was
needed for this source closure.

The actual flattened event and built-in cue both ended at `3842000` ms, giving `3000` ms rather
than the `9630` ms gap to the later newline. The whitespace control retained that same end time.
The probe exited zero to indicate successful measurement, not absence of the defect.

Before execution, the run froze the exact Issue revision, source commit, profile, probe fields,
preconditions and mutually exclusive present/absent signatures. The Worker and Server independently
evaluated the complete 19-field `TestProbeReceiptV1` and returned `confirmed`, with coverage limited
to this configured claim. The receipt is inline measurement evidence; no screenshot or trace asset
was fabricated for a headless probe.

Result digest: `1162b4c69956bbc5f57d2f4e64b7d7094c6c56cc9532aaa6f7d19fa08a5690c3`.

## Presentation and closure

The compiled production Dashboard showed the actual Issue, exact source commit, confirmed run,
present current/recorded case states, and the comparison of absent-signature value `3848630` with
observed value `3842000`. Browser console warnings/errors were empty. The first browser attempt
failed because the fixture omitted `/signed-out`; a distinct recovery-mode reader corrected its
route allowlist and used normal loopback login. It read the same completed result and did not
restart the Worker or change the experiment.

Readback preserved 19 selected business tables and 26 rows. The ingestion path had naturally
created an earlier unscheduled Run before an exact tested commit was supplied; it remains visible
and was not executed. Exactly one mapped Run, one Job and one attempt performed the measurement.
The Worker/Host closed, all 19 recorded process IDs were absent, attempt workspaces were empty,
both Server lifecycles ended before their deadlines, port 3285 was released locally and remotely,
and the temporary browser tab closed. Owned audit directories remain intact.

This is a real reported behavior measured through the platform, with explicitly synthetic internal
assignment authority and test credentials. It does not verify an installed extension, video
playback, complete VTT output, AI segmentation or translation-provider behavior. No actual repository
PR/Issue was created, edited, assigned, commented on or otherwise mutated.

The [full execution record](../../artifacts/m33-real-issue-20260909/REPORT.md) and
[composite acceptance](../../artifacts/m33-real-issue-20260909/delivery-acceptance.json) bind the
frozen inputs, actual observations, Server result, browser readback and resource closure.
