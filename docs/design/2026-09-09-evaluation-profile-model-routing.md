# Evaluation envelope and model routing

This increment connects frozen evaluation semantics to the existing profile executor. It does
not enable evaluation capability, remove either Worker execution guard, or accept model-backed
completion on the Server. Those boundaries still require actual environment and model acceptance.

## Frozen input validation

Ordinary Issue validation requires its existing selected-source authorization. An evaluation
instead has a separate frozen operator authorization and source manifest, and its legacy
`testedSourceAuthorization` must remain null. The Worker validates the complete evaluation
context and compares its source, repository, work item, revision, profile, Prompt and job/lease
identities with the outer envelope. Digest checks use the existing canonical contracts and domain
helpers. An evaluation marker cannot be downgraded to ordinary review semantics.

Validation of a consistent frozen document is not execution readiness. A required model without
an accepted, available runtime remains unavailable. Mapped Issue reproduction remains explicitly
unsupported for evaluation; this change does not invent an ordinary Issue authorization for it.

## Model selection

The profile executor resolves one model policy from the frozen workflow and model requirement:

| Context | Model step | Recording requirement |
| --- | --- | --- |
| Ordinary PR static/build or Issue triage | Required review | Existing parent configuration |
| Ordinary PR UI or Issue validation | Optional summary, subject to configuration | Existing parent configuration |
| Profile-only evaluation | No model step | None; configuration cannot promote it |
| Required-model static/build or triage evaluation | Required review | Original model output and invocation |
| Required-model UI or Issue validation evaluation | Required summary | Frozen composed input and ScopeV2 invocation |

The production dispatcher invokes neither model callback for profile-only evaluation. Required
model work cannot become `not_requested` because an executor is unavailable or returns that state.
It retains a typed failure and a model-stage blocker alongside unchanged runner facts. Required
recording selects the V2 result envelope before dispatch, including capacity reservation for a
failure result. Cancellation continues to propagate through the original owner signal.

Startup model factories independently reject profile-only or wrong-workflow evaluation requests.
An explicitly pinned evaluation summary backend can be prepared when ordinary optional summaries
are disabled. It uses the existing bounded summary defaults unless a summary timeout is configured;
it does not enable ordinary summaries. If required composition is missing, the executor reports
failure rather than selecting the legacy backend.

## Server completion

New profile-only evaluation completion rejects actual model content, including a V1 embedded
`report.modelSummary` and a completed model review. `not_requested` and `failed` remain valid
observations of absent model output. Ordinary optional summaries and existing historical V1 reads
retain their original contracts and bytes. Required-model evaluation completion keeps its existing
independent rejection boundary.

Verification covers pure frozen-input validation, callback dispatch and startup selection, ordinary
runner-result compatibility, all early execution guards, and real Linux completion ownership.
Passing these checks does not establish actual evaluation, Windows UI, provider or deployment
acceptance. No upstream PR/Issue mutation is authorized by this increment.
