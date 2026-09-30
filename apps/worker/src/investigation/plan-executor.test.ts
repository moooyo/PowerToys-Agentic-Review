import { createHash } from "node:crypto";
import { createCanonicalResult } from "@agentic-review/codex";
import {
  createInvestigationPreview as createInvestigationFixture,
  type InvestigationArtifactV1,
  type InvestigationEvidenceV1,
  type InvestigationPlanExecutionBinding,
  type InvestigationRecipeStep,
  type InvestigationValidation,
  investigationCanonicalJson,
  investigationPlanDigestPayload,
} from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ManagedProcessRunError,
  type ManagedProcessRunner,
} from "../execution/managed-process-runner.js";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import { ModelBudgetExceededError } from "./model-budget.js";
import {
  digestInvestigationExecutableStep,
  type InvestigationModelEditAdapter,
  type InvestigationPlanExecutorContext,
  type InvestigationPlanExecutorInput,
  type InvestigationPlanStepCompleted,
  type InvestigationPlanStepStarted,
  ProductionInvestigationPlanExecutor,
} from "./plan-executor.js";
import type {
  InvestigationRecipeObservation,
  InvestigationRecipePlanAdapter,
} from "./recipe-plan-adapter.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

const limits = {
  hardTimeoutMs: 10_000,
  maximumProcessCount: 4,
  maximumMemoryBytes: 134_217_728,
  maximumOutputBytes: 65_536,
};

function fixture() {
  const initial = createInvestigationFixture("pr", { findingCount: 0 });
  const task = structuredClone(initial.task);
  const attempt = structuredClone(initial.attempt);
  const plan = structuredClone(initial.result.plans[0]!);
  plan.digest = createHash("sha256")
    .update(investigationCanonicalJson(investigationPlanDigestPayload(plan)))
    .digest("hex");
  task.kind = "pr-verify";
  task.parentTaskId = "parent-task";
  task.parentReportRef = { ...plan.sourceReportRef, digest: "3".repeat(64) };
  task.planRef = { id: plan.id, version: plan.version, digest: plan.digest };
  task.executionPolicy = {
    mode: "execute",
    allowRepositoryExecution: true,
    allowedSubjectRefs: [task.subjectRef],
    authorizationRef: "authorization-1",
  };
  let sequence = 0;
  const records = new Map<string, Uint8Array>();
  const artifact = (
    subjectRef: string,
    kind: InvestigationArtifactV1["kind"],
    bytes: Uint8Array,
  ): InvestigationArtifactV1 => {
    const id = `artifact-${++sequence}`;
    records.set(id, bytes);
    return {
      id,
      taskId: task.id,
      attemptId: attempt.id,
      subjectRef,
      kind,
      name: id,
      mediaType: "application/json",
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      availability: "available",
    };
  };
  const workspace: PreparedInvestigationWorkspace = {
    attemptDirectory: "C:\\Worker\\attempt",
    modelInputDirectory: "C:\\Worker\\attempt\\input",
    modelInputPath: "C:\\Worker\\attempt\\input\\snapshot.json",
    modelInputDigest: "1".repeat(64),
    controlDirectory: "C:\\Worker\\attempt\\control",
    tempDirectory: "C:\\Worker\\attempt\\temp",
    sourceDirectory: "C:\\Worker\\attempt\\source",
    sourceBinding: {
      subjectRef: task.subjectRef,
      revisionKey: task.subjects[0]!.revisionKey,
      sourceSha: "b".repeat(40),
      patchDigest: null,
      artifactRef: "source-1",
    },
    assertIntegrity: vi.fn(async () => undefined),
    assertSourceBinding: vi.fn(async () => undefined),
    resolveSourcePath: vi.fn(
      async (relativePath) => `C:\\Worker\\attempt\\source\\${relativePath}`,
    ),
    writeArtifact: vi.fn(async (input) => artifact(input.subjectRef, input.kind, input.bytes)),
    writePatchArtifact: vi.fn(async (input) => artifact(input.subjectRef, "patch", input.bytes)),
    readArtifact: vi.fn(async (id) => records.get(id)!),
    readSourceFile: vi.fn(async (path) => ({
      path,
      content: "old",
      digest: createHash("sha256").update("old").digest("hex"),
    })),
    readPrDiffManifest: vi.fn(async () => {
      throw new Error("The plan fixture does not request PR diff input.");
    }),
    readPrDiffChunk: vi.fn(async () => {
      throw new Error("The plan fixture does not request PR diff input.");
    }),
    applyEdits: vi.fn(async () => undefined),
    capturePatch: vi.fn(async () => ({
      baseSha: "b".repeat(40),
      bytes: Buffer.from("diff --git a/a b/a\n"),
    })),
    cleanup: vi.fn(async () => undefined),
  };
  const operation = {
    kind: "command" as const,
    executableId: "test-tool",
    arguments: ["--fixture"],
    workingDirectory: ".",
    expectedExitCode: 0,
  };
  const stepId = plan.steps[0]!.id;
  const execution: InvestigationPlanExecutionBinding = {
    planRef: task.planRef,
    subjectRef: task.subjectRef,
    subjectRevisionKey: task.subjects[0]!.revisionKey,
    executionPolicyDigest: createCanonicalResult(task.executionPolicy).sha256,
    authorizationRef: "authorization-1",
    satisfiedPrerequisiteRefs: plan.prerequisites.map((entry) => entry.id),
    steps: [
      { stepId, operation, digest: digestInvestigationExecutableStep({ stepId, operation }) },
    ],
  };
  const processHost: ProcessHostClient = {
    start: vi.fn(async () => {
      throw new Error("The mocked runner must not launch a process.");
    }),
    terminateAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const started: InvestigationPlanStepStarted[] = [];
  const completed: InvestigationPlanStepCompleted[] = [];
  const context: InvestigationPlanExecutorContext = {
    processHost,
    signal: new AbortController().signal,
    onStepStarted: vi.fn(async (event) => {
      started.push(event);
    }),
    onStepCompleted: vi.fn(async (event) => {
      completed.push(event);
    }),
  };
  const run = vi.fn<ManagedProcessRunner["run"]>(async () => ({
    exitCode: 0,
    stdout: "observed",
    stderr: "",
  }));
  const edit = vi.fn<InvestigationModelEditAdapter["execute"]>(async () => ({
    proposal: {
      schemaVersion: "InvestigationModelEditsV1",
      summary: "Update the saved source file.",
      edits: [
        {
          path: "src/file.ts",
          expectedDigest: createHash("sha256").update("old").digest("hex"),
          content: "new",
        },
      ],
    },
    usage: { tokens: 120, source: "cli" },
  }));
  const executor = new ProductionInvestigationPlanExecutor({
    executables: { "test-tool": "C:\\Trusted\\test-tool.exe" },
    environment: { SystemRoot: "C:\\Windows" },
    processLimits: limits,
    processRunner: { run },
    createId: () => `id-${++sequence}`,
    modelEditAdapter: { execute: edit },
    now: () => new Date("2026-09-15T01:00:00.000Z"),
  });
  const input: InvestigationPlanExecutorInput = { task, attempt, plan, execution, workspace };
  return {
    input,
    context,
    run,
    edit,
    executor,
    started,
    completed,
    processHost,
    workspace,
    execution,
    task,
    plan,
  };
}

function addModelEditStep(f: ReturnType<typeof fixture>): void {
  const stepId = f.plan.steps[0]!.id;
  const operation = { kind: "model-edit" as const, allowedPaths: ["src/file.ts"] };
  f.execution.steps[0] = {
    stepId,
    operation,
    digest: digestInvestigationExecutableStep({ stepId, operation }),
  };
}

function explicitIssueSourceFixture(
  kind: "issue-verify" | "reproduction-setup" | "issue-fix" | "feature-implement",
) {
  const f = fixture();
  const originalSubject = f.task.subjects[0]!;
  const snapshot = {
    id: originalSubject.id,
    repositoryId: f.task.repository.id,
    workItemId: f.task.workItem.id,
    kind: "issue_snapshot" as const,
    revisionKey: originalSubject.revisionKey,
    snapshotDigest: "5".repeat(64),
  };
  const source = {
    id: "explicit-source-subject",
    repositoryId: f.task.repository.id,
    workItemId: f.task.workItem.id,
    kind: "source_commit" as const,
    revisionKey: "6".repeat(64),
    commitSha: "b".repeat(40),
  };
  f.task.kind = kind;
  f.task.workItem.kind = "issue";
  f.task.subjects = [snapshot, source];
  f.task.subjectRef = source.id;
  f.task.executionPolicy.allowedSubjectRefs = [snapshot.id, source.id];
  f.plan.kind =
    kind === "issue-verify"
      ? "verification"
      : kind === "reproduction-setup"
        ? "reproduction"
        : kind === "issue-fix"
          ? "fix"
          : "implementation";
  f.plan.digest = createHash("sha256")
    .update(investigationCanonicalJson(investigationPlanDigestPayload(f.plan)))
    .digest("hex");
  f.task.planRef = { id: f.plan.id, version: f.plan.version, digest: f.plan.digest };
  f.execution.planRef = f.task.planRef;
  f.execution.subjectRef = source.id;
  f.execution.subjectRevisionKey = source.revisionKey;
  f.execution.executionPolicyDigest = createCanonicalResult(f.task.executionPolicy).sha256;
  if (kind === "issue-fix" || kind === "feature-implement") addModelEditStep(f);
  const workspace = {
    ...f.workspace,
    sourceBinding: {
      ...f.workspace.sourceBinding!,
      subjectRef: source.id,
      revisionKey: source.revisionKey,
      sourceSha: source.commitSha,
    },
  };
  return { ...f, snapshot, source, input: { ...f.input, workspace } };
}

function freezePlan(f: ReturnType<typeof fixture>): void {
  f.plan.digest = createHash("sha256")
    .update(investigationCanonicalJson(investigationPlanDigestPayload(f.plan)))
    .digest("hex");
  f.task.planRef = { id: f.plan.id, version: f.plan.version, digest: f.plan.digest };
  f.execution.planRef = f.task.planRef;
}

function freezeRecipeStep(f: ReturnType<typeof fixture>, recipe: InvestigationRecipeStep): void {
  const step = f.plan.steps[0]!;
  step.recipe = structuredClone(recipe);
  step.checkIds = recipe.checks.map((check) => check.checkId);
  freezePlan(f);
  const operation = { kind: "recipe" as const, recipe: structuredClone(recipe) };
  f.execution.steps[0] = {
    stepId: step.id,
    operation,
    digest: digestInvestigationExecutableStep({ stepId: step.id, operation }),
  };
}

function recipeFixture(
  statuses: InvestigationValidation["checks"][number]["status"][] = ["passed", "passed"],
) {
  const f = fixture();
  const recipe: InvestigationRecipeStep = {
    request: {
      recipeId: "powertoys-run-query",
      plugin: "UnitConverter",
      scenarios: ["%% 1 sqm in sqft", "%% 1 sqft in sqm"].map((query, index) => ({
        query,
        feature: {
          id: `conversion-${index}`,
          title: `Area conversion ${index}`,
          paths: [
            "src/modules/launcher/Plugins/Community.PowerToys.Run.Plugin.UnitConverter/Main.cs",
          ],
          scenario: `Enter ${query} and observe its result.`,
          userVisible: true,
          assertions: [
            {
              id: "result",
              kind: "ui",
              description: "The expected conversion result is visible.",
              selector: { automationId: "Result" },
              assertion: { property: "text", expected: "converted value", match: "contains" },
            },
          ],
        },
      })),
    },
    checks: statuses.map((_, index) => ({
      checkId: `conversion-check-${index}`,
      featureId: `conversion-${index}`,
      assertionId: "result",
      scenarioId: `conversion-scenario-${index}`,
    })),
  };
  freezeRecipeStep(f, recipe);
  const artifacts: InvestigationArtifactV1[] = [];
  const evidence: InvestigationEvidenceV1[] = [];
  const checks: InvestigationValidation["checks"] = recipe.checks.map((mapping, index) => {
    const assertionId = `assertion-${index}`;
    const mediaId = `screenshot-${index}`;
    const receiptArtifacts = [`${assertionId}.json`, `${mediaId}.json`, `${mediaId}.png`];
    for (const id of receiptArtifacts) {
      const bytes = Buffer.from(`Synthetic recipe artifact ${id}.`);
      artifacts.push({
        id,
        taskId: f.task.id,
        attemptId: f.input.attempt.id,
        subjectRef: f.task.subjectRef,
        kind: id.endsWith(".png") ? "image" : "log",
        name: id,
        mediaType: id.endsWith(".png") ? "image/png" : "application/json",
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        availability: "available",
      });
    }
    for (const [id, source, artifactRefs] of [
      [assertionId, "executor_observation", [receiptArtifacts[0]!]],
      [mediaId, "visual_observation", receiptArtifacts.slice(1)],
    ] as const) {
      evidence.push({
        id,
        subjectRef: f.task.subjectRef,
        source,
        authority: "worker",
        summary: `Synthetic recipe observation ${id}.`,
        artifactRefs: [...artifactRefs],
        evidenceRefs: [],
        provenance: {
          taskId: f.task.id,
          attemptId: f.input.attempt.id,
          producer: "e2e-tool-server",
          recordedAt: "2026-09-15T01:00:00.000Z",
        },
      });
    }
    return {
      id: mapping.checkId,
      scenarioId: mapping.scenarioId,
      subjectRef: f.task.subjectRef,
      planRef: f.task.planRef,
      required: true,
      description: "Observe the saved area conversion assertion.",
      status: statuses[index]!,
      executor: "e2e-tool-server",
      evidenceRefs: [assertionId],
      authoritativeAttemptId: f.input.attempt.id,
    };
  });
  const observation: InvestigationRecipeObservation = {
    summary: "The saved area conversion scenarios were observed.",
    checks,
    evidence,
    artifacts,
  };
  const executeRecipe = vi.fn<InvestigationRecipePlanAdapter["execute"]>(async () => observation);
  const executor = new ProductionInvestigationPlanExecutor({
    processLimits: limits,
    processRunner: { run: f.run },
    recipeAdapter: { execute: executeRecipe },
  });
  return { ...f, executor, recipe, observation, executeRecipe };
}

describe("ProductionInvestigationPlanExecutor", () => {
  it("blocks prose-only saved plans without running a command", async () => {
    const f = fixture();
    const result = await f.executor.execute({ ...f.input, execution: null }, f.context);
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("PLAN_EXECUTION_UNAVAILABLE");
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["policy", "subject", "operation", "prerequisite"])(
    "blocks a mismatched %s binding",
    async (kind) => {
      const f = fixture();
      if (kind === "policy") f.task.executionPolicy.authorizationRef = "another-authorization";
      if (kind === "subject") f.execution.subjectRevisionKey = "9".repeat(64);
      if (kind === "operation")
        f.execution.steps[0]!.operation = {
          kind: "command",
          executableId: "test-tool",
          arguments: ["--changed"],
          workingDirectory: ".",
          expectedExitCode: 0,
        };
      if (kind === "prerequisite") f.execution.satisfiedPrerequisiteRefs = [];
      expect((await f.executor.execute(f.input, f.context)).outcome).toBe("blocked");
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("persists a start before execution and creates checks only from worker observations", async () => {
    const f = fixture();
    f.run.mockImplementation(async () => {
      expect(f.started).toHaveLength(1);
      expect(f.completed).toHaveLength(0);
      return { exitCode: 0, stdout: "observed", stderr: "" };
    });
    const result = await f.executor.execute(f.input, f.context);
    expect(result.outcome).toBe("completed");
    expect(result.validation.checks[0]).toMatchObject({
      status: "passed",
      subjectRef: f.task.subjectRef,
      authoritativeAttemptId: f.input.attempt.id,
    });
    expect(result.verificationEvidence[0]).toMatchObject({
      authority: "worker",
      source: "executor_observation",
    });
    expect(f.completed).toHaveLength(1);
    expect(f.run.mock.calls[0]?.[0]).toMatchObject({
      executable: "C:\\Trusted\\test-tool.exe",
      workingDirectory: f.workspace.sourceDirectory,
      environmentMode: "replace",
      arguments: ["--fixture"],
    });
    expect(f.processHost.start).not.toHaveBeenCalled();
  });

  it("keeps failed checks and executes the remaining saved scenarios", async () => {
    const f = fixture();
    f.plan.steps.push({
      id: "second-step",
      description: "Observe another scenario.",
      expectedObservation: "A second observation is recorded.",
      checkIds: ["second-check"],
    });
    f.plan.digest = createHash("sha256")
      .update(investigationCanonicalJson(investigationPlanDigestPayload(f.plan)))
      .digest("hex");
    f.task.planRef = { id: f.plan.id, version: f.plan.version, digest: f.plan.digest };
    f.execution.planRef = f.task.planRef;
    const operation = {
      kind: "command" as const,
      executableId: "test-tool",
      arguments: ["--second"],
      workingDirectory: ".",
      expectedExitCode: 0,
    };
    f.execution.steps.push({
      stepId: "second-step",
      operation,
      digest: digestInvestigationExecutableStep({ stepId: "second-step", operation }),
    });
    f.run.mockRejectedValueOnce(
      new ManagedProcessRunError("NON_ZERO_EXIT", "Failure observed.", { exitCode: 1 }),
    );
    const result = await f.executor.execute(f.input, f.context);
    expect(result.outcome).toBe("completed");
    expect(result.validation.checks.map((check) => check.status)).toEqual(["failed", "passed"]);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("reuses only persisted exact completed steps after a new attempt starts", async () => {
    const f = fixture();
    const first = await f.executor.execute(f.input, f.context);
    f.run.mockClear();
    const nextAttempt = { ...f.input.attempt, id: "next-attempt", number: 2 };
    const result = await f.executor.execute(
      { ...f.input, attempt: nextAttempt, priorState: first.state },
      f.context,
    );
    expect(result.outcome).toBe("completed");
    expect(f.run).not.toHaveBeenCalled();
    expect(result.validation.checks[0]?.authoritativeAttemptId).toBe(f.input.attempt.id);
  });

  it("does not replay a step whose execution may have happened before interruption", async () => {
    const f = fixture();
    const first = await f.executor.execute(f.input, f.context);
    f.run.mockClear();
    const result = await f.executor.execute(
      { ...f.input, priorState: { startedSteps: first.state.startedSteps, completedSteps: [] } },
      f.context,
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("PLAN_RESUME_UNSAFE");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects model authority masquerading as resumable runtime evidence", async () => {
    const f = fixture();
    const first = await f.executor.execute(f.input, f.context);
    const prior = structuredClone(first.state);
    prior.completedSteps[0]!.verificationEvidence[0]!.authority = "model";
    f.run.mockClear();
    const result = await f.executor.execute({ ...f.input, priorState: prior }, f.context);
    expect(result.outcome).toBe("blocked");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("blocks unconfigured UI adapters without a fabricated passing check", async () => {
    const f = fixture();
    const operation = { kind: "ui" as const, adapterId: "desktop", scenarioId: "scenario-1" };
    const stepId = f.plan.steps[0]!.id;
    f.execution.steps[0] = {
      stepId,
      operation,
      digest: digestInvestigationExecutableStep({ stepId, operation }),
    };
    const result = await f.executor.execute(f.input, f.context);
    expect(result.outcome).toBe("blocked");
    expect(result.validation.checks[0]?.status).toBe("blocked");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("does not execute when the source patch does not match the selected subject", async () => {
    const f = fixture();
    const sourceBinding = { ...f.workspace.sourceBinding!, patchDigest: "8".repeat(64) };
    const result = await f.executor.execute(
      { ...f.input, workspace: { ...f.workspace, sourceBinding } },
      f.context,
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("PLAN_SOURCE_BINDING_MISMATCH");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("does not run the next operation if persisting the previous observation fails", async () => {
    const f = fixture();
    const failure = new Error("Checkpoint storage is unavailable.");
    await expect(
      f.executor.execute(f.input, {
        ...f.context,
        onStepCompleted: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(f.started).toHaveLength(1);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("binds implementation checks to the captured patch instead of the original PR", async () => {
    const f = fixture();
    f.task.kind = "issue-fix";
    f.plan.kind = "fix";
    f.plan.digest = createHash("sha256")
      .update(investigationCanonicalJson(investigationPlanDigestPayload(f.plan)))
      .digest("hex");
    f.task.planRef = { id: f.plan.id, version: f.plan.version, digest: f.plan.digest };
    f.execution.planRef = f.task.planRef;
    addModelEditStep(f);
    const result = await f.executor.execute(f.input, f.context);
    expect(result.outcome).toBe("completed");
    expect(result.subjects).toHaveLength(1);
    const patch = result.subjects[0]!;
    expect(patch.kind).toBe("local_patch");
    expect(result.validation.checks[0]?.subjectRef).toBe(patch.id);
    expect(result.verificationEvidence[0]?.subjectRef).toBe(patch.id);
    expect(result.artifacts.find((entry) => entry.kind === "patch")?.subjectRef).toBe(patch.id);
    expect(result.validation.checks[0]?.subjectRef).not.toBe(f.task.subjectRef);
    expect(result.validation.checks[0]).toMatchObject({
      status: "not_run",
      executor: null,
      authoritativeAttemptId: null,
      evidenceRefs: [],
    });
    expect(f.completed[0]?.subjects).toEqual(result.subjects);
    expect(f.edit).toHaveBeenCalledTimes(1);
    expect(f.workspace.applyEdits).toHaveBeenCalledWith({
      allowedPaths: ["src/file.ts"],
      edits: [
        {
          path: "src/file.ts",
          expectedDigest: createHash("sha256").update("old").digest("hex"),
          content: "new",
        },
      ],
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("blocks a mutation resume when its persisted patch has not been restored", async () => {
    const f = fixture();
    f.task.kind = "feature-implement";
    f.plan.kind = "implementation";
    f.plan.digest = createHash("sha256")
      .update(investigationCanonicalJson(investigationPlanDigestPayload(f.plan)))
      .digest("hex");
    f.task.planRef = { id: f.plan.id, version: f.plan.version, digest: f.plan.digest };
    f.execution.planRef = f.task.planRef;
    addModelEditStep(f);
    const first = await f.executor.execute(f.input, f.context);
    f.run.mockClear();
    const workspace = {
      ...f.workspace,
      capturePatch: vi.fn(async () => ({ baseSha: "b".repeat(40), bytes: new Uint8Array() })),
    };
    const result = await f.executor.execute(
      { ...f.input, workspace, priorState: first.state },
      f.context,
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("PLAN_MUTATION_RESUME_UNSAFE");
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["issue-verify", "reproduction-setup"] as const)(
    "runs %s against the explicit source while preserving the parent's Issue plan",
    async (kind) => {
      const f = explicitIssueSourceFixture(kind);
      const savedPlan = structuredClone(f.plan);
      const result = await f.executor.execute(f.input, f.context);
      expect(result.outcome).toBe("completed");
      expect(result.validation.checks[0]?.subjectRef).toBe(f.source.id);
      expect(result.verificationEvidence[0]?.subjectRef).toBe(f.source.id);
      expect(result.state.startedSteps[0]?.subjectRevisionKey).toBe(f.source.revisionKey);
      expect(f.plan).toEqual(savedPlan);
      expect(f.plan.subjectRef).toBe(f.snapshot.id);
      expect(f.run).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["task-kind", "repository", "parent-report", "execution-subject"])(
    "rejects an explicit Issue source with a mismatched %s",
    async (mismatch) => {
      const f = explicitIssueSourceFixture("issue-verify");
      if (mismatch === "task-kind") f.task.kind = "pr-verify";
      if (mismatch === "repository") f.snapshot.repositoryId = "another-repository";
      if (mismatch === "parent-report") f.task.parentReportRef!.id = "another-parent-report";
      if (mismatch === "execution-subject") f.execution.subjectRef = f.snapshot.id;
      expect((await f.executor.execute(f.input, f.context)).outcome).toBe("blocked");
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("does not authorize a model edit for a verification task", async () => {
    const f = fixture();
    addModelEditStep(f);
    const result = await f.executor.execute(f.input, f.context);
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("PLAN_MODEL_EDIT_NOT_AUTHORIZED");
    expect(f.edit).not.toHaveBeenCalled();
    expect(f.workspace.applyEdits).not.toHaveBeenCalled();
  });

  it("requires a real saved model edit operation for an implementation task", async () => {
    const f = fixture();
    f.task.kind = "issue-fix";
    f.plan.kind = "fix";
    f.plan.digest = createHash("sha256")
      .update(investigationCanonicalJson(investigationPlanDigestPayload(f.plan)))
      .digest("hex");
    f.task.planRef = { id: f.plan.id, version: f.plan.version, digest: f.plan.digest };
    f.execution.planRef = f.task.planRef;
    const result = await f.executor.execute(f.input, f.context);
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("PLAN_MODEL_EDIT_REQUIRED");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("retains a real edited patch without inventing checks for a pure edit step", async () => {
    const f = fixture();
    f.task.kind = "feature-implement";
    f.plan.kind = "implementation";
    f.plan.steps[0]!.checkIds = [];
    f.plan.digest = createHash("sha256")
      .update(investigationCanonicalJson(investigationPlanDigestPayload(f.plan)))
      .digest("hex");
    f.task.planRef = { id: f.plan.id, version: f.plan.version, digest: f.plan.digest };
    f.execution.planRef = f.task.planRef;
    addModelEditStep(f);
    const result = await f.executor.execute(f.input, f.context);
    expect(result.outcome).toBe("completed");
    expect(result.validation.checks).toEqual([]);
    expect(result.subjects[0]?.kind).toBe("local_patch");
    expect(result.verificationEvidence[0]?.authority).toBe("worker");
    expect(f.workspace.applyEdits).toHaveBeenCalledTimes(1);
  });

  it.each(["issue-fix", "feature-implement"] as const)(
    "executes %s using the explicit immutable source of its saved Issue plan",
    async (kind) => {
      const f = explicitIssueSourceFixture(kind);
      const savedPlan = structuredClone(f.plan);
      const result = await f.executor.execute(f.input, f.context);
      expect(result.outcome).toBe("completed");
      expect(result.subjects[0]).toMatchObject({
        kind: "local_patch",
        baseSubjectRef: f.source.id,
        baseSha: f.source.commitSha,
      });
      expect(result.validation.checks[0]).toMatchObject({
        subjectRef: result.subjects[0]!.id,
        status: "not_run",
      });
      expect(f.plan).toEqual(savedPlan);
      expect(f.plan.subjectRef).toBe(f.snapshot.id);
      expect(f.edit).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks unknown model usage before applying any proposed edits", async () => {
    const f = explicitIssueSourceFixture("issue-fix");
    f.edit.mockResolvedValue({
      proposal: {
        schemaVersion: "InvestigationModelEditsV1",
        summary: "A proposed edit.",
        edits: [],
      },
      usage: { tokens: null, source: "unavailable" },
    });
    const result = await f.executor.execute(f.input, f.context);
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("PLAN_MODEL_USAGE_UNAVAILABLE");
    expect(f.workspace.applyEdits).not.toHaveBeenCalled();
    expect(result.state.completedSteps[0]?.modelUsage).toBeUndefined();
  });

  it("records observed token consumption and rejects edits beyond the remaining budget", async () => {
    const f = explicitIssueSourceFixture("issue-fix");
    const result = await f.executor.execute(
      { ...f.input, consumedTokens: f.task.budget.maxTokens - 1 },
      f.context,
    );
    expect(result.outcome).toBe("blocked");
    expect(result.diagnostics[0]?.code).toBe("PLAN_MODEL_TOKEN_BUDGET_EXCEEDED");
    expect(result.state.completedSteps[0]?.modelUsage?.tokens).toBe(120);
    expect(f.workspace.applyEdits).not.toHaveBeenCalled();
  });

  it("deducts each edit from the invocation allowance while retaining the attempt deadline", async () => {
    const f = explicitIssueSourceFixture("issue-fix");
    f.plan.steps.push({ ...f.plan.steps[0]!, id: "second-edit", checkIds: [] });
    f.plan.digest = createHash("sha256")
      .update(investigationCanonicalJson(investigationPlanDigestPayload(f.plan)))
      .digest("hex");
    f.task.planRef = { id: f.plan.id, version: f.plan.version, digest: f.plan.digest };
    f.execution.planRef = f.task.planRef;
    const operation = { kind: "model-edit" as const, allowedPaths: ["src/file.ts"] };
    f.execution.steps.push({
      stepId: "second-edit",
      operation,
      digest: digestInvestigationExecutableStep({ stepId: "second-edit", operation }),
    });
    const invocationBudget = { remainingTokens: 300, deadlineAtMs: Date.now() + 60_000 };
    const result = await f.executor.execute(
      { ...f.input, consumedTokens: 200 },
      { ...f.context, invocationBudget },
    );
    expect(result.outcome).toBe("completed");
    expect(f.edit.mock.calls.map(([, context]) => context.invocationBudget)).toEqual([
      invocationBudget,
      { remainingTokens: 180, deadlineAtMs: invocationBudget.deadlineAtMs },
    ]);
    expect(result.state.completedSteps.map((step) => step.modelUsage?.tokens)).toEqual([120, 120]);
  });

  it("does not dispatch an edit when its supplied invocation allowance is exhausted", async () => {
    const f = explicitIssueSourceFixture("issue-fix");
    await expect(
      f.executor.execute(f.input, {
        ...f.context,
        invocationBudget: { remainingTokens: 0, deadlineAtMs: Date.now() + 60_000 },
      }),
    ).rejects.toBeInstanceOf(ModelBudgetExceededError);
    expect(f.edit).not.toHaveBeenCalled();
    expect(f.context.onStepStarted).not.toHaveBeenCalled();
    expect(f.workspace.applyEdits).not.toHaveBeenCalled();
  });

  it("propagates a live edit budget stop without recording a successful step or applying edits", async () => {
    const f = explicitIssueSourceFixture("issue-fix");
    const stopped = new ModelBudgetExceededError("tokens");
    f.edit.mockRejectedValue(stopped);
    await expect(
      f.executor.execute(f.input, {
        ...f.context,
        invocationBudget: { remainingTokens: 1, deadlineAtMs: Date.now() + 60_000 },
      }),
    ).rejects.toBe(stopped);
    expect(f.context.onStepStarted).toHaveBeenCalledOnce();
    expect(f.context.onStepCompleted).not.toHaveBeenCalled();
    expect(f.workspace.applyEdits).not.toHaveBeenCalled();
  });

  it.each([
    "SOURCE_PROCESS_CLEANUP_UNCONFIRMED",
    "UI_PROCESS_CLEANUP_UNCONFIRMED",
    "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
  ])("preserves %s instead of converting it to a cleanup-safe blocker", async (code) => {
    const f = explicitIssueSourceFixture("issue-fix");
    const fault = Object.assign(new Error("Managed processes may still be running."), { code });
    const workspace = {
      ...f.input.workspace,
      capturePatch: vi.fn(async () => {
        throw new AggregateError([fault], "Source capture failed.");
      }),
    };
    await expect(f.executor.execute({ ...f.input, workspace }, f.context)).rejects.toBe(fault);
    expect(f.started).toHaveLength(1);
    expect(f.completed).toHaveLength(0);
  });

  it("retains UI adapter bytes under the exact observed subject before recording passed checks", async () => {
    const f = fixture();
    const stepId = f.plan.steps[0]!.id;
    const operation = {
      kind: "ui" as const,
      adapterId: "desktop",
      scenarioId: "saved-ui-scenario",
    };
    f.execution.steps[0] = {
      stepId,
      operation,
      digest: digestInvestigationExecutableStep({ stepId, operation }),
    };
    const executor = new ProductionInvestigationPlanExecutor({
      processLimits: limits,
      processRunner: { run: f.run },
      uiAdapters: {
        desktop: {
          execute: async () => ({
            status: "passed",
            summary: "The fixture window was observed.",
            observation: { fixture: true, windowTitle: "Synthetic window" },
            artifacts: [
              {
                name: "fixture-screen.png",
                mediaType: "image/png",
                kind: "image",
                bytes: Buffer.from("synthetic-image-bytes"),
              },
            ],
          }),
        },
      },
    });
    const result = await executor.execute(f.input, f.context);
    const image = result.artifacts.find((artifact) => artifact.kind === "image");
    expect(result.outcome).toBe("completed");
    expect(image?.subjectRef).toBe(f.task.subjectRef);
    expect(result.verificationEvidence[0]?.artifactRefs).toContain(image?.id);
    expect(result.validation.checks[0]).toMatchObject({
      status: "passed",
      scenarioId: "saved-ui-scenario",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  describe("saved recipe steps", () => {
    it("persists individual assertion results and raw E2E evidence under the saved plan", async () => {
      const f = recipeFixture(["failed", "passed"]);
      const onRuntimeObservation = vi.fn(async () => undefined);
      f.executeRecipe.mockImplementation(async () => {
        expect(f.started).toHaveLength(1);
        expect(f.completed).toHaveLength(0);
        return f.observation;
      });
      const result = await f.executor.execute(f.input, { ...f.context, onRuntimeObservation });
      expect(result.outcome).toBe("completed");
      expect(result.validation.checks).toEqual(f.observation.checks);
      expect(result.validation.checks.map((check) => check.evidenceRefs)).toEqual([
        ["assertion-0"],
        ["assertion-1"],
      ]);
      expect(result.verificationEvidence).toEqual(
        expect.arrayContaining([...f.observation.evidence]),
      );
      expect(result.artifacts).toEqual(expect.arrayContaining([...f.observation.artifacts]));
      expect(result.verificationEvidence).toContainEqual(
        expect.objectContaining({
          source: "executor_observation",
          provenance: expect.objectContaining({ producer: "saved-plan:recipe" }),
        }),
      );
      expect(f.executeRecipe).toHaveBeenCalledExactlyOnceWith(
        {
          task: f.task,
          attempt: f.input.attempt,
          plan: f.plan,
          recipe: f.recipe,
          workspace: f.workspace,
        },
        expect.objectContaining({
          signal: f.context.signal,
          processHost: f.processHost,
          onRuntimeObservation,
        }),
      );
      expect(f.completed[0]?.validation.checks).toEqual(f.observation.checks);
      expect(f.run).not.toHaveBeenCalled();
    });

    it.each(["passed", "failed"] as const)(
      "retains %s and blocked assertions when a recipe cannot finish and when it resumes",
      async (status) => {
        const f = recipeFixture([status, "blocked"]);
        const first = await f.executor.execute(f.input, f.context);
        expect(first.outcome).toBe("blocked");
        expect(first.validation.checks.map((check) => check.status)).toEqual([status, "blocked"]);
        f.executeRecipe.mockClear();
        const resumed = await f.executor.execute(
          { ...f.input, priorState: first.state },
          f.context,
        );
        expect(resumed.outcome).toBe("blocked");
        expect(resumed.validation.checks).toEqual(first.validation.checks);
        expect(resumed.diagnostics.some((entry) => entry.code === "PLAN_RESUME_UNSAFE")).toBe(
          false,
        );
        expect(f.executeRecipe).not.toHaveBeenCalled();
      },
    );

    it("reuses completed recipe receipts from their original attempt without another build", async () => {
      const f = recipeFixture();
      const first = await f.executor.execute(f.input, f.context);
      f.executeRecipe.mockClear();
      const result = await f.executor.execute(
        {
          ...f.input,
          attempt: { ...f.input.attempt, id: "next-recipe-attempt", number: 2 },
          priorState: first.state,
        },
        f.context,
      );
      expect(result.outcome).toBe("completed");
      expect(result.validation.checks).toEqual(f.observation.checks);
      expect(result.verificationEvidence).toEqual(first.verificationEvidence);
      expect(f.executeRecipe).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    });

    it("does not replay a recipe with a persisted start and no completed observation", async () => {
      const f = recipeFixture();
      const first = await f.executor.execute(f.input, f.context);
      f.executeRecipe.mockClear();
      const result = await f.executor.execute(
        { ...f.input, priorState: { startedSteps: first.state.startedSteps, completedSteps: [] } },
        f.context,
      );
      expect(result.outcome).toBe("blocked");
      expect(result.diagnostics[0]?.code).toBe("PLAN_RESUME_UNSAFE");
      expect(f.executeRecipe).not.toHaveBeenCalled();
    });

    it.each(["request", "check-order", "duplicate-assertion", "missing-declaration"])(
      "rejects an invalid saved recipe %s before dispatch",
      async (kind) => {
        const f = recipeFixture();
        if (kind === "request") {
          const executable = f.execution.steps[0]!;
          if (executable.operation.kind !== "recipe") throw new Error("Expected a recipe step.");
          executable.operation.recipe.request = { recipeId: "powertoys-calculator" };
          executable.digest = digestInvestigationExecutableStep({
            stepId: executable.stepId,
            operation: executable.operation,
          });
        } else if (kind === "check-order") {
          f.plan.steps[0]!.checkIds.reverse();
          freezePlan(f);
        } else if (kind === "duplicate-assertion") {
          f.recipe.checks[1]!.featureId = f.recipe.checks[0]!.featureId;
          freezeRecipeStep(f, f.recipe);
        } else {
          delete f.plan.steps[0]!.recipe;
          freezePlan(f);
        }
        const result = await f.executor.execute(f.input, f.context);
        expect(result.outcome).toBe("blocked");
        expect(result.diagnostics[0]?.code).toBe("PLAN_RECIPE_BINDING_INVALID");
        expect(f.executeRecipe).not.toHaveBeenCalled();
        expect(f.started).toHaveLength(0);
      },
    );

    it("blocks a recipe whose configured adapter is unavailable", async () => {
      const f = recipeFixture();
      const executor = new ProductionInvestigationPlanExecutor({
        processLimits: limits,
        processRunner: { run: f.run },
      });
      const result = await executor.execute(f.input, f.context);
      expect(result.outcome).toBe("blocked");
      expect(result.validation.checks.map((check) => check.status)).toEqual(["blocked", "blocked"]);
      expect(result.diagnostics[0]?.code).toBe("PLAN_RECIPE_ADAPTER_UNAVAILABLE");
      expect(f.executeRecipe).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    });

    it.each(["check", "scenario", "plan", "attempt"])(
      "rejects an adapter result with a different %s binding",
      async (kind) => {
        const f = recipeFixture();
        const check = f.observation.checks[0]!;
        if (kind === "check") check.id = "unmapped-check";
        if (kind === "scenario") check.scenarioId = f.recipe.checks[1]!.scenarioId;
        if (kind === "plan") check.planRef = null;
        if (kind === "attempt") check.authoritativeAttemptId = "another-attempt";
        await expect(f.executor.execute(f.input, f.context)).rejects.toThrow(
          "A prior completed step is missing authoritative observations or exact check and artifact bindings.",
        );
        expect(f.started).toHaveLength(1);
        expect(f.completed).toHaveLength(0);
      },
    );

    it.each([
      "authority",
      "producer",
      "source",
      "attempt",
      "artifact-subject",
      "scenario",
      "missing-assertion",
      "mixed-screenshot",
    ])("rejects a persisted recipe with an invalid %s observation", async (kind) => {
      const f = recipeFixture();
      const first = await f.executor.execute(f.input, f.context);
      const prior = structuredClone(first.state);
      const completed = prior.completedSteps[0]!;
      const evidence = completed.verificationEvidence.find((entry) => entry.id === "assertion-0")!;
      if (kind === "authority") evidence.authority = "model";
      if (kind === "producer") evidence.provenance.producer = "saved-plan:recipe";
      if (kind === "source") evidence.source = "reporter_statement";
      if (kind === "attempt") evidence.provenance.attemptId = "another-attempt";
      if (kind === "artifact-subject")
        completed.artifacts.find((entry) => entry.id === evidence.artifactRefs[0])!.subjectRef =
          "another-subject";
      if (kind === "scenario")
        completed.validation.checks[0]!.scenarioId = f.recipe.checks[1]!.scenarioId;
      if (kind === "missing-assertion")
        completed.validation.checks[0]!.evidenceRefs = ["screenshot-0"];
      if (kind === "mixed-screenshot")
        completed.validation.checks[0]!.evidenceRefs.push("screenshot-0");
      f.executeRecipe.mockClear();
      const result = await f.executor.execute({ ...f.input, priorState: prior }, f.context);
      expect(result.outcome).toBe("blocked");
      expect(result.diagnostics[0]?.code).toBe("PLAN_RESUME_UNSAFE");
      expect(f.executeRecipe).not.toHaveBeenCalled();
    });

    it("does not grant ordinary command steps E2E receipt provenance", async () => {
      const f = fixture();
      const first = await f.executor.execute(f.input, f.context);
      const prior = structuredClone(first.state);
      const completed = prior.completedSteps[0]!;
      completed.verificationEvidence[0]!.provenance.producer = "e2e-tool-server";
      completed.verificationEvidence[0]!.source = "visual_observation";
      completed.validation.checks[0]!.executor = "e2e-tool-server";
      f.run.mockClear();
      const result = await f.executor.execute({ ...f.input, priorState: prior }, f.context);
      expect(result.outcome).toBe("blocked");
      expect(result.diagnostics[0]?.code).toBe("PLAN_RESUME_UNSAFE");
      expect(f.run).not.toHaveBeenCalled();
    });

    it("propagates uncertain recipe cleanup without recording a completed step", async () => {
      const f = recipeFixture();
      const fault = Object.assign(new Error("Recipe cleanup was not confirmed."), {
        code: "E2E_CLEANUP_UNCONFIRMED",
      });
      f.executeRecipe.mockRejectedValueOnce(fault);
      await expect(f.executor.execute(f.input, f.context)).rejects.toBe(fault);
      expect(f.started).toHaveLength(1);
      expect(f.completed).toHaveLength(0);
    });
  });
});
