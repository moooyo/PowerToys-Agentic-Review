import type { ValidationJobResultV1 } from "@agentic-review/codex";
import type * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { evaluationBatchNow, readEvaluationBatchCells } from "./evaluation-batches.testing.js";
import {
  beginAttempt,
  completedAt,
  prepareEvaluationCompletionFixture,
  resultFor,
  selected,
  settle,
  transaction,
  validate,
} from "./evaluation-completion.testing.js";
import { cancelEvaluationBatchInTransaction } from "./evaluation-control.js";
import { readEvaluationExecutionCellInTransaction } from "./evaluation-execution.js";
import {
  evaluationActor,
  evaluationAdministrator,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";
import { handleEvaluationBatchRequest } from "./evaluation-queries.js";
import { handleEvaluationReproductionRequest } from "./evaluation-reproduction.js";
import { createEvaluationReproductionFixture } from "./evaluation-reproduction.testing.js";
import { getEvaluationCellResult } from "./evaluation-results.js";
import {
  assertCurrentIssueReproductionAuthorization,
  recomputeIssueReproductionRequestAssessment,
} from "./issue-reproduction.js";
import { getJobAdmissionRecord } from "./job-admission.js";
import { parseExecutionTemplate } from "./scheduling-eligibility.js";
import { dispatchEvaluationRequestInTransaction } from "./validation-dispatch.js";
import { persistValidatedValidationResult } from "./validation-results.js";

const fixtures: { close(): void }[] = [];
function isIssueResult(
  value: ValidationJobResultV1,
): value is Extract<ValidationJobResultV1, { report: { workItemKind: "issue" } }> {
  return value.report.workItemKind === "issue";
}
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.close();
});
afterAll(() => {
  for (const [name, value] of formats) {
    if (value === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, value);
  }
});
function fixture(options?: Parameters<typeof createEvaluationReproductionFixture>[0]) {
  const value = createEvaluationReproductionFixture(options);
  fixtures.push(value);
  return value;
}
function read(f: ReturnType<typeof fixture>, operation: "getEvaluationSourceReproduction") {
  return handleEvaluationReproductionRequest(
    f.database,
    {
      operation,
      input: { repositoryId: f.repositoryId, actor: evaluationActor, sourceId: f.source.id },
    },
    evaluationBatchNow,
    [evaluationAdministrator],
  ) as C.EvaluationReproductionSourceDefinitionReadV1;
}
function plan(f: ReturnType<typeof fixture>, batch: C.EvaluationBatchSummaryV1) {
  return handleEvaluationReproductionRequest(
    f.database,
    {
      operation: "getEvaluationReproductionPlan",
      input: {
        repositoryId: f.repositoryId,
        actor: evaluationActor,
        evaluationId: batch.id,
      },
    },
    evaluationBatchNow,
    [evaluationAdministrator],
  ) as C.EvaluationReproductionPlanV1;
}
function preview(f: ReturnType<typeof fixture>, selection = f.selection) {
  return handleEvaluationReproductionRequest(
    f.database,
    {
      operation: "previewEvaluationReproduction",
      input: {
        repositoryId: f.repositoryId,
        actor: evaluationActor,
        request: {
          sourceId: f.source.id,
          selection,
          baselineProfileVersionId: f.baseline.profile.id,
          candidateProfileVersionId: f.candidate.profile.id,
        },
      },
    },
    evaluationBatchNow,
    [evaluationAdministrator],
  ) as C.EvaluationReproductionPreviewV1;
}
function counts(f: ReturnType<typeof fixture>) {
  return Object.fromEntries(
    [
      "evaluations",
      "evaluation_cells",
      "review_runs",
      "review_run_requests",
      "evaluation_mutation_receipts",
      "evaluation_reproduction_sources",
      "evaluation_reproduction_cells",
      "evaluation_reproduction_manifests",
    ].map((table) => [
      table,
      f.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
    ]),
  );
}

describe("frozen evaluation reproduction owners", () => {
  it("reads the original source and previews distinct arms without persisting authority", () => {
    const f = fixture(),
      before = counts(f);
    const definition = read(f, "getEvaluationSourceReproduction");
    expect(definition.sourceDefinition).toEqual(f.definition);
    expect(definition.sourceDefinitionSha256).toBe(sha256(canonicalJson(f.definition)));
    const result = preview(f);
    expect(result.baseline).toEqual({
      profileVersionId: f.baseline.profile.id,
      profileConfigSha256: f.baseline.profile.configSha256,
      state: "ready",
      blockers: [],
    });
    expect(result.candidate).toEqual({
      profileVersionId: f.candidate.profile.id,
      profileConfigSha256: f.candidate.profile.configSha256,
      state: "ready",
      blockers: [],
    });
    expect(canonicalJson(result)).not.toContain("authorizedBy");
    expect(canonicalJson(result)).not.toContain("preview-activation");
    expect(counts(f)).toEqual(before);
  });

  it("freezes complete V2 records with independent bindings and retains non-applicable cells", () => {
    const f = fixture({ notApplicableCase: true }),
      batch = f.create();
    const cells = readEvaluationBatchCells(f.database, batch.id);
    expect(cells).toHaveLength(4);
    const root = plan(f, batch).manifest;
    expect(root?.cells).toHaveLength(4);
    expect(root?.sources).toHaveLength(2);
    const readCells = cells.map((cell) =>
      transaction(f.database, () =>
        readEvaluationExecutionCellInTransaction(f.database, {
          repositoryId: f.repositoryId,
          runId: cell.run_id,
        }),
      ),
    );
    expect(readCells.filter((cell) => cell?.reproductionReadiness.state === "ready")).toHaveLength(
      2,
    );
    expect(
      readCells.filter((cell) => cell?.reproductionReadiness.state === "not_applicable"),
    ).toHaveLength(2);
    const bindingDigests = new Set<string>();
    for (const cell of readCells) {
      expect(cell).not.toBeNull();
      if (!cell) throw new Error("Missing frozen cell.");
      const detail = handleEvaluationReproductionRequest(
        f.database,
        {
          operation: "getEvaluationReproductionCell",
          input: {
            repositoryId: f.repositoryId,
            actor: evaluationActor,
            evaluationId: batch.id,
            cellId: cell.cellId,
          },
        },
        evaluationBatchNow,
        [evaluationAdministrator],
      ) as C.EvaluationReproductionCellDetailV1;
      expect(detail.record).toEqual(cell.reproductionRecord);
      expect(detail.cellRecordSha256).toBe(sha256(canonicalJson(detail.record)));
      if (!cell.applicable) {
        expect(cell.plan.reproduction).toBeUndefined();
        continue;
      }
      const binding = cell.plan.reproduction;
      if (!binding) throw new Error("Missing mapped binding.");
      bindingDigests.add(binding.bindingDigest);
      expect(binding.binding.authorizedBy).toEqual({
        ...evaluationAdministrator,
        authorizedAt: evaluationBatchNow,
      });
      expect(binding.binding.activationId).toBe(cell.plan.activationId);
      expect(binding.binding.cases[0]).toMatchObject({
        requestId: cell.requestId,
        profileVersionId: cell.request.profileVersion.id,
      });
      expect(binding.binding.cases[0]?.presentWhen.allOf[0]?.observation).toEqual({
        kind: "probe_value",
        testStepId: `${cell.plan.purpose.arm}-probe`,
        observationId: `${cell.plan.purpose.arm}-state`,
      });
    }
    expect(bindingDigests.size).toBe(2);
    expect(
      f.database.prepare("SELECT plan_json FROM review_runs WHERE id = ?").get(f.run.id)?.plan_json,
    ).toBe(f.originalPlanJson);
  });

  it.each(["missing", "candidate-null"] as const)(
    "retains the entire matrix and repeatedly blocks %s mappings",
    (mode) => {
      const f = fixture();
      const request = structuredClone(f.input);
      if (mode === "missing") delete request.request.reproductionMappings;
      else {
        const mapping = request.request.reproductionMappings?.[0]?.candidate.observationMappings[0];
        if (!mapping) throw new Error("Missing synthetic mapping.");
        mapping.to = null;
      }
      const batch = f.create(request),
        cells = readEvaluationBatchCells(f.database, batch.id);
      expect(cells).toHaveLength(2);
      for (const cell of cells) {
        const blocked = mode === "missing" || cell.arm === "candidate";
        for (let index = 0; index < 2; index += 1) {
          const outcome = transaction(f.database, () =>
            dispatchEvaluationRequestInTransaction(
              f.database,
              {
                repositoryId: f.repositoryId,
                reviewRunId: cell.run_id,
                requestId: cell.request_id,
              },
              evaluationBatchNow,
            ),
          );
          if (blocked) {
            expect(outcome.createdJobs).toHaveLength(0);
            expect(outcome.blockedRequests).toEqual([
              {
                requestId: cell.request_id,
                reasons: [{ code: "reproduction_mapping_blocked" }],
              },
            ]);
          }
        }
      }
      const matrix = handleEvaluationBatchRequest(
        f.database,
        {
          operation: "getEvaluationBatchMatrix",
          input: { repositoryId: f.repositoryId, evaluationId: batch.id, actor: evaluationActor },
        },
        evaluationBatchNow,
        [evaluationAdministrator],
      ) as C.EvaluationBatchMatrixV1;
      expect(
        matrix.cases
          .flatMap((entry) => [entry.baseline, entry.candidate])
          .filter((cell) => cell.state === "blocked"),
      ).toHaveLength(mode === "missing" ? 2 : 1);
    },
  );

  it("previews unknown targets as blocked while refusing a stale source digest atomically", () => {
    const f = fixture(),
      selection = structuredClone(f.selection),
      before = counts(f);
    const mapping = selection.candidate.observationMappings[0];
    if (!mapping) throw new Error("Missing synthetic mapping.");
    mapping.to = { kind: "probe_value", testStepId: "missing", observationId: "missing" };
    expect(preview(f, selection).candidate).toMatchObject({
      state: "blocked",
      blockers: [{ code: "profile_incompatible" }],
    });
    const request = structuredClone(f.input);
    const chosen = request.request.reproductionMappings?.[0];
    if (!chosen) throw new Error("Missing synthetic mapping.");
    chosen.expectedSource.planDigest = "e".repeat(64);
    expect(() => f.create(request)).toThrow(expect.objectContaining({ code: "PLATFORM_INVALID" }));
    expect(counts(f)).toEqual(before);
  });

  it("checks repository read access before source, preview, and historical mapping reads", () => {
    const f = fixture(),
      batch = f.create();
    expect(() =>
      handleEvaluationReproductionRequest(
        f.database,
        {
          operation: "getEvaluationSourceReproduction",
          input: {
            repositoryId: f.secondRepositoryId,
            actor: evaluationActor,
            sourceId: f.source.id,
          },
        },
        evaluationBatchNow,
        [evaluationAdministrator],
      ),
    ).toThrow();
    setEvaluationManagementRole(f.database, f.repositoryId, null, 1);
    expect(() => read(f, "getEvaluationSourceReproduction")).toThrow();
    expect(() => preview(f)).toThrow();
    expect(() => plan(f, batch)).toThrow();
    setEvaluationManagementRole(f.database, f.repositoryId, "viewer", 2);
    expect(read(f, "getEvaluationSourceReproduction").sourceDefinition).toEqual(f.definition);
    expect(plan(f, batch).manifest?.cells).toHaveLength(2);
  });

  it("replays the exact immutable batch during recovery and refuses a new request", () => {
    const f = fixture(),
      batch = f.create(),
      before = counts(f);
    expect(f.create(f.input, { readOnly: true })).toEqual(batch);
    expect(() =>
      f.create(
        { ...f.input, request: { ...f.input.request, changeId: "new-recovery-change" } },
        { readOnly: true },
      ),
    ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
    expect(counts(f)).toEqual(before);
  });

  it.each(["sources", "cells", "manifests"] as const)(
    "prevents replacement and mutation of immutable reproduction %s",
    (name) => {
      const f = fixture();
      f.create();
      const table = `evaluation_reproduction_${name}`;
      const row = f.database.prepare(`SELECT * FROM ${table} LIMIT 1`).get();
      if (!row) throw new Error("Missing frozen sidecar row.");
      expect(() => f.database.exec(`DELETE FROM ${table}`)).toThrow(
        "evaluation reproduction records cannot be deleted",
      );
      expect(() => f.database.exec(`UPDATE ${table} SET created_at = created_at`)).toThrow(
        /immutable/u,
      );
      const fields = Object.keys(row);
      expect(() =>
        f.database
          .prepare(
            `INSERT OR REPLACE INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
          )
          .run(...Object.values(row)),
      ).toThrow();
    },
  );

  it("detects a changed source binding even when its enclosing source plan digest is recomputed", () => {
    const f = fixture();
    f.create();
    const plan = structuredClone(f.run.plan);
    if (!plan.reproduction) throw new Error("Missing source binding.");
    plan.reproduction.binding.claim = "Tampered synthetic historical claim.";
    plan.reproduction.bindingDigest = sha256(canonicalJson(plan.reproduction.binding));
    const json = canonicalJson(plan);
    expect(() =>
      f.database
        .prepare("UPDATE review_runs SET plan_json=?,plan_digest=? WHERE id=?")
        .run(json, sha256(json), f.run.id),
    ).toThrow(/immutable/u);
    // The explicit corruption fixture first proves the real immutable guard rejects the write.
    f.database.exec("DROP TRIGGER tr_review_runs_immutable_update");
    f.database
      .prepare("UPDATE review_runs SET plan_json=?,plan_digest=? WHERE id=?")
      .run(json, sha256(json), f.run.id);
    expect(() => read(f, "getEvaluationSourceReproduction")).toThrow(
      expect.objectContaining({ code: "PLATFORM_CORRUPT" }),
    );
  });

  it("rejects duplicate JSON keys in a new sidecar and rolls back the whole batch", () => {
    const f = fixture(),
      before = counts(f),
      prepare = f.database.prepare.bind(f.database);
    vi.spyOn(f.database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("INSERT INTO evaluation_reproduction_cells(")) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement, "run").mockImplementation((...values) => {
          const serialized = values[6];
          if (typeof serialized !== "string") throw new Error("Missing sidecar JSON.");
          values[6] = `${serialized.slice(0, -1)},"state":"ready"}`;
          return run(...values);
        });
      }
      return statement;
    });
    expect(() => f.create()).toThrow();
    expect(counts(f)).toEqual(before);
  });

  it("dispatches required CLI review with a complete reproduction mapping", () => {
    const f = fixture({ requiredModel: true }),
      batch = f.create();
    for (const cell of readEvaluationBatchCells(f.database, batch.id)) {
      const outcome = transaction(f.database, () =>
        dispatchEvaluationRequestInTransaction(
          f.database,
          { repositoryId: f.repositoryId, reviewRunId: cell.run_id, requestId: cell.request_id },
          evaluationBatchNow,
        ),
      );
      expect(outcome.createdJobs).toHaveLength(1);
      expect(outcome.blockedRequests).toEqual([]);
    }
  });

  it("completes both mapped arms through the real completion guard and reads their independent measured conclusions", () => {
    const base = fixture(),
      f = prepareEvaluationCompletionFixture(base, "issue", {
        issueReproduction: "1",
        structuredProbeOutput: "1",
      });
    for (const arm of ["baseline", "candidate"] as const) {
      const cell = selected(f, arm),
        completion = beginAttempt(f, cell);
      expect(parseExecutionTemplate(canonicalJson(cell.template)).ok).toBe(true);
      const result: ValidationJobResultV1 = resultFor(cell);
      if (!isIssueResult(result)) throw new Error("Missing synthetic Issue report.");
      const profile = cell.template.validation.profileVersion,
        probe = profile.config.test[0];
      if (!probe?.probeOutput?.fields[0]) throw new Error("Missing declared synthetic probe.");
      const probeCheck = `${profile.id}:${probe.id}`;
      const build = result.report.checks[0],
        diagnostic = result.execution.diagnostics[0];
      if (!build || !diagnostic) throw new Error("Missing build observation.");
      build.outcome = "passed";
      diagnostic.outcome = "passed";
      diagnostic.exitCode = 0;
      result.report.checks.push({
        id: probeCheck,
        name: probe.name,
        kind: "test",
        required: true,
        outcome: "passed",
        summary: "Synthetic protocol observation; no command was executed.",
        expected: null,
        actual: null,
        evidenceIds: [],
        source: "runner",
      });
      result.execution.diagnostics.push({
        stepId: probeCheck,
        phase: "test",
        outcome: "passed",
        exitCode: 0,
        summary: "Synthetic process settlement.",
      });
      const output: C.TestProbeReceiptV1["output"] = {
        schemaVersion: "ProbeObservationsV1",
        observations: [
          {
            id: probe.probeOutput.fields[0].id,
            state: "observed",
            value: { type: "boolean", value: arm === "baseline" },
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
          profileVersionId: profile.id,
          checkId: probeCheck,
          capture: "complete",
          output,
          outputSha256: sha256(canonicalJson(output)),
        },
      ];
      const measured = recomputeIssueReproductionRequestAssessment({
        validation: cell.template.validation,
        jobId: cell.jobId,
        runAttemptId: completion.runAttemptId,
        result,
      });
      if (!measured) throw new Error("Missing mapped measurement.");
      result.reproductionAssessment = measured.assessment;
      result.report.reproductionConclusion = measured.assessment.conclusion;
      const accepted = validate(f, completion, result);
      transaction(f.database, () => {
        assertCurrentIssueReproductionAuthorization(f.database, cell.template, {
          jobId: cell.jobId,
          runAttemptId: completion.runAttemptId,
        });
        settle(f.database, completion, accepted);
        persistValidatedValidationResult(f.database, completion, accepted, completedAt);
        f.database
          .prepare(
            "UPDATE jobs SET status='succeeded',current_run_attempt_id=NULL,completed_at=? WHERE id=?",
          )
          .run(completedAt, cell.jobId);
      });
      const stored = f.database
        .prepare("SELECT id FROM validation_job_results WHERE job_id=?")
        .get(cell.jobId);
      if (typeof stored?.id !== "string") throw new Error("Missing actual persisted result.");
      const projected = getEvaluationCellResult(
        f.database,
        {
          repositoryId: f.repositoryId,
          evaluationId: f.batch.id,
          cellId: cell.id,
          resultId: stored.id,
          actor: evaluationActor,
        },
        [evaluationAdministrator],
      );
      if (projected.report.workItemKind !== "issue")
        throw new Error("Missing projected synthetic Issue report.");
      expect(projected.report.reproductionConclusion).toBe(
        arm === "baseline" ? "confirmed" : "not_reproduced",
      );
      expect(projected.modelReview.state).toBe("not_requested");
      expect(
        f.database
          .prepare("SELECT result_json FROM validation_job_results WHERE id=?")
          .get(stored.id)?.result_json,
      ).toBe(canonicalJson(result));
    }
  });

  it("rejects final evaluation reproduction authority after cancellation without consulting the ordinary Issue epoch", () => {
    const base = fixture(),
      f = prepareEvaluationCompletionFixture(base, "issue", {
        issueReproduction: "1",
        structuredProbeOutput: "1",
      }),
      cell = selected(f),
      completion = beginAttempt(f, cell);
    transaction(f.database, () =>
      cancelEvaluationBatchInTransaction(
        f.database,
        {
          repositoryId: f.repositoryId,
          evaluationId: f.batch.id,
          actor: evaluationAdministrator,
          request: {
            changeId: "cancel-mapped",
            expectedVersion: 1,
            reason: "Stop the synthetic batch.",
          },
        },
        completedAt,
        [evaluationAdministrator],
      ),
    );
    expect(() =>
      transaction(f.database, () =>
        assertCurrentIssueReproductionAuthorization(f.database, cell.template, {
          jobId: cell.jobId,
          runAttemptId: completion.runAttemptId,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "STORED_EXECUTION_TEMPLATE_INVALID" }));
  });

  it("does not admit mapped work to a synthetic Worker without the required observation protocols", () => {
    const f = prepareEvaluationCompletionFixture(fixture());
    for (const cell of f.cells)
      expect(getJobAdmissionRecord(f.database, cell.jobId)).toMatchObject({
        state: "pending",
        admittedAt: null,
        blockers: ["no_compatible_worker"],
      });
  });

  it.each(["job cancellation", "worker supersession"] as const)(
    "rechecks %s in the final mapped evaluation authority transaction",
    (change) => {
      const f = prepareEvaluationCompletionFixture(fixture(), "issue", {
          issueReproduction: "1",
          structuredProbeOutput: "1",
        }),
        cell = selected(f),
        completion = beginAttempt(f, cell);
      const scope = { jobId: cell.jobId, runAttemptId: completion.runAttemptId };
      transaction(f.database, () => {
        expect(() =>
          assertCurrentIssueReproductionAuthorization(f.database, cell.template, scope),
        ).not.toThrow();
        const changed =
          change === "job cancellation"
            ? f.database
                .prepare("UPDATE jobs SET cancellation_requested_at=? WHERE id=?")
                .run(completedAt, cell.jobId)
            : f.database
                .prepare("UPDATE workers SET superseded_at=? WHERE id='evaluation-worker'")
                .run(completedAt);
        expect(Number(changed.changes)).toBe(1);
        expect(() =>
          assertCurrentIssueReproductionAuthorization(f.database, cell.template, scope),
        ).toThrow(expect.objectContaining({ code: "STORED_EXECUTION_TEMPLATE_INVALID" }));
        expect(
          f.database
            .prepare(
              "SELECT worker_id,worker_node_id,worker_instance_id FROM run_attempts WHERE id=?",
            )
            .get(completion.runAttemptId),
        ).toMatchObject({
          worker_id: "evaluation-worker",
          worker_node_id: "evaluation-node",
          worker_instance_id: "evaluation-instance",
        });
      });
    },
  );
});
