import * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE,
  type EvaluationAssessmentOperation,
  type EvaluationAssessmentOperationMap,
  type EvaluationAssessmentOptions,
  type EvaluationAssessmentRequest,
  evaluationAssessmentCaseProjection,
  handleEvaluationAssessmentRequest,
  prepareEvaluationAssessmentRequest,
} from "./evaluation-assessments.js";
import {
  beginAttempt,
  completedAt,
  createEvaluationCompletionFixture,
  type EvaluationCompletionFixture,
  resultFor,
  selected,
  settle,
  transaction,
  validate,
} from "./evaluation-completion.testing.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import { handleEvaluationManagementRequest } from "./evaluation-management.js";
import {
  evaluationActor,
  evaluationAdministrator,
  reviseEvaluationManagementSource,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import { evaluationScoreInputDigest } from "./evaluation-observations.js";
import * as resultSelectionQueries from "./evaluation-result-selection.js";
import * as scoringPlanQueries from "./evaluation-scoring-plan.js";
import { findingOccurrenceKey } from "./finding-disposition-projection.js";
import { insertHistoricalEvaluationResult } from "./historical-evaluation-results.testing.js";
import { handleRepositoryConfigurationRequest } from "./managed-repositories.js";
import { persistValidatedValidationResult } from "./validation-results.js";

const now = "2026-09-08T04:03:00.000Z";
const administrators = [evaluationAdministrator];
const fixtures: EvaluationCompletionFixture[] = [];
const formats = new Map(["date-time", "uri"].map((key) => [key, FormatRegistry.Get(key)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) value.close();
});
afterAll(() => {
  for (const [key, original] of formats) {
    if (original === undefined) FormatRegistry.Delete(key);
    else FormatRegistry.Set(key, original);
  }
});
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("The assessment fixture is incomplete.");
  return value;
}
function code(action: () => unknown, expected: string): void {
  expect(action).toThrow(expect.objectContaining({ code: expected }));
}
function fixture(kind: "issue" | "pull_request" = "issue") {
  const value = createEvaluationCompletionFixture(kind);
  fixtures.push(value);
  const input = {
    repositoryId: value.repositoryId,
    evaluationId: value.batch.id,
    actor: evaluationActor,
  };
  function request<K extends EvaluationAssessmentOperation>(
    operation: K,
    input: EvaluationAssessmentOperationMap[K]["input"],
    options: EvaluationAssessmentOptions = {},
  ): EvaluationAssessmentOperationMap[K]["output"] {
    return handleEvaluationAssessmentRequest(
      value.database,
      { operation, input } as EvaluationAssessmentRequest,
      now,
      administrators,
      options,
    ) as EvaluationAssessmentOperationMap[K]["output"];
  }
  const preview = () => request("getEvaluationScorePreview", input);
  const publishInput = (changeId = "publish-assessment", current = preview()) => ({
    ...input,
    request: {
      changeId,
      expectedVersion: current.assessmentVersion,
      expectedInputDigest: current.inputDigest,
    },
  });
  const storeFixtureResult = (
    arm: "baseline" | "candidate" = "baseline",
    observationTitles?: readonly string[],
  ) => {
    const cell = selected(value, arm);
    const completion = beginAttempt(value, cell);
    const body = resultFor(cell);
    if (observationTitles) {
      if (body.report.workItemKind !== "issue")
        throw new Error("The fixture requires Issue observations.");
      body.report.modelSummary = {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "issue",
        summary: "Synthetic observations in the original validation result.",
        reproductionConclusion: "inconclusive",
        observations: observationTitles.map((title, ordinal) => ({
          id: `observation-${ordinal}`,
          title,
          body: "An observation from the declared fixture check.",
          priority: 1,
          path: "src/example.ts",
          line: 7,
        })),
      };
      const archive = insertHistoricalEvaluationResult(value.database, cell, completion, body);
      return { cell, resultId: archive.resultId, resultDigest: archive.resultDigest };
    }
    const validated = validate(value, completion, body);
    const resultId = transaction(value.database, () => {
      settle(value.database, completion, validated);
      const id = persistValidatedValidationResult(
        value.database,
        completion,
        validated,
        completedAt,
      );
      value.database
        .prepare(
          "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
        )
        .run(completedAt, cell.jobId);
      return id;
    });
    return { cell, resultId, resultDigest: validated.resultDigest };
  };
  const counts = () =>
    value.database
      .prepare(`SELECT
    (SELECT COUNT(*) FROM evaluation_assessments) AS assessments,
    (SELECT COUNT(*) FROM evaluation_mutation_receipts) AS receipts`)
      .get();
  const caseInput = (assessment: C.EvaluationAssessmentSummaryV1) => ({
    ...input,
    assessmentId: assessment.assessmentId,
    caseId: present(assessment.caseIds[0]),
  });
  return {
    value,
    input,
    request,
    preview,
    publishInput,
    complete: (arm: "baseline" | "candidate" = "baseline") => storeFixtureResult(arm),
    archiveObservations: (arm: "baseline" | "candidate", titles: readonly string[]) =>
      storeFixtureResult(arm, titles),
    counts,
    caseInput,
  };
}

describe("evaluation assessment owner", () => {
  it("captures actual profile-only results and freezes honest unavailable evidence and model NA", () => {
    const f = fixture();
    const completed = f.complete();
    const preview = f.preview();
    expect(C.getEvaluationScorePreviewIssues(preview)).toEqual([]);
    expect(preview.assessmentVersion).toBe(0);
    expect(preview.inputDigest).toBe(
      evaluationScoreInputDigest({
        repositoryId: f.input.repositoryId,
        evaluationId: f.input.evaluationId,
        scorerVersion: preview.summary.rulesVersion,
        scoringPlanDigest: preview.scoringPlanDigest,
        observationDigest: preview.observationDigest,
        adjudicationDigest: preview.adjudicationDigest,
      }),
    );
    const published = f.request(
      "publishEvaluationAssessment",
      f.publishInput("publish-first", preview),
    );
    expect(C.getEvaluationAssessmentPublishResponseIssues(published)).toEqual([]);
    expect(published).toMatchObject({
      version: 1,
      scorerVersion: "explicit-matching-v2",
      createdAt: now,
      createdBy: evaluationActor,
      summary: preview.summary,
    });
    expect(published).not.toHaveProperty("selectionDigest");
    expect(published).not.toHaveProperty("inputDigest");
    const detail = f.request("getEvaluationAssessmentCase", f.caseInput(published));
    expect(C.getEvaluationAssessmentCaseIssues(detail)).toEqual([]);
    expect(detail.caseTitle).toBe("Known failing build");
    expect(detail.expectation.criteria[0]).toMatchObject({
      criterionId: "criterion-compiler",
      expectedOutcome: "failed",
    });
    expect(detail.case.baseline).toMatchObject({
      executionState: "completed",
      result: { resultId: completed.resultId, resultDigest: completed.resultDigest },
      criteria: [{ criterionId: "criterion-compiler", state: "unavailable" }],
      findings: { state: "not_applicable", modelAvailable: false },
    });
    expect(detail.case.candidate).toMatchObject({
      executionState: "queued",
      result: null,
      findings: { state: "not_applicable", modelAvailable: false },
    });
    const row = present(
      f.value.database
        .prepare(`SELECT observation_json, observation_digest,
      adjudication_json, adjudication_digest, report_json, report_digest FROM evaluation_assessments WHERE id = ?`)
        .get(published.assessmentId),
    ) as Record<string, string>;
    for (const kind of ["observation", "adjudication", "report"]) {
      const json = present(row[`${kind}_json`]);
      expect(json).toBe(canonicalJson(JSON.parse(json)));
      expect(sha256(json)).toBe(row[`${kind}_digest`]);
    }
    const observations = JSON.parse(
      present(row.observation_json),
    ) as C.EvaluationOwnerObservation[];
    expect(observations).toHaveLength(2);
    expect(observations.find((entry) => entry.arm === "baseline")).toMatchObject({
      result: { resultId: completed.resultId },
      checks: [{ evidenceAvailable: false }],
      model: { state: "not_applicable" },
    });
    expect(JSON.parse(present(row.adjudication_json))).toEqual([]);
    expect(f.value.database.isTransaction).toBe(false);
  });

  it("replays the original receipt before capture after inputs and the latest version change", () => {
    const f = fixture();
    const originalInput = f.publishInput();
    const first = f.request("publishEvaluationAssessment", originalInput);
    f.complete();
    const current = f.preview();
    expect(current.inputDigest).not.toBe(originalInput.request.expectedInputDigest);
    expect(current.assessmentVersion).toBe(1);
    const second = f.request(
      "publishEvaluationAssessment",
      f.publishInput("publish-second", current),
    );
    expect(second.version).toBe(2);
    const before = f.counts();
    const unavailableFacts = {
      selectionDigest: "f".repeat(64),
      cells: new Map(),
      assertCurrent() {
        throw new Error("Historical replay must not request current file facts.");
      },
    };
    const replayOptions: EvaluationAssessmentOptions[] = [
      {},
      { readOnly: true },
      { facts: unavailableFacts },
    ];
    for (const options of replayOptions)
      expect(f.request("publishEvaluationAssessment", originalInput, options)).toEqual(first);
    expect(
      f.request("publishEvaluationAssessment", { ...originalInput, replayOnly: true }),
    ).toEqual(first);
    expect(
      prepareEvaluationAssessmentRequest(
        f.value.database,
        { operation: "publishEvaluationAssessment", input: originalInput },
        administrators,
        { readOnly: true },
      ),
    ).toEqual({ kind: "replay", assessment: first });
    expect(
      f.request(
        "getEvaluationAssessment",
        {
          ...f.input,
          assessmentId: first.assessmentId,
        },
        { facts: unavailableFacts },
      ),
    ).toEqual(first);
    expect(f.counts()).toEqual(before);
    const page = f.request("listEvaluationAssessments", {
      ...f.input,
      query: { page: 2, pageSize: 1 },
    });
    expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [first] });
    expect(C.getEvaluationAssessmentListIssues(page)).toEqual([]);
    expect(f.request("listEvaluationAssessments", { ...f.input, query: {} }).items).toEqual([
      second,
      first,
    ]);
    expect(
      f.request("listEvaluationAssessments", { ...f.input, query: { page: 3, pageSize: 1 } }).items,
    ).toEqual([]);
  });

  it("rejects stale semantic input digests and assessment CAS without a report or receipt", () => {
    const f = fixture();
    const stale = f.publishInput();
    f.complete();
    const before = f.counts();
    code(() => f.request("publishEvaluationAssessment", stale), "PLATFORM_CONFLICT");
    expect(f.counts()).toEqual(before);
    const current = f.publishInput("current");
    f.request("publishEvaluationAssessment", current);
    const after = f.counts();
    code(
      () =>
        f.request("publishEvaluationAssessment", {
          ...current,
          request: { ...current.request, changeId: "stale-cas" },
        }),
      "PLATFORM_CONFLICT",
    );
    expect(f.counts()).toEqual(after);
  });

  it("checks the frozen plan once per list transaction without caching another request or authority", () => {
    const f = fixture();
    f.complete();
    const first = f.request("publishEvaluationAssessment", f.publishInput("first-list-version"));
    const second = f.request("publishEvaluationAssessment", f.publishInput("second-list-version"));
    const reader = vi.spyOn(scoringPlanQueries, "readEvaluationScoringPlanInTransaction");
    const resultReader = vi.spyOn(
      resultSelectionQueries,
      "readEvaluationResultSelectionInTransaction",
    );
    expect(f.request("listEvaluationAssessments", { ...f.input, query: {} }).items).toEqual([
      second,
      first,
    ]);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(resultReader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0]?.[1]).toEqual({
      repositoryId: f.input.repositoryId,
      evaluationId: f.input.evaluationId,
    });
    reader.mockClear();
    resultReader.mockClear();
    expect(f.request("listEvaluationAssessments", { ...f.input, query: {} }).items).toEqual([
      second,
      first,
    ]);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(resultReader).toHaveBeenCalledTimes(1);
    reader.mockClear();
    resultReader.mockClear();
    code(
      () =>
        f.request("listEvaluationAssessments", {
          ...f.input,
          repositoryId: f.value.secondRepositoryId,
          actor: evaluationAdministrator,
          query: {},
        }),
      "PLATFORM_NOT_FOUND",
    );
    expect(reader).not.toHaveBeenCalled();
    expect(resultReader).not.toHaveBeenCalled();
    setEvaluationManagementRole(f.value.database, f.value.repositoryId, null, 1);
    code(
      () => f.request("listEvaluationAssessments", { ...f.input, query: {} }),
      "PLATFORM_NOT_FOUND",
    );
    expect(reader).not.toHaveBeenCalled();
    expect(resultReader).not.toHaveBeenCalled();
  });

  it("bounds a reachable large NA report page before parsing snapshots and permits a complete size-one page", () => {
    const f = fixture();
    const suiteScope = {
      repositoryId: f.input.repositoryId,
      suiteId: f.value.suite.id,
      actor: evaluationActor,
    };
    const currentSuite = handleEvaluationManagementRequest(
      f.value.database,
      {
        operation: "getEvaluationSuite",
        input: suiteScope,
      },
      now,
      administrators,
    ) as C.EvaluationSuiteDetailV1;
    const draft = structuredClone(currentSuite.draft);
    // A case-level reason is copied to each criterion in both arms by the real scorer.
    // Twelve NA cases stay inside the suite and individual-case limits while producing >13 MiB reports.
    for (let index = 0; index < 12; index++)
      draft.cases.push({
        caseId: `large-na-${index}`,
        title: `Excluded target ${index}`,
        sourceId: f.value.source.id,
        applicability: { state: "not_applicable", reason: "界".repeat(2048) },
        findings: { annotation: "unlabeled", expected: [] },
        criteria: Array.from({ length: C.maximumEvaluationCriterionCount }, (_, criterion) => ({
          criterionId: `criterion-${criterion}`,
          description: "This criterion belongs to another target.",
          applicability: { state: "applicable" },
          expectedOutcome: "passed",
        })),
      });
    const saved = handleEvaluationManagementRequest(
      f.value.database,
      {
        operation: "saveEvaluationSuiteDraft",
        input: {
          ...suiteScope,
          request: {
            changeId: "save-large-page-suite",
            expectedRevision: currentSuite.draftRevision,
            draft,
          },
        },
      },
      now,
      administrators,
    ) as C.EvaluationSuiteSummaryV1;
    const version = handleEvaluationManagementRequest(
      f.value.database,
      {
        operation: "publishEvaluationSuite",
        input: {
          ...suiteScope,
          request: { changeId: "publish-large-page-suite", expectedRevision: saved.draftRevision },
        },
      },
      now,
      administrators,
    ) as C.EvaluationSuiteVersionV1;
    const batch = f.value.create({
      ...f.value.input,
      request: {
        ...f.value.input.request,
        changeId: "create-large-page-batch",
        suiteVersionId: version.id,
        mode: "profile_only",
        checkMappings: draft.cases.flatMap(({ caseId, criteria }) =>
          criteria.map(
            ({ criterionId }) =>
              f.value.input.request.checkMappings.find(
                (mapping) => mapping.caseId === caseId && mapping.criterionId === criterionId,
              ) ?? {
                caseId,
                criterionId,
                baselineCheckId: null,
                candidateCheckId: null,
              },
          ),
        ),
      },
    });
    const input = { ...f.input, evaluationId: batch.id };
    const preview = f.request("getEvaluationScorePreview", input);
    const published: C.EvaluationAssessmentSummaryV1[] = [];
    for (let index = 0; index < 5; index++)
      published.push(
        f.request("publishEvaluationAssessment", {
          ...input,
          request: {
            changeId: `publish-large-page-${index}`,
            expectedVersion: index,
            expectedInputDigest: preview.inputDigest,
          },
        }),
      );
    const lengths = present(
      f.value.database
        .prepare(`SELECT COUNT(*) AS count,
      MIN(length(CAST(report_json AS BLOB))) AS minimum_report_bytes,
      SUM(length(CAST(report_json AS BLOB)) + length(CAST(observation_json AS BLOB)) + length(CAST(adjudication_json AS BLOB))) AS bytes
      FROM evaluation_assessments WHERE evaluation_id = ?`)
        .get(batch.id),
    ) as { count: number; minimum_report_bytes: number; bytes: number };
    expect(lengths.count).toBe(5);
    expect(lengths.minimum_report_bytes).toBeGreaterThan(13 * 1024 * 1024);
    expect(lengths.bytes).toBeGreaterThan(64 * 1024 * 1024);
    const changes = () =>
      present(f.value.database.prepare("SELECT total_changes() AS count").get()) as {
        count: number;
      };
    const before = changes();
    const parse = vi.spyOn(JSON, "parse");
    const reader = vi.spyOn(scoringPlanQueries, "readEvaluationScoringPlanInTransaction");
    let failure: unknown;
    try {
      f.request("listEvaluationAssessments", { ...input, query: { page: 1, pageSize: 5 } });
    } catch (error) {
      failure = error;
    }
    const parseCount = parse.mock.calls.length,
      planCount = reader.mock.calls.length;
    parse.mockRestore();
    reader.mockRestore();
    expect(failure).toMatchObject({
      code: "PLATFORM_INVALID",
      message: EVALUATION_ASSESSMENT_PAGE_WORK_LIMIT_MESSAGE,
    });
    expect(parseCount).toBe(0);
    expect(planCount).toBe(0);
    expect(changes()).toEqual(before);
    const one = f.request("listEvaluationAssessments", {
      ...input,
      query: { page: 1, pageSize: 1 },
    });
    expect(one).toMatchObject({ page: 1, pageSize: 1, total: 5, items: [present(published[4])] });
    expect(C.getEvaluationAssessmentListIssues(one)).toEqual([]);
    expect(changes()).toEqual(before);
  }, 120_000);

  it("reads and replays an archived v1 all-unexecuted report without applying the current scorer", () => {
    const f = fixture("pull_request");
    const current = f.request("publishEvaluationAssessment", f.publishInput("current-rules"));
    const original = present(
      f.value.database
        .prepare(`SELECT assessment.observation_json, evaluation.scoring_plan_json
      FROM evaluation_assessments AS assessment JOIN evaluations AS evaluation ON evaluation.id = assessment.evaluation_id
      WHERE assessment.id = ?`)
        .get(current.assessmentId),
    ) as { observation_json: string; scoring_plan_json: string };
    const observations = JSON.parse(original.observation_json) as C.EvaluationOwnerObservation[];
    const plan = JSON.parse(original.scoring_plan_json) as C.EvaluationScoringPlanV1;
    const expected = present(plan.cases[0]);
    expect(plan.cases).toHaveLength(1);
    expect(expected.criteria).toHaveLength(1);
    expect(expected.findings.expected).toEqual([]);
    expect(
      observations.every((entry) => entry.executionState === "not_run" && entry.result === null),
    ).toBe(true);
    // Independently authored v1 archive data for an entirely unexecuted required-model matrix.
    // This tests historical reads; it does not claim the v1 scorer or any model was executed.
    const emptyRatio = { numerator: 0, denominator: 0, value: null };
    const uncovered = { numerator: 0, denominator: 1, value: 0 };
    const findings: C.EvaluationFindingAssessment = {
      annotation: "complete",
      state: "unavailable",
      reason: "No completed model result was captured.",
      modelAvailable: false,
      expected: [],
      occurrences: [],
      truePositives: 0,
      falsePositives: 0,
      duplicates: 0,
      unjudged: 0,
      falseNegatives: 0,
      unresolvedExpected: 0,
      knownPositiveRecall: emptyRatio,
      precision: emptyRatio,
      recall: emptyRatio,
    };
    const arm = (name: C.EvaluationArm): C.EvaluationArmCaseAssessment => ({
      ...expected[`${name}Binding`],
      executionState: "not_run",
      executionReason: present(observations.find((entry) => entry.arm === name)).reason,
      result: null,
      findings: structuredClone(findings),
      criteria: expected.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        checkId: criterion[`${name}CheckId`],
        state: "not_run",
        actualOutcome: null,
        reason: "The planned cell has not run.",
      })),
    });
    const aggregate: C.EvaluationArmAggregate = {
      coverage: {
        applicableCases: 1,
        notApplicableCases: 0,
        completedCases: 0,
        pendingCases: 0,
        notRunCases: 1,
        failedCases: 0,
        blockedCases: 0,
        cancelledCases: 0,
        invalidCases: 0,
        execution: uncovered,
        applicableCriteria: 1,
        scoredCriteria: 0,
        unmappedCriteria: 0,
        unavailableCriteria: 0,
        notRunCriteria: 1,
        notApplicableCriteria: 0,
        checks: uncovered,
        availableModels: 0,
        models: uncovered,
        completeAnnotationCases: 1,
        partialAnnotationCases: 0,
        unlabeledCases: 0,
        provisionalFindingCases: 0,
      },
      quality: {
        correctChecks: 0,
        incorrectChecks: 0,
        checkAgreement: emptyRatio,
        truePositives: 0,
        falsePositives: 0,
        duplicates: 0,
        unjudged: 0,
        falseNegatives: 0,
        unresolvedExpected: 0,
        knownPositiveRecall: emptyRatio,
        precision: emptyRatio,
        recall: emptyRatio,
        provisional: true,
      },
    };
    const emptyPairs = {
      compared: 0,
      improved: 0,
      regressed: 0,
      unchanged: 0,
      coverageImproved: 0,
      coverageRegressed: 0,
      unavailable: 0,
      notApplicable: 0,
      coverage: emptyRatio,
    };
    const report: C.EvaluationScoringReportV1 = {
      schemaVersion: "EvaluationScoringReportV1",
      rulesVersion: "explicit-matching-v1",
      planDigest: current.scoringPlanDigest,
      cases: [
        {
          caseId: expected.caseId,
          applicable: true,
          baseline: arm("baseline"),
          candidate: arm("candidate"),
          paired: {
            criteria: expected.criteria.map((entry) => ({
              criterionId: entry.criterionId,
              change: "unavailable",
            })),
            findings: [],
            modelCoverage: "unavailable",
            falsePositiveDelta: null,
            duplicateDelta: null,
          },
        },
      ],
      baseline: aggregate,
      candidate: structuredClone(aggregate),
      paired: {
        criteria: { ...emptyPairs, compared: 1, unavailable: 1, coverage: uncovered },
        findings: emptyPairs,
      },
    };
    C.assertEvaluationScoringReport(report);
    const reportJson = canonicalJson(report);
    const archived: C.EvaluationAssessmentSummaryV1 = {
      ...current,
      assessmentId: "archived-v1-assessment",
      version: 2,
      scorerVersion: "explicit-matching-v1",
      reportDigest: sha256(reportJson),
      summary: {
        rulesVersion: report.rulesVersion,
        planDigest: report.planDigest,
        baseline: report.baseline,
        candidate: report.candidate,
        paired: report.paired,
      },
    };
    const input = {
      ...f.input,
      request: {
        changeId: "archived-v1-publication",
        expectedVersion: 1,
        expectedInputDigest: evaluationScoreInputDigest({
          repositoryId: f.input.repositoryId,
          evaluationId: f.input.evaluationId,
          scorerVersion: archived.scorerVersion,
          scoringPlanDigest: archived.scoringPlanDigest,
          observationDigest: archived.observationDigest,
          adjudicationDigest: archived.adjudicationDigest,
        }),
      },
    };
    transaction(f.value.database, () => {
      f.value.database
        .prepare(`INSERT INTO evaluation_assessments
        (id,evaluation_id,repository_id,version,scorer_version,scoring_plan_digest,observation_digest,adjudication_digest,
         observation_json,adjudication_json,report_digest,report_json,actor_issuer,actor_subject,change_id,created_at)
        SELECT ?,evaluation_id,repository_id,2,'explicit-matching-v1',scoring_plan_digest,observation_digest,adjudication_digest,
          observation_json,adjudication_json,?,?,actor_issuer,actor_subject,?,created_at
        FROM evaluation_assessments WHERE id = ?`)
        .run(
          archived.assessmentId,
          archived.reportDigest,
          reportJson,
          input.request.changeId,
          current.assessmentId,
        );
      f.value.database
        .prepare(`INSERT INTO evaluation_mutation_receipts
        (repository_id,change_id,operation,entity_id,intent_digest,actor_issuer,actor_subject,previous_version,version,response_json,created_at)
        VALUES (?,?,'assessment_published',?,?,?,?,1,2,?,?)`)
        .run(
          f.input.repositoryId,
          input.request.changeId,
          archived.assessmentId,
          sha256(canonicalJson({ operation: "publishEvaluationAssessment", input })),
          f.input.actor.issuer,
          f.input.actor.subject,
          canonicalJson(archived),
          now,
        );
    });
    expect(
      f.request("getEvaluationAssessment", { ...f.input, assessmentId: archived.assessmentId }),
    ).toEqual(archived);
    expect(f.request("getEvaluationAssessmentCase", f.caseInput(archived)).case).toEqual(
      present(report.cases[0]),
    );
    expect(f.request("publishEvaluationAssessment", input, { readOnly: true })).toEqual(archived);
    expect(f.preview().summary.rulesVersion).toBe("explicit-matching-v2");
  });

  it("requires review for publication and rechecks current permission before replay or recovery", () => {
    const f = fixture();
    setEvaluationManagementRole(f.value.database, f.value.repositoryId, "reviewer", 1);
    const input = f.publishInput();
    const published = f.request("publishEvaluationAssessment", input);
    setEvaluationManagementRole(f.value.database, f.value.repositoryId, "viewer", 2);
    expect(
      f.request("getEvaluationAssessment", { ...f.input, assessmentId: published.assessmentId }),
    ).toEqual(published);
    expect(f.preview().assessmentVersion).toBe(1);
    const before = f.counts();
    code(
      () => f.request("publishEvaluationAssessment", input, { readOnly: true }),
      "PLATFORM_FORBIDDEN",
    );
    code(
      () =>
        prepareEvaluationAssessmentRequest(
          f.value.database,
          { operation: "publishEvaluationAssessment", input },
          administrators,
          { readOnly: true },
        ),
      "PLATFORM_FORBIDDEN",
    );
    setEvaluationManagementRole(f.value.database, f.value.repositoryId, null, 3);
    code(() => f.request("publishEvaluationAssessment", input), "PLATFORM_NOT_FOUND");
    code(() => f.preview(), "PLATFORM_NOT_FOUND");
    code(
      () => f.request("getEvaluationAssessmentCase", f.caseInput(published)),
      "PLATFORM_NOT_FOUND",
    );
    expect(f.counts()).toEqual(before);
  });

  it("independently enforces startup read-only and trusted replay-only without allowing a new write", () => {
    const f = fixture();
    const input = f.publishInput();
    const before = f.counts();
    for (const [selectedInput, options] of [
      [input, { readOnly: true }],
      [{ ...input, replayOnly: true }, {}],
    ] as const) {
      code(
        () => f.request("publishEvaluationAssessment", selectedInput, options),
        "DATABASE_READ_ONLY",
      );
      code(
        () =>
          prepareEvaluationAssessmentRequest(
            f.value.database,
            { operation: "publishEvaluationAssessment", input: selectedInput },
            administrators,
            options,
          ),
        "DATABASE_READ_ONLY",
      );
    }
    expect(
      prepareEvaluationAssessmentRequest(
        f.value.database,
        { operation: "getEvaluationScorePreview", input: f.input },
        administrators,
        { readOnly: true },
      ),
    ).toEqual({
      kind: "capture",
      scope: { repositoryId: f.input.repositoryId, evaluationId: f.input.evaluationId },
    });
    expect(f.counts()).toEqual(before);
  });

  it("binds the globally unique change ID to exact operation, scope, actor, and payload", () => {
    const f = fixture();
    const input = f.publishInput();
    f.request("publishEvaluationAssessment", input);
    const before = f.counts();
    for (const changed of [
      { ...input, actor: evaluationAdministrator },
      { ...input, evaluationId: "different-evaluation" },
      { ...input, request: { ...input.request, expectedVersion: 1 } },
      { ...input, request: { ...input.request, expectedInputDigest: "f".repeat(64) } },
      { ...input, request: { ...input.request, changeId: "batch-capture-source" } },
    ])
      code(() => f.request("publishEvaluationAssessment", changed), "PLATFORM_CONFLICT");
    expect(f.counts()).toEqual(before);
  });

  it("keeps published titles, expectations, report bytes, and summaries after source and draft edits", () => {
    const f = fixture();
    f.complete();
    const published = f.request("publishEvaluationAssessment", f.publishInput());
    const oldCase = f.request("getEvaluationAssessmentCase", f.caseInput(published));
    const suite = handleEvaluationManagementRequest(
      f.value.database,
      {
        operation: "getEvaluationSuite",
        input: {
          repositoryId: f.value.repositoryId,
          actor: evaluationActor,
          suiteId: f.value.suite.id,
        },
      },
      now,
      administrators,
    ) as C.EvaluationSuiteDetailV1;
    const draft = structuredClone(suite.draft);
    const edited = present(draft.cases[0]);
    edited.title = "Later unpublished title";
    present(edited.criteria[0]).description = "A changed unpublished expectation.";
    present(edited.criteria[0]).expectedOutcome = "passed";
    handleEvaluationManagementRequest(
      f.value.database,
      {
        operation: "saveEvaluationSuiteDraft",
        input: {
          repositoryId: f.value.repositoryId,
          actor: evaluationActor,
          suiteId: f.value.suite.id,
          request: {
            changeId: "change-assessment-draft",
            expectedRevision: suite.draftRevision,
            draft,
          },
        },
      },
      now,
      administrators,
    );
    reviseEvaluationManagementSource(f.value, "A later upstream issue description.");
    transaction(f.value.database, () =>
      cancelEvaluationBatchInTransaction(
        f.value.database,
        {
          ...f.input,
          request: {
            changeId: "cancel-after-assessment",
            expectedVersion: 1,
            reason: "Stop unexecuted cells.",
          },
        },
        now,
        administrators,
      ),
    );
    const version = present(
      f.value.database
        .prepare("SELECT version FROM managed_repositories WHERE id = ?")
        .get(f.value.repositoryId),
    ) as { version: number };
    handleRepositoryConfigurationRequest(
      f.value.database,
      {
        operation: "updateManagedRepository",
        input: {
          repositoryId: f.value.repositoryId,
          actor: evaluationAdministrator,
          request: { expectedVersion: version.version, enabled: false },
        },
      },
      now,
      { actor: evaluationAdministrator, administrators },
    );
    expect(
      f.request("getEvaluationAssessmentCase", f.caseInput(published), { readOnly: true }),
    ).toEqual(oldCase);
    expect(
      f.request("getEvaluationAssessment", { ...f.input, assessmentId: published.assessmentId }),
    ).toEqual(published);
    expect(() =>
      f.value.database
        .prepare("UPDATE evaluation_assessments SET report_json = report_json WHERE id = ?")
        .run(published.assessmentId),
    ).toThrow();
    expect(() =>
      f.value.database
        .prepare("DELETE FROM evaluation_assessments WHERE id = ?")
        .run(published.assessmentId),
    ).toThrow();
  });

  it("preserves exact selectors and denies foreign repository, assessment, case, and unsupported input fields", () => {
    const f = fixture();
    const published = f.request("publishEvaluationAssessment", f.publishInput());
    for (const input of [
      {
        ...f.caseInput(published),
        repositoryId: f.value.secondRepositoryId,
        actor: evaluationAdministrator,
      },
      { ...f.caseInput(published), evaluationId: "missing-evaluation" },
      { ...f.caseInput(published), assessmentId: "missing-assessment" },
      { ...f.caseInput(published), caseId: "missing-case" },
    ])
      code(() => f.request("getEvaluationAssessmentCase", input), "PLATFORM_NOT_FOUND");
    code(
      () =>
        f.request("getEvaluationAssessmentCase", {
          ...f.caseInput(published),
          caseId: `${present(published.caseIds[0])}\n`,
        }),
      "PLATFORM_INVALID",
    );
    code(
      () => f.request("listEvaluationAssessments", { ...f.input, query: { pageSize: 51 } }),
      "PLATFORM_INVALID",
    );
    code(
      () =>
        handleEvaluationAssessmentRequest(
          f.value.database,
          {
            operation: "publishEvaluationAssessment",
            input: { ...f.publishInput("illegal"), observations: [] },
          } as unknown as EvaluationAssessmentRequest,
          now,
          administrators,
        ),
      "PLATFORM_INVALID",
    );
    code(
      () =>
        handleEvaluationAssessmentRequest(
          f.value.database,
          {
            operation: "publishEvaluationAssessment",
            input: { ...f.publishInput("false-replay"), replayOnly: false },
          } as unknown as EvaluationAssessmentRequest,
          now,
          administrators,
        ),
      "PLATFORM_INVALID",
    );
  });

  it("rolls back only the nested operation when the receipt fails after report insertion", () => {
    const f = fixture();
    const input = f.publishInput();
    const before = f.counts();
    // This fault adds a constraint; it does not bypass any production guard.
    f.value.database.exec(`CREATE TEMP TRIGGER reject_assessment_receipt BEFORE INSERT ON evaluation_mutation_receipts
      WHEN NEW.operation = 'assessment_published' BEGIN SELECT RAISE(ABORT, 'synthetic receipt write failure'); END`);
    transaction(f.value.database, () => {
      expect(() => f.request("publishEvaluationAssessment", input)).toThrow(
        "synthetic receipt write failure",
      );
      expect(f.value.database.isTransaction).toBe(true);
      expect(f.counts()).toEqual(before);
      f.value.database.exec("DROP TRIGGER reject_assessment_receipt");
      expect(f.request("publishEvaluationAssessment", input).version).toBe(1);
    });
    expect(f.value.database.isTransaction).toBe(false);
  });

  it("rejects expired prepared facts atomically instead of publishing a historical availability bit", () => {
    const f = fixture();
    const input = f.publishInput();
    const before = f.counts();
    expect(() =>
      f.request("publishEvaluationAssessment", input, {
        facts: {
          selectionDigest: "f".repeat(64),
          cells: new Map(),
          assertCurrent() {
            throw new Error("The evidence identity changed after preflight.");
          },
        },
      }),
    ).toThrow("The evidence identity changed after preflight.");
    expect(f.counts()).toEqual(before);
  });

  it("validates archived actual provenance and preserves conservative or reordered historical inputs", () => {
    const mutations: ((
      observations: C.EvaluationOwnerObservation[],
      report: C.EvaluationScoringReportV1,
    ) => void)[] = [
      (observations) => {
        present(observations[0]).repositoryId = "foreign-repository";
      },
      (_observations, report) => {
        present(report.cases[0]).baseline.runId = "foreign-run";
      },
      (_observations, report) => {
        const result = present(present(report.cases[0]).baseline.result);
        result.resultDigest = "e".repeat(64);
      },
      (_observations, report) => {
        present(report.cases[0]).baseline.executionState = "not_run";
      },
      (_observations, report) => {
        present(present(report.cases[0]).baseline.criteria[0]).actualOutcome = "passed";
      },
      (_observations, report) => {
        expect(present(report.cases[0]).candidate.result).toBeNull();
        present(present(report.cases[0]).candidate.criteria[0]).actualOutcome = "passed";
      },
      (observations, report) => {
        present(present(observations[0]).result).resultId = "nonexistent-result";
        present(present(report.cases[0]).baseline.result).resultId = "nonexistent-result";
      },
      (observations, report) => {
        present(present(observations[0]).result).jobId = "nonexistent-job";
        present(present(report.cases[0]).baseline.result).jobId = "nonexistent-job";
      },
      (observations, report) => {
        present(present(observations[0]).result).resultDigest = "e".repeat(64);
        present(present(report.cases[0]).baseline.result).resultDigest = "e".repeat(64);
      },
      (observations, report) => {
        present(present(observations[0]).result).runAttemptId = "nonexistent-attempt";
        present(present(report.cases[0]).baseline.result).runAttemptId = "nonexistent-attempt";
      },
      (observations) => {
        present(present(observations[0]).checks[0]).outcome = "passed";
      },
      (observations) => {
        const observed = present(observations[0]);
        present(observed.checks[0]).checkId =
          `${present(observed.result).profileVersionId}:invented-check`;
      },
      (observations) => {
        present(observations[0]).sourceState = "modified";
      },
      (observations) => {
        present(observations[0]).model = {
          state: "complete",
          evidenceAvailable: false,
          modelIdentityDigest: null,
          occurrenceKeys: [],
        };
      },
    ];
    const modelOccurrences = (
      observations: C.EvaluationOwnerObservation[],
      ordinals: readonly number[],
    ) => {
      const observed = present(observations[0]),
        result = present(observed.result);
      observed.model = {
        state: "complete",
        evidenceAvailable: false,
        modelIdentityDigest: null,
        occurrenceKeys: ordinals.map((ordinal) =>
          findingOccurrenceKey({
            resultId: result.resultId,
            resultDigest: result.resultDigest,
            kind: "validation_observation",
            ordinal,
          }),
        ),
      };
    };
    const variants = [
      ...mutations.map((mutate) => ({ mutate, actualObservations: false, accepted: false })),
      {
        mutate: (observations: C.EvaluationOwnerObservation[]) =>
          modelOccurrences(observations, [1, 0]),
        actualObservations: true,
        accepted: true,
      },
      {
        mutate: (observations: C.EvaluationOwnerObservation[]) =>
          modelOccurrences(observations, [0]),
        actualObservations: true,
        accepted: false,
      },
      {
        mutate: (observations: C.EvaluationOwnerObservation[]) =>
          modelOccurrences(observations, [0, 2]),
        actualObservations: true,
        accepted: false,
      },
      {
        mutate: (observations: C.EvaluationOwnerObservation[]) => {
          present(observations[0]).checks = [];
        },
        actualObservations: false,
        accepted: true,
      },
      {
        mutate: (
          _observations: C.EvaluationOwnerObservation[],
          report: C.EvaluationScoringReportV1,
        ) => {
          present(present(report.cases[0]).baseline.criteria[0]).actualOutcome = null;
        },
        actualObservations: false,
        accepted: true,
      },
    ];
    for (const { mutate, actualObservations, accepted } of variants) {
      const f = fixture();
      if (actualObservations)
        f.archiveObservations("baseline", ["First observation", "Second observation"]);
      else f.complete("baseline");
      const first = f.request("publishEvaluationAssessment", f.publishInput());
      const snapshots = present(
        f.value.database
          .prepare(`SELECT observation_json, report_json FROM evaluation_assessments WHERE id = ?`)
          .get(first.assessmentId),
      ) as { observation_json: string; report_json: string };
      const observations = JSON.parse(snapshots.observation_json) as C.EvaluationOwnerObservation[];
      const report = JSON.parse(snapshots.report_json) as C.EvaluationScoringReportV1;
      mutate(observations, report);
      C.assertEvaluationOwnerObservations(observations);
      C.assertEvaluationScoringReport(report);
      const observationJson = canonicalJson(observations),
        reportJson = canonicalJson(report);
      const archived: C.EvaluationAssessmentSummaryV1 = {
        ...first,
        assessmentId: "invalid-archive",
        version: 2,
        observationDigest: sha256(observationJson),
        reportDigest: sha256(reportJson),
      };
      const input = {
        ...f.input,
        request: {
          changeId: "invalid-archive-receipt",
          expectedVersion: 1,
          expectedInputDigest: evaluationScoreInputDigest({
            repositoryId: f.input.repositoryId,
            evaluationId: f.input.evaluationId,
            scorerVersion: archived.scorerVersion,
            scoringPlanDigest: archived.scoringPlanDigest,
            observationDigest: archived.observationDigest,
            adjudicationDigest: archived.adjudicationDigest,
          }),
        },
      };
      // Isolated archives pass every production SQL guard and have recomputed snapshot digests.
      // These fixtures test identity compatibility, not historical score arithmetic or model execution.
      transaction(f.value.database, () => {
        f.value.database
          .prepare(`INSERT INTO evaluation_assessments
          (id,evaluation_id,repository_id,version,scorer_version,scoring_plan_digest,observation_digest,adjudication_digest,
          observation_json,adjudication_json,report_digest,report_json,actor_issuer,actor_subject,change_id,created_at)
          SELECT ?,evaluation_id,repository_id,2,scorer_version,scoring_plan_digest,?,adjudication_digest,
            ?,adjudication_json,?,?,actor_issuer,actor_subject,?,created_at
          FROM evaluation_assessments WHERE id = ?`)
          .run(
            archived.assessmentId,
            archived.observationDigest,
            observationJson,
            archived.reportDigest,
            reportJson,
            input.request.changeId,
            first.assessmentId,
          );
        f.value.database
          .prepare(`INSERT INTO evaluation_mutation_receipts
          (repository_id,change_id,operation,entity_id,intent_digest,actor_issuer,actor_subject,previous_version,version,response_json,created_at)
          VALUES (?,?,'assessment_published',?,?,?,?,1,2,?,?)`)
          .run(
            f.input.repositoryId,
            input.request.changeId,
            archived.assessmentId,
            sha256(canonicalJson({ operation: "publishEvaluationAssessment", input })),
            f.input.actor.issuer,
            f.input.actor.subject,
            canonicalJson(archived),
            now,
          );
      });
      const read = () =>
        f.request("getEvaluationAssessment", { ...f.input, assessmentId: archived.assessmentId });
      const replay = () => f.request("publishEvaluationAssessment", input, { readOnly: true });
      if (accepted) {
        expect(read()).toEqual(archived);
        expect(replay()).toEqual(archived);
      } else {
        code(read, "PLATFORM_CORRUPT");
        code(replay, "PLATFORM_CORRUPT");
      }
      expect(
        f.request("getEvaluationAssessment", { ...f.input, assessmentId: first.assessmentId }),
      ).toEqual(first);
    }
  }, 60_000);

  it("requires the original historical adjudication event and preserves its old version after a new head", () => {
    const f = fixture();
    const completed = f.archiveObservations("baseline", [
      "First observation",
      "Second observation",
    ]);
    const first = f.request(
      "publishEvaluationAssessment",
      f.publishInput("before-historical-audit"),
    );
    const original = present(
      f.value.database
        .prepare("SELECT observation_json FROM evaluation_assessments WHERE id = ?")
        .get(first.assessmentId),
    ) as { observation_json: string };
    const observations = JSON.parse(original.observation_json) as C.EvaluationOwnerObservation[];
    const observed = present(observations.find((entry) => entry.arm === "baseline"));
    const keys = [0, 1].map((ordinal) =>
      findingOccurrenceKey({
        resultId: completed.resultId,
        resultDigest: completed.resultDigest,
        kind: "validation_observation",
        ordinal,
      }),
    );
    observed.model = {
      state: "complete",
      evidenceAvailable: false,
      modelIdentityDigest: null,
      occurrenceKeys: keys,
    };
    const observationJson = canonicalJson(observations);
    const originalJudgment: C.EvaluationFindingAdjudication = {
      adjudicationId: "historical-audit-one",
      caseId: observed.caseId,
      arm: "baseline",
      resultId: completed.resultId,
      resultDigest: completed.resultDigest,
      occurrenceKey: present(keys[0]),
      kind: "false_positive",
      reason: "The original reviewer rejected this observation.",
      actor: evaluationActor,
      createdAt: now,
    };
    // These explicit import fixtures prove immutable audit binding, not current model-gated write eligibility.
    const seedAudit = (
      judgment: C.EvaluationFindingAdjudication,
      version: number,
      previousEventId: string | null,
    ) => {
      const scope: C.EvaluationAdjudicationScope = {
        repositoryId: f.input.repositoryId,
        evaluationId: f.input.evaluationId,
        cellId: observed.cellId,
        resultId: judgment.resultId,
        occurrenceKey: judgment.occurrenceKey,
      };
      const changeId = `receipt-${judgment.adjudicationId}`;
      const intent = {
        ...scope,
        actor: judgment.actor,
        request: {
          changeId,
          expectedVersion: version - 1,
          resultDigest: judgment.resultDigest,
          judgment: { kind: judgment.kind, reason: judgment.reason },
        },
      };
      const response: C.EvaluationAdjudicationChangeV1 = {
        schemaVersion: "EvaluationAdjudicationChangeV1",
        scope,
        previousVersion: version - 1,
        version,
        adjudication: judgment,
      };
      expect(C.getEvaluationAdjudicationChangeIssues(response)).toEqual([]);
      transaction(f.value.database, () => {
        f.value.database
          .prepare(`INSERT INTO evaluation_adjudication_events
          (id,evaluation_id,repository_id,cell_id,result_id,result_digest,occurrence_key,version,previous_event_id,
           adjudication_json,actor_issuer,actor_subject,change_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            judgment.adjudicationId,
            scope.evaluationId,
            scope.repositoryId,
            scope.cellId,
            judgment.resultId,
            judgment.resultDigest,
            judgment.occurrenceKey,
            version,
            previousEventId,
            canonicalJson(judgment),
            judgment.actor.issuer,
            judgment.actor.subject,
            changeId,
            judgment.createdAt,
          );
        f.value.database
          .prepare(`INSERT INTO evaluation_mutation_receipts
          (repository_id,change_id,operation,entity_id,intent_digest,actor_issuer,actor_subject,previous_version,version,response_json,created_at)
          VALUES (?,?,'finding_adjudicated',?,?,?,?,?,?,?,?)`)
          .run(
            scope.repositoryId,
            changeId,
            judgment.adjudicationId,
            sha256(canonicalJson({ operation: "changeEvaluationAdjudication", input: intent })),
            judgment.actor.issuer,
            judgment.actor.subject,
            version - 1,
            version,
            canonicalJson(response),
            judgment.createdAt,
          );
      });
    };
    let assessmentVersion = 1;
    const archive = (judgment: C.EvaluationFindingAdjudication) => {
      const version = ++assessmentVersion,
        assessmentId = `audit-assessment-${version}`;
      const adjudicationJson = canonicalJson([judgment]);
      const summary: C.EvaluationAssessmentSummaryV1 = {
        ...first,
        assessmentId,
        version,
        observationDigest: sha256(observationJson),
        adjudicationDigest: sha256(adjudicationJson),
      };
      const input = {
        ...f.input,
        request: {
          changeId: `receipt-${assessmentId}`,
          expectedVersion: version - 1,
          expectedInputDigest: evaluationScoreInputDigest({
            repositoryId: f.input.repositoryId,
            evaluationId: f.input.evaluationId,
            scorerVersion: summary.scorerVersion,
            scoringPlanDigest: summary.scoringPlanDigest,
            observationDigest: summary.observationDigest,
            adjudicationDigest: summary.adjudicationDigest,
          }),
        },
      };
      transaction(f.value.database, () => {
        f.value.database
          .prepare(`INSERT INTO evaluation_assessments
          (id,evaluation_id,repository_id,version,scorer_version,scoring_plan_digest,observation_digest,adjudication_digest,
           observation_json,adjudication_json,report_digest,report_json,actor_issuer,actor_subject,change_id,created_at)
          SELECT ?,evaluation_id,repository_id,?,scorer_version,scoring_plan_digest,?,?,?,?,report_digest,report_json,
            actor_issuer,actor_subject,?,created_at FROM evaluation_assessments WHERE id = ?`)
          .run(
            assessmentId,
            version,
            summary.observationDigest,
            summary.adjudicationDigest,
            observationJson,
            adjudicationJson,
            input.request.changeId,
            first.assessmentId,
          );
        f.value.database
          .prepare(`INSERT INTO evaluation_mutation_receipts
          (repository_id,change_id,operation,entity_id,intent_digest,actor_issuer,actor_subject,previous_version,version,response_json,created_at)
          VALUES (?,?,'assessment_published',?,?,?,?,?,?,?,?)`)
          .run(
            f.input.repositoryId,
            input.request.changeId,
            assessmentId,
            sha256(canonicalJson({ operation: "publishEvaluationAssessment", input })),
            f.input.actor.issuer,
            f.input.actor.subject,
            version - 1,
            version,
            canonicalJson(summary),
            now,
          );
      });
      return { summary, input };
    };
    seedAudit(originalJudgment, 1, null);
    const historical = archive(originalJudgment);
    seedAudit(
      {
        ...originalJudgment,
        adjudicationId: "historical-audit-new-head",
        kind: "unjudged",
        reason: "The newer reviewer reopened the judgment.",
        createdAt: "2026-09-08T04:04:00.000Z",
      },
      2,
      originalJudgment.adjudicationId,
    );
    expect(
      f.value.database
        .prepare(
          `SELECT id FROM evaluation_adjudication_events WHERE occurrence_key = ? ORDER BY version DESC LIMIT 1`,
        )
        .get(originalJudgment.occurrenceKey),
    ).toMatchObject({ id: "historical-audit-new-head" });
    expect(
      f.request("getEvaluationAssessment", {
        ...f.input,
        assessmentId: historical.summary.assessmentId,
      }),
    ).toEqual(historical.summary);
    expect(f.request("publishEvaluationAssessment", historical.input, { readOnly: true })).toEqual(
      historical.summary,
    );
    const repeated = archive(originalJudgment);
    expect(
      f.request("listEvaluationAssessments", { ...f.input, query: { pageSize: 2 } }).items,
    ).toEqual([repeated.summary, historical.summary]);
    const otherOccurrence = {
      ...originalJudgment,
      adjudicationId: "historical-audit-other-occurrence",
      occurrenceKey: present(keys[1]),
    };
    seedAudit(otherOccurrence, 1, null);
    const invalidJudgments: C.EvaluationFindingAdjudication[] = [
      { ...originalJudgment, adjudicationId: "missing-audit-event" },
      { ...originalJudgment, reason: "A reason that no reviewer actually saved." },
      { ...originalJudgment, actor: evaluationAdministrator },
      { ...originalJudgment, createdAt: "2026-09-08T04:05:00.000Z" },
      { ...originalJudgment, adjudicationId: otherOccurrence.adjudicationId },
    ];
    for (const judgment of invalidJudgments) {
      const invalidArchive = archive(judgment);
      code(
        () =>
          f.request("getEvaluationAssessment", {
            ...f.input,
            assessmentId: invalidArchive.summary.assessmentId,
          }),
        "PLATFORM_CORRUPT",
      );
      code(
        () => f.request("publishEvaluationAssessment", invalidArchive.input, { readOnly: true }),
        "PLATFORM_CORRUPT",
      );
    }
    expect(
      f.request("getEvaluationAssessment", {
        ...f.input,
        assessmentId: historical.summary.assessmentId,
      }),
    ).toEqual(historical.summary);
  });

  it("checks the complete case envelope budget with frozen labels and both arm reports", () => {
    const f = fixture();
    const published = f.request("publishEvaluationAssessment", f.publishInput());
    const current = f.request("getEvaluationAssessmentCase", f.caseInput(published));
    const expectation = structuredClone(current.expectation);
    const score = structuredClone(current.case);
    const long = "界".repeat(2048);
    expectation.criteria = Array.from(
      { length: C.maximumEvaluationCriterionCount },
      (_, index) => ({
        criterionId: `criterion-${index}`,
        description: long,
        applicability: { state: "not_applicable", reason: long },
        expectedOutcome: "failed",
        baselineCheckId: null,
        candidateCheckId: null,
      }),
    );
    for (const arm of ["baseline", "candidate"] as const)
      score[arm].criteria = expectation.criteria.map((entry) => ({
        criterionId: entry.criterionId,
        checkId: null,
        state: "not_applicable",
        actualOutcome: null,
        reason: long,
      }));
    score.paired.criteria = expectation.criteria.map((entry) => ({
      criterionId: entry.criterionId,
      change: "not_applicable",
    }));
    const projection = evaluationAssessmentCaseProjection(
      current.scope,
      current.reportDigest,
      current.scoringPlanDigest,
      score,
      current.caseTitle,
      expectation,
    );
    expect(Value.Check(C.EvaluationAssessmentCaseV1Schema, projection)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBeGreaterThan(
      C.maximumEvaluationAssessmentReadUtf8Bytes,
    );
    expect(C.getEvaluationAssessmentCaseIssues(projection)).toContain(
      "Evaluation assessment exceeds its aggregate UTF-8 byte limit.",
    );
  });
});
