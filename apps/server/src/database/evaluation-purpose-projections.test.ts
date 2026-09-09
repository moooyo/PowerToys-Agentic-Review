import type { DatabaseSync } from "node:sqlite";
import type {
  EvaluationExecutionTemplate,
  JobExecutionTemplateV2,
  NormalizedSchedulingEvent,
  ReviewRunPlanInput,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  createEvaluationExecutionTemplate,
  createValidationExecutionTemplate,
} from "../scheduling/validation-job-factory.js";
import { getSystemSnapshot, listJobs, listWorkItems } from "./dashboard-queries.js";
import {
  createEvaluationBatchFixture,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import {
  evaluationActor,
  evaluationAdministrator,
  evaluationNow,
} from "./evaluation-management.testing.js";
import { readFindingResult } from "./finding-occurrences.js";
import { ingestSchedulingEvent } from "./github-ingestion.js";
import { pinGitHubLegacyJobInTransaction } from "./github-review-runs.js";
import { readIssueReproductionRunSummary } from "./issue-reproduction-queries.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";
import { handlePromptConfigurationRequest } from "./prompt-configuration.js";
import { readReviewRunDecisionSnapshotInTransaction } from "./review-run-decision-snapshot.js";
import { handleReviewRunDecisionRequest } from "./review-run-decisions.js";
import { handleReviewRunQuery } from "./review-run-queries.js";
import {
  getReviewRunByActivation,
  getReviewRunPromptEnvelope,
  handleReviewRunRequest,
  type ReviewRunDetail,
} from "./review-runs.js";

type Fixture = ReturnType<typeof createEvaluationBatchFixture>;
const fixtures: Fixture[] = [];
const ordinaryAt = "2026-09-08T02:30:00.000Z";
const evaluationJobAt = "2026-09-08T03:30:00.000Z";
const eventAt = "2026-09-08T04:00:00.000Z";
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));

beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(evaluationNow));
});
afterEach(() => {
  try {
    for (const fixture of fixtures.splice(0)) fixture.close();
  } finally {
    vi.useRealTimers();
  }
});
afterAll(() => {
  for (const [name, previous] of formats) {
    if (previous === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, previous);
  }
});

function transaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function insertQueuedJob(
  database: DatabaseSync,
  id: string,
  template: JobExecutionTemplateV2 | EvaluationExecutionTemplate,
  createdAt: string,
) {
  const context = template.validation;
  const json = canonicalJson(template);
  transaction(database, () => {
    database
      .prepare(`INSERT INTO jobs
      (id, work_item_id, job_kind, semantic_key, concurrency_key, status, execution_json,
       execution_digest, required_capabilities_json, required_capabilities_digest, resource_revision,
       request_epoch_id, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, '[]', ?, ?, ?, 1, ?, ?, ?)`)
      .run(
        id,
        context.workItemId,
        template.resource.kind === "pull_request" ? "pull_request_review" : "issue_triage",
        `purpose-projection:${id}`,
        `purpose-projection:${id}`,
        json,
        sha256(json),
        sha256("[]"),
        context.revisionKey,
        context.requestEpochId,
        createdAt,
        createdAt,
        createdAt,
      );
    // The current parser records V2 admission as pending/invalid_template; no lease is fabricated.
    createJobAdmissionInTransaction(database, id, createdAt);
    if (context.schemaVersion === "ValidationJobContextV1") {
      database
        .prepare(
          "INSERT INTO job_request_epochs (job_id, request_epoch_id, linked_at) VALUES (?, ?, ?)",
        )
        .run(id, context.requestEpochId, createdAt);
    }
    database
      .prepare(`INSERT INTO review_run_job_links
      (review_run_id, request_id, activation_number, job_id, linked_at) VALUES (?, ?, ?, ?, ?)`)
      .run(context.runId, context.requestId, context.jobActivation, id, createdAt);
  });
  return id;
}

function fixture(kind: "pull_request" | "issue") {
  expect(new Date().toISOString()).toBe(evaluationNow);
  const value = createEvaluationBatchFixture(kind, { notApplicableCase: false });
  fixtures.push(value);
  const legacy = value.database
    .prepare(`SELECT job.id, job.created_at AS createdAt FROM jobs AS job
    WHERE job.work_item_id = ? AND NOT EXISTS (
      SELECT 1 FROM review_run_job_links WHERE job_id = job.id)
    ORDER BY job.created_at, job.id LIMIT 1`)
    .get(value.planInput.workItemId) as { id: string; createdAt: string };
  expect(legacy.createdAt).toBe(evaluationNow);
  const batch = value.create();
  const cells = readEvaluationBatchCells(value.database, batch.id);
  expect(cells).toHaveLength(2);
  const evaluationJobs = cells.map((cell) => ({
    ...cell,
    jobId: insertQueuedJob(
      value.database,
      `evaluation-${cell.arm}`,
      createEvaluationExecutionTemplate({
        runId: cell.run_id,
        plan: cell.plan,
        planDigest: cell.plan_digest,
        frozenPrompt: cell.prompt,
      }),
      evaluationJobAt,
    ),
  }));
  return { ...value, legacyJobId: legacy.id, batch, evaluationJobs };
}

function addOrdinaryReview(value: Fixture): { run: ReviewRunDetail; jobId: string } {
  vi.setSystemTime(new Date(ordinaryAt));
  const profile = value.baseline.profile;
  handlePromptConfigurationRequest(
    value.database,
    {
      operation: "saveValidationProfileBinding",
      input: {
        repositoryId: value.repositoryId,
        profileId: profile.profileId,
        actor: evaluationAdministrator,
        request: { expectedVersion: 0, profileVersionId: profile.id, enabled: true },
      },
    },
    ordinaryAt,
  );
  const activationId = "ordinary-projection-review";
  const sourceAuthorization = value.planInput.testedSourceAuthorization;
  const planInput: ReviewRunPlanInput = {
    ...value.planInput,
    activationId,
    testedSourceAuthorization:
      sourceAuthorization === null ? null : { ...sourceAuthorization, activationId },
    requests: [
      {
        requestId: "ordinary-request",
        workflowKind: profile.workflowKind,
        target: profile.target,
        required: true,
        profileVersion: profile,
        prompt: { workflowKind: profile.workflowKind, version: value.baseline.prompt },
      },
    ],
    runnerSupport: [
      {
        workflowKind: profile.workflowKind,
        target: profile.target,
        capabilities: [],
        evidenceDelivery: true,
      },
    ],
  };
  const run = handleReviewRunRequest(
    value.database,
    {
      operation: "createReviewRun",
      input: { planInput, actor: evaluationActor },
    },
    ordinaryAt,
  ) as ReviewRunDetail;
  const prompt = getReviewRunPromptEnvelope(value.database, {
    repositoryId: value.repositoryId,
    reviewRunId: run.id,
    requestId: "ordinary-request",
  });
  if (!prompt) throw new Error("The ordinary request must retain its published prompt.");
  const jobId = insertQueuedJob(
    value.database,
    "ordinary-review-job",
    createValidationExecutionTemplate({
      runId: run.id,
      plan: run.plan,
      planDigest: run.planDigest,
      requestId: "ordinary-request",
      jobActivation: 1,
      frozenPrompt: prompt,
    }),
    ordinaryAt,
  );
  const timeline = value.database
    .prepare(`SELECT id, created_at AS createdAt FROM jobs WHERE work_item_id = ?
      ORDER BY created_at, id`)
    .all(value.planInput.workItemId);
  // Evaluation Jobs are newer than the ordinary Job and must still be excluded from latest.
  expect(timeline).toEqual([
    { id: expect.any(String), createdAt: evaluationNow },
    { id: jobId, createdAt: ordinaryAt },
    { id: "evaluation-baseline", createdAt: evaluationJobAt },
    { id: "evaluation-candidate", createdAt: evaluationJobAt },
  ]);
  expect(Date.parse(evaluationNow)).toBeLessThan(Date.parse(ordinaryAt));
  expect(Date.parse(ordinaryAt)).toBeLessThan(Date.parse(evaluationJobAt));
  return { run, jobId };
}

function workItem(value: Fixture) {
  const result = listWorkItems(value.database, { repositoryId: value.repositoryId });
  const item = result.items.find((entry) => entry.id === value.planInput.workItemId);
  if (!item) throw new Error("The ordinary work-item projection must remain visible.");
  return item;
}

function sourceEvent(
  value: Fixture,
  action: "revision_observed" | "request_closed",
): NormalizedSchedulingEvent {
  vi.setSystemTime(new Date(eventAt));
  expect(Date.now()).toBeGreaterThan(Date.parse(evaluationJobAt));
  const base = {
    ...value.event,
    eventId: `purpose-${action}`,
    sourceEventId: `purpose-${action}`,
    occurredAt: eventAt,
    observedAt: eventAt,
  };
  if (action === "request_closed") {
    return {
      ...base,
      action,
      closeReason:
        value.event.requestKind === "assignment" ? "assignment_removed" : "review_request_removed",
    };
  }
  const item = {
    ...value.event.workItem,
    body: "A newer source must not supersede evaluation Jobs.",
    updatedAt: eventAt,
  };
  const revision = value.event.revision;
  const headSha = "d".repeat(40);
  const revisionKey =
    revision.kind === "pull_request"
      ? sha256(`${revision.baseSha}\0${headSha}`)
      : sha256(JSON.stringify([item.title, item.body, item.state, item.updatedAt]));
  return {
    ...base,
    action,
    requestKind: null,
    actor: null,
    target: null,
    workItem: item,
    revision: {
      ...revision,
      revisionKey,
      observedAt: eventAt,
      sourceUpdatedAt: eventAt,
      ...(revision.kind === "pull_request" ? { headSha } : { contentDigest: revisionKey }),
    },
  };
}

describe("ordinary review purpose isolation on the actual migrated evaluation matrix", () => {
  it.each(["pull_request", "issue"] as const)(
    "keeps legacy and ordinary %s Jobs visible while hiding later evaluation cells from work-item and approval projections",
    (kind) => {
      const value = fixture(kind);
      expect(workItem(value).latestJobId).toBe(value.legacyJobId);
      expect(workItem(value).reviewedRevisionKey).toBeNull();
      const ordinary = addOrdinaryReview(value);
      const item = workItem(value);
      expect(item.latestJobId).toBe(ordinary.jobId);
      expect(item.latestJobStatus).toBe("queued");
      const operational = listJobs(value.database, { repositoryId: value.repositoryId });
      expect(new Set(operational.items.map((job) => job.id))).toEqual(
        new Set([
          value.legacyJobId,
          ordinary.jobId,
          ...value.evaluationJobs.map((entry) => entry.jobId),
        ]),
      );
      expect(getSystemSnapshot(value.database, 28).awaitingAdmissionJobs).toBe(5);
      expect(
        handleReviewRunRequest(
          value.database,
          {
            operation: "listReviewRuns",
            input: { repositoryId: value.repositoryId, workItemId: value.planInput.workItemId },
          },
          eventAt,
        ),
      ).toMatchObject({ total: 1, items: [{ id: ordinary.run.id }] });
      expect(
        handleReviewRunQuery(value.database, {
          operation: "listDashboardReviewRuns",
          input: { repositoryId: value.repositoryId, workItemId: value.planInput.workItemId },
        }),
      ).toMatchObject({ total: 1, items: [{ id: ordinary.run.id }] });
      for (const cell of value.evaluationJobs) {
        const scope = { repositoryId: value.repositoryId, reviewRunId: cell.run_id };
        expect(
          handleReviewRunRequest(
            value.database,
            { operation: "getReviewRun", input: scope },
            eventAt,
          ),
        ).toBeNull();
        expect(
          getReviewRunByActivation(value.database, {
            repositoryId: value.repositoryId,
            workItemId: value.planInput.workItemId,
            activationId: cell.plan.activationId,
          }),
        ).toBeNull();
        expect(
          handleReviewRunQuery(value.database, {
            operation: "getDashboardReviewRun",
            input: scope,
          }),
        ).toBeNull();
        transaction(value.database, () => {
          expect(readReviewRunDecisionSnapshotInTransaction(value.database, scope)).toBeNull();
          expect(
            readFindingResult(value.database, {
              ...scope,
              requestId: cell.request_id,
              jobId: cell.jobId,
            }),
          ).toBeNull();
          expect(readIssueReproductionRunSummary(value.database, scope)).toBeUndefined();
        });
        expect(() =>
          handleReviewRunDecisionRequest(
            value.database,
            {
              operation: "getReviewRunDecisionContext",
              input: { ...scope, actor: evaluationActor },
            },
            eventAt,
            [evaluationAdministrator],
          ),
        ).toThrow(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
        transaction(value.database, () => {
          expect(() =>
            pinGitHubLegacyJobInTransaction(
              value.database,
              {
                workItemId: value.planInput.workItemId,
                jobId: cell.jobId,
              },
              eventAt,
            ),
          ).toThrow(/ordinary non-validation/u);
        });
        // Prompt retrieval is a purpose-neutral helper for an already validated exact scope.
        expect(
          getReviewRunPromptEnvelope(value.database, { ...scope, requestId: cell.request_id }),
        ).toEqual(cell.prompt);
      }
      transaction(value.database, () =>
        pinGitHubLegacyJobInTransaction(
          value.database,
          {
            workItemId: value.planInput.workItemId,
            jobId: value.legacyJobId,
          },
          eventAt,
        ),
      );
    },
  );

  it.each([
    ["pull_request", "revision_observed"],
    ["pull_request", "request_closed"],
    ["issue", "revision_observed"],
    ["issue", "request_closed"],
  ] as const)(
    "does not supersede or cancel queued evaluation Jobs when %s receives %s",
    (kind, action) => {
      const value = fixture(kind);
      const ordinary = addOrdinaryReview(value);
      const evaluationIds = value.evaluationJobs.map((cell) => cell.jobId);
      const rows = () =>
        value.database
          .prepare("SELECT * FROM jobs WHERE id IN (?, ?) ORDER BY id")
          .all(...evaluationIds);
      const before = rows();
      const event = sourceEvent(value, action);
      const result = ingestSchedulingEvent(value.database, {
        allowScheduling: false,
        event,
        policy: value.planInput.authorizationPolicy,
        schedule: null,
        delivery: {
          deliveryId: event.sourceEventId,
          eventName: event.workItem.kind,
          payloadSha256: sha256(canonicalJson(event)),
          receivedAt: eventAt,
        },
      });
      expect(result.staleJobCount).toBe(2);
      expect(result.cancelRequestedJobCount).toBe(0);
      expect(
        value.database.prepare("SELECT status FROM jobs WHERE id = ?").get(value.legacyJobId),
      ).toEqual({ status: "stale" });
      expect(
        value.database.prepare("SELECT status FROM jobs WHERE id = ?").get(ordinary.jobId),
      ).toEqual({ status: "stale" });
      expect(rows()).toEqual(before);
      expect(
        value.database
          .prepare("SELECT COUNT(*) AS count FROM job_request_epochs WHERE job_id IN (?, ?)")
          .get(...evaluationIds),
      ).toEqual({ count: 0 });
      expect(
        value.database
          .prepare(
            "SELECT COUNT(*) AS count FROM github_review_run_activations WHERE review_run_id IN (?, ?)",
          )
          .get(...value.evaluationJobs.map((cell) => cell.run_id)),
      ).toEqual({ count: 0 });
      expect(
        new Set(
          listJobs(value.database, {
            repositoryId: value.repositoryId,
            status: "queued",
          }).items.map((job) => job.id),
        ),
      ).toEqual(new Set(evaluationIds));
      expect(workItem(value).latestJobId).toBe(ordinary.jobId);
    },
  );
});
