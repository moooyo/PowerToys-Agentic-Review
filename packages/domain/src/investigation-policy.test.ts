import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationActionKind,
  type InvestigationResultV1,
  investigationPlanDigestPayload,
  validateInvestigationResult,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { createInvestigationCheckpoint, investigationContentDigest } from "./investigation-loop.js";
import {
  evaluateInvestigationActions,
  hasSufficientInvestigationE2eEvidence,
  type InvestigationActionPolicyInput,
  resolveInvestigationFeedbackSelection,
  validateInvestigationNextActions,
} from "./investigation-policy.js";

const capabilities: InvestigationActionKind[] = [
  "approve",
  "comment",
  "suggestion-comment",
  "request-changes",
  "close",
  "merge",
  "trigger-ci",
  "start-task",
  "reviews.verify",
  "view-validation",
  "view-evidence",
];

function policyInput(result: InvestigationResultV1): InvestigationActionPolicyInput {
  const subject = result.context.subjects[0]!;
  return {
    repositoryId: result.context.repository.id,
    workItemId: result.context.workItem.id,
    actor: { id: "reviewer", displayName: "Reviewer" },
    target: {
      kind: result.context.workItem.kind,
      state: "open",
      headSha: subject.kind === "original_pr" ? subject.headSha : null,
      revisionKey: subject.revisionKey,
    },
    generatedAt: "2026-09-15T04:00:00.000Z",
    result,
    capabilities,
    persistedPlans: result.plans,
  };
}

function approveAllowed(
  result: InvestigationResultV1,
  override: Partial<InvestigationActionPolicyInput> = {},
): boolean {
  return evaluateInvestigationActions({ ...policyInput(result), ...override }).fixedActions.find(
    (entry) => entry.action === "approve",
  )!.allowed;
}

function namedReviewFixture(name: string, findingCount = 1) {
  const original = createInvestigationFixture("pr", { findingCount, priority: "P0" });
  const fixture = JSON.parse(
    JSON.stringify(original).replaceAll("synthetic-pr-", `${name}-`),
  ) as typeof original;
  fixture.task.workItem.id = original.task.workItem.id;
  fixture.result.context.workItem.id = original.task.workItem.id;
  for (const subject of [...fixture.task.subjects, ...fixture.result.context.subjects])
    subject.workItemId = original.task.workItem.id;
  return fixture;
}

function rereviewFixture(
  previous: InvestigationResultV1,
  name: string,
  disposition: "not_confirmed" | "still_present" = "not_confirmed",
  findingCount = disposition === "still_present" ? previous.findings.length : 0,
) {
  const fixture = namedReviewFixture(name, findingCount);
  const subject = previous.context.subjects.find(
    (entry) => entry.id === previous.context.task.subjectRef,
  );
  if (subject?.kind !== "original_pr") throw new Error("Expected an original PR baseline.");
  const baseline = {
    reportRef: {
      id: previous.report.id,
      version: previous.report.version,
      digest: previous.report.logicalContentDigest,
    },
    sourceTaskId: previous.context.task.id,
    subject: structuredClone(subject),
    findings: previous.findings.map(({ id, version, title }) => ({ id, version, title })),
  };
  fixture.task.reviewBaseline = structuredClone(baseline);
  fixture.result.context.reviewBaseline = structuredClone(baseline);
  const evidenceId = `${name}-rereview-evidence`;
  fixture.result.verificationEvidence.push({
    id: evidenceId,
    subjectRef: fixture.task.subjectRef,
    source: "static_analysis",
    authority: "model",
    summary: "The previous diagnosis was independently checked against the current frozen source.",
    artifactRefs: [],
    evidenceRefs: [fixture.result.verificationEvidence[0]!.id],
    provenance: {
      taskId: fixture.task.id,
      attemptId: fixture.attempt.id,
      producer: "synthetic-rereview",
      recordedAt: "2026-10-01T02:00:00.000Z",
    },
  });
  for (const [index, finding] of baseline.findings.entries()) {
    fixture.result.report.loop.candidates.unshift({
      id: `${name}-baseline-candidate-${index + 1}`,
      subjectRef: fixture.task.subjectRef,
      title: finding.title,
      discoveredRound: 0,
      status: disposition === "still_present" ? "merged" : "withdrawn",
      findingId: null,
      findingVersion: null,
      mergedIntoCandidateId:
        disposition === "still_present" ? `${name}-candidate-${index + 1}` : null,
      rationale: "The current source evidence supports this explicit review conclusion.",
      evidenceRefs: [evidenceId],
      reviewBaselineFindingRef: { id: finding.id, version: finding.version },
      reviewDisposition: disposition,
    });
  }
  fixture.result.report.collections.candidates = fixture.result.report.loop.candidates.length;
  fixture.result.report.collections.verificationEvidence =
    fixture.result.verificationEvidence.length;
  return fixture;
}

function reviewCheckpoint(fixture: ReturnType<typeof namedReviewFixture>) {
  const { task, attempt, result } = fixture;
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: `${task.id}-accepted-checkpoint`,
    leaseVersion: 1,
    recordedAt: "2026-10-01T02:00:00.000Z",
  });
  checkpoint.analysis.findings = structuredClone(result.findings);
  checkpoint.analysis.candidates = structuredClone(result.report.loop.candidates);
  checkpoint.analysis.rechecks = structuredClone(result.report.recheck.records);
  checkpoint.analysis.evidence = result.verificationEvidence
    .filter((entry) => entry.source === "static_analysis")
    .map((entry) => ({
      id: entry.id,
      subjectRef: entry.subjectRef,
      source: "static_analysis" as const,
      summary: entry.summary,
      evidenceRefs: entry.evidenceRefs,
    }));
  const { digest: _digest, ...content } = checkpoint;
  checkpoint.digest = investigationContentDigest(content);
  return { task, checkpoint };
}

function verificationReportWithoutActions(): InvestigationResultV1 {
  const { result } = createInvestigationFixture("pr", { findingCount: 0 });
  result.nextActions = [];
  result.report.collections.nextActions = 0;
  return result;
}

function issuePlanReportWithoutActions(
  planKind: "verification" | "reproduction" = "reproduction",
  sourceKind: "issue_snapshot" | "source_commit" | "local_patch" = "issue_snapshot",
): InvestigationResultV1 {
  const { result } = createInvestigationFixture("bug", { findingCount: 0 });
  const plan = result.plans[0]!;
  plan.kind = planKind;
  plan.prerequisites = [];
  result.nextActions = [];
  result.report.collections.nextActions = 0;
  if (sourceKind !== "issue_snapshot") {
    const base = {
      id: "native-issue-source",
      kind: "source_commit" as const,
      repositoryId: result.context.repository.id,
      workItemId: result.context.workItem.id,
      revisionKey: "7".repeat(64),
      commitSha: "8".repeat(40),
    };
    result.context.subjects.push(base);
    let selectedId = base.id;
    if (sourceKind === "local_patch") {
      selectedId = "native-issue-patch";
      result.context.subjects.push({
        id: selectedId,
        kind: "local_patch",
        repositoryId: base.repositoryId,
        workItemId: base.workItemId,
        revisionKey: "9".repeat(64),
        baseSubjectRef: base.id,
        baseSha: base.commitSha,
        patchDigest: "a".repeat(64),
        artifactRef: "native-issue-patch-artifact",
      });
    }
    result.assessment.subjectRef = selectedId;
    result.context.task.subjectRef = selectedId;
    plan.subjectRef = selectedId;
  }
  return result;
}

function issueFixReportWithoutPatchAction(): InvestigationResultV1 {
  const { result } = createInvestigationFixture("bug", { findingCount: 1 });
  const original = result.context.subjects[0]!;
  if (original.kind !== "issue_snapshot" || result.assessment.kind !== "bug")
    throw new Error("Expected an Issue report.");
  const snapshot = { ...original, id: "current-issue-snapshot" };
  const base = {
    id: original.id,
    kind: "source_commit" as const,
    repositoryId: original.repositoryId,
    workItemId: original.workItemId,
    revisionKey: "7".repeat(64),
    commitSha: "8".repeat(40),
  };
  const patch = {
    id: "native-issue-patch",
    kind: "local_patch" as const,
    repositoryId: base.repositoryId,
    workItemId: base.workItemId,
    revisionKey: "9".repeat(64),
    baseSubjectRef: base.id,
    baseSha: base.commitSha,
    patchDigest: "a".repeat(64),
    artifactRef: "native-issue-patch-artifact",
  };
  result.context.subjects = [snapshot, base, patch];
  result.context.task.kind = "issue-fix";
  result.context.task.subjectRef = base.id;
  result.context.task.parentTaskId = "parent-issue-investigation";
  result.context.parentReportRef = {
    id: "parent-issue-report",
    version: 1,
    digest: "b".repeat(64),
  };
  result.assessment.subjectRef = base.id;
  result.assessment.bugAssessment.status = "confirmed";
  result.assessment.reproduction.planRef = null;
  result.findings[0]!.confirmation.status = "confirmed";
  result.report.loop.candidates[0]!.status = "confirmed";
  const fixPlan = result.plans[0]!;
  fixPlan.kind = "fix";
  fixPlan.prerequisites = [];
  fixPlan.sourceReportRef = { id: result.context.parentReportRef.id, version: 1 };
  fixPlan.digest = investigationContentDigest(investigationPlanDigestPayload(fixPlan));
  result.findings[0]!.fixRecommendation.planRef = {
    id: fixPlan.id,
    version: fixPlan.version,
    digest: fixPlan.digest,
  };
  const patchPlan = {
    ...structuredClone(fixPlan),
    id: "generated-patch-verification",
    kind: "verification" as const,
    subjectRef: patch.id,
    title: "Verify the generated patch",
    steps: [
      {
        id: "generated-patch-behavior",
        description: "Exercise the reported behavior against the freshly built patch.",
        expectedObservation: "The patched product satisfies the recorded expected behavior.",
        checkIds: ["generated-patch-check"],
      },
    ],
    sourceReportRef: { id: result.report.id, version: result.report.version },
  };
  patchPlan.digest = investigationContentDigest(investigationPlanDigestPayload(patchPlan));
  result.plans.push(patchPlan);
  result.report.collections.plans = result.plans.length;
  for (const check of result.validation.checks)
    check.planRef = { id: fixPlan.id, version: fixPlan.version, digest: fixPlan.digest };
  result.nextActions = [];
  result.report.collections.nextActions = 0;
  result.artifacts.push({
    id: patch.artifactRef,
    taskId: result.context.task.id,
    attemptId: result.context.attempt.id,
    subjectRef: patch.id,
    kind: "patch",
    name: "fix.patch",
    mediaType: "text/x-diff",
    digest: patch.patchDigest,
    byteLength: 42,
    availability: "available",
  });
  result.report.collections.artifacts = result.artifacts.length;
  return result;
}

describe("investigation action policy", () => {
  it("derives patch verification from an Issue fix report whose primary source remains the base commit", () => {
    const result = issueFixReportWithoutPatchAction();
    const original = structuredClone(result);
    const patch = result.context.subjects.find((entry) => entry.kind === "local_patch")!;
    expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    const context = evaluateInvestigationActions(policyInput(result));
    expect(context.nextActions).toHaveLength(1);
    const action = context.nextActions[0]!;
    expect(action).toMatchObject({
      action: "start-task",
      taskKind: "issue-verify",
      subjectRef: patch.id,
      planRef: {
        id: result.plans[1]!.id,
        version: result.plans[1]!.version,
        digest: result.plans[1]!.digest,
      },
      canPrepare: true,
      readyToExecute: true,
    });
    expect(action.subjectRef).not.toBe(result.assessment.subjectRef);
    result.nextActions = [{ ...action }];
    result.report.collections.nextActions = 1;
    expect(evaluateInvestigationActions(policyInput(result)).nextActions).toHaveLength(1);
    result.nextActions = [];
    result.report.collections.nextActions = 0;
    expect(result).toEqual(original);
  });

  it.each([
    "stale snapshot",
    "base SHA",
    "artifact digest",
    "artifact availability",
    "artifact producer",
    "artifact attempt",
    "plan from another report",
    "missing checks",
    "unsupported assessment",
  ])("does not derive patch verification with invalid %s", (change) => {
    const result = issueFixReportWithoutPatchAction();
    const input = policyInput(result);
    const patch = result.context.subjects.find((entry) => entry.kind === "local_patch")!;
    if (patch.kind !== "local_patch") throw new Error("Expected a patch.");
    const artifact = result.artifacts.find((entry) => entry.id === patch.artifactRef)!;
    if (change === "stale snapshot") input.target.revisionKey = "different-snapshot";
    if (change === "base SHA") patch.baseSha = "b".repeat(40);
    if (change === "artifact digest") artifact.digest = "b".repeat(64);
    if (change === "artifact availability") artifact.availability = "missing";
    if (change === "artifact producer") artifact.taskId = "another-task";
    if (change === "artifact attempt") artifact.attemptId = "another-attempt";
    if (change === "plan from another report")
      result.plans[1]!.sourceReportRef.id = "another-report";
    if (change === "missing checks") result.plans[1]!.steps[0]!.checkIds = [];
    if (change === "unsupported assessment" && result.assessment.kind === "bug")
      result.assessment.bugAssessment.status = "needs_information";
    expect(evaluateInvestigationActions(input).nextActions).toEqual([]);
  });

  it.each([
    ["reproduction", "issue_snapshot"],
    ["verification", "source_commit"],
    ["verification", "local_patch"],
  ] as const)(
    "derives a native Issue %s action for %s without changing the report",
    (planKind, sourceKind) => {
      const result = issuePlanReportWithoutActions(planKind, sourceKind);
      const original = structuredClone(result);
      const input = policyInput(result);
      const context = evaluateInvestigationActions(input);
      expect(context.nextActions).toHaveLength(1);
      const action = context.nextActions[0]!;
      expect(action).toMatchObject({
        action: "start-task",
        taskKind: planKind === "reproduction" ? "reproduction-setup" : "issue-verify",
        subjectRef: result.assessment.subjectRef,
        planRef: result.assessment.kind === "bug" ? result.assessment.reproduction.planRef : null,
        sourceReportRef: { id: result.report.id, version: result.report.version },
        canPrepare: true,
        readyToExecute: true,
        allowed: true,
      });
      expect(evaluateInvestigationActions(input).nextActions[0]!.id).toBe(action.id);
      expect(
        evaluateInvestigationActions({ ...input, capabilities: [] }).nextActions[0],
      ).toMatchObject({
        id: action.id,
        canPrepare: false,
        allowed: false,
      });
      expect(result).toEqual(original);
    },
  );

  it("keeps an existing saved Issue action without deriving a duplicate", () => {
    const { result } = createInvestigationFixture("bug", { findingCount: 0 });
    const saved = result.nextActions.find((action) => action.action === "start-task")!;
    const actions = evaluateInvestigationActions(policyInput(result)).nextActions.filter(
      (action) => action.action === "start-task",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject(saved);
  });

  it.each([
    "stale snapshot",
    "missing saved plan",
    "changed saved plan",
    "different subject",
    "wrong plan kind",
    "different report",
    "unsupported assessment",
  ])("does not derive an Issue action for a %s", (change) => {
    const result = issuePlanReportWithoutActions();
    const input = { ...policyInput(result) };
    const plan = result.plans[0]!;
    if (change === "stale snapshot") input.target.revisionKey = "different-snapshot";
    if (change === "missing saved plan") input.persistedPlans = [];
    if (change === "changed saved plan")
      input.persistedPlans = [{ ...plan, rationale: "A different saved plan." }];
    if (change === "different subject") plan.subjectRef = "another-source";
    if (change === "wrong plan kind") plan.kind = "fix";
    if (change === "different report") plan.sourceReportRef.id = "another-report";
    if (change === "unsupported assessment" && result.assessment.kind === "bug")
      result.assessment.bugAssessment.status = "needs_information";
    expect(evaluateInvestigationActions(input).nextActions).toEqual([]);
  });

  it("evaluates a P0 beyond the first 100 findings independently of selection", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 137, priority: "P2" });
    result.findings[136]!.priority = "P0";
    const context = evaluateInvestigationActions(policyInput(result));
    expect(context.hardContentBlockers.map((entry) => entry.findingId)).toEqual([
      result.findings[136]!.id,
    ]);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
    expect(context.fixedActions.find((entry) => entry.action === "merge")?.allowed).toBe(true);
  });

  it("refuses to use a page as the complete report basis", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 137, priority: "P2" });
    result.findings[136]!.priority = "P0";
    const page = structuredClone(result);
    page.findings = page.findings.slice(0, 50);
    const context = evaluateInvestigationActions({
      ...policyInput(page),
      validatedReports: [result],
    });
    expect(context.reportRef).toBeNull();
    expect(context.nextActions).toEqual([]);
    expect(context.hardContentBlockers).toHaveLength(1);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
  });

  it.each(["P1", "P2", "P3"] as const)(
    "does not add an approval content blocker for %s",
    (priority) => {
      const { result } = createInvestigationFixture("pr", { priority });
      expect(approveAllowed(result)).toBe(true);
      if (priority === "P1")
        expect(evaluateInvestigationActions(policyInput(result)).recommendation.action).toBe(
          "request-changes",
        );
    },
  );

  it.each(["blocked", "failed", "cancelled", "interrupted"] as const)(
    "keeps manual approval available for a %s investigation",
    (outcome) => {
      const { result } = createInvestigationFixture("pr", { outcome, priority: "P1" });
      expect(approveAllowed(result)).toBe(true);
      expect(evaluateInvestigationActions(policyInput(result)).recommendation.action).toBe(
        "view-evidence",
      );
    },
  );

  it("retains a validated P0 from the last accepted report when the latest result is unavailable", () => {
    const { result } = createInvestigationFixture("pr", { priority: "P0", outcome: "failed" });
    expect(approveAllowed(result, { result: null, validatedReports: [result] })).toBe(false);
  });

  it("blocks approval for an accepted rechecked P0 checkpoint before a report has been sealed", () => {
    const { task, attempt, result } = createInvestigationFixture("pr", { priority: "P0" });
    const checkpoint = createInvestigationCheckpoint({
      task,
      attemptId: attempt.id,
      checkpointId: "accepted-checkpoint",
      leaseVersion: 1,
      recordedAt: "2026-09-15T04:00:00.000Z",
    });
    checkpoint.analysis.findings = result.findings;
    checkpoint.analysis.candidates = result.report.loop.candidates;
    checkpoint.analysis.rechecks = result.report.recheck.records;
    checkpoint.analysis.evidence = result.verificationEvidence
      .filter((entry) => entry.source === "static_analysis")
      .map((entry) => ({
        id: entry.id,
        subjectRef: entry.subjectRef,
        source: "static_analysis",
        summary: entry.summary,
        evidenceRefs: entry.evidenceRefs,
      }));
    const { digest: _digest, ...content } = checkpoint;
    checkpoint.digest = investigationContentDigest(content);
    const context = evaluateInvestigationActions({
      ...policyInput(result),
      result: null,
      validatedCheckpoints: [{ task, checkpoint }],
    });
    expect(context.hardContentBlockers).toHaveLength(1);
    expect(context.hardContentBlockers[0]!.reportRef).toBeNull();
    expect(context.hardContentBlockers[0]!.checkpointRef?.digest).toBe(checkpoint.digest);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
  });

  it("adopts a same-SHA rereview rejecting the exact previous P0 without rewriting its history", () => {
    const previous = namedReviewFixture("previous-review");
    const current = rereviewFixture(previous.result, "current-review");
    const original = structuredClone(previous);
    expect(validateInvestigationResult(current.result)).toEqual({ valid: true, errors: [] });
    const context = evaluateInvestigationActions({
      ...policyInput(current.result),
      validatedReports: [previous.result],
      validatedCheckpoints: [reviewCheckpoint(previous)],
    });
    expect(context.hardContentBlockers).toEqual([]);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(true);
    expect(previous).toEqual(original);
  });

  it.each([
    "report id",
    "report version",
    "report digest",
    "source task",
    "source subject",
    "source base SHA",
    "finding id",
    "finding version",
    "finding title",
    "failed review",
    "partial review",
    "truncated collection",
    "pending disposition",
    "unverified disposition",
    "fixed without a new head",
    "missing finding ref",
    "non-review task",
    "old SHA",
    "missing fresh evidence",
    "previous-task evidence",
    "duplicate baseline candidate",
  ])("retains the previous P0 when a rereview has a mismatched or incomplete %s", (change) => {
    const previous = namedReviewFixture("previous-review");
    const current = rereviewFixture(previous.result, "current-review");
    const result = current.result;
    const baseline = result.context.reviewBaseline!;
    const candidate = result.report.loop.candidates[0]!;
    if (change === "report id") baseline.reportRef.id = "unknown-report";
    if (change === "report version") baseline.reportRef.version += 1;
    if (change === "report digest") baseline.reportRef.digest = "f".repeat(64);
    if (change === "source task") baseline.sourceTaskId = "unknown-source-task";
    if (change === "source subject") baseline.subject.id = "different-baseline-subject";
    if (change === "source base SHA") baseline.subject.baseSha = "f".repeat(40);
    if (change === "finding id") {
      baseline.findings[0]!.id = "different-baseline-finding";
      candidate.reviewBaselineFindingRef!.id = baseline.findings[0]!.id;
    }
    if (change === "finding version") {
      baseline.findings[0]!.version += 1;
      candidate.reviewBaselineFindingRef!.version = baseline.findings[0]!.version;
    }
    if (change === "finding title") baseline.findings[0]!.title = "A different diagnosis";
    if (change === "failed review") result.outcome = "failed";
    if (change === "partial review") result.report.completeness = "partial";
    if (change === "truncated collection") result.report.collections.candidates += 1;
    if (change === "pending disposition") {
      candidate.reviewDisposition = "pending";
      candidate.status = "pending";
    }
    if (change === "unverified disposition") {
      candidate.reviewDisposition = "unverified";
      result.report.limitations.push({
        id: "unverified-baseline-limitation",
        description:
          "The current source does not establish whether the previous diagnosis is valid.",
        impact: "The previous P0 remains unresolved.",
        evidenceRefs: [...candidate.evidenceRefs],
      });
      expect(validateInvestigationResult(result)).toEqual({ valid: true, errors: [] });
    }
    if (change === "fixed without a new head") candidate.reviewDisposition = "fixed";
    if (change === "missing finding ref") delete candidate.reviewBaselineFindingRef;
    if (change === "non-review task") result.context.task.kind = "pr-verify";
    if (change === "old SHA") {
      const subject = result.context.subjects[0]!;
      if (subject.kind !== "original_pr") throw new Error("Expected an original PR subject.");
      subject.headSha = "e".repeat(40);
      subject.revisionKey = "e".repeat(64);
    }
    if (change === "missing fresh evidence")
      candidate.evidenceRefs = [result.verificationEvidence[0]!.id];
    if (change === "previous-task evidence")
      result.verificationEvidence.at(-1)!.provenance.taskId = previous.task.id;
    if (change === "duplicate baseline candidate") {
      result.report.loop.candidates.push({ ...candidate, id: "duplicate-baseline-candidate" });
      result.report.collections.candidates += 1;
    }
    const context = evaluateInvestigationActions({
      ...policyInput(previous.result),
      result,
      validatedReports: [previous.result],
      validatedCheckpoints: [reviewCheckpoint(previous)],
    });
    expect(context.hardContentBlockers).toHaveLength(2);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
  });

  it("keeps a reconfirmed P0 and its previous diagnosis blocking approval", () => {
    const previous = namedReviewFixture("previous-review");
    const current = rereviewFixture(previous.result, "current-review", "still_present");
    expect(validateInvestigationResult(current.result)).toEqual({ valid: true, errors: [] });
    const context = evaluateInvestigationActions({
      ...policyInput(current.result),
      validatedReports: [previous.result],
    });
    expect(context.hardContentBlockers.map((entry) => entry.findingId)).toEqual([
      previous.result.findings[0]!.id,
      current.result.findings[0]!.id,
    ]);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
  });

  it("requires the actual baseline report before resolving an accepted checkpoint", () => {
    const previous = namedReviewFixture("previous-review");
    const current = rereviewFixture(previous.result, "current-review");
    const context = evaluateInvestigationActions({
      ...policyInput(current.result),
      validatedCheckpoints: [reviewCheckpoint(previous)],
    });
    expect(context.hardContentBlockers).toHaveLength(1);
    expect(context.hardContentBlockers[0]!.checkpointRef).not.toBeNull();
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
  });

  it("keeps a newly discovered P0 blocking after rejecting a previous diagnosis", () => {
    const previous = namedReviewFixture("previous-review");
    const current = rereviewFixture(previous.result, "current-review", "not_confirmed", 1);
    expect(validateInvestigationResult(current.result)).toEqual({ valid: true, errors: [] });
    const context = evaluateInvestigationActions({
      ...policyInput(current.result),
      validatedReports: [previous.result],
      validatedCheckpoints: [reviewCheckpoint(previous), reviewCheckpoint(current)],
    });
    expect(context.hardContentBlockers).toHaveLength(2);
    expect(
      context.hardContentBlockers.every(
        (entry) => entry.findingId === current.result.findings[0]!.id,
      ),
    ).toBe(true);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
  });

  it("only resolves the precisely rechecked finding when another previous P0 remains", () => {
    const previous = namedReviewFixture("previous-review", 2);
    const current = rereviewFixture(previous.result, "current-review", "still_present");
    const rejected = current.result.report.loop.candidates.find(
      (entry) => entry.reviewBaselineFindingRef?.id === previous.result.findings[0]!.id,
    )!;
    rejected.status = "withdrawn";
    rejected.reviewDisposition = "not_confirmed";
    rejected.mergedIntoCandidateId = null;
    expect(validateInvestigationResult(current.result)).toEqual({ valid: true, errors: [] });
    const context = evaluateInvestigationActions({
      ...policyInput(current.result),
      validatedReports: [previous.result],
    });
    expect(
      context.hardContentBlockers
        .filter((entry) => entry.reportRef?.id === previous.result.report.id)
        .map((entry) => entry.findingId),
    ).toEqual([previous.result.findings[1]!.id]);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
  });

  it("does not clear an independent task checkpoint or a different finding version", () => {
    const previous = namedReviewFixture("previous-review");
    const current = rereviewFixture(previous.result, "current-review");
    const independent = reviewCheckpoint(namedReviewFixture("independent-review"));
    const revised = reviewCheckpoint(previous);
    revised.checkpoint.analysis.findings[0]!.version += 1;
    revised.checkpoint.analysis.candidates[0]!.findingVersion =
      revised.checkpoint.analysis.findings[0]!.version;
    revised.checkpoint.analysis.rechecks[0]!.findingVersion += 1;
    const { digest: _digest, ...content } = revised.checkpoint;
    revised.checkpoint.digest = investigationContentDigest(content);
    const changedSubject = structuredClone(previous);
    const subject = changedSubject.task.subjects[0]!;
    if (subject.kind !== "original_pr") throw new Error("Expected an original PR subject.");
    subject.baseSha = "f".repeat(40);
    const context = evaluateInvestigationActions({
      ...policyInput(current.result),
      validatedReports: [previous.result],
      validatedCheckpoints: [
        reviewCheckpoint(previous),
        independent,
        revised,
        reviewCheckpoint(changedSubject),
      ],
    });
    expect(context.hardContentBlockers).toHaveLength(3);
    expect(context.hardContentBlockers.every((entry) => entry.reportRef === null)).toBe(true);
    expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(false);
  });

  it.each([false, true])(
    "resolves an exact carry-forward chain independently of report order (%s)",
    (reverse) => {
      const first = namedReviewFixture("first-review");
      const second = rereviewFixture(first.result, "second-review", "still_present");
      const third = rereviewFixture(second.result, "third-review");
      const reports = [first.result, second.result];
      if (reverse) reports.reverse();
      expect(validateInvestigationResult(second.result)).toEqual({ valid: true, errors: [] });
      expect(validateInvestigationResult(third.result)).toEqual({ valid: true, errors: [] });
      const context = evaluateInvestigationActions({
        ...policyInput(third.result),
        validatedReports: reports,
        validatedCheckpoints: [reviewCheckpoint(first), reviewCheckpoint(second)],
      });
      expect(context.hardContentBlockers).toEqual([]);
      expect(context.fixedActions.find((entry) => entry.action === "approve")?.allowed).toBe(true);
    },
  );

  it("keeps an exact rejected diagnosis resolved after another review with an empty baseline", () => {
    const first = namedReviewFixture("first-review");
    const second = rereviewFixture(first.result, "second-review");
    const third = rereviewFixture(second.result, "third-review");
    expect(validateInvestigationResult(third.result)).toEqual({ valid: true, errors: [] });
    expect(
      approveAllowed(third.result, {
        validatedReports: [first.result, second.result],
        validatedCheckpoints: [reviewCheckpoint(first)],
      }),
    ).toBe(true);
  });

  it("retains the old P0 when a later clean report has no exact rereview baseline", () => {
    const previous = namedReviewFixture("previous-review");
    const clean = namedReviewFixture("later-clean-review", 0);
    expect(approveAllowed(clean.result, { validatedReports: [previous.result] })).toBe(false);
  });

  it("only defaults independently validated current confirmed original-PR suggestions", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 3 });
    result.findings[1]!.confirmation.status = "hypothesis";
    result.findings[2]!.feedbackDraft.suggestion!.headSha = "1".repeat(40);
    const context = evaluateInvestigationActions({
      ...policyInput(result),
      validatedSuggestionFindingIds: result.findings.map((entry) => entry.id),
    });
    expect(context.suggestionSelectionDefaults.map((entry) => entry.selectedByDefault)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("requires every element of the current-original confirmed unresolved P0 predicate", () => {
    const { result } = createInvestigationFixture("pr", { priority: "P0" });
    expect(approveAllowed(result)).toBe(false);
    expect(approveAllowed(result, { resolvedFindingIds: [result.findings[0]!.id] })).toBe(true);
    const hypothetical = structuredClone(result);
    hypothetical.findings[0]!.confirmation.status = "hypothesis";
    expect(approveAllowed(hypothetical)).toBe(true);
    const revised = structuredClone(result);
    revised.findings[0]!.version += 1;
    expect(approveAllowed(revised)).toBe(true);
    const oldSource = policyInput(result).target;
    expect(
      approveAllowed(result, {
        target: { ...oldSource, headSha: "1".repeat(40), revisionKey: "2".repeat(64) },
      }),
    ).toBe(true);
    const patched = structuredClone(result);
    const original = patched.context.subjects[0]!;
    patched.context.subjects[0] = {
      id: original.id,
      repositoryId: original.repositoryId,
      workItemId: original.workItemId,
      revisionKey: original.revisionKey,
      kind: "local_patch",
      baseSubjectRef: "original",
      baseSha: "1".repeat(40),
      patchDigest: "2".repeat(64),
      artifactRef: "patch",
    };
    expect(approveAllowed(result, { result: patched })).toBe(true);
  });

  it("keeps permission, target state, and unknown submission guards independent", () => {
    const { result } = createInvestigationFixture("pr", { priority: "P1" });
    expect(approveAllowed(result, { capabilities: ["comment"] })).toBe(false);
    expect(
      approveAllowed(result, { target: { ...policyInput(result).target, state: "closed" } }),
    ).toBe(false);
    expect(
      approveAllowed(result, {
        pendingSubmission: {
          intentId: "unresolved",
          state: "unknown",
          message: "Reconcile the previous write.",
        },
      }),
    ).toBe(false);
    expect(approveAllowed(result, { result: null })).toBe(true);
  });

  it("recommends required verification without prohibiting manual approval", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 0 });
    const context = evaluateInvestigationActions(policyInput(result));
    expect(context.recommendation.action).toBe("reviews.verify");
    expect(context.nextActions.find((entry) => entry.action === "reviews.verify")?.allowed).toBe(
      false,
    );
    expect(approveAllowed(result)).toBe(true);
  });

  it("derives a stable native verification action from the saved assessment plan without changing the report", () => {
    const result = verificationReportWithoutActions();
    const original = structuredClone(result);
    const input = policyInput(result);
    const context = evaluateInvestigationActions(input);
    expect(context.nextActions).toHaveLength(1);
    const action = context.nextActions[0]!;
    expect(action).toMatchObject({
      action: "reviews.verify",
      taskKind: "pr-verify",
      subjectRef: result.assessment.subjectRef,
      planRef: {
        id: result.plans[0]!.id,
        version: result.plans[0]!.version,
        digest: result.plans[0]!.digest,
      },
      sourceReportRef: { id: result.report.id, version: result.report.version },
      prerequisiteRefs: result.plans[0]!.prerequisites.map((entry) => entry.id),
      canPrepare: true,
      readyToExecute: false,
      allowed: false,
    });
    expect(action.guards).toContainEqual({
      code: `prerequisite:${result.plans[0]!.prerequisites[0]!.id}`,
      satisfied: false,
      message: `Prerequisite ${result.plans[0]!.prerequisites[0]!.id} must be satisfied.`,
    });
    const ready = evaluateInvestigationActions({
      ...input,
      generatedAt: "2026-09-15T05:00:00.000Z",
      satisfiedPrerequisiteIds: result.plans[0]!.prerequisites.map((entry) => entry.id),
    }).nextActions[0]!;
    expect(ready).toMatchObject({ id: action.id, allowed: true, readyToExecute: true });
    expect(
      evaluateInvestigationActions({ ...input, capabilities: [] }).nextActions[0],
    ).toMatchObject({ id: action.id, allowed: false, canPrepare: false });
    expect(result).toEqual(original);
    expect(result.nextActions).toEqual([]);
  });

  it("reuses an existing valid verification action without deriving a duplicate", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 0 });
    const original = structuredClone(result);
    const saved = result.nextActions.find((action) => action.action === "reviews.verify")!;
    const actions = evaluateInvestigationActions(policyInput(result)).nextActions.filter(
      (action) => action.action === "reviews.verify",
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject(saved);
    expect(result).toEqual(original);
  });

  it("derives verification independently of a rejected proposal instead of reviving it", () => {
    const result = verificationReportWithoutActions();
    const native = evaluateInvestigationActions(policyInput(result)).nextActions[0]!;
    const { result: proposed } = createInvestigationFixture("pr", { findingCount: 0 });
    const rejected = proposed.nextActions.find((action) => action.action === "reviews.verify")!;
    rejected.taskKind = "pr-e2e";
    rejected.reason = "The rejected model proposal must remain unchanged.";
    result.nextActions = [rejected];
    result.report.collections.nextActions = 1;
    const original = structuredClone(result);
    const actions = evaluateInvestigationActions(policyInput(result)).nextActions;
    expect(actions).toEqual([native]);
    expect(actions[0]!.id).not.toBe(rejected.id);
    expect(result).toEqual(original);
  });

  it("requires actual recipe check coverage without inventing coverage for legacy steps", () => {
    const result = verificationReportWithoutActions();
    if (result.assessment.kind !== "pr") throw new Error("Expected a PR assessment.");
    const plan = result.plans[0]!;
    const step = plan.steps[0]!;
    const scenarioId = result.assessment.e2eAssessment.scenarioIds[0]!;
    step.recipe = {
      request: {
        recipeId: "powertoys-run-query",
        plugin: "UnitConverter",
        scenarios: [
          {
            query: "10 sqmi in sqkm",
            feature: {
              id: "area-conversion",
              title: "Convert square miles",
              paths: ["src/modules/launcher/Plugins/Microsoft.PowerToys.Run.Plugin.UnitConverter"],
              scenario: "Convert square miles to square kilometres.",
              userVisible: true,
              assertions: [
                {
                  id: "conversion-result",
                  kind: "ui",
                  description: "The conversion result is displayed.",
                  selector: { automationId: "conversion-result" },
                  assertion: { property: "exists", expected: true },
                },
              ],
            },
          },
        ],
      },
      checks: [
        {
          checkId: step.checkIds[0]!,
          featureId: "area-conversion",
          assertionId: "conversion-result",
          scenarioId,
        },
      ],
    };
    const input = policyInput(result);
    expect(evaluateInvestigationActions(input).nextActions).toHaveLength(1);
    step.recipe.checks[0]!.scenarioId = "unrelated-scenario";
    expect(evaluateInvestigationActions(input).nextActions).toEqual([]);
    step.recipe.checks[0]!.scenarioId = scenarioId;
    step.recipe.checks[0]!.checkId = "unsaved-check";
    expect(evaluateInvestigationActions(input).nextActions).toEqual([]);
    step.recipe.checks[0]!.checkId = step.checkIds[0]!;
    plan.steps.push({
      id: "legacy-step",
      description: "Perform the additional manually bound check.",
      expectedObservation: "The additional check passes.",
      checkIds: ["legacy-check"],
    });
    expect(evaluateInvestigationActions(input).nextActions[0]).toMatchObject({
      action: "reviews.verify",
      canPrepare: true,
      allowed: false,
    });
    result.assessment.e2eAssessment.scenarioIds.push("legacy-scenario");
    expect(evaluateInvestigationActions(input).nextActions).toEqual([]);
  });

  it.each([
    "stale revision",
    "missing saved plan",
    "plan absent from report",
    "different plan digest",
    "plan from the parent report",
    "different report version",
    "different subject",
    "wrong plan kind",
    "empty steps",
    "empty acceptance criteria",
  ])("does not derive native verification for a %s", (change) => {
    const result = verificationReportWithoutActions();
    if (result.assessment.kind !== "pr") throw new Error("Expected a PR assessment.");
    const plan = result.plans[0]!;
    let overrides: Partial<InvestigationActionPolicyInput> = {};
    switch (change) {
      case "stale revision":
        overrides = { target: { ...policyInput(result).target, revisionKey: "new-revision" } };
        break;
      case "missing saved plan":
        overrides = { persistedPlans: [] };
        break;
      case "plan absent from report":
        overrides = { persistedPlans: result.plans };
        result.plans = [];
        result.report.collections.plans = 0;
        break;
      case "different plan digest":
        result.assessment.e2eAssessment.planRef = {
          id: plan.id,
          version: plan.version,
          digest: "f".repeat(64),
        };
        break;
      case "plan from the parent report":
        result.context.parentReportRef = {
          id: "parent-report",
          version: 1,
          digest: "f".repeat(64),
        };
        plan.sourceReportRef = { id: "parent-report", version: 1 };
        break;
      case "different report version":
        plan.sourceReportRef.version++;
        break;
      case "different subject":
        plan.subjectRef = "another-subject";
        break;
      case "wrong plan kind":
        plan.kind = "investigation";
        break;
      case "empty steps":
        plan.steps = [];
        break;
      case "empty acceptance criteria":
        plan.acceptanceCriteria = [];
        break;
    }
    expect(
      evaluateInvestigationActions({ ...policyInput(result), ...overrides }).nextActions,
    ).toEqual([]);
  });

  it("does not synthesize feature implementation from ready without a saved plan", () => {
    const { result } = createInvestigationFixture("feature");
    expect(
      validateInvestigationNextActions(result, []).find(
        (entry) => entry.action.action === "start-task",
      )?.valid,
    ).toBe(false);
    const context = evaluateInvestigationActions({ ...policyInput(result), persistedPlans: [] });
    expect(context.nextActions.some((entry) => entry.action === "start-task")).toBe(false);
    expect(context.fixedActions.map((entry) => entry.action)).toEqual(["comment", "close"]);
  });

  it("keeps a valid bug reproduction plan visible while its environment is unavailable", () => {
    const { result } = createInvestigationFixture("bug");
    const context = evaluateInvestigationActions(policyInput(result));
    const action = context.nextActions.find((entry) => entry.action === "start-task")!;
    expect(action).toBeDefined();
    expect(action.allowed).toBe(false);
    expect(action.canPrepare).toBe(true);
    expect(action.readyToExecute).toBe(false);
    expect(
      action.guards.some((entry) => entry.code.startsWith("prerequisite:") && !entry.satisfied),
    ).toBe(true);
    expect(
      evaluateInvestigationActions({
        ...policyInput(result),
        satisfiedPrerequisiteIds: result.plans[0]!.prerequisites.map((entry) => entry.id),
      }).nextActions.find((entry) => entry.action === "start-task")?.allowed,
    ).toBe(true);
  });

  it("does not let preparation bypass authorization, actor, or unknown-submission guards", () => {
    const { result } = createInvestigationFixture("bug");
    const authorization = {
      id: "execution-authorization",
      kind: "authorization" as const,
      description: "An authorized operator must permit execution.",
    };
    result.plans[0]!.prerequisites.push(authorization);
    result.nextActions[0]!.prerequisiteRefs.push(authorization.id);
    expect(evaluateInvestigationActions(policyInput(result)).nextActions[0]?.canPrepare).toBe(
      false,
    );
    const authorized = { ...policyInput(result), satisfiedPrerequisiteIds: [authorization.id] };
    expect(evaluateInvestigationActions(authorized).nextActions[0]?.canPrepare).toBe(true);
    expect(
      evaluateInvestigationActions({ ...authorized, capabilities: [] }).nextActions[0]?.canPrepare,
    ).toBe(false);
    expect(
      evaluateInvestigationActions({
        ...authorized,
        pendingSubmission: {
          intentId: "pending",
          state: "unknown",
          message: "Resolve prior submission.",
        },
      }).nextActions[0]?.canPrepare,
    ).toBe(false);
  });

  it("rejects a persisted plan bound to another report or task kind", () => {
    const { result } = createInvestigationFixture("feature");
    const plans = structuredClone(result.plans);
    plans[0]!.sourceReportRef.id = "different-report";
    expect(validateInvestigationNextActions(result, plans)[0]?.valid).toBe(false);
    result.nextActions[0]!.taskKind = "issue-fix";
    expect(validateInvestigationNextActions(result, result.plans)[0]?.valid).toBe(false);
  });

  it("preserves a trusted inherited plan without rebinding its source report", () => {
    const { result } = createInvestigationFixture("feature");
    const parentRef = {
      id: result.report.id,
      version: result.report.version,
      digest: result.report.logicalContentDigest,
    };
    result.context.parentReportRef = parentRef;
    result.report.id = "child-feature-report";
    for (const action of result.nextActions)
      action.sourceReportRef = { id: result.report.id, version: result.report.version };
    expect(validateInvestigationNextActions(result, result.plans)[0]?.valid).toBe(true);
    expect(result.plans[0]!.sourceReportRef).toEqual({
      id: parentRef.id,
      version: parentRef.version,
    });
    result.context.parentReportRef.version += 1;
    expect(validateInvestigationNextActions(result, result.plans)[0]?.valid).toBe(false);
  });

  it("allows only the frozen issue verification source binding to inherit a snapshot plan", () => {
    const { result } = createInvestigationFixture("bug");
    const snapshot = result.context.subjects[0]!;
    result.context.parentReportRef = {
      id: result.report.id,
      version: 1,
      digest: result.report.logicalContentDigest,
    };
    result.report.id = "issue-verification-report";
    result.context.task.kind = "reproduction-setup";
    result.context.task.subjectRef = "selected-source";
    result.assessment.subjectRef = "selected-source";
    result.context.subjects.push({
      id: "selected-source",
      kind: "source_commit",
      repositoryId: snapshot.repositoryId,
      workItemId: snapshot.workItemId,
      revisionKey: "f".repeat(64),
      commitSha: "c".repeat(40),
    });
    for (const action of result.nextActions)
      action.sourceReportRef = { id: result.report.id, version: 1 };
    result.nextActions[0]!.subjectRef = "selected-source";
    expect(validateInvestigationNextActions(result, result.plans)[0]?.valid).toBe(true);
    result.context.task.kind = "issue-fix";
    expect(validateInvestigationNextActions(result, result.plans)[0]?.valid).toBe(false);
  });

  it("allows an explicitly bound feature implementation source without changing the parent plan", () => {
    const { result } = createInvestigationFixture("feature");
    const snapshot = result.context.subjects[0]!;
    const originalPlan = structuredClone(result.plans[0]!);
    result.context.parentReportRef = {
      id: result.report.id,
      version: 1,
      digest: result.report.logicalContentDigest,
    };
    result.report.id = "feature-implementation-report";
    result.context.task.kind = "feature-implement";
    result.context.task.subjectRef = "selected-feature-source";
    result.assessment.subjectRef = "selected-feature-source";
    result.context.subjects.push({
      id: "selected-feature-source",
      kind: "source_commit",
      repositoryId: snapshot.repositoryId,
      workItemId: snapshot.workItemId,
      revisionKey: "f".repeat(64),
      commitSha: "c".repeat(40),
    });
    for (const action of result.nextActions)
      action.sourceReportRef = { id: result.report.id, version: 1 };
    result.nextActions[0]!.subjectRef = "selected-feature-source";
    expect(validateInvestigationNextActions(result, result.plans)[0]?.valid).toBe(true);
    expect(result.plans[0]).toEqual(originalPlan);
  });

  it("requires all frozen checks and scenarios with original-source execution evidence", () => {
    const { result } = createInvestigationFixture("pr", { findingCount: 0 });
    const check = result.validation.checks[0]!;
    check.status = "passed";
    check.executor = "synthetic-executor";
    check.authoritativeAttemptId = result.context.attempt.id;
    result.context.adoptedAttemptIds = [result.context.attempt.id];
    const evidence = {
      ...result.verificationEvidence[0]!,
      id: "execution-observation",
      source: "executor_observation" as const,
      artifactRefs: [],
    };
    result.verificationEvidence.push(evidence);
    result.report.collections.verificationEvidence += 1;
    check.evidenceRefs = [evidence.id];
    expect(hasSufficientInvestigationE2eEvidence(result, result.plans)).toBe(true);
    expect(evaluateInvestigationActions(policyInput(result)).recommendation.action).toBe("approve");
    result.plans[0]!.steps[0]!.checkIds.push("never-created-check");
    expect(hasSufficientInvestigationE2eEvidence(result, result.plans)).toBe(false);
    result.plans[0]!.steps[0]!.checkIds.pop();
    evidence.authority = "model";
    expect(hasSufficientInvestigationE2eEvidence(result, result.plans)).toBe(false);
  });
});

describe("investigation feedback selection", () => {
  const feedback = [
    {
      findingId: "suggestion",
      draftId: "draft-suggestion",
      suggestionId: "replacement",
      suggestionValid: true,
      textValid: true,
    },
    {
      findingId: "text",
      draftId: "draft-text",
      suggestionId: null,
      suggestionValid: false,
      textValid: true,
    },
    {
      findingId: "stale",
      draftId: "draft-stale",
      suggestionId: "stale-replacement",
      suggestionValid: false,
      textValid: true,
    },
  ];
  it("defaults only valid suggestions and never chooses request changes", () => {
    const selected = resolveInvestigationFeedbackSelection({
      feedback,
      recommendedActionId: "approve",
    });
    expect(selected.selectedFindingIds).toEqual(["suggestion"]);
    expect(selected.preferredActionId).toBe("suggestion-comment");
  });
  it("prepares only selected mixed feedback and keeps the formats distinct", () => {
    const selected = resolveInvestigationFeedbackSelection({
      feedback,
      selectedFindingIds: ["suggestion", "text"],
      recommendedActionId: "approve",
    });
    expect(selected.selectionKind).toBe("mixed");
    expect(selected.feedback.map((entry) => [entry.findingId, entry.kind])).toEqual([
      ["suggestion", "suggestion"],
      ["text", "comment"],
    ]);
    expect(selected.preferredActionId).not.toBe("request-changes");
  });
  it("restores the default after explicit deselection unless an explicit action is retained", () => {
    expect(
      resolveInvestigationFeedbackSelection({
        feedback,
        selectedFindingIds: [],
        recommendedActionId: "approve",
      }).preferredActionId,
    ).toBe("approve");
    expect(
      resolveInvestigationFeedbackSelection({
        feedback,
        selectedFindingIds: [],
        explicitAction: "request-changes",
        recommendedActionId: "approve",
      }).preferredActionId,
    ).toBe("request-changes");
  });
  it("reports invalid selections instead of silently dropping user-selected content", () => {
    expect(
      resolveInvestigationFeedbackSelection({
        feedback,
        selectedFindingIds: ["missing"],
        recommendedActionId: "approve",
      }).reasonCodes,
    ).toEqual(["unknown_selected_finding:missing"]);
  });
});
