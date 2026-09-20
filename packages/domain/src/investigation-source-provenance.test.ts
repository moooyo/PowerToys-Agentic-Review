import {
  createInvestigationPreview,
  type InvestigationLoopCheckpointV1,
  type InvestigationSourceProvenance,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import {
  applyInvestigationLoopRound,
  applyInvestigationRuntimeCheckpoint,
  applyInvestigationSourceProvenanceCheckpoint,
  assertInvestigationCheckpointIntegrity,
  createInvestigationCheckpoint,
  interruptInvestigationLoop,
  investigationContentDigest,
  restoreCompletedInvestigationForDelivery,
  restoreInvestigationCheckpoint,
} from "./investigation-loop.js";

const recordedAt = "2026-09-20T12:00:00.000Z";

function fixture(configure?: (task: InvestigationTaskV1) => void) {
  const { task, attempt } = createInvestigationPreview("pr", { findingCount: 0 });
  task.executionPolicy.mode = "source_read";
  task.scope.includedUnits = [
    {
      id: "primary-source",
      kind: "source_file",
      subjectRef: task.subjectRef,
      paths: ["src/main.ts"],
      requiredWork: "Inspect the complete pinned source.",
      status: "pending",
      evidenceRefs: [],
    },
  ];
  task.scope.completedUnitRefs = [];
  task.scope.unresolvedUnitRefs = ["primary-source"];
  configure?.(task);
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "source-provenance-checkpoint",
    leaseVersion: attempt.leaseVersion,
    recordedAt,
  });
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef)!;
  const sourceSha =
    subject.kind === "original_pr" || subject.kind === "remote_branch"
      ? subject.headSha
      : subject.kind === "source_commit"
        ? subject.commitSha
        : subject.kind === "local_patch"
          ? subject.baseSha
          : "b".repeat(40);
  const provenance: InvestigationSourceProvenance = {
    subjectRef: task.subjectRef,
    sourceSha,
    submodules: [
      {
        path: "deps/library",
        repository: "example/library",
        commitSha: "c".repeat(40),
        parentPath: null,
        parentCommitSha: sourceSha,
      },
      {
        path: "deps/library/vendor/core",
        repository: "example/core",
        commitSha: "d".repeat(40),
        parentPath: "deps/library",
        parentCommitSha: "c".repeat(40),
      },
    ],
  };
  const register = (value = provenance, previous = checkpoint) =>
    applyInvestigationSourceProvenanceCheckpoint(previous, value, {
      task,
      recordedAt,
      durationMs: 7,
    });
  return { task, checkpoint, provenance, register };
}

function acceptAnalysis(
  checkpoint: InvestigationLoopCheckpointV1,
  completed = true,
): InvestigationLoopCheckpointV1 {
  const analysis = structuredClone(checkpoint.analysis);
  if (completed) {
    for (const unit of analysis.coverage.includedUnits) unit.status = "completed";
    analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits.map((unit) => unit.id);
    analysis.coverage.unresolvedUnitRefs = [];
  }
  analysis.summary = completed
    ? "The complete pinned source was inspected."
    : "Source inspection is in progress.";
  return applyInvestigationLoopRound(
    checkpoint,
    {
      schemaVersion: "InvestigationLoopRoundV1",
      taskId: checkpoint.taskId,
      attemptId: checkpoint.attemptId,
      inputCheckpointRef: {
        id: checkpoint.id,
        version: checkpoint.version,
        digest: checkpoint.digest,
      },
      round: checkpoint.round + 1,
      phase: "discovery",
      analysis,
      continue: !completed,
      continuationReason: completed
        ? "The source scope is complete."
        : "The source scope requires further inspection.",
    },
    { recordedAt, usage: { tokens: 13, durationMs: 11, reportBytes: 0 } },
  );
}

describe("trusted source provenance checkpoints", () => {
  it("retains the exact dependency graph without accepting analysis or charging a model round", () => {
    const f = fixture();
    const original = structuredClone(f.checkpoint);
    const next = f.register();
    expect(f.checkpoint).toEqual(original);
    expect(next.analysis).toEqual(original.analysis);
    expect(next.round).toBe(original.round);
    expect(next.consumed.rounds).toBe(0);
    expect(next.consumed.tokens).toBe(0);
    expect(next.consumed.durationMs).toBe(7);
    expect(next.consumed.reportBytes).toBeGreaterThan(0);
    expect(next.version).toBe(original.version + 1);
    expect(next.previousCheckpointRef).toEqual({
      id: original.id,
      version: original.version,
      digest: original.digest,
    });
    expect(next.runtime.sourceProvenance).toEqual(f.provenance);
    assertInvestigationCheckpointIntegrity(next);
    f.provenance.submodules[0]!.repository = "example/replaced";
    expect(next.runtime.sourceProvenance!.submodules[0]!.repository).toBe("example/library");
  });

  it("preserves the immutable graph across interruption, adopted attempts and completed delivery recovery", () => {
    const f = fixture();
    const registered = f.register();
    const resumed = restoreInvestigationCheckpoint({
      checkpoint: interruptInvestigationLoop(registered, "interrupted", recordedAt),
      task: f.task,
      attemptId: "resumed-source-attempt",
      leaseVersion: 2,
      recordedAt,
    });
    expect(resumed.runtime.sourceProvenance).toEqual(f.provenance);
    const completed = acceptAnalysis(resumed);
    expect(completed.stopReason).toBe("complete");
    const recovered = restoreCompletedInvestigationForDelivery({
      checkpoint: completed,
      task: f.task,
      attemptId: "delivery-only-attempt",
      leaseVersion: 3,
      recordedAt,
    });
    expect(recovered.runtime.sourceProvenance).toEqual(f.provenance);
    expect(recovered.round).toBe(completed.round);
    expect(recovered.analysis).toEqual(completed.analysis);
    expect(recovered.consumed).toEqual(completed.consumed);
  });

  it("allows the same graph but refuses a replacement dependency pin", () => {
    const f = fixture();
    const registered = f.register();
    const matching = f.register(structuredClone(f.provenance), registered);
    expect(matching.runtime.sourceProvenance).toEqual(registered.runtime.sourceProvenance);
    expect(matching.round).toBe(0);
    const changed = structuredClone(f.provenance);
    changed.submodules[1]!.commitSha = "e".repeat(40);
    expect(() => f.register(changed, registered)).toThrow(
      expect.objectContaining({ code: "source_provenance_changed" }),
    );
  });

  it("refuses first registration after accepted model or execution work while allowing an existing receipt", () => {
    const f = fixture();
    const modeled = acceptAnalysis(f.checkpoint, false);
    expect(modeled.stopReason).toBe("continuing");
    const executed = applyInvestigationRuntimeCheckpoint(
      f.checkpoint,
      {
        ...f.checkpoint.runtime,
        e2eExecution: {
          attemptId: f.checkpoint.attemptId,
          status: "started",
          startedAt: recordedAt,
          completedAt: null,
        },
      },
      { recordedAt },
    );
    for (const prior of [modeled, executed])
      expect(() => f.register(f.provenance, prior)).toThrow(
        expect.objectContaining({ code: "source_provenance_registration_too_late" }),
      );
    const recordedBeforeWork = acceptAnalysis(f.register(), false);
    expect(f.register(f.provenance, recordedBeforeWork).runtime.sourceProvenance).toEqual(
      f.provenance,
    );
  });

  it("allows first registration after a preparation-only attempt was interrupted and adopted", () => {
    const f = fixture();
    const resumed = restoreInvestigationCheckpoint({
      checkpoint: interruptInvestigationLoop(f.checkpoint, "blocked", recordedAt),
      task: f.task,
      attemptId: "retry-source-preparation",
      leaseVersion: 2,
      recordedAt,
    });
    expect(f.register(f.provenance, resumed).runtime.sourceProvenance).toEqual(f.provenance);
  });

  it.each(["add", "replace", "remove"] as const)(
    "rejects an execution receipt attempting to %s source provenance",
    (operation) => {
      const f = fixture();
      const prior = operation === "add" ? f.checkpoint : f.register();
      const runtime = structuredClone(prior.runtime);
      if (operation === "remove") delete runtime.sourceProvenance;
      else {
        runtime.sourceProvenance = structuredClone(f.provenance);
        if (operation === "replace")
          runtime.sourceProvenance.submodules[1]!.commitSha = "e".repeat(40);
      }
      expect(() => applyInvestigationRuntimeCheckpoint(prior, runtime, { recordedAt })).toThrow(
        expect.objectContaining({ code: "source_provenance_is_trusted" }),
      );
      expect(
        applyInvestigationRuntimeCheckpoint(prior, prior.runtime, { recordedAt }).runtime,
      ).toEqual(prior.runtime);
    },
  );

  it.each(["subject", "sha", "parent", "alias"] as const)(
    "rejects a %s binding violation before changing the checkpoint",
    (field) => {
      const f = fixture();
      const changed = structuredClone(f.provenance);
      if (field === "subject") changed.subjectRef = "another-subject";
      else if (field === "sha") changed.sourceSha = "f".repeat(40);
      else if (field === "parent") changed.submodules[1]!.parentCommitSha = "f".repeat(40);
      else changed.submodules[1]!.path = "Deps/library/vendor/core";
      const digest = f.checkpoint.digest;
      expect(() => f.register(changed)).toThrow(
        expect.objectContaining({ code: "invalid_source_provenance" }),
      );
      expect(f.checkpoint.digest).toBe(digest);
      expect(f.checkpoint.runtime.sourceProvenance).toBeUndefined();
    },
  );

  it.each([
    "snapshot",
    "unauthorized-execute",
    "subject-scope",
    "repository",
    "work-item",
  ] as const)("rejects a frozen task with %s materialization", (kind) => {
    const f = fixture((task) => {
      if (kind === "snapshot") task.executionPolicy.mode = "snapshot_only";
      else if (kind === "unauthorized-execute") {
        task.executionPolicy.mode = "execute";
        task.executionPolicy.allowRepositoryExecution = false;
        task.executionPolicy.authorizationRef = null;
      } else if (kind === "subject-scope") task.executionPolicy.allowedSubjectRefs = [];
      else if (kind === "repository") task.subjects[0]!.repositoryId = "another-repository";
      else task.subjects[0]!.workItemId = "another-work-item";
    });
    expect(() => f.register()).toThrow(
      expect.objectContaining({ code: "source_provenance_not_authorized" }),
    );
  });

  it("accepts authorized execution materialization and retains legacy checkpoints without provenance", () => {
    const f = fixture((task) => {
      task.kind = "pr-e2e";
      task.executionPolicy.mode = "execute";
      task.executionPolicy.allowRepositoryExecution = true;
      task.executionPolicy.authorizationRef = "synthetic-e2e-authorization";
    });
    expect(f.register().runtime.sourceProvenance).toEqual(f.provenance);
    const legacy = fixture();
    expect(acceptAnalysis(legacy.checkpoint).runtime.sourceProvenance).toBeUndefined();
  });

  it("rejects a changed task binding and a stopped checkpoint", () => {
    const f = fixture();
    const changedTask = structuredClone(f.task);
    changedTask.repository.fullName = "example/replaced";
    expect(() =>
      applyInvestigationSourceProvenanceCheckpoint(f.checkpoint, f.provenance, {
        task: changedTask,
        recordedAt,
      }),
    ).toThrow(expect.objectContaining({ code: "checkpoint_task_binding_mismatch" }));
    expect(() =>
      f.register(f.provenance, interruptInvestigationLoop(f.checkpoint, "blocked", recordedAt)),
    ).toThrow(expect.objectContaining({ code: "loop_already_stopped" }));
  });

  it.each(["duration", "report"] as const)(
    "retains the graph when registration exhausts the %s budget",
    (kind) => {
      const f = fixture((task) => {
        if (kind === "duration") task.budget.maxDurationMs = 7;
        else task.budget.maxReportBytes = 1;
      });
      const registered = f.register();
      expect(registered.stopReason).toBe("budget_exhausted");
      expect(registered.runtime.sourceProvenance).toEqual(f.provenance);
      expect(registered.round).toBe(0);
    },
  );

  it("does not accept forged checkpoint bytes or invalid duration accounting", () => {
    const f = fixture();
    const altered = structuredClone(f.checkpoint);
    altered.runtime.sourceProvenance = structuredClone(f.provenance);
    expect(() => f.register(f.provenance, altered)).toThrow(
      expect.objectContaining({ code: "checkpoint_digest_mismatch" }),
    );
    for (const durationMs of [-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() =>
        applyInvestigationSourceProvenanceCheckpoint(f.checkpoint, f.provenance, {
          task: f.task,
          recordedAt,
          durationMs,
        }),
      ).toThrow(expect.objectContaining({ code: "invalid_worker_consumption" }));
    const { digest: _digest, ...unsigned } = f.register();
    expect(investigationContentDigest(unsigned)).not.toBe(f.checkpoint.digest);
  });
});
