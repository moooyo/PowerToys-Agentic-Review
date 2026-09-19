import { describe, expect, it } from "vitest";
import {
  type InvestigationE2eResult,
  projectInvestigationCheckpointPresentation,
  validateInvestigationE2eBindings,
} from "./investigation-e2e.js";
import { createInvestigationPreview } from "./investigation-preview.js";

function fixture() {
  const e2e: InvestigationE2eResult = {
    headSha: "a".repeat(40),
    buildIdentity: "Pinned source build",
    cleanup: {
      confirmed: true,
      recordedAt: "2026-09-19T00:00:00Z",
      summary: "Owned processes exited.",
    },
    features: [
      {
        id: "feature",
        title: "Changed behavior",
        paths: ["src/file.cs"],
        scenario: "Operate the changed UI.",
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
        artifactRefs: ["image"],
        limitations: [],
      },
    ],
  };
  return {
    e2e,
    taskId: "task",
    taskKind: "pr-e2e",
    subjectRef: "subject",
    headSha: e2e.headSha,
    completed: true,
    artifacts: [
      {
        id: "image",
        taskId: "task",
        attemptId: "attempt",
        subjectRef: "subject",
        kind: "image",
        availability: "available",
      },
    ],
    evidence: [
      {
        id: "observation",
        subjectRef: "subject",
        authority: "worker",
        artifactRefs: ["image"],
        provenance: { taskId: "task", attemptId: "attempt" },
      },
    ],
  };
}

describe("E2E evidence bindings", () => {
  it("accepts a passed feature with same-attempt media and Worker assertions", () => {
    expect(validateInvestigationE2eBindings(fixture())).toEqual([]);
  });
  it.each(["task", "revision", "attempt", "model", "missing media", "cleanup", "incomplete"])(
    "rejects invalid %s evidence",
    (mutation) => {
      const input = fixture();
      if (mutation === "task") input.artifacts[0]!.taskId = "other";
      if (mutation === "revision") input.headSha = "b".repeat(40);
      if (mutation === "attempt") input.artifacts[0]!.attemptId = "other";
      if (mutation === "model") input.evidence[0]!.authority = "model";
      if (mutation === "missing media") input.e2e.features[0]!.artifactRefs = [];
      if (mutation === "cleanup") input.e2e.cleanup.confirmed = false;
      if (mutation === "incomplete") input.e2e.features[0]!.outcome = "blocked";
      expect(validateInvestigationE2eBindings(input).length).toBeGreaterThan(0);
    },
  );
});

function presentationFixture() {
  const task = { id: "task", kind: "pr-e2e" as const };
  const checkpoint: Parameters<typeof projectInvestigationCheckpointPresentation>[1] = {
    taskId: task.id,
    round: 0,
    stopReason: "budget_exhausted",
    analysis: {
      summary: "Investigation has not started.",
      assessment: {
        ...createInvestigationPreview("pr").result.assessment,
        summary: "Investigation has not started.",
      },
    },
    runtime: {
      evidence: [],
      artifacts: [],
      e2eExecution: {
        attemptId: "attempt",
        status: "started",
        startedAt: "2026-09-19T00:00:00Z",
        completedAt: null,
      },
    },
  };
  return { task, checkpoint };
}

describe("unadopted E2E presentation", () => {
  it("describes recorded results without adopting an assessment or mutating saved analysis", () => {
    const { task, checkpoint } = presentationFixture();
    checkpoint.runtime.e2e = fixture().e2e;
    const before = structuredClone(checkpoint);
    const presentation = projectInvestigationCheckpointPresentation(task, checkpoint);
    expect(presentation.summary).toContain("Recorded E2E feature results: 1 passed");
    expect(presentation.summary).toContain("Final analysis was not adopted");
    expect(presentation.summary).toContain("task budget was exhausted");
    expect(presentation.summary).toContain("Results remain partial");
    expect(presentation.assessment).toMatchObject({
      summary: presentation.summary,
      reviewConclusion: { status: "inconclusive" },
      e2eAssessment: { rationale: presentation.summary },
    });
    expect(checkpoint).toEqual(before);
  });

  it("retains cancellation with observations but no final feature results", () => {
    const { task, checkpoint } = presentationFixture();
    checkpoint.stopReason = "cancelled";
    checkpoint.runtime.evidence = [
      {
        ...fixture().evidence[0]!,
        source: "executor_observation",
        authority: "worker",
        summary: "The owned application window opened.",
        evidenceRefs: [],
        provenance: {
          taskId: task.id,
          attemptId: "attempt",
          producer: "e2e-tool-server",
          recordedAt: "2026-09-19T00:00:00Z",
        },
      },
    ];
    const presentation = projectInvestigationCheckpointPresentation(task, checkpoint);
    expect(presentation.summary).toContain("Worker observations or artifacts were recorded");
    expect(presentation.summary).toContain("final E2E feature results are unavailable");
    expect(presentation.summary).toContain("task was cancelled");
    expect(presentation.summary).not.toContain("not started");
  });

  it("does not claim application execution from a start marker alone", () => {
    const { task, checkpoint } = presentationFixture();
    expect(projectInvestigationCheckpointPresentation(task, checkpoint).summary).toContain(
      "workflow start was recorded; application execution is not established",
    );
    checkpoint.stopReason = "continuing";
    const running = projectInvestigationCheckpointPresentation(task, checkpoint);
    expect(running.summary).toContain("Final analysis has not been adopted yet");
    expect(running.summary).not.toContain("stopped");
    expect(running.summary).not.toContain("Results remain partial");
  });

  it.each(["no activity", "other task", "static review", "adopted round"])(
    "preserves saved presentation for %s",
    (condition) => {
      const { task, checkpoint } = presentationFixture();
      if (condition === "no activity") delete checkpoint.runtime.e2eExecution;
      if (condition === "other task") checkpoint.taskId = "other";
      if (condition === "adopted round") checkpoint.round = 1;
      const presentation = projectInvestigationCheckpointPresentation(
        condition === "static review" ? { ...task, kind: "pr-review" } : task,
        checkpoint,
      );
      expect(presentation).toEqual(checkpoint.analysis);
    },
  );
});
