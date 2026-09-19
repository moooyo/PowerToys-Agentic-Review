import {
  createInvestigationPreview,
  type InvestigationLoopCheckpointV1,
} from "@agentic-review/contracts";
import {
  createInvestigationCheckpoint,
  interruptInvestigationLoop,
  investigationContentDigest,
} from "@agentic-review/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  attemptHasVerifiedNoModelInvocation,
  recordAttemptWithoutModelInvocation,
} from "../../dist/investigation/attempt-usage-coverage.js";
import { InvestigationStore } from "../../dist/investigation/store.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const store = new InvestigationStore();
  stores.push(store);
  const { task, attempt } = createInvestigationPreview("pr");
  // Preview fixtures describe completed reports. A newly claimed source-preparation
  // attempt must instead begin with the pending scope persisted by createTask.
  task.scope = {
    ...task.scope,
    includedUnits: task.scope.includedUnits.map((unit) => ({
      ...unit,
      status: "pending" as const,
      evidenceRefs: [],
    })),
    completedUnitRefs: [],
    unresolvedUnitRefs: task.scope.includedUnits.map((unit) => unit.id),
  };
  const initial = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "source-failure",
    leaseVersion: 1,
    recordedAt: "2026-09-19T00:00:00Z",
  });
  const checkpoint = interruptInvestigationLoop(initial, "blocked", initial.recordedAt, [
    {
      id: "source-preparation-error",
      code: "SOURCE_TREE_UNSUPPORTED",
      category: "blocker",
      message: "A required source or trusted execution prerequisite was unavailable.",
      retryable: true,
      evidenceRefs: [],
      prerequisiteRefs: [],
    },
  ]);
  const acceptedKey = `checkpoint:${attempt.id}:interrupt:${"a".repeat(64)}`;
  const save = (value = checkpoint) =>
    store.put("idempotency", acceptedKey, { digest: "a".repeat(64), checkpoint: value });
  return { store, task, attempt, checkpoint, save };
}
function reseal(checkpoint: InvestigationLoopCheckpointV1): InvestigationLoopCheckpointV1 {
  const { digest: _digest, ...content } = checkpoint;
  return { ...content, digest: investigationContentDigest(content) };
}

describe("verified attempts without model dispatch", () => {
  it("reads the original accepted source-failure receipt instead of a resumed current checkpoint", () => {
    const f = fixture();
    f.save();
    f.store.put("checkpoints", f.task.id, {
      ...f.checkpoint,
      attemptId: "resumed-attempt",
      round: 1,
      consumed: { ...f.checkpoint.consumed, rounds: 1, tokens: 386035 },
    });
    expect(attemptHasVerifiedNoModelInvocation(f.store, f.task.id, f.attempt.id, 1)).toBe(true);
    expect(attemptHasVerifiedNoModelInvocation(f.store, f.task.id, f.attempt.id, 2)).toBe(false);
    expect(attemptHasVerifiedNoModelInvocation(f.store, "other-task", f.attempt.id, 1)).toBe(false);
  });
  it("does not infer zero calls from a current checkpoint without an accepted interrupt receipt", () => {
    const f = fixture();
    f.store.put("checkpoints", f.task.id, f.checkpoint);
    expect(attemptHasVerifiedNoModelInvocation(f.store, f.task.id, f.attempt.id, 1)).toBe(false);
  });
  it.each([
    "unknown usage",
    "model execution",
    "already inspected scope",
    "generic source error",
    "lease expiry",
    "broken digest",
  ])("retains uncertainty for %s", (mutation) => {
    const f = fixture();
    const checkpoint = structuredClone(f.checkpoint);
    if (mutation === "unknown usage")
      checkpoint.runtime.unacceptedModelUsage = [
        { attemptId: f.attempt.id, round: 1, tokens: null },
      ];
    if (mutation === "model execution")
      checkpoint.runtime.modelExecutions = [
        { attemptId: f.attempt.id, round: 1, engine: "codex", model: null },
      ];
    if (mutation === "already inspected scope")
      checkpoint.analysis.coverage.includedUnits[0]!.status = "completed";
    if (mutation === "generic source error")
      checkpoint.analysis.diagnostics[0]!.code = "SOURCE_UNAVAILABLE";
    if (mutation === "lease expiry") checkpoint.analysis.diagnostics[0]!.code = "LEASE_EXPIRED";
    const sealed = reseal(checkpoint);
    f.save(mutation === "broken digest" ? { ...sealed, digest: "0".repeat(64) } : sealed);
    expect(attemptHasVerifiedNoModelInvocation(f.store, f.task.id, f.attempt.id, 1)).toBe(false);
  });
  it("binds explicit pre-dispatch proof to the original task, attempt and lease", () => {
    const f = fixture();
    recordAttemptWithoutModelInvocation(f.store, f.checkpoint);
    expect(attemptHasVerifiedNoModelInvocation(f.store, f.task.id, f.attempt.id, 1)).toBe(true);
    expect(attemptHasVerifiedNoModelInvocation(f.store, f.task.id, f.attempt.id, 2)).toBe(false);
    expect(attemptHasVerifiedNoModelInvocation(f.store, f.task.id, "another-attempt", 1)).toBe(
      false,
    );
  });
});
