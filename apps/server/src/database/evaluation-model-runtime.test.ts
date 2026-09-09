import type * as C from "@agentic-review/contracts";
import {
  evaluateEvaluationRunReadiness,
  modelRuntimeRegistrationDigest,
} from "@agentic-review/domain";
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
import { handleModelRuntimeRegistryRequest } from "./model-runtime-registry.js";
import { handleValidationDispatchRequest } from "./validation-dispatch.js";

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
const registeredAt = "2026-09-08T02:59:00.000Z";
const changedAt = "2026-09-08T03:01:00.000Z";
function register(f: Fixture, suffix = "baseline", enabled = true): C.ModelRuntimeStatusV1 {
  return handleModelRuntimeRegistryRequest(
    f.database,
    {
      operation: "registerModelRuntime",
      input: {
        actor: evaluationAdministrator,
        request: {
          changeId: `register-${suffix}`,
          name: `Expected runtime ${suffix}`,
          requestedModel: `requested-${suffix}`,
          enabled,
          identity: {
            schemaVersion: "ModelRuntimeIdentityV1",
            providerId: "fixture-provider",
            endpointSha256: "a".repeat(64),
            modelId: `observed-${suffix}`,
            client: {
              kind: "codex_cli",
              version: "fixture-cli",
              executableSha256: "b".repeat(64),
              launchPolicySha256: "c".repeat(64),
            },
            relay: { implementationSha256: "d".repeat(64), policySha256: "e".repeat(64) },
          },
        },
      },
    },
    registeredAt,
    [evaluationAdministrator],
  ) as C.ModelRuntimeStatusV1;
}
function select(f: Fixture, baseline: C.ModelRuntimeStatusV1, candidate = baseline) {
  const input = structuredClone(f.input);
  input.request.baseline.modelRuntimeRegistrationId = baseline.registration.id;
  input.request.candidate.modelRuntimeRegistrationId = candidate.registration.id;
  return input;
}
function disable(f: Fixture, runtime: C.ModelRuntimeStatusV1) {
  return handleModelRuntimeRegistryRequest(
    f.database,
    {
      operation: "changeModelRuntimeControl",
      input: {
        actor: evaluationAdministrator,
        registrationId: runtime.registration.id,
        request: {
          changeId: "disable-model-runtime",
          expectedVersion: 1,
          enabled: false,
          reason: "Stop new selections.",
        },
      },
    },
    changedAt,
    [evaluationAdministrator],
  );
}
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

describe("Evaluation model runtime registration integration", () => {
  it("freezes independent arm identities through configuration, plan, context, summary and scoring", () => {
    const f = fixture(),
      baseline = register(f),
      candidate = register(f, "candidate");
    const input = select(f, baseline, candidate),
      summary = f.create(input);
    expect(summary.baseline.modelRuntimeRegistrationId).toBe(baseline.registration.id);
    expect(summary.candidate.modelRuntimeRegistrationId).toBe(candidate.registration.id);
    const stored = persisted(f, summary.id);
    const configuration = JSON.parse(
      stored.configuration_manifest_json ?? "null",
    ) as C.EvaluationConfigurationManifestV1;
    const cells = JSON.parse(stored.cell_manifest_json ?? "null") as C.EvaluationCellManifestV1;
    const scoring = JSON.parse(stored.scoring_plan_json ?? "null") as C.EvaluationScoringPlanV1;
    for (const row of readEvaluationBatchCells(f.database, summary.id)) {
      const expected = row.arm === "baseline" ? baseline.registration : candidate.registration;
      expect(configuration[row.arm].modelRuntimeRegistration).toEqual(expected);
      expect(row.plan.modelRuntimeRegistration).toEqual(expected);
      expect(row.plan.modelRequirements).toEqual({
        required: true,
        expectedModelIdentityDigest: expected.identitySha256,
        runtimeRegistration: {
          registrationId: expected.id,
          registrationSha256: modelRuntimeRegistrationDigest(expected),
        },
      });
      expect(cells.cells.find((entry) => entry.cellId === row.id)?.modelRequirements).toEqual(
        row.plan.modelRequirements,
      );
      expect(cells.cells.find((entry) => entry.cellId === row.id)).not.toHaveProperty(
        "modelRuntimeRegistration",
      );
      expect(scoring[row.arm].modelIdentityDigest).toBe(expected.identitySha256);
      const template = createEvaluationExecutionTemplate({
        runId: row.run_id,
        plan: row.plan,
        planDigest: row.plan_digest,
        frozenPrompt: row.prompt,
      });
      expect(template.validation.modelRuntimeRegistration).toEqual(expected);
      expect(readCell(f, row.run_id)?.plan).toEqual(row.plan);
    }
    const visible = detail(f, summary.id);
    expect(visible.summary).toEqual(summary);
    expect(visible.configurations.baseline.modelRuntimeRegistration).toEqual(baseline.registration);
    expect(visible.configurations.candidate.modelRuntimeRegistration).toEqual(
      candidate.registration,
    );
  });
  it("does not turn a registered expectation into accepted model execution", () => {
    const f = fixture(),
      runtime = register(f),
      summary = f.create(select(f, runtime));
    const row = readEvaluationBatchCells(f.database, summary.id).find(
      (cell) => cell.applicable === 1,
    );
    if (!row) throw new Error("An applicable fixture cell is required.");
    const readiness = evaluateEvaluationRunReadiness(row.plan, []);
    expect(readiness[0]?.reasons).toContainEqual({
      code: "missing_capability",
      capability: "verified_model_execution",
    });
    handleValidationDispatchRequest(
      f.database,
      { operation: "dispatchPendingReviewRuns", input: { limit: 128 } },
      changedAt,
    );
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM run_attempts").get()).toEqual({
      count: 0,
    });
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get(),
    ).toEqual({ count: 0 });
    expect(detail(f, summary.id).summary).toEqual(summary);
  });
  it("keeps frozen records and exact replay intact after registration selection is disabled", () => {
    const f = fixture(),
      runtime = register(f),
      input = select(f, runtime),
      summary = f.create(input);
    const before = persisted(f, summary.id);
    disable(f, runtime);
    expect(f.create(input, { readOnly: true })).toEqual(summary);
    expect(detail(f, summary.id).configurations.baseline.modelRuntimeRegistration).toEqual(
      runtime.registration,
    );
    const row = readEvaluationBatchCells(f.database, summary.id)[0];
    if (!row) throw new Error("A fixture cell is required.");
    expect(readCell(f, row.run_id)?.plan.modelRuntimeRegistration).toEqual(runtime.registration);
    expect(persisted(f, summary.id)).toEqual(before);
    const next = structuredClone(input);
    next.request.changeId = "new-batch-after-disable";
    expect(() =>
      handleEvaluationBatchRequest(
        f.database,
        {
          operation: "createEvaluationBatch",
          input: next,
        },
        "2026-09-08T03:02:00.000Z",
        [evaluationAdministrator],
      ),
    ).toThrowError(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM evaluations").get()).toEqual({
      count: 1,
    });
  });
  it("rejects unknown, disabled and client-forged registrations before any evaluation rows exist", () => {
    const f = fixture(),
      runtime = register(f, "disabled", false),
      input = select(f, runtime);
    expect(() => f.create(input)).toThrow();
    input.request.baseline.modelRuntimeRegistrationId = "missing-registration";
    expect(() => f.create(input)).toThrow();
    Object.assign(input.request.baseline, { modelRuntimeRegistration: runtime.registration });
    expect(() => f.create(input)).toThrow();
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM evaluations").get()).toEqual({
      count: 0,
    });
  });
  it("does not allow a model selection in profile-only mode", () => {
    const f = fixture("issue"),
      runtime = register(f),
      input = select(f, runtime);
    input.request.mode = "profile_only";
    expect(() => f.create(input)).toThrow();
    expect(f.database.prepare("SELECT COUNT(*) AS count FROM evaluations").get()).toEqual({
      count: 0,
    });
  });
  it("preserves old unknown batches byte for byte after later model registration", () => {
    const f = fixture(),
      summary = f.create(),
      before = persisted(f, summary.id);
    register(f);
    const visible = detail(f, summary.id);
    expect(visible.summary).toEqual(summary);
    expect(visible.configurations.baseline.modelRequirements).toEqual({
      required: true,
      expectedModelIdentityDigest: null,
    });
    expect(visible.configurations.baseline).not.toHaveProperty("modelRuntimeRegistration");
    expect(persisted(f, summary.id)).toEqual(before);
    expect(canonicalJson(f.create())).toBe(canonicalJson(summary));
  });
  it("reauthorizes repository access before an exact frozen creation replay", () => {
    const f = fixture(),
      runtime = register(f),
      input = select(f, runtime);
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
