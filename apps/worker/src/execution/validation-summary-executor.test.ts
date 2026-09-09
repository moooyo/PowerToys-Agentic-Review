import { createHash } from "node:crypto";
import {
  composeSummaryPrompt as composeSharedSummaryPrompt,
  createCanonicalResult,
  createValidationSummaryContext as createSharedSummaryContext,
  IssueTriageV2ModelOutputSchema,
  PrReviewPlanV2ModelOutputSchema,
} from "@agentic-review/codex";
import {
  type EvidenceAssetManifest,
  type FreezeValidationSummaryInputRequest,
  type FreezeValidationSummaryInputResponse,
  type FrozenValidationSummaryInputV1,
  GitHubWorkItemSchema,
  IssueValidationSummaryV1Schema,
  type JobExecutionEnvelopeV2,
  PullRequestValidationSummaryV1Schema,
  type ValidationProfileVersion,
  type ValidationReportV1,
  type ValidationSummaryV1,
} from "@agentic-review/contracts";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaseLostError } from "../leases/errors.js";
import type { JobExecutionContext } from "./job-executor.js";
import type { JobWorkspaceProvider, PreparedJobWorkspace } from "./job-workspace.js";
import { modelArtifactEvaluationFixture } from "./model-output-artifact.testing.js";
import type {
  PreparedCliOutputInput,
  PreparedCliOutputResult,
  PreparedCliOutputRunner,
} from "./prepared-cli-output-runner.js";
import {
  composeSummaryPrompt,
  createValidationSummaryContext,
  ValidationSummaryExecutor,
  type ValidationSummaryExecutorOptions,
  type ValidationSummaryInput,
} from "./validation-summary-executor.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const now = "2026-09-08T00:00:00.000Z";
function profile(ui = false): ValidationProfileVersion {
  const step = {
    id: "test",
    name: "Test original code",
    command: { executable: "test.exe", args: [], workingDirectory: ".", environment: [] },
    timeoutMs: 1_000,
    required: true,
  };
  const config = {
    schemaVersion: "ValidationProfileV1" as const,
    setup: [],
    build: [],
    test: ui ? [] : [step],
    launch: ui ? [{ ...step, id: "launch" }] : [],
    cleanup: [],
    hardTimeoutMs: 30_000,
    noProgressTimeoutMs: 20_000,
    requiredCapabilities: [],
  };
  const metadata = {
    id: "profile-version",
    profileId: "profile",
    repositoryId: "repo",
    name: "Fixture profile",
    version: 1,
    required: true,
    createdAt: now,
    publishedAt: now,
    createdBy: "operator",
  };
  if (!ui)
    return {
      ...metadata,
      workflowKind: "pr_static_build",
      target: "headless",
      config,
      configSha256: createCanonicalResult(config).sha256,
      outputSchemaVersion: "PrReviewPlanV2",
    };
  const uiConfig = {
    ...config,
    ui: {
      schemaVersion: "UiScenariosV1" as const,
      target: "windows_desktop" as const,
      desktop: {
        session: "exclusive_interactive" as const,
        scope: "launched_process_tree" as const,
      },
      launch: {
        stepId: "launch",
        mode: "persistent" as const,
        readiness: {
          kind: "window" as const,
          window: { title: "Owned fixture" },
          timeoutMs: 1_000,
        },
      },
      reset: { strategy: "restart_process" as const },
      evidence: {
        screenshots: "every_assertion" as const,
        screenshotScope: "owned_window" as const,
        required: true as const,
      },
      scenarios: [
        {
          id: "scenario",
          name: "UI scenario",
          required: true,
          timeoutMs: 1_000,
          steps: [
            {
              id: "assertion",
              name: "Check fixture",
              action: "assertText" as const,
              locator: { by: "automationId" as const, automationId: "ResultLabel" },
              expected: "Ready",
              match: "exact" as const,
              timeoutMs: 100,
            },
          ],
        },
      ],
    },
  };
  return {
    ...metadata,
    workflowKind: "pr_ui",
    target: "windows_desktop",
    config: uiConfig,
    configSha256: createCanonicalResult(uiConfig).sha256,
    outputSchemaVersion: "ValidationReportV1",
  };
}
function envelope(selected = profile()): JobExecutionEnvelopeV2 {
  const snapshot = {
    kind: "pull_request" as const,
    githubWorkItemId: 12,
    githubNodeId: "PR_12",
    githubRepositoryId: 8,
    number: 12,
    title: "Fixture change",
    body: "Fixture body",
    state: "open" as const,
    author: { githubUserId: 4, login: "author" },
    htmlUrl: "https://github.com/org/repo/pull/12",
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    isDraft: false,
  };
  const outputSchema: unknown = JSON.parse(
    JSON.stringify(
      selected.workflowKind === "pr_ui"
        ? PullRequestValidationSummaryV1Schema
        : PrReviewPlanV2ModelOutputSchema,
    ),
  );
  return {
    protocolVersion: "1.0",
    envelopeVersion: 2,
    assignedAt: now,
    leaseExpiresAt: "2026-09-08T00:01:00.000Z",
    executionDeadlineAt: "2026-09-08T00:01:00.000Z",
    lease: {
      jobId: "job",
      runAttemptId: "attempt",
      workerNodeId: "node",
      workerInstanceId: "instance",
      leaseToken: "t".repeat(64),
      leaseGeneration: 1,
    },
    job: {
      jobId: "job",
      kind: "pull_request_review",
      priority: 10,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "run:fixture",
    },
    repository: { githubRepositoryId: 8, fullName: "org/repo" },
    resource: {
      kind: "pull_request",
      githubNodeId: snapshot.githubNodeId,
      number: snapshot.number,
      title: snapshot.title,
      author: snapshot.author,
      canonicalSnapshot: snapshot,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isDraft: false,
    },
    prompt: {
      name: "prompt-template",
      version: "1",
      renderedPrompt: "Review the frozen source.",
      promptSha256: hash("Review the frozen source."),
      outputSchema: JSON.parse(createCanonicalResult(outputSchema).json),
      outputSchemaSha256: createCanonicalResult(outputSchema).sha256,
    },
    executionPolicy: {
      hardTimeoutMs: selected.config.hardTimeoutMs,
      noProgressTimeoutMs: selected.config.noProgressTimeoutMs,
      allowedRecipeIds: [],
      requiredCapabilityLabels: {},
    },
    validation: {
      schemaVersion: "ValidationJobContextV1",
      runId: "run",
      planDigest: "d".repeat(64),
      activationId: "activation",
      requestId: "request",
      jobActivation: 1,
      repositoryId: "repo",
      workItemId: "work-item",
      revisionKey: hash(`${"a".repeat(40)}\0${"b".repeat(40)}`),
      requestEpochId: "epoch",
      workflowKind: selected.workflowKind,
      target: selected.target,
      required: true,
      profileVersion: selected,
      promptVersion: {
        id: "prompt-version",
        templateId: "prompt-template",
        version: 1,
        contentSha256: "e".repeat(64),
      },
      requiredCheckIds: [`profile-version:${selected.target === "headless" ? "test" : "scenario"}`],
      testedSourceRevision: {
        kind: "pull_request",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
      testedSourceAuthorization: null,
    },
  };
}
function workspace(purpose: string): PreparedJobWorkspace {
  const root = `C:\\Worker\\${purpose}`;
  return {
    attemptDirectory: root,
    checkoutDirectory: `${root}\\checkout`,
    controlDirectory: `${root}\\control`,
    tempDirectory: `${root}\\temp`,
    userProfileDirectory: `${root}\\user`,
    startDiskMonitoring: async (signal) => ({
      signal,
      violation: undefined,
      close: async () => undefined,
    }),
    captureWorktreeState: async () => "clean",
    cleanup: vi.fn(async () => undefined),
  };
}
function issueEnvelope(validation = false): JobExecutionEnvelopeV2 {
  const value = envelope(profile(validation));
  const snapshot = value.resource.canonicalSnapshot;
  if (!Value.Check(GitHubWorkItemSchema, snapshot) || snapshot.kind !== "pull_request")
    throw new Error("Fixture snapshot missing.");
  const { isDraft: _draft, ...common } = snapshot;
  const issue = {
    ...common,
    kind: "issue" as const,
    githubNodeId: "ISSUE_12",
    htmlUrl: "https://github.com/org/repo/issues/12",
  };
  const digest = hash("Issue fixture snapshot.");
  value.resource = {
    kind: "issue",
    githubNodeId: issue.githubNodeId,
    number: issue.number,
    title: issue.title,
    author: issue.author,
    canonicalSnapshot: issue,
    revisionDigest: digest,
  };
  value.job.kind = "issue_triage";
  const selected = value.validation.profileVersion;
  const config = validation
    ? selected.config
    : { ...selected.config, setup: [], build: [], test: [], launch: [], cleanup: [] };
  value.validation.profileVersion = validation
    ? {
        ...selected,
        workflowKind: "issue_validation",
        target: "windows_desktop",
        config,
        configSha256: createCanonicalResult(config).sha256,
        outputSchemaVersion: "ValidationReportV1",
      }
    : {
        ...selected,
        workflowKind: "issue_triage",
        target: "headless",
        config,
        configSha256: createCanonicalResult(config).sha256,
        outputSchemaVersion: "IssueTriageV2",
      };
  value.validation.workflowKind = validation ? "issue_validation" : "issue_triage";
  value.validation.revisionKey = digest;
  value.validation.requiredCheckIds = validation ? ["profile-version:scenario"] : [];
  value.validation.testedSourceRevision = validation
    ? { kind: "commit", headSha: "c".repeat(40) }
    : null;
  value.validation.testedSourceAuthorization = validation
    ? {
        kind: "operator",
        activationId: "activation",
        issuer: "fixture-issuer",
        subject: "fixture-operator",
        authorizedAt: now,
        githubRepositoryId: 8,
        githubWorkItemId: 12,
        issueRevisionKey: digest,
        headSha: "c".repeat(40),
      }
    : null;
  value.prompt.outputSchema = JSON.parse(
    JSON.stringify(validation ? IssueValidationSummaryV1Schema : IssueTriageV2ModelOutputSchema),
  );
  value.prompt.outputSchemaSha256 = createCanonicalResult(value.prompt.outputSchema).sha256;
  return value;
}

function fixture(issue = false, overrides: Partial<ValidationSummaryExecutorOptions> = {}) {
  const frozen = issue ? issueEnvelope(true) : envelope(profile(true));
  frozen.executionDeadlineAt = "2026-09-08T00:02:00.000Z";
  frozen.executionPolicy.hardTimeoutMs = 120_000;
  frozen.executionPolicy.noProgressTimeoutMs = 120_000;
  frozen.validation.profileVersion.config.hardTimeoutMs = 120_000;
  frozen.validation.profileVersion.configSha256 = createCanonicalResult(
    frozen.validation.profileVersion.config,
  ).sha256;
  const report: ValidationReportV1 = {
    schemaVersion: "ValidationReportV1",
    source: "worker",
    sourceState: "original",
    summary: "The observed assertion failed.",
    ...(issue
      ? { workItemKind: "issue" as const, reproductionConclusion: "inconclusive" as const }
      : { workItemKind: "pull_request" as const }),
    checks: [
      {
        id: "profile-version:scenario",
        name: "UI scenario",
        kind: "ui",
        required: true,
        outcome: "failed",
        summary: "Expected Ready; observed Broken.",
        expected: "Ready",
        actual: "Broken",
        evidenceIds: [],
        source: "runner",
      },
    ],
  };
  const input: ValidationSummaryInput = {
    envelope: frozen,
    validationWorkspace: workspace("validation"),
    runnerReport: report,
    runnerExecution: {
      cleanupState: "not_needed",
      blockers: [],
      diagnostics: [
        {
          stepId: "profile-version:scenario",
          phase: "ui",
          outcome: "failed",
          exitCode: null,
          summary: "Observed failure.",
        },
      ],
    },
    evidenceContext: { assets: [], scenarios: [] },
  };
  let candidate: unknown = issue
    ? {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "issue",
        summary: "The observed scenario is consistent with the reported issue.",
        reproductionConclusion: "confirmed",
        observations: [],
      }
    : {
        schemaVersion: "ValidationSummaryV1",
        workItemKind: "pull_request",
        summary: "The failed assertion needs review.",
        recommendation: "request_changes",
        observations: [],
      };
  let observedFileChange = false;
  const run = vi.fn<
    (value: PreparedCliOutputInput<TSchema>) => Promise<PreparedCliOutputResult<unknown>>
  >(async (value) => {
    const canonical = createCanonicalResult(candidate);
    return {
      outcome: "succeeded",
      result: candidate,
      canonicalResultJson: canonical.json,
      resultDigest: canonical.sha256,
      commandEvidence: { commands: [], commandCapture: "complete" },
      observedFileChange,
      cliExecution: {
        engine: "codex",
        cliVersion: "fixture-version",
        requestedModel: null,
        processRequestId: "summary-process",
        startedAt: now,
        completedAt: "2026-09-08T00:00:01.000Z",
        promptSha256: hash(value.prompt),
        actualPromptSha256: hash(value.prompt),
        outputSchemaSha256: value.authoritativeSchema.digest,
        modelOutputSha256: canonical.sha256,
      },
    };
  });
  const model = workspace("model");
  const capture = vi.fn<NonNullable<PreparedJobWorkspace["captureWorktreeState"]>>(
    async () => "clean",
  );
  Reflect.set(model, "captureWorktreeState", capture);
  const prepare = vi.fn<JobWorkspaceProvider["prepare"]>(async () => model);
  const cleanups: Array<() => Promise<void>> = [];
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    processHost: { start: vi.fn(), terminateAll: vi.fn(), close: vi.fn() },
    reportProgress: vi.fn(),
    reportNodeHealthFault: vi.fn(),
    deferCleanup: (cleanup: () => Promise<void>) => {
      cleanups.push(cleanup);
    },
  } satisfies JobExecutionContext;
  const options: ValidationSummaryExecutorOptions = {
    workspaceProvider: { prepare },
    outputRunner: { run: run as PreparedCliOutputRunner["run"] },
    now: () => Date.parse(now),
    ...overrides,
  };
  const executor = new ValidationSummaryExecutor(options);
  return {
    options,
    input,
    context,
    executor,
    model,
    capture,
    prepare,
    run,
    controller,
    cleanups,
    setCandidate: (value: unknown) => {
      candidate = value;
    },
    candidate: () => candidate as ValidationSummaryV1,
    observeWrite: () => {
      observedFileChange = true;
    },
  };
}

afterEach(() => vi.useRealTimers());

function summaryReceipt(
  envelope: JobExecutionEnvelopeV2,
  request: FreezeValidationSummaryInputRequest,
): FreezeValidationSummaryInputResponse {
  const validation = envelope.validation;
  if (validation.schemaVersion !== "ValidationJobContextV2")
    throw new Error("Expected an evaluation fixture.");
  const canonical = createCanonicalResult(request.context);
  const actualPromptSha256 = hash(
    composeSummaryPrompt(envelope.prompt.renderedPrompt, canonical.json),
  );
  const document: FrozenValidationSummaryInputV1 = {
    schemaVersion: "FrozenValidationSummaryInputV1",
    inputId: request.inputId,
    repositoryId: validation.repositoryId,
    evaluationId: validation.purpose.evaluationId,
    cellId: validation.purpose.cellId,
    authorizationId: validation.authorization.id,
    executionManifestSha256: validation.purpose.executionManifestSha256,
    workerNodeId: envelope.lease.workerNodeId,
    workerInstanceId: envelope.lease.workerInstanceId,
    leaseGeneration: envelope.lease.leaseGeneration,
    sourcePromptSha256: envelope.prompt.promptSha256,
    outputSchemaSha256: envelope.prompt.outputSchemaSha256,
    contextSha256: canonical.sha256,
    actualPromptSha256,
    context: structuredClone(request.context),
    frozenAt: now,
  };
  return {
    schemaVersion: "FreezeValidationSummaryInputResponseV1",
    frozenAt: document.frozenAt,
    reference: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: request.inputId,
      inputSha256: createCanonicalResult(document).sha256,
      sourcePromptSha256: document.sourcePromptSha256,
      outputSchemaSha256: document.outputSchemaSha256,
      contextSha256: canonical.sha256,
      actualPromptSha256,
    },
  };
}

function evaluationSummaryFixture() {
  const f = fixture(true);
  Reflect.set(f.input, "envelope", modelArtifactEvaluationFixture("issue").envelope);
  f.input.runnerReport.checks.length = 0;
  f.input.runnerExecution.diagnostics.length = 0;
  return f;
}

function attachEvidence(f: ReturnType<typeof fixture>) {
  const scope = f.input.envelope.validation;
  const common = {
    repositoryId: scope.repositoryId,
    runId: scope.runId,
    requestId: scope.requestId,
    jobId: f.input.envelope.job.jobId,
    runAttemptId: f.input.envelope.lease.runAttemptId,
    profileVersionId: scope.profileVersion.id,
    revisionKey: scope.revisionKey,
    planDigest: scope.planDigest,
    state: "finalized" as const,
    createdAt: now,
    finalizedAt: now,
    retiredAt: null,
  };
  const assets: EvidenceAssetManifest[] = [
    {
      ...common,
      id: "server-shot",
      metadata: {
        kind: "screenshot",
        mediaType: "image/png",
        sizeBytes: 10,
        sha256: "a".repeat(64),
        capturedAt: now,
        checkId: "profile-version:scenario",
      },
    },
    {
      ...common,
      id: "server-steps",
      metadata: {
        kind: "steps",
        mediaType: "application/json",
        sizeBytes: 20,
        sha256: "b".repeat(64),
        capturedAt: now,
        checkId: "profile-version:scenario",
      },
    },
  ];
  const evidence = {
    assets,
    scenarios: [
      {
        checkId: "profile-version:scenario",
        execution: {
          schemaVersion: "UiScenarioExecutionEvidenceV1" as const,
          source: "ui_driver" as const,
          target: "windows_desktop" as const,
          scenarioId: "scenario",
          steps: [
            {
              stepId: "assertion",
              name: "Check fixture",
              action: "assertText" as const,
              expected: "Ready",
              actual: "Broken",
              outcome: "failed" as const,
              summary: "Recorded mismatch",
              evidenceIds: ["server-shot"],
            },
          ],
        },
      },
    ],
  };
  f.input.runnerReport.checks[0]!.evidenceIds = ["server-shot", "server-steps"];
  const serialized = JSON.stringify(evidence.scenarios[0]!.execution);
  evidence.assets[1]!.metadata.sha256 = hash(serialized);
  evidence.assets[1]!.metadata.sizeBytes = Buffer.byteLength(serialized, "utf8");
  Reflect.set(f.input, "evidenceContext", evidence);
  return evidence;
}

describe("optional ValidationSummary executor", () => {
  it("freezes an evaluation context and retains the direct CLI output association", async () => {
    const f = evaluationSummaryFixture();
    const freezeValidationSummaryInput = vi.fn(
      async (request: FreezeValidationSummaryInputRequest) =>
        summaryReceipt(f.input.envelope, request),
    );
    const executor = new ValidationSummaryExecutor({
      ...f.options,
      summaryInputApi: { freezeValidationSummaryInput },
    });
    const completed = await executor.execute(f.input, f.context);
    expect(completed).toMatchObject({
      state: "completed",
      modelOutputArtifact: {
        execution: {
          schemaVersion: "CliModelExecutionV1",
          jobId: f.input.envelope.lease.jobId,
          runAttemptId: f.input.envelope.lease.runAttemptId,
          cli: { kind: "codex", version: "fixture-version", requestedModel: null },
          summaryInputRef: { contextSha256: createValidationSummaryContext(f.input).sha256 },
        },
      },
    });
    expect(freezeValidationSummaryInput).toHaveBeenCalledOnce();
    expect(freezeValidationSummaryInput.mock.calls[0]?.[0]).toMatchObject({
      lease: f.input.envelope.lease,
      context: JSON.parse(createValidationSummaryContext(f.input).json),
    });
    expect(f.run.mock.calls[0]?.[0].launchPolicy).toBe("summary_read_only");
    expect(f.input.runnerReport.modelSummary).toBeUndefined();
    expect(f.capture).toHaveBeenCalledTimes(2);
  });

  it.each([
    "inputId",
    "inputSha256",
    "contextSha256",
    "actualPromptSha256",
    "sourcePromptSha256",
    "outputSchemaSha256",
  ] as const)(
    "rejects a summary input receipt with an altered %s before running the CLI",
    async (field) => {
      const f = evaluationSummaryFixture();
      const freezeValidationSummaryInput = vi.fn(
        async (request: FreezeValidationSummaryInputRequest) => {
          const receipt = summaryReceipt(f.input.envelope, request);
          receipt.reference[field] = field === "inputId" ? "foreign-input" : "0".repeat(64);
          return receipt;
        },
      );
      const executor = new ValidationSummaryExecutor({
        ...f.options,
        summaryInputApi: { freezeValidationSummaryInput },
      });
      expect(await executor.execute(f.input, f.context)).toMatchObject({
        state: "failed",
        code: "SUMMARY_EXECUTION_FAILED",
      });
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("rejects a receipt computed for another execution even when its visible context hashes match", async () => {
    const f = evaluationSummaryFixture();
    const other = structuredClone(f.input.envelope);
    if (other.validation.schemaVersion !== "ValidationJobContextV2")
      throw new Error("Expected an evaluation fixture.");
    other.validation.purpose.cellId = "another-cell";
    const freezeValidationSummaryInput = vi.fn(
      async (request: FreezeValidationSummaryInputRequest) => summaryReceipt(other, request),
    );
    const executor = new ValidationSummaryExecutor({
      ...f.options,
      summaryInputApi: { freezeValidationSummaryInput },
    });
    expect(await executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_EXECUTION_FAILED",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("requires evaluation context storage without requiring a model service", async () => {
    const f = evaluationSummaryFixture();
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_INPUT_UNAVAILABLE",
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("propagates cancellation during input freezing without launching the CLI", async () => {
    const f = evaluationSummaryFixture();
    const freezeValidationSummaryInput = vi.fn(
      (_request: FreezeValidationSummaryInputRequest, signal?: AbortSignal) =>
        new Promise<FreezeValidationSummaryInputResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const executor = new ValidationSummaryExecutor({
      ...f.options,
      summaryInputApi: { freezeValidationSummaryInput },
    });
    const pending = executor.execute(f.input, f.context);
    await vi.waitFor(() => expect(freezeValidationSummaryInput).toHaveBeenCalledOnce());
    const lost = new LeaseLostError("Fixture lease lost", "lease_rejected");
    f.controller.abort(lost);
    await expect(pending).rejects.toBe(lost);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("keeps ordinary advice independent of evaluation context storage", async () => {
    const f = fixture();
    const freezeValidationSummaryInput = vi.fn(async () => {
      throw new Error("Ordinary advice has no evaluation input.");
    });
    const executor = new ValidationSummaryExecutor({
      ...f.options,
      summaryInputApi: { freezeValidationSummaryInput },
    });
    expect(await executor.execute(f.input, f.context)).toMatchObject({ state: "completed" });
    expect(freezeValidationSummaryInput).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "retains Copilot advice with incomplete command capture and an unchanged worktree (evaluation=%s)",
    async (evaluation) => {
      const f = evaluation ? evaluationSummaryFixture() : fixture();
      const originalRun = f.run.getMockImplementation();
      if (!originalRun) throw new Error("Missing synthetic output runner.");
      f.run.mockImplementation(async (input) => {
        const result = await originalRun(input);
        if (result.outcome === "failed") return result;
        return {
          ...result,
          commandEvidence: { commands: [], commandCapture: "incomplete" },
          cliExecution: { ...result.cliExecution, engine: "copilot" },
        };
      });
      const executor = new ValidationSummaryExecutor({
        ...f.options,
        summaryInputApi: {
          freezeValidationSummaryInput: async (request) =>
            summaryReceipt(f.input.envelope, request),
        },
      });
      const result = await executor.execute(f.input, f.context);
      expect(result).toMatchObject({ state: "completed" });
      if (evaluation)
        expect(result).toMatchObject({
          modelOutputArtifact: {
            execution: { cli: { kind: "copilot" } },
            executionEvidence: { commandCapture: "incomplete" },
          },
        });
      expect(f.capture).toHaveBeenCalledTimes(2);
    },
  );

  it("passes scoped finalized manifests and remapped typed UI observations as read-only context", async () => {
    const f = fixture();
    const evidence = attachEvidence(f);
    const before = createCanonicalResult(evidence);
    expect((await f.executor.execute(f.input, f.context)).state).toBe("completed");
    expect(f.run.mock.calls[0]?.[0].prompt).toContain('"evidenceIds":["server-shot"]');
    expect(f.run.mock.calls[0]?.[0].prompt).toContain('"actual":"Broken"');
    expect(createCanonicalResult(evidence)).toStrictEqual(before);
  });

  it.each([
    "foreign attempt",
    "duplicate asset",
    "missing asset",
    "local ID",
    "wrong scenario",
    "missing observations",
    "changed action",
    "changed expected",
    "changed name",
    "changed body digest",
    "changed body size",
  ])("rejects evidence context with %s", async (changed) => {
    const f = fixture();
    const evidence = attachEvidence(f);
    if (changed === "foreign attempt") evidence.assets[0]!.runAttemptId = "another-attempt";
    if (changed === "duplicate asset") evidence.assets.push(evidence.assets[0]!);
    if (changed === "missing asset") evidence.assets.pop();
    if (changed === "local ID")
      evidence.scenarios[0]!.execution.steps[0]!.evidenceIds = ["local-shot"];
    if (changed === "wrong scenario")
      evidence.scenarios[0]!.execution.scenarioId = "another-scenario";
    if (changed === "missing observations") evidence.scenarios.length = 0;
    if (changed === "changed action")
      Reflect.set(evidence.scenarios[0]!.execution.steps[0]!, "action", "assertValue");
    if (changed === "changed expected")
      evidence.scenarios[0]!.execution.steps[0]!.expected = "Different";
    if (changed === "changed name") evidence.scenarios[0]!.execution.steps[0]!.name = "Different";
    if (changed === "changed body digest") evidence.assets[1]!.metadata.sha256 = "0".repeat(64);
    if (changed === "changed body size") evidence.assets[1]!.metadata.sizeBytes += 1;
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_CONTEXT_INVALID",
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "produces strict advice from an independent model workspace (Issue=%s)",
    async (issue) => {
      const f = fixture(issue);
      const before = createCanonicalResult({
        report: f.input.runnerReport,
        execution: f.input.runnerExecution,
        evidence: f.input.evidenceContext,
      });
      const result = await f.executor.execute(f.input, f.context);
      expect(result).toMatchObject({
        state: "completed",
        summary: f.candidate(),
        promptSha256: f.input.envelope.prompt.promptSha256,
        contextSha256: createValidationSummaryContext(f.input).sha256,
      });
      expect(f.prepare.mock.calls[0]?.[0]).toStrictEqual(f.input.envelope);
      expect(f.prepare.mock.calls[0]?.[2]).toBe("model");
      expect(f.capture).toHaveBeenCalledTimes(2);
      expect(f.run.mock.calls[0]?.[0]).toMatchObject({
        launchPolicy: "summary_read_only",
        hardTimeoutMs: 60_000,
        correlationId: "attempt",
      });
      expect(f.run.mock.calls[0]?.[0].context.signal).not.toBe(f.context.signal);
      expect(f.run.mock.calls[0]?.[0].context.attemptSignal).toBe(f.context.signal);
      expect(f.run.mock.calls[0]?.[0].prompt).toBe(
        composeSharedSummaryPrompt(
          f.input.envelope.prompt.renderedPrompt,
          createSharedSummaryContext(f.input).json,
        ),
      );
      expect(
        createCanonicalResult({
          report: f.input.runnerReport,
          execution: f.input.runnerExecution,
          evidence: f.input.evidenceContext,
        }),
      ).toStrictEqual(before);
      expect(f.model.cleanup).not.toHaveBeenCalled();
      await f.cleanups[0]?.();
      await f.cleanups[0]?.();
      expect(f.model.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("preserves an inherited attempt owner when deriving the summary runner budget", async () => {
    const f = fixture();
    const owner = new AbortController();
    expect(
      await f.executor.execute(f.input, { ...f.context, attemptSignal: owner.signal }),
    ).toMatchObject({ state: "completed" });
    const capturedContext = f.run.mock.calls[0]?.[0].context;
    expect(capturedContext?.attemptSignal).toBe(owner.signal);
    expect(capturedContext?.signal).not.toBe(owner.signal);
    expect(capturedContext?.signal).not.toBe(f.context.signal);
  });

  it("keeps dynamic context hashes separate from the unchanged frozen prompt hash", async () => {
    const first = fixture();
    const second = fixture();
    second.input.runnerReport.checks[0]!.actual = "Another failure";
    const a = await first.executor.execute(first.input, first.context);
    const b = await second.executor.execute(second.input, second.context);
    if (a.state !== "completed" || b.state !== "completed")
      throw new Error("Fixture summary failed");
    expect(a.promptSha256).toBe(b.promptSha256);
    expect(a.contextSha256).not.toBe(b.contextSha256);
    const prompt = first.run.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt.startsWith(first.input.envelope.prompt.renderedPrompt)).toBe(true);
    expect(prompt).toContain('"outcome":"failed"');
    expect(prompt).toContain('"actual":"Broken"');
    expect(prompt).not.toContain(first.input.envelope.lease.leaseToken);
  });

  it("snapshots caller context before asynchronous model workspace preparation", async () => {
    const f = fixture();
    const prepared = Promise.withResolvers<PreparedJobWorkspace>();
    f.prepare.mockReturnValue(prepared.promise);
    const pending = f.executor.execute(f.input, f.context);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    f.input.runnerReport.checks[0]!.outcome = "passed";
    f.input.envelope.prompt.renderedPrompt = "changed after snapshot";
    prepared.resolve(f.model);
    expect((await pending).state).toBe("completed");
    expect(f.run.mock.calls[0]?.[0].prompt).toContain('"outcome":"failed"');
    expect(f.run.mock.calls[0]?.[0].prompt).not.toContain("changed after snapshot");
  });

  it.each(["prompt bytes", "schema bytes", "schema digest", "workflow", "profile digest"])(
    "rejects altered %s before preparing a workspace",
    async (changed) => {
      const f = fixture();
      if (changed === "prompt bytes") f.input.envelope.prompt.renderedPrompt += "changed";
      if (changed === "schema bytes") f.input.envelope.prompt.outputSchema = { type: "object" };
      if (changed === "schema digest") f.input.envelope.prompt.outputSchemaSha256 = "0".repeat(64);
      if (changed === "workflow") f.input.envelope.validation.workflowKind = "pr_static_build";
      if (changed === "profile digest")
        f.input.envelope.validation.profileVersion.configSha256 = "0".repeat(64);
      expect(await f.executor.execute(f.input, f.context)).toMatchObject({
        state: "failed",
        code: "SUMMARY_ENVELOPE_INVALID",
      });
      expect(f.prepare).not.toHaveBeenCalled();
    },
  );

  it("rejects omitted failed checks and model-owned input fields instead of silently shrinking context", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.input.runnerReport.checks = [];
      },
      (f: ReturnType<typeof fixture>) => {
        f.input.runnerReport.checks[0]!.source = "model";
      },
      (f: ReturnType<typeof fixture>) => {
        Reflect.set(f.input.runnerReport, "modelSummary", f.candidate());
      },
    ]) {
      const f = fixture();
      mutate(f);
      expect(await f.executor.execute(f.input, f.context)).toMatchObject({
        state: "failed",
        code: "SUMMARY_CONTEXT_INVALID",
      });
      expect(f.run).not.toHaveBeenCalled();
    }
  });

  it("rejects an oversized combined prompt and context without truncating the failed report", async () => {
    const f = fixture();
    const prompt = "p".repeat(512 * 1024);
    f.input.envelope.prompt.renderedPrompt = prompt;
    f.input.envelope.prompt.promptSha256 = hash(prompt);
    const before = structuredClone(f.input.runnerReport);
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_CONTEXT_TOO_LARGE",
    });
    expect(f.input.runnerReport).toStrictEqual(before);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each(["runner context", "model output"])(
    "does not retain protected values from %s",
    async (source) => {
      const f = fixture(false, { sensitiveValues: ["protected-fixture-value"] });
      if (source === "runner context") f.input.runnerReport.summary = "protected-fixture-value";
      else f.setCandidate({ ...f.candidate(), summary: "protected-fixture-value" });
      const result = await f.executor.execute(f.input, f.context);
      expect(result.state).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("protected-fixture-value");
    },
  );

  it("permits explicitly classified public metadata while retaining exact secret checks", async () => {
    const unclassified = fixture(false, { sensitiveValues: ["worker"] });
    expect(unclassified.input.runnerReport.source).toBe("worker");
    expect(
      await unclassified.executor.execute(unclassified.input, unclassified.context),
    ).toMatchObject({
      state: "failed",
      code: "SUMMARY_CONTEXT_UNSAFE",
    });
    expect(unclassified.run).not.toHaveBeenCalled();

    const classified = fixture(false, { sensitiveValues: ["protected-fixture-value"] });
    expect(await classified.executor.execute(classified.input, classified.context)).toMatchObject({
      state: "completed",
    });
    expect(classified.run).toHaveBeenCalledOnce();
    expect(classified.run.mock.calls[0]?.[0].sensitiveValues).toEqual([
      classified.input.envelope.lease.leaseToken,
      "protected-fixture-value",
    ]);
    const unsafe = fixture(false, { sensitiveValues: ["protected-fixture-value"] });
    unsafe.input.runnerReport.summary = "protected-fixture-value";
    expect(await unsafe.executor.execute(unsafe.input, unsafe.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_CONTEXT_UNSAFE",
    });
    expect(unsafe.run).not.toHaveBeenCalled();
  });

  it("detects protected values even when JSON escaping changes their serialized bytes", async () => {
    const secret = 'protected\n"quoted"\\value';
    const f = fixture(false, { sensitiveValues: [secret] });
    f.input.runnerReport.summary = secret;
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_CONTEXT_UNSAFE",
    });
    const output = fixture(false, { sensitiveValues: [secret] });
    output.setCandidate({ ...output.candidate(), summary: secret });
    expect(await output.executor.execute(output.input, output.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_RESULT_UNSAFE",
    });
  });

  it.each(["modified", "unknown"] as const)(
    "discards advice from a model source observed as %s",
    async (source) => {
      const f = fixture();
      f.capture.mockResolvedValueOnce("clean").mockResolvedValue(source);
      const report = structuredClone(f.input.runnerReport);
      const result = await f.executor.execute(f.input, f.context);
      expect(result).toMatchObject({
        state: "failed",
        code: source === "modified" ? "SUMMARY_CONTEXT_MODIFIED" : "SUMMARY_CONTEXT_UNKNOWN",
      });
      expect(result).not.toHaveProperty("summary");
      expect(f.input.runnerReport).toStrictEqual(report);
      expect(f.input.runnerExecution.blockers).toStrictEqual([]);
    },
  );

  it("does not infer pristine execution from final Git status after an observed write", async () => {
    const f = fixture();
    f.observeWrite();
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_CONTEXT_MODIFIED",
    });
  });

  it("does not launch on an initially unknown model source", async () => {
    const f = fixture();
    f.capture.mockResolvedValue("unknown");
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_CONTEXT_UNKNOWN",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("does not clean an aliased validation workspace returned as the model workspace", async () => {
    const f = fixture();
    f.prepare.mockResolvedValue(f.input.validationWorkspace);
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_WORKSPACE_NOT_ISOLATED",
    });
    expect(f.context.reportNodeHealthFault).toHaveBeenCalledOnce();
    await f.cleanups[0]?.();
    expect(f.input.validationWorkspace.cleanup).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([
    { checks: [] },
    { sourceState: "original" },
    { execution: {} },
    { evidenceComplete: true },
    { workItemKind: "issue", reproductionConclusion: "confirmed" },
  ])("rejects injected or wrong-branch output %#", async (injected) => {
    const f = fixture();
    f.setCandidate({ ...f.candidate(), ...injected });
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_RESULT_INVALID",
    });
  });

  it.each([
    { path: null, line: 1 },
    { path: "src/../file.ts", line: 1 },
    { path: "src//file.ts", line: 1 },
    { path: "C:/file.ts", line: 1 },
    { path: "src/\ud800.ts", line: 1 },
    { path: "src/\u007f.ts", line: 1 },
  ])("rejects ambiguous observation source locations %#", async (location) => {
    const f = fixture();
    f.setCandidate({
      ...f.candidate(),
      observations: [
        { id: "note", title: "Observed issue", body: "Details", priority: 1, ...location },
      ],
    });
    const result = await f.executor.execute(f.input, f.context);
    expect(result.state).toBe("failed");
    expect(result).not.toHaveProperty("summary");
  });

  it("rejects duplicate observation identities while allowing a path without a line", async () => {
    const f = fixture();
    const observation = {
      id: "note",
      title: "Observed issue",
      body: "Details",
      priority: 1,
      path: "src/file.ts",
      line: null,
    };
    f.setCandidate({ ...f.candidate(), observations: [observation] });
    expect((await f.executor.execute(f.input, f.context)).state).toBe("completed");
    const other = fixture();
    other.setCandidate({ ...other.candidate(), observations: [observation, observation] });
    expect(await other.executor.execute(other.input, other.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_RESULT_INVALID",
    });
  });

  it("reserves terminal/cleanup time instead of starting an unaffordable summary", async () => {
    const f = fixture();
    f.input.envelope.executionDeadlineAt = "2026-09-08T00:00:35.000Z";
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_BUDGET_UNAVAILABLE",
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("does not restart the frozen job hard-timeout budget after validation has already consumed it", async () => {
    const f = fixture(false, { now: () => Date.parse(now) + 60_000 });
    f.input.envelope.executionDeadlineAt = "2026-09-08T00:10:00.000Z";
    expect((await f.executor.execute(f.input, f.context)).state).toBe("completed");
    expect(f.run.mock.calls[0]?.[0].hardTimeoutMs).toBe(25_000);
    expect(f.run.mock.calls[0]?.[0].teardownTimeoutMs).toBe(5_000);
    expect(Object.isFrozen(f.prepare.mock.calls[0]?.[0])).toBe(true);
  });

  it("finishes the optional child before an otherwise silent attempt loses its no-progress lease", async () => {
    const f = fixture();
    f.input.envelope.executionPolicy.noProgressTimeoutMs = 60_000;
    expect((await f.executor.execute(f.input, f.context)).state).toBe("completed");
    expect(f.run.mock.calls[0]?.[0].hardTimeoutMs).toBe(50_000);
  });

  it("does not consume the teardown and completion reserve from a short no-progress window", async () => {
    const f = fixture();
    f.input.envelope.executionPolicy.noProgressTimeoutMs = 15_000;
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_BUDGET_UNAVAILABLE",
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("uses distinct hard-deadline and no-progress reserves for the default 30-second no-progress window", async () => {
    const f = fixture();
    f.input.envelope.executionPolicy.noProgressTimeoutMs = 30_000;
    expect((await f.executor.execute(f.input, f.context)).state).toBe("completed");
    expect(f.run.mock.calls[0]?.[0].hardTimeoutMs).toBe(20_000);
    expect(f.run.mock.calls[0]?.[0].teardownTimeoutMs).toBe(5_000);
  });

  it("rejects valid but oversized summary JSON instead of losing the completed runner report", async () => {
    const f = fixture();
    const original = createCanonicalResult(f.input.runnerReport);
    f.setCandidate({
      ...f.candidate(),
      observations: Array.from({ length: 100 }, (_, index) => ({
        id: `observation-${index}`,
        title: "Large observation",
        body: "\u0001".repeat(4096),
        priority: 2,
        path: null,
        line: null,
      })),
    });
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      code: "SUMMARY_RESULT_TOO_LARGE",
    });
    expect(createCanonicalResult(f.input.runnerReport)).toStrictEqual(original);
  });

  it("times out an optional child without aborting its parent or changing validation facts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.run.mockImplementation(
      (input) =>
        new Promise((_resolve, reject) =>
          input.context.signal.addEventListener(
            "abort",
            () => reject(input.context.signal.reason),
            { once: true },
          ),
        ),
    );
    const result = f.executor.execute(f.input, f.context);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toMatchObject({ state: "failed", code: "SUMMARY_TIMEOUT" });
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.input.runnerReport.checks[0]?.outcome).toBe("failed");
    expect(f.input.runnerExecution.blockers).toStrictEqual([]);
  });

  it("propagates actual lease loss rather than converting it to optional failure", async () => {
    const f = fixture();
    const lost = new LeaseLostError("Fixture lease lost", "lease_rejected");
    f.capture.mockRejectedValue(lost);
    await expect(f.executor.execute(f.input, f.context)).rejects.toBe(lost);
    const cancelled = fixture();
    cancelled.controller.abort(lost);
    await expect(cancelled.executor.execute(cancelled.input, cancelled.context)).rejects.toBe(lost);
  });

  it("distinguishes unconfirmed process teardown from ordinary optional model failure", async () => {
    const f = fixture();
    f.run.mockImplementation(async (input) => {
      const fault = Object.assign(new Error("A model process did not settle"), {
        code: "CLI_STREAM_FAILED",
      });
      input.context.reportNodeHealthFault(fault);
      throw fault;
    });
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      nodeFault: true,
      cleanupUnconfirmed: true,
    });
    expect(f.context.reportNodeHealthFault).toHaveBeenCalledOnce();
    expect(f.input.runnerExecution.blockers).toStrictEqual([]);
    const ordinary = fixture();
    ordinary.run.mockRejectedValue(new Error("Invalid model response"));
    const result = await ordinary.executor.execute(ordinary.input, ordinary.context);
    expect(result.state).toBe("failed");
    expect(result).not.toHaveProperty("nodeFault");
    expect(result).not.toHaveProperty("cleanupUnconfirmed");
  });

  it("does not publish advice after a health fault observed during final source verification", async () => {
    const f = fixture();
    f.capture.mockResolvedValueOnce("clean").mockImplementationOnce(async () => {
      f.run.mock.calls[0]?.[0].context.reportNodeHealthFault(
        Object.assign(new Error("Late source observation fault"), { code: "CLI_PROCESS_FAILED" }),
      );
      return "clean";
    });
    expect(await f.executor.execute(f.input, f.context)).toMatchObject({
      state: "failed",
      nodeFault: true,
      cleanupUnconfirmed: true,
    });
  });

  it("retains a valid late-prepared workspace for cleanup after optional cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const prepared = Promise.withResolvers<PreparedJobWorkspace>();
    f.prepare.mockReturnValue(prepared.promise);
    const result = f.executor.execute(f.input, f.context);
    await vi.advanceTimersByTimeAsync(60_000);
    prepared.resolve(f.model);
    await expect(result).resolves.toMatchObject({ state: "failed", code: "SUMMARY_TIMEOUT" });
    await f.cleanups[0]?.();
    expect(f.model.cleanup).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
  });
});
