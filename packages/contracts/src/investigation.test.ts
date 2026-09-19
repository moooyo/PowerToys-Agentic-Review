import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  type InvestigationAnalysisEvidence,
  type InvestigationAnalysisV1,
  InvestigationAnalysisV1Schema,
  type InvestigationArtifactV1,
  InvestigationAttemptV1Schema,
  InvestigationCheckpointRequestSchema,
  InvestigationModelExecutionSchema,
  InvestigationModelIdentitySchema,
  type InvestigationResultV1,
  InvestigationResultV1Schema,
  InvestigationRuntimeStateSchema,
  type InvestigationSubjectV1,
  InvestigationTaskV1Schema,
  InvestigationUnacceptedModelUsageSchema,
  investigationCanonicalJson,
  investigationPlanDigestPayload,
  validateInvestigationAnalysisForTask,
  validateInvestigationResult,
  validateInvestigationTask,
} from "./investigation.js";
import { createInvestigationFixture } from "./investigation.testing.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("A required synthetic fixture item is missing.");
  return item;
}

function modelAnalysis(): InvestigationAnalysisV1 {
  const { result } = createInvestigationFixture("pr");
  return {
    schemaVersion: "InvestigationAnalysisV1",
    summary: result.report.summary,
    coverage: result.report.coverage,
    findings: result.findings,
    assessment: result.assessment,
    candidates: result.report.loop.candidates,
    rechecks: result.report.recheck.records,
    evidence: result.verificationEvidence.flatMap<InvestigationAnalysisEvidence>((item) => {
      if (item.source !== "static_analysis" && item.source !== "reporter_statement") return [];
      return [
        {
          id: item.id,
          subjectRef: item.subjectRef,
          source: item.source,
          summary: item.summary,
          evidenceRefs: item.evidenceRefs,
        },
      ];
    }),
    plans: result.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _sourceReportRef, ...plan }) => plan,
    ),
    nextActions: result.nextActions.map(
      ({ state: _state, sourceReportRef: _sourceReportRef, ...action }) => action,
    ),
    feedbackDrafts: result.feedbackDrafts,
    diagnostics: result.diagnostics,
    limitations: result.report.limitations,
  };
}

function expectSemanticFailure(result: InvestigationResultV1): void {
  // Keep every negative case structurally valid so it exercises the semantic boundary itself.
  expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
  const validation = validateInvestigationResult(result);
  expect(validation.valid).toBe(false);
  expect(validation.errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: expect.any(String),
        code: expect.any(String),
        message: expect.any(String),
      }),
    ]),
  );
}

function removeSavedPlans(result: InvestigationResultV1): void {
  result.plans = [];
  result.nextActions = result.nextActions.filter((action) => action.planRef === null);
  result.report.collections.plans = 0;
  result.report.collections.nextActions = result.nextActions.length;
  for (const finding of result.findings) finding.fixRecommendation.planRef = null;
  for (const check of result.validation.checks) check.planRef = null;
  if (result.assessment.kind === "bug") result.assessment.reproduction.planRef = null;
  if (result.assessment.kind === "feature")
    result.assessment.featureAssessment.implementationPlanRef = null;
}

function inheritedPatchFixture(selectedPatch = false, producingTaskId = "parent-task") {
  const fixture = createInvestigationFixture("pr", { findingCount: 0 });
  const { task, result } = fixture;
  const original = first(task.subjects);
  if (original.kind !== "original_pr") throw new Error("Expected an original PR subject.");
  const patch: Extract<InvestigationSubjectV1, { kind: "local_patch" }> = {
    id: "inherited-patch",
    kind: "local_patch",
    repositoryId: original.repositoryId,
    workItemId: original.workItemId,
    revisionKey: "6".repeat(64),
    baseSubjectRef: original.id,
    baseSha: original.headSha,
    patchDigest: "7".repeat(64),
    artifactRef: "inherited-patch-artifact",
  };
  const artifact: InvestigationArtifactV1 = {
    id: patch.artifactRef,
    taskId: producingTaskId,
    attemptId: `${producingTaskId}-attempt`,
    subjectRef: patch.id,
    kind: "patch",
    name: "inherited.patch",
    mediaType: "text/x-diff",
    digest: patch.patchDigest,
    byteLength: 128,
    availability: "available",
  };
  const parentReportRef = { id: "parent-report", version: 2, digest: "9".repeat(64) };
  task.kind = "pr-verify";
  task.parentTaskId = "parent-task";
  task.parentReportRef = parentReportRef;
  task.subjects.push(structuredClone(patch));
  task.sourceArtifacts = [structuredClone(artifact)];
  const plan = first(result.plans);
  task.planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  plan.sourceReportRef = { id: parentReportRef.id, version: parentReportRef.version };
  result.context.task.kind = task.kind;
  result.context.task.parentTaskId = task.parentTaskId;
  result.context.parentReportRef = structuredClone(parentReportRef);
  result.context.subjects.push(patch);
  result.context.sourceArtifacts = [structuredClone(artifact)];
  if (selectedPatch) {
    task.subjectRef = patch.id;
    task.executionPolicy.allowedSubjectRefs.push(patch.id);
    result.context.task.subjectRef = patch.id;
    result.assessment.subjectRef = patch.id;
    result.assessment.evidenceRefs = [];
    plan.subjectRef = patch.id;
    for (const check of result.validation.checks) check.subjectRef = patch.id;
    for (const action of result.nextActions)
      if (action.planRef !== null) {
        action.subjectRef = patch.id;
        action.action = "start-task";
      }
  }
  return { ...fixture, patch, artifact };
}

describe("investigation structural contracts", () => {
  it.each(["pr", "bug", "feature"] as const)(
    "accepts a complete %s task, attempt, and report",
    (kind) => {
      const { task, attempt, result } = createInvestigationFixture(kind);
      expect(Value.Check(InvestigationTaskV1Schema, task)).toBe(true);
      expect(Value.Check(InvestigationAttemptV1Schema, attempt)).toBe(true);
      expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
      expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    },
  );

  it("preserves all 151 findings and their final rechecks instead of applying a top-k limit", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 151 });
    expect(result.findings).toHaveLength(151);
    expect(result.report.loop.candidates).toHaveLength(151);
    expect(result.report.recheck.records).toHaveLength(151);
    expect(result.report.recheck.validFinalVersionRecheckCount).toBe(151);
    expect(result.findings.at(-1)?.ordinal).toBe(150);
    expect(new Set(result.findings.map((finding) => finding.id)).size).toBe(151);
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
  });

  it.each(["blocked", "failed", "cancelled", "interrupted"] as const)(
    "preserves an unfinished scope unit for the %s outcome",
    (outcome) => {
      const { task, attempt, result } = createInvestigationFixture("pr", { outcome });
      expect(task.state).toBe(outcome);
      expect(attempt.state).toBe(outcome);
      expect(result.report.completeness).toBe("partial");
      expect(result.report.delivery).toBe("checkpoint");
      expect(result.report.coverage.unresolvedUnitRefs).not.toHaveLength(0);
      expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
      expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    },
  );

  it("keeps the task's frozen coverage independent from report edits", () => {
    const { task, result } = createInvestigationFixture("pr");
    result.report.coverage.includedUnits = [];
    result.report.coverage.completedUnitRefs = [];
    expect(task.scope.includedUnits).toHaveLength(2);
    expect(task.scope.completedUnitRefs).toHaveLength(2);
  });
});

describe("model analysis authority boundary", () => {
  it("accepts proposed analysis without trusted execution or persisted state", () => {
    expect(Value.Check(InvestigationAnalysisV1Schema, modelAnalysis())).toBe(true);
  });

  it.each([
    { outcome: "completed" },
    { verificationEvidence: [] },
    { authority: "worker" },
    { allowed: true },
    { saved: true },
    { sourceUnitIds: ["claimed-source-chunk"] },
    { sourceCoverage: { brokeredUnitIds: ["claimed-source-chunk"] } },
    { modelIdentity: { engine: "codex", model: "gpt-6-astra" } },
    {
      modelExecutions: [
        { attemptId: "claimed-attempt", round: 1, engine: "codex", model: "gpt-6-astra" },
      ],
    },
    { unacceptedModelUsage: [{ attemptId: "claimed-attempt", round: 1, tokens: null }] },
    { modelUsage: { round: 1, tokens: 100 } },
  ])("rejects trusted top-level fields in model output: %j", (injected) => {
    expect(Value.Check(InvestigationAnalysisV1Schema, { ...modelAnalysis(), ...injected })).toBe(
      false,
    );
  });

  it("rejects Worker authority injected into model evidence", () => {
    const analysis = modelAnalysis();
    const value = { ...analysis, evidence: [{ ...first(analysis.evidence), authority: "worker" }] };
    expect(Value.Check(InvestigationAnalysisV1Schema, value)).toBe(false);
  });

  it("rejects a model claim that a plan is already saved", () => {
    const analysis = modelAnalysis();
    const value = { ...analysis, plans: [{ ...first(analysis.plans), state: "saved" }] };
    expect(Value.Check(InvestigationAnalysisV1Schema, value)).toBe(false);
  });

  it("rejects a model claim that a next action is already saved", () => {
    const analysis = modelAnalysis();
    const value = {
      ...analysis,
      nextActions: [{ ...first(analysis.nextActions), state: "saved" }],
    };
    expect(Value.Check(InvestigationAnalysisV1Schema, value)).toBe(false);
  });

  it("rejects permission injected into a proposed action", () => {
    const analysis = modelAnalysis();
    const value = { ...analysis, nextActions: [{ ...first(analysis.nextActions), allowed: true }] };
    expect(Value.Check(InvestigationAnalysisV1Schema, value)).toBe(false);
  });

  it("rejects executor observations as model-authored evidence", () => {
    const analysis = modelAnalysis();
    const value = {
      ...analysis,
      evidence: [{ ...first(analysis.evidence), source: "executor_observation" }],
    };
    expect(Value.Check(InvestigationAnalysisV1Schema, value)).toBe(false);
  });
});

describe("trusted unaccepted model usage", () => {
  const runtime = {
    completedStepIds: [],
    checks: [],
    evidence: [],
    artifacts: [],
    subjects: [],
    startedSteps: [],
    completedSteps: [],
  };
  const interrupt = {
    kind: "interrupt",
    lease: { attemptId: "synthetic-attempt", fence: 1, leaseToken: "synthetic-lease-token" },
    reason: "interrupted",
    diagnostics: [],
  };

  it("keeps legacy runtime states and interrupt requests compatible", () => {
    expect(Value.Check(InvestigationRuntimeStateSchema, runtime)).toBe(true);
    expect(Value.Check(InvestigationCheckpointRequestSchema, interrupt)).toBe(true);
  });

  it.each([{ tokens: 0 }, { tokens: 100 }, { tokens: null }])(
    "preserves known or explicitly unknown usage independently of accepted analysis: %j",
    ({ tokens }) => {
      const usage = { attemptId: "synthetic-attempt", round: 1, tokens };
      expect(Value.Check(InvestigationUnacceptedModelUsageSchema, usage)).toBe(true);
      expect(
        Value.Check(InvestigationRuntimeStateSchema, {
          ...runtime,
          unacceptedModelUsage: [usage],
        }),
      ).toBe(true);
      expect(
        Value.Check(InvestigationCheckpointRequestSchema, {
          ...interrupt,
          modelUsage: { round: 1, tokens },
        }),
      ).toBe(true);
    },
  );

  it.each([
    { round: 0, tokens: 100 },
    { round: -1, tokens: 100 },
    { round: 1.5, tokens: 100 },
    { round: Number.MAX_SAFE_INTEGER + 1, tokens: 100 },
    { round: 1, tokens: -1 },
    { round: 1, tokens: 1.5 },
    { round: 1, tokens: Number.MAX_SAFE_INTEGER + 1 },
    { round: 1, tokens: "unknown" },
    { round: 1 },
    { tokens: 100 },
    { round: 1, tokens: 100, analysis: {} },
  ])("rejects invalid or unbounded usage metadata: %j", (modelUsage) => {
    expect(
      Value.Check(InvestigationUnacceptedModelUsageSchema, {
        attemptId: "synthetic-attempt",
        ...modelUsage,
      }),
    ).toBe(false);
    expect(Value.Check(InvestigationCheckpointRequestSchema, { ...interrupt, modelUsage })).toBe(
      false,
    );
  });

  it("requires a valid persisted attempt identity and derives request identity from the lease", () => {
    for (const usage of [
      { round: 1, tokens: null },
      { attemptId: "", round: 1, tokens: null },
      { attemptId: "invalid attempt", round: 1, tokens: null },
    ]) {
      expect(Value.Check(InvestigationUnacceptedModelUsageSchema, usage)).toBe(false);
      expect(
        Value.Check(InvestigationRuntimeStateSchema, {
          ...runtime,
          unacceptedModelUsage: [usage],
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(InvestigationCheckpointRequestSchema, {
        ...interrupt,
        modelUsage: { attemptId: "another-attempt", round: 1, tokens: null },
      }),
    ).toBe(false);
  });
});

describe("trusted investigation model identity", () => {
  it.each(["codex", "copilot"] as const)(
    "accepts a known or explicitly unknown model from the %s engine",
    (engine) => {
      for (const model of ["gpt-6-astra", null]) {
        const identity = { engine, model };
        expect(Value.Check(InvestigationModelIdentitySchema, identity)).toBe(true);
        expect(
          Value.Check(InvestigationModelExecutionSchema, {
            ...identity,
            attemptId: "synthetic-attempt",
            round: 1,
          }),
        ).toBe(true);
      }
    },
  );

  it.each(["", "   ", "x".repeat(257), "model\nname", "model\u0000name", "model\u009fname"])(
    "rejects an invalid model identifier: %j",
    (model) => {
      expect(Value.Check(InvestigationModelIdentitySchema, { engine: "codex", model })).toBe(false);
    },
  );

  it("rejects unrecognized engines and unbound execution records", () => {
    expect(
      Value.Check(InvestigationModelIdentitySchema, { engine: "unknown", model: "gpt-6-astra" }),
    ).toBe(false);
    for (const round of [0, -1, 1.5]) {
      expect(
        Value.Check(InvestigationModelExecutionSchema, {
          attemptId: "synthetic-attempt",
          round,
          engine: "codex",
          model: null,
        }),
      ).toBe(false);
    }
  });

  it("keeps legacy checkpoint requests compatible and accepts identity only in trusted metadata", () => {
    const { task, attempt } = createInvestigationFixture("pr");
    const request = {
      kind: "analysis",
      lease: { attemptId: attempt.id, fence: 1, leaseToken: "synthetic-lease-token" },
      round: {
        schemaVersion: "InvestigationLoopRoundV1",
        taskId: task.id,
        attemptId: attempt.id,
        inputCheckpointRef: { id: "synthetic-checkpoint", version: 1, digest: "a".repeat(64) },
        round: 1,
        phase: "discovery",
        analysis: modelAnalysis(),
        continue: false,
        continuationReason: "The proposed analysis is ready for trusted completion checks.",
      },
      usage: { durationMs: 10, tokens: 100, reportBytes: 1_000 },
    };
    expect(Value.Check(InvestigationCheckpointRequestSchema, request)).toBe(true);
    for (const model of ["gpt-6-astra", null]) {
      expect(
        Value.Check(InvestigationCheckpointRequestSchema, {
          ...request,
          modelIdentity: { engine: "codex", model },
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(InvestigationCheckpointRequestSchema, {
        ...request,
        modelIdentity: { engine: "codex", model: "" },
      }),
    ).toBe(false);
  });

  it("accepts legacy reports without model history and mixed identities from adopted attempts", () => {
    const { result } = createInvestigationFixture("pr");
    expect(result.context.modelExecutions).toBeUndefined();
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    result.context.adoptedAttemptIds.push("synthetic-prior-attempt");
    result.context.modelExecutions = [
      { attemptId: "synthetic-prior-attempt", round: 1, engine: "codex", model: "gpt-6-astra" },
      { attemptId: result.context.attempt.id, round: 3, engine: "copilot", model: null },
    ];
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
  });

  it.each(["unknown_attempt", "duplicate_round", "future_round", "too_many_records"])(
    "rejects model execution history with %s",
    (invalid) => {
      const { result } = createInvestigationFixture("pr");
      const execution = {
        attemptId: result.context.attempt.id,
        round: 1,
        engine: "codex" as const,
        model: "gpt-6-astra",
      };
      result.context.modelExecutions = [execution];
      if (invalid === "unknown_attempt") execution.attemptId = "unadopted-attempt";
      if (invalid === "duplicate_round") result.context.modelExecutions.push({ ...execution });
      if (invalid === "future_round") execution.round = result.report.loop.completedRounds + 1;
      if (invalid === "too_many_records") {
        result.context.modelExecutions = Array.from(
          { length: result.report.loop.completedRounds + 1 },
          (_, index) => ({ ...execution, round: index + 1 }),
        );
      }
      expectSemanticFailure(result);
    },
  );
});

describe("investigation semantic completion", () => {
  it("rejects a completed outcome paired with a partial checkpoint", () => {
    const { result } = createInvestigationFixture("pr");
    result.report.completeness = "partial";
    result.report.delivery = "checkpoint";
    expectSemanticFailure(result);
  });

  it("rejects final delivery when a finding has no final-version recheck", () => {
    const { result } = createInvestigationFixture("pr");
    const finding = first(result.findings);
    finding.confirmation.recheckRef = null;
    result.report.recheck.records = [];
    result.report.recheck.validFinalVersionRecheckCount = 0;
    result.report.recheck.pendingFindingIds = [finding.id];
    result.report.collections.rechecks = 0;
    expectSemanticFailure(result);
  });

  it("does not count a prior finding version as the final recheck", () => {
    const { result } = createInvestigationFixture("pr");
    const finding = first(result.findings);
    finding.version = 2;
    first(result.report.loop.candidates).findingVersion = 2;
    result.report.recheck.validFinalVersionRecheckCount = 0;
    result.report.recheck.pendingFindingIds = [finding.id];
    expect(first(result.report.recheck.records).findingVersion).toBe(1);
    expectSemanticFailure(result);
  });

  it("rejects completion when a completed scope unit is omitted from the manifest references", () => {
    const { result } = createInvestigationFixture("pr");
    result.report.coverage.completedUnitRefs.pop();
    expect(result.report.coverage.includedUnits.every((unit) => unit.status === "completed")).toBe(
      true,
    );
    expectSemanticFailure(result);
  });

  it("rejects cycles between merged candidates even when each target exists", () => {
    const { result } = createInvestigationFixture("pr");
    const original = first(result.report.loop.candidates);
    result.report.loop.candidates.push(
      {
        ...original,
        id: "synthetic-merged-a",
        status: "merged",
        findingId: null,
        findingVersion: null,
        mergedIntoCandidateId: "synthetic-merged-b",
        rationale: "Merged into candidate B.",
      },
      {
        ...original,
        id: "synthetic-merged-b",
        status: "merged",
        findingId: null,
        findingVersion: null,
        mergedIntoCandidateId: "synthetic-merged-a",
        rationale: "Merged into candidate A.",
      },
    );
    result.report.collections.candidates = result.report.loop.candidates.length;
    expectSemanticFailure(result);
  });

  it("rejects an unresolved candidate without an explicit evidence limitation", () => {
    const { result } = createInvestigationFixture("bug");
    expect(first(result.report.loop.candidates).status).toBe("unresolved");
    result.report.limitations = [];
    expectSemanticFailure(result);
  });

  it("allows a saved continuation plan to support a complete hypothesis without an executable action", () => {
    const { result } = createInvestigationFixture("bug");
    expect(first(result.report.loop.candidates).status).toBe("unresolved");
    result.nextActions = [];
    result.report.collections.nextActions = 0;
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    for (const kind of ["verification", "reproduction"] as const) {
      first(result.plans).kind = kind;
      expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    }
    if (result.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    result.assessment.bugAssessment.status = "needs_information";
    result.assessment.bugAssessment.missingInformation = [
      "Provide the exact source and reproduction input.",
    ];
    result.assessment.reproduction.planRef = null;
    first(result.plans).kind = "investigation";
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    "missing",
    "subject",
    "source",
    "steps",
    "criteria",
    "limitation",
    "implementation",
    "fix",
  ])("does not accept an inapplicable saved continuation plan: %s", (invalid) => {
    const { result } = createInvestigationFixture("bug");
    result.nextActions = [];
    result.report.collections.nextActions = 0;
    const plan = first(result.plans);
    if (invalid === "missing") removeSavedPlans(result);
    if (invalid === "subject") {
      const other = { ...first(result.context.subjects), id: "unrelated-subject" };
      result.context.subjects.push(other);
      plan.subjectRef = other.id;
    }
    if (invalid === "source") plan.sourceReportRef.id = "unrelated-report";
    if (invalid === "steps") plan.steps = [];
    if (invalid === "criteria") plan.acceptanceCriteria = [];
    if (invalid === "limitation") result.report.limitations = [];
    if (invalid === "implementation" || invalid === "fix") plan.kind = invalid;
    expect(validateInvestigationResult(result).valid).toBe(false);
  });

  it("rejects an unresolved candidate without a saved continuation plan and limitation", () => {
    const { result } = createInvestigationFixture("bug");
    removeSavedPlans(result);
    result.report.limitations = [];
    if (result.assessment.kind !== "bug") throw new Error("Expected a bug fixture.");
    result.assessment.bugAssessment.status = "needs_information";
    result.assessment.bugAssessment.missingInformation = [
      "Provide the exact Settings version and launch sequence.",
    ];
    expectSemanticFailure(result);
  });

  it("allows a confirmed finding to explicitly retain an unknown root cause", () => {
    const { result } = createInvestigationFixture("pr");
    first(result.findings).rootCause = {
      status: "unknown",
      explanation:
        "The observable defect is supported, but the evidence does not establish its root cause.",
      evidenceRefs: [],
    };
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
  });

  it("rejects needs_verification without a saved experiment, independently of findings", () => {
    const { result } = createInvestigationFixture("bug", { findingCount: 0 });
    removeSavedPlans(result);
    expect(result.findings).toHaveLength(0);
    expectSemanticFailure(result);
  });

  it("rejects a ready feature without a saved implementation plan", () => {
    const { result } = createInvestigationFixture("feature");
    removeSavedPlans(result);
    expectSemanticFailure(result);
  });
});

describe.each(["bug", "feature"] as const)("%s information inquiry draft registry", (kind) => {
  function informationResult(findingCount = 1) {
    const { result } = createInvestigationFixture(kind, { findingCount });
    const assessment = result.assessment;
    if (assessment.kind !== "bug" && assessment.kind !== "feature")
      throw new Error("Expected an issue assessment.");
    const detail =
      assessment.kind === "bug" ? assessment.bugAssessment : assessment.featureAssessment;
    detail.status = "needs_information";
    detail.missingInformation = [
      "The exact version and observed behavior needed to assess this request.",
    ];
    for (const finding of result.findings) {
      finding.feedbackDraft.body =
        "Please provide the exact version and observed behavior so this request can be assessed.";
      finding.feedbackDraft.suggestion = null;
    }
    result.feedbackDrafts = [];
    result.nextActions = [];
    result.report.collections.nextActions = 0;
    return result;
  }

  it("accepts an existing finding inquiry without duplicating it at the top level", () => {
    const result = informationResult();
    const before = investigationCanonicalJson(result);
    expect(result.feedbackDrafts).toHaveLength(0);
    expect(first(result.findings).feedbackDraft.suggestion).toBeNull();
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    expect(investigationCanonicalJson(result)).toBe(before);
  });

  it("still rejects a missing-information assessment without any saved inquiry", () => {
    const result = informationResult(0);
    expect(result.findings).toHaveLength(0);
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(validateInvestigationResult(result).errors).toContainEqual(
      expect.objectContaining({
        code: kind === "bug" ? "BUG_INFORMATION_REQUIRED" : "FEATURE_INFORMATION_REQUIRED",
      }),
    );
  });

  it("still requires explicit missing information when an inquiry is saved on a finding", () => {
    const result = informationResult();
    const assessment = result.assessment;
    if (assessment.kind === "bug") assessment.bugAssessment.missingInformation = [];
    else if (assessment.kind === "feature") assessment.featureAssessment.missingInformation = [];
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(validateInvestigationResult(result).errors).toContainEqual(
      expect.objectContaining({
        code: kind === "bug" ? "BUG_INFORMATION_REQUIRED" : "FEATURE_INFORMATION_REQUIRED",
      }),
    );
  });

  it("still rejects conflicting content for a shared top-level and finding draft identity", () => {
    const result = informationResult();
    result.feedbackDrafts = [
      {
        ...first(result.findings).feedbackDraft,
        body: "A different saved inquiry with the same identity.",
      },
    ];
    expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
    expect(validateInvestigationResult(result).errors).toContainEqual(
      expect.objectContaining({ code: "DRAFT_CONTENT_CONFLICT" }),
    );
  });
});

describe("investigation subject evidence binding", () => {
  it.each([false, true])(
    "retains inherited patch ownership when the child selects the patch: %s",
    (selectedPatch) => {
      const { task, result, patch, artifact } = inheritedPatchFixture(selectedPatch);
      expect(Value.Check(InvestigationTaskV1Schema, task)).toBe(true);
      expect(Value.Check(InvestigationResultV1Schema, result)).toBe(true);
      expect(validateInvestigationTask(task)).toEqual({ valid: true, errors: [] });
      expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
      expect(result.context.sourceArtifacts).toEqual([artifact]);
      expect(result.context.adoptedAttemptIds).not.toContain(artifact.attemptId);
      expect(result.artifacts.every((item) => item.taskId === task.id)).toBe(true);
      expect(result.artifacts.some((item) => item.id === patch.artifactRef)).toBe(false);
      expect(result.context.task.subjectRef === patch.id).toBe(selectedPatch);
    },
  );

  it("preserves a grandparent patch owner through the exact parent report context", () => {
    const { task, result, artifact } = inheritedPatchFixture(true, "grandparent-task");
    expect(artifact.taskId).not.toBe(task.parentTaskId);
    expect(artifact.attemptId).toBe("grandparent-task-attempt");
    expect(validateInvestigationTask(task)).toEqual({ valid: true, errors: [] });
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    expect(result.context.sourceArtifacts).toEqual([artifact]);
  });

  it.each([
    "digest",
    "subject",
    "artifact-id",
    "non-patch",
    "current-owner",
    "missing-parent-task",
    "missing-parent-report",
    "duplicate",
  ] as const)("rejects inherited patch metadata with an invalid %s binding", (binding) => {
    const { task, result } = inheritedPatchFixture();
    for (const artifact of [first(task.sourceArtifacts!), first(result.context.sourceArtifacts!)]) {
      if (binding === "digest") artifact.digest = "8".repeat(64);
      else if (binding === "subject") artifact.subjectRef = task.subjectRef;
      else if (binding === "artifact-id") artifact.id = "unbound-patch-artifact";
      else if (binding === "non-patch") artifact.kind = "log";
      else if (binding === "current-owner") artifact.taskId = task.id;
    }
    if (binding === "missing-parent-task") {
      task.parentTaskId = null;
      result.context.task.parentTaskId = null;
    } else if (binding === "missing-parent-report") {
      task.parentReportRef = null;
      result.context.parentReportRef = null;
    } else if (binding === "duplicate") {
      task.sourceArtifacts!.push(structuredClone(first(task.sourceArtifacts!)));
      result.context.sourceArtifacts!.push(structuredClone(first(result.context.sourceArtifacts!)));
    }
    expect(Value.Check(InvestigationTaskV1Schema, task)).toBe(true);
    expect(validateInvestigationTask(task).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_SOURCE_ARTIFACT" })]),
    );
    expectSemanticFailure(result);
  });

  it("rejects republishing inherited patch metadata as a current task artifact", () => {
    const { result, artifact } = inheritedPatchFixture();
    result.artifacts.push({
      ...artifact,
      taskId: result.context.task.id,
      attemptId: result.context.attempt.id,
    });
    result.report.collections.artifacts = result.artifacts.length;
    expectSemanticFailure(result);
    expect(validateInvestigationResult(result).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SOURCE_ARTIFACT_ID_CONFLICT" })]),
    );
  });

  it("rejects ancestor artifacts in current evidence even if their attempt is adopted", () => {
    const { result, artifact } = inheritedPatchFixture();
    result.context.sourceArtifacts = [];
    result.context.adoptedAttemptIds.push(artifact.attemptId);
    result.artifacts.push(artifact);
    result.report.collections.artifacts = result.artifacts.length;
    expectSemanticFailure(result);
    expect(validateInvestigationResult(result).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ARTIFACT_SCOPE_MISMATCH" })]),
    );
  });

  it("does not use local patch evidence to confirm a finding on the original PR", () => {
    const { result } = createInvestigationFixture("pr");
    const original = first(result.context.subjects);
    if (original.kind !== "original_pr") throw new Error("Expected an original PR subject.");
    const patchId = "synthetic-local-patch";
    const patchArtifactId = "synthetic-local-patch-artifact";
    result.context.subjects.push({
      id: patchId,
      kind: "local_patch",
      repositoryId: original.repositoryId,
      workItemId: original.workItemId,
      revisionKey: "6".repeat(64),
      baseSubjectRef: original.id,
      baseSha: original.headSha,
      patchDigest: "7".repeat(64),
      artifactRef: patchArtifactId,
    });
    result.artifacts.push({
      id: patchArtifactId,
      taskId: result.context.task.id,
      attemptId: result.context.attempt.id,
      subjectRef: patchId,
      kind: "patch",
      name: "synthetic-local.patch",
      mediaType: "text/plain",
      digest: "7".repeat(64),
      byteLength: 128,
      availability: "available",
    });
    result.report.collections.artifacts = result.artifacts.length;
    const referencedEvidenceId = first(first(result.findings).evidenceRefs);
    const patchEvidence = result.verificationEvidence.find(
      (item) => item.id === referencedEvidenceId,
    );
    if (patchEvidence === undefined) throw new Error("Expected finding evidence.");
    patchEvidence.subjectRef = patchId;
    patchEvidence.evidenceRefs = [];
    patchEvidence.artifactRefs = [patchArtifactId];
    patchEvidence.summary = "This observation applies only to the locally modified source.";
    expect(first(result.findings).subjectRef).toBe(original.id);
    expectSemanticFailure(result);
  });

  it("rejects model authority disguised as an executed check", () => {
    const { result } = createInvestigationFixture("pr");
    const check = first(result.validation.checks);
    check.status = "passed";
    check.executor = "claimed-executor";
    check.authoritativeAttemptId = result.context.attempt.id;
    check.evidenceRefs = first(result.findings).evidenceRefs;
    expectSemanticFailure(result);
  });

  it("rejects cyclic evidence justification", () => {
    const { result } = createInvestigationFixture("pr");
    const snapshot = first(result.verificationEvidence);
    const inferred = result.verificationEvidence[1];
    if (!inferred) throw new Error("Expected inferred evidence.");
    snapshot.evidenceRefs = [inferred.id];
    inferred.evidenceRefs = [snapshot.id];
    expectSemanticFailure(result);
  });

  it("retains identical feedback draft references but rejects conflicting content", () => {
    const { result } = createInvestigationFixture("pr");
    result.feedbackDrafts.push(structuredClone(first(result.findings).feedbackDraft));
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    result.feedbackDrafts.at(-1)!.body =
      "A different draft must not reuse the saved draft identity.";
    expectSemanticFailure(result);
  });

  it("preserves an inherited saved plan's parent report identity", () => {
    const { result } = createInvestigationFixture("pr");
    const parentReportRef = { id: "parent-report", version: 2, digest: "9".repeat(64) };
    result.context.parentReportRef = parentReportRef;
    result.context.task.parentTaskId = "parent-task";
    result.context.task.kind = "pr-verify";
    first(result.plans).sourceReportRef = {
      id: parentReportRef.id,
      version: parentReportRef.version,
    };
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
  });

  it("binds an Issue snapshot plan to an explicitly selected verification commit only", () => {
    const { result } = createInvestigationFixture("bug", { findingCount: 0 });
    const snapshot = first(result.context.subjects);
    const source = {
      id: "explicit-verification-source",
      kind: "source_commit" as const,
      repositoryId: snapshot.repositoryId,
      workItemId: snapshot.workItemId,
      revisionKey: "8".repeat(64),
      commitSha: "9".repeat(40),
    };
    result.context.subjects.push(source);
    result.context.task.kind = "issue-verify";
    result.context.task.subjectRef = source.id;
    result.context.task.parentTaskId = "parent-issue-task";
    result.context.parentReportRef = {
      id: "parent-issue-report",
      version: 1,
      digest: "7".repeat(64),
    };
    first(result.plans).sourceReportRef = { id: "parent-issue-report", version: 1 };
    result.assessment.subjectRef = source.id;
    result.assessment.evidenceRefs = [];
    first(result.validation.checks).subjectRef = source.id;
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    result.context.task.kind = "issue-investigate";
    expectSemanticFailure(result);
  });

  it("keeps a feature implementation check on its derived patch while retaining the original Issue plan", () => {
    const { result } = createInvestigationFixture("feature");
    const snapshot = first(result.context.subjects);
    const sourceId = "implementation-source";
    const patchId = "implementation-patch";
    const sourceSha = "8".repeat(40);
    const patchDigest = "9".repeat(64);
    result.context.task.kind = "feature-implement";
    result.context.task.subjectRef = sourceId;
    result.context.task.parentTaskId = "parent-feature-task";
    result.context.parentReportRef = {
      id: "parent-feature-report",
      version: 1,
      digest: "6".repeat(64),
    };
    result.context.subjects.push(
      {
        id: sourceId,
        kind: "source_commit",
        repositoryId: snapshot.repositoryId,
        workItemId: snapshot.workItemId,
        revisionKey: "7".repeat(64),
        commitSha: sourceSha,
      },
      {
        id: patchId,
        kind: "local_patch",
        repositoryId: snapshot.repositoryId,
        workItemId: snapshot.workItemId,
        revisionKey: "5".repeat(64),
        baseSubjectRef: sourceId,
        baseSha: sourceSha,
        patchDigest,
        artifactRef: "implementation-patch-artifact",
      },
    );
    const provenance = {
      taskId: result.context.task.id,
      attemptId: result.context.attempt.id,
      producer: "synthetic-worker",
      recordedAt: "2026-09-15T02:00:02.000Z",
    };
    result.artifacts.push(
      {
        id: "implementation-source-artifact",
        taskId: provenance.taskId,
        attemptId: provenance.attemptId,
        subjectRef: sourceId,
        kind: "source",
        name: "source.json",
        mediaType: "application/json",
        digest: "4".repeat(64),
        byteLength: 128,
        availability: "available",
      },
      {
        id: "implementation-patch-artifact",
        taskId: provenance.taskId,
        attemptId: provenance.attemptId,
        subjectRef: patchId,
        kind: "patch",
        name: "implementation.patch",
        mediaType: "text/plain",
        digest: patchDigest,
        byteLength: 128,
        availability: "available",
      },
    );
    result.verificationEvidence.push(
      {
        id: "implementation-source-evidence",
        subjectRef: sourceId,
        source: "source_snapshot",
        authority: "worker",
        summary: "The selected implementation source was frozen.",
        artifactRefs: ["implementation-source-artifact"],
        evidenceRefs: [],
        provenance,
      },
      {
        id: "implementation-check-evidence",
        subjectRef: patchId,
        source: "executor_observation",
        authority: "worker",
        summary: "The isolated check passed on the derived patch.",
        artifactRefs: ["implementation-patch-artifact"],
        evidenceRefs: [],
        provenance,
      },
    );
    const plan = first(result.plans);
    plan.sourceReportRef = { id: "parent-feature-report", version: 1 };
    plan.steps[0]!.checkIds = ["implementation-check"];
    result.assessment.subjectRef = sourceId;
    result.assessment.evidenceRefs = ["implementation-source-evidence"];
    result.validation.checks = [
      {
        id: "implementation-check",
        scenarioId: "implementation-scenario",
        subjectRef: patchId,
        planRef: { id: plan.id, version: plan.version, digest: plan.digest },
        required: true,
        description: "Check the proposed implementation.",
        status: "passed",
        executor: "synthetic-checker",
        evidenceRefs: ["implementation-check-evidence"],
        authoritativeAttemptId: provenance.attemptId,
      },
    ];
    result.report.collections.artifacts = result.artifacts.length;
    result.report.collections.verificationEvidence = result.verificationEvidence.length;
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    const patch = result.context.subjects.find((item) => item.id === patchId);
    if (!patch || patch.kind !== "local_patch") throw new Error("Expected the derived patch.");
    patch.baseSubjectRef = snapshot.id;
    expectSemanticFailure(result);
  });
});

describe("frozen investigation authorization", () => {
  it.each(["pr", "bug"] as const)(
    "rejects execute policy under the static %s task kind even with explicit authorization",
    (kind) => {
      const { task } = createInvestigationFixture(kind);
      task.executionPolicy = {
        ...task.executionPolicy,
        mode: "execute",
        allowRepositoryExecution: true,
        authorizationRef: "synthetic-administrator",
      };
      expect(Value.Check(InvestigationTaskV1Schema, task)).toBe(true);
      expect(validateInvestigationTask(task).errors).toContainEqual(
        expect.objectContaining({ code: "STATIC_TASK_EXECUTION_FORBIDDEN" }),
      );
    },
  );

  it("accepts snapshot-only Issue analysis without inventing a source SHA", () => {
    const { task } = createInvestigationFixture("bug");
    expect(validateInvestigationTask(task)).toEqual({ valid: true, errors: [] });
    expect(first(task.subjects).kind).toBe("issue_snapshot");
  });

  it("does not silently turn a text snapshot into executable source", () => {
    const { task } = createInvestigationFixture("bug");
    task.executionPolicy = {
      ...task.executionPolicy,
      mode: "execute",
      allowRepositoryExecution: true,
      authorizationRef: "explicit-authorization",
    };
    expect(validateInvestigationTask(task).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "EXECUTION_SOURCE_REQUIRED" })]),
    );
  });

  it("rejects analysis that drops a frozen unit or invents a subject", () => {
    const { task } = createInvestigationFixture("pr");
    const analysis = modelAnalysis();
    analysis.coverage.includedUnits.shift();
    first(analysis.findings).subjectRef = "unapproved-source";
    const result = validateInvestigationAnalysisForTask(task, analysis);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "FROZEN_COVERAGE_CHANGED" }),
        expect.objectContaining({ code: "SUBJECT_OUTSIDE_AUTHORIZATION" }),
      ]),
    );
  });

  it("separates canonical plan content from server persistence metadata", () => {
    const { result } = createInvestigationFixture("pr");
    const plan = first(result.plans);
    const original = investigationCanonicalJson(investigationPlanDigestPayload(plan));
    plan.sourceReportRef = { id: "different-parent-report", version: 2 };
    plan.digest = "0".repeat(64);
    expect(investigationCanonicalJson(investigationPlanDigestPayload(plan))).toBe(original);
    plan.steps[0]!.description = "A different executable work description.";
    expect(investigationCanonicalJson(investigationPlanDigestPayload(plan))).not.toBe(original);
    expect(investigationCanonicalJson({ z: 1, a: ["b", "a"] })).toBe('{"a":["b","a"],"z":1}');
  });
});
