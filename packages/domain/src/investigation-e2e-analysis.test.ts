import {
  createInvestigationPreview,
  type InvestigationE2eBlocker,
  type InvestigationE2eResult,
} from "@agentic-review/contracts";
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

function addBuildBlocker(
  input: ReturnType<typeof fixture>,
  overrides: Partial<InvestigationE2eBlocker> = {},
) {
  const { task, checkpoint } = input;
  const blocker: InvestigationE2eBlocker = {
    stage: "build",
    code: "E2E_BUILD_FAILED",
    diagnosticCodes: ["MSB8020"],
    evidenceRefs: ["build-observation"],
    ...overrides,
  };
  checkpoint.runtime.artifacts.push({
    id: "build-log",
    taskId: task.id,
    attemptId: checkpoint.runtime.e2eExecution!.attemptId,
    subjectRef: task.subjectRef,
    kind: "log",
    name: "private-build-log-synthetic.txt",
    mediaType: "text/plain",
    digest: "b".repeat(64),
    byteLength: 100,
    availability: "available",
  });
  checkpoint.runtime.evidence.push({
    id: "build-observation",
    subjectRef: task.subjectRef,
    source: "executor_observation",
    authority: "worker",
    summary: "C:\\private\\build.log contains synthetic-sensitive-worker-text",
    artifactRefs: ["build-log"],
    evidenceRefs: [],
    provenance: {
      taskId: task.id,
      attemptId: checkpoint.runtime.e2eExecution!.attemptId,
      producer: "e2e-tool-server",
      recordedAt: "2026-09-19T00:00:30Z",
    },
  });
  checkpoint.runtime.e2e!.blockers = [blocker];
  return blocker;
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

  it.each(["blocked", "failed"] as const)(
    "prioritizes typed build reasons in %s results without adopting private Worker text",
    (outcome) => {
      const input = fixture(outcome === "blocked" ? "not_run" : "failed");
      const { task, checkpoint } = input;
      const blocker = addBuildBlocker(input);
      checkpoint.runtime.e2e!.features[0]!.title = "Uncovered changed behavior";
      checkpoint.runtime.e2e!.features[0]!.limitations = ["Required UI behavior was not verified."];
      checkpoint.analysis.diagnostics = [
        {
          id: "generic-coverage",
          code: "E2E_COVERAGE_BLOCKED",
          category: "blocker",
          message: "Generic uncovered explanation.",
          retryable: false,
          evidenceRefs: [],
          prerequisiteRefs: [],
        },
        {
          id: "stale-build-reason",
          code: "E2E_BUILD_TOOL_UNAVAILABLE",
          category: "blocker",
          message: "Old untrusted blocker explanation.",
          retryable: false,
          evidenceRefs: [],
          prerequisiteRefs: [],
        },
      ];
      const original = structuredClone(input);
      const projected = projectRecordedE2eAnalysis(
        task,
        checkpoint,
        "Unrecorded model claims a passing build and all UI assertions executed.",
      );

      expect(projected.outcome).toBe(outcome);
      expect(projected.analysis.summary).toContain("E2E_BUILD_FAILED: The build failed.");
      expect(projected.analysis.summary).toContain("MSB8020");
      expect(projected.analysis.summary.indexOf("E2E_BUILD_FAILED")).toBeLessThan(
        projected.analysis.summary.indexOf("Uncovered"),
      );
      expect(projected.analysis.diagnostics).toEqual([
        expect.objectContaining({
          code: "E2E_BUILD_FAILED",
          category: outcome === "failed" ? "error" : "blocker",
          message: expect.stringContaining("MSB8020"),
          evidenceRefs: blocker.evidenceRefs,
        }),
      ]);
      expect(projected.analysis.limitations[0]).toMatchObject({
        description: expect.stringContaining("E2E_BUILD_FAILED"),
        evidenceRefs: blocker.evidenceRefs,
      });
      expect(projected.analysis.limitations[1]?.description).toBe(
        "Required UI behavior was not verified.",
      );
      expect(projected.analysis.coverage.completedUnitRefs).toEqual([]);
      expect(projected.analysis.assessment).toMatchObject({
        summary: projected.analysis.summary,
        e2eAssessment: { rationale: expect.stringContaining("E2E_BUILD_FAILED") },
      });
      for (const privateText of [
        "synthetic-sensitive-worker-text",
        "private-build-log-synthetic",
        "C:\\private",
        "Unrecorded model",
        "Old untrusted blocker explanation",
        "Generic uncovered explanation",
      ])
        expect(JSON.stringify(projected)).not.toContain(privateText);
      expect(input).toEqual(original);
    },
  );

  it("keeps build diagnostics stable across delivery recovery and removes resolved reasons", () => {
    const input = fixture("blocked");
    addBuildBlocker(input);
    const first = projectRecordedE2eAnalysis(input.task, input.checkpoint);
    const delivery = structuredClone(input.checkpoint);
    delivery.id = "later-delivery-checkpoint";
    delivery.attemptId = "later-delivery-attempt";
    delivery.adoptedAttemptIds.push(delivery.attemptId);
    delivery.analysis = structuredClone(first.analysis);
    expect(projectRecordedE2eAnalysis(input.task, delivery)).toEqual(first);

    delivery.runtime.e2e!.blockers![0] = {
      ...delivery.runtime.e2e!.blockers![0]!,
      code: "E2E_BUILD_RECORD_INVALID",
      diagnosticCodes: [],
    };
    const changed = projectRecordedE2eAnalysis(input.task, delivery);
    expect(changed.analysis.diagnostics.map((entry) => entry.code)).toEqual([
      "E2E_BUILD_RECORD_INVALID",
    ]);
    expect(JSON.stringify(changed)).not.toContain("MSB8020");

    const recovered = fixture("passed");
    recovered.checkpoint.analysis = structuredClone(first.analysis);
    const successful = projectRecordedE2eAnalysis(recovered.task, recovered.checkpoint);
    expect(successful.outcome).toBe("completed");
    expect(successful.analysis.diagnostics).toEqual([]);
    expect(successful.analysis.limitations).toEqual([]);
    expect(JSON.stringify(successful)).not.toContain("E2E_BUILD_FAILED");
    expect(JSON.stringify(successful)).not.toContain("MSB8020");
  });

  it("rejects build reasons without their own exact Worker log and rejects completed blockers", () => {
    const input = fixture("blocked");
    addBuildBlocker(input);
    input.checkpoint.runtime.artifacts[0]!.attemptId = "foreign-attempt";
    expect(() => projectRecordedE2eAnalysis(input.task, input.checkpoint)).toThrow(
      "Recorded E2E analysis must retain its exact PR revision and Worker evidence.",
    );
    const passed = fixture("passed");
    addBuildBlocker(passed);
    expect(() => projectRecordedE2eAnalysis(passed.task, passed.checkpoint)).toThrow(
      "Recorded E2E analysis must retain its exact PR revision and Worker evidence.",
    );
  });

  it("removes resolved generic E2E diagnostics after recovery while preserving accepted context", () => {
    const failed = fixture("failed");
    const blocked = fixture("blocked");
    const recovered = fixture("passed");
    const accepted = {
      id: "accepted-context-diagnostic",
      code: "ACCEPTED_CONTEXT",
      category: "limitation" as const,
      message: "Previously accepted context remains relevant.",
      retryable: false,
      evidenceRefs: [],
      prerequisiteRefs: [],
    };
    recovered.checkpoint.analysis.diagnostics = [
      ...projectRecordedE2eAnalysis(failed.task, failed.checkpoint).analysis.diagnostics,
      ...projectRecordedE2eAnalysis(blocked.task, blocked.checkpoint).analysis.diagnostics,
      accepted,
    ];
    const original = structuredClone(recovered.checkpoint);
    const projected = projectRecordedE2eAnalysis(recovered.task, recovered.checkpoint);
    expect(projected.outcome).toBe("completed");
    expect(projected.analysis.diagnostics).toEqual([accepted]);
    expect(recovered.checkpoint).toEqual(original);
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
