import type { InvestigationLoopCheckpointV1 } from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import type { InvestigationStore } from "./store.js";

const key = (attemptId: string) => `attempt-model-coverage:${attemptId}`;
interface NoModelInvocationReceipt {
  readonly taskId: string;
  readonly attemptId: string;
  readonly state: "not_started";
  readonly leaseVersion: number;
  readonly checkpointRef: {
    readonly id: string;
    readonly version: number;
    readonly digest: string;
  };
}

/** Called only after the original Worker lease and pre-dispatch interrupt were checked. */
export function recordAttemptWithoutModelInvocation(
  store: InvestigationStore,
  checkpoint: InvestigationLoopCheckpointV1,
): void {
  store.put<NoModelInvocationReceipt>("idempotency", key(checkpoint.attemptId), {
    taskId: checkpoint.taskId,
    attemptId: checkpoint.attemptId,
    state: "not_started",
    leaseVersion: checkpoint.leaseVersion,
    checkpointRef: { id: checkpoint.id, version: checkpoint.version, digest: checkpoint.digest },
  });
}

/** Absence of a ledger row is not evidence. Require a positive Worker receipt or a narrow legacy proof. */
export function attemptHasVerifiedNoModelInvocation(
  store: InvestigationStore,
  taskId: string,
  attemptId: string,
  leaseVersion: number,
): boolean {
  const explicit = store.get<NoModelInvocationReceipt>("idempotency", key(attemptId));
  if (
    explicit?.taskId === taskId &&
    explicit.attemptId === attemptId &&
    explicit.leaseVersion === leaseVersion &&
    explicit.state === "not_started"
  )
    return true;
  const prefix = `checkpoint:${attemptId}:interrupt:`;
  let cursor: string | undefined;
  for (;;) {
    const page = store.pagePrefix<{ digest: string; checkpoint: InvestigationLoopCheckpointV1 }>(
      "idempotency",
      prefix,
      1_000,
      false,
      cursor,
    );
    if (
      page.some((receipt) =>
        legacySourcePreparationFailure(receipt.checkpoint, taskId, attemptId, leaseVersion),
      )
    )
      return true;
    if (page.length < 1_000) return false;
    cursor = `${prefix}${page.at(-1)!.digest}`;
  }
}

/** This exact legacy failure can only occur while parsing Git tree entries before checkout completes. */
function legacySourcePreparationFailure(
  checkpoint: InvestigationLoopCheckpointV1,
  taskId: string,
  attemptId: string,
  leaseVersion: number,
): boolean {
  if (
    checkpoint.taskId !== taskId ||
    checkpoint.attemptId !== attemptId ||
    checkpoint.leaseVersion !== leaseVersion ||
    checkpoint.stopReason !== "blocked" ||
    checkpoint.round !== 0 ||
    checkpoint.lastPhase !== null ||
    checkpoint.consumed.rounds !== 0 ||
    checkpoint.consumed.tokens !== 0
  )
    return false;
  const { analysis, runtime } = checkpoint;
  const preparationOnly =
    analysis.summary === "Investigation has not started." &&
    analysis.findings.length === 0 &&
    analysis.candidates.length === 0 &&
    analysis.rechecks.length === 0 &&
    analysis.evidence.length === 0 &&
    analysis.plans.length === 0 &&
    analysis.nextActions.length === 0 &&
    analysis.feedbackDrafts.length === 0 &&
    analysis.limitations.length === 0 &&
    analysis.coverage.includedUnits.every(
      (unit) => unit.status === "pending" && unit.evidenceRefs.length === 0,
    ) &&
    analysis.diagnostics.length > 0 &&
    analysis.diagnostics.every(
      (diagnostic) =>
        diagnostic.code === "SOURCE_TREE_UNSUPPORTED" &&
        diagnostic.category === "blocker" &&
        diagnostic.message ===
          "A required source or trusted execution prerequisite was unavailable." &&
        diagnostic.evidenceRefs.length === 0 &&
        diagnostic.prerequisiteRefs.length === 0,
    ) &&
    (runtime.modelExecutions ?? []).length === 0 &&
    (runtime.unacceptedModelUsage ?? []).length === 0 &&
    runtime.e2e === undefined &&
    runtime.e2eExecution === undefined &&
    runtime.sourceCoverage === undefined &&
    runtime.startedSteps.length === 0 &&
    runtime.completedSteps.length === 0 &&
    runtime.completedStepIds.length === 0 &&
    runtime.evidence.length === 0 &&
    runtime.artifacts.length === 0 &&
    runtime.checks.length === 0 &&
    runtime.subjects.length === 0;
  if (!preparationOnly) return false;
  const { digest, ...content } = checkpoint;
  return digest === investigationContentDigest(content);
}
