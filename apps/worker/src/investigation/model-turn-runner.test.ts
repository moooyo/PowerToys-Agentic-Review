import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationAnalysisV1,
  type InvestigationLoopCheckpointV1,
  type InvestigationLoopRoundV1,
  InvestigationModelEditsV1Schema,
  type InvestigationModelInvocationReceipt,
} from "@agentic-review/contracts";
import { createInvestigationCheckpoint, investigationContentDigest } from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import { ProcessHostRequestError } from "../execution/process-host-client.js";
import {
  type ManagedProcess,
  type ProcessExitedEvent,
  ProcessHostProtocolError,
  type ProcessLaunchSpec,
  processHostProtocolVersion,
} from "../execution/process-host-protocol.js";
import { createInvestigationModelOutputSchema } from "./model-output-schema.js";
import * as modelTurnProjection from "./model-turn-projection.js";
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
  makePrompt,
} from "./model-turn-runner.js";
import { InvestigationModelUsageJournal } from "./model-usage-journal.js";
import type {
  InvestigationPrDiffChunk,
  InvestigationPrDiffManifest,
  InvestigationSourceContext,
  InvestigationSourceDependencies,
  PreparedInvestigationWorkspace,
} from "./workspace.js";

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
    async (
      spec: ProcessLaunchSpec,
      _signal: AbortSignal,
      _onDispatch?: () => void,
    ): Promise<ManagedProcess> => {
      const contextText = (spec.standardInput ?? "")
        .split(/<(?:frozen_investigation_context|local_source_review_context)>\n/u)[1]!
        .split(/\n<\/(?:frozen_investigation_context|local_source_review_context)>/u)[0]!;
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

function prChunkFixture(
  settings: {
    chunks?: readonly (Pick<InvestigationPrDiffChunk, "id" | "kind" | "content"> & {
      path?: string;
    })[];
    status?: "deleted" | "modified";
    findingCount?: number;
    options?: Partial<ModelTurnRunnerOptions>;
  } = {},
) {
  const f = fixture({ options: settings.options ?? {} });
  const pr = createInvestigationFixture("pr", { findingCount: settings.findingCount ?? 0 });
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
  const chunks: NonNullable<typeof settings.chunks> = settings.chunks ?? [
    {
      id: "deleted-diff",
      kind: "diff" as const,
      content:
        "diff --git a/src/deleted.ts b/src/deleted.ts\n@@ -1 +0,0 @@\n-export const removed = true;\n",
    },
    { id: "deleted-base", kind: "base" as const, content: "export const removed = true;\n" },
  ];
  const contents = new Map(chunks.map((chunk) => [chunk.id, chunk.content]));
  const descriptors = chunks.map(({ id, kind, content, path }, ordinal) => ({
    id,
    path: path ?? "src/deleted.ts",
    kind,
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
    files: [...new Set(descriptors.map((chunk) => chunk.path))].sort().map((path) => ({
      path,
      previousPath: null,
      status: settings.status ?? ("deleted" as const),
      chunkIds: descriptors.filter((chunk) => chunk.path === path).map((chunk) => chunk.id),
    })),
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
  // This fixture exercises persisted legacy chunk-brokered checkpoints.
  delete checkpoint.runtime.reviewMode;
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
  const readChunk = (id: string): InvestigationPrDiffChunk => ({
    ...descriptors.find((chunk) => chunk.id === id)!,
    content: contents.get(id)!,
  });
  const readPrDiffChunks = vi.fn(async (ids: readonly string[]) => ids.map(readChunk));
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
      inertSymlinks: [
        { path: ".claude/CLAUDE.md", revisionSha: subject.headSha },
        { path: ".claude/agents", revisionSha: subject.baseSha },
      ],
    },
    readPrDiffManifest: vi.fn(async () => manifest),
    readPrDiffChunk: vi.fn(async (id: string) => readChunk(id)),
    readPrDiffChunks,
  };
  f.start.mockImplementation(async (spec) => {
    const contextText = (spec.standardInput ?? "")
      .split(/<(?:frozen_investigation_context|local_source_review_context)>\n/u)[1]!
      .split(/\n<\/(?:frozen_investigation_context|local_source_review_context)>/u)[0]!;
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
  return {
    f,
    pr,
    task,
    checkpoint,
    manifest,
    descriptors,
    contents,
    readChunk,
    readPrDiffChunks,
    workspace,
    input: { ...f.input, task, attempt: pr.attempt, checkpoint, workspace },
  };
}

function attachSourceDependencies(
  p: ReturnType<typeof prChunkFixture>,
  files = [
    {
      path: "src/caller.test.ts",
      content: "import { removed } from './deleted';\nexport const delegated = removed;\n",
    },
  ],
) {
  const readSourceDependencies = vi.fn(
    async (seedPaths: readonly string[]): Promise<InvestigationSourceDependencies> => ({
      sourceSha: p.workspace.sourceBinding!.sourceSha,
      seedPaths: [...seedPaths],
      symbols: ["removed"],
      searchDepth: 1,
      queries: [
        {
          revisionSha: p.workspace.sourceBinding!.sourceSha,
          symbols: ["removed"],
          paths: files.map((file) => file.path).sort(),
          depth: 1,
        },
      ],
      files: files.map((file) => ({ ...file, digest: hash(file.content) })),
    }),
  );
  p.workspace.readSourceDependencies = readSourceDependencies;
  return readSourceDependencies;
}

function selectFullDiff(p: ReturnType<typeof prChunkFixture>): void {
  const coverage = p.checkpoint.analysis.coverage;
  for (const unit of coverage.includedUnits)
    unit.status = unit.kind === "pr_diff_chunk" ? "completed" : "blocked";
  coverage.completedUnitRefs = p.descriptors.map((chunk) => chunk.id);
  coverage.unresolvedUnitRefs = ["full-diff"];
  p.checkpoint.runtime.sourceCoverage!.brokeredUnitIds = [...coverage.completedUnitRefs];
  p.checkpoint.round = 1;
}

describe("investigation model turn runner", () => {
  it("lets a fresh snapshot-only issue finish in its first static invocation", async () => {
    const f = fixture({ findingCount: 0 });
    f.round.continue = false;
    const result = await f.runner.execute(f.input);
    expect(result.round.phase).toBe("discovery");
    expect(result.round.continue).toBe(false);
    expect(f.start).toHaveBeenCalledOnce();
    const prompt = f.start.mock.calls[0]![0].standardInput!;
    expect(prompt).toContain("no separate finalize invocation is required");
    expect(prompt).toContain("Do not guess a repository branch or source revision");
    expect(prompt).toContain("Only analyze the supplied snapshots and complete source files");
    expect(prompt).not.toContain("A non-finalize batch cannot finish");
    expect(f.input.workspace.assertSourceBinding).not.toHaveBeenCalled();
    expect(f.input.workspace.readSourceFile).not.toHaveBeenCalled();
  });

  it("keeps the historical snapshot prompt when an existing checkpoint has no review mode", async () => {
    const f = fixture({ findingCount: 0 });
    const checkpoint = createInvestigationCheckpoint({
      task: f.input.task,
      attemptId: f.input.attempt.id,
      checkpointId: "historical-snapshot",
      leaseVersion: f.input.attempt.leaseVersion,
      recordedAt: f.input.task.updatedAt,
    });
    delete checkpoint.runtime.reviewMode;
    const prepared = await makePrompt({ ...f.input, checkpoint }, f.io, 128 * 1024, 1024 * 1024);
    expect(prepared.projection.autonomousReview).toBe(false);
    expect(prepared.prompt).toContain("A non-finalize batch cannot finish");
    expect(prepared.prompt).not.toContain("no separate finalize invocation is required");
  });

  it("uses the pinned local checkout and a diff entry point without preselecting dependency paths", async () => {
    const p = prChunkFixture();
    p.checkpoint.runtime.reviewMode = "local_checkout";
    p.checkpoint.analysis.coverage.includedUnits =
      p.checkpoint.analysis.coverage.includedUnits.filter((unit) => unit.kind !== "pr_diff_chunk");
    p.checkpoint.analysis.coverage.unresolvedUnitRefs = ["full-diff"];
    const discover = vi.fn();
    const workspace = {
      ...p.workspace,
      readSourceDependencies: discover,
      readSourceContext: discover,
    };
    const prepared = await makePrompt({ ...p.input, workspace }, p.f.io, 128 * 1024, 1024 * 1024);
    const context = JSON.parse(
      prepared.prompt
        .split("<local_source_review_context>\n")[1]!
        .split("\n</local_source_review_context>")[0]!,
    );
    expect(context.workspace.directory).toBe(p.workspace.sourceDirectory);
    expect(context.workspace.headSha).toBe(p.manifest.headSha);
    expect(context.workspace.mergeBaseSha).toBe(p.manifest.mergeBaseSha);
    expect(context.initialDiff.chunks.map((chunk: { kind: string }) => chunk.kind)).toEqual([
      "diff",
    ]);
    expect(context.initialDiff.complete).toBe(true);
    expect(prepared.sourceUnitIds).toEqual([]);
    expect(prepared.prompt).toContain("search the checkout before declaring source unavailable");
    expect(prepared.prompt).toContain("No separate finalization invocation is required");
    expect(prepared.prompt).toContain("Do not restore dependencies, build, run tests");
    expect(discover).not.toHaveBeenCalled();
    await p.f.runner.execute({ ...p.input, workspace });
    const spec = p.f.start.mock.calls[0]![0];
    expect(spec.arguments[spec.arguments.indexOf("--cd") + 1]).toBe(p.workspace.sourceDirectory);
    expect(spec.environment.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(spec.arguments).not.toContain("features.shell_tool=false");
    expect(p.workspace.assertSourceBinding).toHaveBeenCalled();
  });

  it("leaves oversized initial diff content for exact local Git inspection instead of blocking the review", async () => {
    const p = prChunkFixture({
      chunks: [
        { id: "large-diff", kind: "diff", content: "large diff context\n".repeat(2500) },
        { id: "large-base", kind: "base", content: "export const removed = true;\n" },
      ],
    });
    p.checkpoint.runtime.reviewMode = "local_checkout";
    p.checkpoint.analysis.coverage.includedUnits =
      p.checkpoint.analysis.coverage.includedUnits.filter((unit) => unit.kind !== "pr_diff_chunk");
    p.checkpoint.analysis.coverage.unresolvedUnitRefs = ["full-diff"];
    const result = await makePrompt(p.input, p.f.io, 32 * 1024, 1024 * 1024);
    const context = JSON.parse(
      result.prompt
        .split("<local_source_review_context>\n")[1]!
        .split("\n</local_source_review_context>")[0]!,
    );
    expect(context.initialDiff.complete).toBe(false);
    expect(context.initialDiff.omittedChunkIds).toEqual(["large-diff"]);
    expect(context.initialDiff.chunks).toEqual([]);
    expect(context.workspace.files[0].path).toBe("src/deleted.ts");
    expect(Buffer.byteLength(result.prompt)).toBeLessThanOrEqual(32 * 1024);
  });

  it("retains complete owned progress comments and their provenance in the model input", async () => {
    const f = fixture();
    const original = JSON.parse(f.files.get(f.input.workspace.modelInputPath)!.toString("utf8"));
    const comments = [
      {
        id: "reporter-comment",
        body: "Keep this complete human report, including its original wording.",
      },
      {
        id: "owned-progress-comment",
        body: "I'm an AI assistant. Preparing the investigation.\n<!-- agentic-review-progress:fixture -->",
        provenance: { kind: "agentic_review_progress", publicationId: "publication-fixture" },
      },
    ];
    const encoded = JSON.stringify({ ...original, comments });
    f.files.set(f.input.workspace.modelInputPath, Buffer.from(encoded));
    await f.runner.execute({
      ...f.input,
      workspace: { ...f.input.workspace, modelInputDigest: hash(encoded) },
    });
    const prompt = f.start.mock.calls[0]![0].standardInput!;
    const context = JSON.parse(
      prompt
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!,
    );
    expect(context.snapshot.comments).toEqual(comments);
    expect(prompt).toContain("not new human requests or independent evidence");
  });

  function focusedSourceFixture(
    optionalContent = "class Delegate {}\n",
    requiredContent = "class Core { Delegate owner; }\n",
    findingCount = 0,
    prStatus: "deleted" | "modified" = "deleted",
  ) {
    const p = prChunkFixture({
      findingCount,
      status: prStatus,
      ...(prStatus === "modified"
        ? {
            chunks: [
              {
                id: "modified-diff",
                kind: "diff",
                content: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
              },
              { id: "modified-base", kind: "base", content: "export const value = 1;\n" },
              { id: "modified-head", kind: "head", content: "export const value = 2;\n" },
            ] as const,
          }
        : {}),
      options: { maximumInputBytes: 128 * 1024 },
    });
    selectFullDiff(p);
    const coverage = p.checkpoint.analysis.coverage;
    coverage.includedUnits.push({
      id: "source-core",
      subjectRef: p.task.subjectRef,
      kind: "source_file",
      paths: ["src/Core.cs"],
      requiredWork: "Read the complete Core source and assess its referenced types.",
      status: "pending",
      evidenceRefs: [],
    });
    coverage.unresolvedUnitRefs.push("source-core");
    const sourceContext: InvestigationSourceContext = {
      sourceSha: p.workspace.sourceBinding!.sourceSha,
      seedPaths: ["src/Core.cs"],
      requiredFiles: [
        { path: "src/Core.cs", content: requiredContent, digest: hash(requiredContent) },
      ],
      contextFiles: [
        {
          path: "src/Delegate.cs",
          content: optionalContent,
          digest: hash(optionalContent),
          role: "definition_candidate",
          relation: "unresolved_reference_identity",
          lexicalDeclaration: { name: "Delegate", namespace: "" },
        },
      ],
      queries: [
        {
          kind: "definition",
          revisionSha: p.workspace.sourceBinding!.sourceSha,
          symbols: ["Delegate"],
          paths: ["src/Delegate.cs"],
          matchedPathCount: 1,
          omittedPathCount: 0,
        },
      ],
      deferred: [],
      identityScanFiles: 2,
      identityScanBytes: Buffer.byteLength(requiredContent) + Buffer.byteLength(optionalContent),
      catalogComplete: true,
      omittedCandidateCount: 0,
    };
    const readSourceContext = vi.fn(async (): Promise<InvestigationSourceContext> => sourceContext);
    p.workspace.readSourceContext = readSourceContext;
    const readSourceDependencies = attachSourceDependencies(p);
    return { ...p, sourceContext, readSourceContext, readSourceDependencies };
  }

  function jointBlockedSourceFixture(optionalContent?: string, requiredFileBytes = 64) {
    const p = focusedSourceFixture(optionalContent);
    const coverage = p.checkpoint.analysis.coverage;
    const core = coverage.includedUnits.find((unit) => unit.id === "source-core")!;
    core.status = "blocked";
    const units = [
      core,
      {
        ...core,
        id: "source-window",
        paths: ["src/MainWindow.cs", "src/DisplayState.cs"],
        requiredWork: "Read the complete window caller and its display event subscription.",
      },
      {
        ...core,
        id: "source-display",
        paths: [
          "src/MainWindow.cs",
          "src/DisplayStateTests.cs",
          "src/MainWindow.xaml",
          "src/DisplayCoordinator.cs",
          "src/DisplayCoordinatorTests.cs",
        ],
        requiredWork: "Assess the complete display source, callers, state, and related tests.",
      },
    ];
    coverage.includedUnits.push(...units.slice(1));
    coverage.unresolvedUnitRefs.push(...units.slice(1).map((unit) => unit.id));
    const paths = [...new Set(units.flatMap((unit) => unit.paths))].sort();
    const requiredFiles = paths.map((path) => {
      const content = `// Complete required source: ${path}\n`.padEnd(requiredFileBytes, "r");
      return { path, content, digest: hash(content) };
    });
    const sourceContext: InvestigationSourceContext = {
      ...p.sourceContext,
      seedPaths: paths,
      requiredFiles,
      identityScanFiles: requiredFiles.length + p.sourceContext.contextFiles.length,
      identityScanBytes: [...requiredFiles, ...p.sourceContext.contextFiles].reduce(
        (total, file) => total + Buffer.byteLength(file.content),
        0,
      ),
    };
    p.readSourceContext.mockResolvedValue(sourceContext);
    return { ...p, sourceContext, units, paths };
  }

  function completedSourceContextFixture(
    settings: {
      status?: "pending" | "blocked";
      optionalContent?: string;
      requiredFileBytes?: number;
      selectedPaths?: string[];
      completedPaths?: string[];
      jointBlocked?: boolean;
    } = {},
  ) {
    const p = focusedSourceFixture(settings.optionalContent, undefined, 0, "modified");
    const coverage = p.checkpoint.analysis.coverage;
    const core = coverage.includedUnits.find((unit) => unit.id === "source-core")!;
    core.status = settings.status ?? "pending";
    core.paths = settings.selectedPaths ?? core.paths;
    const selectedUnits = [core];
    if (settings.jointBlocked) {
      const caller = {
        ...core,
        id: "source-core-caller",
        paths: ["src/Caller.cs"],
        requiredWork: "Read the complete caller together with Core and prior lifecycle source.",
      };
      selectedUnits.push(caller);
      coverage.includedUnits.push(caller);
      coverage.unresolvedUnitRefs.push(caller.id);
    }
    const completedUnits = [
      {
        ...core,
        id: "source-lifecycle",
        paths: settings.completedPaths ?? ["src/Core.cs", "src/Lifecycle.cs"],
        requiredWork: "Read the complete lifecycle owner and its Core usage.",
        status: "completed" as const,
      },
      {
        ...core,
        id: "source-startup",
        paths: ["src/Startup.cs"],
        requiredWork: "Read the complete application startup source.",
        status: "completed" as const,
      },
    ];
    coverage.includedUnits.push(...completedUnits);
    coverage.completedUnitRefs.push(...completedUnits.map((unit) => unit.id));
    const paths = [
      ...new Set([...selectedUnits, ...completedUnits].flatMap((unit) => unit.paths)),
    ].sort();
    const requiredFiles = paths.map((path) => {
      const head = p.descriptors.find((chunk) => chunk.path === path && chunk.kind === "head");
      const content =
        head === undefined
          ? `// Complete required source: ${path}\n`.padEnd(settings.requiredFileBytes ?? 64, "r")
          : p.contents.get(head.id)!;
      return { path, content, digest: hash(content) };
    });
    const sourceContext: InvestigationSourceContext = {
      ...p.sourceContext,
      seedPaths: paths,
      requiredFiles,
      identityScanFiles: requiredFiles.length + p.sourceContext.contextFiles.length,
      identityScanBytes: [...requiredFiles, ...p.sourceContext.contextFiles].reduce(
        (total, file) => total + Buffer.byteLength(file.content),
        0,
      ),
    };
    p.readSourceContext.mockResolvedValue(sourceContext);
    return { ...p, sourceContext, selectedUnits, completedUnits, paths };
  }

  it.each(
    (["pending", "blocked"] as const).flatMap((status) =>
      (["supplied", "prompt_input_budget"] as const).map((mode) => ({ status, mode })),
    ),
  )(
    "redelivers complete read-only lifecycle source with the $status focused batch when optional context is $mode",
    async ({ status, mode }) => {
      const p = completedSourceContextFixture({
        status,
        jointBlocked: status === "blocked",
        ...(mode === "prompt_input_budget" ? { optionalContent: "x".repeat(128 * 1024) } : {}),
      });
      const originalCheckpoint = structuredClone(p.checkpoint);
      const result = await makePrompt(p.input, p.f.io, 128 * 1024, 128 * 1024);
      const context = JSON.parse(
        result.prompt
          .split("<frozen_investigation_context>\n")[1]!
          .split("\n</frozen_investigation_context>")[0]!,
      ) as {
        turn: ModelTurnProjectionContext;
        sourceFiles: Array<{ path: string; content: string; sha256: string }>;
        sourceChunks: unknown[];
        sourceDiscovery: {
          requiredFiles: Array<{ path: string; digest: string }>;
          contextFiles: unknown[];
          deferred: Array<{ path: string; reason: string }>;
        };
        sourceProjection: { allRequiredFilesIncluded: boolean };
      };
      expect(p.readSourceContext).toHaveBeenCalledExactlyOnceWith(p.paths);
      expect(p.readSourceDependencies).not.toHaveBeenCalled();
      expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
      expect(p.readPrDiffChunks).not.toHaveBeenCalled();
      expect(context.turn.analysis.coverageUnits).toEqual(p.selectedUnits);
      expect(context.turn.sourceCoverage?.units).toEqual(
        p.completedUnits.map(({ requiredWork: _requiredWork, ...unit }) => unit),
      );
      expect(result.projection.selectedUnitIds).toEqual(p.selectedUnits.map((unit) => unit.id));
      expect(context.sourceDiscovery.requiredFiles).toEqual(
        p.sourceContext.requiredFiles.map(({ path, digest }) => ({ path, digest })),
      );
      for (const file of p.sourceContext.requiredFiles)
        expect(context.sourceFiles).toContainEqual({
          path: file.path,
          content: file.content,
          sha256: file.digest,
        });
      expect(context.sourceFiles.filter((file) => file.path === "src/Core.cs")).toHaveLength(1);
      expect(context.sourceFiles).toHaveLength(p.paths.length + (mode === "supplied" ? 1 : 0));
      expect(context.sourceChunks).toEqual([]);
      expect(context.sourceProjection.allRequiredFilesIncluded).toBe(true);
      expect(context.sourceDiscovery.contextFiles).toHaveLength(mode === "supplied" ? 1 : 0);
      expect(context.sourceDiscovery.deferred).toEqual(
        mode === "supplied" ? [] : [{ path: "src/Delegate.cs", reason: "prompt_input_budget" }],
      );
      expect(p.checkpoint).toEqual(originalCheckpoint);
      expect(p.sourceContext.contextFiles).toHaveLength(1);
      expect(p.sourceContext.deferred).toEqual([]);
      expect(result.sourceUnitIds).toEqual([]);
      expect(Buffer.byteLength(result.prompt)).toBeLessThanOrEqual(128 * 1024);
    },
  );

  it.each(["prompt_budget", "file_count", "byte_count", "missing_completed_file"] as const)(
    "rejects a required selected and read-only completed union with %s before model dispatch",
    async (mode) => {
      const p = completedSourceContextFixture({
        ...(mode === "file_count"
          ? {
              completedPaths: Array.from(
                { length: 63 },
                (_, index) => `src/Lifecycle${index.toString().padStart(2, "0")}.cs`,
              ),
            }
          : {}),
        requiredFileBytes:
          mode === "prompt_budget" ? 50 * 1024 : mode === "byte_count" ? 90 * 1024 : 64,
      });
      const originalCheckpoint = structuredClone(p.checkpoint);
      const requiredBytes = new Map(
        p.sourceContext.requiredFiles.map((file) => [file.path, Buffer.byteLength(file.content)]),
      );
      if (mode === "prompt_budget" || mode === "byte_count") {
        const maximum = (mode === "prompt_budget" ? 128 : 256) * 1024;
        expect(
          [...requiredBytes.values()].reduce((total, bytes) => total + bytes, 0),
        ).toBeGreaterThan(maximum);
        for (const unit of [...p.selectedUnits, ...p.completedUnits])
          expect(
            unit.paths.reduce((total, path) => total + requiredBytes.get(path)!, 0),
          ).toBeLessThan(maximum);
      }
      if (mode === "missing_completed_file")
        p.readSourceContext.mockResolvedValue({
          ...p.sourceContext,
          requiredFiles: p.sourceContext.requiredFiles.filter(
            (file) => file.path !== "src/Startup.cs",
          ),
        });
      if (mode === "file_count") {
        expect(p.paths).toHaveLength(65);
        for (const unit of [...p.selectedUnits, ...p.completedUnits])
          expect(unit.paths.length).toBeLessThanOrEqual(64);
        p.readSourceContext.mockResolvedValue({
          ...p.sourceContext,
          contextFiles: [],
          queries: [],
          identityScanFiles: p.paths.length,
          identityScanBytes: p.sourceContext.requiredFiles.reduce(
            (total, file) => total + Buffer.byteLength(file.content),
            0,
          ),
        });
      }
      const runner =
        mode === "prompt_budget"
          ? p.f.runner
          : createModelTurnRunner({ ...p.f.options, maximumInputBytes: 512 * 1024 });
      await expect(runner.execute(p.input)).rejects.toMatchObject({
        code: mode === "prompt_budget" ? "MODEL_INPUT_LIMIT_EXCEEDED" : "MODEL_SOURCE_UNAVAILABLE",
      });
      expect(p.readSourceContext).toHaveBeenCalledExactlyOnceWith(p.paths);
      expect(p.readSourceDependencies).not.toHaveBeenCalled();
      expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
      expect(p.f.start).not.toHaveBeenCalled();
      expect(p.checkpoint).toEqual(originalCheckpoint);
    },
  );

  it.each(["selected", "read_only_completed"] as const)(
    "preserves PR chunk selection when the matching focused source path is %s",
    async (pathRole) => {
      const path = "src/deleted.ts";
      const p = completedSourceContextFixture(
        pathRole === "selected" ? { selectedPaths: [path] } : { completedPaths: [path] },
      );
      const result = await makePrompt(p.input, p.f.io, 128 * 1024, 128 * 1024);
      const context = JSON.parse(
        result.prompt
          .split("<frozen_investigation_context>\n")[1]!
          .split("\n</frozen_investigation_context>")[0]!,
      ) as {
        sourceFiles: Array<{ path: string; content: string; sha256: string }>;
        sourceChunks: InvestigationPrDiffChunk[];
      };
      const required = p.sourceContext.requiredFiles.find((file) => file.path === path)!;
      expect(p.readSourceContext).toHaveBeenCalledExactlyOnceWith(p.paths);
      expect(p.readSourceDependencies).not.toHaveBeenCalled();
      expect(context.sourceFiles).toContainEqual({
        path,
        content: required.content,
        sha256: required.digest,
      });
      if (pathRole === "selected") {
        expect(p.readPrDiffChunks).toHaveBeenCalledExactlyOnceWith(
          p.descriptors.map((chunk) => chunk.id),
        );
        expect(context.sourceChunks).toEqual(p.descriptors.map((chunk) => p.readChunk(chunk.id)));
        expect(result.sourceUnitIds).toEqual(p.descriptors.map((chunk) => chunk.id));
      } else {
        expect(p.readPrDiffChunks).not.toHaveBeenCalled();
        expect(context.sourceChunks).toEqual([]);
        expect(result.sourceUnitIds).toEqual([]);
      }
    },
  );

  it.each(["supplied", "prompt_input_budget"] as const)(
    "delivers all three blocked source units and seven unique required files with optional context %s",
    async (mode) => {
      const p = jointBlockedSourceFixture(
        mode === "prompt_input_budget" ? "x".repeat(128 * 1024) : undefined,
      );
      const originalUnits = structuredClone(p.units);
      const originalCheckpoint = structuredClone(p.checkpoint);
      const start = p.f.start.getMockImplementation()!;
      p.f.start.mockImplementation(async (...args) => {
        const process = await start(...args);
        const resultPath = win32.join(p.f.roundDirectory, "round-result.json");
        const delta = JSON.parse(
          p.f.files.get(resultPath)!.toString("utf8"),
        ) as InvestigationModelTurnDeltaV1;
        delta.analysis.coverageUnits = [];
        p.f.files.set(resultPath, Buffer.from(JSON.stringify(delta)));
        return process;
      });
      const result = await p.f.runner.execute(p.input);
      const prompt = p.f.start.mock.calls[0]![0].standardInput!;
      const context = JSON.parse(
        prompt
          .split("<frozen_investigation_context>\n")[1]!
          .split("\n</frozen_investigation_context>")[0]!,
      ) as {
        turn: ModelTurnProjectionContext;
        sourceFiles: Array<{ path: string; content: string; sha256: string }>;
        sourceDiscovery: {
          requiredFiles: Array<{ path: string; digest: string }>;
          contextFiles: unknown[];
          deferred: Array<{ path: string; reason: string }>;
        };
        sourceProjection: { allRequiredFilesIncluded: boolean };
      };
      expect(p.paths).toHaveLength(7);
      expect(p.readSourceContext).toHaveBeenCalledExactlyOnceWith(p.paths);
      expect(p.readSourceDependencies).not.toHaveBeenCalled();
      expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
      expect(context.turn.analysis.coverageUnits).toEqual(originalUnits);
      expect(context.sourceDiscovery.requiredFiles).toEqual(
        p.sourceContext.requiredFiles.map(({ path, digest }) => ({ path, digest })),
      );
      for (const file of p.sourceContext.requiredFiles)
        expect(context.sourceFiles).toContainEqual({
          path: file.path,
          content: file.content,
          sha256: file.digest,
        });
      expect(context.sourceProjection.allRequiredFilesIncluded).toBe(true);
      expect(context.sourceFiles).toHaveLength(mode === "supplied" ? 8 : 7);
      expect(context.sourceDiscovery.contextFiles).toHaveLength(mode === "supplied" ? 1 : 0);
      expect(context.sourceDiscovery.deferred).toEqual(
        mode === "supplied" ? [] : [{ path: "src/Delegate.cs", reason: "prompt_input_budget" }],
      );
      expect(result.round.analysis.coverage.includedUnits).toEqual(
        originalCheckpoint.analysis.coverage.includedUnits,
      );
      expect(p.checkpoint).toEqual(originalCheckpoint);
      expect(p.sourceContext.contextFiles).toHaveLength(1);
      expect(p.sourceContext.deferred).toEqual([]);
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(128 * 1024);
      expect(result.sourceUnitIds).toEqual([]);
    },
  );

  it.each(["required_union_budget", "missing_required_file"] as const)(
    "rejects a joint blocked source batch with %s without selecting a smaller subset or starting a model",
    async (mode) => {
      const p = jointBlockedSourceFixture(undefined, 20 * 1024);
      const originalCheckpoint = structuredClone(p.checkpoint);
      const requiredBytes = new Map(
        p.sourceContext.requiredFiles.map((file) => [file.path, Buffer.byteLength(file.content)]),
      );
      expect(
        [...requiredBytes.values()].reduce((total, bytes) => total + bytes, 0),
      ).toBeGreaterThan(128 * 1024);
      for (const unit of p.units)
        expect(
          unit.paths.reduce((total, path) => total + requiredBytes.get(path)!, 0),
        ).toBeLessThan(128 * 1024);
      if (mode === "missing_required_file")
        p.readSourceContext.mockResolvedValue({
          ...p.sourceContext,
          requiredFiles: p.sourceContext.requiredFiles.slice(0, -1),
        });
      await expect(p.f.runner.execute(p.input)).rejects.toMatchObject({
        code:
          mode === "required_union_budget"
            ? "MODEL_INPUT_LIMIT_EXCEEDED"
            : "MODEL_SOURCE_UNAVAILABLE",
      });
      expect(p.readSourceContext).toHaveBeenCalledExactlyOnceWith(p.paths);
      expect(p.readSourceDependencies).not.toHaveBeenCalled();
      expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
      expect(p.f.start).not.toHaveBeenCalled();
      expect(p.checkpoint).toEqual(originalCheckpoint);
    },
  );

  it.each(["source_dependency", "full_diff"] as const)(
    "does not classify blocked source_file plus %s as a joint focused source batch",
    async (kind) => {
      const p = focusedSourceFixture();
      const coverage = p.checkpoint.analysis.coverage;
      const core = coverage.includedUnits.find((unit) => unit.id === "source-core")!;
      core.status = "blocked";
      const other = coverage.includedUnits.find((unit) => unit.id === "full-diff")!;
      other.kind = kind;
      const projection = modelTurnProjection.prepareModelTurnProjection({
        task: p.input.task,
        attempt: p.input.attempt,
        checkpoint: p.checkpoint,
        maximumContextBytes: 128 * 1024,
      });
      const selectedUnits = [other, core];
      const prepare = vi.spyOn(modelTurnProjection, "prepareModelTurnProjection").mockReturnValue({
        ...projection,
        selectedUnitIds: selectedUnits.map((unit) => unit.id),
        context: {
          ...projection.context,
          analysis: { ...projection.context.analysis, coverageUnits: selectedUnits },
        },
      });
      for (const file of p.sourceContext.requiredFiles)
        p.f.files.set(
          win32.join(p.workspace.attemptDirectory, "source", file.path),
          Buffer.from(file.content),
        );
      try {
        const result = await makePrompt(p.input, p.f.io, 128 * 1024, 128 * 1024);
        expect(result.projection.selectedUnitIds).toEqual(selectedUnits.map((unit) => unit.id));
        expect(p.readSourceContext).not.toHaveBeenCalled();
        expect(p.workspace.resolveSourcePath).toHaveBeenCalledExactlyOnceWith("src/Core.cs");
        if (kind === "full_diff")
          expect(p.readSourceDependencies).toHaveBeenCalledExactlyOnceWith([
            "src/Core.cs",
            "src/deleted.ts",
          ]);
        else expect(p.readSourceDependencies).not.toHaveBeenCalled();
        expect(p.f.start).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
    },
  );

  it.each(
    (["pending", "blocked"] as const).flatMap((status) =>
      (["supplied", "deferred", "prompt_input_budget"] as const).map((mode) => ({ status, mode })),
    ),
  )(
    "delivers complete $status focused required source when optional context is $mode without completing coverage",
    async ({ status, mode }) => {
      const p = focusedSourceFixture(
        mode === "prompt_input_budget" ? "x".repeat(128 * 1024) : undefined,
      );
      const sourceUnit = p.checkpoint.analysis.coverage.includedUnits.find(
        (unit) => unit.id === "source-core",
      )!;
      sourceUnit.status = status;
      const originalSourceUnit = structuredClone(sourceUnit);
      const start = p.f.start.getMockImplementation()!;
      p.f.start.mockImplementation(async (...args) => {
        const process = await start(...args);
        const resultPath = win32.join(p.f.roundDirectory, "round-result.json");
        const delta = JSON.parse(
          p.f.files.get(resultPath)!.toString("utf8"),
        ) as InvestigationModelTurnDeltaV1;
        delta.analysis.coverageUnits = [];
        p.f.files.set(resultPath, Buffer.from(JSON.stringify(delta)));
        return process;
      });
      if (mode === "deferred")
        p.readSourceContext.mockResolvedValue({
          ...p.sourceContext,
          contextFiles: [],
          deferred: [{ path: "src/Delegate.cs", reason: "optional_context_budget" }],
          queryBudgetExhausted: true,
        });
      const result = await p.f.runner.execute(p.input);
      const prompt = p.f.start.mock.calls[0]![0].standardInput!;
      const context = JSON.parse(
        prompt
          .split("<frozen_investigation_context>\n")[1]!
          .split("\n</frozen_investigation_context>")[0]!,
      ) as {
        turn: ModelTurnProjectionContext;
        sourceFiles: Array<{ path: string; content: string; sha256: string }>;
        sourceDiscovery: {
          contextFiles: unknown[];
          deferred: Array<{ path: string; reason: string }>;
          catalogComplete: boolean;
          omittedCandidateCount: number;
          queryBudgetExhausted?: true;
        };
        sourceProjection: {
          allRequiredFilesIncluded: boolean;
          allDependencyFilesIncluded: boolean;
        };
      };
      expect(p.readSourceContext).toHaveBeenCalledExactlyOnceWith(["src/Core.cs"]);
      expect(p.readSourceDependencies).not.toHaveBeenCalled();
      expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
      expect(context.turn.analysis.coverageUnits.map((unit) => unit.id)).toEqual(["source-core"]);
      expect(context.turn.analysis.coverageUnits[0]).toEqual(originalSourceUnit);
      expect(
        result.round.analysis.coverage.includedUnits.find((unit) => unit.id === "source-core"),
      ).toEqual(originalSourceUnit);
      expect(context.sourceFiles).toContainEqual({
        path: "src/Core.cs",
        content: p.sourceContext.requiredFiles[0]!.content,
        sha256: p.sourceContext.requiredFiles[0]!.digest,
      });
      expect(context.sourceProjection.allRequiredFilesIncluded).toBe(true);
      if (mode === "deferred") expect(context.sourceDiscovery.queryBudgetExhausted).toBe(true);
      else expect(context.sourceDiscovery).not.toHaveProperty("queryBudgetExhausted");
      expect(
        result.round.analysis.coverage.includedUnits.find((unit) => unit.id === "full-diff"),
      ).toMatchObject({
        status: "blocked",
        requiredWork: "Review the complete frozen PR diff.",
      });
      if (mode === "supplied") {
        expect(context.sourceFiles).toHaveLength(2);
        expect(context.sourceDiscovery.contextFiles).toHaveLength(1);
      } else {
        expect(context.sourceFiles).toHaveLength(1);
        expect(context.sourceDiscovery.contextFiles).toEqual([]);
        expect(context.sourceDiscovery.catalogComplete).toBe(true);
        expect(context.sourceDiscovery.omittedCandidateCount).toBe(0);
        expect(context.sourceProjection.allDependencyFilesIncluded).toBe(false);
        expect(context.sourceDiscovery.deferred).toContainEqual({
          path: "src/Delegate.cs",
          reason: mode === "deferred" ? "optional_context_budget" : "prompt_input_budget",
        });
      }
      expect(p.sourceContext.contextFiles).toHaveLength(1);
      expect(p.sourceContext.deferred).toEqual([]);
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(128 * 1024);
      expect(result.sourceUnitIds).toEqual([]);
    },
  );

  it.each([false, true])(
    "redelivers completed focused source to full-diff separately and never trims protected dependency content (selected Core finding: %s)",
    async (withFinding) => {
      const p = focusedSourceFixture(undefined, undefined, withFinding ? 1 : 0);
      const first = await p.f.runner.execute(p.input);
      p.checkpoint.analysis = first.round.analysis;
      p.checkpoint.round = first.round.round;
      if (withFinding) {
        const analysis = p.checkpoint.analysis;
        analysis.findings = p.pr.result.findings.map((finding) => ({
          ...finding,
          confirmation: { ...finding.confirmation, recheckRef: null },
          fixRecommendation: { ...finding.fixRecommendation, planRef: null },
          locations: [
            {
              kind: "source" as const,
              subjectRef: finding.subjectRef,
              path: "src/Core.cs",
              startLine: 1,
              endLine: 1,
            },
          ],
        }));
        const finding = analysis.findings[0]!;
        analysis.candidates = [
          {
            ...p.pr.result.report.loop.candidates[0]!,
            status: "pending",
            findingId: finding.id,
            findingVersion: finding.version,
          },
        ];
        analysis.evidence = p.pr.result.verificationEvidence.flatMap((entry) =>
          entry.source === "static_analysis" || entry.source === "reporter_statement"
            ? [
                {
                  id: entry.id,
                  subjectRef: entry.subjectRef,
                  source: entry.source,
                  summary: entry.summary,
                  evidenceRefs: entry.evidenceRefs,
                },
              ]
            : [],
        );
      }
      p.readSourceContext.mockClear();
      p.readSourceDependencies.mockClear();
      p.f.start.mockClear();
      const protectedFile = p.sourceContext.contextFiles[0]!;
      const optionalContent = "x".repeat(128 * 1024 - Buffer.byteLength(protectedFile.content));
      p.readSourceDependencies.mockImplementation(async (seedPaths) => ({
        sourceSha: p.workspace.sourceBinding!.sourceSha,
        seedPaths: [...seedPaths],
        symbols: ["removed"],
        searchDepth: 1,
        files: [
          {
            path: protectedFile.path,
            content: protectedFile.content,
            digest: protectedFile.digest,
          },
        ],
        queries: [
          {
            revisionSha: p.workspace.sourceBinding!.sourceSha,
            symbols: ["removed"],
            paths: [protectedFile.path],
            depth: 1,
          },
        ],
      }));
      p.readSourceContext.mockResolvedValue({
        ...p.sourceContext,
        contextFiles: [
          {
            path: "src/Extra.cs",
            content: optionalContent,
            digest: hash(optionalContent),
            role: "related_context",
            relation: "unresolved_reference_identity",
          },
          protectedFile,
        ],
        queries: [
          {
            kind: "definition",
            revisionSha: p.workspace.sourceBinding!.sourceSha,
            symbols: ["Delegate"],
            paths: [protectedFile.path, "src/Extra.cs"],
            matchedPathCount: 2,
            omittedPathCount: 0,
          },
        ],
        identityScanFiles: 3,
        identityScanBytes: p.sourceContext.identityScanBytes + Buffer.byteLength(optionalContent),
      });
      const result = await p.f.runner.execute(p.input);
      const prompt = p.f.start.mock.calls[0]![0].standardInput!;
      const context = JSON.parse(
        prompt
          .split("<frozen_investigation_context>\n")[1]!
          .split("\n</frozen_investigation_context>")[0]!,
      ) as {
        turn: ModelTurnProjectionContext;
        sourceFiles: Array<{ path: string; content: string; sha256: string }>;
        sourceContextDiscovery: {
          deferred: Array<{ path: string; reason: string }>;
          catalogComplete: boolean;
          omittedCandidateCount: number;
        };
      };
      expect(p.readSourceContext).toHaveBeenCalledExactlyOnceWith(["src/Core.cs"]);
      expect(p.readSourceDependencies).toHaveBeenCalledExactlyOnceWith(["src/deleted.ts"]);
      expect(context.turn.analysis.coverageUnits.map((unit) => unit.id)).toEqual(["full-diff"]);
      expect(context.turn.analysis.findings).toEqual(p.checkpoint.analysis.findings);
      expect(context.turn.analysis.findings).toHaveLength(withFinding ? 1 : 0);
      if (withFinding)
        expect(context.turn.analysis.findings[0]!.locations).toEqual([
          {
            kind: "source",
            subjectRef: p.task.subjectRef,
            path: "src/Core.cs",
            startLine: 1,
            endLine: 1,
          },
        ]);
      expect(context.sourceFiles).toContainEqual({
        path: "src/Core.cs",
        content: p.sourceContext.requiredFiles[0]!.content,
        sha256: p.sourceContext.requiredFiles[0]!.digest,
      });
      expect(context.sourceFiles).toContainEqual({
        path: protectedFile.path,
        content: protectedFile.content,
        sha256: protectedFile.digest,
      });
      expect(context.sourceFiles).toHaveLength(2);
      expect(context.sourceContextDiscovery.deferred).toEqual([
        { path: "src/Extra.cs", reason: "prompt_input_budget" },
      ]);
      expect(context.sourceContextDiscovery.catalogComplete).toBe(true);
      expect(context.sourceContextDiscovery.omittedCandidateCount).toBe(0);
      expect(result.sourceUnitIds).toEqual(p.descriptors.map((chunk) => chunk.id));
    },
  );

  it.each(["revision", "digest", "path", "required_input_budget"] as const)(
    "rejects invalid focused required source %s before model dispatch",
    async (mode) => {
      const p = focusedSourceFixture(
        undefined,
        mode === "required_input_budget" ? "r".repeat(128 * 1024) : undefined,
      );
      const required = p.sourceContext.requiredFiles[0]!;
      if (mode !== "required_input_budget")
        p.readSourceContext.mockResolvedValue({
          ...p.sourceContext,
          ...(mode === "revision" ? { sourceSha: "0".repeat(40) } : {}),
          requiredFiles: [
            {
              ...required,
              ...(mode === "digest" ? { digest: "0".repeat(64) } : {}),
              ...(mode === "path" ? { path: "../Core.cs" } : {}),
            },
          ],
        });
      await expect(p.f.runner.execute(p.input)).rejects.toMatchObject({
        code:
          mode === "required_input_budget"
            ? "MODEL_INPUT_LIMIT_EXCEEDED"
            : "MODEL_SOURCE_UNAVAILABLE",
      });
      expect(p.readSourceContext).toHaveBeenCalledExactlyOnceWith(["src/Core.cs"]);
      expect(p.readSourceDependencies).not.toHaveBeenCalled();
      expect(p.f.start).not.toHaveBeenCalled();
    },
  );

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
      expect(result).toEqual({
        round: expectedRound,
        modelIdentity: { engine, model: null },
        usage: { tokens: 50, source: "cli" },
      });
      expect(f.start).toHaveBeenCalledOnce();
      const [spec, signal] = f.start.mock.calls[0]!;
      expect(signal).not.toBe(f.input.signal);
      expect(spec.environmentMode).toBe("replace");
      expect(spec.environment).not.toHaveProperty("WORKER_TOKEN");
      expect(spec.standardInput).toContain("Synthetic frozen issue text");
      expect(spec.standardInput).toContain("Do not run commands, tests, builds");
      for (const instruction of [
        "Write narrative report content in English",
        "Preserve source identifiers and necessary verbatim quotations in their original language",
        "provenance.kind=agentic_review_progress",
        "not new human requests or independent evidence",
        "evidenceRefs identifies evidence, not subjects",
        "evidenceRefs: []",
        "Only status and evidenceRefs may change",
        "Accepted evidence and recheck records are immutable",
        "including changes to a finding's confirmation or recheckRef",
        `provisional digest "${"0".repeat(64)}"`,
        "the Worker computes the real digest from the complete proposed plan",
        "Copy existing saved plan references exactly",
        "findingVersion must match the updated finding version",
        "preserve its subjectRef and discoveredRound exactly",
        "A confirmed candidate must provide a non-null findingId and positive findingVersion",
        "An unresolved candidate must provide the same links to a hypothesis finding",
        "Preserve historical findingId and findingVersion links on withdrawn or merged candidates",
        "In a recheck round, return all three together",
        "incrementing version and setting confirmation.recheckRef to a new recheck ID",
        "Appending only a recheck does not link it to the finding and leaves the finding pending",
        "This snapshot_only task investigates only the provided material",
        "not new required coverage that must wait for future inputs",
        "bugAssessment may remain needs_information or needs_verification",
        "Do not leave a candidate pending solely to wait for unavailable external information",
        "independently recheck its final version against the supplied evidence",
        "keep its hypothesis status if uncertainty remains",
      ])
        expect(spec.standardInput).toContain(instruction);
      if (engine === "codex") {
        expect(spec.arguments[spec.arguments.indexOf("--cd") + 1]).toBe(
          f.input.workspace.modelInputDirectory,
        );
        expect(
          spec.arguments.filter((argument) => argument === "--skip-git-repo-check"),
        ).toHaveLength(1);
        expect(spec.arguments).toContain("--dangerously-bypass-approvals-and-sandbox");
        expect(spec.arguments).not.toContain("features.shell_tool=false");
        expect(spec.arguments).not.toContain("features.unified_exec=false");
        expect(spec.arguments).toEqual(
          expect.arrayContaining([
            'approval_policy="never"',
            "features.apps=false",
            "features.hooks=false",
            "features.multi_agent=false",
            'web_search="disabled"',
            'mcp_servers."external-services".enabled=false',
          ]),
        );
        expect(spec.arguments.at(-1)).toBe("-");
      } else {
        expect(spec.arguments).toContain("--allow-all");
        expect(spec.arguments).not.toContain("--available-tools=view,glob,grep");
        expect(spec.arguments).not.toContain("--skip-git-repo-check");
      }
      expect(f.io.writeExclusiveUtf8).toHaveBeenCalledWith(
        win32.join(f.roundDirectory, "round-schema.json"),
        JSON.stringify(createInvestigationModelOutputSchema(InvestigationModelTurnDeltaV1Schema)),
      );
      expect(f.io.removeDirectory).toHaveBeenCalledWith(f.roundDirectory);
      expect(f.input.workspace.cleanup).not.toHaveBeenCalled();
    },
  );

  it.each(["codex", "copilot"] as const)(
    "records the exact configured %s model independently of model-authored content",
    async (engine) => {
      const model = "provider/model-under-test";
      const f = fixture({ engine, options: { model } });
      f.round.analysis.summary = "I am a different model according to untrusted narrative text.";
      const result = await f.runner.execute(f.input);
      expect(result.modelIdentity).toEqual({ engine, model });
      expect(result.round.analysis.summary).toBe(f.round.analysis.summary);
      const argumentsList = f.start.mock.calls[0]![0].arguments;
      expect(argumentsList[argumentsList.indexOf("--model") + 1]).toBe(model);
      expect(result.round).not.toHaveProperty("modelIdentity");
      expect(result.round.analysis).not.toHaveProperty("modelIdentity");
    },
  );

  it.each(["", "   ", "a".repeat(257), "model\u0000suffix", "model\u0085suffix"])(
    "rejects an invalid configured model identity before process execution",
    (model) => {
      const f = fixture();
      expect(() => createModelTurnRunner({ ...f.options, model })).toThrow(
        "configured CLI model identity is invalid",
      );
      expect(f.start).not.toHaveBeenCalled();
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
    const { f, input, workspace, descriptors } = prChunkFixture();
    const result = await f.runner.execute(input);
    expect(result.sourceUnitIds).toEqual(descriptors.map((chunk) => chunk.id));
    expect(workspace.readPrDiffChunks).toHaveBeenCalledExactlyOnceWith(
      descriptors.map((chunk) => chunk.id),
    );
    expect(workspace.readPrDiffChunk).not.toHaveBeenCalled();
    expect(workspace.resolveSourcePath).not.toHaveBeenCalled();
    const prompt = f.start.mock.calls[0]![0].standardInput;
    expect(prompt).toContain("export const removed = true;");
    expect(prompt).toContain("Only status and evidenceRefs may change");
    expect(prompt).toContain(
      "Their supplied content is only inert link-target text; no link was followed.",
    );
    expect(prompt).toContain("Target content is covered only when independently supplied");
    const suppliedContext = JSON.parse(
      prompt!
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!,
    ) as { sourceRepresentation: { inertSymlinks: unknown[] }; sourceChunks: unknown[] };
    expect(suppliedContext.sourceRepresentation.inertSymlinks).toEqual(
      workspace.sourceBinding!.inertSymlinks,
    );
    expect(suppliedContext.sourceChunks).toHaveLength(descriptors.length);
    expect(prompt).not.toContain("This snapshot_only task investigates only the provided material");
    expect(
      result.round.analysis.coverage.includedUnits.find((unit) => unit.id === "full-diff")?.status,
    ).toBe("pending");
  });

  it("reuses the round chunk cache after reducing the complete source projection", async () => {
    const chunks = ["first", "second", "third"].map((id) => ({
      id,
      kind: "base" as const,
      content: id[0]!.repeat(40 * 1024),
    }));
    const p = prChunkFixture({ chunks, options: { maximumInputBytes: 128 * 1024 } });
    for (const unit of p.checkpoint.analysis.coverage.includedUnits)
      if (unit.kind === "pr_diff_chunk") unit.requiredWork += " Review frozen source.".repeat(800);

    const result = await p.f.runner.execute(p.input);
    const prompt = p.f.start.mock.calls[0]![0].standardInput!;
    const context = JSON.parse(
      prompt
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!,
    ) as { sourceChunks: InvestigationPrDiffChunk[] };

    expect(p.readPrDiffChunks).toHaveBeenCalledExactlyOnceWith(chunks.map((chunk) => chunk.id));
    expect(p.workspace.readPrDiffChunk).not.toHaveBeenCalled();
    expect(result.sourceUnitIds).toEqual(["first"]);
    expect(context.sourceChunks.map((chunk) => chunk.id)).toEqual(result.sourceUnitIds);
    expect(context.sourceChunks[0]!.content).toBe(chunks[0]!.content);
    expect(prompt).not.toContain(chunks[1]!.content);
    expect(prompt).not.toContain(chunks[2]!.content);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(128 * 1024);
  });

  it("redelivers the complete frozen diff to a stateless full-diff round after all chunks were covered", async () => {
    const p = prChunkFixture();
    const coverage = p.checkpoint.analysis.coverage;
    for (const unit of coverage.includedUnits)
      unit.status = unit.kind === "pr_diff_chunk" ? "completed" : "blocked";
    coverage.completedUnitRefs = p.descriptors.map((chunk) => chunk.id);
    coverage.unresolvedUnitRefs = ["full-diff"];
    p.checkpoint.runtime.sourceCoverage!.brokeredUnitIds = [...coverage.completedUnitRefs];
    p.checkpoint.round = 3;
    p.checkpoint.consumed = {
      rounds: 3,
      durationMs: 2_425_940,
      tokens: 94_954,
      reportBytes: 33_092,
    };
    p.task.budget = {
      ...p.task.budget,
      maxRounds: 24,
      maxDurationMs: 3_600_000,
      maxTokens: 120_000,
    };
    p.checkpoint.budget = { ...p.task.budget };
    const result = await p.f.runner.execute(p.input);
    const prompt = p.f.start.mock.calls[0]![0].standardInput!;
    const context = JSON.parse(
      prompt
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!,
    ) as { turn: ModelTurnProjectionContext; sourceChunks: InvestigationPrDiffChunk[] };
    expect(context.turn.analysis.coverageUnits.map((unit) => unit.id)).toEqual(["full-diff"]);
    expect(context.turn.analysis.coverageUnits[0]!.requiredWork).toBe(
      "Review the complete frozen PR diff.",
    );
    expect(context.sourceChunks.map((chunk) => chunk.id)).toEqual(
      p.descriptors.map((chunk) => chunk.id),
    );
    expect(context.sourceChunks.map((chunk) => chunk.content)).toEqual([...p.contents.values()]);
    expect(result.sourceUnitIds).toEqual(p.descriptors.map((chunk) => chunk.id));
    expect(context.turn.budgetState.consumed.tokens).toBe(94_954);
    expect(context.turn.budgetState.remaining).toMatchObject({
      rounds: 21,
      durationMs: 1_174_060,
      tokens: 25_046,
    });
    expect(prompt).toContain("Each turn is stateless");
    expect(prompt).toContain("A low budget never permits invented evidence");
    expect(prompt).toContain("A non-finalize batch cannot finish");
  });

  it("supplies complete lexical dependency files in the selected full-diff turn", async () => {
    const p = prChunkFixture({ status: "modified" });
    selectFullDiff(p);
    const readSourceDependencies = attachSourceDependencies(p);

    const result = await p.f.runner.execute(p.input);
    const prompt = p.f.start.mock.calls[0]![0].standardInput!;
    const context = JSON.parse(
      prompt
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!,
    ) as {
      turn: ModelTurnProjectionContext;
      sourceFiles: Array<{ path: string; content: string; sha256: string }>;
      sourceDiscovery: Omit<InvestigationSourceDependencies, "files"> & {
        available: boolean;
        filePaths: string[];
      };
      sourceProjection: { allSelectedFilesIncluded: boolean; allDependencyFilesIncluded: boolean };
    };
    expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith(["src/deleted.ts"]);
    expect(context.turn.analysis.coverageUnits.map((unit) => unit.id)).toEqual(["full-diff"]);
    expect(context.sourceFiles[0]).toEqual({
      path: "src/caller.test.ts",
      content: "import { removed } from './deleted';\nexport const delegated = removed;\n",
      sha256: hash("import { removed } from './deleted';\nexport const delegated = removed;\n"),
    });
    expect(context.sourceDiscovery).toEqual({
      available: true,
      sourceSha: p.workspace.sourceBinding!.sourceSha,
      seedPaths: ["src/deleted.ts"],
      symbols: ["removed"],
      searchDepth: 1,
      queries: [
        {
          revisionSha: p.workspace.sourceBinding!.sourceSha,
          symbols: ["removed"],
          paths: ["src/caller.test.ts"],
          depth: 1,
        },
      ],
      filePaths: ["src/caller.test.ts"],
    });
    expect(context.sourceProjection).toMatchObject({
      allSelectedFilesIncluded: true,
      allDependencyFilesIncluded: true,
    });
    expect(result.sourceUnitIds).toEqual(p.descriptors.map((chunk) => chunk.id));
    expect(prompt).toContain("not a complete call graph");
    expect(prompt).toContain("does not establish that a file was analyzed");
    expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves complete full-diff chunks with unsupported documentation seeds: mixed=%s",
    async (includeCode) => {
      const documentationPath = "docs/review.md";
      const chunks: Array<Pick<InvestigationPrDiffChunk, "id" | "path" | "kind" | "content">> = [
        {
          id: "documentation-diff",
          path: documentationPath,
          kind: "diff",
          content:
            "diff --git a/docs/review.md b/docs/review.md\n@@ -1 +1 @@\n-# Old review\n+# Updated review\n",
        },
        {
          id: "documentation-base",
          path: documentationPath,
          kind: "base",
          content: "# Old review\n",
        },
        {
          id: "documentation-head",
          path: documentationPath,
          kind: "head",
          content: "# Updated review\n",
        },
      ];
      if (includeCode)
        chunks.push(
          {
            id: "code-diff",
            path: "src/deleted.ts",
            kind: "diff",
            content:
              "diff --git a/src/deleted.ts b/src/deleted.ts\n@@ -1 +1 @@\n-export const removed = false;\n+export const removed = true;\n",
          },
          {
            id: "code-base",
            path: "src/deleted.ts",
            kind: "base",
            content: "export const removed = false;\n",
          },
          {
            id: "code-head",
            path: "src/deleted.ts",
            kind: "head",
            content: "export const removed = true;\n",
          },
        );
      const p = prChunkFixture({ status: "modified", chunks });
      selectFullDiff(p);
      const readSourceDependencies = attachSourceDependencies(p, includeCode ? undefined : []);
      const original = readSourceDependencies.getMockImplementation()!;
      readSourceDependencies.mockImplementation(async (seedPaths) => ({
        ...(await original(seedPaths)),
        unsupportedSeedPaths: [documentationPath],
        ...(includeCode ? {} : { symbols: [], searchDepth: 0, queries: [] }),
      }));

      const result = await makePrompt(p.input, p.f.io, 128 * 1024, 128 * 1024);
      const context = JSON.parse(
        result.prompt
          .split("<frozen_investigation_context>\n")[1]!
          .split("\n</frozen_investigation_context>")[0]!,
      ) as {
        sourceChunks: InvestigationPrDiffChunk[];
        sourceFiles: Array<{ path: string; content: string; sha256: string }>;
        sourceDiscovery: Omit<InvestigationSourceDependencies, "files"> & {
          available: boolean;
          filePaths: string[];
        };
        sourceProjection: {
          allSelectedFilesIncluded: boolean;
          allDependencyFilesIncluded: boolean;
        };
      };
      const seedPaths = includeCode ? [documentationPath, "src/deleted.ts"] : [documentationPath];
      const callerContent =
        "import { removed } from './deleted';\nexport const delegated = removed;\n";
      expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith(seedPaths);
      expect(result.projection.selectedUnitIds).toEqual(["full-diff"]);
      expect(context.sourceChunks).toEqual(p.descriptors.map((chunk) => p.readChunk(chunk.id)));
      expect(result.sourceUnitIds).toEqual(p.descriptors.map((chunk) => chunk.id));
      expect(context.sourceFiles).toEqual(
        includeCode
          ? [{ path: "src/caller.test.ts", content: callerContent, sha256: hash(callerContent) }]
          : [],
      );
      expect(context.sourceDiscovery).toEqual({
        available: true,
        sourceSha: p.workspace.sourceBinding!.sourceSha,
        seedPaths,
        unsupportedSeedPaths: [documentationPath],
        symbols: includeCode ? ["removed"] : [],
        searchDepth: includeCode ? 1 : 0,
        queries: includeCode
          ? [
              {
                revisionSha: p.workspace.sourceBinding!.sourceSha,
                symbols: ["removed"],
                paths: ["src/caller.test.ts"],
                depth: 1,
              },
            ]
          : [],
        filePaths: includeCode ? ["src/caller.test.ts"] : [],
      });
      expect(context.sourceProjection).toMatchObject({
        allSelectedFilesIncluded: true,
        allDependencyFilesIncluded: false,
      });
      expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
      expect(p.f.start).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "deduplicates selected dependency files only when complete content agrees: conflict=%s",
    async (conflict) => {
      const p = prChunkFixture();
      selectFullDiff(p);
      const path = "src/shared-caller.ts";
      const content = "export const sourceIdentity = true;\n";
      p.checkpoint.analysis.coverage.includedUnits[0]!.paths = [path];
      p.f.files.set(
        win32.join(p.f.input.workspace.attemptDirectory, "source", path),
        Buffer.from(content),
      );
      attachSourceDependencies(p, [
        { path, content: conflict ? `${content}// Different.\n` : content },
      ]);
      if (conflict) {
        await expect(p.f.runner.execute(p.input)).rejects.toMatchObject({
          code: "MODEL_SOURCE_UNAVAILABLE",
        });
        expect(p.f.start).not.toHaveBeenCalled();
        return;
      }
      await p.f.runner.execute(p.input);
      const prompt = p.f.start.mock.calls[0]![0].standardInput!;
      const context = JSON.parse(
        prompt
          .split("<frozen_investigation_context>\n")[1]!
          .split("\n</frozen_investigation_context>")[0]!,
      ) as {
        sourceFiles: Array<{ path: string; content: string; sha256: string }>;
        sourceProjection: {
          allSelectedFilesIncluded: boolean;
          allDependencyFilesIncluded: boolean;
        };
      };
      expect(context.sourceFiles).toEqual([{ path, content, sha256: hash(content) }]);
      expect(context.sourceProjection).toMatchObject({
        allSelectedFilesIncluded: true,
        allDependencyFilesIncluded: true,
      });
    },
  );

  it("reports unavailable dependency discovery for legacy workspaces", async () => {
    const p = prChunkFixture();
    selectFullDiff(p);
    await p.f.runner.execute(p.input);
    const prompt = p.f.start.mock.calls[0]![0].standardInput!;
    const context = JSON.parse(
      prompt
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!,
    ) as {
      sourceDiscovery: { available: boolean; seedPaths: string[] };
      sourceProjection: { allDependencyFilesIncluded: boolean };
    };
    expect(context.sourceDiscovery).toMatchObject({
      available: false,
      seedPaths: ["src/deleted.ts"],
    });
    expect(context.sourceProjection.allDependencyFilesIncluded).toBe(false);
  });

  it("supplies namespace filtering evidence while keeping excluded files outside delivered source", async () => {
    const p = prChunkFixture();
    selectFullDiff(p);
    const reader = attachSourceDependencies(p);
    const original = reader.getMockImplementation()!;
    reader.mockImplementation(async (paths) => {
      const result = await original(paths);
      return {
        ...result,
        identityScanBytes: 200,
        queries: result.queries.map((query) => ({
          ...query,
          paths: [...query.paths, "src/unrelated.cs"].sort(),
          anchorIdentities: query.symbols.map((name) => ({ name, namespace: "Example" })),
          provenReferencePaths: query.paths.filter((path) => paths.includes(path)),
          unpropagatedMatches: query.paths
            .filter((path) => !paths.includes(path))
            .map((path) => ({ path, reason: "unresolved_reference_identity" as const })),
          excludedMatches: [
            {
              path: "src/unrelated.cs",
              reason: "namespace_or_import_only" as const,
              matchedSymbols: query.symbols,
            },
          ],
        })),
      };
    });
    await p.f.runner.execute(p.input);
    const prompt = p.f.start.mock.calls[0]![0].standardInput!;
    const context = JSON.parse(
      prompt
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!,
    ) as {
      sourceFiles: Array<{ path: string }>;
      sourceDiscovery: {
        identityScanBytes: number;
        queries: Array<{ excludedMatches: unknown[] }>;
      };
    };
    expect(context.sourceDiscovery.identityScanBytes).toBe(200);
    expect(context.sourceDiscovery.queries[0]!.excludedMatches).toHaveLength(1);
    expect(context.sourceFiles.some((file) => file.path === "src/unrelated.cs")).toBe(false);
  });

  it.each([
    "revision",
    "seed order",
    "seed omission",
    "digest",
    "unsafe path",
    "duplicate path",
    "query revision",
    "query order",
  ] as const)(
    "rejects dependency discovery with invalid %s before model dispatch",
    async (mode) => {
      const p = prChunkFixture();
      selectFullDiff(p);
      p.checkpoint.analysis.coverage.includedUnits[0]!.paths = ["src/z-last.ts"];
      const readSourceDependencies = attachSourceDependencies(p);
      const original = readSourceDependencies.getMockImplementation()!;
      readSourceDependencies.mockImplementation(async (seedPaths) => {
        const value = structuredClone(await original(seedPaths));
        const first = value.files[0]!;
        return {
          ...value,
          ...(mode === "revision" ? { sourceSha: "f".repeat(40) } : {}),
          ...(mode === "seed order" ? { seedPaths: [...value.seedPaths].reverse() } : {}),
          ...(mode === "seed omission" ? { seedPaths: [] } : {}),
          ...(mode === "digest" ? { files: [{ ...first, digest: "0".repeat(64) }] } : {}),
          ...(mode === "unsafe path" ? { files: [{ ...first, path: "../outside.ts" }] } : {}),
          ...(mode === "duplicate path" ? { files: [first, { ...first }] } : {}),
          ...(mode === "query revision"
            ? { queries: [{ ...value.queries[0]!, revisionSha: "f".repeat(40) }] }
            : {}),
          ...(mode === "query order"
            ? { queries: [{ ...value.queries[0]!, paths: ["src/z.ts", "src/a.ts"] }] }
            : {}),
        };
      });
      await expect(p.f.runner.execute(p.input)).rejects.toMatchObject({
        code: "MODEL_SOURCE_UNAVAILABLE",
      });
      expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith([
        "src/deleted.ts",
        "src/z-last.ts",
      ]);
      expect(p.f.start).not.toHaveBeenCalled();
    },
  );

  it("keeps complete dependencies across projection retries and fails before model dispatch when they cannot fit", async () => {
    const p = prChunkFixture({ options: { maximumInputBytes: 128 * 1024 } });
    selectFullDiff(p);
    const readSourceDependencies = attachSourceDependencies(p, [
      { path: "src/large-caller.ts", content: "x".repeat(128 * 1024) },
    ]);
    await expect(p.f.runner.execute(p.input)).rejects.toMatchObject({
      code: "MODEL_INPUT_LIMIT_EXCEEDED",
    });
    expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith(["src/deleted.ts"]);
    expect(p.f.start).not.toHaveBeenCalled();
  });

  it("redelivers source linked to a pending candidate through typed coverage evidence", async () => {
    const p = prChunkFixture();
    const readSourceDependencies = attachSourceDependencies(p);
    const analysis = p.checkpoint.analysis;
    for (const unit of analysis.coverage.includedUnits) unit.status = "completed";
    analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits.map((unit) => unit.id);
    analysis.coverage.unresolvedUnitRefs = [];
    p.checkpoint.runtime.sourceCoverage!.brokeredUnitIds = p.descriptors.map((chunk) => chunk.id);
    const sourceEvidence = {
      id: "evidence-base-source",
      subjectRef: p.task.subjectRef,
      source: "static_analysis" as const,
      summary: "The supplied deleted-file base establishes the candidate's source context.",
      evidenceRefs: [],
    };
    analysis.evidence = [sourceEvidence];
    analysis.coverage.includedUnits.find((unit) => unit.id === "deleted-base")!.evidenceRefs = [
      sourceEvidence.id,
    ];
    analysis.candidates = [
      {
        id: "candidate-source-linked",
        subjectRef: p.task.subjectRef,
        title: "Inspect the retained source concern.",
        discoveredRound: 1,
        status: "pending",
        findingId: null,
        findingVersion: null,
        mergedIntoCandidateId: null,
        rationale: "The concern is linked to the typed source evidence.",
        evidenceRefs: [sourceEvidence.id],
      },
    ];
    p.checkpoint.round = 1;
    const result = await p.f.runner.execute(p.input);
    const prompt = p.f.start.mock.calls[0]![0].standardInput!;
    const context = JSON.parse(
      prompt
        .split("<frozen_investigation_context>\n")[1]!
        .split("\n</frozen_investigation_context>")[0]!,
    ) as {
      turn: ModelTurnProjectionContext;
      sourceChunks: InvestigationPrDiffChunk[];
      sourceFiles: Array<{ path: string; content: string; sha256: string }>;
    };
    expect(context.turn.analysis.candidates.map((candidate) => candidate.id)).toEqual([
      "candidate-source-linked",
    ]);
    expect(context.turn.analysis.coverageUnits).toEqual([]);
    expect(context.sourceChunks.map((chunk) => chunk.id)).toEqual(["deleted-base"]);
    expect(context.sourceChunks[0]!.content).toBe(p.contents.get("deleted-base"));
    expect(result.sourceUnitIds).toEqual(["deleted-base"]);
    expect(context.turn.analysis.evidence).toContainEqual(sourceEvidence);
    expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith(["src/deleted.ts"]);
    expect(context.sourceFiles).toContainEqual({
      path: "src/caller.test.ts",
      content: "import { removed } from './deleted';\nexport const delegated = removed;\n",
      sha256: hash("import { removed } from './deleted';\nexport const delegated = removed;\n"),
    });
  });

  it("supplies changed-file source for a selected concrete non-chunk coverage path", async () => {
    const p = prChunkFixture();
    const coverage = p.checkpoint.analysis.coverage;
    for (const unit of coverage.includedUnits) unit.status = "completed";
    coverage.completedUnitRefs = coverage.includedUnits.map((unit) => unit.id);
    coverage.includedUnits.push({
      id: "source-follow-up",
      subjectRef: p.task.subjectRef,
      kind: "source_dependency",
      paths: [p.manifest.files[0]!.path],
      requiredWork: "Inspect this exact file again to resolve a source question.",
      status: "pending",
      evidenceRefs: [],
    });
    coverage.unresolvedUnitRefs = ["source-follow-up"];
    p.checkpoint.runtime.sourceCoverage!.brokeredUnitIds = p.descriptors.map((chunk) => chunk.id);
    p.checkpoint.round = 1;
    const result = await p.f.runner.execute(p.input);
    expect(result.sourceUnitIds).toEqual(p.descriptors.map((chunk) => chunk.id));
    expect(p.readPrDiffChunks).toHaveBeenCalledExactlyOnceWith(
      p.descriptors.map((chunk) => chunk.id),
    );
    expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
  });

  it.each(["primary", "secondary"] as const)(
    "binds typed candidate caller paths to the %s source subject without parsing narrative paths",
    async (sourceKind) => {
      const p = prChunkFixture();
      const readSourceDependencies = attachSourceDependencies(p);
      const subjectRef = sourceKind === "primary" ? p.task.subjectRef : "secondary-source-subject";
      if (sourceKind === "secondary") {
        const original = p.task.subjects.find((subject) => subject.id === p.task.subjectRef)!;
        p.task.subjects.push({ ...original, id: subjectRef });
        p.task.executionPolicy.allowedSubjectRefs.push(subjectRef);
      }
      const analysis = p.checkpoint.analysis;
      for (const unit of analysis.coverage.includedUnits) unit.status = "completed";
      const callerPath = "src/caller.ts";
      const callerContent = "export const actualCaller = true;\n";
      const evidenceId = "evidence-caller-source";
      analysis.coverage.includedUnits.push({
        id: "known-caller",
        subjectRef,
        kind: "source_dependency",
        paths: [callerPath],
        requiredWork: "Inspect the exact caller supplied through trusted source reading.",
        status: "completed",
        evidenceRefs: [evidenceId],
      });
      analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits.map((unit) => unit.id);
      analysis.coverage.unresolvedUnitRefs = [];
      analysis.evidence = [
        {
          id: evidenceId,
          subjectRef,
          source: "static_analysis",
          summary: "The narrative mentions private/guess.ts, which is not a requested path.",
          evidenceRefs: [],
        },
      ];
      analysis.candidates = [
        {
          id: "candidate-caller-linked",
          subjectRef,
          title: "Do not infer a file path from this title.",
          discoveredRound: 1,
          status: "pending",
          findingId: null,
          findingVersion: null,
          mergedIntoCandidateId: null,
          rationale: "The source context is the exact typed coverage path.",
          evidenceRefs: [evidenceId],
        },
      ];
      p.checkpoint.round = 1;
      p.f.files.set(
        win32.join(p.f.input.workspace.attemptDirectory, "source", callerPath),
        Buffer.from(callerContent),
      );
      if (sourceKind === "secondary") {
        await expect(p.f.runner.execute(p.input)).rejects.toMatchObject({
          code: "MODEL_SOURCE_UNAVAILABLE",
        });
        expect(p.workspace.resolveSourcePath).not.toHaveBeenCalled();
        expect(readSourceDependencies).not.toHaveBeenCalled();
        expect(p.f.start).not.toHaveBeenCalled();
        return;
      }
      await p.f.runner.execute(p.input);
      expect(p.workspace.resolveSourcePath).toHaveBeenCalledExactlyOnceWith(callerPath);
      expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith([callerPath]);
      const prompt = p.f.start.mock.calls[0]![0].standardInput!;
      expect(prompt).toContain(callerContent.trim());
      expect(prompt).toContain("export const delegated = removed;");
      expect(p.readPrDiffChunks).not.toHaveBeenCalled();
    },
  );

  it.each(["deleted", "modified"] as const)(
    "prefetches %s recheck line indexes once without claiming delivery of index-only chunks",
    async (status) => {
      const kind = status === "deleted" ? "base" : "head";
      const p = prChunkFixture({
        status,
        findingCount: 1,
        chunks: [
          { id: "anchor", kind: "diff", content: "Frozen diff anchor.\n" },
          { id: "first", kind, content: "First source line.\nSecond source line.\n" },
          { id: "second", kind, content: "Third source line.\nFourth source line.\n" },
          { id: "third", kind, content: "Fifth source line.\nSixth source line.\n" },
        ],
      });
      const readSourceDependencies = attachSourceDependencies(p);
      const analysis = p.checkpoint.analysis;
      for (const unit of analysis.coverage.includedUnits) unit.status = "completed";
      analysis.coverage.completedUnitRefs = analysis.coverage.includedUnits.map((unit) => unit.id);
      analysis.coverage.unresolvedUnitRefs = [];
      analysis.findings = p.pr.result.findings.map((finding) => ({
        ...finding,
        confirmation: { ...finding.confirmation, recheckRef: null },
        fixRecommendation: { ...finding.fixRecommendation, planRef: null },
        locations: [1, 2].map(() => ({
          kind: "source" as const,
          subjectRef: finding.subjectRef,
          path: p.manifest.files[0]!.path,
          startLine: 2,
          endLine: 2,
        })),
      }));
      analysis.candidates = p.pr.result.report.loop.candidates;
      analysis.evidence = p.pr.result.verificationEvidence.flatMap((entry) =>
        entry.source === "static_analysis" || entry.source === "reporter_statement"
          ? [
              {
                id: entry.id,
                subjectRef: entry.subjectRef,
                source: entry.source,
                summary: entry.summary,
                evidenceRefs: entry.evidenceRefs,
              },
            ]
          : [],
      );
      p.checkpoint.round = 1;
      p.checkpoint.lastPhase = "discovery";

      const result = await p.f.runner.execute(p.input);
      const prompt = p.f.start.mock.calls[0]![0].standardInput!;
      const context = JSON.parse(
        prompt
          .split("<frozen_investigation_context>\n")[1]!
          .split("\n</frozen_investigation_context>")[0]!,
      ) as { turn: ModelTurnProjectionContext; sourceChunks: InvestigationPrDiffChunk[] };

      expect(context.turn.phase).toBe("recheck");
      expect(readSourceDependencies).toHaveBeenCalledExactlyOnceWith(["src/deleted.ts"]);
      expect(prompt).toContain("export const delegated = removed;");
      expect(p.readPrDiffChunks).toHaveBeenCalledExactlyOnceWith([
        "anchor",
        "first",
        "second",
        "third",
      ]);
      expect(p.workspace.readPrDiffChunk).not.toHaveBeenCalled();
      expect(result.sourceUnitIds).toEqual(["anchor", "first"]);
      expect(context.sourceChunks.map((chunk) => chunk.id)).toEqual(result.sourceUnitIds);
      expect(context.sourceChunks[1]!.kind).toBe(kind);
      expect(prompt).not.toContain(p.contents.get("second"));
      expect(prompt).not.toContain(p.contents.get("third"));
      expect(p.workspace.assertSourceBinding).toHaveBeenCalledTimes(2);
    },
  );

  it("falls back to the legacy chunk adapter and caches each chunk for budget retries", async () => {
    const chunks = ["first", "second", "third"].map((id) => ({
      id,
      kind: "base" as const,
      content: id[0]!.repeat(40 * 1024),
    }));
    const p = prChunkFixture({ chunks, options: { maximumInputBytes: 128 * 1024 } });
    for (const unit of p.checkpoint.analysis.coverage.includedUnits)
      if (unit.kind === "pr_diff_chunk") unit.requiredWork += " Review frozen source.".repeat(800);
    const { readPrDiffChunks: _batch, ...workspace } = p.workspace;

    const result = await p.f.runner.execute({ ...p.input, workspace });

    expect(p.readPrDiffChunks).not.toHaveBeenCalled();
    expect(vi.mocked(workspace.readPrDiffChunk).mock.calls).toEqual(chunks.map(({ id }) => [id]));
    expect(result.sourceUnitIds).toEqual(["first"]);
  });

  it.each(["short", "extra", "reordered", "unknown", "duplicate"] as const)(
    "rejects a %s batch before dispatching any source to the model",
    async (shape) => {
      const p = prChunkFixture();
      p.readPrDiffChunks.mockImplementation(async (ids) => {
        const chunks = ids.map(p.readChunk);
        if (shape === "short") return chunks.slice(0, -1);
        if (shape === "extra") return [...chunks, chunks[0]!];
        if (shape === "reordered") return chunks.reverse();
        if (shape === "duplicate") return chunks.map(() => chunks[0]!);
        return [chunks[0]!, { ...chunks[1]!, id: "unknown-chunk" }];
      });

      await expect(p.f.runner.execute(p.input)).rejects.toMatchObject({
        code: "MODEL_SOURCE_UNAVAILABLE",
      });
      expect(p.f.start).not.toHaveBeenCalled();
      expect(p.workspace.readPrDiffChunk).not.toHaveBeenCalled();
      expect(p.readPrDiffChunks).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { name: "path", change: { path: "src/other.ts" } },
    { name: "kind", change: { kind: "head" } },
    { name: "ordinal", change: { ordinal: 99 } },
    { name: "encoding", change: { encoding: "base64" } },
    { name: "content digest", change: { contentDigest: "0".repeat(64) } },
    { name: "byte length", change: { byteLength: 1 } },
    { name: "content", change: { content: "Tampered content." } },
    { name: "serialized byte limit", change: { padding: "x".repeat(65_536) } },
  ] as const)(
    "rejects an invalid later batch chunk $name without accepting its valid prefix",
    async ({ change }) => {
      const p = prChunkFixture();
      p.readPrDiffChunks.mockImplementation(async (ids) =>
        ids.map((id, index) => (index === 0 ? p.readChunk(id) : { ...p.readChunk(id), ...change })),
      );

      await expect(p.f.runner.execute(p.input)).rejects.toMatchObject({
        code: "MODEL_SOURCE_UNAVAILABLE",
      });
      expect(p.f.start).not.toHaveBeenCalled();
      expect(p.workspace.readPrDiffChunk).not.toHaveBeenCalled();
    },
  );

  it("reads a fresh complete batch and rechecks source binding for each model round", async () => {
    const p = prChunkFixture();

    await p.f.runner.execute(p.input);
    await p.f.runner.execute(p.input);

    expect(p.readPrDiffChunks.mock.calls).toEqual([
      [p.descriptors.map((chunk) => chunk.id)],
      [p.descriptors.map((chunk) => chunk.id)],
    ]);
    expect(p.workspace.assertSourceBinding).toHaveBeenCalledTimes(4);
    expect(p.workspace.readPrDiffChunk).not.toHaveBeenCalled();
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
    expect(f.start.mock.calls[0]![0].arguments).not.toContain("features.shell_tool=false");
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

  it("rejects model-authored claims of authoritative model identity", async () => {
    const base = fixture();
    const f = fixture({
      outputText: JSON.stringify({
        ...roundDelta(base.round),
        modelIdentity: { engine: "codex", model: "forged-model" },
      }),
    });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(f.io.removeDirectory).toHaveBeenCalledOnce();
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

  it("accepts native source-reading tool events with a structured final response", async () => {
    const f = fixture({
      stdout: jsonl(
        {
          type: "item.completed",
          item: { type: "command_execution", command: "rg CleanupTempDir" },
        },
        codexComplete,
      ),
    });
    await expect(f.runner.execute(f.input)).resolves.toMatchObject({ usage: { tokens: 50 } });
  });

  it.each(["codex", "copilot"] as const)(
    "preserves the isolated passive proposal boundary for %s",
    async (engine) => {
      const f = fixture({
        engine,
        stdout:
          engine === "codex"
            ? jsonl(
                {
                  type: "item.completed",
                  item: { type: "command_execution", command: "rg source" },
                },
                codexComplete,
              )
            : jsonl(
                { type: "tool.execution_start", data: {} },
                copilotFinal("{}"),
                copilotComplete,
              ),
      });
      const prepared = await makePrompt(f.input, f.io, 128 * 1024, 1024 * 1024);
      const runner = createStaticModelJsonRunner(f.options);
      await expect(
        runner.execute({
          toolPolicy: "passive_proposal",
          workspace: f.input.workspace,
          signal: f.input.signal,
          prompt: prepared.prompt,
          schema: InvestigationModelTurnDeltaV1Schema,
          hardTimeoutMs: 30_000,
          maximumResultBytes: 1024 * 1024,
        }),
      ).rejects.toMatchObject({ code: "MODEL_TOOL_POLICY_VIOLATION" });
      const argumentsList = f.start.mock.calls[0]![0].arguments;
      if (engine === "codex") {
        expect(argumentsList).toContain("features.shell_tool=false");
        expect(argumentsList).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      } else {
        expect(argumentsList).toContain("--available-tools=view,glob,grep");
        expect(argumentsList).not.toContain("--allow-all");
      }
    },
  );

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
    const onUsage = vi.fn();
    f.start.mockImplementation(async (_spec, _signal, onDispatch) => {
      onDispatch?.();
      throw new Error("The native start acknowledgement was lost.");
    });
    await expect(f.runner.execute({ ...f.input, onUsage })).rejects.toMatchObject({
      code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
    });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ tokens: null, source: "unavailable" });
    expect(f.io.removeDirectory).not.toHaveBeenCalled();
    expect(f.directories.has(f.roundDirectory)).toBe(true);
  });

  it("does not invent usage when a launch adapter rejects before dispatch", async () => {
    const f = fixture();
    const onUsage = vi.fn();
    f.start.mockRejectedValue(new ProcessHostProtocolError("The launch specification is invalid."));
    await expect(f.runner.execute({ ...f.input, onUsage })).rejects.toBeInstanceOf(Error);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("retains Copilot sidecar usage before a malformed final response after tool execution", async () => {
    const f = fixture({
      engine: "copilot",
      stdout: jsonl(
        { type: "tool.execution_start", data: { toolName: "unmanaged" } },
        copilotFinal("Rejected model output."),
        { ...copilotComplete, usage: undefined },
      ),
      usageFile: { modelMetrics: { primary: { usage: { inputTokens: 23, outputTokens: 7 } } } },
    });
    const onUsage = vi.fn();
    await expect(f.runner.execute({ ...f.input, onUsage })).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
    expect(onUsage).toHaveBeenLastCalledWith({ tokens: 30, source: "cli" });
  });

  it("does not use an earlier Copilot result or sidecar as complete usage for an unfinished later turn", async () => {
    const f = fixture({
      engine: "copilot",
      stdout: jsonl(copilotFinal("Earlier output."), copilotComplete, {
        type: "assistant.turn_start",
        data: {},
      }),
      usageFile: { modelMetrics: { primary: { usage: { inputTokens: 23, outputTokens: 7 } } } },
    });
    const onUsage = vi.fn();
    await expect(f.runner.execute({ ...f.input, onUsage })).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ tokens: null, source: "unavailable" });
  });

  it.each(["invalid JSON", "invalid schema", "binding mismatch", "nonzero exit"])(
    "retains complete CLI usage when output fails with %s",
    async (mode) => {
      const f = fixture({
        ...(mode === "invalid JSON" ? { outputText: "not-json" } : {}),
        ...(mode === "invalid schema" ? { outputText: "{}" } : {}),
        ...(mode === "nonzero exit" ? { exit: { exitCode: 9 } } : {}),
      });
      if (mode === "binding mismatch") f.round.attemptId = "wrong-attempt";
      const onUsage = vi.fn();
      await expect(f.runner.execute({ ...f.input, onUsage })).rejects.toBeInstanceOf(Error);
      expect(onUsage).toHaveBeenNthCalledWith(1, { tokens: null, source: "unavailable" });
      expect(onUsage).toHaveBeenLastCalledWith({ tokens: 50, source: "cli" });
      expect(f.io.removeDirectory).toHaveBeenCalledOnce();
    },
  );

  it("does not infer complete usage from a completed marker followed by an unfinished turn", async () => {
    const f = fixture({ stdout: jsonl(codexComplete, { type: "turn.started" }) });
    const onUsage = vi.fn();
    await expect(f.runner.execute({ ...f.input, onUsage })).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ tokens: null, source: "unavailable" });
  });

  it.each(["PROCESS_HARD_TIMEOUT", "STANDARD_INPUT_WRITE_FAILED", "OUTPUT_READ_FAILED"])(
    "keeps usage unknown after %s because completion failure can conceal lost output",
    async (code) => {
      const f = fixture();
      const onUsage = vi.fn();
      f.start.mockImplementation(async () => ({
        requestId: f.exit.requestId,
        processId: 17,
        exited: Promise.resolve({ ...f.exit, exitCode: 1 }),
        completed: Promise.reject(new ProcessHostRequestError(code, "Synthetic process failure.")),
        stdout: Readable.from(jsonl(codexComplete)),
        stderr: Readable.from([]),
        terminate: f.terminate,
      }));
      await expect(f.runner.execute({ ...f.input, onUsage })).rejects.toMatchObject({
        code: "MODEL_PROCESS_FAILED",
      });
      expect(onUsage).toHaveBeenLastCalledWith({ tokens: null, source: "unavailable" });
      expect(f.io.removeDirectory).toHaveBeenCalledOnce();
    },
  );

  it.each(["PROCESS_HARD_TIMEOUT", "OUTPUT_READ_FAILED", "STANDARD_INPUT_WRITE_FAILED"])(
    "confirms cleanup after %s only from the actual exit and both drained streams",
    async (code) => {
      const onProcessDiagnostic = vi.fn();
      const f = fixture({ options: { onProcessDiagnostic, protectedValues: ["private-output"] } });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const started = Promise.withResolvers<void>();
      f.start.mockImplementation(async () => {
        started.resolve();
        return {
          requestId: f.exit.requestId,
          processId: 17,
          exited: Promise.resolve({ ...f.exit, exitCode: 1 }),
          completed: Promise.reject(new ProcessHostRequestError(code, "private-output")),
          stdout,
          stderr,
          terminate: f.terminate,
        };
      });
      const execution = f.runner.execute(f.input);
      await started.promise;
      expect(f.io.removeDirectory).not.toHaveBeenCalled();
      stdout.end("private-output");
      expect(f.io.removeDirectory).not.toHaveBeenCalled();
      stderr.end("private-output");
      await expect(execution).rejects.toMatchObject({ code: "MODEL_PROCESS_FAILED" });
      expect(f.io.removeDirectory).toHaveBeenCalledOnce();
      expect(onProcessDiagnostic).toHaveBeenLastCalledWith({
        stage: "settled",
        requestId: f.exit.requestId,
        processId: 17,
        exitCode: 1,
        outputTruncated: false,
        stdoutBytes: 14,
        stderrBytes: 14,
        cleanupConfirmed: true,
        completionFailure: code,
      });
      expect(JSON.stringify(onProcessDiagnostic.mock.calls)).not.toContain("private-output");
    },
  );

  it("retains workspace and reports a bounded native failure code when no actual exit was observed", async () => {
    const onProcessDiagnostic = vi.fn();
    const f = fixture({ options: { onProcessDiagnostic } });
    f.start.mockImplementation(async () => {
      const error = new ProcessHostProtocolError("A private diagnostic must not be logged.", {
        cause: new ProcessHostRequestError("PROCESS_TERMINATION_FAILED", "private native output"),
      });
      return {
        requestId: f.exit.requestId,
        processId: 17,
        exited: Promise.reject(error),
        completed: Promise.reject(error),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        terminate: f.terminate,
      };
    });
    await expect(f.runner.execute(f.input)).rejects.toMatchObject({
      code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
    });
    expect(f.io.removeDirectory).not.toHaveBeenCalled();
    expect(onProcessDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cleanupConfirmed: false,
        exitFailure: "PROCESS_TERMINATION_FAILED",
        completionFailure: "PROCESS_TERMINATION_FAILED",
      }),
    );
    expect(JSON.stringify(onProcessDiagnostic.mock.calls)).not.toContain("private");
  });

  it.each(["throw", "reject"])("ignores a diagnostic observer that fails with %s", async (mode) => {
    const f = fixture({
      options: {
        onProcessDiagnostic: () => {
          if (mode === "throw") throw new Error("Observer failed.");
          return Promise.reject(new Error("Asynchronous observer failed."));
        },
      },
    });
    await expect(f.runner.execute(f.input)).resolves.toHaveProperty("round");
    expect(f.io.removeDirectory).toHaveBeenCalledOnce();
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

  it.each([false, true])(
    "retains reported usage while confirming cancellation cleanup: %s",
    async (usageReported) => {
      const f = fixture();
      const onUsage = vi.fn();
      const stdout = new PassThrough(),
        stderr = new PassThrough();
      const completion = Promise.withResolvers<ProcessExitedEvent>();
      const started = Promise.withResolvers<void>();
      f.terminate.mockImplementation(async () => {
        expect(f.io.removeDirectory).not.toHaveBeenCalled();
        stdout.end(usageReported ? jsonl(codexComplete).join("") : undefined);
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
      const execution = f.runner.execute({ ...f.input, onUsage });
      await started.promise;
      const reason = new Error("Fixture lease was cancelled.");
      f.controller.abort(reason);
      await expect(execution).rejects.toBe(reason);
      expect(f.terminate).toHaveBeenCalledWith("cancelled");
      expect(f.io.removeDirectory).toHaveBeenCalledOnce();
      expect(onUsage).toHaveBeenLastCalledWith(
        usageReported ? { tokens: 50, source: "cli" } : { tokens: null, source: "unavailable" },
      );
    },
  );

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

  it("keeps concrete selected source reads for a historical brokered checkpoint", async () => {
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
    const checkpoint = createInvestigationCheckpoint({
      task,
      attemptId: f.input.attempt.id,
      checkpointId: "historical-brokered-checkpoint",
      leaseVersion: f.input.attempt.leaseVersion,
      recordedAt: task.updatedAt,
    });
    delete checkpoint.runtime.reviewMode;
    const { digest: _digest, ...checkpointContent } = checkpoint;
    checkpoint.digest = investigationContentDigest(checkpointContent);
    await f.runner.execute({ ...f.input, task, workspace, checkpoint });
    expect(workspace.resolveSourcePath).toHaveBeenCalledExactlyOnceWith(path);
    expect(f.start.mock.calls[0]![0].standardInput).toContain(content.trim());
    expect(workspace.assertSourceBinding).toHaveBeenCalledTimes(2);
  });
});

describe("managed model invocation usage integration", () => {
  it("durably registers before process dispatch and records provider subdivisions once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-model-usage-"));
    try {
      const receipts: InvestigationModelInvocationReceipt[] = [];
      const f = fixture();
      const usageLease = {
        attemptId: f.input.attempt.id,
        fence: f.input.attempt.leaseVersion,
        leaseToken: "retained-runner-lease",
      };
      const journal = new InvestigationModelUsageJournal({
        directory,
        createInvocationId: () => "call-integration",
        deliver: async (receipt, retainedLease) => {
          expect(retainedLease).toEqual(usageLease);
          expect(JSON.stringify(receipt)).not.toContain(usageLease.leaseToken);
          receipts.push(receipt);
        },
      });
      const originalStart = f.options.processHost.start;
      const nativeOwnership = {
        capability: "named-job-tree-v1" as const,
        instanceKey: "a".repeat(64),
        generation: "b".repeat(64),
        previousTreeDrained: true as const,
      };
      const runner = createModelTurnRunner({
        ...f.options,
        usageJournal: journal,
        processHost: {
          recovery: () => nativeOwnership,
          start: async (...args) => {
            expect(receipts.map((receipt) => receipt.state)).toEqual(["registered", "running"]);
            const deliveryPath = join(
              directory,
              `${Buffer.from("call-integration").toString("hex")}.delivery.json`,
            );
            expect(JSON.parse(await readFile(deliveryPath, "utf8"))).toEqual({
              lease: usageLease,
              nativeOwnership,
            });
            return originalStart(...args);
          },
        },
      });
      const result = await runner.execute({ ...f.input, usageLease });
      expect(result.usage).toMatchObject({
        invocationId: "call-integration",
        tokens: 50,
        details: { inputTokens: 31, cachedReadTokens: 7, outputTokens: 19, totalTokens: 50 },
      });
      expect(receipts.at(-1)).toMatchObject({
        state: "completed",
        disposition: "pending",
        completeness: "complete",
        usage: { totalTokens: 50 },
      });
      await runner.markUsageDisposition?.("call-integration", "accepted");
      expect(receipts.at(-1)).toMatchObject({
        disposition: "accepted",
        usage: { totalTokens: 50 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains known costs even when the final model output is rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-model-usage-"));
    try {
      const receipts: InvestigationModelInvocationReceipt[] = [];
      const journal = new InvestigationModelUsageJournal({
        directory,
        createInvocationId: () => "call-invalid",
        deliver: async (receipt) => {
          receipts.push(receipt);
        },
      });
      const f = fixture({
        outputText: "invalid structured output",
        options: { usageJournal: journal },
      });
      await expect(f.runner.execute(f.input)).rejects.toMatchObject({
        code: "MODEL_OUTPUT_INVALID",
      });
      expect(receipts.at(-1)).toMatchObject({
        state: "failed",
        disposition: "rejected",
        usage: { totalTokens: 50, cachedReadTokens: 7 },
      });
      expect(f.io.removeDirectory).toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("model usage survives transport and accounting failures", () => {
  it("retains a partial token receipt when stdout fails after a complete usage event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-model-usage-"));
    try {
      const receipts: InvestigationModelInvocationReceipt[] = [];
      const journal = new InvestigationModelUsageJournal({
        directory,
        createInvocationId: () => "call-stream-error",
        deliver: async (receipt) => {
          receipts.push(receipt);
        },
      });
      const f = fixture();
      const originalStart = f.options.processHost.start;
      const runner = createModelTurnRunner({
        ...f.options,
        usageJournal: journal,
        processHost: {
          start: async (...args) => {
            const managed = await originalStart(...args);
            return {
              ...managed,
              stdout: Readable.from(
                (async function* () {
                  yield JSON.stringify(codexComplete) + "\n";
                  throw new Error("Synthetic stdout read failure.");
                })(),
              ),
            };
          },
        },
      });
      await expect(runner.execute(f.input)).rejects.toMatchObject({
        code: "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
      });
      expect(receipts.at(-1)).toMatchObject({
        state: "failed",
        disposition: "rejected",
        completeness: "partial",
        usage: { totalTokens: 50, cachedReadTokens: 7 },
      });
      expect(f.io.removeDirectory).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the process cleanup fault visible when its usage delivery also fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-model-usage-"));
    try {
      const journal = new InvestigationModelUsageJournal({
        directory,
        createInvocationId: () => "call-multiple-errors",
        deliver: async (receipt) => {
          if (receipt.revision >= 3) throw new Error("Synthetic accounting delivery failure.");
        },
      });
      const f = fixture();
      const originalStart = f.options.processHost.start;
      const runner = createModelTurnRunner({
        ...f.options,
        usageJournal: journal,
        processHost: {
          start: async (...args) => {
            const managed = await originalStart(...args);
            return {
              ...managed,
              stdout: Readable.from(
                (async function* () {
                  yield JSON.stringify(codexComplete) + "\n";
                  throw new Error("Synthetic stdout read failure.");
                })(),
              ),
            };
          },
        },
      });
      let failure: unknown;
      try {
        await runner.execute(f.input);
      } catch (error) {
        failure = error;
      }
      const errors: unknown[] = [failure];
      for (let index = 0; index < errors.length; index++) {
        const error = errors[index];
        if (error instanceof AggregateError) errors.push(...error.errors);
      }
      expect(
        errors.some(
          (error) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
        ),
      ).toBe(true);
      expect(f.io.removeDirectory).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("bounded usage prefix retention", () => {
  it("keeps complete usage events before an oversized output chunk crosses the cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-model-usage-"));
    try {
      const receipts: InvestigationModelInvocationReceipt[] = [];
      const journal = new InvestigationModelUsageJournal({
        directory,
        createInvocationId: () => "call-output-cap",
        deliver: async (receipt) => {
          receipts.push(receipt);
        },
      });
      const f = fixture({ stdout: [JSON.stringify(codexComplete) + "\n" + "x".repeat(8192)] });
      const runner = createModelTurnRunner({
        ...f.options,
        usageJournal: journal,
        limits: { ...f.options.limits, maximumOutputBytes: 4096 },
      });
      await expect(runner.execute(f.input)).rejects.toMatchObject({
        code: "MODEL_OUTPUT_LIMIT_EXCEEDED",
      });
      expect(receipts.at(-1)).toMatchObject({
        state: "failed",
        completeness: "partial",
        usage: { totalTokens: 50 },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
