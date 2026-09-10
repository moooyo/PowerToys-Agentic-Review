# Synthetic CLI review quality corpus

This is a deliberately small, fully labeled regression corpus. It is not a real PowerToys
quality benchmark and does not establish model quality on production pull requests. The two
regression classes and the fixed negative control are different evaluation cases, not repeated
model runs presented as additional examples.

`createQualityCorpus({ directory, gitExecutablePath, nodeExecutablePath, repoFullName })` creates
an exclusive new directory. `repoFullName` uses the existing
`agentic-review-fixture/workflow-<16 lowercase hex characters>` naming convention. A shared owned
bare Git repository contains three independent base/head pairs and `refs/pull/1/head` through
`refs/pull/3/head`. Each returned case has its own clean, detached head checkout and neutral review
prompt. No existing repository is committed or pushed; `hash-object`, `mktree`, `commit-tree`, and
local refs create only synthetic history in the new bare repository. Git configuration and hooks
are isolated. No external repository service or model is called.

PR titles, README titles, Git commit messages and branch names do not reveal the positive/negative
classification. The two percentage changes share the same neutral title; branches use `case-1`
through `case-3`. The Worker receives only execution scope metadata, while labels and full probe
results stay with the coordinator/Server. These input restrictions are not an OS containment claim:
inspect actual CLI tool traces after the real run before claiming that no tool accessed an oracle.

| Case | Ground truth | Representative measurement | Expected new findings |
| --- | --- | --- | --- |
| `percent-scaling-regression` | Removes percentage scaling | `applyDiscount(100, 25)`: base `75`, head `-2400` | `percent-points-must-be-scaled`, `src/discount.js:2` |
| `percent-scaling-fixed-control` | Restores the correct percentage calculation | `applyDiscount(100, 25)`: base `-2400`, head `75` | None; complete negative annotation |
| `capacity-inclusive-boundary-regression` | Changes inclusive capacity to a strict comparison | `fitsCapacity(7, 3, 10)`: base `true`, head `false` | `capacity-boundary-is-inclusive`, `src/capacity.js:2` |

Every revision is measured by a real Node process against source read from its exact Git commit.
Five probes per revision include passing ordinary inputs and the documented boundary or scaling
behavior. The two positive heads each fail three oracle probes. The fixed control changes from
three failed probes to zero. Every checked-out head also passes its deliberately partial
`check.mjs`. A passed smoke check does not establish correct review findings.

`quality-corpus.json` records source identities, SHA256 values, all expected and measured values,
and complete expected findings. `creation-receipt.json` retains Git/Node commands and failures.
Measurement scripts and annotations are outside every checkout. Do not copy these oracle files
or suite expectations into the Worker checkout, model prompt, or model tool input. Keep failed
directories; reruns require a new directory.

## Existing Evaluation API integration

Use the existing isolated Server owner and Evaluation APIs. Do not insert fabricated model
results, observations, occurrences, matching events, or score rows into its database.

1. Ingest each synthetic PR with its own PR number and the returned exact base/head. Capture its
   actual source through `captureEvaluationSource`. The current-work-item request contains
   `changeId` and `source: { kind: "current_work_item", workItemId, expectedRevisionKey,
   testedIssueCommit: null }`; the existing fixture revision key is SHA256 of
   `baseSha + "\0" + headSha`.
2. Create a `pr_static_build` / `headless` suite, then pass each captured source ID to
   `qualityCaseAnnotation(fixtureCase, captured.id)`. It returns the exact
   `EvaluationSuiteDraftCase` shape. All three use `findings.annotation: "complete"`; the fixed
   control has `expected: []`. Save the draft using the returned `draftRevision`, then publish it
   using the new returned revision. The `fixture-smoke` criterion expects `passed` in every case.
3. Create the batch with exact published baseline/candidate Prompt and profile versions.
   For every case, supply `{ caseId, criterionId: "fixture-smoke", baselineCheckId,
   candidateCheckId }`, where each check ID is the actual `<profile-version-id>:<step-id>` that
   runs `node check.mjs`. Both arms review each case's head against its base. Git base/head are
   source revisions; they are not Evaluation baseline/candidate arms.
4. Wait for real model results. Read `getEvaluationCellResult`, then
   `getEvaluationAdjudicationContext` with `{ repositoryId, evaluationId, cellId, resultId, actor }`.
   The HTTP read is `GET /api/v1/operator/repositories/:repositoryId/evaluations/:evaluationId/
   cells/:cellId/results/:resultId/adjudications`. Inspect the actual finding text and source before
   choosing a judgment; path/line or keyword coincidence is not a semantic match.
5. `qualityAdjudicationPayload({ fixture, context, occurrenceKey, changeId, judgment })` packages
   an explicit judgment about one occurrence already returned by the Server. It returns `scope`
   and the exact request `{ changeId, expectedVersion, resultDigest, judgment }`, preserving the
   current occurrence version and result digest. Call `changeEvaluationAdjudication` with
   `{ ...scope, actor, request }`, or `PUT` the request to the context URL plus `/:occurrenceKey`.
   Do not send actor, adjudication ID, or a timestamp in the HTTP request body; the Server owns
   those fields. On conflict, reload the context and reconsider the judgment.

Judgment payloads are:

```json
{"kind":"match","expectedFindingId":"percent-points-must-be-scaled","reason":"Reviewer explanation supported by the actual finding and measured source."}
{"kind":"match","expectedFindingId":"capacity-boundary-is-inclusive","reason":"Reviewer explanation supported by the actual finding and measured source."}
{"kind":"false_positive","reason":"Reviewer explanation of why this actual reported finding is not a defect in the documented head."}
{"kind":"duplicate","primaryOccurrenceKey":"<existing matched occurrence SHA256>","reason":"Reviewer explanation of the duplicate."}
{"kind":"unjudged","reason":"The available evidence does not support a final judgment."}
```

These are request templates, not observed findings. A missing expected finding has no occurrence
to mutate: the complete annotation lets the scorer account for it. A healthy result with no
findings needs no adjudication. Do not create a dummy finding to represent a negative example.

6. After adjudication, call `getEvaluationScorePreview({ repositoryId, evaluationId, actor })`,
   then `publishEvaluationAssessment({ repositoryId, evaluationId, actor, request: { changeId,
   expectedVersion: preview.assessmentVersion, expectedInputDigest: preview.inputDigest } })`.
   HTTP equivalents are `GET .../score-preview` and `POST .../assessments`. Retain the actual
   preview and published receipt. These operations write only to the isolated Evaluation store;
   they do not authorize external PR or issue operations.

The ideal target per arm is two matched expected findings, zero false positives, zero false
negatives, and one healthy control without findings. Precision/recall of 1 is a target, not a
precomputed result. Incomplete model output, missing execution, duplicate findings, unjudged
occurrences, and unavailable evidence must remain visible in the real scoring result. Do not
call an empty or unavailable model response a successful healthy control.

## Optional mode in the existing acceptance coordinator

Set `"qualityMode": "synthetic-v1"` in the existing `run.mjs` configuration and select exactly
one engine, `codex`. Keep the existing Windows/WSL paths and process-host configuration. For
example, the mode-specific configuration fields are:

```json
{
  "qualityMode": "synthetic-v1",
  "maximumRunMs": 3600000,
  "engines": [{ "engine": "codex", "cliExecutablePath": "C:\\Tools\\Codex\\codex.exe" }]
}
```

This fragment augments the complete configuration documented in `README.md`; it is not a
standalone configuration. The run command remains
`node deploy/worker/cli-workflow-acceptance/run.mjs <config.json> --allow-real-models`.
Real-model execution still requires its existing explicit authorization and source freeze.

The mode creates three ordinary tasks, captures their three real sources into one Evaluation,
then runs three cases in each of its two arms. All nine tasks use the same Worker instance and
engine. The Worker refuses a tenth CLI process. The default configuration still uses the
original one-case, three-task M39 workflow.

After all nine submissions the Server enters `awaiting_adjudication`, saves
`quality-review-ready.json`, stops dispatching, and stays open within `maximumRunMs`. No finding
is automatically labeled, including findings on the healthy control. The Worker waits without
starting more model processes. Root reads the actual finding text, source and oracle before
sending explicit judgments.

The existing local control token authenticates these additional endpoints:

- `GET /__acceptance/quality` returns all six actual Evaluation results and adjudication contexts,
  plus the frozen corpus. The three ordinary results are retained under `results/` and summarized
  by `GET /__acceptance/status`.
- `POST /__acceptance/adjudicate` accepts
  `{ "cellId": "<actual cell>", "resultId": "<actual result>", "occurrenceKey": "<actual key>",
  "request": { "changeId": "<new exact ID>", "expectedVersion": 0,
  "resultDigest": "<actual result digest>", "judgment": { "kind": "match",
  "expectedFindingId": "<frozen expected ID>", "reason": "<root's supported judgment>" } } }`.
  Use the version from the current context rather than assuming zero. The action is restricted
  to this batch's actual cell/result/occurrence, calls normal `changeEvaluationAdjudication`,
  retains an immutable receipt, and returns the refreshed context. All four judgment kinds above
  are supported; conflicting versions return an error rather than silently replacing a judgment.
- `POST /__acceptance/finalize` with an empty body or `{}` requires an explicit judgment for every
  existing occurrence. Empty healthy results require no dummy occurrence. An explicitly selected
  `unjudged` remains unjudged in scoring. The Server reads a real score preview, publishes the
  assessment with its actual input digest/version, then enters `complete` so normal Worker/Server
  closure can finish. Quality scores do not determine workflow success.

Keep the coordinator running while root adjudicates. Finalization is explicit; an unfinished
adjudication phase still obeys the existing workflow deadline and retains its artifacts.
