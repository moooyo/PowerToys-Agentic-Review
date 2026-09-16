import {
  type InvestigationAnalysisV1,
  type InvestigationArtifactV1,
  type InvestigationAttemptV1,
  InvestigationAttemptV1Schema,
  type InvestigationEvidenceV1,
  type InvestigationLoopCheckpointV1,
  InvestigationLoopCheckpointV1Schema,
  type InvestigationPlanDraft,
  type InvestigationPlanV1,
  type InvestigationReportCollection,
  InvestigationReportHeaderV1Schema,
  InvestigationReportManifestV1Schema,
  type InvestigationReportPartV1,
  InvestigationReportPartV1Schema,
  type InvestigationSubjectV1,
  type InvestigationTaskV1,
  InvestigationTaskV1Schema,
} from "@agentic-review/contracts";
import {
  createInvestigationCheckpoint,
  investigationContentDigest,
  investigationTaskBindingDigest,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { beforeAll, describe, expect, it } from "vitest";

import { registerWorkerContractFormats } from "../contracts-formats.js";
import {
  buildInvestigationReportSubmission,
  InvestigationReportBuildError,
} from "./report-builder.js";

const recordedAt = "2026-09-15T02:00:03.000Z";
const reportId = "report:synthetic";

interface FixtureOptions {
  readonly findingCount?: number;
  readonly impact?: string;
  readonly maximumReportBytes?: number;
  readonly allowExecution?: boolean;
}

function seal(checkpoint: InvestigationLoopCheckpointV1): InvestigationLoopCheckpointV1 {
  const { digest: _digest, ...content } = checkpoint;
  return { ...checkpoint, digest: investigationContentDigest(content) };
}

/** All records are isolated synthetic data; no repository, executor, or upstream client is used. */
function fixture(options: FixtureOptions = {}) {
  const task: InvestigationTaskV1 = {
    schemaVersion: "InvestigationTaskV1",
    id: "task:synthetic",
    kind: "pr-review",
    repository: {
      id: "repository:synthetic",
      githubRepositoryId: 1,
      fullName: "synthetic/fixture",
    },
    workItem: {
      id: "work-item:synthetic",
      kind: "pull_request",
      number: 1,
      title: "Synthetic cancellation change",
    },
    parentTaskId: null,
    parentReportRef: null,
    planRef: null,
    subjectRef: "subject:synthetic",
    subjects: [
      {
        id: "subject:synthetic",
        kind: "original_pr",
        repositoryId: "repository:synthetic",
        workItemId: "work-item:synthetic",
        revisionKey: "a".repeat(64),
        baseSha: "b".repeat(40),
        headSha: "c".repeat(40),
      },
    ],
    scope: {
      scopeManifest: { id: "scope:synthetic", version: 1, digest: "d".repeat(64) },
      includedUnits: [
        {
          id: "unit:synthetic",
          subjectRef: "subject:synthetic",
          kind: "source",
          paths: ["src/cancellation.ts"],
          requiredWork: "Inspect every cancellation boundary and recheck every retained finding.",
          status: "pending",
          evidenceRefs: [],
        },
      ],
      exclusions: [
        {
          id: "exclusion:synthetic",
          subjectRef: "subject:synthetic",
          description: "Generated source files.",
          reason: "The frozen scope excludes generated source files.",
        },
      ],
      completedUnitRefs: [],
      unresolvedUnitRefs: ["unit:synthetic"],
    },
    executionPolicy: {
      mode: options.allowExecution ? "execute" : "source_read",
      allowedSubjectRefs: ["subject:synthetic"],
      allowRepositoryExecution: options.allowExecution ?? false,
      authorizationRef: options.allowExecution ? "authorization:synthetic" : null,
    },
    budget: {
      maxRounds: 8,
      maxDurationMs: 300_000,
      maxTokens: 128_000,
      maxReportBytes: options.maximumReportBytes ?? 32 * 1024 * 1024,
    },
    profileRef: { id: "profile:synthetic", version: 1, digest: "e".repeat(64) },
    promptRef: { id: "prompt:synthetic", version: 1, digest: "f".repeat(64) },
    state: "running",
    latestReportRef: null,
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };
  const attempt: InvestigationAttemptV1 = {
    schemaVersion: "InvestigationAttemptV1",
    id: "attempt:synthetic",
    taskId: task.id,
    number: 1,
    workerId: "worker:synthetic",
    leaseVersion: 1,
    state: "running",
    startedAt: recordedAt,
    finishedAt: null,
    terminationReason: null,
  };
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "checkpoint:synthetic",
    leaseVersion: attempt.leaseVersion,
    recordedAt,
  });
  const analysis: InvestigationAnalysisV1 = {
    schemaVersion: "InvestigationAnalysisV1",
    summary: "Every synthetic finding has been retained and rechecked.",
    coverage: {
      ...structuredClone(task.scope),
      includedUnits: task.scope.includedUnits.map((unit) => ({
        ...unit,
        status: "completed" as const,
      })),
      completedUnitRefs: ["unit:synthetic"],
      unresolvedUnitRefs: [],
    },
    findings: [],
    candidates: [],
    rechecks: [],
    evidence: [],
    plans: [],
    nextActions: [],
    feedbackDrafts: [],
    diagnostics: [],
    limitations: [],
    assessment: {
      kind: "pr",
      subjectRef: task.subjectRef,
      summary: "The synthetic source review found cancellation defects.",
      evidenceRefs: [],
      reviewConclusion: {
        status: "changes-requested",
        rationale: "The retained findings establish source defects.",
      },
      e2eAssessment: {
        level: "not_needed",
        rationale: "This fixture exercises report assembly without runtime claims.",
        planRef: null,
        scenarioIds: [],
        prerequisiteRefs: [],
        linkedValidationReportRefs: [],
      },
    },
  };
  for (let index = 0; index < (options.findingCount ?? 3); index += 1) {
    const findingId = `finding:${index}`;
    const evidenceId = `evidence:${index}`;
    const recheckId = `recheck:${index}`;
    const feedbackDraft = {
      id: `draft:${index}`,
      body: `Check cancellation before persistence at boundary ${index}.`,
      suggestion: null,
    };
    analysis.findings.push({
      id: findingId,
      version: 1,
      ordinal: index,
      priority: "P1",
      title: `Cancellation boundary ${index} is unchecked`,
      trigger: {
        conditions: ["An update is cancelled before persistence."],
        inputs: [`Boundary ${index}`],
        steps: ["Start the update.", "Cancel the update."],
      },
      impact: {
        description: options.impact ?? "Cancelled work overwrites the previously saved settings.",
        affectedParties: ["Settings users"],
      },
      rootCause: {
        status: "established",
        explanation: "The persistence boundary does not inspect cancellation.",
        evidenceRefs: [evidenceId],
      },
      subjectRef: task.subjectRef,
      locations: [
        {
          kind: "source",
          subjectRef: task.subjectRef,
          path: "src/cancellation.ts",
          startLine: index + 1,
          endLine: index + 1,
        },
      ],
      evidenceRefs: [evidenceId],
      confirmation: {
        status: "confirmed",
        rationale: "The final finding version was rechecked against the frozen source.",
        evidenceRefs: [evidenceId],
        recheckRef: recheckId,
      },
      fixRecommendation: {
        summary: "Check cancellation before persistence.",
        constraints: ["Preserve existing values on cancellation."],
        planRef: null,
      },
      feedbackDraft,
    });
    analysis.candidates.push({
      id: `candidate:${index}`,
      subjectRef: task.subjectRef,
      title: `Cancellation boundary ${index}`,
      discoveredRound: 1,
      status: "confirmed",
      findingId,
      findingVersion: 1,
      mergedIntoCandidateId: null,
      rationale: "Retain the confirmed source defect after the final recheck.",
      evidenceRefs: [evidenceId],
    });
    analysis.rechecks.push({
      id: recheckId,
      findingId,
      findingVersion: 1,
      subjectRef: task.subjectRef,
      round: 2,
      evidenceRefs: [evidenceId],
      conclusion: "The current finding remains supported by the frozen source.",
      unresolvedQuestions: [],
    });
    analysis.evidence.push({
      id: evidenceId,
      subjectRef: task.subjectRef,
      source: "static_analysis",
      summary: `The synthetic source at boundary ${index} has no cancellation guard.`,
      evidenceRefs: [],
    });
    analysis.feedbackDrafts.push(feedbackDraft);
  }
  analysis.coverage.includedUnits[0]!.evidenceRefs = analysis.evidence.map((entry) => entry.id);
  analysis.assessment.evidenceRefs = analysis.evidence.map((entry) => entry.id);
  return {
    task,
    attempt,
    checkpoint: seal({
      ...checkpoint,
      version: 4,
      round: 3,
      analysis,
      lastPhase: "finalize",
      stopReason: "complete",
      consumed: {
        rounds: 3,
        durationMs: 3_000,
        tokens: 2_000,
        reportBytes: Buffer.byteLength(JSON.stringify(analysis)),
      },
    }),
    reportId,
    outcome: "completed" as const,
  };
}

function collectionItems<C extends InvestigationReportCollection>(
  parts: readonly InvestigationReportPartV1[],
  collection: C,
) {
  return parts.flatMap((part) => (part.collection === collection ? (part.items as unknown[]) : []));
}

function derivedPatchFixture(allowExecution = true) {
  const input = fixture({ allowExecution });
  const patch: Extract<InvestigationSubjectV1, { kind: "local_patch" }> = {
    id: "subject:patch",
    kind: "local_patch",
    repositoryId: input.task.repository.id,
    workItemId: input.task.workItem.id,
    revisionKey: "4".repeat(64),
    baseSubjectRef: input.task.subjectRef,
    baseSha: "c".repeat(40),
    patchDigest: "5".repeat(64),
    artifactRef: "artifact:patch",
  };
  input.checkpoint.runtime.subjects = [patch];
  input.checkpoint.runtime.artifacts = [
    {
      id: patch.artifactRef,
      taskId: input.task.id,
      attemptId: input.attempt.id,
      subjectRef: patch.id,
      kind: "patch",
      name: "synthetic.patch",
      mediaType: "text/x-diff",
      digest: patch.patchDigest,
      byteLength: 128,
      availability: "available",
    },
    {
      id: "artifact:patch-execution",
      taskId: input.task.id,
      attemptId: input.attempt.id,
      subjectRef: patch.id,
      kind: "log",
      name: "synthetic-patch-execution.log",
      mediaType: "text/plain",
      digest: "6".repeat(64),
      byteLength: 256,
      availability: "available",
    },
  ];
  input.checkpoint.runtime.evidence = [
    {
      id: "evidence:patch-execution",
      subjectRef: patch.id,
      source: "executor_observation",
      authority: "worker",
      summary: "The isolated mock executor observed the saved local patch.",
      artifactRefs: ["artifact:patch-execution"],
      evidenceRefs: [],
      provenance: {
        taskId: input.task.id,
        attemptId: input.attempt.id,
        producer: "mock-patch-executor",
        recordedAt,
      },
    },
  ];
  input.checkpoint.runtime.checks = [
    {
      id: "check:patch",
      scenarioId: "scenario:patch",
      subjectRef: patch.id,
      planRef: null,
      required: true,
      description: "Verify the saved local patch preserves cancellation semantics.",
      status: "passed",
      executor: "mock-patch-executor",
      evidenceRefs: ["evidence:patch-execution"],
      authoritativeAttemptId: input.attempt.id,
    },
  ];
  input.checkpoint = seal(input.checkpoint);
  return { input, patch };
}

function parentPlanFixture() {
  const input = fixture({ allowExecution: true });
  const draft: InvestigationPlanDraft = {
    id: "plan:parent-verification",
    version: 2,
    kind: "verification",
    subjectRef: input.task.subjectRef,
    title: "Verify the original cancellation change",
    rationale: "The parent report saved the required follow-up experiment.",
    prerequisites: [],
    steps: [
      {
        id: "step:parent-verification",
        description: "Cancel a pending settings update.",
        expectedObservation: "Saved settings remain unchanged.",
        checkIds: [],
      },
    ],
    acceptanceCriteria: ["Cancelling an update preserves the previous saved settings."],
  };
  const parentPlan: InvestigationPlanV1 = {
    ...draft,
    digest: investigationContentDigest(draft),
    state: "saved",
    sourceReportRef: { id: "report:parent", version: 3 },
  };
  input.task.kind = "pr-verify";
  input.task.parentTaskId = "task:parent";
  input.task.parentReportRef = { ...parentPlan.sourceReportRef, digest: "7".repeat(64) };
  input.task.planRef = {
    id: parentPlan.id,
    version: parentPlan.version,
    digest: parentPlan.digest,
  };
  input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
  input.checkpoint.analysis.findings[0]!.fixRecommendation.planRef = { ...input.task.planRef };
  input.checkpoint = seal(input.checkpoint);
  return { input, parentPlan, draft };
}

function inheritedPatchReportFixture(selectedPatch = false, producingTaskId = "task:parent") {
  const { input, parentPlan } = parentPlanFixture();
  const patch: Extract<InvestigationSubjectV1, { kind: "local_patch" }> = {
    id: "subject:inherited-patch",
    kind: "local_patch",
    repositoryId: input.task.repository.id,
    workItemId: input.task.workItem.id,
    revisionKey: "4".repeat(64),
    baseSubjectRef: input.task.subjectRef,
    baseSha: "c".repeat(40),
    patchDigest: "5".repeat(64),
    artifactRef: "artifact:inherited-patch",
  };
  const artifact: InvestigationArtifactV1 = {
    id: patch.artifactRef,
    taskId: producingTaskId,
    attemptId: `${producingTaskId}:attempt`,
    subjectRef: patch.id,
    kind: "patch",
    name: "inherited.patch",
    mediaType: "text/x-diff",
    digest: patch.patchDigest,
    byteLength: 128,
    availability: "available",
  };
  input.task.subjects.push(patch);
  input.task.sourceArtifacts = [structuredClone(artifact)];
  if (selectedPatch) {
    input.task.subjectRef = patch.id;
    input.task.executionPolicy.allowedSubjectRefs.push(patch.id);
    input.checkpoint.subjectRevisionKey = patch.revisionKey;
    input.checkpoint.analysis.assessment.subjectRef = patch.id;
    input.checkpoint.analysis.assessment.evidenceRefs = [];
    input.checkpoint.analysis.findings[0]!.fixRecommendation.planRef = null;
    parentPlan.subjectRef = patch.id;
    const {
      digest: _digest,
      state: _state,
      sourceReportRef: _sourceReportRef,
      ...draft
    } = parentPlan;
    parentPlan.digest = investigationContentDigest(draft);
    input.task.planRef = {
      id: parentPlan.id,
      version: parentPlan.version,
      digest: parentPlan.digest,
    };
  }
  input.checkpoint.runtime.artifacts = [
    {
      id: "artifact:current-log",
      taskId: input.task.id,
      attemptId: input.attempt.id,
      subjectRef: input.task.subjectRef,
      kind: "log",
      name: "current-attempt.log",
      mediaType: "text/plain",
      digest: "6".repeat(64),
      byteLength: 64,
      availability: "available",
    },
  ];
  input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
  input.checkpoint = seal(input.checkpoint);
  return { input, parentPlan, patch, artifact };
}

function selectedIssueSourceFixture(
  kind: "issue-verify" | "reproduction-setup" | "issue-fix" | "feature-implement",
) {
  const original = parentPlanFixture();
  const { input } = original;
  const snapshot: Extract<InvestigationSubjectV1, { kind: "issue_snapshot" }> = {
    id: "subject:parent-issue",
    kind: "issue_snapshot",
    repositoryId: input.task.repository.id,
    workItemId: input.task.workItem.id,
    revisionKey: "8".repeat(64),
    snapshotDigest: "9".repeat(64),
  };
  const draft: InvestigationPlanDraft = {
    ...original.draft,
    subjectRef: snapshot.id,
    kind:
      kind === "issue-verify"
        ? "verification"
        : kind === "reproduction-setup"
          ? "reproduction"
          : kind === "issue-fix"
            ? "fix"
            : "implementation",
  };
  const parentPlan: InvestigationPlanV1 = {
    ...draft,
    digest: investigationContentDigest(draft),
    state: "saved",
    sourceReportRef: { ...original.parentPlan.sourceReportRef },
  };
  input.task.kind = kind;
  input.task.workItem.kind = "issue";
  input.task.subjects = [
    {
      id: input.task.subjectRef,
      kind: "source_commit",
      repositoryId: input.task.repository.id,
      workItemId: input.task.workItem.id,
      revisionKey: "a".repeat(64),
      commitSha: "c".repeat(40),
    },
    snapshot,
  ];
  input.task.planRef = {
    id: parentPlan.id,
    version: parentPlan.version,
    digest: parentPlan.digest,
  };
  input.checkpoint.analysis.findings[0]!.fixRecommendation.planRef = { ...input.task.planRef };
  input.checkpoint.analysis.assessment = {
    kind: "other_issue",
    subjectRef: input.task.subjectRef,
    summary: "The selected immutable source was investigated.",
    evidenceRefs: input.checkpoint.analysis.evidence.map((entry) => entry.id),
    classification: "verification",
    explanation:
      "The saved parent plan retains its original issue snapshot while this task identifies the selected source commit.",
  };
  input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
  input.checkpoint = seal(input.checkpoint);
  return { input, parentPlan, snapshot };
}

function expectBuildError(
  action: () => unknown,
  code: InvestigationReportBuildError["code"],
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvestigationReportBuildError);
  expect(caught).toMatchObject({ code });
}

beforeAll(() => registerWorkerContractFormats());

describe("investigation report builder", () => {
  it("assembles valid worker protocols from schema-valid frozen inputs", () => {
    const input = fixture();
    expect(Value.Check(InvestigationTaskV1Schema, input.task)).toBe(true);
    expect(Value.Check(InvestigationAttemptV1Schema, input.attempt)).toBe(true);
    expect(Value.Check(InvestigationLoopCheckpointV1Schema, input.checkpoint)).toBe(true);

    const submission = buildInvestigationReportSubmission(input);
    expect(Value.Check(InvestigationReportHeaderV1Schema, submission.header)).toBe(true);
    expect(Value.Check(InvestigationReportManifestV1Schema, submission.manifest)).toBe(true);
    for (const part of submission.parts)
      expect(Value.Check(InvestigationReportPartV1Schema, part)).toBe(true);
    expect(submission.header.report.completeness).toBe("complete");
    expect(submission.header.report.delivery).toBe("final");
    expect(submission.header.context.task.id).toBe(input.task.id);
    expect(submission.header.context.attempt.id).toBe(input.attempt.id);
  });

  it("preserves more than 100 findings and more than 2 MiB without truncation", () => {
    const input = fixture({ findingCount: 125, impact: "\u{1f6a6}".repeat(5_000) });
    const maximumPartBytes = 96 * 1024;
    const submission = buildInvestigationReportSubmission({
      ...input,
      maximumPartBytes,
      maximumPartItems: 17,
    });

    expect(collectionItems(submission.parts, "findings")).toEqual(
      input.checkpoint.analysis.findings,
    );
    expect(collectionItems(submission.parts, "candidates")).toEqual(
      input.checkpoint.analysis.candidates,
    );
    expect(collectionItems(submission.parts, "rechecks")).toEqual(
      input.checkpoint.analysis.rechecks,
    );
    expect(submission.header.report.collections).toMatchObject({
      findings: 125,
      candidates: 125,
      rechecks: 125,
    });
    expect(
      submission.parts.reduce((total, part) => total + Buffer.byteLength(JSON.stringify(part)), 0),
    ).toBeGreaterThan(2 * 1024 * 1024);
    for (const part of submission.parts) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(maximumPartBytes);
      expect(part.items.length).toBeLessThanOrEqual(17);
      expect(part.itemCount).toBe(part.items.length);
    }
  });

  it("applies item limits independently of byte limits and seals every part in order", () => {
    const input = fixture({ findingCount: 7 });
    const submission = buildInvestigationReportSubmission({
      ...input,
      maximumPartBytes: 64 * 1024,
      maximumPartItems: 2,
    });
    const findingParts = submission.parts.filter((part) => part.collection === "findings");
    expect(findingParts.map((part) => part.itemCount)).toEqual([2, 2, 2, 1]);
    for (const [index, part] of submission.parts.entries()) {
      const { digest, ...content } = part;
      expect(part.sequence).toBe(index);
      expect(part.previousPartDigest).toBe(
        index === 0 ? null : submission.parts[index - 1]!.digest,
      );
      expect(digest).toBe(investigationContentDigest(content));
      expect(part.items.length).toBeLessThanOrEqual(2);
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(64 * 1024);
      expect(submission.manifest.parts[index]).toEqual({
        id: part.id,
        collection: part.collection,
        sequence: index,
        itemCount: part.itemCount,
        digest,
      });
    }
    expect(submission.manifest.parts).toHaveLength(submission.parts.length);
    expect(submission.manifest.collections).toEqual(submission.header.report.collections);
    expect(submission.manifest.logicalContentDigest).toBe(
      submission.header.report.logicalContentDigest,
    );
  });

  it("keeps the logical content digest independent of transport partitioning", () => {
    const input = fixture({ findingCount: 7 });
    const small = buildInvestigationReportSubmission({ ...input, maximumPartItems: 2 });
    const large = buildInvestigationReportSubmission({ ...input, maximumPartItems: 100 });
    expect(small.parts.length).toBeGreaterThan(large.parts.length);
    expect(small.manifest.logicalContentDigest).toBe(large.manifest.logicalContentDigest);

    input.checkpoint.analysis.findings[0]!.impact.description =
      "Cancellation loses a newly observed setting value.";
    input.checkpoint = seal(input.checkpoint);
    expect(buildInvestigationReportSubmission(input).manifest.logicalContentDigest).not.toBe(
      large.manifest.logicalContentDigest,
    );
  });

  it("rejects an oversized indivisible item with a typed error", () => {
    const input = fixture({ findingCount: 1, impact: "x".repeat(5_000) });
    expectBuildError(
      () => buildInvestigationReportSubmission({ ...input, maximumPartBytes: 1_024 }),
      "REPORT_ITEM_TOO_LARGE",
    );
  });

  it("rejects completed reports that exceed the frozen report budget", () => {
    const input = fixture({ maximumReportBytes: 1 });
    expectBuildError(() => buildInvestigationReportSubmission(input), "REPORT_BUDGET_EXCEEDED");
  });

  it("allows a completed checkpoint at its report budget despite transport metadata overhead", () => {
    const logicalBytes = fixture().checkpoint.consumed.reportBytes;
    const input = fixture({ maximumReportBytes: logicalBytes });
    expect(input.checkpoint.consumed.reportBytes).toBe(input.task.budget.maxReportBytes);

    const submission = buildInvestigationReportSubmission({ ...input, maximumPartItems: 1 });
    expect(submission.header.report.completeness).toBe("complete");
    expect(
      submission.parts.reduce((total, part) => total + Buffer.byteLength(JSON.stringify(part)), 0),
    ).toBeGreaterThan(input.task.budget.maxReportBytes);
    expect(collectionItems(submission.parts, "findings")).toEqual(
      input.checkpoint.analysis.findings,
    );
  });

  it("preserves every recorded item in an interrupted report even when the byte budget is exhausted", () => {
    const input = fixture({ findingCount: 125, maximumReportBytes: 1 });
    input.checkpoint = seal({ ...input.checkpoint, stopReason: "budget_exhausted" });
    const submission = buildInvestigationReportSubmission({ ...input, outcome: "interrupted" });

    expect(submission.header.outcome).toBe("interrupted");
    expect(submission.header.report.completeness).toBe("partial");
    expect(submission.header.report.loop.stopReason).toBe("budget_exhausted");
    expect(collectionItems(submission.parts, "findings")).toEqual(
      input.checkpoint.analysis.findings,
    );
    expect(collectionItems(submission.parts, "candidates")).toEqual(
      input.checkpoint.analysis.candidates,
    );
    expect(collectionItems(submission.parts, "rechecks")).toEqual(
      input.checkpoint.analysis.rechecks,
    );
    expect(
      submission.parts.reduce((total, part) => total + Buffer.byteLength(JSON.stringify(part)), 0),
    ).toBeGreaterThan(input.task.budget.maxReportBytes);
  });

  it("preserves unfinished scope, candidate dispositions, and historical rechecks in a partial report", () => {
    const input = fixture();
    const analysis = input.checkpoint.analysis;
    analysis.coverage.includedUnits[0]!.status = "pending";
    analysis.coverage.completedUnitRefs = [];
    analysis.coverage.unresolvedUnitRefs = ["unit:synthetic"];
    analysis.findings[0]!.version = 2;
    analysis.candidates[0]!.findingVersion = 2;
    analysis.candidates.push({
      id: "candidate:pending",
      subjectRef: input.task.subjectRef,
      title: "An additional persistence boundary",
      discoveredRound: 3,
      status: "pending",
      findingId: null,
      findingVersion: null,
      mergedIntoCandidateId: null,
      rationale: "The interruption occurred before investigation of this candidate.",
      evidenceRefs: [],
    });
    input.checkpoint = seal({
      ...input.checkpoint,
      lastPhase: "investigation",
      stopReason: "interrupted",
    });

    const submission = buildInvestigationReportSubmission({ ...input, outcome: "interrupted" });
    expect(submission.header.report.completeness).toBe("partial");
    expect(submission.header.report.coverage).toMatchObject({
      includedUnitCount: 1,
      completedUnitCount: 0,
      unresolvedUnitCount: 1,
      exclusionCount: 1,
    });
    expect(submission.header.report.recheck).toEqual({
      finalFindingCount: 3,
      validFinalVersionRecheckCount: 2,
      pendingFindingCount: 1,
    });
    expect(collectionItems(submission.parts, "coverageUnits")).toEqual(
      analysis.coverage.includedUnits,
    );
    expect(collectionItems(submission.parts, "coverageExclusions")).toEqual(
      analysis.coverage.exclusions,
    );
    expect(collectionItems(submission.parts, "candidates")).toEqual(analysis.candidates);
    expect(collectionItems(submission.parts, "rechecks")).toEqual(analysis.rechecks);
    expect(collectionItems(submission.parts, "findings")).toEqual(analysis.findings);
  });

  it.each(["coverage", "candidate", "recheck", "finalize", "stop-reason"] as const)(
    "does not trust a completed outcome when the %s completion gate is unsatisfied",
    (gate) => {
      const input = fixture();
      if (gate === "coverage") {
        input.checkpoint.analysis.coverage.includedUnits[0]!.status = "pending";
        input.checkpoint.analysis.coverage.completedUnitRefs = [];
        input.checkpoint.analysis.coverage.unresolvedUnitRefs = ["unit:synthetic"];
      } else if (gate === "candidate") input.checkpoint.analysis.candidates[0]!.status = "pending";
      else if (gate === "recheck") input.checkpoint.analysis.rechecks.shift();
      else if (gate === "finalize") input.checkpoint.lastPhase = "investigation";
      else input.checkpoint.stopReason = "continuing";
      input.checkpoint = seal(input.checkpoint);
      expectBuildError(() => buildInvestigationReportSubmission(input), "COMPLETION_NOT_READY");
    },
  );

  it.each([
    { outcome: "completed" },
    { verificationEvidence: [] },
    { validation: { checks: [], summary: "Forged runtime success." } },
    { runtime: { checks: [], evidence: [], artifacts: [], completedStepIds: [] } },
  ])("rejects model-supplied authority fields: %j", (injected) => {
    const input = fixture();
    Object.assign(input.checkpoint.analysis, injected);
    input.checkpoint = seal(input.checkpoint);
    expectBuildError(() => buildInvestigationReportSubmission(input), "INVALID_INPUT");
  });

  it("rejects worker authority smuggled into model analysis evidence", () => {
    const input = fixture();
    Object.assign(input.checkpoint.analysis.evidence[0]!, {
      authority: "worker",
      source: "executor_observation",
    });
    input.checkpoint = seal(input.checkpoint);
    expectBuildError(() => buildInvestigationReportSubmission(input), "INVALID_INPUT");
  });

  it("rejects tampered checkpoint content and a changed frozen task binding", () => {
    const tampered = fixture();
    tampered.checkpoint.analysis.summary = "Unsealed replacement summary.";
    expectBuildError(() => buildInvestigationReportSubmission(tampered), "INVALID_INPUT");

    const changedTask = fixture();
    changedTask.task.budget.maxTokens += 1;
    expectBuildError(() => buildInvestigationReportSubmission(changedTask), "INVALID_INPUT");
  });

  it("seals draft plans and actions with canonical digests and the submitted report reference", () => {
    const input = fixture();
    const draft: InvestigationPlanDraft = {
      id: "plan:verification",
      version: 2,
      kind: "verification",
      subjectRef: input.task.subjectRef,
      title: "Verify cancellation preserves values",
      rationale: "Source analysis requires a follow-up runtime observation.",
      prerequisites: [
        {
          id: "prerequisite:environment",
          kind: "environment",
          description: "Provide an authorized isolated executor.",
        },
      ],
      steps: [
        {
          id: "step:verify",
          description: "Cancel a pending settings update.",
          expectedObservation: "The previous settings remain saved.",
          checkIds: [],
        },
      ],
      acceptanceCriteria: ["Cancellation preserves the previous saved values."],
    };
    const planRef = {
      id: draft.id,
      version: draft.version,
      digest: investigationContentDigest(draft),
    };
    const action = {
      id: "action:verification",
      action: "reviews.verify" as const,
      taskKind: "pr-verify" as const,
      label: "Verify cancellation",
      reason: "Capture runtime evidence for the retained source findings.",
      recommended: true,
      subjectRef: input.task.subjectRef,
      planRef,
      draftRef: null,
      validationReportRef: null,
      prerequisiteRefs: ["prerequisite:environment"],
    };
    input.checkpoint.analysis.plans = [draft];
    input.checkpoint.analysis.nextActions = [action];
    input.checkpoint.analysis.findings[0]!.fixRecommendation.planRef = planRef;
    if (input.checkpoint.analysis.assessment.kind !== "pr") throw new Error("Expected PR fixture.");
    input.checkpoint.analysis.assessment.e2eAssessment.planRef = planRef;
    input.checkpoint = seal(input.checkpoint);
    const submission = buildInvestigationReportSubmission({
      ...input,
      reportId: "report:revised",
      reportVersion: 7,
    });
    const sourceReportRef = { id: "report:revised", version: 7 };

    expect(collectionItems(submission.parts, "plans")).toEqual([
      { ...draft, ...planRef, state: "saved", sourceReportRef },
    ]);
    expect(collectionItems(submission.parts, "nextActions")).toEqual([
      { ...action, state: "saved", sourceReportRef },
    ]);
    expect(submission.header.report.collections).toMatchObject({ plans: 1, nextActions: 1 });

    input.checkpoint.analysis.plans = [
      Object.fromEntries(Object.entries(draft).reverse()) as InvestigationPlanDraft,
    ];
    input.checkpoint = seal(input.checkpoint);
    const reordered = buildInvestigationReportSubmission({
      ...input,
      reportId: "report:revised",
      reportVersion: 7,
    });
    expect(collectionItems(reordered.parts, "plans")).toEqual(
      collectionItems(submission.parts, "plans"),
    );
    expect(reordered.manifest.logicalContentDigest).toBe(submission.manifest.logicalContentDigest);
  });

  it("delivers complete findings while retaining invalid action proposals outside the executable action list", () => {
    const input = fixture();
    const proposal = {
      id: "action:invalid-verification",
      action: "start-task" as const,
      taskKind: "issue-verify" as const,
      label: "Verify the retained findings",
      reason: "The source findings need a separate saved verification plan.",
      recommended: true,
      subjectRef: input.task.subjectRef,
      planRef: null,
      draftRef: null,
      validationReportRef: null,
      prerequisiteRefs: [],
    };
    input.checkpoint.analysis.nextActions = [proposal];
    input.checkpoint = seal(input.checkpoint);
    const original = structuredClone(input.checkpoint);
    const submission = buildInvestigationReportSubmission(input);
    expect(submission.header.outcome).toBe("completed");
    expect(submission.header.report.collections.nextActions).toBe(0);
    expect(collectionItems(submission.parts, "findings")).toEqual(original.analysis.findings);
    expect(collectionItems(submission.parts, "nextActions")).toEqual([]);
    const diagnostics = submission.parts.flatMap((part) =>
      part.collection === "diagnostics" ? part.items : [],
    );
    expect(diagnostics).toHaveLength(1);
    expect(JSON.parse(diagnostics[0]!.message)).toMatchObject({
      proposal,
      reasonCodes: ["missing_saved_plan", "bug_verification_not_supported_by_assessment"],
    });
    expect(input.checkpoint).toEqual(original);
    expect(input.checkpoint.digest).toBe(original.digest);
  });

  it("keeps duplicate terminal diagnostics identical to checkpoint diagnostics and rejects uncheckpointed additions", () => {
    const input = fixture();
    const diagnostic = {
      id: "diagnostic:accepted",
      code: "ACCEPTED_LIMITATION",
      category: "limitation" as const,
      message: "A terminal limitation already accepted in this checkpoint.",
      retryable: false,
      evidenceRefs: [],
      prerequisiteRefs: [],
    };
    input.checkpoint.analysis.diagnostics = [diagnostic];
    input.checkpoint = seal(input.checkpoint);
    const ordinary = buildInvestigationReportSubmission(input);
    expect(
      buildInvestigationReportSubmission({ ...input, diagnostics: [structuredClone(diagnostic)] }),
    ).toEqual(ordinary);
    expectBuildError(
      () =>
        buildInvestigationReportSubmission({
          ...input,
          diagnostics: [{ ...diagnostic, id: "diagnostic:uncheckpointed" }],
        }),
      "INVALID_INPUT",
    );
    expectBuildError(
      () =>
        buildInvestigationReportSubmission({
          ...input,
          diagnostics: [{ ...diagnostic, message: "Changed accepted content" }],
        }),
      "INVALID_INPUT",
    );
  });

  it("normalizes only report display ordinals and preserves original finding versions and the accepted checkpoint", () => {
    const input = fixture();
    input.checkpoint.analysis.findings.forEach((finding, index) => {
      finding.ordinal = [10, 10, 1][index]!;
    });
    input.checkpoint = seal(input.checkpoint);
    const original = structuredClone(input.checkpoint);
    const submission = buildInvestigationReportSubmission(input);
    expect(collectionItems(submission.parts, "findings")).toEqual(
      original.analysis.findings.map((finding, ordinal) => ({ ...finding, ordinal })),
    );
    expect(collectionItems(submission.parts, "rechecks")).toEqual(original.analysis.rechecks);
    const diagnostics = submission.parts.flatMap((part) =>
      part.collection === "diagnostics" ? part.items : [],
    );
    expect(diagnostics).toHaveLength(3);
    expect(
      diagnostics.every((diagnostic) => diagnostic.code === "FINDING_ORDINAL_NORMALIZED"),
    ).toBe(true);
    expect(input.checkpoint).toEqual(original);
    expect(submission.header.outcome).toBe("completed");
  });

  it("does not truncate a rejected proposal that cannot fit inside a transport part", () => {
    const input = fixture();
    input.checkpoint.analysis.nextActions = [
      {
        id: "action:oversized-rejected",
        action: "start-task",
        taskKind: "pr-verify",
        label: "Keep the complete proposal",
        reason: 'Quoted \\"data\\" '.repeat(20_000),
        recommended: true,
        subjectRef: input.task.subjectRef,
        planRef: null,
        draftRef: null,
        validationReportRef: null,
        prerequisiteRefs: [],
      },
    ];
    input.checkpoint = seal(input.checkpoint);
    const original = structuredClone(input.checkpoint);
    expectBuildError(() => buildInvestigationReportSubmission(input), "REPORT_ITEM_TOO_LARGE");
    expect(input.checkpoint).toEqual(original);
  });

  it("keeps trusted checkpoint receipts separate from model evidence", () => {
    const input = fixture({ allowExecution: true });
    const observed: InvestigationEvidenceV1 = {
      id: "evidence:runtime",
      subjectRef: input.task.subjectRef,
      source: "executor_observation",
      authority: "worker",
      summary: "The isolated mock executor observed unchanged saved settings.",
      artifactRefs: ["artifact:runtime"],
      evidenceRefs: [],
      provenance: {
        taskId: input.task.id,
        attemptId: input.attempt.id,
        producer: "mock-executor",
        recordedAt,
      },
    };
    input.checkpoint.runtime = {
      ...input.checkpoint.runtime,
      completedStepIds: ["step:runtime"],
      evidence: [observed],
      artifacts: [
        {
          id: "artifact:runtime",
          taskId: input.task.id,
          attemptId: input.attempt.id,
          subjectRef: input.task.subjectRef,
          kind: "log",
          name: "synthetic-executor.log",
          mediaType: "text/plain",
          digest: "1".repeat(64),
          byteLength: 64,
          availability: "available",
        },
      ],
      checks: [
        {
          id: "check:runtime",
          scenarioId: "scenario:runtime",
          subjectRef: input.task.subjectRef,
          planRef: null,
          required: true,
          description: "Verify cancelled updates preserve saved values.",
          status: "passed",
          executor: "mock-executor",
          evidenceRefs: [observed.id],
          authoritativeAttemptId: input.attempt.id,
        },
      ],
    };
    input.checkpoint = seal(input.checkpoint);

    const submission = buildInvestigationReportSubmission(input);
    const evidence = collectionItems(
      submission.parts,
      "verificationEvidence",
    ) as InvestigationEvidenceV1[];
    expect(evidence.find((entry) => entry.id === observed.id)).toEqual(observed);
    expect(evidence.filter((entry) => entry.id !== observed.id)).toHaveLength(
      input.checkpoint.analysis.evidence.length,
    );
    expect(
      evidence
        .filter((entry) => entry.id !== observed.id)
        .every((entry) => entry.authority === "model"),
    ).toBe(true);
    expect(collectionItems(submission.parts, "artifacts")).toEqual(
      input.checkpoint.runtime.artifacts,
    );
    expect(collectionItems(submission.parts, "validationChecks")).toEqual(
      input.checkpoint.runtime.checks,
    );
  });

  it.each(["authority", "source", "subject", "attempt"] as const)(
    "rejects untrusted runtime evidence with an invalid %s binding",
    (field) => {
      const input = fixture();
      const evidence: InvestigationEvidenceV1 = {
        id: "evidence:runtime",
        subjectRef: input.task.subjectRef,
        source: "executor_observation",
        authority: "worker",
        summary: "An isolated executor observation.",
        artifactRefs: [],
        evidenceRefs: [],
        provenance: {
          taskId: input.task.id,
          attemptId: input.attempt.id,
          producer: "mock-executor",
          recordedAt,
        },
      };
      if (field === "authority") evidence.authority = "model";
      else if (field === "source") evidence.source = "static_analysis";
      else if (field === "subject") evidence.subjectRef = "subject:unrecognized";
      else evidence.provenance.attemptId = "attempt:unadopted";
      input.checkpoint.runtime.evidence = [evidence];
      input.checkpoint = seal(input.checkpoint);
      expectBuildError(() => buildInvestigationReportSubmission(input), "INVALID_RUNTIME_EVIDENCE");
    },
  );

  it.each(["self", "unknown", "cross-subject"] as const)(
    "rejects runtime evidence with a %s evidence reference",
    (referenceKind) => {
      const input = fixture();
      const evidence: InvestigationEvidenceV1 = {
        id: "evidence:runtime",
        subjectRef: input.task.subjectRef,
        source: "source_snapshot",
        authority: "worker",
        summary: "An isolated frozen source snapshot.",
        artifactRefs: [],
        evidenceRefs: [],
        provenance: {
          taskId: input.task.id,
          attemptId: input.attempt.id,
          producer: "mock-snapshotter",
          recordedAt,
        },
      };
      input.checkpoint.runtime.evidence = [evidence];
      if (referenceKind === "self") evidence.evidenceRefs = [evidence.id];
      else if (referenceKind === "unknown") evidence.evidenceRefs = ["evidence:missing"];
      else {
        const subjectRef = "subject:second";
        input.task.subjects.push({
          id: subjectRef,
          kind: "source_commit",
          repositoryId: input.task.repository.id,
          workItemId: input.task.workItem.id,
          revisionKey: "2".repeat(64),
          commitSha: "3".repeat(40),
        });
        input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
        const target = { ...evidence, id: "evidence:second-subject", subjectRef, evidenceRefs: [] };
        input.checkpoint.runtime.evidence.push(target);
        evidence.evidenceRefs = [target.id];
      }
      input.checkpoint = seal(input.checkpoint);

      expectBuildError(() => buildInvestigationReportSubmission(input), "INVALID_RUNTIME_EVIDENCE");
    },
  );

  it.each(["passed", "failed"] as const)(
    "accepts a %s receipt for a saved patch derived from an authorized immutable base",
    (status) => {
      const { input, patch } = derivedPatchFixture();
      input.checkpoint.runtime.checks[0]!.status = status;
      input.checkpoint = seal(input.checkpoint);

      const submission = buildInvestigationReportSubmission(input);
      expect(submission.header.context.subjects).toEqual([...input.task.subjects, patch]);
      expect(submission.header.context.task.subjectRef).toBe(input.task.subjectRef);
      expect(collectionItems(submission.parts, "validationChecks")).toEqual(
        input.checkpoint.runtime.checks,
      );
      expect(collectionItems(submission.parts, "artifacts")).toEqual(
        input.checkpoint.runtime.artifacts,
      );
      expect(collectionItems(submission.parts, "findings")).toEqual(
        input.checkpoint.analysis.findings,
      );
    },
  );

  it.each([
    "unauthorized-base",
    "base-sha",
    "patch-digest",
    "missing-patch-artifact",
    "unavailable-patch-artifact",
    "non-patch-artifact",
    "read-only",
  ] as const)("rejects derived patch validation with an invalid %s binding", (binding) => {
    const { input, patch } = derivedPatchFixture(binding !== "read-only");
    if (binding === "unauthorized-base") {
      const baseId = "subject:unauthorized-base";
      input.task.subjects.push({
        id: baseId,
        kind: "source_commit",
        repositoryId: input.task.repository.id,
        workItemId: input.task.workItem.id,
        revisionKey: "7".repeat(64),
        commitSha: patch.baseSha,
      });
      patch.baseSubjectRef = baseId;
      input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
    } else if (binding === "base-sha") patch.baseSha = "8".repeat(40);
    else if (binding === "patch-digest") patch.patchDigest = "9".repeat(64);
    else if (binding === "missing-patch-artifact") {
      input.checkpoint.runtime.artifacts = input.checkpoint.runtime.artifacts.filter(
        (artifact) => artifact.id !== patch.artifactRef,
      );
    } else if (binding === "unavailable-patch-artifact") {
      input.checkpoint.runtime.artifacts.find(
        (artifact) => artifact.id === patch.artifactRef,
      )!.availability = "expired";
    } else if (binding === "non-patch-artifact") {
      input.checkpoint.runtime.artifacts.find(
        (artifact) => artifact.id === patch.artifactRef,
      )!.kind = "log";
    }
    input.checkpoint = seal(input.checkpoint);

    expectBuildError(() => buildInvestigationReportSubmission(input), "INVALID_RUNTIME_VALIDATION");
  });

  it("rejects a derived runtime subject that exists only in model analysis", () => {
    const { input, patch } = derivedPatchFixture();
    input.checkpoint.runtime.subjects = [];
    input.checkpoint.analysis.evidence.push({
      id: "evidence:model-patch",
      subjectRef: patch.id,
      source: "static_analysis",
      summary: "The model claims that a local patch subject exists.",
      evidenceRefs: [],
    });
    input.checkpoint = seal(input.checkpoint);

    expectBuildError(() => buildInvestigationReportSubmission(input), "INVALID_RUNTIME_EVIDENCE");
  });

  it("preserves the saved parent plan digest and original source report reference", () => {
    const { input, parentPlan } = parentPlanFixture();
    const submission = buildInvestigationReportSubmission({ ...input, parentPlan });

    expect(collectionItems(submission.parts, "plans")).toEqual([parentPlan]);
    expect(submission.header.report.collections.plans).toBe(1);
    expect(submission.header.context.parentReportRef).toEqual(input.task.parentReportRef);
    expect(parentPlan.sourceReportRef.id).not.toBe(submission.header.id);
    expect(collectionItems(submission.parts, "findings")).toEqual(
      input.checkpoint.analysis.findings,
    );
  });

  it.each([
    { selection: "original source", selectedPatch: false, producingTaskId: "task:parent" },
    { selection: "local patch", selectedPatch: true, producingTaskId: "task:parent" },
    { selection: "nested local patch", selectedPatch: true, producingTaskId: "task:grandparent" },
  ])(
    "preserves frozen patch lineage when reporting on $selection",
    ({ selectedPatch, producingTaskId }) => {
      const { input, parentPlan, patch, artifact } = inheritedPatchReportFixture(
        selectedPatch,
        producingTaskId,
      );
      const submission = buildInvestigationReportSubmission({ ...input, parentPlan });

      expect(submission.header.context.subjects).toEqual(input.task.subjects);
      expect(submission.header.context.sourceArtifacts).toEqual([artifact]);
      expect(submission.header.context.parentReportRef).toEqual(input.task.parentReportRef);
      expect(submission.header.context.task.subjectRef === patch.id).toBe(selectedPatch);
      expect(submission.header.context.adoptedAttemptIds).not.toContain(artifact.attemptId);
      expect(collectionItems(submission.parts, "artifacts")).toEqual(
        input.checkpoint.runtime.artifacts,
      );
      expect(submission.header.report.collections.artifacts).toBe(1);
      expect(collectionItems(submission.parts, "artifacts")).not.toContainEqual(artifact);
      expect(collectionItems(submission.parts, "plans")).toEqual([parentPlan]);
      expect(input.task.sourceArtifacts).toEqual([artifact]);
    },
  );

  it("rejects changing frozen inherited artifact metadata after the checkpoint was sealed", () => {
    const { input, parentPlan } = inheritedPatchReportFixture();
    const boundDigest = input.checkpoint.taskBindingDigest;
    input.task.sourceArtifacts![0]!.name = "replacement.patch";

    expect(investigationTaskBindingDigest(input.task)).not.toBe(boundDigest);
    expectBuildError(
      () => buildInvestigationReportSubmission({ ...input, parentPlan }),
      "INVALID_INPUT",
    );
  });

  it("rejects an inherited patch in runtime artifacts even when its ancestor attempt is adopted", () => {
    const { input, parentPlan, artifact } = inheritedPatchReportFixture(true);
    input.checkpoint.adoptedAttemptIds.push(artifact.attemptId);
    input.checkpoint.runtime.artifacts.push(artifact);
    input.checkpoint = seal(input.checkpoint);

    expectBuildError(
      () => buildInvestigationReportSubmission({ ...input, parentPlan }),
      "INVALID_RUNTIME_ARTIFACT",
    );
  });

  it("preserves a runtime validation check reference to the saved parent plan", () => {
    const { input, parentPlan } = parentPlanFixture();
    const planRef = { ...input.task.planRef! };
    input.checkpoint.runtime.artifacts = [
      {
        id: "artifact:parent-plan-check",
        taskId: input.task.id,
        attemptId: input.attempt.id,
        subjectRef: input.task.subjectRef,
        kind: "log",
        name: "synthetic-parent-plan-check.log",
        mediaType: "text/plain",
        digest: "1".repeat(64),
        byteLength: 64,
        availability: "available",
      },
    ];
    input.checkpoint.runtime.evidence = [
      {
        id: "evidence:parent-plan-check",
        subjectRef: input.task.subjectRef,
        source: "executor_observation",
        authority: "worker",
        summary: "The isolated mock executor observed the saved parent plan check.",
        artifactRefs: ["artifact:parent-plan-check"],
        evidenceRefs: [],
        provenance: {
          taskId: input.task.id,
          attemptId: input.attempt.id,
          producer: "mock-parent-plan-executor",
          recordedAt,
        },
      },
    ];
    input.checkpoint.runtime.checks = [
      {
        id: "check:parent-plan",
        scenarioId: "scenario:parent-plan",
        subjectRef: input.task.subjectRef,
        planRef,
        required: true,
        description: "Verify the exact saved parent experiment.",
        status: "passed",
        executor: "mock-parent-plan-executor",
        evidenceRefs: ["evidence:parent-plan-check"],
        authoritativeAttemptId: input.attempt.id,
      },
    ];
    input.checkpoint = seal(input.checkpoint);

    const submission = buildInvestigationReportSubmission({ ...input, parentPlan });
    expect(collectionItems(submission.parts, "validationChecks")).toEqual(
      input.checkpoint.runtime.checks,
    );
    expect(collectionItems(submission.parts, "validationChecks")[0]).toMatchObject({ planRef });
    expect(collectionItems(submission.parts, "plans")).toEqual([parentPlan]);
    expect(parentPlan.sourceReportRef.id).not.toBe(submission.header.id);
  });

  it.each(["issue-verify", "reproduction-setup", "issue-fix", "feature-implement"] as const)(
    "retains the parent issue snapshot plan when %s selects an immutable source commit",
    (kind) => {
      const { input, parentPlan, snapshot } = selectedIssueSourceFixture(kind);
      const submission = buildInvestigationReportSubmission({ ...input, parentPlan });

      expect(collectionItems(submission.parts, "plans")).toEqual([parentPlan]);
      expect(parentPlan.subjectRef).toBe(snapshot.id);
      expect(parentPlan.subjectRef).not.toBe(input.task.subjectRef);
      expect(submission.header.context.subjects).toEqual(input.task.subjects);
      expect(
        submission.header.context.subjects.find((subject) => subject.id === input.task.subjectRef)
          ?.kind,
      ).toBe("source_commit");
      expect(
        submission.header.context.subjects.find((subject) => subject.id === snapshot.id),
      ).toEqual(snapshot);
    },
  );

  it.each(["issue-verify", "reproduction-setup", "issue-fix", "feature-implement"] as const)(
    "rejects a selected source %s parent plan without the original issue snapshot",
    (kind) => {
      const { input, parentPlan, snapshot } = selectedIssueSourceFixture(kind);
      input.task.subjects = input.task.subjects.filter((subject) => subject.id !== snapshot.id);
      input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
      input.checkpoint = seal(input.checkpoint);

      expectBuildError(
        () => buildInvestigationReportSubmission({ ...input, parentPlan }),
        "INVALID_INPUT",
      );
    },
  );

  it("reuses an identical parent plan draft without rewriting its saved provenance", () => {
    const { input, parentPlan, draft } = parentPlanFixture();
    input.checkpoint.analysis.plans = [draft];
    input.checkpoint = seal(input.checkpoint);

    const submission = buildInvestigationReportSubmission({ ...input, parentPlan });
    expect(collectionItems(submission.parts, "plans")).toEqual([parentPlan]);
    expect(submission.header.report.collections.plans).toBe(1);
  });

  it("rejects a model draft that conflicts with the bound parent plan identity", () => {
    const { input, parentPlan, draft } = parentPlanFixture();
    input.checkpoint.analysis.plans = [
      { ...draft, title: "A model replacement for the saved experiment" },
    ];
    input.checkpoint = seal(input.checkpoint);

    expectBuildError(
      () => buildInvestigationReportSubmission({ ...input, parentPlan }),
      "INVALID_INPUT",
    );
  });

  it.each([
    "plan-id",
    "plan-version",
    "plan-digest",
    "source-report-id",
    "source-report-version",
    "missing-parent-task",
    "missing-parent-report",
  ] as const)("rejects a parent plan with an invalid %s binding", (binding) => {
    const { input, parentPlan } = parentPlanFixture();
    if (binding === "plan-id") input.task.planRef!.id = "plan:unrelated";
    else if (binding === "plan-version") input.task.planRef!.version += 1;
    else if (binding === "plan-digest") input.task.planRef!.digest = "8".repeat(64);
    else if (binding === "source-report-id") input.task.parentReportRef!.id = "report:unrelated";
    else if (binding === "source-report-version") input.task.parentReportRef!.version += 1;
    else if (binding === "missing-parent-task") input.task.parentTaskId = null;
    else input.task.parentReportRef = null;
    input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
    input.checkpoint = seal(input.checkpoint);

    expectBuildError(
      () => buildInvestigationReportSubmission({ ...input, parentPlan }),
      "INVALID_INPUT",
    );
  });
});
