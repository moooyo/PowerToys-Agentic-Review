import type * as C from "@agentic-review/contracts";
import {
  evaluationTestActor,
  evaluationTestTime,
  sourceSummaryFixture,
  suiteVersionFixture,
} from "../evaluations/fixtures.testing";

export const evaluationBatchTestActor = { ...evaluationTestActor };
export const evaluationBatchTestScope = {
  repositoryId: "repository-a",
  evaluationId: "evaluation-a",
};

export function batchCreateRequestFixture(): C.EvaluationBatchCreateRequest {
  const version = suiteVersionFixture();
  return {
    changeId: "create-batch-a",
    suiteId: version.suiteId,
    suiteVersionId: version.id,
    baseline: { profileVersionId: "profile-baseline", promptVersionId: "prompt-baseline" },
    candidate: { profileVersionId: "profile-candidate", promptVersionId: "prompt-candidate" },
    mode: "prompt_and_profile",
    checkMappings: [
      {
        caseId: "case-1",
        criterionId: "criterion-1",
        baselineCheckId: "profile-baseline:build",
        candidateCheckId: "profile-candidate:build",
      },
    ],
  };
}

export function batchSummaryFixture(): C.EvaluationBatchSummaryV1 {
  const request = batchCreateRequestFixture();
  return {
    schemaVersion: "EvaluationBatchSummaryV1",
    id: evaluationBatchTestScope.evaluationId,
    repositoryId: evaluationBatchTestScope.repositoryId,
    suiteId: request.suiteId,
    suiteVersionId: request.suiteVersionId,
    workflowKind: "pr_static_build",
    target: "headless",
    mode: request.mode,
    baseline: request.baseline,
    candidate: request.candidate,
    caseCount: 1,
    cellCount: 2,
    createdAt: evaluationTestTime,
    createdBy: { ...evaluationBatchTestActor },
  };
}

export function batchCancelRequestFixture(): C.EvaluationBatchCancelRequest {
  return { changeId: "cancel-batch-a", expectedVersion: 1, reason: "Cancel this comparison." };
}

export function batchCancellationFixture(): C.EvaluationBatchCancellationV1 {
  return {
    schemaVersion: "EvaluationBatchCancellationV1",
    ...evaluationBatchTestScope,
    status: "cancelled",
    version: 2,
    reason: batchCancelRequestFixture().reason,
    cancelledAt: evaluationTestTime,
    cancelledBy: { ...evaluationBatchTestActor },
    cancelledJobCount: 1,
    cancellationRequestedJobCount: 1,
  };
}

export function batchProgressFixture(): C.EvaluationBatchProgress {
  return {
    totalCells: 2,
    applicableCells: 2,
    notApplicableCells: 0,
    not_run: 2,
    awaiting_admission: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    invalid: 0,
  };
}

export function batchListItemFixture(): C.EvaluationBatchListItemV1 {
  return {
    summary: batchSummaryFixture(),
    suiteName: suiteVersionFixture().name,
    status: "pending",
    controlStatus: "active",
    controlVersion: 1,
    progress: batchProgressFixture(),
  };
}

export function batchListFixture(): C.EvaluationBatchListV1 {
  return {
    schemaVersion: "EvaluationBatchListV1",
    repositoryId: evaluationBatchTestScope.repositoryId,
    page: 1,
    pageSize: 20,
    total: 1,
    items: [batchListItemFixture()],
  };
}

function profile(arm: C.EvaluationArm): C.ValidationProfileVersionSummary {
  return {
    id: `profile-${arm}`,
    profileId: `profile-root-${arm}`,
    repositoryId: evaluationBatchTestScope.repositoryId,
    name: `Profile ${arm}`,
    version: 1,
    required: true,
    configSha256: "b".repeat(64),
    workflowKind: "pr_static_build",
    target: "headless",
    outputSchemaVersion: "PrReviewPlanV2",
    createdAt: evaluationTestTime,
    publishedAt: evaluationTestTime,
    createdBy: JSON.stringify([evaluationBatchTestActor.issuer, evaluationBatchTestActor.subject]),
  };
}

function prompt(arm: C.EvaluationArm): C.PromptVersionSummary {
  return {
    id: `prompt-${arm}`,
    templateId: `template-${arm}`,
    version: 1,
    contentSha256: "c".repeat(64),
    outputSchemaVersion: "PrReviewPlanV2",
    createdAt: evaluationTestTime,
    publishedAt: evaluationTestTime,
    createdBy: JSON.stringify([evaluationBatchTestActor.issuer, evaluationBatchTestActor.subject]),
  };
}

export function batchDetailFixture(): C.EvaluationBatchDetailV1 {
  const configuration = (arm: C.EvaluationArm) => ({
    profile: profile(arm),
    prompt: prompt(arm),
    modelRequirements: { required: true },
  });
  return {
    schemaVersion: "EvaluationBatchDetailV1",
    ...batchListItemFixture(),
    suiteVersion: suiteVersionFixture(),
    control: {
      status: "active",
      version: 1,
      reason: null,
      updatedAt: evaluationTestTime,
      updatedBy: { ...evaluationBatchTestActor },
    },
    configurations: { baseline: configuration("baseline"), candidate: configuration("candidate") },
  };
}

export function batchMatrixFixture(): C.EvaluationBatchMatrixV1 {
  const source = sourceSummaryFixture();
  const cell = (arm: C.EvaluationArm): C.EvaluationCellSummaryV1 => ({
    cellId: `cell-${arm}`,
    caseId: "case-1",
    arm,
    trial: 1,
    runId: `run-${arm}`,
    requestId: `request-${arm}`,
    sourceId: source.id,
    sourceDigest: source.sourceDigest,
    profileVersionId: `profile-${arm}`,
    promptVersionId: `prompt-${arm}`,
    state: "not_run",
    job: null,
    result: null,
    blockerCount: 0,
    blockers: [],
  });
  return {
    schemaVersion: "EvaluationBatchMatrixV1",
    ...evaluationBatchTestScope,
    suiteVersionId: suiteVersionFixture().id,
    status: "pending",
    progress: batchProgressFixture(),
    cases: [
      {
        caseId: "case-1",
        title: "A complete negative example",
        applicability: { state: "applicable" },
        source,
        baseline: cell("baseline"),
        candidate: cell("candidate"),
      },
    ],
  };
}

export function batchWaitingMatrixFixture(
  state: "pending" | "admitted" = "pending",
): C.EvaluationBatchMatrixV1 {
  const value = batchMatrixFixture();
  value.status = state === "pending" ? "awaiting_admission" : "queued";
  value.progress.not_run = 0;
  value.progress[state === "pending" ? "awaiting_admission" : "queued"] = 2;
  for (const entry of value.cases) {
    for (const arm of ["baseline", "candidate"] as const) {
      entry[arm].state = state === "pending" ? "awaiting_admission" : "queued";
      entry[arm].job = {
        jobId: `job-${arm}`,
        status: "retry_waiting",
        attemptCount: 1,
        admission: {
          state,
          attemptBase: 1,
          requestedAt: evaluationTestTime,
          timestampBasis: "recorded",
          admittedAt: state === "pending" ? null : evaluationTestTime,
        } as C.JobAdmission,
        createdAt: evaluationTestTime,
        startedAt: null,
        completedAt: null,
        failureCode: null,
      };
    }
  }
  return value;
}

export function batchPromptOptionsFixture(): C.EvaluationPromptOptionsV1 {
  return {
    schemaVersion: "EvaluationPromptOptionsV1",
    repositoryId: evaluationBatchTestScope.repositoryId,
    workflowKind: "pr_static_build",
    page: 1,
    pageSize: 20,
    total: 1,
    items: [{ ...prompt("baseline"), templateName: "Baseline prompt", visibility: "binding" }],
  };
}

export function cellResultFixture(): C.EvaluationCellResultV1 {
  const matrix = batchMatrixFixture(),
    entry = matrix.cases[0];
  if (!entry) throw new Error("A matrix case is required.");
  const cell = entry.baseline;
  return {
    schemaVersion: "EvaluationCellResultV1",
    repositoryId: matrix.repositoryId,
    evaluationId: matrix.evaluationId,
    cellId: cell.cellId,
    resultId: "result-baseline",
    caseId: cell.caseId,
    arm: cell.arm,
    trial: 1,
    runId: cell.runId,
    requestId: cell.requestId,
    jobId: "job-baseline",
    runAttemptId: "attempt-baseline",
    workItemId: entry.source.workItemId,
    sourceId: cell.sourceId,
    sourceDigest: cell.sourceDigest,
    revisionKey: entry.source.revisionKey,
    profileVersionId: cell.profileVersionId,
    promptVersionId: cell.promptVersionId,
    resultDigest: "a".repeat(64),
    planDigest: "b".repeat(64),
    executionDigest: "c".repeat(64),
    workflowKind: "pr_static_build",
    target: "headless",
    createdAt: evaluationTestTime,
    modelRequirements: { required: true },
    evidenceComplete: true,
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "pull_request",
      summary: "The original source was checked.",
      sourceState: "original",
      checks: [
        {
          id: `${cell.profileVersionId}:build`,
          name: "Build",
          kind: "build",
          required: true,
          outcome: "passed",
          summary: "The build completed.",
          expected: "Exit code 0",
          actual: "Exit code 0",
          evidenceIds: ["evidence-build"],
          source: "runner",
        },
      ],
    },
    execution: {
      blockers: [],
      diagnostics: [
        {
          stepId: `${cell.profileVersionId}:build`,
          phase: "build",
          outcome: "passed",
          exitCode: 0,
          summary: "Build completed.",
          stdout: "Fixture output",
        },
      ],
      cleanupState: "completed",
    },
    modelReview: {
      execution: {
        schemaVersion: "CliModelExecutionV1",
        jobId: "job-baseline",
        runAttemptId: "attempt-baseline",
        cli: { kind: "codex", version: "fixture-cli-1", requestedModel: null },
        promptSha256: "d".repeat(64),
        outputSchemaSha256: "e".repeat(64),
        outputSha256: "f".repeat(64),
        exitCode: 0,
      },
      state: "completed",
      summary: "Model advice",
      recommendation: "approve",
      findings: [],
      observations: [],
      issueTriage: null,
      reproductionConclusion: null,
      error: null,
    },
    occurrences: [],
  };
}

export function completedCellMatrixFixture(): C.EvaluationBatchMatrixV1 {
  const matrix = batchMatrixFixture(),
    entry = matrix.cases[0],
    result = cellResultFixture();
  if (!entry) throw new Error("A matrix case is required.");
  matrix.progress.not_run = 1;
  matrix.progress.completed = 1;
  entry.baseline.state = "completed";
  entry.baseline.job = {
    jobId: result.jobId,
    status: "succeeded",
    attemptCount: 1,
    admission: null,
    createdAt: result.createdAt,
    startedAt: result.createdAt,
    completedAt: result.createdAt,
    failureCode: null,
  };
  entry.baseline.result = {
    resultId: result.resultId,
    runAttemptId: result.runAttemptId,
    resultDigest: result.resultDigest,
    createdAt: result.createdAt,
  };
  return matrix;
}
