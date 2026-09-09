import type * as C from "@agentic-review/contracts";
import { evaluateEvaluationRunReadiness } from "@agentic-review/domain";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../scheduling/canonical-json.js";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  createEvaluationBatchFixture,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import { readEvaluationExecutionCellInTransaction } from "./evaluation-execution.js";
import {
  evaluationAdministrator,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import { handleEvaluationBatchRequest } from "./evaluation-queries.js";
import { inspectJobAdmissionReadinessInTransaction } from "./scheduling-diagnostics.js";
import {
  handleValidationDispatchRequest,
  type ValidationDispatchOperationMap,
} from "./validation-dispatch.js";

type Fixture = ReturnType<typeof createEvaluationBatchFixture>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture(kind: "pull_request" | "issue" = "pull_request") {
  const f = createEvaluationBatchFixture(kind);
  fixtures.push(f);
  return f;
}
const changedAt = "2026-09-08T03:01:00.000Z";
function detail(f: Fixture, id: string) {
  return handleEvaluationBatchRequest(
    f.database,
    {
      operation: "getEvaluationBatch",
      input: { actor: evaluationAdministrator, repositoryId: f.repositoryId, evaluationId: id },
    },
    changedAt,
    [evaluationAdministrator],
  ) as C.EvaluationBatchDetailV1;
}
function persisted(f: Fixture, id: string) {
  return f.database
    .prepare(`SELECT configuration_manifest_json, configuration_manifest_sha256,
    cell_manifest_json, cell_manifest_sha256, execution_manifest_json, execution_manifest_sha256,
    scoring_plan_json, scoring_plan_digest FROM evaluations WHERE id = ?`)
    .get(id) as Record<string, string>;
}
function readCell(f: Fixture, runId: string) {
  f.database.exec("BEGIN");
  try {
    return readEvaluationExecutionCellInTransaction(
      f.database,
      { repositoryId: f.repositoryId, runId },
      changedAt,
    );
  } finally {
    f.database.exec("ROLLBACK");
  }
}

describe("Evaluation CLI model execution configuration", () => {
  it("freezes both arm inputs and the model requirement through configuration, plan, context and scoring", () => {
    const f = fixture(),
      summary = f.create();
    expect(summary.baseline).toEqual(f.baseline.selection);
    expect(summary.candidate).toEqual(f.candidate.selection);
    const stored = persisted(f, summary.id);
    const configuration = JSON.parse(
      stored.configuration_manifest_json ?? "null",
    ) as C.EvaluationConfigurationManifestV1;
    const cells = JSON.parse(stored.cell_manifest_json ?? "null") as C.EvaluationCellManifestV1;
    const scoring = JSON.parse(stored.scoring_plan_json ?? "null") as C.EvaluationScoringPlanV1;
    for (const row of readEvaluationBatchCells(f.database, summary.id)) {
      const expected = row.arm === "baseline" ? f.baseline : f.candidate;
      expect(configuration[row.arm].profileVersion).toEqual(expected.profile);
      expect(configuration[row.arm].prompt.version).toEqual(expected.prompt);
      expect(configuration[row.arm].modelRequirements).toEqual({ required: true });
      expect(row.plan.modelRequirements).toEqual({ required: true });
      expect(cells.cells.find((entry) => entry.cellId === row.id)?.modelRequirements).toEqual(
        row.plan.modelRequirements,
      );
      expect(scoring[row.arm]).toEqual(expected.selection);
      const template = createEvaluationExecutionTemplate({
        runId: row.run_id,
        plan: row.plan,
        planDigest: row.plan_digest,
        frozenPrompt: row.prompt,
      });
      expect(template.validation.modelRequirements).toEqual({ required: true });
      expect(readCell(f, row.run_id)?.plan).toEqual(row.plan);
    }
    const visible = detail(f, summary.id);
    expect(visible.summary).toEqual(summary);
    for (const arm of ["baseline", "candidate"] as const) {
      expect(visible.configurations[arm].modelRequirements).toEqual({ required: true });
      expect(visible.configurations[arm].profile.id).toBe(f[arm].profile.id);
      expect(visible.configurations[arm].prompt.id).toBe(f[arm].prompt.id);
    }
  });

  it("dispatches required-model evaluations for configured Worker CLIs without provider registration", () => {
    const f = fixture(),
      summary = f.create();
    const row = readEvaluationBatchCells(f.database, summary.id).find(
      (cell) => cell.applicable === 1,
    );
    if (!row) throw new Error("An applicable fixture cell is required.");
    const readiness = evaluateEvaluationRunReadiness(row.plan, []);
    expect(readiness[0]?.reasons).toEqual([{ code: "unsupported_target" }]);
    const dispatched = handleValidationDispatchRequest(
      f.database,
      { operation: "dispatchPendingReviewRuns", input: { limit: 128 } },
      changedAt,
    ) as ValidationDispatchOperationMap["dispatchPendingReviewRuns"]["output"];
    expect(dispatched.createdJobs).toHaveLength(2);
    expect(dispatched.blockedRequestCount).toBe(0);
    for (const job of dispatched.createdJobs) {
      f.database.exec("BEGIN");
      try {
        const current = inspectJobAdmissionReadinessInTransaction(f.database, job.jobId, changedAt);
        expect(current.ready).toBe(false);
        expect(current.reasons.some((reason) => reason.code === "plan_prerequisite_missing")).toBe(
          false,
        );
      } finally {
        f.database.exec("ROLLBACK");
      }
    }
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
    expect(detail(f, summary.id).summary).toEqual(summary);
  });

  it("keeps frozen records intact during exact creation replays", () => {
    const f = fixture(),
      input = structuredClone(f.input),
      summary = f.create(input),
      before = persisted(f, summary.id);
    expect(f.create(input, { readOnly: true })).toEqual(summary);
    expect(detail(f, summary.id).summary).toEqual(summary);
    expect(canonicalJson(f.create(input))).toBe(canonicalJson(summary));
    expect(persisted(f, summary.id)).toEqual(before);
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM evaluations").get()).toEqual({
      count: 1,
    });
  });

  it("freezes profile-only evaluations without requesting CLI model content", () => {
    const f = fixture("issue"),
      input = structuredClone(f.input);
    input.request.mode = "profile_only";
    const summary = f.create(input);
    for (const row of readEvaluationBatchCells(f.database, summary.id)) {
      expect(row.plan.modelRequirements).toEqual({ required: false });
      const template = createEvaluationExecutionTemplate({
        runId: row.run_id,
        plan: row.plan,
        planDigest: row.plan_digest,
        frozenPrompt: row.prompt,
      });
      expect(template.validation.modelRequirements).toEqual({ required: false });
      expect(readCell(f, row.run_id)?.plan).toEqual(row.plan);
    }
    const visible = detail(f, summary.id);
    expect(visible.configurations.baseline.modelRequirements).toEqual({ required: false });
    expect(visible.configurations.candidate.modelRequirements).toEqual({ required: false });
  });

  it("reauthorizes repository access before an exact frozen creation replay", () => {
    const f = fixture(),
      input = structuredClone(f.input);
    input.actor = { issuer: "https://fixture.invalid", subject: "repository-maintainer" };
    setEvaluationManagementRole(f.database, f.repositoryId, "maintainer", 0, input.actor);
    // A repository actor may select its current bound prompt in both arms.
    input.request.candidate = { ...input.request.baseline };
    input.request.checkMappings = input.request.checkMappings.map((mapping) => ({
      ...mapping,
      candidateCheckId: mapping.baselineCheckId,
    }));
    f.create(input);
    setEvaluationManagementRole(f.database, f.repositoryId, "viewer", 1, input.actor);
    expect(() => f.create(input)).toThrow();
  });
});
