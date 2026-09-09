import type * as C from "@agentic-review/contracts";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import type { ModelCliFixture } from "./model-cli.testing.js";

/** Synthetic runner observations only; no command, CLI, or successful claim runs. */
export function validationSummaryInputRequest(
  fixture: ModelCliFixture,
  arm: "baseline" | "candidate" = "baseline",
): C.FreezeValidationSummaryInputRequest {
  const cell = fixture.cells.find((value) => value.arm === arm);
  if (!cell) throw new Error("The synthetic cell is missing.");
  const template = createEvaluationExecutionTemplate({
    runId: cell.run_id,
    plan: cell.plan,
    planDigest: cell.plan_digest,
    frozenPrompt: cell.prompt,
  });
  const validation = template.validation;
  const checkId = `${validation.profileVersion.id}:compile`;
  const lease = fixture.lease(arm);
  return {
    lease,
    inputId: `summary-${arm}`,
    context: {
      schemaVersion: "ValidationSummaryContextV1",
      runId: validation.runId,
      requestId: validation.requestId,
      jobId: lease.jobId,
      runAttemptId: lease.runAttemptId,
      githubRepositoryId: template.repository.githubRepositoryId,
      profileVersionId: validation.profileVersion.id,
      revisionKey: validation.revisionKey,
      planDigest: validation.planDigest,
      testedSourceRevision: validation.testedSourceRevision,
      report: {
        schemaVersion: "ValidationReportV1",
        workItemKind: "issue",
        source: "worker",
        sourceState: "original",
        summary: "Synthetic compiler observations before model summarization.",
        reproductionConclusion: "inconclusive",
        checks: [
          {
            id: checkId,
            name: "Compile the frozen source",
            kind: "build",
            required: true,
            outcome: "failed",
            summary: "The synthetic compile step failed.",
            expected: null,
            actual: null,
            evidenceIds: [],
            source: "runner",
          },
        ],
      },
      execution: {
        blockers: [],
        diagnostics: [
          {
            stepId: checkId,
            phase: "build",
            outcome: "failed",
            exitCode: 1,
            summary: "Synthetic compiler exit.",
          },
        ],
        cleanupState: "not_needed",
      },
      evidence: { assets: [], scenarios: [] },
      ...(validation.reproduction === undefined ? {} : { reproduction: validation.reproduction }),
    },
  };
}
