import { createHash } from "node:crypto";
import {
  createCanonicalResult,
  type IssueTriageV2,
  IssueTriageV2ModelOutputSchema,
  type PrReviewPlanV2,
  PrReviewPlanV2ModelOutputSchema,
  type ValidationJobResultV1,
  ValidationJobResultV1Schema,
  type ValidationJobResultV2,
  ValidationJobResultV2Schema,
} from "@agentic-review/codex";
import {
  type EvidenceAssetManifest,
  GitHubWorkItemSchema,
  type IssueReproductionBindingV1,
  IssueValidationSummaryV1Schema,
  type JobExecutionEnvelopeV2,
  type ModelInvocationScopeV1,
  type ObservationValue,
  PullRequestValidationSummaryV1Schema,
  type ValidationJobContextV2,
  ValidationJobContextV2Schema,
  type ValidationProfileVersion,
  type ValidationSummaryV1,
} from "@agentic-review/contracts";
import { modelInvocationScopeDigest } from "@agentic-review/domain";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaseLostError } from "../leases/errors.js";
import {
  EvidenceUploadError,
  type EvidenceUploadResult,
  type UiScenarioEvidenceUploadInput,
} from "./evidence-uploader.js";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "./job-executor.js";
import {
  JobWorkspaceError,
  type JobWorkspaceProvider,
  type PreparedJobWorkspace,
} from "./job-workspace.js";
import type { ModelInvocationSessionResult } from "./model-invocation-coordinator.js";
import { type CreateModelInvocation, createModelOutputArtifact } from "./model-output-artifact.js";
import type {
  PreparedCodexOutputInput,
  PreparedCodexOutputResult,
} from "./prepared-codex-output-runner.js";
import { PreparedCodexOutputRunner } from "./prepared-codex-output-runner.js";
import { evaluationProfileEnvelopeFixture } from "./profile-envelope.testing.js";
import { ProfileJobExecutor, type ProfileJobExecutorOptions } from "./profile-job-executor.js";
import { ReviewJobExecutor } from "./review-executor.js";
import { captureTestProbeOutput } from "./test-probe-capture.js";
import type { UiProfileResult } from "./ui-profile-runner.js";
import type { HeadlessValidationCheckResult } from "./validation-check-runner.js";
import {
  composeSummaryPrompt,
  createValidationSummaryContext,
  type ValidationSummaryAttempt,
  ValidationSummaryExecutor,
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
    codexHomeDirectory: `${root}\\codex`,
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
function observed(ui = false): HeadlessValidationCheckResult {
  const id = `profile-version:${ui ? "scenario" : "test"}`;
  return {
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      sourceState: "original",
      workItemKind: "pull_request",
      summary: "Original validation completed.",
      checks: [
        {
          id,
          name: "Configured check",
          kind: ui ? "ui" : "test",
          required: true,
          outcome: "passed",
          summary: "Check passed.",
          expected: "Ready",
          actual: "Ready",
          evidenceIds: ui ? ["local-steps"] : [],
          source: "runner",
        },
      ],
    },
    blockers: [],
    diagnostics: [
      {
        stepId: id,
        phase: ui ? "ui" : "test",
        outcome: "passed",
        exitCode: ui ? null : 0,
        summary: "Observed check passed.",
      },
    ],
    cleanupState: "not_needed",
  };
}
function uiObserved(): UiProfileResult {
  const base = observed(true);
  const files = [
    {
      id: "local-shot",
      relativePath: "windows-fixture/shot.png",
      kind: "screenshot" as const,
      mediaType: "image/png" as const,
      sizeBytes: 10,
      sha256: "a".repeat(64),
    },
    {
      id: "local-steps",
      relativePath: "windows-fixture/steps.json",
      kind: "ui_steps" as const,
      mediaType: "application/json" as const,
      sizeBytes: 20,
      sha256: "b".repeat(64),
    },
  ];
  return {
    ...base,
    diagnostics: [
      ...base.diagnostics,
      {
        stepId: "profile-version:launch",
        phase: "launch",
        outcome: "passed",
        exitCode: null,
        summary: "Owned launch was ready.",
      },
    ],
    evidenceFiles: files.map((file) => ({
      ...file,
      evidenceDirectory: "C:\\Evidence",
      scenarioCheckId: "profile-version:scenario",
    })),
    scenarioEvidence: [
      {
        scenarioCheckId: "profile-version:scenario",
        evidenceDirectory: "C:\\Evidence",
        evidenceFiles: files,
        execution: {
          schemaVersion: "UiScenarioExecutionEvidenceV1",
          source: "ui_driver",
          scenarioId: "scenario",
          target: "windows_desktop",
          steps: [
            {
              stepId: "assertion",
              name: "Check fixture",
              action: "assertText",
              expected: "Ready",
              actual: "Ready",
              outcome: "passed",
              summary: "Matched.",
              evidenceIds: ["local-shot"],
            },
          ],
        },
      },
    ],
  };
}
function review(): PrReviewPlanV2 {
  return {
    schemaVersion: "PrReviewPlanV2",
    summary: "Review completed.",
    assessment: "approve",
    findings: [],
    requestedRecipeIds: [],
    verification: { status: "not_run", summary: "Runner owns verification.", commands: [] },
    executionEvidence: {
      schemaVersion: "ReviewExecutionEvidenceV1",
      source: "worker",
      commandCapture: "complete",
      commands: [],
      worktree: { status: "modified", source: "git_status" },
    },
  };
}
function issueReview(): IssueTriageV2 {
  const evidence = review();
  return {
    schemaVersion: "IssueTriageV2",
    summary: "Issue triage completed.",
    category: "bug",
    priority: 2,
    confidence: 0.8,
    suggestedLabels: [],
    missingInformation: [],
    duplicateCandidates: [],
    requestedRecipeIds: [],
    verification: evidence.verification,
    executionEvidence: evidence.executionEvidence,
  };
}
function uploadResult(input: UiScenarioEvidenceUploadInput): EvidenceUploadResult {
  const execution = structuredClone(input.execution);
  for (const step of execution.steps)
    step.evidenceIds = step.evidenceIds.map((id) => `server-${id}`);
  const serialized = JSON.stringify(execution);
  const assets: EvidenceAssetManifest[] = input.files.map((file) => ({
    id: `server-${file.id}`,
    ...input.scope,
    jobId: input.lease.jobId,
    runAttemptId: input.lease.runAttemptId,
    metadata:
      file.kind === "ui_steps"
        ? {
            kind: "steps",
            mediaType: "application/json",
            sizeBytes: Buffer.byteLength(serialized, "utf8"),
            sha256: hash(serialized),
            capturedAt: input.capturedAt,
            checkId: "profile-version:scenario",
          }
        : {
            kind: "screenshot",
            mediaType: "image/png",
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            capturedAt: input.capturedAt,
            checkId: "profile-version:scenario",
          },
    state: "finalized",
    createdAt: now,
    finalizedAt: now,
    retiredAt: null,
  }));
  return {
    assets,
    assetIds: Object.fromEntries(input.files.map((file) => [file.id, `server-${file.id}`])),
  };
}
function harness(input = envelope()) {
  const validation = workspace("validation");
  const model = workspace("model");
  const cleanups: (() => Promise<void>)[] = [];
  const cancellation = new AbortController();
  const context: JobExecutionContext = {
    signal: cancellation.signal,
    processHost: {
      start: vi.fn(async () => {
        throw new Error("Not used by the injected runners.");
      }),
      terminateAll: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    reportProgress: vi.fn(),
    reportNodeHealthFault: vi.fn(),
    deferCleanup: (cleanup) => {
      cleanups.push(cleanup);
    },
  };
  const provider: JobWorkspaceProvider = {
    prepare: vi.fn(async (_envelope, _context, purpose) =>
      purpose === "model" ? model : validation,
    ),
  };
  const headlessRunner = { run: vi.fn(async () => observed()) };
  const uiRunner = { run: vi.fn(async () => uiObserved()) };
  const legacyExecutor: JobExecutor = {
    execute: vi.fn<JobExecutor["execute"]>(async () => ({
      outcome: "failed",
      code: "LEGACY_FIXTURE",
      message: "Legacy routed.",
      retryable: false,
    })),
  };
  let modelEnvelope: Parameters<JobExecutor["execute"]>[0] | undefined;
  const createModelExecutor = vi.fn<NonNullable<ProfileJobExecutorOptions["createModelExecutor"]>>(
    (selectedProvider) => ({
      executeProfileModel: async (modelInput, scoped) => {
        modelEnvelope = modelInput;
        const prepared = await selectedProvider.prepare(modelInput, {
          signal: scoped.signal,
          processHost: scoped.processHost,
          reportProcessCount: () => undefined,
          reportNodeHealthFault: scoped.reportNodeHealthFault,
        });
        scoped.deferCleanup?.(() => prepared.cleanup());
        const result = modelInput.resource.kind === "issue" ? issueReview() : review();
        return { outcome: "succeeded", result, resultDigest: createCanonicalResult(result).sha256 };
      },
    }),
  );
  const evidenceUploader = {
    uploadUiScenarioEvidence: vi.fn(async (request: UiScenarioEvidenceUploadInput) =>
      uploadResult(request),
    ),
  };
  const options: ProfileJobExecutorOptions = {
    legacyExecutor,
    workspaceProvider: provider,
    headlessRunner,
    createUiRunner: () => uiRunner,
    createModelExecutor,
    evidenceUploader,
    now: () => new Date(now),
  };
  return {
    input,
    context,
    options,
    validation,
    model,
    provider,
    headlessRunner,
    uiRunner,
    legacyExecutor,
    createModelExecutor,
    evidenceUploader,
    cleanups,
    cancellation,
    modelEnvelope: () => modelEnvelope,
    run: () => new ProfileJobExecutor(options).execute(input, context),
  };
}

function actualModelExecutor(
  provider: JobWorkspaceProvider,
  createModelInvocation?: CreateModelInvocation,
): ReviewJobExecutor {
  return new ReviewJobExecutor({
    workspaceProvider: provider,
    codexExecutablePath: "C:\\Tools\\Codex\\codex.exe",
    codexHomeDirectory: "C:\\AgenticReview\\Profile",
    systemRoot: "C:\\Windows",
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    path: "C:\\Windows\\System32",
    pathExt: ".COM;.EXE;.BAT;.CMD",
    maximumHardTimeoutMs: 1_200_000,
    maximumProcessCount: 64,
    maximumMemoryBytes: 8_589_934_592,
    maximumOutputBytes: 67_108_864,
    ...(createModelInvocation === undefined ? {} : { createModelInvocation }),
  });
}
function recordedScope(
  input: JobExecutionEnvelopeV2,
  promptSha256 = input.prompt.promptSha256,
): ModelInvocationScopeV1 {
  return {
    schemaVersion: "ModelInvocationScopeV1",
    repositoryId: input.validation.repositoryId,
    evaluationId: "synthetic-evaluation",
    cellId: "synthetic-cell",
    runId: input.validation.runId,
    requestId: input.validation.requestId,
    jobId: input.lease.jobId,
    attemptId: input.lease.runAttemptId,
    invocationId: "synthetic-invocation",
    authorizationId: "synthetic-authorization",
    executionManifestSha256: "a".repeat(64),
    promptSha256,
    outputSchemaSha256: input.prompt.outputSchemaSha256,
    expectedModelIdentitySha256: "b".repeat(64),
    requestedModel: "synthetic-model",
    workerNodeId: input.lease.workerNodeId,
    workerInstanceId: input.lease.workerInstanceId,
    leaseGeneration: input.lease.leaseGeneration,
  };
}
function recording(scope: ModelInvocationScopeV1): ModelInvocationSessionResult {
  return {
    executionAccepted: false,
    modelOutputBound: true,
    submission: {
      schemaVersion: "ModelInvocationSubmissionV1",
      invocationId: scope.invocationId,
      scopeSha256: modelInvocationScopeDigest(scope),
      receiptSetSha256: "c".repeat(64),
      receivedAt: now,
      consistency: {
        state: "matched",
        reasons: [],
        observedIdentitySha256: scope.expectedModelIdentitySha256,
      },
      executionAccepted: false,
    },
  };
}
function typedV2(result: JobExecutionResult): ValidationJobResultV2 {
  expect(result.outcome, result.outcome === "failed" ? result.code : undefined).toBe("succeeded");
  if (result.outcome !== "succeeded" || !Value.Check(ValidationJobResultV2Schema, result.result))
    throw new Error("Expected the recorded V2 result.");
  expect(result.resultDigest).toBe(createCanonicalResult(result.result).sha256);
  return result.result;
}
function typed(result: JobExecutionResult): ValidationJobResultV1 {
  expect(result.outcome, result.outcome === "failed" ? result.code : undefined).toBe("succeeded");
  if (result.outcome !== "succeeded" || !Value.Check(ValidationJobResultV1Schema, result.result))
    throw new Error("Typed validation result missing.");
  expect(result.resultDigest).toBe(createCanonicalResult(result.result).sha256);
  return result.result;
}
function summary(issue = false): ValidationSummaryV1 {
  const common = {
    schemaVersion: "ValidationSummaryV1" as const,
    summary: "The observed result needs human review.",
    observations: [],
  };
  return issue
    ? { ...common, workItemKind: "issue", reproductionConclusion: "confirmed" }
    : { ...common, workItemKind: "pull_request", recommendation: "request_changes" };
}
function completedSummary(input: ValidationSummaryInput): ValidationSummaryAttempt {
  return {
    state: "completed",
    summary: summary(input.envelope.resource.kind === "issue"),
    contextSha256: createValidationSummaryContext(input).sha256,
    promptSha256: input.envelope.prompt.promptSha256,
  };
}
function summaryHarness(input = envelope(profile(true))) {
  const test = harness(input);
  const execute = vi.fn<ValidationSummaryExecutor["execute"]>(async (input) =>
    completedSummary(input),
  );
  const factory = vi.fn(() => ({ execute }));
  return {
    ...test,
    execute,
    factory,
    run: () =>
      new ProfileJobExecutor({ ...test.options, createSummaryExecutor: factory }).execute(
        test.input,
        test.context,
      ),
  };
}
function summaryBudget(
  input: JobExecutionEnvelopeV2,
  hardTimeoutMs = 120_000,
  noProgressTimeoutMs = 30_000,
): void {
  input.executionDeadlineAt = new Date(Date.parse(now) + hardTimeoutMs).toISOString();
  input.executionPolicy.hardTimeoutMs = hardTimeoutMs;
  input.executionPolicy.noProgressTimeoutMs = noProgressTimeoutMs;
  const profile = input.validation.profileVersion;
  profile.config.hardTimeoutMs = hardTimeoutMs;
  profile.config.noProgressTimeoutMs = noProgressTimeoutMs;
  profile.configSha256 = createCanonicalResult(profile.config).sha256;
}
function adapterHarness() {
  const test = harness(envelope(profile(true)));
  summaryBudget(test.input);
  const run = vi.fn<
    (input: PreparedCodexOutputInput<TSchema>) => Promise<PreparedCodexOutputResult<unknown>>
  >(async () => {
    const candidate = summary();
    const canonical = createCanonicalResult(candidate);
    return {
      outcome: "succeeded",
      result: candidate,
      canonicalResultJson: canonical.json,
      resultDigest: canonical.sha256,
      commandEvidence: { commands: [], commandCapture: "complete" },
      observedFileChange: false,
    };
  });
  const adapter = new ValidationSummaryExecutor({
    workspaceProvider: test.provider,
    outputRunner: { run: run as PreparedCodexOutputRunner["run"] },
    now: () => Date.parse(now),
  });
  return {
    ...test,
    output: run,
    run: () =>
      new ProfileJobExecutor({ ...test.options, createSummaryExecutor: () => adapter }).execute(
        test.input,
        test.context,
      ),
  };
}

afterEach(() => vi.useRealTimers());

function reproductionFixture(
  ui: boolean,
  value: ObservationValue = { type: "boolean", value: true },
) {
  const input = issueEnvelope(true);
  if (!ui) {
    const config = profile().config;
    const test = config.test[0];
    if (test === undefined) throw new Error("Missing test fixture.");
    test.probeOutput = {
      schemaVersion: "TestProbeOutputDeclarationV1",
      fields: [
        { id: "duplicate", description: "Whether the duplicate appeared.", type: "boolean" },
      ],
    };
    Reflect.set(input.validation, "profileVersion", {
      ...input.validation.profileVersion,
      target: "headless",
      config,
      configSha256: createCanonicalResult(config).sha256,
    });
    input.validation.target = "headless";
    input.validation.requiredCheckIds = ["profile-version:test"];
  }
  const context = input.validation;
  const binding: IssueReproductionBindingV1 = {
    schemaVersion: "IssueReproductionBindingV1",
    activationId: context.activationId,
    repositoryId: context.repositoryId,
    githubRepositoryId: 8,
    workItemId: context.workItemId,
    githubWorkItemId: 12,
    issueRevisionKey: context.revisionKey,
    testedSourceCommit: "c".repeat(40),
    authorizedBy: { issuer: "fixture-issuer", subject: "fixture-operator", authorizedAt: now },
    claim: "The operation creates a duplicate.",
    cases: [
      {
        id: "duplicate-case",
        context: "Observe the isolated fixture after one operation.",
        requestId: context.requestId,
        profileVersionId: context.profileVersion.id,
        profileConfigSha256: context.profileVersion.configSha256,
        target: context.target,
        preconditions: [],
        presentWhen: {
          allOf: [
            {
              observation: ui
                ? { kind: "ui_assertion", scenarioId: "scenario", stepId: "assertion" }
                : { kind: "probe_value", testStepId: "test", observationId: "duplicate" },
              equals: value,
            },
          ],
        },
        absentWhen: null,
      },
    ],
  };
  context.reproduction = { binding, bindingDigest: createCanonicalResult(binding).sha256 };
  const uiOutput = ui ? uiObserved() : undefined;
  const output: HeadlessValidationCheckResult = uiOutput ?? observed();
  Reflect.set(output, "report", {
    ...output.report,
    workItemKind: "issue",
    reproductionConclusion: "inconclusive",
  });
  if (uiOutput !== undefined) {
    for (const diagnostic of output.diagnostics) diagnostic.exitCode = 0;
    const step = uiOutput.scenarioEvidence[0]?.execution.steps[0];
    if (step === undefined) throw new Error("Missing UI fixture.");
    Reflect.set(step, "capture", { schemaVersion: "UiAssertionCaptureV1", state: "complete" });
    step.actual = "Duplicate";
    step.outcome = "failed";
    const check = output.report.checks[0];
    const diagnostic = output.diagnostics[0];
    if (check === undefined || diagnostic === undefined) throw new Error("Missing check fixture.");
    check.outcome = "failed";
    diagnostic.outcome = "failed";
  } else {
    const declaration = context.profileVersion.config.test[0]?.probeOutput;
    if (declaration === undefined) throw new Error("Missing probe declaration.");
    Reflect.set(output, "probeCaptures", [
      captureTestProbeOutput(
        "profile-version:test",
        JSON.stringify({
          schemaVersion: "ProbeObservationsV1",
          observations: [{ id: "duplicate", state: "observed", value }],
        }),
        declaration,
      ),
    ]);
  }
  const test = summaryHarness(input);
  if (uiOutput !== undefined) test.uiRunner.run.mockResolvedValue(uiOutput);
  else test.headlessRunner.run.mockResolvedValue(output);
  return { test, output };
}

describe("frozen Issue reproduction composition", () => {
  it("binds a settled probe receipt before optional advice and reports its deterministic conclusion", async () => {
    const { test } = reproductionFixture(false);
    const result = typed(await test.run());
    expect(result.report).toMatchObject({ reproductionConclusion: "confirmed" });
    expect(result).toMatchObject({
      reproductionAssessment: { conclusion: "confirmed", coverage: "complete" },
      probeReceipts: [
        { requestId: "request", jobId: "job", runAttemptId: "attempt", planDigest: "d".repeat(64) },
      ],
    });
    const input = test.execute.mock.calls[0]?.[0];
    expect(input?.observationResults?.reproductionAssessment?.conclusion).toBe("confirmed");
    const modelContext = input === undefined ? "" : createValidationSummaryContext(input).json;
    expect(modelContext).toContain('"claim":"The operation creates a duplicate."');
    expect(modelContext).toContain('"probeReceipts"');
    expect(modelContext).not.toContain(test.input.lease.leaseToken);
  });

  it("uses a complete failed UI assertion as the positive witness with finalized evidence IDs", async () => {
    const { test } = reproductionFixture(true, { type: "string", value: "Duplicate" });
    const result = typed(await test.run());
    expect(result).toMatchObject({
      reproductionAssessment: {
        conclusion: "confirmed",
        cases: [{ state: "present", evidenceIds: ["server-local-shot", "server-local-steps"] }],
      },
    });
    expect(result.report.checks[0]?.outcome).toBe("failed");
    expect(JSON.stringify(result)).not.toContain('"local-shot"');
  });

  it("cannot infer absence from a positive-only probe whose predicate did not match", async () => {
    const { test, output } = reproductionFixture(false);
    const capture = output.probeCaptures?.[0];
    if (capture === undefined) throw new Error("Missing capture.");
    const observation = capture.output.observations[0];
    if (observation === undefined) throw new Error("Missing observation.");
    Reflect.set(observation, "value", { type: "boolean", value: false });
    Reflect.set(capture, "outputSha256", createCanonicalResult(capture.output).sha256);
    expect(typed(await test.run())).toMatchObject({
      reproductionAssessment: { conclusion: "inconclusive" },
    });
  });

  it("retains unavailable probe fields without allowing them to match a negative signature", async () => {
    const { test, output } = reproductionFixture(false);
    const capture = output.probeCaptures?.[0];
    if (capture === undefined) throw new Error("Missing capture.");
    capture.output.observations[0] = { id: "duplicate", state: "unavailable" };
    Reflect.set(capture, "outputSha256", createCanonicalResult(capture.output).sha256);
    expect(typed(await test.run())).toMatchObject({
      reproductionAssessment: { conclusion: "blocked" },
      probeReceipts: [{ output: { observations: [{ id: "duplicate", state: "unavailable" }] } }],
    });
  });

  it.each(["missing", "digest", "duplicate", "undeclared"])(
    "rejects %s probe capture before optional model execution",
    async (kind) => {
      const { test, output } = reproductionFixture(false);
      const captures = output.probeCaptures;
      const capture = captures?.[0];
      if (capture === undefined) throw new Error("Missing capture.");
      if (kind === "missing") Reflect.deleteProperty(output, "probeCaptures");
      if (kind === "digest") Reflect.set(capture, "outputSha256", "f".repeat(64));
      if (kind === "duplicate") Reflect.set(output, "probeCaptures", [capture, capture]);
      if (kind === "undeclared") Reflect.set(capture, "checkId", "profile-version:unknown");
      expect(await test.run()).toMatchObject({ outcome: "failed" });
      expect(test.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects a changed frozen binding before preparing source or running commands", async () => {
    const { test } = reproductionFixture(false);
    if (test.input.validation.reproduction === undefined) throw new Error("Missing binding.");
    test.input.validation.reproduction.binding.claim = "Changed interpretation.";
    expect(await test.run()).toMatchObject({
      outcome: "failed",
      code: "VALIDATION_ENVELOPE_INVALID",
    });
    expect(test.provider.prepare).not.toHaveBeenCalled();
  });

  it("recomputes the conclusion after optional summary cleanup becomes unconfirmed", async () => {
    const { test } = reproductionFixture(false);
    test.execute.mockResolvedValue({
      state: "failed",
      code: "SUMMARY_NODE_FAULT",
      message: "Fixture cleanup failed.",
      nodeFault: true,
    });
    expect(typed(await test.run())).toMatchObject({
      report: { reproductionConclusion: "blocked" },
      reproductionAssessment: { conclusion: "blocked" },
    });
  });
});

describe("profile job executor", () => {
  it("attaches optional advice after finalized immutable evidence without changing runner facts", async () => {
    const test = summaryHarness();
    const frozen = structuredClone(test.input);
    test.execute.mockImplementation(async (input) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.envelope.validation.profileVersion.config)).toBe(true);
      expect(Object.isFrozen(input.runnerReport.checks[0])).toBe(true);
      expect(Object.isFrozen(input.runnerExecution.diagnostics)).toBe(true);
      expect(Object.isFrozen(input.evidenceContext.assets[0]?.metadata)).toBe(true);
      expect(Reflect.set(input.runnerReport, "sourceState", "modified")).toBe(false);
      expect(input.validationWorkspace).toBe(test.validation);
      expect(input.runnerReport.modelSummary).toBeUndefined();
      expect(input.runnerReport.checks[0]?.evidenceIds).toEqual([
        "server-local-steps",
        "server-local-shot",
      ]);
      expect(input.evidenceContext.scenarios[0]?.execution.steps[0]?.evidenceIds).toEqual([
        "server-local-shot",
      ]);
      const context = createValidationSummaryContext(input);
      expect(context.json).not.toContain('"local-shot"');
      expect(context.json).not.toContain("C:\\Evidence");
      expect(context.json).not.toContain(test.input.lease.leaseToken);
      expect(input.envelope.prompt).toEqual(frozen.prompt);
      return completedSummary(input);
    });
    const result = typed(await test.run());
    expect(result.report.modelSummary).toEqual(summary());
    expect(result.modelReview).toEqual({ state: "not_requested" });
    expect(result.report.sourceState).toBe("original");
    expect(result.report.checks[0]?.outcome).toBe("passed");
    expect(result.execution.blockers).toEqual([]);
    expect(test.input).toEqual(frozen);
    expect(test.createModelExecutor).not.toHaveBeenCalled();
  });
  it("keeps deterministic failed UI assertions when the optional model recommends approval", async () => {
    const test = summaryHarness();
    const output = uiObserved();
    const check = output.report.checks[0];
    const step = output.scenarioEvidence[0]?.execution.steps[0];
    if (check === undefined || step === undefined) throw new Error("Fixture assertion missing.");
    check.outcome = "failed";
    check.actual = "Broken";
    step.outcome = "failed";
    step.actual = "Broken";
    test.uiRunner.run.mockResolvedValue(output);
    test.execute.mockImplementation(async (input) => ({
      ...completedSummary(input),
      state: "completed",
      summary: { ...summary(), workItemKind: "pull_request", recommendation: "approve" },
      contextSha256: createValidationSummaryContext(input).sha256,
      promptSha256: input.envelope.prompt.promptSha256,
    }));
    const result = typed(await test.run());
    expect(result.report.checks[0]).toMatchObject({
      outcome: "failed",
      actual: "Broken",
      source: "runner",
    });
    expect(result.execution.diagnostics[0]?.outcome).toBe("failed");
    expect(result.report.modelSummary).toMatchObject({ recommendation: "approve" });
  });
  it("keeps issue reproduction conclusions distinct from optional model advice", async () => {
    const test = summaryHarness(issueEnvelope(true));
    const output = uiObserved();
    Reflect.set(output, "report", {
      ...output.report,
      workItemKind: "issue",
      reproductionConclusion: "inconclusive",
    });
    test.uiRunner.run.mockResolvedValue(output);
    const result = typed(await test.run());
    expect(result.report).toMatchObject({
      workItemKind: "issue",
      reproductionConclusion: "inconclusive",
      modelSummary: { workItemKind: "issue", reproductionConclusion: "confirmed" },
    });
    expect(result.modelReview).toEqual({ state: "not_requested" });
  });
  it("continues required static review without invoking the optional summary factory", async () => {
    const test = summaryHarness(envelope());
    const result = typed(await test.run());
    expect(result.modelReview.state).toBe("completed");
    expect(test.factory).not.toHaveBeenCalled();
  });
  it.each(["SUMMARY_BUDGET_UNAVAILABLE", "SUMMARY_TIMEOUT", "SUMMARY_RESULT_INVALID"])(
    "retains a valid report after optional %s without adding execution blockers",
    async (code) => {
      const test = summaryHarness();
      test.execute.mockResolvedValue({
        state: "failed",
        code,
        message: "Do not expose untrusted private model output.",
      });
      const result = typed(await test.run());
      expect(result.modelReview).toMatchObject({ state: "failed", code });
      expect(JSON.stringify(result)).not.toContain("untrusted private");
      expect(result.report.modelSummary).toBeUndefined();
      expect(result.report.checks[0]?.outcome).toBe("passed");
      expect(result.execution.blockers).toEqual([]);
      expect(test.context.reportNodeHealthFault).not.toHaveBeenCalled();
    },
  );
  it("retains runner facts if the optional factory throws", async () => {
    const test = summaryHarness();
    test.factory.mockImplementation(() => {
      throw new Error("Sensitive factory failure.");
    });
    const result = typed(await test.run());
    expect(result.modelReview).toMatchObject({ state: "failed", code: "SUMMARY_EXECUTION_FAILED" });
    expect(result.execution.blockers).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Sensitive");
  });
  it.each(["nodeFault", "cleanupUnconfirmed"] as const)(
    "blocks execution after optional %s while retaining runner checks and cleanup facts",
    async (flag) => {
      const test = summaryHarness();
      test.execute.mockResolvedValue({
        state: "failed",
        code: "PROCESS_FAILURE",
        message: "Fault.",
        [flag]: true,
      });
      const result = typed(await test.run());
      expect(result.modelReview).toMatchObject({
        state: "failed",
        code: "SUMMARY_LIFECYCLE_UNCONFIRMED",
      });
      expect(result.report.modelSummary).toBeUndefined();
      expect(result.report.checks[0]?.outcome).toBe("passed");
      expect(result.execution.cleanupState).toBe("not_needed");
      expect(result.execution.blockers).toEqual([
        expect.objectContaining({
          phase: "model_review",
          stepId: null,
          code: "SUMMARY_LIFECYCLE_UNCONFIRMED",
        }),
      ]);
      expect(test.context.reportNodeHealthFault).toHaveBeenCalledTimes(1);
    },
  );
  it.each([false, true])(
    "does not accept summary advice after a health callback even when execution throws=%s",
    async (throws) => {
      const test = summaryHarness();
      test.execute.mockImplementation(async (input, context) => {
        context.reportNodeHealthFault(new Error("Unconfirmed drain."));
        if (throws) throw new Error("Failed.");
        return completedSummary(input);
      });
      const result = typed(await test.run());
      expect(result.modelReview).toMatchObject({
        state: "failed",
        code: "SUMMARY_LIFECYCLE_UNCONFIRMED",
      });
      expect(result.execution.blockers).toHaveLength(1);
      expect(result.report.modelSummary).toBeUndefined();
    },
  );
  it.each([false, true])(
    "propagates lease loss from optional summary cancellation=%s",
    async (cancel) => {
      const test = summaryHarness();
      const reason = new LeaseLostError("The original lease expired.");
      test.execute.mockImplementation(async (input) => {
        if (!cancel) throw reason;
        test.cancellation.abort(reason);
        return completedSummary(input);
      });
      await expect(test.run()).rejects.toBe(reason);
      expect(test.validation.cleanup).not.toHaveBeenCalled();
      expect(test.cleanups.length).toBeGreaterThan(0);
    },
  );
  it.each([
    (attempt: Extract<ValidationSummaryAttempt, { state: "completed" }>) => {
      Reflect.set(attempt, "contextSha256", "f".repeat(64));
    },
    (attempt: Extract<ValidationSummaryAttempt, { state: "completed" }>) => {
      Reflect.set(attempt, "promptSha256", "f".repeat(64));
    },
    (attempt: Extract<ValidationSummaryAttempt, { state: "completed" }>) => {
      Reflect.set(attempt, "summary", summary(true));
    },
    (attempt: Extract<ValidationSummaryAttempt, { state: "completed" }>) => {
      Reflect.set(attempt.summary, "checks", []);
    },
    (attempt: Extract<ValidationSummaryAttempt, { state: "completed" }>) => {
      attempt.summary.observations = [1, 2].map(() => ({
        id: "duplicate",
        title: "Observation",
        body: "Details",
        priority: 2,
        path: null,
        line: null,
      }));
    },
    (attempt: Extract<ValidationSummaryAttempt, { state: "completed" }>) => {
      attempt.summary.observations = [
        {
          id: "ambiguous",
          title: "Observation",
          body: "Details",
          priority: 2,
          path: "src//file.ts",
          line: 1,
        },
      ];
    },
  ])("discards summary advice with an invalid authority or schema %#", async (mutate) => {
    const test = summaryHarness();
    test.execute.mockImplementation(async (input) => {
      const attempt = completedSummary(input);
      if (attempt.state !== "completed") throw new Error("Fixture summary missing.");
      mutate(attempt);
      return attempt;
    });
    const result = typed(await test.run());
    expect(result.modelReview).toMatchObject({ state: "failed", code: "SUMMARY_RESULT_INVALID" });
    expect(result.report.modelSummary).toBeUndefined();
    expect(result.execution.blockers).toEqual([]);
  });
  it("rejects a runner-supplied model summary even when optional summaries are disabled", async () => {
    const test = harness(envelope(profile(true)));
    const output = uiObserved();
    Reflect.set(output.report, "modelSummary", summary());
    test.uiRunner.run.mockResolvedValue(output);
    expect(await test.run()).toMatchObject({
      outcome: "failed",
      code: "VALIDATION_RESULT_INVALID",
    });
    expect(test.evidenceUploader.uploadUiScenarioEvidence).not.toHaveBeenCalled();
  });
  it("skips advice when upload only finalized part of its evidence", async () => {
    const test = summaryHarness();
    test.evidenceUploader.uploadUiScenarioEvidence.mockImplementation(async (input) => {
      const uploaded = uploadResult(input);
      const shot = uploaded.assets.find((asset) => asset.metadata.kind === "screenshot");
      if (shot === undefined) throw new Error("Fixture screenshot missing.");
      throw new EvidenceUploadError(
        "UPLOAD_FAILED",
        { assets: [shot], assetIds: { "local-shot": shot.id } },
        "local-steps",
      );
    });
    const result = typed(await test.run());
    expect(test.factory).not.toHaveBeenCalled();
    expect(result.modelReview).toMatchObject({
      state: "failed",
      code: "SUMMARY_CONTEXT_UNAVAILABLE",
    });
    expect(result.report.checks[0]?.evidenceIds).toEqual(["server-local-shot"]);
    expect(result.execution.blockers.every((blocker) => blocker.phase === "evidence")).toBe(true);
  });
  it.each(["steps", "screenshot"])(
    "skips advice when finalized %s content does not bind the observed context",
    async (kind) => {
      const test = summaryHarness();
      test.evidenceUploader.uploadUiScenarioEvidence.mockImplementation(async (input) => {
        const uploaded = uploadResult(input);
        const file = uploaded.assets.find((asset) => asset.metadata.kind === kind);
        if (file === undefined) throw new Error("Fixture asset missing.");
        file.metadata.sha256 = "f".repeat(64);
        return uploaded;
      });
      const result = typed(await test.run());
      expect(test.factory).not.toHaveBeenCalled();
      expect(result.modelReview).toMatchObject({
        state: "failed",
        code: "SUMMARY_CONTEXT_UNAVAILABLE",
      });
      expect(result.report.checks[0]?.evidenceIds).toHaveLength(2);
      expect(result.execution.blockers).toEqual([]);
    },
  );
  it("uses the real summary adapter to prepare one separate model workspace under the original lease", async () => {
    const test = adapterHarness();
    const prompt = structuredClone(test.input.prompt);
    const result = typed(await test.run());
    expect(result.report.modelSummary).toEqual(summary());
    expect(result.modelReview).toEqual({ state: "not_requested" });
    expect(test.provider.prepare).toHaveBeenCalledTimes(2);
    expect(vi.mocked(test.provider.prepare).mock.calls.map((call) => call[2])).toEqual([
      "validation",
      "model",
    ]);
    expect(vi.mocked(test.provider.prepare).mock.calls[1]?.[0].lease).toEqual(test.input.lease);
    const invoked = test.output.mock.calls[0]?.[0];
    expect(invoked?.workspace).toBe(test.model);
    expect(invoked?.launchPolicy).toBe("summary_read_only");
    expect(invoked?.prompt).toContain('"server-local-shot"');
    expect(invoked?.prompt).not.toContain('"local-shot"');
    expect(invoked?.prompt).not.toContain(test.input.lease.leaseToken);
    expect(invoked?.hardTimeoutMs).toBe(20_000);
    expect(invoked?.teardownTimeoutMs).toBe(5_000);
    expect(test.input.prompt).toEqual(prompt);
    expect(test.model.cleanup).not.toHaveBeenCalled();
    for (const cleanup of test.cleanups) await cleanup();
    expect(test.model.cleanup).toHaveBeenCalledTimes(1);
    expect(test.validation.cleanup).toHaveBeenCalledTimes(1);
  });
  it("retains runner reports when the real adapter has no safe hard-deadline budget", async () => {
    const test = adapterHarness();
    summaryBudget(test.input, 30_000, 20_000);
    const result = typed(await test.run());
    expect(result.modelReview).toMatchObject({
      state: "failed",
      code: "SUMMARY_BUDGET_UNAVAILABLE",
    });
    expect(result.report.checks[0]?.outcome).toBe("passed");
    expect(result.execution.blockers).toEqual([]);
    expect(test.provider.prepare).toHaveBeenCalledTimes(1);
    expect(test.output).not.toHaveBeenCalled();
  });
  it("excludes raw fill values from the composed prompt while retaining typed action outcomes", async () => {
    const test = adapterHarness();
    const frozen = test.input.validation.profileVersion;
    const ui = frozen.config.ui;
    if (ui?.target !== "windows_desktop") throw new Error("Fixture UI missing.");
    const scenario = ui.scenarios[0];
    if (scenario === undefined) throw new Error("Fixture scenario missing.");
    scenario.steps.unshift({
      id: "fill",
      name: "Enter fixture input",
      action: "fill",
      locator: { by: "automationId", automationId: "Input" },
      value: "PrivateFixtureInput-OnlyForDriver",
      timeoutMs: 100,
    });
    frozen.configSha256 = createCanonicalResult(frozen.config).sha256;
    const output = uiObserved();
    output.scenarioEvidence[0]?.execution.steps.unshift({
      stepId: "fill",
      name: "Enter fixture input",
      action: "fill",
      expected: null,
      actual: null,
      outcome: "passed",
      summary: "Input entered.",
      evidenceIds: [],
    });
    test.uiRunner.run.mockResolvedValue(output);
    const result = typed(await test.run());
    expect(result.report.modelSummary).toBeDefined();
    const input = test.output.mock.calls[0]?.[0];
    expect(input?.prompt).toContain('"action":"fill"');
    expect(input?.prompt).not.toContain("PrivateFixtureInput-OnlyForDriver");
  });
  it("also summarizes headless issue validation without fabricating UI assets or invoking triage", async () => {
    const input = issueEnvelope(true);
    const config = profile().config;
    Reflect.set(input.validation, "profileVersion", {
      ...input.validation.profileVersion,
      workflowKind: "issue_validation",
      target: "headless",
      config,
      configSha256: createCanonicalResult(config).sha256,
    });
    input.validation.target = "headless";
    input.validation.requiredCheckIds = ["profile-version:test"];
    const test = summaryHarness(input);
    const output = observed();
    Reflect.set(output, "report", {
      ...output.report,
      workItemKind: "issue",
      reproductionConclusion: "not_reproduced",
    });
    test.headlessRunner.run.mockResolvedValue(output);
    const result = typed(await test.run());
    expect(result.report.modelSummary).toEqual(summary(true));
    expect(result.report).toMatchObject({ reproductionConclusion: "not_reproduced" });
    expect(test.execute.mock.calls[0]?.[0].evidenceContext).toEqual({ assets: [], scenarios: [] });
    expect(test.evidenceUploader.uploadUiScenarioEvidence).not.toHaveBeenCalled();
    expect(test.createModelExecutor).not.toHaveBeenCalled();
  });
  it("discards optional prose that would make an otherwise valid runner report exceed submission capacity", async () => {
    const test = summaryHarness();
    const profile = test.input.validation.profileVersion;
    const launch = profile.config.launch[0];
    if (launch === undefined) throw new Error("Fixture launch missing.");
    const output = uiObserved();
    for (const phase of ["setup", "build"] as const) {
      for (let index = 0; index < 32; index++) {
        const id = `${phase}-${index}`;
        profile.config[phase].push({ ...structuredClone(launch), id, name: id });
        output.report.checks.push({
          id: `${profile.id}:${id}`,
          name: id,
          kind: phase === "build" ? "build" : "static",
          required: true,
          source: "runner",
          outcome: "passed",
          summary: "界".repeat(2_048),
          expected: "界".repeat(2_048),
          actual: "界".repeat(2_048),
          evidenceIds: [],
        });
        output.diagnostics.push({
          stepId: `${profile.id}:${id}`,
          phase,
          outcome: "passed",
          exitCode: 0,
          summary: "The command completed.",
        });
      }
    }
    profile.configSha256 = createCanonicalResult(profile.config).sha256;
    test.input.validation.requiredCheckIds = output.report.checks
      .filter((check) => check.kind !== "static")
      .map((check) => check.id);
    test.uiRunner.run.mockResolvedValue(output);
    test.execute.mockImplementation(async (input) => {
      const attempt = completedSummary(input);
      if (attempt.state !== "completed") throw new Error("Fixture summary missing.");
      attempt.summary.observations = Array.from({ length: 100 }, (_, index) => ({
        id: `note-${index}`,
        title: "Observed concern",
        body: "界".repeat(4_096),
        priority: 2,
        path: null,
        line: null,
      }));
      return attempt;
    });
    const result = typed(await test.run());
    expect(result.modelReview).toMatchObject({ state: "failed", code: "SUMMARY_RESULT_TOO_LARGE" });
    expect(result.report.modelSummary).toBeUndefined();
    expect(result.report.checks).toHaveLength(65);
    expect(result.report.checks.every((check) => check.outcome === "passed")).toBe(true);
    expect(result.execution.blockers).toEqual([]);
  });
  it("retains runner reports after the real adapter times out and drains before the parent budget", async () => {
    vi.useFakeTimers();
    const test = adapterHarness();
    let started = false;
    test.output.mockImplementation(async (input) => {
      started = true;
      await new Promise<void>((resolve) =>
        input.context.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw input.context.signal.reason;
    });
    const running = test.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = typed(await running);
    expect(result.modelReview).toMatchObject({ state: "failed", code: "SUMMARY_TIMEOUT" });
    expect(result.report.checks[0]?.outcome).toBe("passed");
    expect(result.execution.blockers).toEqual([]);
    expect(test.cancellation.signal.aborted).toBe(false);
    expect(test.output.mock.calls[0]?.[0].context.attemptSignal).toBe(test.cancellation.signal);
    expect(test.context.reportNodeHealthFault).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains the root attempt owner through profile and summary child budgets", async () => {
    const test = adapterHarness();
    const owner = new AbortController();
    Reflect.set(test.context, "attemptSignal", owner.signal);
    typed(await test.run());
    const capturedContext = test.output.mock.calls[0]?.[0].context;
    expect(capturedContext?.attemptSignal).toBe(owner.signal);
    expect(capturedContext?.signal).not.toBe(owner.signal);
    expect(capturedContext?.signal).not.toBe(test.context.signal);
  });
  it("requires synchronous deferred cleanup registration before preparing a workspace", async () => {
    const test = harness();
    const { deferCleanup: _cleanup, ...context } = test.context;
    expect(await new ProfileJobExecutor(test.options).execute(test.input, context)).toMatchObject({
      outcome: "failed",
      code: "CLEANUP_REGISTRATION_UNAVAILABLE",
    });
    expect(test.provider.prepare).not.toHaveBeenCalled();
  });
  it("delegates the complete V2 envelope to the actual profile model entry point", async () => {
    const test = harness();
    const { executionEvidence: _evidence, ...modelResult } = review();
    const canonical = createCanonicalResult(modelResult);
    const run = vi.spyOn(PreparedCodexOutputRunner.prototype, "run").mockResolvedValue({
      outcome: "succeeded",
      result: modelResult,
      resultDigest: canonical.sha256,
      canonicalResultJson: canonical.json,
      commandEvidence: { commands: [], commandCapture: "complete" },
      observedFileChange: false,
    });
    try {
      test.createModelExecutor.mockImplementation((provider) => actualModelExecutor(provider));
      const result = typed(await test.run());
      expect(result.modelReview.state).toBe("completed");
      expect(test.provider.prepare).toHaveBeenNthCalledWith(
        2,
        test.input,
        expect.anything(),
        "model",
      );
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0].prompt).toBe(test.input.prompt.renderedPrompt);
      expect(test.legacyExecutor.execute).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("rejects an evaluation invocation scope attached to an ordinary profile before model dispatch", async () => {
    const test = harness();
    const raw = {
      schemaVersion: "PrReviewPlanV2" as const,
      summary: "Original raw review.",
      assessment: "comment" as const,
      findings: [],
      requestedRecipeIds: [],
      verification: {
        status: "not_run" as const,
        summary: "Example token=placeholder must keep its original digest.",
        commands: [],
      },
    };
    const canonical = createCanonicalResult(raw);
    const scope = recordedScope(test.input);
    const open = vi.fn(async () => {
      throw new Error("No actual session may open in this pure handoff test.");
    });
    const factory: CreateModelInvocation = () => ({ expectedScope: scope, open });
    const run = vi.spyOn(PreparedCodexOutputRunner.prototype, "run").mockResolvedValue({
      outcome: "succeeded",
      result: raw,
      resultDigest: canonical.sha256,
      canonicalResultJson: canonical.json,
      commandEvidence: { commands: [], commandCapture: "complete" },
      observedFileChange: false,
      modelInvocation: recording(scope),
    });
    try {
      test.createModelExecutor.mockImplementation((provider) =>
        actualModelExecutor(provider, factory),
      );
      const result = typedV2(await test.run());
      expect(result.modelReview).toMatchObject({
        state: "failed",
        code: "MODEL_OUTPUT_ARTIFACT_INVALID",
      });
      expect(result.modelReview).not.toHaveProperty("result");
      expect(result.modelReview).not.toHaveProperty("invocation");
      expect(result.report).not.toHaveProperty("modelSummary");
      expect(result.report.checks.every((check) => check.source === "runner")).toBe(true);
      expect(run).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("does not downgrade required recording to V1 when the prepared model omits its receipt", async () => {
    const test = harness();
    const raw = {
      schemaVersion: "PrReviewPlanV2" as const,
      summary: "Unrecorded output.",
      assessment: "comment" as const,
      findings: [],
      requestedRecipeIds: [],
      verification: { status: "not_run" as const, summary: "No receipt.", commands: [] },
    };
    const canonical = createCanonicalResult(raw);
    const run = vi.spyOn(PreparedCodexOutputRunner.prototype, "run").mockResolvedValue({
      outcome: "succeeded",
      result: raw,
      resultDigest: canonical.sha256,
      canonicalResultJson: canonical.json,
      commandEvidence: { commands: [], commandCapture: "complete" },
      observedFileChange: false,
    });
    try {
      test.createModelExecutor.mockImplementation((provider) =>
        actualModelExecutor(provider, () => ({
          expectedScope: recordedScope(test.input),
          open: async () => {
            throw new Error("No session may open.");
          },
        })),
      );
      const result = typedV2(await test.run());
      expect(result.modelReview).toMatchObject({
        state: "failed",
        code: "MODEL_OUTPUT_ARTIFACT_INVALID",
      });
      expect(result.report.checks[0]?.outcome).toBe("passed");
      expect(result.execution.blockers).toContainEqual(
        expect.objectContaining({ code: "MODEL_REVIEW_REQUIRED" }),
      );
    } finally {
      run.mockRestore();
    }
  });

  it("rejects an invocation for another attempt before asking the prepared runner to execute", async () => {
    const test = harness();
    const scope = recordedScope(test.input);
    scope.attemptId = "foreign-attempt";
    const run = vi.spyOn(PreparedCodexOutputRunner.prototype, "run");
    try {
      test.createModelExecutor.mockImplementation((provider) =>
        actualModelExecutor(provider, () => ({
          expectedScope: scope,
          open: async () => {
            throw new Error("No session may open.");
          },
        })),
      );
      const result = typedV2(await test.run());
      expect(result.modelReview).toMatchObject({
        state: "failed",
        code: "MODEL_OUTPUT_ARTIFACT_INVALID",
      });
      expect(run).not.toHaveBeenCalled();
      expect(result.report.checks[0]?.outcome).toBe("passed");
    } finally {
      run.mockRestore();
    }
  });

  it("fails required recording instead of accepting a legacy delegated result", async () => {
    const test = harness();
    const result = typedV2(
      await new ProfileJobExecutor({ ...test.options, requireModelInvocation: true }).execute(
        test.input,
        test.context,
      ),
    );
    expect(result.modelReview).toMatchObject({ state: "failed", code: "MODEL_RECORDING_MISSING" });
    expect(result.report.checks[0]?.outcome).toBe("passed");
  });

  it("retains all 160 original blockers when recorded model output is unavailable", async () => {
    const test = harness();
    const facts = observed();
    facts.blockers = Array.from({ length: 160 }, (_, index) => ({
      phase: "profile" as const,
      stepId: null,
      code: "ORIGINAL_BLOCKER",
      message: `Original runner blocker ${index}.`,
    }));
    test.headlessRunner.run.mockResolvedValue(facts);
    const result = typedV2(
      await new ProfileJobExecutor({ ...test.options, requireModelInvocation: true }).execute(
        test.input,
        test.context,
      ),
    );
    expect(result.modelReview).toMatchObject({ state: "failed", code: "MODEL_RECORDING_MISSING" });
    expect(result.execution.blockers).toEqual(facts.blockers);
    expect(result.report.checks).toEqual(facts.report.checks);
  });

  it("reserves failure-report capacity before dispatching a model near the terminal byte ceiling", async () => {
    const test = harness();
    const selected = test.input.validation.profileVersion;
    const template = selected.config.test[0];
    if (template === undefined) throw new Error("Expected the command fixture.");
    const facts = observed();
    facts.report.checks = [];
    facts.diagnostics = [];
    for (const phase of ["setup", "build", "test"] as const) {
      selected.config[phase] = Array.from({ length: 32 }, (_, index) => ({
        ...template,
        id: `${phase}-${index}`,
        name: `${phase} check ${index}`,
      }));
      for (const step of selected.config[phase]) {
        const id = `${selected.id}:${step.id}`;
        facts.report.checks.push({
          id,
          name: step.name,
          kind: phase === "setup" ? "static" : phase,
          required: true,
          source: "runner",
          outcome: "passed",
          summary: "Check passed.",
          expected: null,
          actual: null,
          evidenceIds: [],
        });
        facts.diagnostics.push({
          stepId: id,
          phase,
          outcome: "passed",
          exitCode: 0,
          summary: "Check passed.",
          stdout: "",
          stderr: "",
        });
      }
    }
    selected.configSha256 = createCanonicalResult(selected.config).sha256;
    test.input.validation.requiredCheckIds = [...selected.config.build, ...selected.config.test]
      .map((step) => `${selected.id}:${step.id}`)
      .sort();
    const payload = () => ({
      schemaVersion: "ValidationJobResultV2",
      report: facts.report,
      execution: {
        blockers: facts.blockers,
        diagnostics: facts.diagnostics,
        cleanupState: facts.cleanupState,
      },
      modelReview: { state: "not_requested" },
    });
    const remaining =
      2 * 1024 * 1024 - 1000 - Buffer.byteLength(createCanonicalResult(payload()).json, "utf8");
    const characters = Math.floor(remaining / (facts.diagnostics.length * 2 * 3));
    expect(characters).toBeLessThanOrEqual(4096);
    for (const diagnostic of facts.diagnostics) {
      diagnostic.stdout = "\u754c".repeat(characters);
      diagnostic.stderr = "\u754c".repeat(characters);
    }
    const bytes = Buffer.byteLength(createCanonicalResult(payload()).json, "utf8");
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect(bytes).toBeGreaterThan(2 * 1024 * 1024 - 2000);
    test.headlessRunner.run.mockResolvedValue(facts);
    expect(
      await new ProfileJobExecutor({ ...test.options, requireModelInvocation: true }).execute(
        test.input,
        test.context,
      ),
    ).toMatchObject({ outcome: "failed", code: "VALIDATION_RESULT_TOO_LARGE" });
    expect(test.createModelExecutor).not.toHaveBeenCalled();
  });

  it("rejects an evaluation summary artifact attached to an ordinary profile while retaining runner facts", async () => {
    const test = summaryHarness();
    test.execute.mockImplementation(async (input) => {
      const attempt = completedSummary(input);
      if (attempt.state !== "completed") throw new Error("Expected completed summary fixture.");
      const actualPromptSha256 = hash(
        composeSummaryPrompt(
          input.envelope.prompt.renderedPrompt,
          createValidationSummaryContext(input).json,
        ),
      );
      const scope = recordedScope(input.envelope, actualPromptSha256);
      const canonical = createCanonicalResult(attempt.summary);
      const artifact = createModelOutputArtifact({
        output: {
          outcome: "succeeded",
          result: attempt.summary,
          canonicalResultJson: canonical.json,
          resultDigest: canonical.sha256,
          modelInvocation: recording(scope),
        },
        expectedScope: scope,
        executionEvidence: {
          schemaVersion: "ReviewExecutionEvidenceV1",
          source: "worker",
          commandCapture: "complete",
          commands: [],
          worktree: { status: "clean", source: "git_status" },
        },
      });
      return { ...attempt, modelOutputArtifact: artifact, actualPromptSha256 };
    });
    const result = typedV2(await test.run());
    expect(result.modelReview).toMatchObject({ state: "failed", code: "SUMMARY_EXECUTION_FAILED" });
    expect(result.modelReview).not.toHaveProperty("result");
    expect(result.modelReview).not.toHaveProperty("invocation");
    expect(result.report).not.toHaveProperty("modelSummary");
    expect(result.report.checks[0]?.outcome).toBe("passed");
  });

  it("does not downgrade a required recorded summary when its artifact is missing", async () => {
    const test = summaryHarness();
    const result = typedV2(
      await new ProfileJobExecutor({
        ...test.options,
        createSummaryExecutor: test.factory,
        requireModelInvocation: true,
      }).execute(test.input, test.context),
    );
    expect(result.modelReview).toMatchObject({
      state: "failed",
      code: "SUMMARY_RECORDING_MISSING",
    });
    expect(result.report).not.toHaveProperty("modelSummary");
    expect(result.report.checks[0]?.outcome).toBe("passed");
  });
  it("retains runner evidence and an explicit V2 failure when a required summary is unconfigured", async () => {
    const test = summaryHarness();
    const result = typedV2(
      await new ProfileJobExecutor({
        ...test.options,
        requireModelInvocation: true,
      }).execute(test.input, test.context),
    );
    expect(result.modelReview).toMatchObject({
      state: "failed",
      code: "MODEL_EXECUTOR_UNAVAILABLE",
    });
    expect(result.execution.blockers).toContainEqual(
      expect.objectContaining({
        phase: "model_review",
        code: "MODEL_REVIEW_REQUIRED",
      }),
    );
    expect(result.report.checks[0]?.outcome).toBe("passed");
    expect(result.report).not.toHaveProperty("modelSummary");
    expect(test.factory).not.toHaveBeenCalled();
    expect(test.createModelExecutor).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "keeps disabled ordinary advice unrequested with complete evidence=%s",
    async (completeEvidence) => {
      const test = summaryHarness();
      if (!completeEvidence) {
        test.evidenceUploader.uploadUiScenarioEvidence.mockImplementation(async (input) => {
          const uploaded = uploadResult(input);
          const document = uploaded.assets.find((asset) => asset.metadata.kind === "steps");
          if (document === undefined) throw new Error("Fixture steps document missing.");
          document.metadata.sha256 = "f".repeat(64);
          return uploaded;
        });
      }
      const result = typed(
        await new ProfileJobExecutor({
          ...test.options,
          createSummaryExecutor: test.factory,
          optionalSummariesEnabled: false,
        }).execute(test.input, test.context),
      );
      expect(result.modelReview).toEqual({ state: "not_requested" });
      expect(result.report).not.toHaveProperty("modelSummary");
      expect(result.execution.blockers.every((entry) => entry.phase !== "model_review")).toBe(true);
      expect(test.factory).not.toHaveBeenCalled();
      expect(test.execute).not.toHaveBeenCalled();
    },
  );
  it.each(["legacy", "static", "triage", "required evaluation"])(
    "rejects %s model work before workspace preparation when models are disabled",
    async (kind) => {
      const test = harness();
      let input: Parameters<JobExecutor["execute"]>[0] = test.input;
      if (kind === "legacy") {
        const { validation: _validation, ...fields } = test.input;
        input = { ...fields, envelopeVersion: 1 };
      }
      if (kind === "triage") input = issueEnvelope();
      if (kind === "required evaluation") input = evaluationProfileEnvelopeFixture();
      const result = await new ProfileJobExecutor({
        ...test.options,
        modelExecutionEnabled: false,
      }).execute(input, test.context);
      expect(result).toMatchObject({
        outcome: "failed",
        code: "MODEL_EXECUTION_DISABLED",
        retryable: false,
      });
      expect(test.provider.prepare).not.toHaveBeenCalled();
      expect(test.headlessRunner.run).not.toHaveBeenCalled();
      expect(test.createModelExecutor).not.toHaveBeenCalled();
      expect(test.context.processHost.start).not.toHaveBeenCalled();
    },
  );
  it("keeps profile-only evaluation gated even on a model-disabled Worker", async () => {
    const test = harness();
    const input = evaluationProfileEnvelopeFixture("issue_validation", "headless", false);
    expect(
      await new ProfileJobExecutor({ ...test.options, modelExecutionEnabled: false }).execute(
        input,
        test.context,
      ),
    ).toMatchObject({ outcome: "failed", code: "EVALUATION_EXECUTION_BOUNDARY_UNAVAILABLE" });
    expect(test.provider.prepare).not.toHaveBeenCalled();
    expect(test.createModelExecutor).not.toHaveBeenCalled();
  });
  it("runs ordinary validation without creating an optional model executor when models are disabled", async () => {
    const test = summaryHarness();
    const result = typed(
      await new ProfileJobExecutor({
        ...test.options,
        modelExecutionEnabled: false,
        optionalSummariesEnabled: true,
        createSummaryExecutor: test.factory,
      }).execute(test.input, test.context),
    );
    expect(result.report.checks[0]?.outcome).toBe("passed");
    expect(result.modelReview).toEqual({ state: "not_requested" });
    expect(test.factory).not.toHaveBeenCalled();
    expect(test.createModelExecutor).not.toHaveBeenCalled();
  });
  it("rejects a delegated model request that changes its frozen activation", async () => {
    const test = harness();
    test.createModelExecutor.mockImplementation((provider) => ({
      executeProfileModel: (input, context) => {
        const changed = structuredClone(input);
        changed.validation.activationId = "another-activation";
        return actualModelExecutor(provider).executeProfileModel(changed, context);
      },
    }));
    expect(typed(await test.run()).modelReview.state).toBe("failed");
    expect(test.provider.prepare).toHaveBeenCalledOnce();
    expect(test.context.processHost.start).not.toHaveBeenCalled();
  });
  it.each([{ purpose: { kind: "evaluation" } }, { schemaVersion: "ValidationJobContextV2" }])(
    "retains the execution boundary at the direct model entry for marker %#",
    async (marker) => {
      const test = harness();
      Object.assign(test.input.validation, marker);
      const result = await actualModelExecutor(test.provider).executeProfileModel(
        test.input,
        test.context,
      );
      expect(result).toMatchObject({
        outcome: "failed",
        code: "EVALUATION_EXECUTION_BOUNDARY_UNAVAILABLE",
      });
      expect(test.provider.prepare).not.toHaveBeenCalled();
      expect(test.context.processHost.start).not.toHaveBeenCalled();
      expect(test.context.reportProgress).not.toHaveBeenCalled();
    },
  );
  it("rejects a downgraded envelope at the profile model entry", async () => {
    const test = harness();
    const { validation: _validation, ...fields } = test.input;
    const input = { ...fields, envelopeVersion: 1 } as unknown as JobExecutionEnvelopeV2;
    expect(
      await actualModelExecutor(test.provider).executeProfileModel(input, test.context),
    ).toMatchObject({
      outcome: "failed",
      code: "JOB_CONTRACT_INVALID",
    });
    expect(test.provider.prepare).not.toHaveBeenCalled();
    expect(test.context.processHost.start).not.toHaveBeenCalled();
  });
  it("rejects a model executor that bypasses the isolated workspace provider", async () => {
    const test = harness();
    const result = review();
    test.createModelExecutor.mockReturnValue({
      executeProfileModel: async () => ({
        outcome: "succeeded",
        result,
        resultDigest: createCanonicalResult(result).sha256,
      }),
    });
    const completed = typed(await test.run());
    expect(completed.modelReview).toMatchObject({ state: "failed", code: "MODEL_RESULT_INVALID" });
  });
  it("rejects a changed model result digest after isolated model execution", async () => {
    const test = harness();
    const baseline = test.createModelExecutor.getMockImplementation();
    if (baseline === undefined) throw new Error("Fixture model factory missing.");
    test.createModelExecutor.mockImplementation((provider, envelope, context) => {
      const executor = baseline(provider, envelope, context);
      return {
        executeProfileModel: async (input, context) => {
          const result = await executor.executeProfileModel(input, context);
          return result.outcome === "succeeded"
            ? { ...result, resultDigest: "f".repeat(64) }
            : result;
        },
      };
    });
    expect(typed(await test.run()).modelReview).toMatchObject({
      state: "failed",
      code: "MODEL_RESULT_INVALID",
    });
  });
  it("reports deferred filesystem cleanup failure without deleting the terminal reporting window early", async () => {
    const test = harness();
    vi.mocked(test.validation.cleanup).mockRejectedValue(new Error("Fixture cleanup failed."));
    typed(await test.run());
    expect(test.context.reportNodeHealthFault).not.toHaveBeenCalled();
    const cleanup = test.cleanups[0];
    if (cleanup === undefined) throw new Error("Deferred cleanup missing.");
    await expect(cleanup()).rejects.toThrow("Fixture cleanup failed");
    expect(test.context.reportNodeHealthFault).toHaveBeenCalledOnce();
  });
  it("rejects UI observations copied from a different target", async () => {
    const test = harness(envelope(profile(true)));
    const result = uiObserved();
    const scene = result.scenarioEvidence[0];
    if (scene === undefined) throw new Error("Fixture scene missing.");
    scene.execution.target = "web";
    test.uiRunner.run.mockResolvedValue(result);
    expect(await test.run()).toMatchObject({
      outcome: "failed",
      code: "UI_EVIDENCE_SCOPE_INVALID",
    });
    expect(test.evidenceUploader.uploadUiScenarioEvidence).not.toHaveBeenCalled();
  });
  it("does not accept a passing UI observation whose actual value contradicts its assertion", async () => {
    const test = harness(envelope(profile(true)));
    const result = uiObserved();
    const actual = result.scenarioEvidence[0]?.execution.steps[0];
    if (actual === undefined) throw new Error("Fixture observation missing.");
    actual.actual = "Wrong value";
    test.uiRunner.run.mockResolvedValue(result);
    expect(await test.run()).toMatchObject({
      outcome: "failed",
      code: "UI_EVIDENCE_SCOPE_INVALID",
    });
  });
  it("requires isolated model triage for an issue without inventing command checks", async () => {
    const test = harness(issueEnvelope());
    test.headlessRunner.run.mockResolvedValue({
      report: {
        schemaVersion: "ValidationReportV1",
        source: "worker",
        sourceState: "original",
        summary: "Triage has no configured execution commands.",
        checks: [],
        workItemKind: "issue",
        reproductionConclusion: "inconclusive",
      },
      blockers: [],
      diagnostics: [],
      cleanupState: "not_needed",
    });
    const result = typed(await test.run());
    expect(result.report.workItemKind).toBe("issue");
    expect(result.report.checks).toEqual([]);
    expect(result.modelReview).toMatchObject({
      state: "completed",
      result: { schemaVersion: "IssueTriageV2" },
    });
    expect(test.modelEnvelope()?.lease).toEqual(test.input.lease);
  });
  it("blocks issue UI validation without explicit source-commit authorization", async () => {
    const test = harness(issueEnvelope(true));
    test.input.validation.testedSourceAuthorization = null;
    expect(await test.run()).toMatchObject({
      outcome: "failed",
      code: "VALIDATION_ENVELOPE_INVALID",
    });
    expect(test.provider.prepare).not.toHaveBeenCalled();
  });
  it.each(["INVALID_CONFIGURATION", "WORKSPACE_PATH_UNSAFE", "GIT_REVISION_MISMATCH"] as const)(
    "does not retry deterministic workspace failure %s",
    async (code) => {
      const test = harness();
      vi.mocked(test.provider.prepare).mockRejectedValue(
        new JobWorkspaceError(code, "Fixture workspace failure."),
      );
      expect(await test.run()).toMatchObject({ outcome: "failed", retryable: false });
    },
  );
  it("keeps transient workspace capacity failures retryable", async () => {
    const test = harness();
    vi.mocked(test.provider.prepare).mockRejectedValue(
      new JobWorkspaceError("WORKSPACE_DISK_CAPACITY_UNAVAILABLE", "Temporary capacity."),
    );
    expect(await test.run()).toMatchObject({ outcome: "failed", retryable: true });
  });
  it("retains 34 finalized references without silently truncating the check", async () => {
    const test = harness(envelope(profile(true)));
    const output = uiObserved();
    const scenario = output.scenarioEvidence[0];
    if (scenario === undefined) throw new Error("Fixture scenario missing.");
    const additional = Array.from({ length: 32 }, (_, index) => ({
      id: `extra-shot-${index}`,
      relativePath: `windows-fixture/${index}.png`,
      kind: "screenshot" as const,
      mediaType: "image/png" as const,
      sizeBytes: 10,
      sha256: "a".repeat(64),
    }));
    test.uiRunner.run.mockResolvedValue({
      ...output,
      scenarioEvidence: [
        { ...scenario, evidenceFiles: [...scenario.evidenceFiles, ...additional] },
      ],
    });
    const result = typed(await test.run());
    expect(result.report.checks[0]?.evidenceIds).toHaveLength(34);
    expect(result.execution.blockers).toEqual([]);
  });
  it("records an explicit blocker when a scenario exceeds the reference limit", async () => {
    const test = harness(envelope(profile(true)));
    const output = uiObserved();
    const scenario = output.scenarioEvidence[0];
    if (scenario === undefined) throw new Error("Fixture scenario missing.");
    const additional = Array.from({ length: 33 }, (_, index) => ({
      id: `extra-shot-${index}`,
      relativePath: `windows-fixture/${index}.png`,
      kind: "screenshot" as const,
      mediaType: "image/png" as const,
      sizeBytes: 10,
      sha256: "a".repeat(64),
    }));
    test.uiRunner.run.mockResolvedValue({
      ...output,
      scenarioEvidence: [
        { ...scenario, evidenceFiles: [...scenario.evidenceFiles, ...additional] },
      ],
    });
    const result = typed(await test.run());
    expect(result.report.checks[0]?.outcome).toBe("blocked");
    expect(result.execution.blockers).toContainEqual(
      expect.objectContaining({ code: "EVIDENCE_REFERENCE_LIMIT_EXCEEDED" }),
    );
  });
  it("preserves direct V1 legacy routing", async () => {
    const test = harness();
    const { validation: _validation, ...fields } = test.input;
    const legacy = { ...fields, envelopeVersion: 1 as const };
    const result = await new ProfileJobExecutor(test.options).execute(legacy, test.context);
    expect(result).toMatchObject({ outcome: "failed", code: "LEGACY_FIXTURE" });
    expect(test.legacyExecutor.execute).toHaveBeenCalledWith(legacy, test.context);
    expect(test.provider.prepare).not.toHaveBeenCalled();
  });
  it.each([
    { ui: false, modelRequired: true },
    { ui: false, modelRequired: false },
    { ui: true, modelRequired: true },
    { ui: true, modelRequired: false },
  ])(
    "rejects evaluation before any workspace or execution for %#",
    async ({ ui, modelRequired }) => {
      const test = harness(envelope(profile(ui)));
      const original = test.input.validation;
      const resource = test.input.resource;
      const snapshot = resource.canonicalSnapshot;
      if (
        resource.kind !== "pull_request" ||
        !Value.Check(GitHubWorkItemSchema, snapshot) ||
        snapshot.kind !== "pull_request"
      )
        throw new Error("The fixture requires a PR source.");
      const evaluationId = "evaluation-1";
      const source: ValidationJobContextV2["source"] = {
        schemaVersion: "EvaluationSourceSnapshotV1",
        repository: {
          id: original.repositoryId,
          githubRepositoryId: test.input.repository.githubRepositoryId,
          fullName: test.input.repository.fullName,
          configurationVersion: 1,
        },
        workItemId: original.workItemId,
        workItem: snapshot,
        revision: {
          kind: "pull_request",
          githubRepositoryId: snapshot.githubRepositoryId,
          githubWorkItemId: snapshot.githubWorkItemId,
          revisionKey: original.revisionKey,
          baseSha: resource.baseSha,
          headSha: resource.headSha,
        },
        revisionId: "revision-1",
        freshness: "frozen",
        sourceDigest: "e".repeat(64),
        testedSourceRevision: original.testedSourceRevision,
        provenance: {
          kind: "current_work_item",
          capturedAt: now,
          expectedRevisionKey: original.revisionKey,
        },
      };
      const evaluation: ValidationJobContextV2 = {
        ...original,
        schemaVersion: "ValidationJobContextV2",
        requestEpochId: null,
        testedSourceAuthorization: null,
        jobActivation: 1,
        source,
        purpose: {
          schemaVersion: "EvaluationExecutionPurposeV1",
          kind: "evaluation",
          evaluationId,
          cellId: "cell-1",
          caseId: "case-1",
          arm: "baseline",
          sampleSetVersionId: "suite-version-1",
          authorizationId: "authorization-1",
          executionManifestSha256: "f".repeat(64),
          trial: 1,
          upstreamMutationPolicy: "forbidden",
        },
        authorization: {
          schemaVersion: "EvaluationExecutionAuthorizationV1",
          kind: "operator_evaluation",
          id: "authorization-1",
          actor: { issuer: "fixture-issuer", subject: "fixture-operator" },
          authorizedAt: now,
          evaluationId,
          repositoryId: original.repositoryId,
          githubRepositoryId: snapshot.githubRepositoryId,
          sampleSetVersionId: "suite-version-1",
          sourceManifestSha256: "a".repeat(64),
          configurationManifestSha256: "b".repeat(64),
          cellManifestSha256: "c".repeat(64),
          executionManifestSha256: "f".repeat(64),
        },
        modelRequirements: { required: modelRequired, expectedModelIdentityDigest: null },
      };
      expect(Value.Check(ValidationJobContextV2Schema, evaluation)).toBe(true);
      const input = { ...test.input, validation: evaluation } as unknown as JobExecutionEnvelopeV2;
      input.executionPolicy.requiredCapabilityLabels.validationEvaluation = "1";
      const summaryFactory = vi.fn<NonNullable<ProfileJobExecutorOptions["createSummaryExecutor"]>>(
        () => {
          throw new Error("Evaluation summary execution must not begin.");
        },
      );
      const result = await new ProfileJobExecutor({
        ...test.options,
        createSummaryExecutor: summaryFactory,
      }).execute(input, test.context);
      expect(result).toEqual({
        outcome: "failed",
        code: "EVALUATION_EXECUTION_BOUNDARY_UNAVAILABLE",
        retryable: false,
        message:
          "This Worker has no accepted evaluation execution boundary; profile commands and model execution were not started.",
      });
      expect(test.provider.prepare).not.toHaveBeenCalled();
      expect(test.headlessRunner.run).not.toHaveBeenCalled();
      expect(test.uiRunner.run).not.toHaveBeenCalled();
      expect(test.createModelExecutor).not.toHaveBeenCalled();
      expect(summaryFactory).not.toHaveBeenCalled();
      expect(test.legacyExecutor.execute).not.toHaveBeenCalled();
      expect(test.evidenceUploader.uploadUiScenarioEvidence).not.toHaveBeenCalled();
      expect(test.context.processHost.start).not.toHaveBeenCalled();
      expect(test.context.reportProgress).not.toHaveBeenCalled();
      expect(test.cleanups).toEqual([]);
    },
  );
  it.each([{ purpose: { kind: "evaluation" } }, { schemaVersion: "ValidationJobContextV2" }])(
    "does not let a partially downgraded evaluation marker bypass the early guard %#",
    async (marker) => {
      const test = harness();
      Object.assign(test.input.validation, marker);
      const result = await test.run();
      expect(result).toMatchObject({
        outcome: "failed",
        code: "EVALUATION_EXECUTION_BOUNDARY_UNAVAILABLE",
        retryable: false,
      });
      expect(test.provider.prepare).not.toHaveBeenCalled();
      expect(test.legacyExecutor.execute).not.toHaveBeenCalled();
      expect(test.context.processHost.start).not.toHaveBeenCalled();
      expect(test.cleanups).toEqual([]);
    },
  );
  it("keeps model changes in a separate purpose workspace and retains both until terminal reporting", async () => {
    const test = harness();
    const result = typed(await test.run());
    expect(result.report.sourceState).toBe("original");
    expect(result.modelReview.state).toBe("completed");
    expect(test.provider.prepare).toHaveBeenNthCalledWith(
      1,
      test.input,
      expect.anything(),
      "validation",
    );
    expect(test.provider.prepare).toHaveBeenNthCalledWith(
      2,
      test.input,
      expect.anything(),
      "model",
    );
    const modelInput = test.modelEnvelope();
    expect(modelInput).toEqual(test.input);
    expect(modelInput?.envelopeVersion).toBe(2);
    expect(modelInput).toHaveProperty("validation", test.input.validation);
    expect(test.validation.cleanup).not.toHaveBeenCalled();
    expect(test.model.cleanup).not.toHaveBeenCalled();
    for (const cleanup of test.cleanups) await cleanup();
    expect(test.validation.cleanup).toHaveBeenCalledOnce();
    expect(test.model.cleanup).toHaveBeenCalledOnce();
  });
  it("stores a failed test as a typed successful execution with failed checks", async () => {
    const test = harness();
    const failedCheck = observed();
    for (const check of failedCheck.report.checks) check.outcome = "failed";
    for (const diagnostic of failedCheck.diagnostics) {
      diagnostic.outcome = "failed";
      diagnostic.exitCode = 1;
    }
    test.headlessRunner.run.mockResolvedValue(failedCheck);
    const result = typed(await test.run());
    expect(result.report.checks[0]?.outcome).toBe("failed");
    expect(result.modelReview.state).toBe("completed");
  });
  it("requires the static model review without discarding observed runner checks", async () => {
    const test = harness();
    const options = { ...test.options, createModelExecutor: undefined };
    const { createModelExecutor: _unused, ...withoutModel } = options;
    const result = typed(
      await new ProfileJobExecutor(withoutModel).execute(test.input, test.context),
    );
    expect(result.modelReview).toMatchObject({
      state: "failed",
      code: "MODEL_EXECUTOR_UNAVAILABLE",
    });
    expect(result.execution.blockers).toContainEqual(
      expect.objectContaining({ phase: "model_review", stepId: null }),
    );
    expect(result.report.checks[0]?.outcome).toBe("passed");
  });
  it("rejects model/validation workspace aliasing before model execution", async () => {
    const test = harness();
    vi.mocked(test.provider.prepare).mockResolvedValue(test.validation);
    const result = typed(await test.run());
    expect(result.modelReview.state).toBe("failed");
    expect(test.context.reportNodeHealthFault).toHaveBeenCalled();
    expect(test.validation.cleanup).not.toHaveBeenCalled();
  });
  it.each([
    (value: JobExecutionEnvelopeV2) => {
      value.validation.profileVersion.configSha256 = "f".repeat(64);
    },
    (value: JobExecutionEnvelopeV2) => {
      value.prompt.renderedPrompt += " changed";
    },
    (value: JobExecutionEnvelopeV2) => {
      value.prompt.name = "different-template";
    },
    (value: JobExecutionEnvelopeV2) => {
      value.validation.requiredCheckIds = [];
    },
    (value: JobExecutionEnvelopeV2) => {
      value.lease.jobId = "other-job";
    },
    (value: JobExecutionEnvelopeV2) => {
      value.validation.revisionKey = "f".repeat(64);
    },
  ])("rejects changed frozen identities before workspace creation %#", async (mutate) => {
    const test = harness();
    mutate(test.input);
    expect(await test.run()).toMatchObject({
      outcome: "failed",
      code: "VALIDATION_ENVELOPE_INVALID",
    });
    expect(test.provider.prepare).not.toHaveBeenCalled();
  });
  it("uploads typed UI evidence and uses only finalized server IDs", async () => {
    const test = harness(envelope(profile(true)));
    const result = typed(await test.run());
    expect(result.modelReview).toEqual({ state: "not_requested" });
    expect(test.createModelExecutor).not.toHaveBeenCalled();
    expect(result.report.checks[0]?.evidenceIds).toEqual([
      "server-local-steps",
      "server-local-shot",
    ]);
    expect(test.evidenceUploader.uploadUiScenarioEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: test.input.lease,
        scope: expect.objectContaining({
          repositoryId: "repo",
          runId: "run",
          profileVersionId: "profile-version",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('"local-steps"');
  });
  it("retains finalized partial uploads and blocks completeness after upload failure", async () => {
    const test = harness(envelope(profile(true)));
    test.evidenceUploader.uploadUiScenarioEvidence.mockImplementation(async (input) => {
      const complete = uploadResult(input);
      const asset = complete.assets.find((candidate) => candidate.metadata.kind === "screenshot");
      if (asset === undefined) throw new Error("Fixture asset missing.");
      throw new EvidenceUploadError(
        "UPLOAD_FAILED",
        { assets: [asset], assetIds: { "local-shot": asset.id } },
        "local-steps",
      );
    });
    const result = typed(await test.run());
    expect(result.report.checks[0]?.evidenceIds).toEqual(["server-local-shot"]);
    expect(result.report.checks[0]?.outcome).toBe("blocked");
    expect(
      result.execution.diagnostics.find((diagnostic) => diagnostic.phase === "ui")?.outcome,
    ).toBe("blocked");
    expect(result.execution.blockers).toContainEqual(
      expect.objectContaining({
        phase: "evidence",
        stepId: null,
        code: "EVIDENCE_UPLOAD_INCOMPLETE",
      }),
    );
  });
  it("never submits success when upload loses the lease", async () => {
    const test = harness(envelope(profile(true)));
    test.evidenceUploader.uploadUiScenarioEvidence.mockRejectedValue(
      new EvidenceUploadError("ABORTED", { assets: [], assetIds: {} }, null, false, true),
    );
    await expect(test.run()).rejects.toBeInstanceOf(LeaseLostError);
    expect(test.validation.cleanup).not.toHaveBeenCalled();
    expect(test.cleanups.length).toBeGreaterThan(0);
  });
  it("does not submit success when cancelled after runner completion", async () => {
    const test = harness();
    test.headlessRunner.run.mockImplementation(async () => {
      test.cancellation.abort(new Error("Lease cancelled."));
      return observed();
    });
    await expect(test.run()).rejects.toThrow("Lease cancelled");
    expect(test.createModelExecutor).not.toHaveBeenCalled();
  });
  it("normalizes UI lifecycle diagnostics and global evidence blockers for storage", async () => {
    const test = harness(envelope(profile(true)));
    const output = uiObserved();
    output.cleanupState = "completed";
    for (const check of output.report.checks) check.outcome = "blocked";
    output.blockers.push({
      phase: "evidence",
      stepId: "profile-version:scenario",
      code: "LOCAL_EVIDENCE_FAILED",
      message: "The screenshot could not be finalized.",
    });
    test.uiRunner.run.mockResolvedValue(output);
    const result = typed(await test.run());
    expect(result.execution.cleanupState).toBe("not_needed");
    expect(result.execution.blockers[0]?.stepId).toBeNull();
    expect(result.execution.diagnostics.find((entry) => entry.phase === "ui")?.outcome).toBe(
      "blocked",
    );
  });
  it("rejects cross-attempt evidence returned by an uploader", async () => {
    const test = harness(envelope(profile(true)));
    test.evidenceUploader.uploadUiScenarioEvidence.mockImplementation(async (input) => {
      const result = uploadResult(input);
      return {
        ...result,
        assets: result.assets.map((asset) => ({ ...asset, runAttemptId: "foreign-attempt" })),
      };
    });
    expect(await test.run()).toMatchObject({
      outcome: "failed",
      code: "UI_EVIDENCE_SCOPE_INVALID",
    });
  });
});
