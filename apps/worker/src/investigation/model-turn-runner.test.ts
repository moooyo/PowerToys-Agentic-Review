import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationLoopRoundV1,
  InvestigationModelEditsV1Schema,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint, investigationContentDigest } from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import {
  type ManagedProcess,
  type ProcessExitedEvent,
  type ProcessLaunchSpec,
  processHostProtocolVersion,
} from "../execution/process-host-protocol.js";
import { createInvestigationModelOutputSchema } from "./model-output-schema.js";
import {
  type InvestigationModelTurnDeltaV1,
  InvestigationModelTurnDeltaV1Schema,
  type ModelTurnProjectionContext,
} from "./model-turn-projection.js";
import {
  createModelTurnRunner,
  createStaticModelJsonRunner,
  type ModelTurnExecutionInput,
  type ModelTurnFileIO,
  type ModelTurnFileStat,
  type ModelTurnRunnerOptions,
} from "./model-turn-runner.js";
import type { InvestigationPrDiffManifest, PreparedInvestigationWorkspace } from "./workspace.js";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const jsonl = (...events: unknown[]) => events.map((event) => `${JSON.stringify(event)}\n`);
const codexComplete = {
  type: "turn.completed",
  usage: { input_tokens: 31, cached_input_tokens: 7, output_tokens: 19 },
};
const copilotFinal = (content: string) => ({ type: "assistant.message", data: { content } });
const copilotComplete = {
  type: "result",
  exitCode: 0,
  usage: { inputTokens: 31, outputTokens: 19 },
};

function roundDelta(
  round: InvestigationLoopRoundV1,
  selectedUnitIds = round.analysis.coverage.includedUnits.map((unit) => unit.id),
): InvestigationModelTurnDeltaV1 {
  const { schemaVersion: _schemaVersion, coverage, ...analysis } = round.analysis;
  return {
    ...round,
    schemaVersion: "InvestigationModelTurnDeltaV1",
    analysis: {
      ...analysis,
      coverageUnits: coverage.includedUnits.filter((unit) => selectedUnitIds.includes(unit.id)),
      removedFindingIds: [],
    },
  };
}

function fixtureDelta(
  round: InvestigationLoopRoundV1,
  context: ModelTurnProjectionContext,
): InvestigationModelTurnDeltaV1 {
  const delta = roundDelta(
    round,
    context.analysis.coverageUnits.map((unit) => unit.id),
  );
  if (context.inputCheckpointRef !== null) {
    delta.analysis.summary = null;
    delta.analysis.assessment = null;
    const visible = <T extends { id: string }>(
      records: T[],
      supplied: readonly { id: string }[],
    ): T[] => records.filter((record) => supplied.some((item) => item.id === record.id));
    delta.analysis.findings = visible(delta.analysis.findings, context.analysis.findings);
    delta.analysis.candidates = visible(delta.analysis.candidates, context.analysis.candidates);
    delta.analysis.rechecks = visible(delta.analysis.rechecks, context.analysis.rechecks);
    delta.analysis.evidence = visible(delta.analysis.evidence, context.analysis.evidence);
    delta.analysis.plans = visible(delta.analysis.plans, context.analysis.plans);
    delta.analysis.nextActions = visible(delta.analysis.nextActions, context.analysis.nextActions);
    delta.analysis.feedbackDrafts = visible(
      delta.analysis.feedbackDrafts,
      context.analysis.feedbackDrafts,
    );
    delta.analysis.diagnostics = visible(delta.analysis.diagnostics, context.analysis.diagnostics);
    delta.analysis.limitations = visible(delta.analysis.limitations, context.analysis.limitations);
  }
  return delta;
}

function fixture(
  settings: {
    engine?: "codex" | "copilot";
    findingCount?: number;
    outputText?: string;
    usageFile?: unknown;
    stdout?: readonly (string | Buffer)[];
    exit?: Partial<ProcessExitedEvent>;
    options?: Partial<ModelTurnRunnerOptions>;
  } = {},
) {
  const synthetic = createInvestigationFixture("bug", { findingCount: settings.findingCount ?? 1 });
  const task = {
    ...synthetic.task,
    executionPolicy: { ...synthetic.task.executionPolicy, mode: "snapshot_only" as const },
    scope: {
      ...synthetic.task.scope,
      includedUnits: synthetic.task.scope.includedUnits.map((unit) => ({
        ...unit,
        status: "pending" as const,
        evidenceRefs: [],
      })),
      completedUnitRefs: [],
      unresolvedUnitRefs: synthetic.task.scope.includedUnits.map((unit) => unit.id),
    },
  };
  const analysis: InvestigationAnalysisV1 = {
    schemaVersion: "InvestigationAnalysisV1",
    summary: "Static analysis of the complete supplied batch.",
    coverage: synthetic.result.report.coverage,
    findings: synthetic.result.findings.map((finding) => ({
      ...finding,
      confirmation: { ...finding.confirmation, recheckRef: null },
    })),
    assessment: synthetic.result.assessment,
    candidates: synthetic.result.report.loop.candidates,
    rechecks: [],
    evidence: synthetic.result.verificationEvidence.map((item) => ({
      id: item.id,
      subjectRef: item.subjectRef,
      source:
        item.source === "reporter_statement"
          ? ("reporter_statement" as const)
          : ("static_analysis" as const),
      summary: item.summary,
      evidenceRefs: item.evidenceRefs,
    })),
    plans: synthetic.result.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...plan }) => plan,
    ),
    nextActions: synthetic.result.nextActions.map(
      ({ state: _state, sourceReportRef: _source, ...action }) => action,
    ),
    feedbackDrafts: synthetic.result.feedbackDrafts,
    diagnostics: synthetic.result.diagnostics,
    limitations: synthetic.result.report.limitations,
  };
  const round: InvestigationLoopRoundV1 = {
    schemaVersion: "InvestigationLoopRoundV1",
    taskId: task.id,
    attemptId: synthetic.attempt.id,
    inputCheckpointRef: null,
    round: 1,
    phase: "discovery",
    analysis,
    continue: true,
    continuationReason: "The coordinator must schedule individual final rechecks.",
  };
  const root = "C:\\Worker\\investigations\\attempt-1";
  const modelInputDirectory = win32.join(root, "model-input");
  const modelInputPath = win32.join(modelInputDirectory, "snapshot.json");
  const controlDirectory = win32.join(root, "control");
  const roundDirectory = win32.join(controlDirectory, "round-fixture");
  const frozenFiles = synthetic.result.findings.flatMap((finding) =>
    finding.locations.flatMap((location) =>
      location.kind === "source"
        ? [
            {
              path: location.path,
              content: "export const synthetic = true;\n",
              digest: hash("export const synthetic = true;\n"),
            },
          ]
        : [],
    ),
  );
  const frozenInput = JSON.stringify({
    schemaVersion: "InvestigationInputSnapshotV1",
    repositoryId: task.repository.id,
    workItemId: task.workItem.id,
    subjectRef: task.subjectRef,
    subjectRevisionKey: task.subjects[0]!.revisionKey,
    title: task.workItem.title,
    body: "Synthetic frozen issue text; no live repository was accessed.",
    comments: [],
    source: {
      artifactRef: "frozen-source",
      artifactDigest: hash(JSON.stringify(frozenFiles)),
      sourceSha: "b".repeat(40),
      files: frozenFiles,
    },
  });
  const files = new Map<string, Buffer>([[modelInputPath, Buffer.from(frozenInput)]]);
  const directories = new Set([
    root,
    modelInputDirectory,
    controlDirectory,
    win32.join(root, "temp"),
  ]);
  const identities = new Map<string, bigint>();
  let nextIdentity = 1n;
  const stat = (path: string): ModelTurnFileStat => {
    if (!directories.has(path) && !files.has(path))
      throw Object.assign(new Error("Fixture path is absent."), { code: "ENOENT" });
    if (!identities.has(path)) identities.set(path, nextIdentity++);
    return {
      dev: 1n,
      ino: identities.get(path)!,
      size: BigInt(files.get(path)?.length ?? 0),
      mtimeMs: 1n,
      ctimeMs: 1n,
      nlink: 1n,
      isFile: () => files.has(path),
      isDirectory: () => directories.has(path),
      isSymbolicLink: () => false,
    };
  };
  const io: ModelTurnFileIO = {
    createPrivateDirectory: vi.fn(async (prefix) => {
      expect(prefix).toBe(win32.join(controlDirectory, "round-"));
      directories.add(roundDirectory);
      return roundDirectory;
    }),
    writeExclusiveUtf8: vi.fn(async (path, text) => {
      if (files.has(path)) throw new Error("The fixture prevents replacing an existing file.");
      files.set(path, Buffer.from(text));
    }),
    lstat: vi.fn(async (path) => stat(path)),
    realpath: vi.fn(async (path) => path),
    openRead: vi.fn(async (path) => ({
      stat: async () => stat(path),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const content = files.get(path)!;
        const bytesRead = Math.max(0, Math.min(length, content.length - position));
        content.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      close: async () => undefined,
    })),
    removeDirectory: vi.fn(async (path) => {
      expect(path).toBe(roundDirectory);
      for (const name of files.keys()) if (name.startsWith(`${path}\\`)) files.delete(name);
      directories.delete(path);
    }),
  };
  const workspace: PreparedInvestigationWorkspace = {
    attemptDirectory: root,
    modelInputDirectory,
    modelInputPath,
    modelInputDigest: hash(frozenInput),
    controlDirectory,
    tempDirectory: win32.join(root, "temp"),
    sourceDirectory: null,
    sourceBinding: null,
    assertIntegrity: vi.fn(async () => undefined),
    assertSourceBinding: vi.fn(async () => undefined),
    resolveSourcePath: vi.fn(async (path) => win32.join(root, "source", path)),
    writeArtifact: vi.fn(),
    readArtifact: vi.fn(),
    writePatchArtifact: vi.fn(),
    readSourceFile: vi.fn(),
    readPrDiffManifest: vi.fn(),
    readPrDiffChunk: vi.fn(),
    applyEdits: vi.fn(),
    capturePatch: vi.fn(),
    cleanup: vi.fn(async () => undefined),
  };
  const engine = settings.engine ?? "codex";
  const exit: ProcessExitedEvent = {
    protocolVersion: processHostProtocolVersion,
    type: "exited",
    requestId: "round-request",
    exitCode: 0,
    signal: null,
    outputTruncated: false,
    ...settings.exit,
  };
  const terminate = vi.fn(async () => undefined);
  const start = vi.fn(
    async (spec: ProcessLaunchSpec, _signal: AbortSignal): Promise<ManagedProcess> => {
      const contextText = (spec.standardInput ?? "")
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!;
      const context = JSON.parse(contextText) as { turn: ModelTurnProjectionContext };
      round.phase = context.turn.phase;
      round.round = context.turn.round;
      round.inputCheckpointRef = context.turn.inputCheckpointRef;
      const outputText = settings.outputText ?? JSON.stringify(fixtureDelta(round, context.turn));
      if (engine === "codex")
        files.set(win32.join(roundDirectory, "round-result.json"), Buffer.from(outputText));
      if (engine === "copilot" && settings.usageFile !== undefined)
        files.set(
          win32.join(roundDirectory, "round-usage.json"),
          Buffer.from(JSON.stringify(settings.usageFile)),
        );
      return {
        requestId: exit.requestId,
        processId: 17,
        completed: Promise.resolve(exit),
        terminate,
        stdout: Readable.from(
          settings.stdout ??
            (engine === "codex"
              ? jsonl(codexComplete)
              : jsonl(
                  copilotFinal(outputText),
                  settings.usageFile === undefined
                    ? copilotComplete
                    : { ...copilotComplete, usage: { premiumRequests: 1 } },
                )),
        ),
        stderr: Readable.from([]),
      };
    },
  );
  const options: ModelTurnRunnerOptions = {
    engine,
    cliExecutablePath: `C:\\Trusted\\${engine}.exe`,
    processHost: { start },
    environment: {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: "C:\\Users\\ModelAccount",
    },
    limits: {
      hardTimeoutMs: 60_000,
      maximumProcessCount: 8,
      maximumMemoryBytes: 1024 * 1024 * 1024,
      maximumOutputBytes: 16 * 1024 * 1024,
    },
    staticConfiguration: { verified: true, disabledMcpServers: ["external-services"] },
    fileIO: io,
    ...settings.options,
  };
  const controller = new AbortController();
  const input: ModelTurnExecutionInput = {
    task,
    attempt: synthetic.attempt,
    checkpoint: null,
    workspace,
    signal: controller.signal,
  };
  return {
    input,
    options,
    round,
    analysis,
    io,
    files,
    directories,
    roundDirectory,
    start,
    terminate,
    exit,
    controller,
    runner: createModelTurnRunner(options),
  };
}

describe("investigation model turn runner", () => {
  it.each(["codex", "copilot"] as const)(
    "runs %s through ProcessHost and validates the native round schema",
    async (engine) => {
      const f = fixture({ engine });
      const result = await f.runner.execute(f.input);
      const normalizedScope = createInvestigationCheckpoint({
        task: f.input.task,
        attemptId: f.input.attempt.id,
        checkpointId: "expected-canonical-scope",
        leaseVersion: f.input.attempt.leaseVersion,
        recordedAt: f.input.task.updatedAt,
      }).analysis.coverage.scopeManifest;
      const expectedRound = {
        ...f.round,
        analysis: {
          ...f.round.analysis,
          coverage: { ...f.round.analysis.coverage, scopeManifest: normalizedScope },
        },
      };
      expect(result).toEqual({ round: expectedRound, usage: { tokens: 50, source: "cli" } });
      expect(f.start).toHaveBeenCalledOnce();
      const [spec, signal] = f.start.mock.calls[0]!;
      expect(signal).not.toBe(f.input.signal);
      expect(spec.environmentMode).toBe("replace");
      expect(spec.environment).not.toHaveProperty("WORKER_TOKEN");
      expect(spec.standardInput).toContain("Synthetic frozen issue text");
      expect(spec.standardInput).toContain("Do not run commands, tests, builds");
      expect(spec.arguments).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(spec.arguments).not.toContain("--allow-all");
      if (engine === "codex") {
        expect(spec.arguments).toContain("features.shell_tool=false");
        expect(spec.arguments).toContain("read-only");
      } else expect(spec.arguments).toContain("--available-tools=view,glob,grep");
      expect(f.io.writeExclusiveUtf8).toHaveBeenCalledWith(
        win32.join(f.roundDirectory, "round-schema.json"),
        JSON.stringify(createInvestigationModelOutputSchema(InvestigationModelTurnDeltaV1Schema)),
      );
      expect(f.io.removeDirectory).toHaveBeenCalledWith(f.roundDirectory);
      expect(f.input.workspace.cleanup).not.toHaveBeenCalled();
    },
  );

  it.each(["codex", "copilot"] as const)(
    "accepts %s rounds above 2 MiB without a finding count cap",
    async (engine) => {
      const f = fixture({ engine, findingCount: 101 });
      f.round.analysis.summary = "Complete static analysis. ".repeat(100_000);
      expect(Buffer.byteLength(JSON.stringify(f.round))).toBeGreaterThan(2 * 1024 * 1024);
      const result = await f.runner.execute(f.input);
      expect(result.round.analysis.findings).toHaveLength(101);
      expect(result.round.analysis.summary).toBe(f.round.analysis.summary);
    },
  );

  it("preserves unavailable token usage instead of manufacturing zero", async () => {
    const f = fixture({ stdout: jsonl({ type: "turn.completed" }) });
    expect((await f.runner.execute(f.input)).usage).toEqual({
      tokens: null,
      source: "unavailable",
    });
  });

  it("reads Copilot's owned usage sidecar without double-counting agent or reasoning metrics", async () => {
    const f = fixture({
      engine: "copilot",
      usageFile: {
        modelMetrics: {
          primary: {
            usage: {
              inputTokens: 20,
              outputTokens: 10,
              cacheReadTokens: 200,
              cacheWriteTokens: 100,
              reasoningTokens: 6,
            },
          },
          secondary: {
            usage: { inputTokens: 40, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        },
        agentMetrics: { primary: { usage: { inputTokens: 20, outputTokens: 10 } } },
      },
    });
    expect((await f.runner.execute(f.input)).usage).toEqual({ tokens: 73, source: "cli" });
    const argumentsList = f.start.mock.calls[0]![0].arguments;
    expect(argumentsList[argumentsList.indexOf("--usage-output-file") + 1]).toBe(
      win32.join(f.roundDirectory, "round-usage.json"),
    );
  });

  it("fails closed for a PR review without a frozen complete diff checkpoint", async () => {
    const f = fixture();
    await expect(
      f.runner.execute({ ...f.input, task: { ...f.input.task, kind: "pr-review" } }),
    ).rejects.toMatchObject({ code: "MODEL_SOURCE_UNAVAILABLE" });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("delivers frozen deleted-file diff/base chunks without reading a missing head file", async () => {
    const f = fixture();
    const pr = createInvestigationFixture("pr", { findingCount: 0 });
    const task = {
      ...pr.task,
      scope: {
        ...pr.task.scope,
        includedUnits: [
          {
            id: "full-diff",
            subjectRef: pr.task.subjectRef,
            kind: "full_diff",
            paths: [],
            requiredWork: "Review the complete frozen PR diff.",
            status: "pending" as const,
            evidenceRefs: [],
          },
        ],
        completedUnitRefs: [],
        unresolvedUnitRefs: ["full-diff"],
      },
    };
    const contents = new Map([
      [
        "deleted-diff",
        "diff --git a/src/deleted.ts b/src/deleted.ts\n@@ -1 +0,0 @@\n-export const removed = true;\n",
      ],
      ["deleted-base", "export const removed = true;\n"],
    ]);
    const descriptors = [...contents].map(([id, content], ordinal) => ({
      id,
      path: "src/deleted.ts",
      kind: id === "deleted-base" ? ("base" as const) : ("diff" as const),
      ordinal,
      encoding: "utf8" as const,
      contentDigest: hash(content),
      byteLength: Buffer.byteLength(content),
    }));
    const subject = task.subjects[0]!;
    if (subject.kind !== "original_pr")
      throw new Error("The synthetic PR subject must be immutable.");
    const manifestContent = {
      schemaVersion: "InvestigationPrDiffManifestV1" as const,
      subjectRef: subject.id,
      baseSha: subject.baseSha,
      headSha: subject.headSha,
      mergeBaseSha: subject.baseSha,
      files: [
        {
          path: "src/deleted.ts",
          previousPath: null,
          status: "deleted" as const,
          chunkIds: descriptors.map((chunk) => chunk.id),
        },
      ],
      chunks: descriptors,
    };
    const manifest: InvestigationPrDiffManifest = {
      ...manifestContent,
      digest: investigationContentDigest(manifestContent),
    };
    const checkpoint = createInvestigationCheckpoint({
      task,
      attemptId: pr.attempt.id,
      checkpointId: "pr-source-checkpoint",
      leaseVersion: 1,
      recordedAt: task.updatedAt,
    });
    checkpoint.analysis.coverage.includedUnits.push(
      ...descriptors.map((chunk) => ({
        id: chunk.id,
        subjectRef: subject.id,
        kind: "pr_diff_chunk",
        paths: [chunk.path],
        requiredWork: `Review frozen ${chunk.kind} chunk ${chunk.id}.`,
        status: "pending" as const,
        evidenceRefs: [],
      })),
    );
    checkpoint.analysis.coverage.unresolvedUnitRefs.push(...descriptors.map((chunk) => chunk.id));
    checkpoint.runtime.sourceCoverage = {
      manifest: { ...manifestContent, digest: manifest.digest },
      brokeredUnitIds: [],
    };
    const snapshot = JSON.stringify({
      schemaVersion: "InvestigationInputSnapshotV1",
      repositoryId: task.repository.id,
      workItemId: task.workItem.id,
      subjectRef: subject.id,
      subjectRevisionKey: subject.revisionKey,
      title: task.workItem.title,
      body: "Frozen PR description.",
      comments: [],
      source: null,
    });
    f.files.set(f.input.workspace.modelInputPath, Buffer.from(snapshot));
    const workspace: PreparedInvestigationWorkspace = {
      ...f.input.workspace,
      modelInputDigest: hash(snapshot),
      sourceDirectory: "C:\\Worker\\source",
      sourceBinding: {
        subjectRef: subject.id,
        revisionKey: subject.revisionKey,
        sourceSha: subject.headSha,
        patchDigest: null,
        artifactRef: null,
      },
      readPrDiffManifest: vi.fn(async () => manifest),
      readPrDiffChunk: vi.fn(async (id: string) => ({
        ...descriptors.find((chunk) => chunk.id === id)!,
        content: contents.get(id)!,
      })),
    };
    f.start.mockImplementation(async (spec) => {
      const contextText = (spec.standardInput ?? "")
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!;
      const context = (JSON.parse(contextText) as { turn: ModelTurnProjectionContext }).turn;
      const delta: InvestigationModelTurnDeltaV1 = {
        schemaVersion: "InvestigationModelTurnDeltaV1",
        taskId: context.task.id,
        attemptId: context.attempt.id,
        inputCheckpointRef: context.inputCheckpointRef,
        round: context.round,
        phase: context.phase,
        continue: true,
        continuationReason: "Complete the remaining full-diff summary.",
        analysis: {
          summary: null,
          assessment: null,
          coverageUnits: context.analysis.coverageUnits.map((unit) => ({
            ...unit,
            status: "completed",
          })),
          findings: [],
          candidates: [],
          rechecks: [],
          evidence: [],
          plans: [],
          nextActions: [],
          feedbackDrafts: [],
          diagnostics: [],
          limitations: [],
          removedFindingIds: [],
        },
      };
      f.files.set(
        win32.join(f.roundDirectory, "round-result.json"),
        Buffer.from(JSON.stringify(delta)),
      );
      return {
        requestId: f.exit.requestId,
        processId: 17,
        completed: Promise.resolve(f.exit),
        terminate: f.terminate,
        stdout: Readable.from(jsonl(codexComplete)),
        stderr: Readable.from([]),
      };
    });
    const result = await f.runner.execute({
      ...f.input,
      task,
      attempt: pr.attempt,
      checkpoint,
      workspace,
    });
    expect(result.sourceUnitIds).toEqual(descriptors.map((chunk) => chunk.id));
    expect(workspace.resolveSourcePath).not.toHaveBeenCalled();
    expect(f.start.mock.calls[0]![0].standardInput).toContain("export const removed = true;");
    expect(
      result.round.analysis.coverage.includedUnits.find((unit) => unit.id === "full-diff")?.status,
    ).toBe("pending");
  });

  it("uses the same owned ProcessHost transport for passive model edit JSON", async () => {
    const f = fixture();
    const proposal = {
      schemaVersion: "InvestigationModelEditsV1",
      summary: "No unrecorded edits were executed.",
      edits: [],
    };
    f.start.mockImplementation(async () => {
      f.files.set(
        win32.join(f.roundDirectory, "round-result.json"),
        Buffer.from(JSON.stringify(proposal)),
      );
      return {
        requestId: f.exit.requestId,
        processId: 17,
        completed: Promise.resolve(f.exit),
        terminate: f.terminate,
        stdout: Readable.from(jsonl(codexComplete)),
        stderr: Readable.from([]),
      };
    });
    const runner = createStaticModelJsonRunner(f.options);
    const result = await runner.execute({
      workspace: f.input.workspace,
      signal: f.input.signal,
      prompt: "Return only a passive model edit proposal.",
      schema: InvestigationModelEditsV1Schema,
      hardTimeoutMs: 30_000,
      maximumResultBytes: 8 * 1024 * 1024,
    });
    expect(result.value).toEqual(proposal);
    expect(result.usage).toEqual({ tokens: 50, source: "cli" });
    expect(f.io.writeExclusiveUtf8).toHaveBeenCalledWith(
      win32.join(f.roundDirectory, "round-schema.json"),
      JSON.stringify(createInvestigationModelOutputSchema(InvestigationModelEditsV1Schema)),
    );
    expect(f.start.mock.calls[0]![0].arguments).toContain("features.shell_tool=false");
    expect(f.io.removeDirectory).toHaveBeenCalledOnce();
  });

  it("continues a checkpoint larger than 2 MiB using a bounded delta without dropping its ledger", async () => {
    const f = fixture({ findingCount: 101, options: { maximumInputBytes: 64 * 1024 } });
    f.analysis.summary = "Preserved complete analysis. ".repeat(100_000);
    const checkpoint: InvestigationLoopCheckpointV1 = {
      schemaVersion: "InvestigationLoopCheckpointV1",
      id: "large-checkpoint",
      version: 3,
      digest: "a".repeat(64),
      taskId: f.input.task.id,
      attemptId: f.input.attempt.id,
      leaseVersion: 1,
      subjectRevisionKey: "b".repeat(64),
      profileRef: f.input.task.profileRef,
      promptRef: f.input.task.promptRef,
      previousCheckpointRef: null,
      round: 2,
      analysis: f.analysis,
      adoptedAttemptIds: [f.input.attempt.id],
      recordedAt: "2026-09-15T01:00:00.000Z",
      budget: f.input.task.budget,
      consumed: {
        rounds: 2,
        durationMs: 100,
        tokens: 100,
        reportBytes: Buffer.byteLength(JSON.stringify(f.analysis)),
      },
      stopReason: "continuing",
      taskBindingDigest: "c".repeat(64),
      lastPhase: "investigation",
      runtime: {
        completedStepIds: [],
        checks: [],
        evidence: [],
        artifacts: [],
        subjects: [],
        startedSteps: [],
        completedSteps: [],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeGreaterThan(2 * 1024 * 1024);
    const result = await f.runner.execute({ ...f.input, checkpoint });
    expect(result.round.analysis.findings).toEqual(f.analysis.findings);
    expect(result.round.analysis.summary).toBe(f.analysis.summary);
    expect(result.round.continue).toBe(true);
    const prompt = f.start.mock.calls[0]![0].standardInput ?? "";
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(512 * 1024);
    expect(prompt).not.toContain(f.analysis.summary);
    const contextText = prompt
      .split("<frozen_investigation_context>\n")[1]!
      .split("\n</frozen_investigation_context>")[0]!;
    const projected = (JSON.parse(contextText) as { turn: ModelTurnProjectionContext }).turn;
    expect(projected.phase).toBe("recheck");
    expect(projected.analysis.findings.length).toBeGreaterThan(0);
    expect(projected.analysis.findings.length).toBeLessThan(101);
  });

  it("fails closed before dispatch when static CLI configuration is unverified", async () => {
    const f = fixture({
      options: { staticConfiguration: { verified: false, disabledMcpServers: [] } },
    });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({
      code: "MODEL_POLICY_UNAVAILABLE",
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.io.createPrivateDirectory).not.toHaveBeenCalled();
  });

  it("never inherits the worker environment or passes credentials under another name", () => {
    const f = fixture();
    expect(() =>
      createModelTurnRunner({
        ...f.options,
        environment: { ...f.options.environment, WORKER_TOKEN: "private-bearer" },
      }),
    ).toThrow("unapproved variable");
    expect(() =>
      createModelTurnRunner({
        ...f.options,
        environment: { ...f.options.environment, LANG: "private-bearer" },
        protectedValues: ["private-bearer"],
      }),
    ).toThrow("protected worker value");
    expect(() =>
      createModelTurnRunner({
        ...f.options,
        environment: { ...f.options.environment, AUTHORIZATION: "Bearer private-bearer" },
      }),
    ).toThrow("unapproved variable");
  });

  it.each([
    ["not-json", "MODEL_OUTPUT_INVALID"],
    [JSON.stringify({ schemaVersion: "JobEnvelope", findings: [] }), "MODEL_OUTPUT_INVALID"],
  ])(
    "rejects invalid or legacy final output and cleans its owned control directory",
    async (outputText, code) => {
      const f = fixture({ outputText });
      await expect(f.runner.execute(f.input)).rejects.toMatchObject({ code });
      expect(f.io.removeDirectory).toHaveBeenCalledOnce();
    },
  );

  it("rejects a schema-valid response for another attempt", async () => {
    const f = fixture();
    f.round.attemptId = "different-attempt";
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({
      code: "MODEL_ROUND_BINDING_MISMATCH",
    });
  });

  it("rejects tampered frozen input without starting a model", async () => {
    const f = fixture();
    f.files.set(f.input.workspace.modelInputPath, Buffer.from('{"issue":"changed"}'));
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({ code: "MODEL_INPUT_INVALID" });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.io.createPrivateDirectory).not.toHaveBeenCalled();
  });

  it("rejects input over the transport budget without truncating the snapshot", async () => {
    const f = fixture({ options: { maximumInputBytes: 32 } });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({
      code: "MODEL_INPUT_LIMIT_EXCEEDED",
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("preserves the complete latest proposal when it crosses the task report soft budget", async () => {
    const f = fixture();
    const input = {
      ...f.input,
      task: { ...f.input.task, budget: { ...f.input.task.budget, maxReportBytes: 64 } },
    };
    const result = await f.runner.execute(input);
    expect(Buffer.byteLength(JSON.stringify(result.round.analysis))).toBeGreaterThan(64);
    expect(result.round.analysis.findings).toEqual(f.round.analysis.findings);
    expect(result.round.analysis.evidence).toEqual(f.round.analysis.evidence);
    expect(result.round.analysis.summary).toBe(f.round.analysis.summary);
    expect(f.io.removeDirectory).toHaveBeenCalledOnce();
  });

  it("does not follow a redirected result file outside the control directory", async () => {
    const f = fixture();
    vi.mocked(f.io.realpath).mockImplementation(async (path) =>
      path.endsWith("round-result.json") ? "C:\\Elsewhere\\round-result.json" : path,
    );
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({ code: "MODEL_PATH_UNSAFE" });
    expect(f.io.removeDirectory).toHaveBeenCalledWith(f.roundDirectory);
  });

  it("rejects a prohibited Codex tool event even when a valid result file exists", async () => {
    const f = fixture({
      stdout: jsonl(
        { type: "item.completed", item: { type: "command_execution", command: "npm test" } },
        codexComplete,
      ),
    });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({
      code: "MODEL_TOOL_POLICY_VIOLATION",
    });
  });

  it("rejects nonzero CLI exit even with schema-valid output", async () => {
    const f = fixture({ exit: { exitCode: 9 } });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({ code: "MODEL_PROCESS_FAILED" });
    expect(f.io.removeDirectory).toHaveBeenCalledOnce();
  });

  it("does not accept an earlier Codex response when a later turn is incomplete", async () => {
    const f = fixture({ stdout: jsonl(codexComplete, { type: "turn.started" }) });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("rejects protected values even when the CLI JSON uses Unicode escapes", async () => {
    const base = fixture();
    base.round.analysis.summary = "private-bearer";
    const outputText = JSON.stringify(roundDelta(base.round)).replace(
      "private-bearer",
      "\\u0070rivate-bearer",
    );
    const f = fixture({ outputText, options: { protectedValues: ["private-bearer"] } });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({
      code: "MODEL_OUTPUT_CONTAINS_CREDENTIAL",
    });
  });

  it("retains owned files when the exit event cannot be bound to the managed process", async () => {
    const f = fixture();
    f.start.mockImplementation(async () => ({
      requestId: f.exit.requestId,
      processId: 17,
      completed: Promise.resolve({ ...f.exit, requestId: "other-process" }),
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      terminate: f.terminate,
    }));
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({
      code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
    });
    expect(f.io.removeDirectory).not.toHaveBeenCalled();
    expect(f.directories.has(f.roundDirectory)).toBe(true);
  });

  it("retains owned files after a lost start acknowledgement with unknown child lifecycle", async () => {
    const f = fixture();
    f.start.mockRejectedValue(new Error("The native start acknowledgement was lost."));
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({
      code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
    });
    expect(f.io.removeDirectory).not.toHaveBeenCalled();
    expect(f.directories.has(f.roundDirectory)).toBe(true);
  });

  it("keeps only the final root Copilot response before its result marker", async () => {
    const base = fixture();
    const f = fixture({
      engine: "copilot",
      stdout: jsonl(
        copilotFinal(JSON.stringify(roundDelta(base.round))),
        {
          type: "assistant.message",
          agentId: "child-agent",
          data: { content: "This is not a root response." },
        },
        copilotFinal("The actual final root output is invalid JSON."),
        copilotComplete,
      ),
    });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("rejects duplicate Copilot completion markers", async () => {
    const base = fixture();
    const f = fixture({
      engine: "copilot",
      stdout: jsonl(
        copilotFinal(JSON.stringify(roundDelta(base.round))),
        copilotComplete,
        copilotComplete,
      ),
    });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });

  it("propagates cancellation only after managed exit, output draining, and owned cleanup", async () => {
    const f = fixture();
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    const completion = Promise.withResolvers<ProcessExitedEvent>();
    const started = Promise.withResolvers<void>();
    f.terminate.mockImplementation(async () => {
      expect(f.io.removeDirectory).not.toHaveBeenCalled();
      stdout.end();
      stderr.end();
      completion.resolve({ ...f.exit, exitCode: null, signal: "cancelled" });
    });
    f.start.mockImplementation(async () => {
      started.resolve();
      return {
        requestId: f.exit.requestId,
        processId: 17,
        stdout,
        stderr,
        completed: completion.promise,
        terminate: f.terminate,
      };
    });
    const execution = f.runner.execute(f.input);
    await started.promise;
    const reason = new Error("Fixture lease was cancelled.");
    f.controller.abort(reason);
    await expect(execution).rejects.toBe(reason);
    expect(f.terminate).toHaveBeenCalledWith("cancelled");
    expect(f.io.removeDirectory).toHaveBeenCalledOnce();
  });

  it("never dispatches an already aborted round", async () => {
    const f = fixture();
    f.controller.abort(new Error("Already cancelled."));
    await expect(f.runner.execute(f.input)).rejects.toThrow("Already cancelled");
    expect(f.start).not.toHaveBeenCalled();
    expect(f.io.createPrivateDirectory).not.toHaveBeenCalled();
  });

  it("summarizes actual checkpoint runtime without running a verification plan", async () => {
    const f = fixture();
    const checkpoint: InvestigationLoopCheckpointV1 = {
      schemaVersion: "InvestigationLoopCheckpointV1",
      id: "checkpoint-1",
      version: 1,
      digest: "a".repeat(64),
      taskId: f.input.task.id,
      attemptId: f.input.attempt.id,
      leaseVersion: 1,
      subjectRevisionKey: "b".repeat(64),
      profileRef: f.input.task.profileRef,
      promptRef: f.input.task.promptRef,
      previousCheckpointRef: null,
      round: 0,
      analysis: f.analysis,
      adoptedAttemptIds: [f.input.attempt.id],
      recordedAt: "2026-09-15T01:00:00.000Z",
      budget: f.input.task.budget,
      consumed: { rounds: 0, durationMs: 10, tokens: 0, reportBytes: 1 },
      stopReason: "continuing",
      taskBindingDigest: "c".repeat(64),
      lastPhase: null,
      runtime: {
        completedStepIds: [],
        checks: [],
        evidence: [
          {
            id: "trusted-step-1",
            subjectRef: f.input.task.subjectRef,
            source: "executor_observation",
            authority: "worker",
            summary: "The trusted saved-plan executor recorded the observed result.",
            artifactRefs: [],
            evidenceRefs: [],
            provenance: {
              taskId: f.input.task.id,
              attemptId: f.input.attempt.id,
              producer: "fixture-plan-executor",
              recordedAt: "2026-09-15T01:00:00.000Z",
            },
          },
        ],
        artifacts: [],
        subjects: [],
        startedSteps: [],
        completedSteps: [],
      },
    };
    f.round.inputCheckpointRef = {
      id: checkpoint.id,
      version: checkpoint.version,
      digest: checkpoint.digest,
    };
    const input = { ...f.input, checkpoint, task: { ...f.input.task, kind: "pr-verify" as const } };
    await f.runner.execute(input);
    expect(f.start.mock.calls[0]![0].standardInput).toContain("trusted-step-1");
    expect(f.start.mock.calls[0]![0].standardInput).toContain("A plan is not evidence");
    expect(f.input.workspace.resolveSourcePath).not.toHaveBeenCalled();
  });

  it("reads only concrete selected source paths through the workspace broker", async () => {
    const f = fixture();
    const sourceDirectory = "C:\\Worker\\investigations\\attempt-1\\source";
    const path = "src/example.ts",
      content = "export const unchanged = true;\n";
    f.files.set(win32.join(sourceDirectory, path), Buffer.from(content));
    const task = {
      ...f.input.task,
      executionPolicy: { ...f.input.task.executionPolicy, mode: "source_read" as const },
      scope: {
        ...f.input.task.scope,
        includedUnits: [
          {
            id: "unit-source",
            subjectRef: f.input.task.subjectRef,
            kind: "source",
            paths: [path],
            requiredWork: "Read the complete file.",
            status: "pending" as const,
            evidenceRefs: [],
          },
        ],
      },
    };
    const workspace = {
      ...f.input.workspace,
      sourceDirectory,
      sourceBinding: {
        subjectRef: task.subjectRef,
        revisionKey: "a".repeat(64),
        sourceSha: "b".repeat(40),
        patchDigest: null,
        artifactRef: null,
      },
    };
    await f.runner.execute({ ...f.input, task, workspace });
    expect(workspace.resolveSourcePath).toHaveBeenCalledExactlyOnceWith(path);
    expect(f.start.mock.calls[0]![0].standardInput).toContain(content.trim());
    expect(workspace.assertSourceBinding).toHaveBeenCalledTimes(2);
  });
});
