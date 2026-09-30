import {
  createInvestigationPreview,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationPlanDraft,
  investigationPlanDigestPayload,
  validateInvestigationResult,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint, investigationContentDigest } from "@agentic-review/domain";
import { describe, expect, it } from "vitest";
import { buildInvestigationReportSubmission } from "../../../worker/src/investigation/report-builder.js";
import { assembleInvestigationReport } from "./report.js";

function reference(plan: InvestigationPlanDraft) {
  return { id: plan.id, version: plan.version, digest: investigationContentDigest(plan) };
}

function seal(checkpoint: InvestigationLoopCheckpointV1): void {
  const { digest: _digest, ...content } = checkpoint;
  checkpoint.digest = investigationContentDigest(content);
}

/** Reproduce the accepted stale investigation link and later explicit verification recommendation. */
function fixture() {
  const { task, attempt, result } = createInvestigationPreview("bug", { findingCount: 0 });
  task.state = "running";
  task.latestReportRef = null;
  attempt.state = "running";
  attempt.finishedAt = null;
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: result.report.loop.checkpointId,
    leaseVersion: attempt.leaseVersion,
    recordedAt: task.updatedAt,
  });
  const previous: InvestigationPlanDraft = {
    ...investigationPlanDigestPayload(result.plans[0]!),
    id: "plan-original-investigation",
    kind: "investigation",
  };
  const verification: InvestigationPlanDraft = {
    ...structuredClone(previous),
    id: "plan-second-round-verification",
    kind: "verification",
  };
  const assessment = structuredClone(result.assessment);
  if (assessment.kind !== "bug") throw new Error("The fixture requires a bug assessment.");
  assessment.reproduction.planRef = reference(previous);
  const analysis: InvestigationAnalysisV1 = {
    schemaVersion: "InvestigationAnalysisV1",
    summary: result.report.summary,
    coverage: {
      ...structuredClone(result.report.coverage),
      scopeManifest: checkpoint.analysis.coverage.scopeManifest,
    },
    assessment,
    findings: [],
    candidates: [],
    rechecks: [],
    evidence: [],
    plans: [previous, verification],
    nextActions: [
      {
        id: "action-request-fixture",
        action: "comment",
        taskKind: null,
        label: "Request a reproducible sample",
        reason: "The snapshot does not establish the reported behavior.",
        recommended: true,
        subjectRef: task.subjectRef,
        planRef: reference(previous),
        draftRef: result.feedbackDrafts[0]!.id,
        validationReportRef: null,
        prerequisiteRefs: [],
      },
      {
        id: "action-verify-reported-behavior",
        action: "start-task",
        taskKind: "issue-verify",
        label: "Verify the reported behavior",
        reason: "Run the accepted experiment after its prerequisites are available.",
        recommended: true,
        subjectRef: task.subjectRef,
        planRef: reference(verification),
        draftRef: null,
        validationReportRef: null,
        prerequisiteRefs: verification.prerequisites.map((entry) => entry.id),
      },
    ],
    feedbackDrafts: structuredClone(result.feedbackDrafts),
    diagnostics: [],
    limitations: structuredClone(result.report.limitations),
  };
  checkpoint.analysis = analysis;
  checkpoint.round = 3;
  checkpoint.version = 4;
  checkpoint.lastPhase = "finalize";
  checkpoint.stopReason = "complete";
  checkpoint.consumed = structuredClone(result.report.loop.consumed);
  checkpoint.runtime.evidence = structuredClone(result.verificationEvidence);
  checkpoint.runtime.artifacts = structuredClone(result.artifacts);
  seal(checkpoint);
  return { task, attempt, checkpoint, reportId: result.id, outcome: "completed" as const };
}

describe("verification plan report presentation", () => {
  it("round-trips the stale investigation reference without changing accepted facts", () => {
    const input = fixture();
    const accepted = structuredClone(input.checkpoint);
    const submission = buildInvestigationReportSubmission(input);
    const result = assembleInvestigationReport({ ...input, ...submission });
    const original = accepted.analysis.assessment;
    if (original.kind !== "bug") throw new Error("The fixture requires a bug assessment.");
    expect(result.assessment).toEqual({
      ...original,
      reproduction: {
        ...original.reproduction,
        planRef: accepted.analysis.nextActions[1]!.planRef,
      },
    });
    expect(result.assessment).toMatchObject({
      bugAssessment: { status: "needs_verification" },
      reproduction: { status: "not_run" },
    });
    expect(result.outcome).toBe("completed");
    expect(result.nextActions).toHaveLength(2);
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    expect(validateInvestigationResult({ ...result, assessment: original }).errors).toEqual([
      expect.objectContaining({
        code: "BUG_VERIFICATION_PLAN_REQUIRED",
        path: "/assessment/bugAssessment",
      }),
    ]);
    expect(input.checkpoint).toEqual(accepted);
    expect(buildInvestigationReportSubmission(input)).toEqual(submission);
  });

  it.each(["verification", "reproduction"] as const)(
    "preserves an existing compatible %s reference",
    (kind) => {
      const input = fixture();
      const previous = input.checkpoint.analysis.plans[0]!;
      previous.kind = kind;
      const assessment = input.checkpoint.analysis.assessment;
      if (assessment.kind !== "bug") throw new Error("The fixture requires a bug assessment.");
      assessment.reproduction.planRef = reference(previous);
      input.checkpoint.analysis.nextActions[0]!.planRef = reference(previous);
      seal(input.checkpoint);
      const submission = buildInvestigationReportSubmission(input);
      const result = assembleInvestigationReport({ ...input, ...submission });
      expect(result.assessment).toEqual(assessment);
      expect(validateInvestigationResult(result).valid).toBe(true);
    },
  );

  it.each([
    "missing-current-reference",
    "unknown-current-plan",
    "stale-current-digest",
    "missing-verification-plan",
    "stale-verification-digest",
    "cross-subject-plan",
    "unrecommended-action",
    "ambiguous-actions",
    "unknown-prerequisite",
    "wrong-task-plan-kind",
    "missing-hypothesis",
  ])("preserves the semantic rejection for %s", (condition) => {
    const input = fixture();
    const analysis = input.checkpoint.analysis;
    const assessment = analysis.assessment;
    if (assessment.kind !== "bug") throw new Error("The fixture requires a bug assessment.");
    const action = analysis.nextActions[1]!;
    if (condition === "missing-current-reference") assessment.reproduction.planRef = null;
    if (condition === "unknown-current-plan") assessment.reproduction.planRef!.id = "missing";
    if (condition === "stale-current-digest")
      assessment.reproduction.planRef!.digest = "0".repeat(64);
    if (condition === "missing-verification-plan") analysis.plans.pop();
    if (condition === "stale-verification-digest") action.planRef!.digest = "0".repeat(64);
    if (condition === "cross-subject-plan") {
      analysis.plans[1]!.subjectRef = "another-subject";
      action.planRef = reference(analysis.plans[1]!);
    }
    if (condition === "unrecommended-action") action.recommended = false;
    if (condition === "ambiguous-actions")
      analysis.nextActions.push({ ...structuredClone(action), id: "another-verification-action" });
    if (condition === "unknown-prerequisite") action.prerequisiteRefs.push("unknown-prerequisite");
    if (condition === "wrong-task-plan-kind") {
      analysis.plans[1]!.kind = "reproduction";
      action.planRef = reference(analysis.plans[1]!);
    }
    if (condition === "missing-hypothesis") assessment.bugAssessment.hypotheses = [];
    seal(input.checkpoint);
    const accepted = structuredClone(input.checkpoint);
    const submission = buildInvestigationReportSubmission(input);
    expect(submission.header.assessment).toEqual(assessment);
    const invalidReference =
      condition === "unknown-current-plan" || condition === "stale-current-digest";
    const unknownSubject = condition === "cross-subject-plan";
    let rejection: unknown;
    try {
      assembleInvestigationReport({ ...input, ...submission });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      statusCode: 422,
      code: invalidReference
        ? "invalid_report_plan_reference"
        : unknownSubject
          ? "unknown_report_subject"
          : "invalid_logical_report_semantics",
      message: expect.stringMatching(
        invalidReference
          ? /Plan references must resolve to the saved plan version and subject/
          : unknownSubject
            ? /Every report record must reference a frozen task subject/
            : /BUG_VERIFICATION_PLAN_REQUIRED/,
      ),
    });
    expect(input.checkpoint).toEqual(accepted);
  });

  it("rejects a Worker header that disagrees with the Server's independent projection", () => {
    const input = fixture();
    const submission = buildInvestigationReportSubmission(input);
    submission.header.assessment = structuredClone(input.checkpoint.analysis.assessment);
    expect(() => assembleInvestigationReport({ ...input, ...submission })).toThrow(
      /report assessment must match the accepted checkpoint presentation/,
    );
  });
});
