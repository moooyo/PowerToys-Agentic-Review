import {
  type InvestigationAnalysisV1,
  type InvestigationDiagnostic,
  type InvestigationLoopCheckpointV1,
  type InvestigationOutcome,
  type InvestigationTaskV1,
  validateInvestigationE2eBindings,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "./investigation-loop.js";

/** Project only durable Worker observations; unrecorded model text cannot change recovery. */
export function projectRecordedE2eAnalysis(
  task: InvestigationTaskV1,
  checkpoint: InvestigationLoopCheckpointV1,
  _suppliedSummary?: string,
): { analysis: InvestigationAnalysisV1; outcome: InvestigationOutcome } {
  const runtime = checkpoint.runtime;
  const e2e = runtime.e2e;
  const execution = runtime.e2eExecution;
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  if (
    task.kind !== "pr-e2e" ||
    task.parentTaskId !== null ||
    task.parentReportRef !== null ||
    task.planRef !== null ||
    checkpoint.taskId !== task.id ||
    subject?.kind !== "original_pr" ||
    e2e === undefined ||
    e2e.features.length === 0 ||
    !e2e.cleanup.confirmed ||
    execution?.status !== "completed" ||
    execution.completedAt === null ||
    !checkpoint.adoptedAttemptIds.includes(execution.attemptId)
  ) {
    throw new Error(
      "Final E2E analysis requires a completed recorded root PR execution and confirmed cleanup.",
    );
  }
  const outcome: InvestigationOutcome = e2e.features.some((feature) => feature.outcome === "failed")
    ? "failed"
    : e2e.features.every((feature) => feature.outcome === "passed")
      ? "completed"
      : "blocked";
  if (
    validateInvestigationE2eBindings({
      e2e,
      taskId: task.id,
      taskKind: task.kind,
      subjectRef: task.subjectRef,
      headSha: subject.headSha,
      completed: outcome === "completed",
      artifacts: runtime.artifacts,
      evidence: runtime.evidence,
    }).length > 0
  ) {
    throw new Error("Recorded E2E analysis must retain its exact PR revision and Worker evidence.");
  }

  const allEvidence = [...new Set(runtime.evidence.map((evidence) => evidence.id))];
  const coverage = structuredClone(task.scope);
  for (const unit of coverage.includedUnits) {
    unit.status = outcome === "completed" ? "completed" : "blocked";
    unit.evidenceRefs = [...allEvidence];
  }
  coverage.completedUnitRefs = coverage.includedUnits
    .filter((unit) => unit.status === "completed")
    .map((unit) => unit.id);
  coverage.unresolvedUnitRefs = coverage.includedUnits
    .filter((unit) => unit.status !== "completed")
    .map((unit) => unit.id);
  const summary = `E2E ${outcome}: ${e2e.features.map((feature) => `${feature.title} (${feature.outcome})`).join("; ")}`;
  const diagnostics = structuredClone(checkpoint.analysis.diagnostics);
  const code = outcome === "failed" ? "E2E_ASSERTION_FAILED" : "E2E_COVERAGE_BLOCKED";
  if (outcome !== "completed" && !diagnostics.some((entry) => entry.code === code)) {
    const diagnostic: Omit<InvestigationDiagnostic, "id"> = {
      code,
      category: outcome === "failed" ? "error" : "blocker",
      message:
        "E2E coverage is incomplete or a runtime assertion failed. The feature matrix records exact results and missing prerequisites.",
      retryable: false,
      evidenceRefs: [...allEvidence],
      prerequisiteRefs: [],
    };
    diagnostics.push({
      id: `e2e-diagnostic:${investigationContentDigest({
        taskId: task.id,
        headSha: e2e.headSha,
        diagnostic,
      })}`,
      ...diagnostic,
    });
  }

  const analysis: InvestigationAnalysisV1 = {
    ...structuredClone(checkpoint.analysis),
    summary,
    coverage,
    diagnostics,
    assessment: {
      kind: "pr",
      subjectRef: task.subjectRef,
      summary,
      evidenceRefs: [...allEvidence],
      reviewConclusion: {
        status: "inconclusive",
        rationale:
          "This task reports runtime E2E verification; it does not replace static code review.",
      },
      e2eAssessment: {
        level: "not_needed",
        rationale:
          outcome === "completed"
            ? "All required E2E feature assertions and media were observed for this revision."
            : "E2E execution did not verify all required behavior; consult the feature results.",
        planRef: null,
        scenarioIds: e2e.features.map((feature) => feature.id),
        prerequisiteRefs: [],
        linkedValidationReportRefs: [],
      },
    },
    limitations: e2e.features.flatMap((feature) =>
      feature.limitations.map((description, index) => {
        const limitation = {
          description,
          impact: `E2E coverage for ${feature.title}.`,
          evidenceRefs: [
            ...new Set(feature.assertions.flatMap((assertion) => assertion.evidenceRefs)),
          ],
        };
        return {
          id: `e2e-limitation:${investigationContentDigest({
            taskId: task.id,
            headSha: e2e.headSha,
            featureId: feature.id,
            index,
            limitation,
          })}`,
          ...limitation,
        };
      }),
    ),
  };
  return { analysis, outcome };
}
