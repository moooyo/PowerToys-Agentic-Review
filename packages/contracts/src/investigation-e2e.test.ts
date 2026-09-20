import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  describeInvestigationE2eBlocker,
  type InvestigationE2eBlocker,
  type InvestigationE2eResult,
  InvestigationE2eResultSchema,
  projectInvestigationCheckpointPresentation,
  validateInvestigationE2eBindings,
} from "./investigation-e2e.js";
import { createInvestigationPreview } from "./investigation-preview.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

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

function buildBlockerFixture() {
  const input = fixture();
  input.completed = false;
  input.e2e.features[0]!.outcome = "not_run";
  input.e2e.features[0]!.assertions[0]!.outcome = "not_run";
  input.e2e.features[0]!.assertions[0]!.evidenceRefs = [];
  input.e2e.features[0]!.artifactRefs = [];
  input.artifacts[0] = { ...input.artifacts[0]!, id: "build-log", kind: "log" };
  input.evidence[0] = {
    ...input.evidence[0]!,
    id: "build-observation",
    artifactRefs: ["build-log"],
  };
  input.e2e.blockers = [
    {
      stage: "build",
      code: "E2E_BUILD_FAILED",
      diagnosticCodes: ["MSB8020", "C1083"],
      evidenceRefs: ["build-observation"],
    },
  ];
  return input;
}

describe("typed E2E build blockers", () => {
  it.each([
    "E2E_BUILD_REQUEST_INVALID",
    "E2E_BUILD_TOOL_UNAVAILABLE",
    "E2E_BUILD_SOURCE_INVALID",
    "E2E_BUILD_FAILED",
    "E2E_BUILD_ARTIFACT_INVALID",
    "E2E_BUILD_RECORD_INVALID",
    "E2E_BUILD_OPERATION_BLOCKED",
  ] as const)("accepts %s with an exact Worker log binding", (code) => {
    const input = buildBlockerFixture();
    input.e2e.blockers![0]!.code = code;
    expect(Value.Check(InvestigationE2eResultSchema, input.e2e)).toBe(true);
    expect(validateInvestigationE2eBindings(input)).toEqual([]);
    expect(describeInvestigationE2eBlocker(input.e2e.blockers![0]!)).toContain(code);
  });

  it("keeps legacy results valid and bounds diagnostic and evidence collections", () => {
    expect(Value.Check(InvestigationE2eResultSchema, fixture().e2e)).toBe(true);
    const { e2e } = buildBlockerFixture();
    const blocker = e2e.blockers![0]!;
    blocker.diagnosticCodes = Array.from({ length: 16 }, (_, index) => `MSB${1000 + index}`);
    blocker.evidenceRefs = Array.from({ length: 1_024 }, (_, index) => `build-evidence-${index}`);
    expect(Value.Check(InvestigationE2eResultSchema, e2e)).toBe(true);
    for (const blockers of [
      [],
      Array.from({ length: 8 }, () => blocker),
      [{ ...blocker, diagnosticCodes: [...blocker.diagnosticCodes, "C1234"] }],
      [{ ...blocker, evidenceRefs: [...blocker.evidenceRefs, "overflow-evidence"] }],
      [{ ...blocker, evidenceRefs: [] }],
      [{ ...blocker, diagnosticCodes: ["C1234", "C1234"] }],
      [{ ...blocker, evidenceRefs: ["observation", "observation"] }],
    ])
      expect(Value.Check(InvestigationE2eResultSchema, { ...e2e, blockers })).toBe(false);
  });

  it("accepts the controlled compiler and build diagnostic families", () => {
    const { e2e } = buildBlockerFixture();
    e2e.blockers![0]!.diagnosticCodes = [
      "C1083",
      "D9002",
      "CS12345",
      "MSB8020",
      "NU1301",
      "NETSDK1147",
      "LNK1104",
    ];
    expect(Value.Check(InvestigationE2eResultSchema, e2e)).toBe(true);
  });

  it("never formats raw messages, paths, unknown categories, or malformed diagnostic codes", () => {
    const { e2e } = buildBlockerFixture();
    const blocker = e2e.blockers![0]!;
    expect(describeInvestigationE2eBlocker(blocker)).toBe(
      "E2E_BUILD_FAILED: The build failed. Diagnostic codes: C1083, MSB8020.",
    );
    const privateText = "C:\\private\\build.log token=synthetic-private-value";
    for (const invalid of [
      { ...blocker, message: privateText },
      { ...blocker, path: privateText },
      { ...blocker, summary: privateText },
      { ...blocker, code: privateText },
      { ...blocker, code: "toString" },
      { ...blocker, stage: privateText },
      ...[privateText, "C1083\n", "MSB123", "msb8020", "MSB123456"].map((diagnostic) => ({
        ...blocker,
        diagnosticCodes: [diagnostic],
      })),
    ]) {
      expect(Value.Check(InvestigationE2eResultSchema, { ...e2e, blockers: [invalid] })).toBe(
        false,
      );
      expect(describeInvestigationE2eBlocker(invalid as InvestigationE2eBlocker)).toBe(
        "E2E build blocker details are unavailable.",
      );
    }
  });

  const invalidBindings: [string, (input: ReturnType<typeof buildBlockerFixture>) => void][] = [
    [
      "completed report",
      (input) => {
        input.completed = true;
      },
    ],
    [
      "missing observation",
      (input) => {
        input.evidence = [];
      },
    ],
    [
      "model observation",
      (input) => {
        input.evidence[0]!.authority = "model";
      },
    ],
    [
      "foreign observation task",
      (input) => {
        input.evidence[0]!.provenance.taskId = "foreign";
      },
    ],
    [
      "foreign observation subject",
      (input) => {
        input.evidence[0]!.subjectRef = "foreign";
      },
    ],
    [
      "unreferenced log",
      (input) => {
        input.evidence[0]!.artifactRefs = [];
      },
    ],
    [
      "missing log",
      (input) => {
        input.artifacts = [];
      },
    ],
    [
      "non-log artifact",
      (input) => {
        input.artifacts[0]!.kind = "image";
      },
    ],
    [
      "unavailable log",
      (input) => {
        input.artifacts[0]!.availability = "missing";
      },
    ],
    [
      "foreign log task",
      (input) => {
        input.artifacts[0]!.taskId = "foreign";
      },
    ],
    [
      "foreign log subject",
      (input) => {
        input.artifacts[0]!.subjectRef = "foreign";
      },
    ],
    [
      "foreign log attempt",
      (input) => {
        input.artifacts[0]!.attemptId = "foreign";
      },
    ],
    [
      "duplicate code",
      (input) => {
        input.e2e.blockers!.push({ ...input.e2e.blockers![0]! });
      },
    ],
    [
      "duplicate evidence reference",
      (input) => {
        input.e2e.blockers!.push({ ...input.e2e.blockers![0]!, code: "E2E_BUILD_RECORD_INVALID" });
      },
    ],
    [
      "invalid shape",
      (input) => {
        Object.assign(input.e2e.blockers![0]!, { message: "raw text" });
      },
    ],
  ];
  it.each(invalidBindings)("rejects %s", (_name, mutate) => {
    const input = buildBlockerFixture();
    mutate(input);
    expect(validateInvestigationE2eBindings(input).length).toBeGreaterThan(0);
  });

  it("requires each blocker reference to retain its own same-attempt log", () => {
    const input = buildBlockerFixture();
    input.e2e.blockers![0]!.evidenceRefs.push("another-build-observation");
    input.evidence.push({
      ...input.evidence[0]!,
      id: "another-build-observation",
      provenance: { taskId: input.taskId, attemptId: "another-attempt" },
    });
    expect(validateInvestigationE2eBindings(input).length).toBeGreaterThan(0);
    input.artifacts.push({
      ...input.artifacts[0]!,
      id: "another-build-log",
      attemptId: "another-attempt",
    });
    input.evidence[1]!.artifactRefs = ["another-build-log"];
    expect(validateInvestigationE2eBindings(input)).toEqual([]);
  });
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
