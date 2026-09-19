import {
  createInvestigationPreview,
  type InvestigationRuntimeState,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint } from "@agentic-review/domain";
import { describe, expect, it } from "vitest";
import { validateRootE2eRuntime } from "./e2e-runtime.js";

function fixture() {
  const { task, attempt } = createInvestigationPreview("pr");
  task.kind = "pr-e2e";
  task.parentTaskId = null;
  task.parentReportRef = null;
  task.planRef = null;
  task.executionPolicy = {
    mode: "execute",
    allowedSubjectRefs: [task.subjectRef],
    allowRepositoryExecution: true,
    authorizationRef: "e2e-authorization",
  };
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "e2e-checkpoint",
    leaseVersion: attempt.leaseVersion,
    recordedAt: "2026-09-19T00:00:00Z",
  });
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef)!;
  if (subject.kind !== "original_pr") throw new Error("The fixture must supply a PR.");
  checkpoint.runtime.e2eExecution = {
    attemptId: attempt.id,
    status: "started",
    startedAt: "2026-09-19T00:00:00Z",
    completedAt: null,
  };
  const runtime: InvestigationRuntimeState = {
    ...structuredClone(checkpoint.runtime),
    e2eExecution: {
      ...checkpoint.runtime.e2eExecution,
      status: "completed",
      completedAt: "2026-09-19T00:01:00Z",
    },
    artifacts: [
      {
        id: "screenshot",
        taskId: task.id,
        attemptId: attempt.id,
        subjectRef: subject.id,
        kind: "image",
        name: "feature.png",
        mediaType: "image/png",
        digest: "a".repeat(64),
        byteLength: 100,
        availability: "available",
      },
    ],
    evidence: [
      {
        id: "observation",
        subjectRef: subject.id,
        source: "executor_observation",
        authority: "worker",
        summary: "The displayed value matched.",
        artifactRefs: ["screenshot"],
        evidenceRefs: [],
        provenance: {
          taskId: task.id,
          attemptId: attempt.id,
          producer: "e2e-tool-server",
          recordedAt: "2026-09-19T00:00:00Z",
        },
      },
    ],
    checks: [
      {
        id: "assertion",
        scenarioId: "feature",
        subjectRef: subject.id,
        planRef: null,
        required: true,
        description: "Expected value is displayed.",
        status: "passed",
        executor: "e2e-tool-server",
        evidenceRefs: ["observation"],
        authoritativeAttemptId: attempt.id,
      },
    ],
    e2e: {
      headSha: subject.headSha,
      buildIdentity: "Build from the pinned revision",
      cleanup: {
        confirmed: true,
        recordedAt: "2026-09-19T00:00:00Z",
        summary: "Owned processes exited.",
      },
      features: [
        {
          id: "feature",
          title: "Changed feature",
          paths: ["file.cs"],
          scenario: "Operate the changed feature",
          userVisible: true,
          outcome: "passed",
          assertions: [
            {
              id: "assertion",
              expected: "Expected value",
              observed: "Expected value",
              outcome: "passed",
              evidenceRefs: ["observation"],
            },
          ],
          artifactRefs: ["screenshot"],
          limitations: [],
        },
      ],
    },
  };
  return { task, checkpoint, runtime };
}

describe("root E2E runtime admission", () => {
  it("requires an empty durable start checkpoint before accepting execution evidence", () => {
    const f = fixture();
    delete f.checkpoint.runtime.e2eExecution;
    expect(() => validateRootE2eRuntime(f.task, f.checkpoint, f.runtime)).toThrow(/durably start/u);
    const start = {
      ...structuredClone(f.checkpoint.runtime),
      e2eExecution: {
        attemptId: f.checkpoint.attemptId,
        status: "started" as const,
        startedAt: "2026-09-19T00:00:00Z",
        completedAt: null,
      },
    };
    expect(() => validateRootE2eRuntime(f.task, f.checkpoint, start)).not.toThrow();
  });
  it("accepts durable in-progress observations without inventing final feature results", () => {
    const f = fixture();
    const partial = {
      ...structuredClone(f.checkpoint.runtime),
      evidence: f.runtime.evidence,
      artifacts: f.runtime.artifacts,
    };
    expect(() => validateRootE2eRuntime(f.task, f.checkpoint, partial)).not.toThrow();
  });
  it("forbids replacing a previous attempt start marker to replay desktop work", () => {
    const f = fixture();
    f.checkpoint.attemptId = "resumed-attempt";
    f.checkpoint.adoptedAttemptIds.push("resumed-attempt");
    f.runtime.e2eExecution = {
      ...f.checkpoint.runtime.e2eExecution!,
      attemptId: "resumed-attempt",
    };
    delete f.runtime.e2e;
    expect(() => validateRootE2eRuntime(f.task, f.checkpoint, f.runtime)).toThrow();
  });
  it("accepts authorized root E2E observations without a parent report or saved plan", () => {
    const f = fixture();
    expect(() => validateRootE2eRuntime(f.task, f.checkpoint, f.runtime)).not.toThrow();
  });
  it.each([
    "wrong task",
    "wrong revision",
    "model evidence",
    "missing check",
    "changed outcome",
    "unconfirmed cleanup",
    "foreign attempt",
  ])("rejects %s", (mutation) => {
    const f = fixture();
    if (mutation === "wrong task") f.task.kind = "pr-review";
    if (mutation === "wrong revision") {
      const original = f.runtime.e2e!.headSha;
      f.runtime.e2e!.headSha = original === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
      expect(f.runtime.e2e!.headSha).not.toBe(original);
    }
    if (mutation === "model evidence") f.runtime.evidence[0]!.authority = "model";
    if (mutation === "missing check") f.runtime.checks = [];
    if (mutation === "changed outcome") f.runtime.checks[0]!.status = "failed";
    if (mutation === "unconfirmed cleanup") f.runtime.e2e!.cleanup.confirmed = false;
    if (mutation === "foreign attempt")
      f.runtime.checks[0]!.authoritativeAttemptId = "other-attempt";
    expect(() => validateRootE2eRuntime(f.task, f.checkpoint, f.runtime)).toThrow();
  });
  it("allows report delivery recovery with previously accepted execution observations", () => {
    const f = fixture();
    f.checkpoint.runtime = structuredClone(f.runtime);
    f.checkpoint.adoptedAttemptIds.push("delivery-attempt");
    f.checkpoint.attemptId = "delivery-attempt";
    expect(() => validateRootE2eRuntime(f.task, f.checkpoint, f.runtime)).not.toThrow();
  });
});
