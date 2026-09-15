import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  type InvestigationAnalysisEvidence,
  type InvestigationAnalysisV1,
  InvestigationAnalysisV1Schema,
  InvestigationAttemptV1Schema,
  type InvestigationResultV1,
  InvestigationResultV1Schema,
  InvestigationTaskV1Schema,
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

describe("investigation subject evidence binding", () => {
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
