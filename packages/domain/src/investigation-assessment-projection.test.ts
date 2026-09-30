import {
  createInvestigationPreview,
  investigationPlanDigestPayload,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { projectInvestigationReportAssessment } from "./investigation-assessment-projection.js";
import { investigationContentDigest } from "./investigation-loop.js";

function verificationFixture() {
  const preview = createInvestigationPreview("pr", { findingCount: 0 });
  const plan = structuredClone(preview.result.plans[0]!);
  plan.kind = "verification";
  plan.digest = investigationContentDigest(investigationPlanDigestPayload(plan));
  const assessment = structuredClone(preview.result.assessment);
  if (assessment.kind !== "pr") throw new Error("A PR assessment is required.");
  assessment.summary = "The model retains a qualified summary of the recorded checks.";
  assessment.reviewConclusion = {
    status: "inconclusive",
    rationale: "The saved verification scope does not establish a complete source review.",
  };
  assessment.e2eAssessment = {
    level: "recommended",
    rationale: "Only the retained checks were executed.",
    planRef: null,
    scenarioIds: [],
    prerequisiteRefs: [],
    linkedValidationReportRefs: [],
  };
  const reportContext = structuredClone(preview.result.context);
  reportContext.task.kind = "pr-verify";
  reportContext.task.parentTaskId = "parent-task";
  reportContext.parentReportRef = { ...plan.sourceReportRef, digest: "a".repeat(64) };
  const context: Parameters<typeof projectInvestigationReportAssessment>[0] = {
    context: reportContext,
    report: { id: "verification-report", version: 1 },
    assessment,
    findings: [],
    feedbackDrafts: [],
  };
  return { context, assessment, plan };
}

describe("saved PR verification assessment projection", () => {
  it("restores only the missing plan reference from the explicit saved parent plan", () => {
    const { context, assessment, plan } = verificationFixture();
    const original = structuredClone(assessment);
    const result = projectInvestigationReportAssessment(context, [], [plan], plan);

    expect(result).toEqual({
      ...original,
      e2eAssessment: {
        ...original.e2eAssessment,
        planRef: { id: plan.id, version: plan.version, digest: plan.digest },
      },
    });
    expect(assessment).toEqual(original);
    expect(result.summary).toBe(assessment.summary);
    if (result.kind !== "pr") throw new Error("The assessment kind changed.");
    expect(result.reviewConclusion.status).toBe("inconclusive");
    expect(result.e2eAssessment.level).toBe("recommended");
  });

  it("does not guess a parent plan from persisted candidates", () => {
    const { context, assessment, plan } = verificationFixture();
    expect(projectInvestigationReportAssessment(context, [], [plan])).toBe(assessment);
  });

  it("preserves an explicit model plan reference", () => {
    const { context, assessment, plan } = verificationFixture();
    assessment.e2eAssessment.planRef = { id: "explicit-plan", version: 2, digest: "b".repeat(64) };
    expect(projectInvestigationReportAssessment(context, [], [plan], plan)).toBe(assessment);
    expect(assessment.e2eAssessment.planRef.id).toBe("explicit-plan");
  });

  it("preserves an explicit assessment that no E2E work is needed", () => {
    const { context, assessment, plan } = verificationFixture();
    assessment.e2eAssessment.level = "not_needed";
    expect(projectInvestigationReportAssessment(context, [], [plan], plan)).toBe(assessment);
    expect(assessment.e2eAssessment.planRef).toBeNull();
  });

  it.each([
    "root review",
    "missing parent task",
    "missing parent report",
    "parent report ID",
    "parent report version",
    "subject",
    "task subject",
    "source repository",
    "source work item",
    "plan kind",
    "plan digest",
    "persisted content",
    "missing persisted plan",
  ])("does not repair a mismatched %s binding", (mismatch) => {
    const { context, assessment, plan } = verificationFixture();
    const source = context.context.subjects.find((entry) => entry.id === assessment.subjectRef)!;
    let persisted = [plan];
    if (mismatch === "root review") context.context.task.kind = "pr-review";
    if (mismatch === "missing parent task") context.context.task.parentTaskId = null;
    if (mismatch === "missing parent report") context.context.parentReportRef = null;
    if (mismatch === "parent report ID") context.context.parentReportRef!.id = "another-report";
    if (mismatch === "parent report version") context.context.parentReportRef!.version += 1;
    if (mismatch === "subject") plan.subjectRef = "another-subject";
    if (mismatch === "task subject") context.context.task.subjectRef = "another-subject";
    if (mismatch === "source repository") source.repositoryId = "another-repository";
    if (mismatch === "source work item") source.workItemId = "another-work-item";
    if (mismatch === "plan kind") plan.kind = "fix";
    if (mismatch === "persisted content")
      persisted = [{ ...plan, title: "Different saved content" }];
    if (mismatch === "missing persisted plan") persisted = [];
    plan.digest = investigationContentDigest(investigationPlanDigestPayload(plan));
    if (mismatch === "plan digest") plan.digest = "f".repeat(64);

    expect(projectInvestigationReportAssessment(context, [], persisted, plan)).toBe(assessment);
    expect(assessment.e2eAssessment.planRef).toBeNull();
  });
});
