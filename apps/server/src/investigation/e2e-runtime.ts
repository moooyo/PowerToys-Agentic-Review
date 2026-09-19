import {
  type InvestigationLoopCheckpointV1,
  type InvestigationRuntimeState,
  type InvestigationTaskV1,
  validateInvestigationE2eBindings,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { requireCondition } from "./errors.js";

/** Root E2E uses Worker receipts rather than a model-authored saved executable plan. */
export function validateRootE2eRuntime(
  task: InvestigationTaskV1,
  checkpoint: InvestigationLoopCheckpointV1,
  runtime: InvestigationRuntimeState,
): void {
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  requireCondition(
    task.kind === "pr-e2e" &&
      task.parentTaskId === null &&
      task.parentReportRef === null &&
      task.planRef === null &&
      task.executionPolicy.mode === "execute" &&
      task.executionPolicy.allowRepositoryExecution &&
      task.executionPolicy.authorizationRef !== null &&
      subject?.kind === "original_pr" &&
      runtime.e2eExecution !== undefined &&
      runtime.subjects.length === 0 &&
      runtime.startedSteps.length === 0 &&
      runtime.completedSteps.length === 0 &&
      runtime.completedStepIds.length === 0,
    400,
    "e2e_execution_binding_invalid",
    "Root E2E execution must retain its authorized original PR subject and Worker feature receipts, without saved-plan or derived-source records.",
  );
  const marker = runtime.e2eExecution;
  const previousMarker = checkpoint.runtime.e2eExecution;
  requireCondition(
    (previousMarker === undefined
      ? marker.attemptId === checkpoint.attemptId &&
        marker.status === "started" &&
        marker.completedAt === null &&
        runtime.e2e === undefined &&
        runtime.evidence.length === checkpoint.runtime.evidence.length &&
        runtime.artifacts.length === checkpoint.runtime.artifacts.length
      : marker.attemptId === previousMarker.attemptId &&
        marker.startedAt === previousMarker.startedAt &&
        (previousMarker.status !== "completed" ||
          investigationContentDigest(marker) === investigationContentDigest(previousMarker))) &&
      checkpoint.adoptedAttemptIds.includes(marker.attemptId) &&
      (marker.status === "completed"
        ? marker.completedAt !== null &&
          Date.parse(marker.completedAt) >= Date.parse(marker.startedAt) &&
          runtime.e2e !== undefined
        : marker.completedAt === null && runtime.e2e === undefined),
    409,
    "e2e_execution_lifecycle_invalid",
    "E2E must durably start before side effects, preserve its originating attempt, and complete only with accepted execution results.",
  );
  if (previousMarker !== undefined && previousMarker.attemptId !== checkpoint.attemptId)
    requireCondition(
      investigationContentDigest(runtime) === investigationContentDigest(checkpoint.runtime),
      409,
      "e2e_execution_restart_forbidden",
      "An interrupted E2E attempt cannot silently resume desktop side effects. Request a new task to rerun.",
    );
  if (checkpoint.runtime.e2e !== undefined)
    requireCondition(
      runtime.e2e !== undefined &&
        investigationContentDigest(runtime.e2e) ===
          investigationContentDigest(checkpoint.runtime.e2e),
      409,
      "e2e_result_immutable",
      "Accepted E2E execution results cannot be replaced during analysis or report recovery.",
    );
  if (runtime.e2e !== undefined) {
    const errors = validateInvestigationE2eBindings({
      e2e: runtime.e2e,
      taskId: task.id,
      taskKind: task.kind,
      subjectRef: task.subjectRef,
      headSha: subject.headSha,
      completed: false,
      artifacts: runtime.artifacts,
      evidence: runtime.evidence,
    });
    requireCondition(errors.length === 0, 400, "e2e_evidence_invalid", errors.join(" "));
  }
  requireCondition(
    runtime.evidence.every(
      (entry) =>
        entry.authority === "worker" &&
        entry.subjectRef === subject.id &&
        entry.provenance.taskId === task.id &&
        checkpoint.adoptedAttemptIds.includes(entry.provenance.attemptId) &&
        entry.provenance.producer === "e2e-tool-server" &&
        ["executor_observation", "visual_observation"].includes(entry.source),
    ) &&
      runtime.artifacts.every(
        (entry) =>
          entry.taskId === task.id &&
          entry.subjectRef === subject.id &&
          checkpoint.adoptedAttemptIds.includes(entry.attemptId) &&
          ["log", "image", "video"].includes(entry.kind),
      ),
    400,
    "e2e_observation_scope_invalid",
    "E2E artifacts and observations must originate from the authorized Worker tool service and exact task revision.",
  );
  if (runtime.e2e === undefined) {
    requireCondition(
      runtime.checks.length === checkpoint.runtime.checks.length,
      400,
      "e2e_partial_checks_invalid",
      "In-progress E2E observations cannot claim final feature checks before the complete result.",
    );
    return;
  }
  const priorChecks = new Map(checkpoint.runtime.checks.map((check) => [check.id, check]));
  const assertions = new Map(
    runtime.e2e.features.flatMap((feature) =>
      feature.assertions.map(
        (assertion) => [assertion.id, { assertion, featureId: feature.id }] as const,
      ),
    ),
  );
  requireCondition(
    runtime.checks.every((check) => {
      const prior = priorChecks.get(check.id);
      if (prior !== undefined)
        return investigationContentDigest(prior) === investigationContentDigest(check);
      const expected = assertions.get(check.id);
      return (
        expected !== undefined &&
        check.scenarioId === expected.featureId &&
        check.subjectRef === subject.id &&
        check.planRef === null &&
        check.required &&
        check.status === expected.assertion.outcome &&
        investigationContentDigest(check.evidenceRefs) ===
          investigationContentDigest(expected.assertion.evidenceRefs) &&
        (check.evidenceRefs.length === 0
          ? check.executor === null && check.authoritativeAttemptId === null
          : check.executor === "e2e-tool-server" &&
            check.authoritativeAttemptId === checkpoint.attemptId &&
            check.evidenceRefs.every((id) =>
              runtime.evidence.some(
                (entry) =>
                  entry.id === id &&
                  entry.provenance.attemptId === checkpoint.attemptId &&
                  entry.source === "executor_observation",
              ),
            ))
      );
    }) && [...assertions.keys()].every((id) => runtime.checks.some((check) => check.id === id)),
    400,
    "e2e_assertion_check_mismatch",
    "Every E2E feature assertion must match its Worker validation check, outcome, producing attempt, and observed evidence.",
  );
}
