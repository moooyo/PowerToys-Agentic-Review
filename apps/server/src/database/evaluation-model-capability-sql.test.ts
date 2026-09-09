import { evaluationModelExecutionCapabilityLabels } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  createEvaluationBatchFixture,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import { createJobAdmissionInTransaction } from "./job-admission.js";

const queuedAt = "2026-09-08T04:00:00.000Z";
const jobId = "synthetic-model-capability-job";
const rejectedBinding = "review run job does not match its frozen validation identity";
const workflows = [
  {
    kind: "pull_request",
    workflowKind: "pr_static_build",
    modelLabel: evaluationModelExecutionCapabilityLabels.review,
    otherModelLabel: evaluationModelExecutionCapabilityLabels.summary,
  },
  {
    kind: "issue",
    workflowKind: "issue_validation",
    modelLabel: evaluationModelExecutionCapabilityLabels.summary,
    otherModelLabel: evaluationModelExecutionCapabilityLabels.review,
  },
] as const;

type BaseFixture = ReturnType<typeof createEvaluationBatchFixture>;
const fixtures: BaseFixture[] = [];

afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});

function fixture(kind: "pull_request" | "issue", modelRequired = true) {
  const value = createEvaluationBatchFixture(kind, { notApplicableCase: false });
  fixtures.push(value);
  const input = structuredClone(value.input);
  if (!modelRequired) {
    input.request.mode = "profile_only";
  }
  const batch = value.create(input);
  const cell = readEvaluationBatchCells(value.database, batch.id).find(
    (entry) => entry.arm === "baseline" && entry.applicable === 1,
  );
  if (!cell) throw new Error("The SQL capability fixture requires an applicable baseline cell.");
  const template = createEvaluationExecutionTemplate({
    runId: cell.run_id,
    plan: cell.plan,
    planDigest: cell.plan_digest,
    frozenPrompt: cell.prompt,
  });
  return { ...value, cell, template };
}

type Fixture = ReturnType<typeof fixture>;

function insertCandidate(value: Fixture, labels: Record<string, unknown>): void {
  const template = {
    ...value.template,
    executionPolicy: {
      ...value.template.executionPolicy,
      requiredCapabilityLabels: labels,
    },
  };
  const executionJson = canonicalJson(template);
  const requiredJson = canonicalJson({ labels });
  value.database.exec("BEGIN IMMEDIATE");
  try {
    // Recompute both commitments so malformed labels must be rejected by the frozen SQL
    // binding, rather than an unrelated stale digest or a TypeScript input validator.
    value.database
      .prepare(`INSERT INTO jobs (
        id, work_item_id, job_kind, generation, intent_version, semantic_key, concurrency_key,
        status, priority, execution_json, execution_digest, required_capabilities_json,
        required_capabilities_digest, resource_revision, max_attempts, next_attempt_at,
        created_at, updated_at, request_epoch_id, activation
      ) VALUES (?, ?, ?, 1, 1, ?, ?, 'queued', 100, ?, ?, ?, ?, ?, 3, ?, ?, ?, NULL, 1)`)
      .run(
        jobId,
        value.cell.plan.workItemId,
        value.cell.plan.workItem.kind === "pull_request" ? "pull_request_review" : "issue_triage",
        jobId,
        jobId,
        executionJson,
        sha256(executionJson),
        requiredJson,
        sha256(requiredJson),
        value.cell.plan.revision.revisionKey,
        queuedAt,
        queuedAt,
        queuedAt,
      );
    createJobAdmissionInTransaction(value.database, jobId, queuedAt);
    value.database
      .prepare(`INSERT INTO review_run_job_links (
        review_run_id, request_id, activation_number, job_id, linked_at
      ) VALUES (?, ?, 1, ?, ?)`)
      .run(value.cell.run_id, value.cell.request_id, jobId, queuedAt);
    value.database.exec("COMMIT");
  } catch (error) {
    if (value.database.isTransaction) value.database.exec("ROLLBACK");
    throw error;
  }
}

function expectRejected(value: Fixture, labels: Record<string, unknown>): void {
  expect(() => insertCandidate(value, labels)).toThrow(rejectedBinding);
  expect(value.database.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId)).toBeUndefined();
  expect(
    value.database.prepare("SELECT job_id FROM job_admission WHERE job_id = ?").get(jobId),
  ).toBeUndefined();
  expect(
    value.database
      .prepare("SELECT job_id FROM review_run_job_links WHERE review_run_id = ?")
      .all(value.cell.run_id),
  ).toEqual([]);
}

describe.each(workflows)("frozen SQL model capability binding for $workflowKind", (workflow) => {
  it("accepts the exact CLI capability derived from the frozen workflow", () => {
    const value = fixture(workflow.kind);
    const labels = { ...value.template.executionPolicy.requiredCapabilityLabels };
    expect(value.template.validation.workflowKind).toBe(workflow.workflowKind);
    expect(labels[workflow.modelLabel]).toBe("1");
    expect(labels[workflow.otherModelLabel]).toBeUndefined();
    expect(() => insertCandidate(value, labels)).not.toThrow();
    expect(
      value.database
        .prepare("SELECT job_id FROM review_run_job_links WHERE review_run_id = ?")
        .get(value.cell.run_id),
    ).toEqual({ job_id: jobId });
  });

  it.each(["missing", "other_workflow", "unsupported_version", "numeric_version"] as const)(
    "rejects %s model capability even with recomputed commitments",
    (mutation) => {
      const value = fixture(workflow.kind);
      const labels: Record<string, unknown> = {
        ...value.template.executionPolicy.requiredCapabilityLabels,
      };
      if (mutation === "missing" || mutation === "other_workflow") {
        delete labels[workflow.modelLabel];
        if (mutation === "other_workflow") labels[workflow.otherModelLabel] = "1";
      } else {
        labels[workflow.modelLabel] = mutation === "unsupported_version" ? "2" : 1;
      }
      expectRejected(value, labels);
    },
  );
});

describe("frozen SQL model capability binding for profile-only evaluations", () => {
  it("accepts a profile-only Issue workflow without a model capability", () => {
    const value = fixture("issue", false);
    const labels = { ...value.template.executionPolicy.requiredCapabilityLabels };
    expect(value.template.validation.modelRequirements.required).toBe(false);
    expect(labels[evaluationModelExecutionCapabilityLabels.review]).toBeUndefined();
    expect(labels[evaluationModelExecutionCapabilityLabels.summary]).toBeUndefined();
    expect(() => insertCandidate(value, labels)).not.toThrow();
  });

  it.each(Object.values(evaluationModelExecutionCapabilityLabels))(
    "rejects an extra %s capability on a profile-only workflow",
    (modelLabel) => {
      const value = fixture("issue", false);
      expectRejected(value, {
        ...value.template.executionPolicy.requiredCapabilityLabels,
        [modelLabel]: "1",
      });
    },
  );
});
