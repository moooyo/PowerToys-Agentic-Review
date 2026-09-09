import { createCanonicalResult } from "@agentic-review/codex";
import {
  type IssueReproductionRequestAssessmentV1,
  type JobExecutionEnvelopeV2,
  type ReproductionObservationFact,
  type TestProbeReceiptV1,
  TestProbeReceiptV1Schema,
  type ValidationExecutionDetails,
  type ValidationReportV1,
} from "@agentic-review/contracts";
import {
  aggregateIssueReproductionRequest,
  deriveIssueReproductionCaseExecutions,
  evaluateIssueReproductionCases,
  validateEvaluationIssueReproductionBinding,
  validateFrozenIssueReproductionBinding,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import {
  type CapturedTestProbeOutput,
  containsUnsafeObservationValue,
} from "./test-probe-capture.js";
import type { ValidationSummaryEvidenceContext } from "./validation-summary-executor.js";

export interface ValidationObservationResults {
  readonly probeReceipts?: TestProbeReceiptV1[];
  readonly reproductionAssessment?: IssueReproductionRequestAssessmentV1;
}

/** Bind safe, complete captures to the current immutable attempt before invoking any model. */
export function createTestProbeReceipts(
  envelope: JobExecutionEnvelopeV2,
  report: ValidationReportV1,
  execution: ValidationExecutionDetails,
  captures: readonly CapturedTestProbeOutput[] | undefined,
): TestProbeReceiptV1[] | undefined {
  const context = envelope.validation;
  const declared = context.profileVersion.config.test.filter(
    (step) => step.probeOutput !== undefined,
  );
  if (declared.length === 0 && captures === undefined) return undefined;
  const pending = new Map((captures ?? []).map((capture) => [capture.checkId, capture]));
  if (pending.size !== (captures?.length ?? 0)) throw new Error("Duplicate test probe captures.");
  const receipts: TestProbeReceiptV1[] = [];
  for (const step of declared) {
    const checkId = `${context.profileVersion.id}:${step.id}`;
    const check = report.checks.find((entry) => entry.id === checkId);
    const diagnostic = execution.diagnostics.find((entry) => entry.stepId === checkId);
    const capture = pending.get(checkId);
    pending.delete(checkId);
    if (check?.outcome !== "passed") {
      if (capture !== undefined) throw new Error("An unsuccessful probe cannot provide a receipt.");
      continue;
    }
    if (
      capture === undefined ||
      check.source !== "runner" ||
      check.kind !== "test" ||
      diagnostic?.phase !== "test" ||
      diagnostic.outcome !== "passed" ||
      diagnostic.exitCode !== 0
    )
      throw new Error("A successful declared probe requires a complete settled capture.");
    const receipt: TestProbeReceiptV1 = {
      schemaVersion: "TestProbeReceiptV1",
      requestId: context.requestId,
      jobId: envelope.job.jobId,
      runAttemptId: envelope.lease.runAttemptId,
      planDigest: context.planDigest,
      profileVersionId: context.profileVersion.id,
      checkId,
      capture: "complete",
      output: structuredClone(capture.output),
      outputSha256: capture.outputSha256,
    };
    if (
      !Value.Check(TestProbeReceiptV1Schema, receipt) ||
      createCanonicalResult(receipt.output).sha256 !== receipt.outputSha256
    )
      throw new Error("The safe probe capture has an invalid shape or digest.");
    const fields = new Map(step.probeOutput?.fields.map((field) => [field.id, field.type]));
    const seen = new Set<string>();
    for (const observation of receipt.output.observations) {
      if (
        seen.has(observation.id) ||
        !fields.has(observation.id) ||
        (observation.state === "observed" &&
          (fields.get(observation.id) !== observation.value.type ||
            containsUnsafeObservationValue(observation.value)))
      )
        throw new Error("The safe probe capture does not match its declared fields.");
      seen.add(observation.id);
    }
    if (seen.size !== fields.size) throw new Error("The safe probe capture omits declared fields.");
    receipts.push(receipt);
  }
  if (pending.size > 0) throw new Error("An undeclared probe supplied observations.");
  return receipts;
}

export function validateReproductionEnvelope(envelope: JobExecutionEnvelopeV2): void {
  const context = envelope.validation;
  if (context.reproduction === undefined) return;
  if (context.schemaVersion === "ValidationJobContextV2") {
    validateEvaluationIssueReproductionBinding(context);
    return;
  }
  const snapshot = envelope.resource.canonicalSnapshot;
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    !("githubWorkItemId" in snapshot) ||
    typeof snapshot.githubWorkItemId !== "number" ||
    !context.reproduction.binding.cases.some((entry) => entry.requestId === context.requestId)
  )
    throw new Error("The reproduction binding does not select this request.");
  validateFrozenIssueReproductionBinding(
    context.reproduction,
    [context],
    {
      activationId: context.activationId,
      repositoryId: context.repositoryId,
      githubRepositoryId: envelope.repository.githubRepositoryId,
      workItemId: context.workItemId,
      githubWorkItemId: snapshot.githubWorkItemId,
      workItemKind: envelope.resource.kind,
      issueRevisionKey: context.revisionKey,
      testedSourceRevision: context.testedSourceRevision,
      testedSourceAuthorization: context.testedSourceAuthorization,
    },
    context.requestId,
  );
}

/** Only finalized, remapped UI documents and settled probe receipts can provide actual values. */
export function createReproductionAssessment(
  envelope: JobExecutionEnvelopeV2,
  report: ValidationReportV1,
  execution: ValidationExecutionDetails,
  evidence: ValidationSummaryEvidenceContext,
  receipts: readonly TestProbeReceiptV1[] | undefined,
): IssueReproductionRequestAssessmentV1 | undefined {
  const context = envelope.validation;
  const frozen = context.reproduction;
  if (frozen === undefined) return undefined;
  validateReproductionEnvelope(envelope);
  const observations: ReproductionObservationFact[] = [];
  for (const receipt of receipts ?? []) {
    const step = context.profileVersion.config.test.find(
      (entry) => receipt.checkId === `${context.profileVersion.id}:${entry.id}`,
    );
    if (step === undefined) throw new Error("Unknown probe receipt check.");
    for (const observation of receipt.output.observations) {
      const fact = {
        observation: {
          kind: "probe_value" as const,
          testStepId: step.id,
          observationId: observation.id,
        },
        checkId: receipt.checkId,
        evidenceIds: [],
      };
      observations.push(
        observation.state === "observed"
          ? { ...fact, state: "observed", value: observation.value }
          : { ...fact, state: "unavailable", reason: "unsafe_value" },
      );
    }
  }
  for (const scenario of evidence.scenarios) {
    const documents = evidence.assets.filter(
      (asset) => asset.metadata.checkId === scenario.checkId && asset.metadata.kind === "steps",
    );
    if (documents.length !== 1) throw new Error("The finalized scenario document is ambiguous.");
    for (const step of scenario.execution.steps) {
      if (!("capture" in step)) continue;
      const fact = {
        observation: {
          kind: "ui_assertion" as const,
          scenarioId: scenario.execution.scenarioId,
          stepId: step.stepId,
        },
        checkId: scenario.checkId,
        evidenceIds: [...documents.map((entry) => entry.id), ...step.evidenceIds].sort(),
      };
      if (step.capture?.state !== "complete" || step.actual === null) {
        observations.push({
          ...fact,
          state: "unavailable",
          reason:
            step.capture?.state === "unavailable" ? step.capture.reason : "capture_unavailable",
        });
      } else if (typeof step.actual === "boolean") {
        observations.push({
          ...fact,
          state: "observed",
          value: { type: "boolean", value: step.actual },
        });
      } else {
        observations.push({
          ...fact,
          state: "observed",
          value: { type: "string", value: step.actual },
        });
      }
    }
  }
  const unavailableChecks = report.checks
    .filter(
      (check) =>
        check.kind === "ui" &&
        check.outcome !== "not_run" &&
        !evidence.scenarios.some((scenario) => scenario.checkId === check.id),
    )
    .map((check) => check.id);
  const executions = deriveIssueReproductionCaseExecutions({
    frozen,
    planDigest: context.planDigest,
    request: context,
    issueRevisionKey: context.revisionKey,
    testedSourceCommit: context.testedSourceRevision?.headSha ?? "",
    report,
    execution,
    observations,
    evidenceComplete: true,
    evidenceUnavailableCheckIds: unavailableChecks,
  });
  return aggregateIssueReproductionRequest(
    frozen,
    context.planDigest,
    context.requestId,
    evaluateIssueReproductionCases(frozen.binding, executions).filter(
      (entry) => entry.requestId === context.requestId,
    ),
  );
}
