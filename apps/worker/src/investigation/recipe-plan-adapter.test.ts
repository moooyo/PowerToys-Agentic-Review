import { createHash } from "node:crypto";
import {
  createInvestigationPreview,
  type InvestigationArtifactV1,
  type InvestigationEvidenceV1,
  type InvestigationRecipeStep,
  investigationCanonicalJson,
  investigationPlanDigestPayload,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import type { E2eBuildRecord } from "./e2e-build.js";
import type { E2eFeaturePlan } from "./e2e-feature-plan.js";
import type { E2eRecipeResult } from "./e2e-recipes.js";
import type { E2eToolReceipt, E2eToolServer, E2eToolServerOptions } from "./e2e-tool-server.js";
import { createRecipePlanAdapter } from "./recipe-plan-adapter.js";

type Adapter = ReturnType<typeof createRecipePlanAdapter>;
type Input = Parameters<Adapter["execute"]>[0];
type Context = Parameters<Adapter["execute"]>[1];
type RecipeFeature = Extract<
  InvestigationRecipeStep["request"],
  { recipeId: "powertoys-run-query" }
>["scenarios"][number]["feature"];
type RecipeTools = Pick<
  E2eToolServer,
  | "start"
  | "execute"
  | "cleanup"
  | "assertObservationsPersisted"
  | "receipts"
  | "evidence"
  | "artifacts"
  | "features"
  | "builds"
>;

const now = "2026-09-30T12:00:00.000Z";
const changedPath =
  "src/modules/launcher/Plugins/Community.PowerToys.Run.Plugin.UnitConverter/UnitHandler.cs";
const query = "%% 1 sqft in sqm";
const featureId = "area-conversion";
const scenarioId = "saved-area-scenario";

/** All execution, desktop, source, and persistence dependencies are synthetic. */
function fixture() {
  const initial = createInvestigationPreview("pr", { findingCount: 0 });
  const task = structuredClone(initial.task);
  const attempt = structuredClone(initial.attempt);
  const plan = structuredClone(initial.result.plans[0]!);
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef)!;
  if (subject.kind !== "original_pr") throw new Error("A PR subject is required.");
  task.repository.fullName = "fixture-owner/PowerToys";
  task.kind = "pr-verify";
  task.parentTaskId = "parent-task";
  task.parentReportRef = { ...plan.sourceReportRef, digest: "3".repeat(64) };
  task.executionPolicy = {
    mode: "execute",
    allowRepositoryExecution: true,
    authorizationRef: "authorization",
    allowedSubjectRefs: [subject.id],
  };
  const feature: RecipeFeature = {
    id: featureId,
    title: "Convert square feet to square metres",
    paths: [changedPath],
    scenario: "Enter an area query and inspect the exact input and converted result.",
    userVisible: true,
    assertions: [
      {
        id: "query",
        kind: "ui",
        description: "The query box contains the requested conversion.",
        selector: { automationId: "QueryTextBox" },
        assertion: { property: "value", expected: query, match: "equals" },
      },
      {
        id: "result",
        kind: "ui",
        description: "The area conversion is displayed.",
        selector: { name: "0.09290304 m²", controlType: "ListItem" },
        assertion: {
          property: "text",
          expected: "0.09290304 m²",
          match: "contains",
        },
      },
    ],
  };
  const recipe: InvestigationRecipeStep = {
    request: {
      recipeId: "powertoys-run-query",
      plugin: "UnitConverter",
      scenarios: [{ query, feature }],
    },
    checks: [
      { checkId: "saved-query-check", featureId, assertionId: "query", scenarioId },
      { checkId: "saved-result-check", featureId, assertionId: "result", scenarioId },
    ],
  };
  plan.steps = [
    {
      id: "recipe-step",
      description: "Run the saved area conversion scenario.",
      expectedObservation: "The requested input and correct conversion are visible together.",
      checkIds: recipe.checks.map((check) => check.checkId),
      recipe,
    },
  ];
  plan.digest = createHash("sha256")
    .update(investigationCanonicalJson(investigationPlanDigestPayload(plan)))
    .digest("hex");
  task.planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  const manifest = {
    schemaVersion: "InvestigationPrDiffManifestV1" as const,
    subjectRef: subject.id,
    baseSha: subject.baseSha,
    headSha: subject.headSha,
    mergeBaseSha: subject.baseSha,
    files: [{ path: changedPath, previousPath: null, status: "modified" as const, chunkIds: [] }],
    chunks: [],
    digest: "4".repeat(64),
  };
  const workspace = {
    attemptDirectory: "C:/Attempts/recipe",
    controlDirectory: "C:/Attempts/recipe/control",
    tempDirectory: "C:/Attempts/recipe/temp",
    sourceDirectory: "C:/Attempts/recipe/source",
    sourceBinding: {
      subjectRef: subject.id,
      revisionKey: subject.revisionKey,
      sourceSha: subject.headSha,
      patchDigest: null,
      artifactRef: "source",
    },
    assertIntegrity: vi.fn(async () => {}),
    assertSourceBinding: vi.fn(async () => {}),
    readPrDiffManifest: vi.fn(async () => manifest),
  };
  const build: E2eBuildRecord = {
    id: "build",
    headSha: subject.headSha,
    projectPath: "src/modules/launcher/PowerLauncher/PowerLauncher.csproj",
    projectDigest: "5".repeat(64),
    tool: "msbuild",
    command: ["msbuild.exe", "PowerLauncher.csproj"],
    artifacts: [
      {
        path: "C:/Attempts/recipe/build/PowerToys.PowerLauncher.exe",
        relativePath: "PowerToys.PowerLauncher.exe",
        digest: "6".repeat(64),
        byteLength: 1024,
      },
    ],
    manifestDigest: "7".repeat(64),
    manifestFileCount: 3,
    identity: "Worker-generated current-head build identity",
  };
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
  const uiBinding = {
    featureId,
    processRef: "application",
    buildRef: build.id,
    targetPid: 123,
    windowHandle: "44",
    interactionVersion: 1,
  };
  const observed: E2eRecipeResult = {
    recipeId: recipe.request.recipeId,
    summary: "The saved area conversion scenario completed.",
    cleanupConfirmed: true,
    features: [
      {
        featureId,
        outcome: "passed",
        reason: "Both registered assertions passed.",
        assertionReceiptIds: ["assert-query", "assert-result"],
        mediaReceiptIds: ["screenshot"],
        limitations: [],
      },
    ],
  };
  const outerReceipt = receipt("recipe", "run-recipe", { observed });
  const receipts: E2eToolReceipt[] = [
    receipt(build.id, "build", { buildRef: build.id }),
    receipt("assert-query", "assert", { ...uiBinding, assertion: true, assertionId: "query" }),
    receipt("assert-result", "assert", { ...uiBinding, assertion: true, assertionId: "result" }),
    receipt("screenshot", "screenshot", {
      ...uiBinding,
      relatedAssertionIds: ["assert-query", "assert-result"],
      artifactRefs: ["png"],
    }),
    outerReceipt,
  ];
  const artifacts: InvestigationArtifactV1[] = [
    {
      id: "png",
      taskId: task.id,
      attemptId: attempt.id,
      subjectRef: subject.id,
      kind: "image",
      name: "conversion.png",
      mediaType: "image/png",
      digest: "8".repeat(64),
      byteLength: 128,
      availability: "available",
    },
  ];
  const features: E2eFeaturePlan[] = [feature];
  const builds = [build];
  const events: string[] = [];
  const tools = {
    start: vi.fn(async () => {
      events.push("start");
      return {
        endpoint: "http://127.0.0.1:1234/tool",
        capability: "synthetic",
        directory: "C:/Attempts/recipe/evidence",
      };
    }),
    execute: vi.fn<RecipeTools["execute"]>(async () => {
      events.push("execute");
      return outerReceipt;
    }),
    cleanup: vi.fn(async () => {
      events.push("cleanup");
    }),
    assertObservationsPersisted: vi.fn(() => {}),
    receipts,
    artifacts,
    features,
    builds,
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
  } satisfies RecipeTools;
  const createTools = vi.fn((_configuration: E2eToolServerOptions): RecipeTools => tools);
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
    ffmpegExecutablePath: "C:/Tools/ffmpeg.exe",
    desktopDriverPath: "C:/Worker/e2e-desktop-driver.ps1",
    buildTools: { msbuild: "C:/Tools/MSBuild.exe" },
    buildToolDigests: { msbuild: "9".repeat(64) },
    msbuildToolchain: { vcToolsVersion: "14.44.35207", platformToolset: "v143" as const },
    createTools,
  };
  const controller = new AbortController();
  const processHost: ProcessHostClient = {
    start: vi.fn(async () => {
      throw new Error("The adapter fixture must not launch a process.");
    }),
    terminateAll: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const context: Context = {
    signal: controller.signal,
    processHost,
    onRuntimeObservation: vi.fn(async () => {}),
  };
  const input: Input = {
    task,
    attempt,
    plan,
    recipe,
    workspace: workspace as unknown as Input["workspace"],
  };
  return {
    adapter: createRecipePlanAdapter(options),
    input,
    context,
    controller,
    task,
    attempt,
    plan,
    recipe,
    subject,
    manifest,
    workspace,
    tools,
    createTools,
    options,
    events,
    observed,
    outerReceipt,
    receipts,
    artifacts,
    features,
    builds,
  };
}

describe("saved-plan recipe adapter", () => {
  it("executes one recipe and preserves saved check, scenario, plan, subject, and attempt identities", async () => {
    const f = fixture();
    const result = await f.adapter.execute(f.input, f.context);

    expect(f.events).toEqual(["start", "execute", "cleanup"]);
    expect(f.tools.execute).toHaveBeenCalledExactlyOnceWith({
      operation: "run-recipe",
      ...f.recipe.request,
    });
    expect(result.summary).toContain(f.observed.summary);
    expect(result.checks).toEqual([
      expect.objectContaining({
        id: "saved-query-check",
        scenarioId,
        subjectRef: f.task.subjectRef,
        planRef: f.task.planRef,
        required: true,
        status: "passed",
        executor: "e2e-tool-server",
        authoritativeAttemptId: f.attempt.id,
        evidenceRefs: ["assert-query"],
      }),
      expect.objectContaining({
        id: "saved-result-check",
        scenarioId,
        subjectRef: f.task.subjectRef,
        planRef: f.task.planRef,
        required: true,
        status: "passed",
        executor: "e2e-tool-server",
        authoritativeAttemptId: f.attempt.id,
        evidenceRefs: ["assert-result"],
      }),
    ]);
    expect(result.checks[0]!.evidenceRefs).not.toContain("assert-result");
    expect(result.checks[1]!.evidenceRefs).not.toContain("assert-query");
    expect(result.evidence).toEqual(f.tools.evidence);
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        id: "screenshot",
        source: "visual_observation",
        artifactRefs: ["png"],
      }),
    );
    for (const check of result.checks) {
      for (const evidenceRef of check.evidenceRefs) {
        expect(result.evidence.find((entry) => entry.id === evidenceRef)?.source).toBe(
          "executor_observation",
        );
      }
    }
    expect(result.artifacts).toEqual(f.artifacts);
    expect(result).not.toHaveProperty("e2e");
    expect(result).not.toHaveProperty("runtime");
    expect(f.tools.assertObservationsPersisted).toHaveBeenCalled();
    expect(f.workspace.assertSourceBinding).toHaveBeenCalledTimes(2);
    expect(f.workspace.assertSourceBinding.mock.invocationCallOrder[0]).toBeLessThan(
      f.tools.start.mock.invocationCallOrder[0]!,
    );
    expect(f.workspace.assertSourceBinding.mock.invocationCallOrder[1]).toBeGreaterThan(
      f.tools.cleanup.mock.invocationCallOrder[0]!,
    );
  });

  it("passes current source paths, execution dependencies, and the evidence observer into the tool session", async () => {
    const f = fixture();
    await f.adapter.execute(f.input, f.context);

    expect(f.createTools).toHaveBeenCalledExactlyOnceWith({
      task: f.task,
      attempt: f.attempt,
      workspace: f.workspace,
      signal: f.context.signal,
      processHost: f.context.processHost,
      changedPaths: [changedPath],
      environment: f.options.environment,
      processLimits: f.options.processLimits,
      powershellExecutablePath: f.options.powershellExecutablePath,
      gitExecutablePath: f.options.gitExecutablePath,
      ffmpegExecutablePath: f.options.ffmpegExecutablePath,
      desktopDriverPath: f.options.desktopDriverPath,
      buildTools: f.options.buildTools,
      buildToolDigests: f.options.buildToolDigests,
      msbuildToolchain: f.options.msbuildToolchain,
      onRuntimeObservation: f.context.onRuntimeObservation,
    });
    const observation = { evidence: f.tools.evidence, artifacts: f.artifacts };
    await f.createTools.mock.calls[0]![0].onRuntimeObservation!(observation);
    expect(f.context.onRuntimeObservation).toHaveBeenCalledWith(observation);
  });

  it("retains a failed assertion while its independently evidenced sibling passes", async () => {
    const f = fixture();
    f.receipts[2] = { ...f.receipts[2]!, status: "failed" };
    f.observed.features[0]!.outcome = "failed";
    f.observed.features[0]!.reason = "The result differs from the registered expectation.";

    const result = await f.adapter.execute(f.input, f.context);

    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["saved-query-check", "passed"],
      ["saved-result-check", "failed"],
    ]);
    expect(result.checks[1]!.evidenceRefs).toContain("assert-result");
  });

  it.each([
    "missing build",
    "wrong build revision",
    "missing build receipt",
    "failed build receipt",
    "generic command build receipt",
    "wrong assertion build",
    "missing matching assertion",
    "wrong feature assertion",
    "non-assertion receipt",
    "non-UI assertion receipt",
    "unselected assertion",
    "missing screenshot",
    "unrelated screenshot",
    "wrong screenshot process",
    "wrong screenshot PID",
    "wrong screenshot window",
    "unavailable screenshot",
    "log instead of image",
  ])("blocks a claimed pass with %s", async (mutation) => {
    const f = fixture();
    if (mutation === "missing build") f.builds.length = 0;
    if (mutation === "wrong build revision")
      f.builds[0] = { ...f.builds[0]!, headSha: "f".repeat(40) };
    if (mutation === "missing build receipt") f.receipts.splice(0, 1);
    if (mutation === "failed build receipt")
      f.receipts[0] = { ...f.receipts[0]!, status: "failed" };
    if (mutation === "generic command build receipt")
      f.receipts[0] = { ...f.receipts[0]!, operation: "command" };
    if (mutation === "wrong assertion build")
      f.receipts[2] = { ...f.receipts[2]!, buildRef: "unverified-build" };
    if (mutation === "missing matching assertion") f.receipts.splice(2, 1);
    if (mutation === "wrong feature assertion")
      f.receipts[2] = { ...f.receipts[2]!, featureId: "different-feature" };
    if (mutation === "non-assertion receipt")
      f.receipts[2] = { ...f.receipts[2]!, assertion: false };
    if (mutation === "non-UI assertion receipt")
      f.receipts[2] = { ...f.receipts[2]!, operation: "command" };
    if (mutation === "unselected assertion")
      f.observed.features[0]!.assertionReceiptIds = ["assert-query"];
    if (mutation === "missing screenshot") f.receipts.splice(3, 1);
    if (mutation === "unrelated screenshot")
      f.receipts[3] = { ...f.receipts[3]!, relatedAssertionIds: ["assert-query"] };
    if (mutation === "wrong screenshot process")
      f.receipts[3] = { ...f.receipts[3]!, processRef: "another-process" };
    if (mutation === "wrong screenshot PID") f.receipts[3] = { ...f.receipts[3]!, targetPid: 456 };
    if (mutation === "wrong screenshot window")
      f.receipts[3] = { ...f.receipts[3]!, windowHandle: "another-window" };
    if (mutation === "unavailable screenshot") f.artifacts[0]!.availability = "missing";
    if (mutation === "log instead of image") f.artifacts[0]!.kind = "log";

    const result = await f.adapter.execute(f.input, f.context);

    expect(result.checks[1]!.status).toBe("blocked");
    expect(f.tools.cleanup).toHaveBeenCalledOnce();
  });

  it("blocks declared cleanup uncertainty even when all assertions and media are present", async () => {
    const f = fixture();
    const uncertain = {
      ...f.outerReceipt,
      observed: { ...f.observed, cleanupConfirmed: false },
    };
    f.receipts[f.receipts.length - 1] = uncertain;
    f.tools.execute.mockResolvedValueOnce(uncertain);

    const result = await f.adapter.execute(f.input, f.context);

    expect(result.checks.every((check) => check.status === "blocked")).toBe(true);
  });

  it("does not let a later passing receipt erase an earlier observed assertion failure", async () => {
    const f = fixture();
    f.receipts.splice(2, 0, { ...f.receipts[2]!, id: "earlier-failure", status: "failed" });

    const result = await f.adapter.execute(f.input, f.context);

    expect(result.checks[1]!.status).toBe("failed");
    expect(result.checks[1]!.evidenceRefs).toContain("earlier-failure");
  });

  it("uses the outer receipt as blocker evidence when no assertion was reached", async () => {
    const f = fixture();
    const blocked: E2eToolReceipt = {
      ...f.outerReceipt,
      status: "blocked",
      summary: "The recipe could not register or build the pinned source.",
      observed: { error: "The pinned source project is unavailable." },
    };
    f.receipts.splice(0, f.receipts.length, blocked);
    f.tools.execute.mockResolvedValue(blocked);
    f.features.length = 0;
    f.builds.length = 0;
    f.artifacts.length = 0;

    const result = await f.adapter.execute(f.input, f.context);

    expect(result.checks).toHaveLength(2);
    for (const check of result.checks) {
      expect(check.status).toBe("blocked");
      expect(check.evidenceRefs).toContain(blocked.id);
      expect(check.executor).toBe("e2e-tool-server");
      expect(check.authoritativeAttemptId).toBe(f.attempt.id);
      expect(check.planRef).toEqual(f.task.planRef);
    }
    expect(result.evidence).toEqual(f.tools.evidence);
  });

  it.each(["head", "base"] as const)(
    "rejects a changed manifest %s before opening the tool session",
    async (revision) => {
      const f = fixture();
      if (revision === "head") f.manifest.headSha = "f".repeat(40);
      else f.manifest.baseSha = "f".repeat(40);

      await expect(f.adapter.execute(f.input, f.context)).rejects.toThrow();

      expect(f.createTools).not.toHaveBeenCalled();
      expect(f.tools.execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    "wrong task kind",
    "wrong plan ID",
    "wrong plan version",
    "wrong plan digest",
    "wrong attempt task",
    "wrong source revision",
    "missing authorization",
  ])("rejects %s before opening the tool session", async (mutation) => {
    const f = fixture();
    if (mutation === "wrong task kind") f.task.kind = "pr-e2e";
    if (mutation === "wrong plan ID") f.task.planRef!.id = "other-plan";
    if (mutation === "wrong plan version") f.task.planRef!.version += 1;
    if (mutation === "wrong plan digest") f.task.planRef!.digest = "a".repeat(64);
    if (mutation === "wrong attempt task") f.attempt.taskId = "other-task";
    if (mutation === "wrong source revision") f.workspace.sourceBinding.sourceSha = "a".repeat(40);
    if (mutation === "missing authorization") f.task.executionPolicy.authorizationRef = null;

    await expect(f.adapter.execute(f.input, f.context)).rejects.toThrow();

    expect(f.createTools).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
  });

  it("rejects an unmapped saved assertion before opening the tool session", async () => {
    const f = fixture();
    f.recipe.checks[1]!.assertionId = "unregistered-assertion";

    await expect(f.adapter.execute(f.input, f.context)).rejects.toThrow();

    expect(f.createTools).not.toHaveBeenCalled();
  });

  it("rejects a declared assertion without a saved check before opening the tool session", async () => {
    const f = fixture();
    f.recipe.checks.pop();

    await expect(f.adapter.execute(f.input, f.context)).rejects.toThrow();

    expect(f.createTools).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate assertion mappings before opening the tool session", async () => {
    const f = fixture();
    f.recipe.checks.push({ ...f.recipe.checks[0]!, checkId: "duplicate-query-check" });

    await expect(f.adapter.execute(f.input, f.context)).rejects.toThrow();

    expect(f.createTools).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
  });

  it("rejects source-binding failure before opening the tool session", async () => {
    const f = fixture();
    const failure = new Error("The source binding changed.");
    f.workspace.assertSourceBinding.mockRejectedValueOnce(failure);

    await expect(f.adapter.execute(f.input, f.context)).rejects.toBe(failure);

    expect(f.createTools).not.toHaveBeenCalled();
  });

  it("rejects post-execution source changes after cleaning the tool session", async () => {
    const f = fixture();
    const failure = new Error("Tracked source changed during execution.");
    f.workspace.assertSourceBinding.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);

    await expect(f.adapter.execute(f.input, f.context)).rejects.toBe(failure);

    expect(f.tools.execute).toHaveBeenCalledOnce();
    expect(f.tools.cleanup).toHaveBeenCalledOnce();
  });

  it("does not return a result when receipt observations were not persisted", async () => {
    const f = fixture();
    const failure = new Error("The evidence observer failed.");
    f.tools.assertObservationsPersisted.mockImplementation(() => {
      throw failure;
    });

    await expect(f.adapter.execute(f.input, f.context)).rejects.toBe(failure);

    expect(f.tools.cleanup).toHaveBeenCalledOnce();
  });

  it.each(["start", "execute"] as const)(
    "cleans the tool session when %s throws",
    async (operation) => {
      const f = fixture();
      const failure = new Error(`The synthetic ${operation} failed.`);
      f.tools[operation].mockRejectedValueOnce(failure);

      await expect(f.adapter.execute(f.input, f.context)).rejects.toBe(failure);

      expect(f.tools.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("rethrows the cancellation reason after cleanup", async () => {
    const f = fixture();
    const reason = new Error("The task was cancelled.");
    f.tools.execute.mockImplementationOnce(async () => {
      f.controller.abort(reason);
      throw reason;
    });

    await expect(f.adapter.execute(f.input, f.context)).rejects.toBe(reason);

    expect(f.tools.cleanup).toHaveBeenCalledOnce();
  });

  it("does not publish a successful result after cancellation during cleanup", async () => {
    const f = fixture();
    const reason = new Error("The task ended while owned processes were stopping.");
    f.tools.cleanup.mockImplementationOnce(async () => {
      f.controller.abort(reason);
    });

    await expect(f.adapter.execute(f.input, f.context)).rejects.toBe(reason);

    expect(f.tools.cleanup).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps cleanup failure authoritative when execution fails=%s",
    async (executionFails) => {
      const f = fixture();
      if (executionFails) f.tools.execute.mockRejectedValueOnce(new Error("The recipe failed."));
      f.tools.cleanup.mockRejectedValueOnce(new Error("An owned application is still running."));

      await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
        code: "E2E_CLEANUP_UNCONFIRMED",
      });

      expect(f.tools.cleanup).toHaveBeenCalledOnce();
    },
  );
});
