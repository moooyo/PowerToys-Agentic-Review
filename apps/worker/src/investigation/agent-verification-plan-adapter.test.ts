import { createHash } from "node:crypto";
import {
  createInvestigationPreview,
  type InvestigationArtifactV1,
  type InvestigationEvidenceV1,
  type InvestigationInputSnapshotV1,
  type InvestigationSubjectV1,
  investigationCanonicalJson,
  investigationPlanDigestPayload,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import { createAgentVerificationPlanAdapter } from "./agent-verification-plan-adapter.js";
import type { E2eBuildRecord } from "./e2e-build.js";
import type { E2eFeaturePlan } from "./e2e-feature-plan.js";
import type { E2eToolReceipt, E2eToolServer, E2eToolServerOptions } from "./e2e-tool-server.js";
import { ModelBudgetExceededError } from "./model-budget.js";
import type {
  ModelTurnFileIO,
  ModelTurnFileStat,
  ModelTurnRunnerOptions,
  StaticModelJsonRunner,
} from "./model-turn-runner.js";

type Adapter = ReturnType<typeof createAgentVerificationPlanAdapter>;
type Input = Parameters<Adapter["execute"]>[0];
type Context = Parameters<Adapter["execute"]>[1];
type AgentTools = Pick<
  E2eToolServer,
  | "start"
  | "cleanup"
  | "assertObservationsPersisted"
  | "receipts"
  | "evidence"
  | "artifacts"
  | "features"
  | "builds"
  | "executionSignal"
>;
type ProposedFeature = {
  featureId: string;
  outcome: "passed" | "failed" | "blocked" | "not_run";
  reason: string;
  assertionReceiptIds: string[];
  mediaReceiptIds: string[];
  limitations: string[];
};

const now = "2026-10-01T12:00:00.000Z";
const sourceSha = "a".repeat(40);
const patchDigest = "b".repeat(64);
const sourcePaths = ["src/converter.cs", "src/regression.cs"];
const checkIds = ["saved:result", "saved:failure", "saved:blocked"];

/** Every source, desktop, process, model, and persistence dependency is synthetic. */
function fixture(
  taskKind: "issue-verify" | "reproduction-setup" = "issue-verify",
  subjectKind: "source_commit" | "local_patch" = "source_commit",
) {
  const initial = createInvestigationPreview("bug", { findingCount: 0 });
  const task = structuredClone(initial.task);
  const attempt = structuredClone(initial.attempt);
  const plan = structuredClone(initial.result.plans[0]!);
  const issueSubject = structuredClone(task.subjects[0]!);
  const baseSubject: InvestigationSubjectV1 = {
    id: "frozen-source",
    kind: "source_commit",
    repositoryId: task.repository.id,
    workItemId: task.workItem.id,
    revisionKey: "c".repeat(64),
    commitSha: sourceSha,
  };
  const subject: InvestigationSubjectV1 =
    subjectKind === "local_patch"
      ? {
          id: "frozen-patch",
          kind: "local_patch",
          repositoryId: task.repository.id,
          workItemId: task.workItem.id,
          revisionKey: "d".repeat(64),
          baseSubjectRef: baseSubject.id,
          baseSha: sourceSha,
          patchDigest,
          artifactRef: "saved-patch-artifact",
        }
      : baseSubject;
  task.id = "issue-followup-task";
  task.kind = taskKind;
  task.repository.fullName = "fixture-owner/PowerToys";
  task.workItem.title = "A saved Issue requires runtime conversion verification";
  task.subjectRef = subject.id;
  task.subjects = [issueSubject, baseSubject, ...(subjectKind === "local_patch" ? [subject] : [])];
  task.parentTaskId = initial.task.id;
  task.parentReportRef = { ...plan.sourceReportRef, digest: "e".repeat(64) };
  task.executionPolicy = {
    mode: "execute",
    allowRepositoryExecution: true,
    authorizationRef: "saved-runtime-authorization",
    allowedSubjectRefs: [subject.id],
  };
  task.scope.includedUnits = sourcePaths.map((path, index) => ({
    id: `runtime-scope-${index}`,
    subjectRef: subject.id,
    kind: "runtime_verification" as const,
    paths: [path],
    requiredWork: `Verify the saved Issue behavior implemented by ${path}.`,
    status: "pending" as const,
    evidenceRefs: [],
  }));
  task.scope.completedUnitRefs = [];
  task.scope.unresolvedUnitRefs = task.scope.includedUnits.map((unit) => unit.id);
  attempt.id = "issue-followup-attempt";
  attempt.taskId = task.id;
  plan.subjectRef = subject.id;
  plan.kind = taskKind === "reproduction-setup" ? "reproduction" : "verification";
  plan.title = "Verify the reported area conversion in the product UI";
  plan.rationale = "The saved Issue hypothesis requires actual runtime observations.";
  plan.steps = [
    {
      id: "runtime-step",
      description:
        "Build the pinned source, enter the reported area query, and inspect the result.",
      expectedObservation: "The exact conversion value and any observed failure are recorded.",
      checkIds: [...checkIds],
    },
    {
      id: "later-step",
      description: "Inspect a separate reverse conversion after the selected step.",
      expectedObservation: "The later step has its own saved observation.",
      checkIds: ["saved:later"],
    },
  ];
  plan.acceptanceCriteria = [
    "Record the exact query and converted value.",
    "Retain a runtime screenshot with the assertion and freshly built source identity.",
  ];
  const refreshPlanDigest = () => {
    plan.digest = createHash("sha256")
      .update(investigationCanonicalJson(investigationPlanDigestPayload(plan)))
      .digest("hex");
    task.planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  };
  refreshPlanDigest();

  const snapshot: InvestigationInputSnapshotV1 = {
    schemaVersion: "InvestigationInputSnapshotV1",
    repositoryId: task.repository.id,
    workItemId: task.workItem.id,
    subjectRef: subject.id,
    subjectRevisionKey: subject.revisionKey,
    title: task.workItem.title,
    body: 'Enter "1 sqmi" and inspect the result. Preserve every reported detail.\nSECOND_ISSUE_PARAGRAPH',
    comments: [
      { id: "reporter-comment", body: "The reverse conversion must remain separate." },
      {
        id: "progress-comment",
        body: "A previous worker planned this experiment; the comment is not runtime evidence.",
        provenance: { kind: "agentic_review_progress", publicationId: "synthetic-publication" },
      },
    ],
    source: null,
  };
  let snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const state = (): ModelTurnFileStat => ({
    dev: 1n,
    ino: 2n,
    size: BigInt(snapshotBytes.byteLength),
    mtimeMs: 1n,
    ctimeMs: 1n,
    nlink: 1n,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  });
  const fileIO: ModelTurnFileIO = {
    createPrivateDirectory: vi.fn(async () => "unused"),
    writeExclusiveUtf8: vi.fn(async () => {}),
    lstat: vi.fn(async () => state()),
    realpath: vi.fn(async (path) => path),
    openRead: vi.fn(async () => ({
      stat: async () => state(),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
        bytesRead: snapshotBytes.copy(buffer, offset, position, position + length),
      }),
      close: async () => {},
    })),
    removeDirectory: vi.fn(async () => {}),
  };
  const sourceBinding = {
    subjectRef: subject.id,
    revisionKey: subject.revisionKey,
    sourceSha,
    patchDigest: subject.kind === "local_patch" ? subject.patchDigest : null,
    artifactRef: subject.kind === "local_patch" ? subject.artifactRef : null,
  };
  const workspace = {
    attemptDirectory: "C:/Attempts/issue-verification",
    controlDirectory: "C:/Attempts/issue-verification/control",
    tempDirectory: "C:/Attempts/issue-verification/temp",
    sourceDirectory: "C:/Attempts/issue-verification/source",
    modelInputPath: "C:\\Attempts\\issue-verification\\model-input\\snapshot.json",
    modelInputDigest: digest(snapshotBytes),
    sourceBinding,
    assertIntegrity: vi.fn(async () => {}),
    assertSourceBinding: vi.fn(async () => {}),
    readPrDiffManifest: vi.fn(async () => {
      throw new Error("An Issue verification must not request a PR diff manifest.");
    }),
  };
  const setSnapshot = (value: unknown) => {
    snapshotBytes = Buffer.from(JSON.stringify(value));
    workspace.modelInputDigest = digest(snapshotBytes);
  };
  const build: E2eBuildRecord = {
    id: "fresh-build",
    headSha: sourceSha,
    sourceBinding: { ...sourceBinding },
    projectPath: "src/converter.csproj",
    projectDigest: "f".repeat(64),
    tool: "msbuild",
    command: ["MSBuild.exe", "src/converter.csproj"],
    artifacts: [
      {
        path: "C:/Attempts/issue-verification/build/app.exe",
        relativePath: "app.exe",
        digest: "1".repeat(64),
        byteLength: 1024,
      },
    ],
    manifestDigest: "2".repeat(64),
    manifestFileCount: 3,
    identity: "Worker-generated exact-source build identity",
  };
  const features: E2eFeaturePlan[] = checkIds.map((id, index) => ({
    id,
    title: `Saved behavior ${index + 1}`,
    paths: [sourcePaths[index === 0 ? 0 : 1]!],
    scenario: `Observe the saved behavior for ${id}.`,
    userVisible: true,
    assertions: [
      {
        id: "result",
        kind: "ui",
        description: "The reported conversion result is visible.",
        selector: { automationId: `Result${index}` },
        assertion: { property: "text", expected: "2589988", match: "contains" },
      },
    ],
  }));
  const receipt = (
    id: string,
    operation: string,
    fields: Partial<E2eToolReceipt> = {},
  ): E2eToolReceipt => ({
    id,
    operation,
    status: "passed",
    assertion: false,
    summary: `${operation}: passed.`,
    observed: {},
    artifactRefs: [],
    ...fields,
  });
  const receipts: E2eToolReceipt[] = [receipt(build.id, "build", { buildRef: build.id })];
  const artifacts: InvestigationArtifactV1[] = [];
  const result: { summary: string; features: ProposedFeature[] } = {
    summary: "The selected saved Issue step was executed.",
    features: [],
  };
  const addFeatureObservations = (feature: E2eFeaturePlan) => {
    const assertionId = `assert-${feature.id}`;
    const screenshotId = `screenshot-${feature.id}`;
    const artifactId = `image-${feature.id}`;
    const binding = {
      featureId: feature.id,
      processRef: `application-${feature.id}`,
      buildRef: build.id,
      targetPid: 123,
      windowHandle: "44",
      interactionVersion: 1,
    };
    receipts.push(
      receipt(assertionId, "assert", { ...binding, assertion: true, assertionId: "result" }),
      receipt(screenshotId, "screenshot", {
        ...binding,
        relatedAssertionIds: [assertionId],
        artifactRefs: [artifactId],
      }),
    );
    artifacts.push({
      id: artifactId,
      taskId: task.id,
      attemptId: attempt.id,
      subjectRef: subject.id,
      kind: "image",
      name: `${feature.id}.png`,
      mediaType: "image/png",
      digest: "3".repeat(64),
      byteLength: 128,
      availability: "available",
    });
    result.features.push({
      featureId: feature.id,
      outcome: "passed",
      reason: "The registered assertion and matching UI state were captured.",
      assertionReceiptIds: [assertionId],
      mediaReceiptIds: [screenshotId],
      limitations: [],
    });
  };
  for (const feature of features) addFeatureObservations(feature);
  const events: string[] = [];
  const tools = {
    start: vi.fn(async () => {
      events.push("start");
      return {
        endpoint: "http://127.0.0.1:1234/tool",
        capability: "synthetic-private-capability",
        directory: "C:/Attempts/issue-verification/evidence",
      };
    }),
    cleanup: vi.fn(async () => {
      events.push("cleanup");
    }),
    assertObservationsPersisted: vi.fn(() => {}),
    receipts,
    artifacts,
    features,
    builds: [build],
    executionSignal: new AbortController().signal,
    get evidence(): InvestigationEvidenceV1[] {
      return receipts.map((entry) => ({
        id: entry.id,
        subjectRef: subject.id,
        source: entry.operation === "screenshot" ? "visual_observation" : "executor_observation",
        authority: "worker",
        summary: entry.summary,
        artifactRefs: [...entry.artifactRefs],
        evidenceRefs: [],
        provenance: {
          taskId: task.id,
          attemptId: attempt.id,
          producer: "e2e-tool-server",
          recordedAt: now,
        },
      }));
    },
  } satisfies AgentTools;
  const usage = { tokens: 123, source: "cli" as const, invocationId: "synthetic-invocation" };
  const execute = vi.fn<StaticModelJsonRunner["execute"]>(async () => {
    events.push("model");
    return { value: result, usage };
  });
  const createTools = vi.fn((_configuration: E2eToolServerOptions): AgentTools => tools);
  const options = {
    environment: { SystemRoot: "C:/Windows" },
    processLimits: {
      hardTimeoutMs: 60_000,
      maximumProcessCount: 16,
      maximumMemoryBytes: 536_870_912,
      maximumOutputBytes: 1_048_576,
    },
    powershellExecutablePath: "C:/Windows/powershell.exe",
    gitExecutablePath: "C:/Tools/git.exe",
    buildTools: { msbuild: "C:/Tools/MSBuild.exe" },
    modelOptions: { engine: "codex", model: "gpt-6-luna", fileIO } as ModelTurnRunnerOptions,
    jsonRunner: { execute },
    createTools,
  };
  const controller = new AbortController();
  const processHost: ProcessHostClient = {
    start: vi.fn(async () => {
      throw new Error("The adapter fixture must not launch any actual process.");
    }),
    terminateAll: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const context: Context = {
    signal: controller.signal,
    processHost,
    onProgress: vi.fn(),
    onRuntimeObservation: vi.fn(async () => {}),
  };
  const input: Input = {
    task,
    attempt,
    plan,
    stepId: "runtime-step",
    workspace: workspace as unknown as Input["workspace"],
  };
  return {
    adapter: createAgentVerificationPlanAdapter(options),
    input,
    context,
    task,
    attempt,
    subject,
    plan,
    workspace,
    snapshot,
    setSnapshot,
    fileIO,
    sourceBinding,
    build,
    tools,
    features,
    receipts,
    result,
    artifacts,
    addFeatureObservations,
    refreshPlanDigest,
    createTools,
    execute,
    usage,
    events,
  };
}

function useHeadlessChecks(f: ReturnType<typeof fixture>): void {
  for (const feature of f.features) {
    feature.userVisible = false;
    feature.assertions = [
      {
        id: "result",
        kind: "process",
        description: "The built executable reports its actual regression result.",
        outputPath: "app.exe",
        arguments: ["--verify-conversion"],
        expectedExitCode: 0,
        expectedOutputContains: "CONVERSION_PASS",
      },
    ];
  }
  const headlessReceipts = f.receipts
    .filter((entry) => entry.operation !== "screenshot")
    .map((entry): E2eToolReceipt => {
      if (entry.operation !== "assert") return entry;
      const {
        processRef: _process,
        targetPid: _pid,
        windowHandle: _window,
        interactionVersion: _interaction,
        ...observed
      } = entry;
      return {
        ...observed,
        operation: "run-check",
        observed: { exitCode: 0, stdout: "CONVERSION_PASS", stderr: "" },
        artifactRefs: [`log-${entry.featureId}`],
      };
    });
  f.receipts.splice(0, f.receipts.length, ...headlessReceipts);
  f.artifacts.splice(
    0,
    f.artifacts.length,
    ...f.features.map(
      (feature): InvestigationArtifactV1 => ({
        id: `log-${feature.id}`,
        taskId: f.task.id,
        attemptId: f.attempt.id,
        subjectRef: f.subject.id,
        kind: "log",
        name: `${feature.id}.json`,
        mediaType: "application/json",
        digest: "5".repeat(64),
        byteLength: 128,
        availability: "available",
      }),
    ),
  );
  for (const feature of f.result.features) feature.mediaReceiptIds = [];
}

describe("saved-plan agent verification adapter", () => {
  it.each([
    ["issue-verify", "source_commit"],
    ["issue-verify", "local_patch"],
    ["reproduction-setup", "source_commit"],
    ["reproduction-setup", "local_patch"],
  ] as const)(
    "verifies %s on %s without requiring a PR manifest",
    async (taskKind, subjectKind) => {
      const f = fixture(taskKind, subjectKind);
      const observed = await f.adapter.execute(f.input, f.context);

      expect(f.events).toEqual(["start", "model", "cleanup"]);
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.workspace.readPrDiffManifest).not.toHaveBeenCalled();
      expect(f.workspace.assertSourceBinding).toHaveBeenCalled();
      expect(f.createTools).toHaveBeenCalledWith(
        expect.objectContaining({
          task: f.task,
          attempt: f.attempt,
          workspace: f.input.workspace,
          processHost: f.context.processHost,
          sourcePathMode: "source",
          onRuntimeObservation: f.context.onRuntimeObservation,
        }),
      );
      expect(observed.checks.map((check) => check.id)).toEqual(checkIds);
      for (const check of observed.checks) {
        expect(check).toMatchObject({
          scenarioId: check.id,
          subjectRef: f.subject.id,
          planRef: f.task.planRef,
          required: true,
          status: "passed",
          executor: "e2e-tool-server",
          authoritativeAttemptId: f.attempt.id,
          evidenceRefs: [`assert-${check.id}`],
        });
      }
      expect(observed.evidence).toEqual(f.tools.evidence);
      expect(observed.artifacts).toEqual(f.artifacts);
      expect(observed.usage).toEqual(f.usage);
      expect(observed.durationMs).toBeGreaterThanOrEqual(0);
      expect(observed).not.toHaveProperty("e2e");
      expect(f.fileIO.writeExclusiveUtf8).not.toHaveBeenCalled();
      expect(f.context.processHost.start).not.toHaveBeenCalled();
    },
  );

  it("preserves independent passed, failed, and blocked checks within one saved step", async () => {
    const f = fixture();
    const failed = f.receipts.find((entry) => entry.id === "assert-saved:failure")!;
    f.receipts.splice(f.receipts.indexOf(failed), 1, { ...failed, status: "failed" });
    f.result.features[1]!.outcome = "failed";
    f.result.features[2]!.outcome = "blocked";
    f.result.features[2]!.reason = "The required UI state was unavailable.";
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.checks.map((check) => [check.id, check.status])).toEqual([
      ["saved:result", "passed"],
      ["saved:failure", "failed"],
      ["saved:blocked", "blocked"],
    ]);
    expect(observed.checks[0]!.evidenceRefs).toEqual(["assert-saved:result"]);
    expect(observed.checks[1]!.evidenceRefs).toEqual(["assert-saved:failure"]);
  });

  it("blocks a model-declared failure unless a real assertion actually failed", async () => {
    const f = fixture();
    f.result.features[0]!.outcome = "failed";
    f.result.features[0]!.reason = "The model suspects a failure despite the passed observation.";
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.checks[0]!).toMatchObject({
      id: "saved:result",
      status: "blocked",
      evidenceRefs: ["assert-saved:result"],
    });
    expect(observed.checks[1]!.status).toBe("passed");
  });

  it("retains setup observations without manufacturing checks outside the selected saved step", async () => {
    const f = fixture();
    const setup: E2eFeaturePlan = {
      ...f.features[0]!,
      id: "setup:window",
      title: "Open the window",
    };
    f.features.push(setup);
    f.addFeatureObservations(setup);
    const later: E2eFeaturePlan = {
      ...f.features[0]!,
      id: "saved:later",
      title: "Later saved step",
    };
    f.features.push(later);
    f.addFeatureObservations(later);
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.checks.map((check) => check.id)).toEqual(checkIds);
    expect(observed.checks.every((check) => check.status === "passed")).toBe(true);
    expect(observed.evidence.some((entry) => entry.id === "assert-setup:window")).toBe(true);
  });

  it.each(["empty response", "missing feature", "missing receipt", "generic command"] as const)(
    "does not promote %s into saved-check acceptance",
    async (mutation) => {
      const f = fixture();
      if (mutation === "empty response") f.result.features = [];
      if (mutation === "missing feature") {
        f.features.splice(0, 1);
        f.result.features.splice(0, 1);
      }
      if (mutation === "missing receipt") {
        const index = f.receipts.findIndex((entry) => entry.id === "assert-saved:result");
        f.receipts.splice(index, 1);
      }
      if (mutation === "generic command") {
        const index = f.receipts.findIndex((entry) => entry.id === "assert-saved:result");
        f.receipts[index] = { ...f.receipts[index]!, operation: "command", assertion: true };
      }
      const observed = await f.adapter.execute(f.input, f.context);
      const check = observed.checks.find((entry) => entry.id === "saved:result")!;

      expect(check.status).toBe("blocked");
      if (mutation !== "empty response") {
        expect(check.executor).toBeNull();
        expect(check.evidenceRefs).toEqual([]);
        expect(check.authoritativeAttemptId).toBeNull();
      }
      expect(f.tools.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("blocks a real passed assertion when no matching runtime media exists", async () => {
    const f = fixture();
    f.result.features[0]!.mediaReceiptIds = [];
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.checks[0]).toMatchObject({
      id: "saved:result",
      status: "blocked",
      executor: "e2e-tool-server",
      evidenceRefs: ["assert-saved:result"],
      authoritativeAttemptId: f.attempt.id,
    });
    expect(observed.checks[1]!.status).toBe("passed");
  });

  it("does not accept unavailable screenshots as runtime media", async () => {
    const f = fixture();
    f.artifacts[0]!.availability = "missing";
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.checks[0]!.status).toBe("blocked");
    expect(observed.checks[0]!.evidenceRefs).toEqual(["assert-saved:result"]);
    expect(observed.checks[1]!.status).toBe("passed");
    expect(observed.artifacts).toContainEqual(f.artifacts[0]);
  });

  it("passes genuine non-visual process checks with retained logs and no screenshot", async () => {
    const f = fixture();
    useHeadlessChecks(f);
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.checks.map((check) => check.status)).toEqual(["passed", "passed", "passed"]);
    expect(observed.artifacts.every((artifact) => artifact.kind === "log")).toBe(true);
    for (const check of observed.checks) {
      expect(check.evidenceRefs).toEqual([`assert-${check.id}`]);
      const evidence = observed.evidence.find((entry) => entry.id === check.evidenceRefs[0])!;
      expect(evidence.source).toBe("executor_observation");
      expect(evidence.artifactRefs).toEqual([`log-${check.id}`]);
    }
  });

  it.each([
    "empty assertions",
    "missing build",
    "missing assertion",
    "generic command",
    "another patch",
  ] as const)(
    "blocks a non-visual check with %s despite a passed model disposition",
    async (mutation) => {
      const f = fixture("issue-verify", "local_patch");
      useHeadlessChecks(f);
      if (mutation === "empty assertions") f.features[0]!.assertions = [];
      if (mutation === "missing build") f.tools.builds.splice(0, f.tools.builds.length);
      if (mutation === "missing assertion") {
        const index = f.receipts.findIndex((entry) => entry.id === "assert-saved:result");
        f.receipts.splice(index, 1);
      }
      if (mutation === "generic command") {
        const index = f.receipts.findIndex((entry) => entry.id === "assert-saved:result");
        f.receipts[index] = { ...f.receipts[index]!, operation: "command" };
      }
      if (mutation === "another patch")
        f.tools.builds[0] = {
          ...f.build,
          sourceBinding: { ...f.sourceBinding, patchDigest: "9".repeat(64) },
        };
      const observed = await f.adapter.execute(f.input, f.context);

      expect(observed.checks[0]!.status).toBe("blocked");
      expect(observed.checks[0]!.executor).toBeNull();
      expect(observed.checks[0]!.evidenceRefs).toEqual([]);
      expect(observed.checks[0]!.authoritativeAttemptId).toBeNull();
    },
  );

  it("retains a failed real process assertion even when the model proposes a pass", async () => {
    const f = fixture();
    useHeadlessChecks(f);
    const index = f.receipts.findIndex((entry) => entry.id === "assert-saved:result");
    f.receipts[index] = { ...f.receipts[index]!, status: "failed" };
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.checks[0]!.status).toBe("failed");
    expect(observed.checks[0]!.evidenceRefs).toEqual(["assert-saved:result"]);
    expect(observed.checks[1]!.status).toBe("passed");
  });

  it.each(["missing binding", "another patch", "another revision"] as const)(
    "cannot pass checks from a build with %s",
    async (mutation) => {
      const f = fixture("issue-verify", "local_patch");
      if (mutation === "missing binding") {
        const { sourceBinding: _binding, ...unbound } = f.build;
        f.tools.builds[0] = unbound;
      } else
        f.tools.builds[0] = {
          ...f.build,
          sourceBinding: {
            ...f.sourceBinding,
            ...(mutation === "another patch"
              ? { patchDigest: "9".repeat(64) }
              : { revisionKey: "8".repeat(64) }),
          },
        };
      const observed = await f.adapter.execute(f.input, f.context);

      expect(observed.checks.every((check) => check.status === "blocked")).toBe(true);
      expect(observed.checks.every((check) => check.executor === null)).toBe(true);
      expect(f.tools.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("forwards the full Issue context, selected saved step, budget, and usage lease", async () => {
    const f = fixture("reproduction-setup", "local_patch");
    const sourceContent = "SOURCE_BODY_NOT_FOR_PROMPT".repeat(100);
    f.snapshot.source = {
      artifactRef: "synthetic-source-artifact",
      artifactDigest: "4".repeat(64),
      sourceSha,
      files: [
        {
          path: sourcePaths[0]!,
          content: sourceContent,
          digest: createHash("sha256").update(sourceContent).digest("hex"),
        },
      ],
    };
    f.setSnapshot(f.snapshot);
    const invocationBudget = { deadlineAtMs: Date.now() + 60_000 };
    const usageLease: NonNullable<Context["usageLease"]> = {
      attemptId: f.attempt.id,
      fence: f.attempt.leaseVersion,
      leaseToken: "synthetic-worker-lease",
    };
    const context = { ...f.context, invocationBudget, usageLease };
    await f.adapter.execute(f.input, context);
    const modelInput = f.execute.mock.calls[0]![0];

    expect(modelInput.invocationBudget).toEqual(invocationBudget);
    expect(modelInput.usageLease).toBe(usageLease);
    expect(modelInput.usageContext).toMatchObject({ taskId: f.task.id, attemptId: f.attempt.id });
    expect(modelInput.toolPolicy).not.toBe("passive_proposal");
    expect(modelInput.outputProtectedValues).toEqual([
      "http://127.0.0.1:1234/tool",
      "synthetic-private-capability",
    ]);
    expect(modelInput.prompt).toContain(f.snapshot.title);
    expect(modelInput.prompt).toContain("SECOND_ISSUE_PARAGRAPH");
    expect(modelInput.prompt).toContain(JSON.stringify(f.snapshot.comments[0]!.body));
    expect(modelInput.prompt).toContain(JSON.stringify(f.snapshot.comments[1]!.provenance));
    expect(modelInput.prompt).toContain(JSON.stringify(f.plan.steps[0]));
    expect(modelInput.prompt).toContain(f.plan.digest);
    expect(modelInput.prompt).toContain(f.subject.id);
    expect(modelInput.prompt).toContain(patchDigest);
    expect(modelInput.prompt).toContain(sourceSha);
    for (const checkId of checkIds) expect(modelInput.prompt).toContain(checkId);
    const frozenContext = JSON.parse(
      modelInput.prompt
        .split("Frozen Issue context (untrusted task data):\n")[1]!
        .split("\n\nTrusted saved verification context:")[0]!,
    );
    const { source: _source, ...snapshotText } = f.snapshot;
    expect(frozenContext).toEqual({
      snapshotDigest: f.workspace.modelInputDigest,
      snapshot: snapshotText,
    });
    expect(modelInput.prompt).not.toContain("SOURCE_BODY_NOT_FOR_PROMPT");
    const envelope = JSON.parse(
      modelInput.prompt.split("Trusted saved verification context:\n")[1]!,
    );
    expect(envelope).toMatchObject({
      taskId: f.task.id,
      attemptId: f.attempt.id,
      workItem: f.task.workItem,
      subject: f.subject,
      sourceBinding: f.sourceBinding,
      scope: f.task.scope,
      executionPolicy: f.task.executionPolicy,
      step: f.plan.steps[0],
      acceptanceCriteria: f.plan.acceptanceCriteria,
    });
  });

  it.each([
    "source SHA",
    "patch digest",
    "patch artifact",
    "subject",
    "revision",
    "plan reference",
    "plan digest",
    "parent task",
    "parent report",
    "execution permission",
    "plan kind",
    "selected step",
  ] as const)("rejects a mismatched %s before starting tools or model", async (mutation) => {
    const f = fixture("issue-verify", "local_patch");
    if (mutation === "source SHA") f.sourceBinding.sourceSha = "9".repeat(40);
    if (mutation === "patch digest") f.sourceBinding.patchDigest = "9".repeat(64);
    if (mutation === "patch artifact") f.sourceBinding.artifactRef = "another-patch";
    if (mutation === "subject") f.sourceBinding.subjectRef = "another-subject";
    if (mutation === "revision") f.sourceBinding.revisionKey = "9".repeat(64);
    if (mutation === "plan reference") f.task.planRef!.digest = "9".repeat(64);
    if (mutation === "plan digest") f.plan.steps[0]!.description += " Changed after it was saved.";
    if (mutation === "parent task") f.task.parentTaskId = null;
    if (mutation === "parent report") f.task.parentReportRef!.id = "another-parent-report";
    if (mutation === "execution permission")
      f.task.executionPolicy.allowRepositoryExecution = false;
    if (mutation === "plan kind") f.plan.kind = "fix";
    const input = mutation === "selected step" ? { ...f.input, stepId: "missing-step" } : f.input;

    await expect(f.adapter.execute(input, f.context)).rejects.toMatchObject({
      code: "PLAN_AGENT_VERIFICATION_NOT_AUTHORIZED",
    });
    expect(f.createTools).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects a frozen Issue snapshot from another source subject before opening tools", async () => {
    const f = fixture();
    f.setSnapshot({ ...f.snapshot, subjectRef: "another-source-subject" });

    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "MODEL_INPUT_INVALID",
    });
    expect(f.createTools).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("accepts an older Issue-snapshot plan for its independently frozen source commit", async () => {
    const f = fixture();
    f.plan.subjectRef = f.task.subjects.find((entry) => entry.kind === "issue_snapshot")!.id;
    f.refreshPlanDigest();
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.checks.every((check) => check.status === "passed")).toBe(true);
    expect(observed.checks.every((check) => check.subjectRef === f.subject.id)).toBe(true);
  });

  it("requires an exact patch plan instead of adopting an older Issue-snapshot plan", async () => {
    const f = fixture("issue-verify", "local_patch");
    f.plan.subjectRef = f.task.subjects.find((entry) => entry.kind === "issue_snapshot")!.id;
    f.refreshPlanDigest();

    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "PLAN_AGENT_VERIFICATION_NOT_AUTHORIZED",
    });
    expect(f.createTools).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["model failure", "invalid output", "unpersisted observations"] as const)(
    "confirms cleanup after %s",
    async (failure) => {
      const f = fixture();
      const stopped = new ModelBudgetExceededError("duration");
      if (failure === "model failure") f.execute.mockRejectedValueOnce(stopped);
      if (failure === "invalid output")
        f.execute.mockResolvedValueOnce({
          value: { summary: "No valid feature matrix." },
          usage: f.usage,
        });
      if (failure === "unpersisted observations")
        f.tools.assertObservationsPersisted.mockImplementationOnce(() => {
          throw new Error("The Worker observation was not persisted.");
        });
      const pending = f.adapter.execute(f.input, f.context);
      if (failure === "model failure") await expect(pending).rejects.toBe(stopped);
      else if (failure === "invalid output")
        await expect(pending).rejects.toMatchObject({
          code: "PLAN_AGENT_VERIFICATION_OUTPUT_INVALID",
        });
      else await expect(pending).rejects.toThrow(/not persisted/u);

      expect(f.tools.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("reports unconfirmed cleanup without returning successful saved checks", async () => {
    const f = fixture();
    f.tools.cleanup.mockRejectedValueOnce(new Error("The owned application is still running."));

    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "E2E_CLEANUP_UNCONFIRMED",
    });
    expect(f.tools.cleanup).toHaveBeenCalledOnce();
  });

  it("preserves unavailable usage so the executor can block final adoption", async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({
      value: f.result,
      usage: { tokens: null, source: "unavailable" },
    });
    const observed = await f.adapter.execute(f.input, f.context);

    expect(observed.usage).toEqual({ tokens: null, source: "unavailable" });
    expect(observed.checks.every((check) => check.status === "passed")).toBe(true);
    expect(f.tools.cleanup).toHaveBeenCalledOnce();
  });
});
