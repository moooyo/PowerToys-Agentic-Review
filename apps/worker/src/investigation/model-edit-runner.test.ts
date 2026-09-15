import { createHash } from "node:crypto";
import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationModelEditsV1,
  InvestigationModelEditsV1Schema,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { describe, expect, it, vi } from "vitest";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import { createModelEditAdapter, type ModelEditRunnerOptions } from "./model-edit-runner.js";
import type { StaticModelJsonInput } from "./model-turn-runner.js";
import type { InvestigationModelEditAdapter } from "./plan-executor.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

const hash = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

function fixture(
  options: { proposal?: unknown; tokens?: number | null; maximumInputBytes?: number } = {},
) {
  const synthetic = createInvestigationFixture("feature");
  const saved = synthetic.result.plans[0]!;
  const {
    digest: _digest,
    state: _state,
    sourceReportRef: _sourceReportRef,
    ...planContent
  } = saved;
  const plan = { ...saved, digest: investigationContentDigest(planContent) };
  const task = {
    ...synthetic.task,
    kind: "feature-implement" as const,
    planRef: { id: plan.id, version: plan.version, digest: plan.digest },
    executionPolicy: {
      ...synthetic.task.executionPolicy,
      mode: "execute" as const,
      allowRepositoryExecution: true,
      authorizationRef: "saved-edit-authorization",
    },
  };
  const original = "export const selectedOnly = false;\n";
  const files = new Map<string, string | null>([
    ["src/feature.ts", original],
    ["src/new.ts", null],
  ]);
  const proposal: InvestigationModelEditsV1 = {
    schemaVersion: "InvestigationModelEditsV1",
    summary: "Proposed selected-only export behavior.",
    edits: [
      {
        path: "src/feature.ts",
        expectedDigest: hash(original),
        content: "export const selectedOnly = true;\n",
      },
    ],
  };
  const processHost: ProcessHostClient = { start: vi.fn(), close: vi.fn(), terminateAll: vi.fn() };
  const workspace: PreparedInvestigationWorkspace = {
    attemptDirectory: "C:\\Worker\\attempt",
    modelInputDirectory: "C:\\Worker\\attempt\\model-input",
    modelInputPath: "C:\\Worker\\attempt\\model-input\\snapshot.json",
    modelInputDigest: "a".repeat(64),
    controlDirectory: "C:\\Worker\\attempt\\control",
    tempDirectory: "C:\\Worker\\attempt\\temp",
    sourceDirectory: "C:\\Worker\\attempt\\source",
    sourceBinding: {
      subjectRef: task.subjectRef,
      revisionKey: task.subjects[0]!.revisionKey,
      sourceSha: "b".repeat(40),
      patchDigest: null,
      artifactRef: null,
    },
    writeArtifact: vi.fn(),
    readArtifact: vi.fn(),
    writePatchArtifact: vi.fn(),
    resolveSourcePath: vi.fn(),
    readPrDiffManifest: vi.fn(),
    readPrDiffChunk: vi.fn(),
    applyEdits: vi.fn(),
    capturePatch: vi.fn(),
    cleanup: vi.fn(),
    assertIntegrity: vi.fn(async () => undefined),
    assertSourceBinding: vi.fn(async () => undefined),
    readSourceFile: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error("Fixture read outside the declared file set.");
      const content = files.get(path) ?? null;
      return { path, content, digest: content === null ? null : hash(content) };
    }),
  };
  const tokens = options.tokens === undefined ? 50 : options.tokens;
  const execute = vi.fn(async (_input: StaticModelJsonInput) => ({
    value: options.proposal ?? proposal,
    usage: { tokens, source: tokens === null ? ("unavailable" as const) : ("cli" as const) },
  }));
  const runnerOptions: ModelEditRunnerOptions = {
    engine: "codex",
    cliExecutablePath: "C:\\Trusted\\codex.exe",
    processHost,
    environment: {
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".EXE",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: "C:\\Users\\ModelAccount",
    },
    limits: {
      hardTimeoutMs: 60_000,
      maximumProcessCount: 8,
      maximumMemoryBytes: 1024 * 1024 * 1024,
      maximumOutputBytes: 8 * 1024 * 1024,
    },
    staticConfiguration: { verified: true, disabledMcpServers: [] },
    structuredRunner: { execute },
    ...(options.maximumInputBytes === undefined
      ? {}
      : { maximumInputBytes: options.maximumInputBytes }),
  };
  const controller = new AbortController();
  const input: Parameters<InvestigationModelEditAdapter["execute"]>[0] = {
    task,
    attempt: synthetic.attempt,
    plan,
    stepId: plan.steps[0]!.id,
    description: plan.steps[0]!.description,
    expectedObservation: plan.steps[0]!.expectedObservation,
    allowedPaths: ["src/feature.ts", "src/new.ts"],
    workspace,
  };
  const context = { signal: controller.signal, processHost, onProgress: vi.fn() };
  return {
    adapter: createModelEditAdapter(runnerOptions),
    input,
    context,
    runnerOptions,
    execute,
    proposal,
    original,
    files,
    controller,
  };
}

describe("saved model edit adapter", () => {
  it("uses the strict edit schema and returns passive edits with observed usage", async () => {
    const f = fixture();
    const result = await f.adapter.execute(f.input, f.context);
    expect(result).toEqual({ proposal: f.proposal, usage: { tokens: 50, source: "cli" } });
    expect(f.input.workspace.readSourceFile).toHaveBeenCalledTimes(2);
    expect(f.input.workspace.applyEdits).not.toHaveBeenCalled();
    expect(f.input.workspace.capturePatch).not.toHaveBeenCalled();
    expect(f.context.processHost.start).not.toHaveBeenCalled();
    const request = f.execute.mock.calls[0]![0];
    expect(request.schema).toBe(InvestigationModelEditsV1Schema);
    expect(request.signal).toBe(f.context.signal);
    expect(request.prompt).toContain(JSON.stringify(f.original).slice(1, -1));
    expect(request.prompt).toContain(hash(f.original));
    expect(request.prompt).toContain("Do not invoke tools");
    expect(request.prompt).toContain("commit, push");
    expect(f.input.workspace.assertSourceBinding).toHaveBeenCalledTimes(2);
  });

  it("passes missing usage through as unavailable for the trusted executor budget gate", async () => {
    const f = fixture({ tokens: null });
    expect((await f.adapter.execute(f.input, f.context)).usage).toEqual({
      tokens: null,
      source: "unavailable",
    });
  });

  it.each([
    "pr-review",
    "issue-investigate",
    "pr-verify",
    "issue-verify",
    "reproduction-setup",
  ] as const)("does not allow the %s task to request edits", async (kind) => {
    const f = fixture();
    await expect(
      f.adapter.execute({ ...f.input, task: { ...f.input.task, kind } }, f.context),
    ).rejects.toMatchObject({ code: "MODEL_EDIT_NOT_AUTHORIZED" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.input.workspace.readSourceFile).not.toHaveBeenCalled();
  });

  it("requires an explicit execution authorization reference", async () => {
    const f = fixture();
    const task = {
      ...f.input.task,
      executionPolicy: { ...f.input.task.executionPolicy, authorizationRef: null },
    };
    await expect(f.adapter.execute({ ...f.input, task }, f.context)).rejects.toMatchObject({
      code: "MODEL_EDIT_NOT_AUTHORIZED",
    });
  });

  it.each(["issue-fix", "feature-implement"] as const)(
    "accepts the explicit immutable source binding of an Issue plan for %s",
    async (kind) => {
      const f = fixture();
      const { digest: _digest, state: _state, sourceReportRef: _source, ...content } = f.input.plan;
      const planContent = {
        ...content,
        kind: kind === "issue-fix" ? ("fix" as const) : ("implementation" as const),
      };
      const plan = {
        ...f.input.plan,
        ...planContent,
        digest: investigationContentDigest(planContent),
      };
      const source = {
        id: "explicit-source",
        kind: "source_commit" as const,
        repositoryId: f.input.task.repository.id,
        workItemId: f.input.task.workItem.id,
        revisionKey: "e".repeat(64),
        commitSha: "f".repeat(40),
      };
      const task = {
        ...f.input.task,
        kind,
        subjectRef: source.id,
        subjects: [...f.input.task.subjects, source],
        planRef: { id: plan.id, version: plan.version, digest: plan.digest },
        parentReportRef: { ...plan.sourceReportRef, digest: "c".repeat(64) },
        executionPolicy: { ...f.input.task.executionPolicy, allowedSubjectRefs: [source.id] },
      };
      const workspace = {
        ...f.input.workspace,
        sourceBinding: {
          subjectRef: source.id,
          revisionKey: source.revisionKey,
          sourceSha: source.commitSha,
          patchDigest: null,
          artifactRef: null,
        },
      };
      const input = { ...f.input, task, plan, workspace };
      expect((await f.adapter.execute(input, f.context)).proposal).toEqual(f.proposal);
      expect(f.execute.mock.calls[0]![0].prompt).toContain(source.commitSha);
      await expect(
        f.adapter.execute(
          {
            ...input,
            task: { ...task, parentReportRef: { ...task.parentReportRef, id: "unrelated-report" } },
          },
          f.context,
        ),
      ).rejects.toMatchObject({ code: "MODEL_EDIT_NOT_AUTHORIZED" });
    },
  );

  it("requires the exact saved step and canonical plan digest", async () => {
    const f = fixture();
    await expect(
      f.adapter.execute(
        { ...f.input, description: "An unsaved replacement instruction." },
        f.context,
      ),
    ).rejects.toMatchObject({ code: "MODEL_EDIT_NOT_AUTHORIZED" });
    await expect(
      f.adapter.execute(
        { ...f.input, plan: { ...f.input.plan, title: "Tampered plan title" } },
        f.context,
      ),
    ).rejects.toMatchObject({ code: "MODEL_EDIT_NOT_AUTHORIZED" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects an unverified static CLI configuration before reading source", async () => {
    const f = fixture();
    const adapter = createModelEditAdapter({
      ...f.runnerOptions,
      staticConfiguration: { verified: false, disabledMcpServers: [] },
    });
    await expect(adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "MODEL_POLICY_UNAVAILABLE",
    });
    expect(f.input.workspace.readSourceFile).not.toHaveBeenCalled();
  });

  it.each(["../outside.ts", "src/*.ts", "C:\\outside.ts", ".git/config", "src/../outside.ts"])(
    "rejects unsafe allowed path %s",
    async (path) => {
      const f = fixture();
      await expect(
        f.adapter.execute({ ...f.input, allowedPaths: [path] }, f.context),
      ).rejects.toMatchObject({ code: "MODEL_EDIT_PATH_INVALID" });
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects case-insensitive duplicate allowed paths", async () => {
    const f = fixture();
    await expect(
      f.adapter.execute(
        { ...f.input, allowedPaths: ["src/feature.ts", "SRC\\FEATURE.ts"] },
        f.context,
      ),
    ).rejects.toMatchObject({ code: "MODEL_EDIT_PATH_INVALID" });
  });

  it("rejects a proposal outside the saved path allowlist", async () => {
    const f = fixture();
    f.proposal.edits[0]!.path = "src/other.ts";
    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "MODEL_EDIT_PATH_INVALID",
    });
    expect(f.input.workspace.applyEdits).not.toHaveBeenCalled();
  });

  it("rejects duplicate output paths across Windows aliases", async () => {
    const f = fixture();
    f.proposal.edits.push({ ...f.proposal.edits[0]!, path: "SRC\\FEATURE.ts" });
    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "MODEL_EDIT_PATH_INVALID",
    });
  });

  it("rejects a model-supplied digest that differs from the original file", async () => {
    const f = fixture();
    f.proposal.edits[0]!.expectedDigest = "0".repeat(64);
    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "MODEL_EDIT_INPUT_CHANGED",
    });
  });

  it("supports explicit creation and deletion without performing either operation", async () => {
    const f = fixture();
    f.proposal.edits = [
      { path: "src/new.ts", expectedDigest: null, content: "export const created = true;\n" },
      { path: "src/feature.ts", expectedDigest: hash(f.original), content: null },
    ];
    expect((await f.adapter.execute(f.input, f.context)).proposal.edits).toEqual(f.proposal.edits);
    expect(f.files.get("src/new.ts")).toBeNull();
    expect(f.files.get("src/feature.ts")).toBe(f.original);
  });

  it("does not truncate oversized allowed file input", async () => {
    const f = fixture({ maximumInputBytes: 64 });
    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "MODEL_INPUT_LIMIT_EXCEEDED",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("stops reading further allowed files as soon as the cumulative input budget is exhausted", async () => {
    const f = fixture({ maximumInputBytes: 128 });
    f.files.set("src/feature.ts", "x".repeat(256));
    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "MODEL_INPUT_LIMIT_EXCEEDED",
    });
    expect(f.input.workspace.readSourceFile).toHaveBeenCalledExactlyOnceWith("src/feature.ts");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects analysis output in place of an edit proposal", async () => {
    const f = fixture({ proposal: { schemaVersion: "InvestigationLoopRoundV1", edits: [] } });
    await expect(f.adapter.execute(f.input, f.context)).rejects.toMatchObject({
      code: "MODEL_EDIT_OUTPUT_INVALID",
    });
  });

  it("does not dispatch a cancelled edit step", async () => {
    const f = fixture();
    const reason = new Error("The saved step was cancelled.");
    f.controller.abort(reason);
    await expect(f.adapter.execute(f.input, f.context)).rejects.toBe(reason);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.input.workspace.readSourceFile).not.toHaveBeenCalled();
  });
});
