import * as C from "@agentic-review/contracts";
import {
  captureEvaluationObservations,
  evaluateEvaluationRunReadiness,
  freezeEvaluationScoringPlan,
  scoreEvaluation,
} from "@agentic-review/domain";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import { createEvaluationBatchInTransaction } from "./evaluation-batches.js";
import {
  createEvaluationBatchFixture,
  evaluationBatchNow,
  readEvaluationBatchCells,
} from "./evaluation-batches.testing.js";
import { handleEvaluationManagementRequest } from "./evaluation-management.js";
import {
  evaluationActor,
  evaluationAdministrator,
  reviseEvaluationManagementSource,
  setEvaluationManagementRole,
} from "./evaluation-management.testing.js";

type Fixture = ReturnType<typeof createEvaluationBatchFixture>;
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
function fixture(
  kind: "pull_request" | "issue" = "pull_request",
  options?: Parameters<typeof createEvaluationBatchFixture>[1],
) {
  const value = createEvaluationBatchFixture(kind, options);
  fixtures.push(value);
  return value;
}
function count(value: Fixture, table: string) {
  return (
    value.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
  ).count;
}
const changedTables = [
  "evaluations",
  "evaluation_authorizations",
  "evaluation_controls",
  "evaluation_cells",
  "evaluation_seals",
  "evaluation_mutation_receipts",
  "review_runs",
  "review_run_requests",
  "review_run_audit",
  "validation_dispatch_checks",
  "jobs",
  "request_epochs",
];
const counts = (value: Fixture) =>
  Object.fromEntries(changedTables.map((table) => [table, count(value, table)]));
function only<T>(values: T[]): T {
  const value = values[0];
  if (values.length !== 1 || value === undefined)
    throw new Error("Expected exactly one fixture value.");
  return value;
}

function publishCriterionCases(value: Fixture, caseCount: number, criteriaPerCase: number) {
  const scope = {
    repositoryId: value.repositoryId,
    suiteId: value.suite.id,
    actor: evaluationAdministrator,
  };
  const current = handleEvaluationManagementRequest(
    value.database,
    { operation: "getEvaluationSuite", input: scope },
    evaluationBatchNow,
    [evaluationAdministrator],
  ) as C.EvaluationSuiteDetailV1;
  const cases: C.EvaluationSuiteDraftCase[] = Array.from({ length: caseCount }, (_, index) => ({
    caseId: `case-mapping-${index}`,
    title: `Frozen mapping example ${index}`,
    sourceId: value.source.id,
    applicability: { state: "applicable" },
    criteria: Array.from({ length: criteriaPerCase }, (_, criterionIndex) => ({
      criterionId: `criterion-${criterionIndex}`,
      description: `Expected behavior ${criterionIndex} for this frozen example.`,
      applicability: { state: "applicable" },
      expectedOutcome: "failed",
    })),
    findings: { annotation: "complete", expected: [] },
  }));
  const saved = handleEvaluationManagementRequest(
    value.database,
    {
      operation: "saveEvaluationSuiteDraft",
      input: {
        ...scope,
        request: {
          changeId: "save-criterion-mapping-cases",
          expectedRevision: current.draftRevision,
          draft: { name: current.name, description: current.description, cases },
        },
      },
    },
    evaluationBatchNow,
    [evaluationAdministrator],
  ) as C.EvaluationSuiteSummaryV1;
  const version = handleEvaluationManagementRequest(
    value.database,
    {
      operation: "publishEvaluationSuite",
      input: {
        ...scope,
        request: {
          changeId: "publish-criterion-mapping-cases",
          expectedRevision: saved.draftRevision,
        },
      },
    },
    evaluationBatchNow,
    [evaluationAdministrator],
  ) as C.EvaluationSuiteVersionV1;
  const input = structuredClone(value.input);
  input.request.suiteVersionId = version.id;
  input.request.checkMappings = cases.flatMap((entry) =>
    entry.criteria.map((criterion) => ({
      caseId: entry.caseId,
      criterionId: criterion.criterionId,
      baselineCheckId: null,
      candidateCheckId: null,
    })),
  );
  return input;
}

describe("evaluation batch persistence", () => {
  it.each(["pull_request", "issue"] as const)(
    "atomically seals a complete new %s matrix without creating GitHub epochs or Jobs",
    (kind) => {
      const value = fixture(kind),
        before = counts(value);
      const result = value.create();
      const cells = readEvaluationBatchCells(value.database, result.id);
      expect(result).toMatchObject({
        caseCount: 2,
        cellCount: 4,
        suiteVersionId: value.version.id,
        createdAt: evaluationBatchNow,
      });
      expect(cells).toHaveLength(4);
      expect(new Set(cells.map((cell) => cell.run_id)).size).toBe(4);
      expect(new Set(cells.map((cell) => cell.request_id)).size).toBe(4);
      expect(count(value, "review_runs")).toBe((before.review_runs ?? 0) + 4);
      expect(count(value, "jobs")).toBe(before.jobs);
      expect(count(value, "request_epochs")).toBe(before.request_epochs);
      expect(count(value, "evaluation_seals")).toBe(1);
      const pending = value.database
        .prepare(`SELECT cell.applicable, checked.pending FROM evaluation_cells AS cell
      JOIN validation_dispatch_checks AS checked ON checked.review_run_id = cell.run_id WHERE cell.evaluation_id = ?`)
        .all(result.id);
      expect(pending.filter((row) => row.applicable === 1).every((row) => row.pending === 1)).toBe(
        true,
      );
      expect(pending.filter((row) => row.applicable === 0).every((row) => row.pending === 0)).toBe(
        true,
      );
      for (const cell of cells) {
        C.assertEvaluationReviewRunPlan(cell.plan);
        expect(cell.plan.requestEpochId).toBeNull();
        expect(cell.plan.testedSourceAuthorization).toBeNull();
        expect(cell.plan.purpose.upstreamMutationPolicy).toBe("forbidden");
        expect(cell.plan.purpose.cellId).toBe(cell.id);
        expect(cell.plan_digest).toBe(sha256(canonicalJson(cell.plan)));
        expect(cell.prompt.promptSha256).toBe(sha256(cell.prompt.renderedPrompt));
        expect(cell.prompt.renderedPrompt).not.toContain("The declared build failure is detected.");
        const template = createEvaluationExecutionTemplate({
          runId: cell.run_id,
          plan: cell.plan,
          planDigest: cell.plan_digest,
          frozenPrompt: cell.prompt,
        });
        expect(template.validation.purpose.cellId).toBe(cell.id);
        expect(template.validation.requestEpochId).toBeNull();
        expect(template.executionPolicy.requiredCapabilityLabels.validationEvaluation).toBe("1");
        expect(template.prompt).toEqual(cell.prompt);
        expect(
          evaluateEvaluationRunReadiness(cell.plan, []).flatMap((entry) => entry.reasons),
        ).not.toContainEqual({ code: "missing_source_authorization" });
        expect(
          evaluateEvaluationRunReadiness(cell.plan, []).flatMap((entry) => entry.reasons),
        ).toContainEqual({ code: "missing_capability", capability: "verified_model_identity" });
      }
      expect(value.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it("preserves frozen historical source and all manifest digests after the current revision changes", () => {
    const value = fixture();
    reviseEvaluationManagementSource(value, "A newer body must not replace the original.");
    const result = value.create();
    const row = value.database
      .prepare("SELECT * FROM evaluations WHERE id = ?")
      .get(result.id) as Record<string, string>;
    expect(row.configuration_manifest_sha256).toBe(sha256(row.configuration_manifest_json ?? ""));
    expect(row.cell_manifest_sha256).toBe(sha256(row.cell_manifest_json ?? ""));
    expect(row.execution_manifest_sha256).toBe(sha256(row.execution_manifest_json ?? ""));
    expect(row.scoring_plan_digest).toBe(sha256(row.scoring_plan_json ?? ""));
    for (const cell of readEvaluationBatchCells(value.database, result.id)) {
      expect(cell.plan.workItem.body).toBe("The original full report body.");
      expect(cell.plan.revision.revisionKey).toBe(value.reference.expectedRevisionKey);
    }
  });

  it.each(["pull_request", "issue"] as const)(
    "captures a persisted V2 %s source without inheriting its execution authorization",
    (kind) => {
      const value = fixture(kind),
        batch = value.create();
      const cell = readEvaluationBatchCells(value.database, batch.id)[0];
      if (!cell) throw new Error("The fixture requires a persisted evaluation cell.");
      reviseEvaluationManagementSource(value, "The current source has changed since evaluation.");
      const captured = handleEvaluationManagementRequest(
        value.database,
        {
          operation: "captureEvaluationSource",
          input: {
            repositoryId: value.repositoryId,
            actor: evaluationActor,
            request: {
              changeId: "capture-persisted-evaluation-source",
              source: {
                kind: "review_run",
                reviewRunId: cell.run_id,
                expectedPlanDigest: cell.plan_digest,
              },
            },
          },
        },
        "2026-09-08T04:00:00.000Z",
        [evaluationAdministrator],
      ) as C.EvaluationSourceSummaryV1;
      const detail = handleEvaluationManagementRequest(
        value.database,
        {
          operation: "getEvaluationSource",
          input: {
            repositoryId: value.repositoryId,
            actor: evaluationActor,
            sourceId: captured.id,
          },
        },
        "2026-09-08T04:00:00.000Z",
        [evaluationAdministrator],
      ) as C.EvaluationSourceDetailV1;
      expect(detail.snapshot.sourceDigest).toBe(cell.plan.source.sourceDigest);
      expect(detail.snapshot.workItem).toEqual(cell.plan.source.workItem);
      expect(detail.snapshot.testedSourceRevision).toEqual(cell.plan.source.testedSourceRevision);
      expect(detail.snapshot.provenance).toMatchObject({
        kind: "review_run",
        reviewRunId: cell.run_id,
        requestEpochId: null,
      });
      expect(Object.hasOwn(detail.snapshot, "authorization")).toBe(false);
    },
  );

  it("replays the original response without creating new cells or rereading current bindings", () => {
    const value = fixture(),
      first = value.create(),
      before = counts(value);
    const input = structuredClone(value.input);
    expect(value.create(input)).toEqual(first);
    expect(value.create({ ...input, replayOnly: true }, { readOnly: true })).toEqual(first);
    expect(counts(value)).toEqual(before);
  });

  it.each(["different_actor", "different_mode", "different_mapping", "other_operation"] as const)(
    "rejects a replay with %s",
    (change) => {
      const value = fixture();
      if (change !== "other_operation") value.create();
      const input = structuredClone(value.input);
      if (change === "different_actor") input.actor = evaluationActor;
      if (change === "different_mode") input.request.mode = "profile_only";
      if (change === "different_mapping") only(input.request.checkMappings).candidateCheckId = null;
      if (change === "other_operation") input.request.changeId = "batch-capture-source";
      const before = counts(value);
      expect(() => value.create(input)).toThrow(
        expect.objectContaining({ code: "PLATFORM_CONFLICT" }),
      );
      expect(counts(value)).toEqual(before);
    },
  );

  it.each(["read_only", "replay_only"] as const)("rejects new creation in %s mode", (mode) => {
    const value = fixture(),
      before = counts(value);
    expect(() =>
      value.create(
        { ...value.input, ...(mode === "replay_only" ? { replayOnly: true } : {}) },
        { readOnly: mode === "read_only" },
      ),
    ).toThrow(expect.objectContaining({ code: "DATABASE_READ_ONLY" }));
    expect(counts(value)).toEqual(before);
  });

  it("rechecks current repository permission before returning a receipt", () => {
    const value = fixture();
    const input = structuredClone(value.input);
    input.actor = evaluationActor;
    input.request.candidate = input.request.baseline;
    only(input.request.checkMappings).candidateCheckId = `${value.baseline.profile.id}:compile`;
    value.create(input);
    setEvaluationManagementRole(value.database, value.repositoryId, "viewer", 1);
    expect(() => value.create(input)).toThrow(
      expect.objectContaining({ code: "PLATFORM_FORBIDDEN" }),
    );
  });

  it("does not expose arbitrary global Prompt versions to repository maintainers", () => {
    const value = fixture(),
      before = counts(value);
    expect(() => value.create({ ...value.input, actor: evaluationActor })).toThrow(
      expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
    );
    expect(counts(value)).toEqual(before);
  });

  it("preserves optional Profile requirements while still creating both applicable cells", () => {
    const value = fixture("pull_request", { required: false });
    for (const cell of readEvaluationBatchCells(value.database, value.create().id)) {
      expect(only(cell.plan.jobs).required).toBe(false);
      expect(cell.plan.requiredCheckIds).toEqual([]);
    }
  });

  it("allows profile-only Issue validation without pretending model execution was required", () => {
    const value = fixture("issue"),
      input = structuredClone(value.input);
    input.request.mode = "profile_only";
    for (const cell of readEvaluationBatchCells(value.database, value.create(input).id)) {
      expect(cell.plan.modelRequirements).toEqual({
        required: false,
        expectedModelIdentityDigest: null,
      });
      const support = {
        workflowKind: "issue_validation" as const,
        target: "headless" as const,
        capabilities: [],
        evidenceDelivery: true,
      };
      expect(evaluateEvaluationRunReadiness(cell.plan, [support])[0]?.reasons).toContainEqual({
        code: "missing_capability",
        capability: "validationEvaluation",
      });
      expect(
        evaluateEvaluationRunReadiness(cell.plan, [
          { ...support, capabilities: ["validationEvaluation"] },
        ])[0],
      ).toMatchObject({
        state: "ready",
        reasons: [],
      });
    }
  });

  it("allows an authorized repository maintainer to select Prompt versions from its frozen runs", () => {
    const value = fixture();
    value.create();
    const input = structuredClone(value.input);
    input.actor = evaluationActor;
    input.request.changeId = "maintainer-reuses-known-configuration";
    expect(value.create(input).createdBy).toEqual(evaluationActor);
  });

  it.each(["missing", "extra", "unknown_check", "cross_repo", "static_profile_only"] as const)(
    "rejects %s selection before persisting any matrix rows",
    (change) => {
      const value = fixture(),
        input = structuredClone(value.input),
        before = counts(value);
      if (change === "missing") input.request.checkMappings = [];
      if (change === "extra")
        input.request.checkMappings.push({
          caseId: "outside",
          criterionId: "outside",
          baselineCheckId: null,
          candidateCheckId: null,
        });
      if (change === "unknown_check")
        only(input.request.checkMappings).candidateCheckId =
          `${value.candidate.profile.id}:missing`;
      if (change === "cross_repo") input.repositoryId = value.secondRepositoryId;
      if (change === "static_profile_only") input.request.mode = "profile_only";
      expect(() => value.create(input)).toThrow();
      expect(counts(value)).toEqual(before);
    },
  );

  it.each(["baseline", "candidate"] as const)(
    "rejects duplicate %s check mappings within one case before writing batch records",
    (arm) => {
      const value = fixture();
      const input = publishCriterionCases(value, 1, 2);
      for (const [index, mapping] of input.request.checkMappings.entries()) {
        mapping.baselineCheckId =
          arm === "baseline" || index === 0 ? `${value.baseline.profile.id}:compile` : null;
        mapping.candidateCheckId =
          arm === "candidate" || index === 0 ? `${value.candidate.profile.id}:compile` : null;
      }
      const before = counts(value);
      value.database.exec("BEGIN IMMEDIATE");
      try {
        expect(() =>
          createEvaluationBatchInTransaction(value.database, input, evaluationBatchNow, [
            evaluationAdministrator,
          ]),
        ).toThrow(
          expect.objectContaining({
            code: "PLATFORM_INVALID",
            message: "Mapped check IDs within an arm must be unique.",
          }),
        );
        expect(value.database.isTransaction).toBe(true);
        expect(counts(value)).toEqual(before);
        value.database.exec("COMMIT");
      } finally {
        if (value.database.isTransaction) value.database.exec("ROLLBACK");
      }
      expect(counts(value)).toEqual(before);
    },
  );

  it.each(["different_profiles", "same_profile"] as const)(
    "allows cross-case check reuse and repeated null mappings with %s without losing criteria",
    (configuration) => {
      const value = fixture();
      const input = publishCriterionCases(value, 2, 3);
      if (configuration === "same_profile") input.request.candidate = input.request.baseline;
      for (const mapping of input.request.checkMappings) {
        if (mapping.criterionId !== "criterion-0") continue;
        mapping.baselineCheckId = `${input.request.baseline.profileVersionId}:compile`;
        mapping.candidateCheckId = `${input.request.candidate.profileVersionId}:compile`;
      }
      const before = counts(value);
      const result = value.create(input);
      expect(result).toMatchObject({ caseCount: 2, cellCount: 4 });
      for (const [table, added] of [
        ["evaluations", 1],
        ["evaluation_cells", 4],
        ["review_runs", 4],
        ["review_run_requests", 4],
        ["evaluation_mutation_receipts", 1],
      ] as const)
        expect(count(value, table)).toBe((before[table] ?? 0) + added);
      expect(count(value, "jobs")).toBe(before.jobs);
      const row = value.database
        .prepare("SELECT scoring_plan_json, scoring_plan_digest FROM evaluations WHERE id = ?")
        .get(result.id) as { scoring_plan_json: string; scoring_plan_digest: string };
      const plan = JSON.parse(row.scoring_plan_json) as C.EvaluationScoringPlanV1;
      const frozen = freezeEvaluationScoringPlan(plan);
      expect(frozen.plan).toEqual(plan);
      expect(frozen.digest).toBe(row.scoring_plan_digest);
      expect(row.scoring_plan_digest).toBe(sha256(row.scoring_plan_json));
      expect(plan.cases).toHaveLength(2);
      for (const entry of plan.cases) {
        expect(entry.criteria).toHaveLength(3);
        expect(
          entry.criteria.map(({ criterionId, baselineCheckId, candidateCheckId }) => ({
            caseId: entry.caseId,
            criterionId,
            baselineCheckId,
            candidateCheckId,
          })),
        ).toEqual(input.request.checkMappings.filter((mapping) => mapping.caseId === entry.caseId));
      }
      // No execution result is invented: empty owner observations represent cells not yet run.
      const report = scoreEvaluation(frozen, captureEvaluationObservations(frozen, []));
      for (const arm of ["baseline", "candidate"] as const)
        expect(report[arm].coverage).toMatchObject({
          applicableCases: 2,
          notRunCases: 2,
          applicableCriteria: 6,
          unmappedCriteria: 4,
          checks: { numerator: 0, denominator: 6, value: 0 },
        });
      expect(value.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it("retains null mappings in the scoring denominator", () => {
    const value = fixture(),
      input = structuredClone(value.input);
    only(input.request.checkMappings).candidateCheckId = null;
    const row = value.database
      .prepare("SELECT scoring_plan_json FROM evaluations WHERE id = ?")
      .get(value.create(input).id) as { scoring_plan_json: string };
    const scored = JSON.parse(row.scoring_plan_json) as C.EvaluationScoringPlanV1;
    expect(scored.cases[0]?.criteria[0]).toMatchObject({
      criterionId: "criterion-compiler",
      expectedOutcome: "failed",
      candidateCheckId: null,
    });
  });

  it("rolls back all matrix rows after a failure while preserving the caller's transaction", () => {
    const value = fixture(),
      before = counts(value);
    value.database.exec(
      "CREATE TEMP TRIGGER reject_evaluation_seal BEFORE INSERT ON evaluation_seals BEGIN SELECT RAISE(ABORT, 'Injected seal failure'); END",
    );
    value.database.exec("BEGIN IMMEDIATE");
    try {
      expect(() =>
        createEvaluationBatchInTransaction(value.database, value.input, evaluationBatchNow, [
          evaluationAdministrator,
        ]),
      ).toThrow("Injected seal failure");
      expect(value.database.isTransaction).toBe(true);
      expect(counts(value)).toEqual(before);
      value.database.exec("COMMIT");
    } finally {
      if (value.database.isTransaction) value.database.exec("ROLLBACK");
    }
  });
});
