import { createHash } from "node:crypto";

import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationPlanV1,
  type InvestigationPrDiffManifestV1,
  type InvestigationReportCollection,
  type InvestigationReportPartV1,
  type InvestigationResultV1,
  validateInvestigationResult,
} from "@agentic-review/contracts";
import {
  applyInvestigationSourceCoverage,
  createInvestigationCheckpoint,
  investigationContentDigest,
  investigationTaskBindingDigest,
  projectInvestigationNextActions,
  projectInvestigationReportFindings,
} from "@agentic-review/domain";
import { describe, expect, it } from "vitest";

import { InvestigationRequestError } from "./errors.js";
import {
  type AssembleInvestigationReportInput,
  assembleInvestigationReport,
  reportHeader,
} from "./report.js";

function sealCheckpoint(checkpoint: InvestigationLoopCheckpointV1): void {
  const { digest: _digest, ...content } = checkpoint;
  checkpoint.digest = investigationContentDigest(content);
}

function refreshPartChain(input: AssembleInvestigationReportInput): void {
  let previousPartDigest: string | null = null;
  for (const [sequence, part] of input.parts.entries()) {
    part.sequence = sequence;
    part.previousPartDigest = previousPartDigest;
    const { digest: _digest, ...content } = part;
    part.digest = investigationContentDigest(content);
    previousPartDigest = part.digest;
  }
  input.manifest.parts = input.parts.map(({ id, collection, sequence, itemCount, digest }) => ({
    id,
    collection,
    sequence,
    itemCount,
    digest,
  }));
}

function sealResult(result: InvestigationResultV1): void {
  const { logicalContentDigest: _digest, ...report } = result.report;
  result.report.logicalContentDigest = investigationContentDigest({ ...result, report });
}

function sourceManifest(
  task: AssembleInvestigationReportInput["task"],
  result: InvestigationResultV1,
): InvestigationPrDiffManifestV1 {
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  if (subject?.kind !== "original_pr") throw new Error("Fixture PR subject is missing.");
  const paths = [
    ...new Set(
      result.findings.flatMap((finding) =>
        finding.locations.flatMap((location) =>
          location.kind === "source" ? [location.path] : [],
        ),
      ),
    ),
  ];
  const prefix = "// Synthetic source line.\n".repeat(41);
  const contents = {
    diff: "@@ -42,2 +42,1 @@\n-cancellationToken.ThrowIfCancellationRequested();\n await SaveSettingsAsync(settings, cancellationToken);\n",
    base: `${prefix}cancellationToken.ThrowIfCancellationRequested();\nawait SaveSettingsAsync(settings, cancellationToken);\n`,
    head: `${prefix}await SaveSettingsAsync(settings, cancellationToken);\n`,
  };
  const chunks = paths.flatMap((path, fileIndex) =>
    (["diff", "base", "head"] as const).map((kind) => ({
      id: `synthetic-source-${fileIndex}-${kind}`,
      path,
      kind,
      ordinal: 0,
      encoding: "utf8" as const,
      contentDigest: createHash("sha256").update(contents[kind]).digest("hex"),
      byteLength: Buffer.byteLength(contents[kind]),
    })),
  );
  const content = {
    schemaVersion: "InvestigationPrDiffManifestV1" as const,
    subjectRef: subject.id,
    baseSha: subject.baseSha,
    headSha: subject.headSha,
    mergeBaseSha: subject.baseSha,
    files: paths.map((path) => ({
      path,
      previousPath: null,
      status: "modified" as const,
      chunkIds: chunks.filter((chunk) => chunk.path === path).map((chunk) => chunk.id),
    })),
    chunks,
  };
  return { ...content, digest: investigationContentDigest(content) };
}

function removePrSourceFixture(
  input: AssembleInvestigationReportInput,
  result: InvestigationResultV1,
): void {
  delete input.checkpoint.runtime.sourceCoverage;
  for (const unit of input.task.scope.includedUnits)
    if (unit.kind === "full_diff") unit.kind = "saved_plan";
  result.report.coverage.includedUnits = result.report.coverage.includedUnits
    .filter((unit) => unit.kind !== "pr_diff_chunk")
    .map((unit) => (unit.kind === "full_diff" ? { ...unit, kind: "saved_plan" } : unit));
  result.report.coverage.completedUnitRefs = result.report.coverage.includedUnits
    .filter((unit) => unit.status === "completed")
    .map((unit) => unit.id);
  result.report.coverage.unresolvedUnitRefs = result.report.coverage.includedUnits
    .filter((unit) => unit.status !== "completed")
    .map((unit) => unit.id);
  result.report.coverage.scopeManifest = createInvestigationCheckpoint({
    task: input.task,
    attemptId: input.attempt.id,
    checkpointId: input.checkpoint.id,
    leaseVersion: input.attempt.leaseVersion,
    recordedAt: input.checkpoint.recordedAt,
  }).analysis.coverage.scopeManifest;
  input.checkpoint.analysis.coverage = structuredClone(result.report.coverage);
  input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
}

function submission(
  result: InvestigationResultV1,
  checkpoint: InvestigationLoopCheckpointV1,
  task: AssembleInvestigationReportInput["task"],
  attempt: AssembleInvestigationReportInput["attempt"],
): AssembleInvestigationReportInput {
  const collectionItems = {
    findings: result.findings,
    verificationEvidence: result.verificationEvidence,
    artifacts: result.artifacts,
    plans: result.plans,
    nextActions: result.nextActions,
    feedbackDrafts: result.feedbackDrafts,
    coverageUnits: result.report.coverage.includedUnits,
    coverageExclusions: result.report.coverage.exclusions,
    candidates: result.report.loop.candidates,
    rechecks: result.report.recheck.records,
    diagnostics: result.diagnostics,
    limitations: result.report.limitations,
    validationChecks: result.validation.checks,
  } satisfies Record<InvestigationReportCollection, readonly unknown[]>;
  const parts: InvestigationReportPartV1[] = [];
  for (const collection of Object.keys(collectionItems) as InvestigationReportCollection[]) {
    const items = collectionItems[collection];
    for (let offset = 0; offset < items.length; offset += 3) {
      const selected = items.slice(offset, offset + 3);
      // The discriminant and item array originate from the typed collection map.
      parts.push({
        schemaVersion: "InvestigationReportPartV1",
        id: `synthetic-part-${parts.length}`,
        taskId: task.id,
        attemptId: attempt.id,
        reportId: result.id,
        reportVersion: result.version,
        sequence: parts.length,
        itemCount: selected.length,
        previousPartDigest: null,
        digest: "0".repeat(64),
        collection,
        items: structuredClone(selected),
      } as InvestigationReportPartV1);
    }
  }
  const input: AssembleInvestigationReportInput = {
    task,
    attempt,
    checkpoint,
    header: reportHeader(result),
    parts,
    manifest: {
      schemaVersion: "InvestigationReportManifestV1",
      reportId: result.id,
      reportVersion: result.version,
      parts: [],
      collections: structuredClone(result.report.collections),
      logicalContentDigest: result.report.logicalContentDigest,
    },
  };
  refreshPartChain(input);
  return input;
}

/** All records are isolated synthetic fixtures; these tests never contact upstream repositories. */
function fixture(findingCount = 2, outcome: "completed" | "blocked" = "completed") {
  const { task, attempt, result } = createInvestigationFixture("pr", { findingCount, outcome });
  for (const unit of task.scope.includedUnits)
    if (unit.kind === "investigation") unit.kind = "full_diff";
  for (const unit of result.report.coverage.includedUnits)
    if (unit.kind === "investigation") unit.kind = "full_diff";
  const planReferences = new Map<string, { id: string; version: number; digest: string }>();
  for (const plan of result.plans) {
    const { digest: _digest, state: _state, sourceReportRef: _source, ...draft } = plan;
    plan.digest = investigationContentDigest(draft);
    planReferences.set(plan.id, { id: plan.id, version: plan.version, digest: plan.digest });
  }
  for (const finding of result.findings) {
    if (finding.fixRecommendation.planRef !== null)
      finding.fixRecommendation.planRef = planReferences.get(finding.fixRecommendation.planRef.id)!;
  }
  for (const action of result.nextActions) {
    if (action.planRef !== null) action.planRef = planReferences.get(action.planRef.id)!;
  }
  for (const check of result.validation.checks) {
    if (check.planRef !== null) check.planRef = planReferences.get(check.planRef.id)!;
  }
  if (result.assessment.kind === "pr" && result.assessment.e2eAssessment.planRef !== null) {
    result.assessment.e2eAssessment.planRef = planReferences.get(
      result.assessment.e2eAssessment.planRef.id,
    )!;
  }
  let checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: result.report.loop.checkpointId,
    leaseVersion: attempt.leaseVersion,
    recordedAt: "2026-09-15T02:00:03.000Z",
  });
  const source = sourceManifest(task, result);
  checkpoint = applyInvestigationSourceCoverage(checkpoint, source, {
    task,
    recordedAt: checkpoint.recordedAt,
  });
  const originalUnits = new Map(
    result.report.coverage.includedUnits.map((unit) => [unit.id, unit]),
  );
  result.report.coverage = structuredClone(checkpoint.analysis.coverage);
  result.report.coverage.includedUnits = result.report.coverage.includedUnits.map((unit) => ({
    ...unit,
    status:
      originalUnits.get(unit.id)?.status ?? (outcome === "completed" ? "completed" : "pending"),
    evidenceRefs: originalUnits.get(unit.id)?.evidenceRefs ?? [],
  }));
  result.report.coverage.completedUnitRefs = result.report.coverage.includedUnits
    .filter((unit) => unit.status === "completed")
    .map((unit) => unit.id);
  result.report.coverage.unresolvedUnitRefs = result.report.coverage.includedUnits
    .filter((unit) => unit.status !== "completed")
    .map((unit) => unit.id);
  checkpoint.runtime.sourceCoverage = {
    manifest: source,
    brokeredUnitIds: outcome === "completed" ? source.chunks.map((chunk) => chunk.id) : [],
  };
  const analysis: InvestigationAnalysisV1 = {
    schemaVersion: "InvestigationAnalysisV1",
    summary: result.report.summary,
    coverage: structuredClone(result.report.coverage),
    findings: structuredClone(result.findings),
    assessment: structuredClone(result.assessment),
    candidates: structuredClone(result.report.loop.candidates),
    rechecks: structuredClone(result.report.recheck.records),
    evidence: result.verificationEvidence
      .filter((entry) => entry.authority === "model")
      .map((entry) => ({
        id: entry.id,
        subjectRef: entry.subjectRef,
        source: entry.source === "reporter_statement" ? "reporter_statement" : "static_analysis",
        summary: entry.summary,
        evidenceRefs: [...entry.evidenceRefs],
      })),
    plans: result.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...draft }) =>
        structuredClone(draft),
    ),
    nextActions: result.nextActions.map(({ state: _state, sourceReportRef: _source, ...draft }) =>
      structuredClone(draft),
    ),
    feedbackDrafts: structuredClone(result.feedbackDrafts),
    diagnostics: structuredClone(result.diagnostics),
    limitations: structuredClone(result.report.limitations),
  };
  checkpoint.analysis = analysis;
  checkpoint.round = 3;
  checkpoint.version = 3;
  checkpoint.lastPhase = "finalize";
  checkpoint.stopReason = outcome === "completed" ? "complete" : "blocked";
  checkpoint.consumed = structuredClone(result.report.loop.consumed);
  checkpoint.runtime.evidence = structuredClone(
    result.verificationEvidence.filter((entry) => entry.authority === "worker"),
  );
  checkpoint.runtime.artifacts = structuredClone(result.artifacts);
  checkpoint.runtime.checks = structuredClone(result.validation.checks);
  sealCheckpoint(checkpoint);
  result.context.adoptedAttemptIds = [attempt.id];
  result.verificationEvidence = [
    ...analysis.evidence.map((entry) => ({
      ...entry,
      authority: "model" as const,
      artifactRefs: [],
      provenance: {
        taskId: task.id,
        attemptId: attempt.id,
        producer: "investigation-model",
        recordedAt: checkpoint.recordedAt,
      },
    })),
    ...structuredClone(checkpoint.runtime.evidence),
  ];
  sealResult(result);
  return { result, input: submission(result, checkpoint, task, attempt) };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("Expected report assembly to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(InvestigationRequestError);
    expect((error as InvestigationRequestError).code).toBe(code);
  }
}

function parentPlanFixture(repeatDraft: boolean) {
  const { input, result } = fixture();
  removePrSourceFixture(input, result);
  const parentPlan: InvestigationPlanV1 = structuredClone(result.plans[0]!);
  parentPlan.sourceReportRef = { id: "synthetic-parent-report", version: 2 };
  input.task.kind = "pr-verify";
  input.task.parentTaskId = "synthetic-parent-task";
  input.task.parentReportRef = { ...parentPlan.sourceReportRef, digest: "9".repeat(64) };
  input.task.planRef = {
    id: parentPlan.id,
    version: parentPlan.version,
    digest: parentPlan.digest,
  };
  input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
  input.checkpoint.analysis.plans = repeatDraft ? input.checkpoint.analysis.plans : [];
  input.checkpoint.analysis.nextActions = [];
  result.nextActions = [];
  result.report.collections.nextActions = 0;
  result.plans = [structuredClone(parentPlan)];
  result.context.task = {
    id: input.task.id,
    kind: input.task.kind,
    parentTaskId: input.task.parentTaskId,
    subjectRef: input.task.subjectRef,
  };
  result.context.parentReportRef = structuredClone(input.task.parentReportRef);
  sealCheckpoint(input.checkpoint);
  sealResult(result);
  return {
    result,
    parentPlan,
    input: { ...submission(result, input.checkpoint, input.task, input.attempt), parentPlan },
  };
}

function derivedPatchFixture() {
  const { input, result } = fixture();
  const base = input.task.subjects[0]!;
  if (base.kind !== "original_pr") throw new Error("Fixture original PR subject is missing.");
  input.task.executionPolicy = {
    mode: "execute",
    allowedSubjectRefs: [base.id],
    allowRepositoryExecution: true,
    authorizationRef: "synthetic-authorization",
  };
  input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
  const patch = {
    id: "synthetic-derived-patch",
    kind: "local_patch" as const,
    repositoryId: base.repositoryId,
    workItemId: base.workItemId,
    revisionKey: "8".repeat(64),
    baseSubjectRef: base.id,
    baseSha: base.headSha,
    patchDigest: "7".repeat(64),
    artifactRef: "synthetic-patch-artifact",
  };
  const artifact = {
    id: patch.artifactRef,
    taskId: input.task.id,
    attemptId: input.attempt.id,
    subjectRef: patch.id,
    kind: "patch" as const,
    name: "synthetic.patch",
    mediaType: "text/x-diff",
    digest: patch.patchDigest,
    byteLength: 42,
    availability: "available" as const,
  };
  const observation = {
    id: "synthetic-patch-observation",
    subjectRef: patch.id,
    source: "executor_observation" as const,
    authority: "worker" as const,
    summary: "The synthetic executor observed the assertion on the derived patch.",
    artifactRefs: [artifact.id],
    evidenceRefs: [],
    provenance: {
      taskId: input.task.id,
      attemptId: input.attempt.id,
      producer: "synthetic-executor",
      recordedAt: input.checkpoint.recordedAt,
    },
  };
  const check = {
    id: "synthetic-patch-check",
    scenarioId: "synthetic-patch-scenario",
    subjectRef: patch.id,
    planRef: null,
    required: true,
    description: "Verify the derived patch without changing the original PR assessment.",
    status: "passed" as const,
    executor: "synthetic-executor",
    evidenceRefs: [observation.id],
    authoritativeAttemptId: input.attempt.id,
  };
  input.checkpoint.runtime.subjects.push(structuredClone(patch));
  input.checkpoint.runtime.artifacts.push(structuredClone(artifact));
  input.checkpoint.runtime.evidence.push(structuredClone(observation));
  input.checkpoint.runtime.checks.push(structuredClone(check));
  result.context.subjects.push(structuredClone(patch));
  result.artifacts.push(structuredClone(artifact));
  result.verificationEvidence.push(structuredClone(observation));
  result.validation.checks.push(structuredClone(check));
  result.report.collections.artifacts += 1;
  result.report.collections.verificationEvidence += 1;
  sealCheckpoint(input.checkpoint);
  sealResult(result);
  return { result, input: submission(result, input.checkpoint, input.task, input.attempt) };
}

describe("assembleInvestigationReport", () => {
  it("reconstructs every finding across many report parts without a top-k limit", () => {
    const { input, result } = fixture(151);
    const assembled = assembleInvestigationReport({ ...input, parts: [...input.parts].reverse() });
    expect(assembled).toEqual(result);
    expect(assembled.findings).toHaveLength(151);
    expect(assembled.report.recheck.records).toHaveLength(151);
    expect(assembled.report.loop.candidates).toHaveLength(151);
    expect(input.checkpoint.runtime.sourceCoverage!.manifest.chunks).toHaveLength(453);
    expect(input.checkpoint.runtime.sourceCoverage!.brokeredUnitIds).toHaveLength(453);
    assembled.findings[0]!.title = "Changed after export";
    expect(input.checkpoint.analysis.findings[0]!.title).not.toBe("Changed after export");
  });

  it("preserves partial reports and their unresolved scope", () => {
    const { input, result } = fixture(4, "blocked");
    expect(assembleInvestigationReport(input)).toEqual(result);
    expect(result.report.completeness).toBe("partial");
    expect(result.report.coverage.unresolvedUnitRefs.length).toBeGreaterThan(1);
  });

  it("keeps all unbounded arrays out of the transport header", () => {
    const { result } = fixture(151);
    const header = reportHeader(result);
    expect(header.report.collections.findings).toBe(151);
    expect(header.report.recheck.finalFindingCount).toBe(151);
    expect(header.report.recheck).not.toHaveProperty("records");
    expect(header.report.loop).not.toHaveProperty("candidates");
    expect(header.report.coverage).not.toHaveProperty("includedUnits");
  });

  it("rejects missing uploaded parts and additional unlisted parts", () => {
    const { input } = fixture();
    expectCode(
      () => assembleInvestigationReport({ ...input, parts: input.parts.slice(1) }),
      "report_part_set_mismatch",
    );
    const extra = structuredClone(input.parts[0]!);
    extra.id = "unlisted-part";
    expectCode(
      () => assembleInvestigationReport({ ...input, parts: [...input.parts, extra] }),
      "report_part_set_mismatch",
    );
  });

  it("rejects digest, item count, and manifest order manipulation", () => {
    const digestCase = fixture().input;
    digestCase.parts[0]!.digest = "f".repeat(64);
    expectCode(() => assembleInvestigationReport(digestCase), "report_part_digest_mismatch");
    const countCase = fixture().input;
    countCase.parts[0]!.itemCount += 1;
    expectCode(() => assembleInvestigationReport(countCase), "report_part_count_mismatch");
    const sequenceCase = fixture().input;
    sequenceCase.manifest.parts.reverse();
    expectCode(() => assembleInvestigationReport(sequenceCase), "report_part_chain_mismatch");
  });

  it("rejects a forged part chain even when individual digests are recalculated", () => {
    const { input } = fixture();
    const part = input.parts[1]!;
    part.previousPartDigest = null;
    const { digest: _digest, ...content } = part;
    part.digest = investigationContentDigest(content);
    input.manifest.parts[1]!.digest = part.digest;
    expectCode(() => assembleInvestigationReport(input), "report_part_chain_mismatch");
  });

  it("cannot discard lower-priority findings from an accepted checkpoint", () => {
    const { input } = fixture(4);
    const part = input.parts.find((entry) => entry.collection === "findings")!;
    part.items.pop();
    part.itemCount -= 1;
    refreshPartChain(input);
    expectCode(() => assembleInvestigationReport(input), "report_checkpoint_collection_mismatch");
  });

  it("rejects candidate, coverage, and recheck content that differs from the accepted checkpoint", () => {
    for (const collection of ["candidates", "coverageUnits", "rechecks"] as const) {
      const { input } = fixture();
      const part = input.parts.find((entry) => entry.collection === collection)!;
      part.items.pop();
      part.itemCount -= 1;
      refreshPartChain(input);
      expectCode(() => assembleInvestigationReport(input), "report_checkpoint_collection_mismatch");
    }
  });

  it("rejects a saved plan whose draft was changed during assembly", () => {
    const { input } = fixture();
    const part = input.parts.find((entry) => entry.collection === "plans");
    if (part?.collection !== "plans") throw new Error("Fixture plan part is missing.");
    part.items[0]!.title = "Unexpected replacement plan";
    refreshPartChain(input);
    expectCode(() => assembleInvestigationReport(input), "report_plan_draft_mismatch");
  });

  it("rejects an incorrect saved plan digest and cross-report action binding", () => {
    const planCase = fixture().input;
    const plans = planCase.parts.find((entry) => entry.collection === "plans");
    if (plans?.collection !== "plans") throw new Error("Fixture plan part is missing.");
    plans.items[0]!.digest = "f".repeat(64);
    refreshPartChain(planCase);
    expectCode(() => assembleInvestigationReport(planCase), "invalid_saved_plan");
    const actionCase = fixture().input;
    const actions = actionCase.parts.find((entry) => entry.collection === "nextActions");
    if (actions?.collection !== "nextActions") throw new Error("Fixture action part is missing.");
    actions.items[0]!.sourceReportRef.id = "another-report";
    refreshPartChain(actionCase);
    expectCode(() => assembleInvestigationReport(actionCase), "invalid_saved_action");
  });

  it("preserves every checkpoint finding while projecting rejected action proposals into diagnostics", () => {
    const { input, result } = fixture(4);
    const rejected = input.checkpoint.analysis.nextActions[0]!;
    rejected.action = "start-task";
    rejected.taskKind = "reproduction-setup";
    sealCheckpoint(input.checkpoint);
    const checkpoint = structuredClone(input.checkpoint);
    const projected = projectInvestigationNextActions(
      result,
      checkpoint.analysis.nextActions,
      result.plans,
      checkpoint.analysis.diagnostics,
    );
    result.nextActions = projected.nextActions;
    result.diagnostics = projected.diagnostics;
    result.report.collections.nextActions = result.nextActions.length;
    sealResult(result);
    const accepted = assembleInvestigationReport(
      submission(result, checkpoint, input.task, input.attempt),
    );
    expect(accepted.outcome).toBe("completed");
    expect(accepted.findings).toEqual(checkpoint.analysis.findings);
    expect(accepted.nextActions.some((action) => action.id === rejected.id)).toBe(false);
    expect(JSON.parse(accepted.diagnostics.at(-1)!.message)).toMatchObject({
      proposal: rejected,
      reasonCodes: ["plan_task_kind_mismatch", "bug_verification_not_supported_by_assessment"],
    });
    expect(input.checkpoint).toEqual(checkpoint);
  });

  it("seals a report after projecting a suggestion proposal without replacement content", () => {
    const { input, result } = fixture();
    const draft = result.feedbackDrafts[0]!;
    expect(draft.suggestion).toBeNull();
    const rejected = {
      ...input.checkpoint.analysis.nextActions[0]!,
      id: "synthetic-suggestion-without-replacement",
      action: "suggestion-comment" as const,
      taskKind: null,
      planRef: null,
      draftRef: draft.id,
      prerequisiteRefs: [],
    };
    input.checkpoint.analysis.nextActions.push(rejected);
    sealCheckpoint(input.checkpoint);
    const checkpoint = structuredClone(input.checkpoint);
    result.nextActions.push({
      ...rejected,
      state: "saved",
      sourceReportRef: { id: result.report.id, version: result.report.version },
    });
    result.report.collections.nextActions = result.nextActions.length;
    expect(validateInvestigationResult(result).errors).toEqual([
      expect.objectContaining({ code: "SUGGESTION_REQUIRED" }),
    ]);
    sealResult(result);
    expectCode(
      () => assembleInvestigationReport(submission(result, checkpoint, input.task, input.attempt)),
      "report_action_draft_mismatch",
    );

    const projected = projectInvestigationNextActions(
      result,
      checkpoint.analysis.nextActions,
      result.plans,
      checkpoint.analysis.diagnostics,
    );
    result.nextActions = projected.nextActions;
    result.diagnostics = projected.diagnostics;
    result.report.collections.nextActions = result.nextActions.length;
    sealResult(result);
    const accepted = assembleInvestigationReport(
      submission(result, checkpoint, input.task, input.attempt),
    );
    expect(accepted.outcome).toBe("completed");
    expect(accepted.findings).toEqual(checkpoint.analysis.findings);
    expect(accepted.nextActions.some((action) => action.id === rejected.id)).toBe(false);
    expect(JSON.parse(accepted.diagnostics.at(-1)!.message)).toMatchObject({
      proposal: rejected,
      reasonCodes: ["missing_saved_suggestion"],
    });
    expect(input.checkpoint).toEqual(checkpoint);
  });

  it("seals deterministic finding display positions while preserving every original reviewed field", () => {
    const { input, result } = fixture(3);
    input.checkpoint.analysis.findings.forEach((finding, index) => {
      finding.ordinal = [8, 8, 1][index]!;
    });
    sealCheckpoint(input.checkpoint);
    const original = structuredClone(input.checkpoint);
    const findings = projectInvestigationReportFindings(
      original.analysis.findings,
      { id: result.report.id, version: result.report.version },
      original.analysis.diagnostics,
    );
    result.findings = findings.findings;
    result.diagnostics = findings.diagnostics;
    sealResult(result);
    const accepted = assembleInvestigationReport(
      submission(result, original, input.task, input.attempt),
    );
    expect(accepted.findings).toEqual(
      original.analysis.findings.map((finding, ordinal) => ({ ...finding, ordinal })),
    );
    expect(accepted.report.recheck.records).toEqual(original.analysis.rechecks);
    expect(
      accepted.diagnostics.filter((diagnostic) => diagnostic.code === "FINDING_ORDINAL_NORMALIZED"),
    ).toHaveLength(3);
    expect(input.checkpoint).toEqual(original);
  });

  it.each(["ordinal", "body", "order", "drop-diagnostic", "rewrite-diagnostic"])(
    "rejects a forged finding projection with recomputed report digests: %s",
    (mutation) => {
      const { input, result } = fixture(2);
      input.checkpoint.analysis.findings.forEach((finding) => {
        finding.ordinal = 7;
      });
      sealCheckpoint(input.checkpoint);
      const projected = projectInvestigationReportFindings(
        input.checkpoint.analysis.findings,
        { id: result.report.id, version: result.report.version },
        input.checkpoint.analysis.diagnostics,
      );
      result.findings = projected.findings;
      result.diagnostics = projected.diagnostics;
      let code = "report_checkpoint_collection_mismatch";
      if (mutation === "ordinal") result.findings[0]!.ordinal = 7;
      if (mutation === "body")
        result.findings[0]!.impact.description = "Substituted reviewed content";
      if (mutation === "order")
        result.findings = result.findings
          .reverse()
          .map((finding, ordinal) => ({ ...finding, ordinal }));
      if (mutation === "drop-diagnostic") {
        result.diagnostics.pop();
        code = "report_diagnostic_projection_mismatch";
      }
      if (mutation === "rewrite-diagnostic") {
        const diagnostic = result.diagnostics.at(-1)!;
        const envelope = JSON.parse(diagnostic.message);
        envelope.originalOrdinal = 1;
        diagnostic.message = JSON.stringify(envelope);
        code = "report_diagnostic_projection_mismatch";
      }
      sealResult(result);
      expectCode(
        () =>
          assembleInvestigationReport(
            submission(result, input.checkpoint, input.task, input.attempt),
          ),
        code,
      );
    },
  );

  it("refuses a schema-valid report whose conclusion contradicts its confirmed blocking findings", () => {
    const { input, result } = fixture();
    if (result.assessment.kind !== "pr" || input.checkpoint.analysis.assessment.kind !== "pr")
      throw new Error("Expected PR fixture.");
    result.assessment.reviewConclusion.status = "no-blocking-findings";
    input.checkpoint.analysis.assessment.reviewConclusion.status = "no-blocking-findings";
    sealCheckpoint(input.checkpoint);
    sealResult(result);
    expectCode(
      () =>
        assembleInvestigationReport(
          submission(result, input.checkpoint, input.task, input.attempt),
        ),
      "invalid_logical_report_semantics",
    );
  });

  it.each([
    "drop-valid",
    "restore-invalid",
    "drop-diagnostic",
    "substitute-proposal",
    "substitute-reasons",
    "forge-source",
    "forge-diagnostic",
  ])(
    "rejects a forged proposal projection even with recomputed transport and report digests: %s",
    (mutation) => {
      const { input, result } = fixture();
      const rejected = input.checkpoint.analysis.nextActions[0]!;
      rejected.action = "start-task";
      rejected.taskKind = "reproduction-setup";
      sealCheckpoint(input.checkpoint);
      const projected = projectInvestigationNextActions(
        result,
        input.checkpoint.analysis.nextActions,
        result.plans,
        input.checkpoint.analysis.diagnostics,
      );
      result.nextActions = projected.nextActions;
      result.diagnostics = projected.diagnostics;
      let code = "report_diagnostic_projection_mismatch";
      if (mutation === "drop-valid") {
        result.nextActions.pop();
        code = "report_action_draft_mismatch";
      }
      if (mutation === "restore-invalid") {
        result.nextActions.unshift({
          ...rejected,
          state: "saved",
          sourceReportRef: { id: result.report.id, version: result.report.version },
        });
        code = "report_action_draft_mismatch";
      }
      if (mutation === "drop-diagnostic") result.diagnostics.pop();
      if (mutation === "forge-diagnostic")
        result.diagnostics.push({ ...result.diagnostics[0]!, id: "forged-extra-diagnostic" });
      if (["substitute-proposal", "substitute-reasons", "forge-source"].includes(mutation)) {
        const diagnostic = result.diagnostics.at(-1)!;
        const envelope = JSON.parse(diagnostic.message);
        if (mutation === "substitute-proposal") envelope.proposal.taskKind = "pr-verify";
        if (mutation === "substitute-reasons") envelope.reasonCodes = ["fabricated_reason"];
        if (mutation === "forge-source") envelope.sourceReportRef.id = "unrelated-report";
        diagnostic.message = JSON.stringify(envelope);
      }
      result.report.collections.nextActions = result.nextActions.length;
      sealResult(result);
      const forged = submission(result, input.checkpoint, input.task, input.attempt);
      expectCode(() => assembleInvestigationReport(forged), code);
    },
  );

  it("cannot upgrade model analysis into worker or server evidence", () => {
    for (const authority of ["worker", "server"] as const) {
      const { input } = fixture();
      const part = input.parts.find((entry) => entry.collection === "verificationEvidence");
      if (part?.collection !== "verificationEvidence")
        throw new Error("Fixture evidence part is missing.");
      part.items[0]!.authority = authority;
      refreshPartChain(input);
      expectCode(() => assembleInvestigationReport(input), "report_evidence_mismatch");
    }
  });

  it("rejects fabricated artifact availability outside the accepted runtime records", () => {
    const { input } = fixture();
    input.checkpoint.runtime.artifacts[0]!.availability = "missing";
    sealCheckpoint(input.checkpoint);
    expectCode(() => assembleInvestigationReport(input), "report_checkpoint_collection_mismatch");
  });

  it("rejects server authority even when it is already present in a runtime checkpoint", () => {
    const { input } = fixture();
    const record = input.checkpoint.runtime.evidence[0]!;
    record.authority = "server";
    const part = input.parts.find(
      (entry) =>
        entry.collection === "verificationEvidence" &&
        entry.items.some((item) => item.id === record.id),
    );
    if (part?.collection !== "verificationEvidence")
      throw new Error("Fixture evidence part is missing.");
    part.items.find((item) => item.id === record.id)!.authority = "server";
    sealCheckpoint(input.checkpoint);
    refreshPartChain(input);
    expectCode(() => assembleInvestigationReport(input), "forged_server_evidence");
  });

  it("accepts identical embedded feedback drafts and rejects conflicting duplicates", () => {
    const { input, result } = fixture();
    const draft = structuredClone(result.findings[0]!.feedbackDraft);
    result.feedbackDrafts.push(draft);
    input.checkpoint.analysis.feedbackDrafts.push(structuredClone(draft));
    sealCheckpoint(input.checkpoint);
    sealResult(result);
    const repeated = submission(result, input.checkpoint, input.task, input.attempt);
    expect(assembleInvestigationReport(repeated)).toEqual(result);
    result.feedbackDrafts[result.feedbackDrafts.length - 1]!.body =
      "Conflicting replacement feedback";
    input.checkpoint.analysis.feedbackDrafts = structuredClone(result.feedbackDrafts);
    sealCheckpoint(input.checkpoint);
    sealResult(result);
    expectCode(
      () =>
        assembleInvestigationReport(
          submission(result, input.checkpoint, input.task, input.attempt),
        ),
      "conflicting_feedback_draft",
    );
  });

  it("accepts the exact trusted model history including unknown and adopted model identities", () => {
    const { input, result } = fixture();
    input.checkpoint.adoptedAttemptIds.unshift("synthetic-prior-model-attempt");
    input.checkpoint.runtime.modelExecutions = [
      {
        attemptId: "synthetic-prior-model-attempt",
        round: 1,
        engine: "codex",
        model: "gpt-6-astra",
      },
      { attemptId: input.attempt.id, round: 3, engine: "copilot", model: null },
    ];
    result.context.adoptedAttemptIds = structuredClone(input.checkpoint.adoptedAttemptIds);
    result.context.modelExecutions = structuredClone(input.checkpoint.runtime.modelExecutions);
    sealCheckpoint(input.checkpoint);
    sealResult(result);
    expect(
      assembleInvestigationReport(submission(result, input.checkpoint, input.task, input.attempt)),
    ).toEqual(result);
  });

  it.each(["model", "engine", "round", "attempt", "discard", "omit", "append"])(
    "rejects a report header that changes trusted model history: %s",
    (mutation) => {
      const { input, result } = fixture();
      input.checkpoint.runtime.modelExecutions = [
        { attemptId: input.attempt.id, round: 1, engine: "codex", model: "gpt-6-astra" },
      ];
      result.context.modelExecutions = structuredClone(input.checkpoint.runtime.modelExecutions);
      const execution = result.context.modelExecutions[0]!;
      if (mutation === "model") execution.model = "forged-model";
      if (mutation === "engine") execution.engine = "copilot";
      if (mutation === "round") execution.round = 2;
      if (mutation === "attempt") execution.attemptId = "forged-attempt";
      if (mutation === "discard") result.context.modelExecutions = [];
      if (mutation === "omit") delete result.context.modelExecutions;
      if (mutation === "append") result.context.modelExecutions!.push({ ...execution, round: 2 });
      sealCheckpoint(input.checkpoint);
      sealResult(result);
      expectCode(
        () =>
          assembleInvestigationReport(
            submission(result, input.checkpoint, input.task, input.attempt),
          ),
        "report_context_mismatch",
      );
    },
  );

  it("rejects a claimed report model when the accepted checkpoint has no model history", () => {
    const { input, result } = fixture();
    expect(input.checkpoint.runtime.modelExecutions).toBeUndefined();
    result.context.modelExecutions = [
      { attemptId: input.attempt.id, round: 1, engine: "codex", model: "forged-model" },
    ];
    sealResult(result);
    expectCode(
      () =>
        assembleInvestigationReport(
          submission(result, input.checkpoint, input.task, input.attempt),
        ),
      "report_context_mismatch",
    );
  });

  it("rejects header identities, frozen versions, and false completeness claims", () => {
    const contextCase = fixture().input;
    contextCase.header.context.attempt.number += 1;
    expectCode(() => assembleInvestigationReport(contextCase), "report_context_mismatch");
    const identityCase = fixture().input;
    identityCase.header.report.version += 1;
    expectCode(() => assembleInvestigationReport(identityCase), "report_identity_mismatch");
    const incompleteCase = fixture(4, "blocked").input;
    incompleteCase.header.outcome = "completed";
    expectCode(() => assembleInvestigationReport(incompleteCase), "report_outcome_mismatch");
    const forgedStopCase = fixture(4, "blocked").input;
    forgedStopCase.checkpoint.stopReason = "complete";
    forgedStopCase.header.outcome = "completed";
    sealCheckpoint(forgedStopCase.checkpoint);
    expectCode(
      () => assembleInvestigationReport(forgedStopCase),
      "incomplete_report_claimed_completed",
    );
  });

  it("rejects incorrect collection counts and logical report digests", () => {
    const countCase = fixture().input;
    countCase.manifest.collections.findings += 1;
    expectCode(() => assembleInvestigationReport(countCase), "report_manifest_count_mismatch");
    const digestCase = fixture().input;
    digestCase.manifest.logicalContentDigest = "f".repeat(64);
    expectCode(() => assembleInvestigationReport(digestCase), "report_logical_digest_mismatch");
  });

  it("requires source receipts independently of a model claim that the full diff is complete", () => {
    const missingManifest = fixture().input;
    delete missingManifest.checkpoint.runtime.sourceCoverage;
    sealCheckpoint(missingManifest.checkpoint);
    expectCode(() => assembleInvestigationReport(missingManifest), "source_manifest_required");
    const missingDelivery = fixture().input;
    missingDelivery.checkpoint.runtime.sourceCoverage!.brokeredUnitIds.pop();
    sealCheckpoint(missingDelivery.checkpoint);
    expectCode(() => assembleInvestigationReport(missingDelivery), "source_chunk_not_delivered");
    const missingInvestigation = fixture().input;
    missingInvestigation.checkpoint.analysis.coverage.includedUnits.find(
      (unit) => unit.kind === "pr_diff_chunk",
    )!.status = "pending";
    sealCheckpoint(missingInvestigation.checkpoint);
    expectCode(
      () => assembleInvestigationReport(missingInvestigation),
      "full_diff_coverage_incomplete",
    );
  });

  it("binds the registered source manifest to the exact original PR base and head", () => {
    for (const field of ["baseSha", "headSha"] as const) {
      const { input } = fixture();
      const source = input.checkpoint.runtime.sourceCoverage!;
      source.manifest[field] = "0".repeat(40);
      const { digest: _digest, ...content } = source.manifest;
      source.manifest.digest = investigationContentDigest(content);
      sealCheckpoint(input.checkpoint);
      expectCode(() => assembleInvestigationReport(input), "invalid_source_coverage");
    }
    const digestCase = fixture().input;
    digestCase.checkpoint.runtime.sourceCoverage!.manifest.digest = "0".repeat(64);
    sealCheckpoint(digestCase.checkpoint);
    expectCode(() => assembleInvestigationReport(digestCase), "source_manifest_digest_mismatch");
  });

  it("rejects omitted base/head content and source units whose definitions were narrowed", () => {
    const graphCase = fixture().input;
    const source = graphCase.checkpoint.runtime.sourceCoverage!;
    const omitted = source.manifest.chunks.find((chunk) => chunk.kind === "head")!;
    source.manifest.chunks = source.manifest.chunks.filter((chunk) => chunk.id !== omitted.id);
    source.manifest.files = source.manifest.files.map((file) => ({
      ...file,
      chunkIds: file.chunkIds.filter((id) => id !== omitted.id),
    }));
    source.brokeredUnitIds = source.brokeredUnitIds.filter((id) => id !== omitted.id);
    const { digest: _digest, ...content } = source.manifest;
    source.manifest.digest = investigationContentDigest(content);
    sealCheckpoint(graphCase.checkpoint);
    expectCode(() => assembleInvestigationReport(graphCase), "invalid_source_coverage");
    const unitCase = fixture().input;
    unitCase.checkpoint.analysis.coverage.includedUnits.find(
      (unit) => unit.kind === "pr_diff_chunk",
    )!.requiredWork = "Inspect only the first line.";
    sealCheckpoint(unitCase.checkpoint);
    expectCode(() => assembleInvestigationReport(unitCase), "source_coverage_unit_mismatch");
  });

  it("allows a metadata-only PR only with an explicitly registered empty diff manifest", () => {
    const { input, result } = fixture(0);
    expect(input.checkpoint.runtime.sourceCoverage!.manifest.files).toEqual([]);
    expect(input.checkpoint.runtime.sourceCoverage!.manifest.chunks).toEqual([]);
    expect(assembleInvestigationReport(input)).toEqual(result);
  });

  it("retains the exact parent plan and its original source report without duplicating a repeated draft", () => {
    for (const repeatDraft of [false, true]) {
      const { input, result, parentPlan } = parentPlanFixture(repeatDraft);
      const assembled = assembleInvestigationReport(input);
      expect(assembled).toEqual(result);
      expect(assembled.plans).toEqual([parentPlan]);
      expect(assembled.plans[0]!.sourceReportRef.id).toBe("synthetic-parent-report");
    }
  });

  it("requires the trusted parent plan instead of accepting a wire-only parent record", () => {
    const { input } = parentPlanFixture(false);
    const { parentPlan: _parent, ...withoutParent } = input;
    expectCode(() => assembleInvestigationReport(withoutParent), "missing_saved_parent_plan");
    input.parentPlan.sourceReportRef.id = "forged-parent-report";
    expectCode(() => assembleInvestigationReport(input), "invalid_saved_parent_plan");
  });

  it("rejects replacing the saved parent plan with a different analysis draft", () => {
    const { input } = parentPlanFixture(true);
    input.checkpoint.analysis.plans[0]!.title = "Replace the inherited plan";
    sealCheckpoint(input.checkpoint);
    expectCode(() => assembleInvestigationReport(input), "saved_parent_plan_conflict");
  });

  it.each([
    ["issue-verify", "verification"],
    ["reproduction-setup", "reproduction"],
    ["issue-fix", "fix"],
    ["feature-implement", "implementation"],
  ] as const)(
    "keeps the Issue snapshot parent plan when %s explicitly selects a source commit",
    (taskKind, planKind) => {
      const { input, result, parentPlan } = parentPlanFixture(false);
      const prior = input.task.subjects[0]!;
      const source = {
        id: "synthetic-selected-source",
        kind: "source_commit" as const,
        repositoryId: prior.repositoryId,
        workItemId: prior.workItemId,
        revisionKey: "6".repeat(64),
        commitSha: "5".repeat(40),
      };
      input.task.kind = taskKind;
      input.task.workItem.kind = "issue";
      parentPlan.kind = planKind;
      const { digest: _digest, sourceReportRef: _source, state: _state, ...draft } = parentPlan;
      parentPlan.digest = investigationContentDigest(draft);
      input.task.planRef = {
        id: parentPlan.id,
        version: parentPlan.version,
        digest: parentPlan.digest,
      };
      result.plans = [structuredClone(parentPlan)];
      input.task.subjects = [
        {
          id: prior.id,
          kind: "issue_snapshot",
          repositoryId: prior.repositoryId,
          workItemId: prior.workItemId,
          revisionKey: prior.revisionKey,
          snapshotDigest: "4".repeat(64),
        },
        source,
      ];
      input.task.subjectRef = source.id;
      input.task.executionPolicy.allowedSubjectRefs = [prior.id, source.id];
      result.context.workItem = structuredClone(input.task.workItem);
      result.context.subjects = structuredClone(input.task.subjects);
      result.context.task.kind = input.task.kind;
      result.context.task.subjectRef = source.id;
      input.checkpoint.subjectRevisionKey = source.revisionKey;
      input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
      result.findings = [];
      result.report.loop.candidates = [];
      result.report.recheck = {
        finalFindingCount: 0,
        validFinalVersionRecheckCount: 0,
        pendingFindingIds: [],
        records: [],
      };
      result.report.collections.findings = 0;
      result.report.collections.candidates = 0;
      result.report.collections.rechecks = 0;
      input.checkpoint.analysis.findings = [];
      input.checkpoint.analysis.candidates = [];
      input.checkpoint.analysis.rechecks = [];
      result.assessment = {
        kind: "other_issue",
        subjectRef: source.id,
        summary: "The saved Issue plan is bound to the explicitly selected source.",
        evidenceRefs: [],
        classification: "source_selected",
        explanation:
          "The immutable source selection preserves the saved plan's original Issue snapshot and report.",
      };
      input.checkpoint.analysis.assessment = structuredClone(result.assessment);
      result.validation.checks = result.validation.checks.map((check) => ({
        ...check,
        subjectRef: source.id,
        planRef: input.task.planRef,
      }));
      if (taskKind === "issue-fix" || taskKind === "feature-implement") {
        input.task.executionPolicy = {
          mode: "execute",
          allowedSubjectRefs: [prior.id, source.id],
          allowRepositoryExecution: true,
          authorizationRef: "synthetic-issue-source-authorization",
        };
        const patch = {
          id: "synthetic-selected-source-patch",
          kind: "local_patch" as const,
          repositoryId: source.repositoryId,
          workItemId: source.workItemId,
          revisionKey: "8".repeat(64),
          baseSubjectRef: source.id,
          baseSha: source.commitSha,
          patchDigest: "7".repeat(64),
          artifactRef: "synthetic-selected-patch-artifact",
        };
        const artifact = {
          id: patch.artifactRef,
          taskId: input.task.id,
          attemptId: input.attempt.id,
          subjectRef: patch.id,
          kind: "patch" as const,
          name: "selected-source.patch",
          mediaType: "text/x-diff",
          digest: patch.patchDigest,
          byteLength: 42,
          availability: "available" as const,
        };
        const observation = {
          id: "synthetic-selected-patch-observation",
          subjectRef: patch.id,
          source: "executor_observation" as const,
          authority: "worker" as const,
          summary: "The saved Issue plan was verified on the explicitly derived patch.",
          artifactRefs: [artifact.id],
          evidenceRefs: [],
          provenance: {
            taskId: input.task.id,
            attemptId: input.attempt.id,
            producer: "synthetic-executor",
            recordedAt: input.checkpoint.recordedAt,
          },
        };
        input.checkpoint.runtime.subjects.push(structuredClone(patch));
        input.checkpoint.runtime.artifacts.push(structuredClone(artifact));
        input.checkpoint.runtime.evidence.push(structuredClone(observation));
        result.context.subjects.push(structuredClone(patch));
        result.artifacts.push(structuredClone(artifact));
        result.verificationEvidence.push(structuredClone(observation));
        result.report.collections.artifacts += 1;
        result.report.collections.verificationEvidence += 1;
        result.validation.checks = result.validation.checks.map((check) => ({
          ...check,
          subjectRef: patch.id,
          status: "passed" as const,
          executor: "synthetic-executor",
          evidenceRefs: [observation.id],
          authoritativeAttemptId: input.attempt.id,
        }));
      }
      input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
      input.checkpoint.runtime.checks = structuredClone(result.validation.checks);
      sealCheckpoint(input.checkpoint);
      sealResult(result);
      const next = {
        ...submission(result, input.checkpoint, input.task, input.attempt),
        parentPlan,
      };
      expect(assembleInvestigationReport(next)).toEqual(result);
      expect(assembleInvestigationReport(next).plans[0]!.subjectRef).toBe(prior.id);
    },
  );

  it("allows worker validation on a derived patch while preserving the original PR subject", () => {
    const { input, result } = derivedPatchFixture();
    const assembled = assembleInvestigationReport(input);
    expect(assembled).toEqual(result);
    expect(assembled.context.task.subjectRef).toBe(input.task.subjectRef);
    expect(assembled.validation.checks.at(-1)!.subjectRef).toBe("synthetic-derived-patch");
    expect(assembled.assessment.subjectRef).toBe(input.task.subjectRef);
  });

  it("binds mutation checks to the saved base plan without moving findings onto the derived patch", () => {
    const { input, result } = derivedPatchFixture();
    removePrSourceFixture(input, result);
    const original = input.task.subjects[0]!;
    if (original.kind !== "original_pr") throw new Error("Fixture original source is missing.");
    input.task.subjects[0] = {
      id: original.id,
      kind: "source_commit",
      repositoryId: original.repositoryId,
      workItemId: original.workItemId,
      revisionKey: original.revisionKey,
      commitSha: original.headSha,
    };
    input.task.kind = "issue-fix";
    input.task.workItem.kind = "issue";
    const parentPlan = structuredClone(result.plans[0]!);
    parentPlan.kind = "fix";
    parentPlan.sourceReportRef = { id: "synthetic-fix-parent-report", version: 1 };
    parentPlan.steps[0]!.checkIds.push("synthetic-patch-check");
    const { digest: _digest, sourceReportRef: _source, state: _state, ...draft } = parentPlan;
    parentPlan.digest = investigationContentDigest(draft);
    const ref = { id: parentPlan.id, version: parentPlan.version, digest: parentPlan.digest };
    input.task.parentTaskId = "synthetic-fix-parent-task";
    input.task.parentReportRef = { ...parentPlan.sourceReportRef, digest: "3".repeat(64) };
    input.task.planRef = ref;
    input.checkpoint.taskBindingDigest = investigationTaskBindingDigest(input.task);
    input.checkpoint.analysis.plans = [];
    input.checkpoint.analysis.nextActions = [];
    result.nextActions = [];
    result.report.collections.nextActions = 0;
    result.plans = [parentPlan];
    for (const finding of result.findings) {
      finding.fixRecommendation.planRef = ref;
    }
    input.checkpoint.analysis.findings = structuredClone(result.findings);
    result.validation.checks = result.validation.checks.map((check) => ({
      ...check,
      planRef: ref,
    }));
    input.checkpoint.runtime.checks = structuredClone(result.validation.checks);
    result.assessment = {
      kind: "bug",
      subjectRef: original.id,
      summary: "The original source defect is confirmed and the local patch is separately tested.",
      evidenceRefs: [...input.checkpoint.analysis.assessment.evidenceRefs],
      bugAssessment: {
        status: "confirmed",
        rationale: "The original source findings remain supported by their static evidence.",
        missingInformation: [],
        hypotheses: [],
        upstreamFix: null,
        duplicateOf: null,
        expectedBehavior: null,
      },
      reproduction: {
        status: "not_run",
        summary: "The original source was not executed by this synthetic fixture.",
        evidenceRefs: [],
        planRef: null,
      },
    };
    input.checkpoint.analysis.assessment = structuredClone(result.assessment);
    result.context.workItem = structuredClone(input.task.workItem);
    result.context.task = {
      id: input.task.id,
      kind: input.task.kind,
      parentTaskId: input.task.parentTaskId,
      subjectRef: input.task.subjectRef,
    };
    result.context.parentReportRef = structuredClone(input.task.parentReportRef);
    result.context.subjects = [
      ...structuredClone(input.task.subjects),
      ...structuredClone(input.checkpoint.runtime.subjects),
    ];
    sealCheckpoint(input.checkpoint);
    sealResult(result);
    const next = { ...submission(result, input.checkpoint, input.task, input.attempt), parentPlan };
    expect(assembleInvestigationReport(next)).toEqual(result);
    expect(
      assembleInvestigationReport(next).findings.every(
        (finding) => finding.subjectRef === original.id,
      ),
    ).toBe(true);
  });

  it("rejects derived patch execution with a mismatched immutable base or missing artifact", () => {
    for (const mutation of ["base", "artifact"] as const) {
      const { input, result } = derivedPatchFixture();
      if (mutation === "base") {
        const patch = input.checkpoint.runtime.subjects[0]!;
        if (patch.kind !== "local_patch") throw new Error("Fixture patch subject is missing.");
        patch.baseSha = "0".repeat(40);
        result.context.subjects = [
          ...structuredClone(input.task.subjects),
          ...structuredClone(input.checkpoint.runtime.subjects),
        ];
      } else {
        input.checkpoint.runtime.artifacts.find((entry) => entry.kind === "patch")!.availability =
          "missing";
        result.artifacts = structuredClone(input.checkpoint.runtime.artifacts);
      }
      sealCheckpoint(input.checkpoint);
      sealResult(result);
      expectCode(
        () =>
          assembleInvestigationReport(
            submission(result, input.checkpoint, input.task, input.attempt),
          ),
        "unauthorized_derived_patch",
      );
    }
  });
});
