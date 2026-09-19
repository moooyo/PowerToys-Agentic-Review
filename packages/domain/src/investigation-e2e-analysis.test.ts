import { createInvestigationPreview, type InvestigationE2eResult } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { projectRecordedE2eAnalysis } from "./investigation-e2e-analysis.js";
import { createInvestigationCheckpoint } from "./investigation-loop.js";

type FeatureOutcome = InvestigationE2eResult["features"][number]["outcome"];

function fixture(outcome: FeatureOutcome = "passed") {
  const { task, attempt } = createInvestigationPreview("pr", { findingCount: 0 });
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
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
  if (subject?.kind !== "original_pr") throw new Error("The fixture requires an original PR.");
  const checkpoint = createInvestigationCheckpoint({
    task,
    attemptId: attempt.id,
    checkpointId: "execution-checkpoint",
    leaseVersion: attempt.leaseVersion,
    recordedAt: "2026-09-19T00:01:00Z",
  });
  const executed = outcome === "passed" || outcome === "failed";
  const evidenceRefs = executed ? ["assertion-observation"] : [];
  checkpoint.runtime.e2eExecution = {
    attemptId: attempt.id,
    status: "completed",
    startedAt: "2026-09-19T00:00:00Z",
    completedAt: "2026-09-19T00:01:00Z",
  };
  checkpoint.runtime.artifacts = executed
    ? [
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
      ]
    : [];
  checkpoint.runtime.evidence = executed
    ? [
        {
          id: "assertion-observation",
          subjectRef: subject.id,
          source: "executor_observation",
          authority: "worker",
          summary: `Recorded assertion outcome: ${outcome}.`,
          artifactRefs: ["screenshot"],
          evidenceRefs: [],
          provenance: {
            taskId: task.id,
            attemptId: attempt.id,
            producer: "e2e-tool-server",
            recordedAt: "2026-09-19T00:00:30Z",
          },
        },
      ]
    : [];
  checkpoint.runtime.checks = [
    {
      id: "feature-assertion",
      scenarioId: "feature",
      subjectRef: subject.id,
      planRef: null,
      required: true,
      description: "The changed UI displays the expected value.",
      status: outcome,
      executor: executed ? "e2e-tool-server" : null,
      evidenceRefs,
      authoritativeAttemptId: executed ? attempt.id : null,
    },
  ];
  checkpoint.runtime.e2e = {
    headSha: subject.headSha,
    buildIdentity: "Worker build from the pinned PR revision",
    cleanup: {
      confirmed: true,
      recordedAt: "2026-09-19T00:01:00Z",
      summary: "Owned processes exited.",
    },
    features: [
      {
        id: "feature",
        title: "Changed UI behavior",
        paths: ["src/feature.cs"],
        scenario: "Operate the changed UI and inspect the displayed value.",
        userVisible: true,
        outcome,
        assertions: [
          {
            id: "feature-assertion",
            expected: "The expected value is displayed.",
            observed: `Recorded assertion outcome: ${outcome}.`,
            outcome,
            evidenceRefs,
          },
        ],
        artifactRefs: executed ? ["screenshot"] : [],
        limitations: [],
      },
    ],
  };
  return { task, checkpoint };
}

describe("recorded E2E analysis projection", () => {
  it.each([
    ["passed", "completed"],
    ["failed", "failed"],
    ["blocked", "blocked"],
    ["not_run", "blocked"],
  ] as const)(
    "derives %s from recorded features without adopting new model text",
    (status, outcome) => {
      const { task, checkpoint } = fixture(status);
      const oldSummary = "The previous analysis claims a different result.";
      const suppliedSummary = "Unpersisted model text claims every feature passed.";
      checkpoint.analysis.summary = oldSummary;
      checkpoint.analysis.assessment.summary = oldSummary;

      const projected = projectRecordedE2eAnalysis(task, checkpoint, suppliedSummary);

      expect(projected.outcome).toBe(outcome);
      expect(projected.analysis.summary).toContain("Changed UI behavior");
      expect(projected.analysis.summary).toContain(status);
      expect(projected.analysis.assessment.summary).toBe(projected.analysis.summary);
      expect(JSON.stringify(projected)).not.toContain(oldSummary);
      expect(JSON.stringify(projected)).not.toContain(suppliedSummary);
      expect(
        projected.analysis.diagnostics.some((entry) => entry.code === "E2E_AGENT_COMPLETION_NOTE"),
      ).toBe(false);
      expect(projected).toEqual(projectRecordedE2eAnalysis(task, checkpoint));
    },
  );

  it("keeps diagnostics and limitations stable across report delivery attempts", () => {
    const { task, checkpoint } = fixture("failed");
    checkpoint.runtime.e2e!.features[0]!.limitations = [
      "The expected UI value was not displayed.",
      "The scenario was exercised with the default configuration only.",
    ];
    const resumed = structuredClone(checkpoint);
    resumed.id = "delivery-checkpoint";
    resumed.version += 1;
    resumed.attemptId = "delivery-attempt";
    resumed.adoptedAttemptIds.push(resumed.attemptId);
    resumed.leaseVersion += 1;
    resumed.recordedAt = "2026-09-20T12:00:00Z";
    const original = structuredClone({ task, checkpoint, resumed });

    const first = projectRecordedE2eAnalysis(task, checkpoint, "First unrecorded summary.");
    const recovered = projectRecordedE2eAnalysis(task, resumed, "Different unrecorded summary.");

    expect(recovered).toEqual(first);
    expect(first.analysis.diagnostics.map((entry) => entry.code)).toContain("E2E_ASSERTION_FAILED");
    expect(first.analysis.limitations).toHaveLength(2);
    expect(new Set(first.analysis.limitations.map((entry) => entry.id)).size).toBe(2);
    expect({ task, checkpoint, resumed }).toEqual(original);
  });

  it("retains accepted analysis content and diagnostics without mutating the checkpoint", () => {
    const { task, checkpoint } = fixture("blocked");
    checkpoint.analysis.evidence = [
      {
        id: "accepted-context",
        subjectRef: task.subjectRef,
        source: "reporter_statement",
        summary: "Previously accepted context for the scenario.",
        evidenceRefs: [],
      },
    ];
    checkpoint.analysis.feedbackDrafts = [
      { id: "accepted-draft", body: "Previously accepted draft content.", suggestion: null },
    ];
    checkpoint.analysis.diagnostics = [
      {
        id: "accepted-diagnostic",
        code: "ACCEPTED_CONTEXT",
        category: "limitation",
        message: "Previously accepted diagnostic content.",
        retryable: false,
        evidenceRefs: [],
        prerequisiteRefs: [],
      },
    ];
    const original = structuredClone({ task, checkpoint });

    const { analysis } = projectRecordedE2eAnalysis(task, checkpoint);

    expect(analysis.evidence).toEqual(checkpoint.analysis.evidence);
    expect(analysis.feedbackDrafts).toEqual(checkpoint.analysis.feedbackDrafts);
    expect(analysis.diagnostics).toContainEqual(checkpoint.analysis.diagnostics[0]);
    expect(analysis.diagnostics.map((entry) => entry.code)).toContain("E2E_COVERAGE_BLOCKED");
    expect({ task, checkpoint }).toEqual(original);
  });

  const invalidCases: [string, (input: ReturnType<typeof fixture>) => void][] = [
    [
      "missing E2E results",
      ({ checkpoint }) => {
        delete checkpoint.runtime.e2e;
      },
    ],
    [
      "missing execution marker",
      ({ checkpoint }) => {
        delete checkpoint.runtime.e2eExecution;
      },
    ],
    [
      "started execution",
      ({ checkpoint }) => {
        checkpoint.runtime.e2eExecution!.status = "started";
        checkpoint.runtime.e2eExecution!.completedAt = null;
      },
    ],
    [
      "missing completion time",
      ({ checkpoint }) => {
        checkpoint.runtime.e2eExecution!.completedAt = null;
      },
    ],
    [
      "unadopted execution attempt",
      ({ checkpoint }) => {
        checkpoint.runtime.e2eExecution!.attemptId = "foreign-attempt";
      },
    ],
    [
      "unconfirmed cleanup",
      ({ checkpoint }) => {
        checkpoint.runtime.e2e!.cleanup.confirmed = false;
      },
    ],
    [
      "empty feature results",
      ({ checkpoint }) => {
        checkpoint.runtime.e2e!.features = [];
      },
    ],
    [
      "a non-E2E task",
      ({ task }) => {
        task.kind = "pr-review";
      },
    ],
    [
      "a child task",
      ({ task }) => {
        task.parentTaskId = "parent-task";
      },
    ],
    [
      "a different checkpoint task",
      ({ checkpoint }) => {
        checkpoint.taskId = "foreign-task";
      },
    ],
    [
      "a different task subject",
      ({ task }) => {
        task.subjectRef = "foreign-subject";
      },
    ],
    [
      "a different head revision",
      ({ checkpoint }) => {
        checkpoint.runtime.e2e!.headSha = "c".repeat(40);
      },
    ],
    [
      "foreign evidence",
      ({ checkpoint }) => {
        checkpoint.runtime.evidence[0]!.provenance.taskId = "foreign-task";
      },
    ],
    [
      "model-authored evidence",
      ({ checkpoint }) => {
        checkpoint.runtime.evidence[0]!.authority = "model";
      },
    ],
    [
      "evidence for another subject",
      ({ checkpoint }) => {
        checkpoint.runtime.evidence[0]!.subjectRef = "foreign-subject";
      },
    ],
    [
      "missing media",
      ({ checkpoint }) => {
        checkpoint.runtime.artifacts = [];
      },
    ],
    [
      "media from another attempt",
      ({ checkpoint }) => {
        checkpoint.runtime.artifacts[0]!.attemptId = "foreign-attempt";
      },
    ],
  ];

  it.each(invalidCases)("rejects %s", (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => projectRecordedE2eAnalysis(input.task, input.checkpoint)).toThrow();
  });
});
