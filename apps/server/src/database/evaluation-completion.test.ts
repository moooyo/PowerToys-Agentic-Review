import { getValidationJobResultIssues } from "@agentic-review/codex";
import type {
  EvaluationExecutionTemplate,
  NormalizedSchedulingEvent,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { listWorkItems } from "./dashboard-queries.js";
import {
  beginAttempt,
  completedAt,
  context,
  createEvaluationCompletionFixture,
  resultFor,
  selected,
  settle,
  transaction,
  validate,
} from "./evaluation-completion.testing.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import { evaluationAdministrator } from "./evaluation-management.testing.js";
import { handleEvaluationBatchRequest } from "./evaluation-queries.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import {
  assertCurrentIssueReproductionAuthorization,
  recomputeIssueReproductionRequestAssessment,
} from "./issue-reproduction.js";
import { getJobAdmissionRecord } from "./job-admission.js";
import { decodeStoredValidationResult } from "./stored-validation-result.js";
import {
  collectValidationCompletionEvidence,
  persistValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

type BaseFixture = ReturnType<typeof createEvaluationCompletionFixture>;
const fixtures: BaseFixture[] = [];
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));

beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
afterAll(() => {
  for (const [name, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, previous);
  }
});

function createFixture(kind: "issue" | "pull_request" = "issue") {
  const fixture = createEvaluationCompletionFixture(kind);
  fixtures.push(fixture);
  return fixture;
}

function invalidContext(action: () => unknown): void {
  expect(action).toThrow(expect.objectContaining({ code: "STORED_EXECUTION_TEMPLATE_INVALID" }));
}

describe("evaluation completion through real sealed cells and admission", () => {
  it("rejects embedded V1 model advice on a profile-only completion while retaining historical decoding", () => {
    const fixture = createFixture(),
      cell = selected(fixture),
      completion = beginAttempt(fixture, cell);
    expect(cell.plan.modelRequirements.required).toBe(false);
    const result = resultFor(cell);
    if (result.report.workItemKind !== "issue")
      throw new Error("Expected the frozen Issue report.");
    result.report.modelSummary = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "issue",
      summary: "Synthetic unrequested model advice.",
      observations: [],
      reproductionConclusion: "inconclusive",
    };
    expect(getValidationJobResultIssues(result)).toEqual([]);
    const json = canonicalJson(result),
      digest = sha256(json);
    const reject = expect.objectContaining({
      code: "REVIEW_RESULT_INVALID",
      message: "Profile-only evaluations cannot submit model content.",
    });
    expect(() =>
      validateValidationCompletion(fixture.database, completion, digest, result),
    ).toThrow(reject);
    expect(() =>
      collectValidationCompletionEvidence(fixture.database, completion, digest, result),
    ).toThrow(reject);
    expect(canonicalJson(decodeStoredValidationResult("ValidationJobResultV1", json, digest))).toBe(
      json,
    );
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toMatchObject({ count: 0 });
    expect(
      fixture.database
        .prepare("SELECT status FROM run_attempts WHERE id=?")
        .get(completion.runAttemptId),
    ).toMatchObject({ status: "running" });
  });
  it("rejects schema-valid completed V2 CLI model content on a profile-only completion", () => {
    const fixture = createFixture(),
      cell = selected(fixture),
      completion = beginAttempt(fixture, cell);
    const raw = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "issue",
      summary: "Synthetic unrequested model advice.",
      observations: [],
      reproductionConclusion: "inconclusive",
    };
    const result = {
      ...resultFor(cell),
      schemaVersion: "ValidationJobResultV2",
      modelReview: {
        state: "completed",
        result: raw,
        execution: {
          schemaVersion: "CliModelExecutionV1",
          jobId: cell.jobId,
          runAttemptId: completion.runAttemptId,
          cli: { kind: "codex", version: "fixture-cli", requestedModel: null },
          promptSha256: sha256(cell.template.prompt.renderedPrompt),
          outputSchemaSha256: "b".repeat(64),
          outputSha256: sha256(canonicalJson(raw)),
          exitCode: 0,
        },
        executionEvidence: {
          schemaVersion: "ReviewExecutionEvidenceV1",
          source: "worker",
          commands: [],
          commandCapture: "complete",
          worktree: { status: "unknown", source: "not_observed" },
        },
      },
    };
    expect(getValidationJobResultIssues(result)).toEqual([]);
    const digest = sha256(canonicalJson(result));
    expect(() =>
      validateValidationCompletion(fixture.database, completion, digest, result),
    ).toThrow(
      expect.objectContaining({
        code: "REVIEW_RESULT_INVALID",
        message: "Profile-only evaluations cannot submit model content.",
      }),
    );
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toMatchObject({ count: 0 });
  });
  it.each([
    { schemaVersion: "ValidationJobResultV1", state: "not_requested" },
    { schemaVersion: "ValidationJobResultV1", state: "failed" },
    { schemaVersion: "ValidationJobResultV2", state: "not_requested" },
    { schemaVersion: "ValidationJobResultV2", state: "failed" },
  ] as const)(
    "retains profile-only $schemaVersion $state completion without model content",
    ({ schemaVersion, state }) => {
      const fixture = createFixture(),
        cell = selected(fixture),
        completion = beginAttempt(fixture, cell);
      const result = {
        ...resultFor(cell),
        schemaVersion,
        modelReview:
          state === "not_requested"
            ? { state }
            : { state, code: "MODEL_UNAVAILABLE", message: "No model content was produced." },
      };
      const json = canonicalJson(result),
        validated = validateValidationCompletion(
          fixture.database,
          completion,
          sha256(json),
          result,
        );
      transaction(fixture.database, () => {
        settle(fixture.database, completion, validated);
        persistValidatedValidationResult(fixture.database, completion, validated, completedAt);
      });
      expect(
        fixture.database.prepare("SELECT schema_id, result_json FROM validation_job_results").get(),
      ).toMatchObject({ schema_id: schemaVersion, result_json: json });
    },
  );
  it("persists a fresh profile-only Issue result after source changes without projecting it as an ordinary reviewed revision", () => {
    const fixture = createFixture();
    const cell = selected(fixture);
    const completion = beginAttempt(fixture, cell);
    const body = "A newer Issue body must not replace the captured source.";
    const workItem = { ...fixture.event.workItem, body, updatedAt: "2026-09-08T04:01:00.000Z" };
    const revisionKey = sha256(
      JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]),
    );
    const event: NormalizedSchedulingEvent = {
      ...fixture.event,
      eventId: "evaluation-completion-source-update",
      sourceEventId: "evaluation-completion-source-update",
      action: "revision_observed",
      requestKind: null,
      actor: null,
      target: null,
      occurredAt: workItem.updatedAt,
      observedAt: workItem.updatedAt,
      workItem,
      revision: {
        kind: "issue",
        githubRepositoryId: fixture.event.repository.githubRepositoryId,
        githubWorkItemId: workItem.githubWorkItemId,
        revisionKey,
        contentDigest: revisionKey,
        observedAt: workItem.updatedAt,
        sourceUpdatedAt: workItem.updatedAt,
      },
    };
    ingestSchedulingEvent(fixture.database, {
      allowScheduling: false,
      event,
      policy: fixture.planInput.authorizationPolicy,
      schedule: null,
      delivery: {
        deliveryId: event.sourceEventId,
        eventName: "issue",
        payloadSha256: sha256(canonicalJson(event)),
        receivedAt: event.observedAt,
      },
    });
    const result = resultFor(cell);
    const collected = collectValidationCompletionEvidence(
      fixture.database,
      completion,
      sha256(canonicalJson(result)),
      result,
    );
    expect(collected.template.validation).toMatchObject({
      schemaVersion: "ValidationJobContextV2",
      requestEpochId: null,
    });
    expect(collected.scopes).toEqual([]);
    const validated = validate(fixture, completion, result);
    expect(validated).toMatchObject({
      reviewRunId: cell.run_id,
      requestId: cell.request_id,
      jobId: cell.jobId,
      evidenceComplete: true,
    });
    const resultId = transaction(fixture.database, () => {
      settle(fixture.database, completion, validated);
      const id = persistValidatedValidationResult(
        fixture.database,
        completion,
        validated,
        completedAt,
      );
      fixture.database
        .prepare(
          "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
        )
        .run(completedAt, cell.jobId);
      return id;
    });
    expect(
      fixture.database
        .prepare(
          "SELECT result_json, result_digest, review_run_id, job_id, run_attempt_id FROM validation_job_results WHERE id = ?",
        )
        .get(resultId),
    ).toEqual({
      result_json: canonicalJson(result),
      result_digest: validated.resultDigest,
      review_run_id: cell.run_id,
      job_id: cell.jobId,
      run_attempt_id: completion.runAttemptId,
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM review_results WHERE job_id = ?")
        .get(cell.jobId),
    ).toEqual({ count: 0 });
    const item = listWorkItems(fixture.database, { repositoryId: fixture.repositoryId }).items.find(
      (entry) => entry.id === fixture.planInput.workItemId,
    );
    expect(item?.reviewedRevisionKey).toBeNull();
    expect(item?.latestJobId).not.toBe(cell.jobId);
    const matrix = handleEvaluationBatchRequest(
      fixture.database,
      {
        operation: "getEvaluationBatchMatrix",
        input: {
          repositoryId: fixture.repositoryId,
          evaluationId: fixture.batch.id,
          actor: evaluationAdministrator,
        },
      },
      completedAt,
      [evaluationAdministrator],
    );
    expect(matrix).toMatchObject({
      schemaVersion: "EvaluationBatchMatrixV1",
      progress: { completed: 1, queued: 1 },
      cases: [
        {
          baseline: {
            state: "completed",
            job: { jobId: cell.jobId, admission: null },
            result: {
              resultId,
              resultDigest: validated.resultDigest,
              runAttemptId: completion.runAttemptId,
            },
          },
          candidate: { state: "queued", result: null },
        },
      ],
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM notification_events WHERE job_id = ?")
        .get(cell.jobId),
    ).toEqual({ count: 0 });
    expect(() =>
      fixture.database
        .prepare("UPDATE validation_job_results SET result_json = result_json WHERE id = ?")
        .run(resultId),
    ).toThrow();
    invalidContext(() =>
      persistValidatedValidationResult(fixture.database, completion, validated, completedAt),
    );
    invalidContext(() =>
      transaction(fixture.database, () =>
        persistValidatedValidationResult(fixture.database, completion, validated, completedAt),
      ),
    );
  });

  it("does not attach one arm's validated result or checks to the other fresh Job", () => {
    const fixture = createFixture();
    const baseline = selected(fixture),
      candidate = selected(fixture, "candidate");
    const baselineContext = beginAttempt(fixture, baseline),
      candidateContext = beginAttempt(fixture, candidate);
    const original = resultFor(baseline);
    const validated = validate(fixture, baselineContext, original);
    expect(() => validate(fixture, candidateContext, original)).toThrow(
      expect.objectContaining({ code: "REVIEW_RESULT_INVALID" }),
    );
    invalidContext(() =>
      transaction(fixture.database, () =>
        persistValidatedValidationResult(
          fixture.database,
          candidateContext,
          validated,
          completedAt,
        ),
      ),
    );
    invalidContext(() =>
      validate(
        fixture,
        { ...baselineContext, runAttemptId: candidateContext.runAttemptId },
        original,
      ),
    );
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });

  it.each(["source", "authorization", "purpose", "profile", "prompt", "epoch"] as const)(
    "rejects a completion context with substituted frozen %s",
    (field) => {
      const fixture = createFixture();
      const cell = selected(fixture),
        completion = beginAttempt(fixture, cell);
      const forged = structuredClone(cell.template);
      if (field === "source") forged.validation.source.workItem.body = "Substituted source";
      if (field === "authorization") forged.validation.authorization.id = "different-authorization";
      if (field === "purpose") forged.validation.purpose.cellId = "different-cell";
      if (field === "profile") forged.validation.profileVersion.config.hardTimeoutMs += 1;
      if (field === "prompt") forged.prompt.renderedPrompt = "A different prompt.";
      if (field === "epoch") Object.assign(forged.validation, { requestEpochId: "ordinary-epoch" });
      const executionJson = canonicalJson(forged);
      invalidContext(() =>
        validate(
          fixture,
          { ...completion, executionJson, executionDigest: sha256(executionJson) },
          resultFor(cell),
        ),
      );
    },
  );

  it.each(["cancel", "pause", "worker_superseded"] as const)(
    "rechecks %s after validation and before immutable persistence",
    (change) => {
      const fixture = createFixture();
      const cell = selected(fixture),
        completion = beginAttempt(fixture, cell);
      const validated = validate(fixture, completion, resultFor(cell));
      fixture.database.exec("BEGIN IMMEDIATE");
      try {
        if (change === "cancel") {
          cancelEvaluationBatchInTransaction(
            fixture.database,
            {
              repositoryId: fixture.repositoryId,
              evaluationId: fixture.batch.id,
              actor: evaluationAdministrator,
              request: {
                changeId: "cancel-before-completion",
                expectedVersion: 1,
                reason: "Cancel the synthetic evaluation.",
              },
            },
            completedAt,
            [evaluationAdministrator],
          );
          const cancelling = handleEvaluationBatchRequest(
            fixture.database,
            {
              operation: "getEvaluationBatch",
              input: {
                repositoryId: fixture.repositoryId,
                evaluationId: fixture.batch.id,
                actor: evaluationAdministrator,
              },
            },
            completedAt,
            [evaluationAdministrator],
          );
          expect(cancelling).toMatchObject({
            status: "cancelling",
            controlStatus: "cancelled",
            progress: { running: 1, cancelled: 1 },
          });
        } else {
          settle(fixture.database, completion, validated);
        }
        if (change === "pause")
          fixture.database
            .prepare("UPDATE managed_repositories SET enabled = 0 WHERE id = ?")
            .run(fixture.repositoryId);
        if (change === "worker_superseded")
          fixture.database
            .prepare("UPDATE workers SET superseded_at = ? WHERE id = 'evaluation-worker'")
            .run(completedAt);
        invalidContext(() =>
          persistValidatedValidationResult(fixture.database, completion, validated, completedAt),
        );
        expect(
          fixture.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
        ).toEqual({ count: 0 });
      } finally {
        fixture.database.exec("ROLLBACK");
      }
    },
  );

  it("retains declared-probe validation and rejects malformed V2 reproduction without inventing ordinary authority", () => {
    const fixture = createFixture();
    const cell = selected(fixture),
      completion = beginAttempt(fixture, cell);
    const result = resultFor(cell);
    const output = {
      schemaVersion: "ProbeObservationsV1" as const,
      observations: [
        {
          id: "status",
          state: "observed" as const,
          value: { type: "string" as const, value: "ready" },
        },
      ],
    };
    result.probeReceipts = [
      {
        schemaVersion: "TestProbeReceiptV1",
        requestId: cell.request_id,
        jobId: cell.jobId,
        runAttemptId: completion.runAttemptId,
        planDigest: cell.plan_digest,
        profileVersionId: cell.template.validation.profileVersion.id,
        checkId: `${cell.template.validation.profileVersion.id}:compile`,
        capture: "complete",
        output,
        outputSha256: sha256(canonicalJson(output)),
      },
    ];
    expect(() => validate(fixture, completion, result)).toThrow(
      expect.objectContaining({ code: "REVIEW_RESULT_INVALID" }),
    );
    const malformedMapping = {
      ...cell.template.validation,
      reproduction: {} as NonNullable<EvaluationExecutionTemplate["validation"]["reproduction"]>,
    };
    expect(malformedMapping.testedSourceAuthorization).toBeNull();
    expect(() =>
      recomputeIssueReproductionRequestAssessment({
        validation: malformedMapping,
        jobId: cell.jobId,
        runAttemptId: completion.runAttemptId,
        result: resultFor(cell),
      }),
    ).toThrow(TypeError);
    invalidContext(() =>
      assertCurrentIssueReproductionAuthorization(
        fixture.database,
        { ...cell.template, validation: malformedMapping },
        { jobId: cell.jobId, runAttemptId: completion.runAttemptId },
      ),
    );
  });

  it("rejects a Prompt-dependent PR completion without a leased attempt", () => {
    const fixture = createFixture("pull_request");
    const cell = selected(fixture);
    expect(cell.plan.modelRequirements).toEqual({
      required: true,
    });
    const admission = getJobAdmissionRecord(fixture.database, cell.jobId);
    expect(admission).toMatchObject({
      state: "pending",
      admittedAt: null,
      ownershipState: "resolved",
    });
    expect(admission.blockers).not.toContain("plan_prerequisite_missing");
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM run_attempts WHERE job_id = ?")
        .get(cell.jobId),
    ).toEqual({ count: 0 });
    invalidContext(() =>
      validate(
        fixture,
        { ...context(fixture.database, cell), runAttemptId: "unleased-attempt" },
        resultFor(cell),
      ),
    );
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
  });
});
