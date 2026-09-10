import { createHash } from "node:crypto";
import { win32 } from "node:path";
import {
  composeSummaryPrompt,
  createCanonicalResult,
  createValidationSummaryContext,
  redactExecutionText,
  type ValidationSummaryContextInput,
  type ValidationSummaryEvidenceContext,
} from "@agentic-review/codex";
import {
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  getValidationProfileConfigIssues,
  IssueValidationSummaryV1Schema,
  type JobExecutionEnvelopeV2,
  JobExecutionEnvelopeV2Schema,
  maximumRunCompletionResultUtf8Bytes,
  PullRequestValidationSummaryV1Schema,
  QualifiedValidationCheckIdSchema,
  type ReviewExecutionEvidence,
  UiScenarioExecutionEvidenceV1Schema,
  type UiScenarioStep,
  type UiStepExecutionEvidence,
  type ValidationExecutionDetails,
  ValidationExecutionDetailsSchema,
  type ValidationReportV1,
  ValidationReportV1Schema,
  type ValidationSummaryContextV1,
  type ValidationSummaryInputReferenceV1,
  type ValidationSummaryV1,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { LeaseLostError } from "../leases/errors.js";
import type { ModelSummaryInputApi } from "../server-client/summary-input-api.js";
import { freezeSummaryInput } from "./freeze-summary-input.js";
import type { JobExecutionContext } from "./job-executor.js";
import type { JobWorkspaceProvider, PreparedJobWorkspace } from "./job-workspace.js";
import {
  assertModelOutputArtifact,
  createModelOutputArtifact,
  type ModelOutputArtifact,
  modelOutputReview,
} from "./model-output-artifact.js";
import type { PreparedCliOutputRunner } from "./prepared-cli-output-runner.js";
import { assertWindowsLocalAbsolutePath } from "./process-host-protocol.js";

registerWorkerContractFormats();
export const maximumValidationSummaryContextBytes = 256 * 1_024;
const maximumCombinedPromptBytes = 512 * 1_024;
const minimumCliTimeoutMs = 10_000;
const noProgressSubmissionSafetyMs = 5_000;
const evidenceSchema = Type.Object(
  {
    assets: Type.Array(EvidenceAssetManifestSchema, { maxItems: 256 }),
    scenarios: Type.Array(
      Type.Object(
        {
          checkId: QualifiedValidationCheckIdSchema,
          execution: UiScenarioExecutionEvidenceV1Schema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
  },
  { additionalProperties: false },
);

export {
  composeSummaryPrompt,
  createValidationSummaryContext,
  type ValidationSummaryEvidenceContext,
} from "@agentic-review/codex";

export interface ValidationSummaryInput extends ValidationSummaryContextInput {
  readonly validationWorkspace: PreparedJobWorkspace;
}

export interface ValidationSummaryExecutorOptions {
  readonly workspaceProvider: JobWorkspaceProvider;
  readonly outputRunner: Pick<PreparedCliOutputRunner, "run">;
  readonly maximumSummaryTimeoutMs?: number;
  readonly completionReserveMs?: number;
  readonly teardownTimeoutMs?: number;
  readonly sensitiveValues?: readonly string[];
  readonly now?: () => number;
  readonly summaryInputApi?: ModelSummaryInputApi;
}

export type ValidationSummaryAttempt =
  | {
      readonly state: "completed";
      readonly summary: ValidationSummaryV1;
      readonly contextSha256: string;
      readonly promptSha256: string;
      readonly actualPromptSha256?: string;
      readonly modelOutputArtifact?: ModelOutputArtifact;
    }
  | {
      readonly state: "failed";
      readonly code: string;
      readonly message: string;
      readonly nodeFault?: true;
      readonly cleanupUnconfirmed?: true;
    };

class SummaryFailure extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SummaryFailure";
  }
}

function failure(code: string, message: string): SummaryFailure {
  return new SummaryFailure(code, message);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Produces optional advice only; it never owns or changes deterministic runner outcomes. */
export class ValidationSummaryExecutor {
  readonly #maximumTimeout: number;
  readonly #reserve: number;
  readonly #teardownTimeout: number;
  readonly #now: () => number;
  readonly #secrets: readonly string[];

  public constructor(private readonly options: ValidationSummaryExecutorOptions) {
    this.#maximumTimeout = options.maximumSummaryTimeoutMs ?? 60_000;
    this.#reserve = options.completionReserveMs ?? 30_000;
    this.#teardownTimeout = options.teardownTimeoutMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    this.#secrets = Object.freeze([...(options.sensitiveValues ?? [])]);
    if (
      !Number.isSafeInteger(this.#maximumTimeout) ||
      this.#maximumTimeout < minimumCliTimeoutMs ||
      this.#maximumTimeout > 300_000 ||
      !Number.isSafeInteger(this.#reserve) ||
      this.#reserve < 5_000 ||
      this.#reserve > 300_000 ||
      !Number.isSafeInteger(this.#teardownTimeout) ||
      this.#teardownTimeout < 1_000 ||
      this.#teardownTimeout > 60_000
    ) {
      throw new RangeError("Validation summary timeout and completion reserve are invalid.");
    }
  }

  public async execute(
    input: ValidationSummaryInput,
    context: JobExecutionContext,
  ): Promise<ValidationSummaryAttempt> {
    context.signal.throwIfAborted();
    const attemptSignal = context.attemptSignal ?? context.signal;
    let timer: NodeJS.Timeout | undefined;
    let nodeFault = false;
    let cleanupUnconfirmed = false;
    const reportNodeHealthFault = (error: Error): void => {
      nodeFault = true;
      const code = (error as Error & { readonly code?: unknown }).code;
      if (
        [
          "CLI_PROCESS_START_FAILED",
          "CLI_PROCESS_FAILED",
          "CLI_STREAM_FAILED",
          "CLI_PROCESS_DRAIN_UNCONFIRMED",
        ].includes(String(code))
      )
        cleanupUnconfirmed = true;
      context.reportNodeHealthFault(error);
    };
    const child = new AbortController();
    const cancel = (): void => child.abort(context.signal.reason);
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      const envelope = freeze(structuredClone(input.envelope));
      const report = structuredClone(input.runnerReport);
      const execution = structuredClone(input.runnerExecution);
      const evidence = structuredClone(input.evidenceContext);
      const observationResults =
        input.observationResults === undefined
          ? undefined
          : freeze(structuredClone(input.observationResults));
      const validationDirectories = workspaceDirectories(input.validationWorkspace);
      const authority = validateSummaryAuthority(envelope);
      validateEvidenceContext(envelope, report, execution, evidence);
      const canonicalContext = createValidationSummaryContext({
        envelope,
        runnerReport: report,
        runnerExecution: execution,
        evidenceContext: evidence,
        ...(observationResults === undefined ? {} : { observationResults }),
      });
      const sensitive = [envelope.lease.leaseToken, ...this.#secrets].filter(
        (value) => value.length > 0,
      );
      const diagnosticSecrets = [
        ...new Set(sensitive.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])),
      ];
      if (containsProtectedValue(JSON.parse(canonicalContext.json), sensitive)) {
        throw failure("SUMMARY_CONTEXT_UNSAFE", "The summary context contains protected values.");
      }
      if (Buffer.byteLength(canonicalContext.json, "utf8") > maximumValidationSummaryContextBytes) {
        throw failure(
          "SUMMARY_CONTEXT_TOO_LARGE",
          "The complete summary context exceeds its input budget.",
        );
      }
      const prompt = composeSummaryPrompt(envelope.prompt.renderedPrompt, canonicalContext.json);
      const actualPromptSha256 = hash(prompt);
      let summaryInputRef: ValidationSummaryInputReferenceV1 | undefined;
      if (Buffer.byteLength(prompt, "utf8") > maximumCombinedPromptBytes) {
        throw failure(
          "SUMMARY_CONTEXT_TOO_LARGE",
          "The frozen prompt and complete context exceed the CLI input budget.",
        );
      }
      const deadline = Math.min(
        Date.parse(envelope.executionDeadlineAt),
        Date.parse(envelope.assignedAt) + envelope.executionPolicy.hardTimeoutMs,
      );
      const available = Math.min(
        deadline - this.#now() - this.#reserve - this.#teardownTimeout,
        envelope.executionPolicy.noProgressTimeoutMs -
          this.#teardownTimeout -
          noProgressSubmissionSafetyMs,
      );
      const budget = Math.min(this.#maximumTimeout, available);
      if (!Number.isSafeInteger(budget) || budget < minimumCliTimeoutMs) {
        throw failure(
          "SUMMARY_BUDGET_UNAVAILABLE",
          "Insufficient execution or no-progress time remains for summary, teardown, and completion.",
        );
      }
      if (context.deferCleanup === undefined) {
        throw failure(
          "SUMMARY_CLEANUP_UNAVAILABLE",
          "The Worker cannot retain model workspace cleanup through terminal reporting.",
        );
      }
      timer = setTimeout(
        () =>
          child.abort(
            failure("SUMMARY_TIMEOUT", "The optional summary exhausted its execution budget."),
          ),
        budget,
      );
      timer.unref();
      if (context.signal.aborted) cancel();
      child.signal.throwIfAborted();
      if (envelope.validation.schemaVersion === "ValidationJobContextV2") {
        if (this.options.summaryInputApi === undefined)
          throw failure(
            "SUMMARY_INPUT_UNAVAILABLE",
            "The evaluation summary input API is not configured.",
          );
        summaryInputRef = await freezeSummaryInput(
          this.options.summaryInputApi,
          envelope,
          JSON.parse(canonicalContext.json) as ValidationSummaryContextV1,
          child.signal,
        );
        child.signal.throwIfAborted();
      }
      let workspace: PreparedJobWorkspace | undefined;
      let cleanup: Promise<void> | undefined;
      context.deferCleanup(() => {
        cleanup ??= Promise.resolve().then(async () => {
          try {
            await workspace?.cleanup();
          } catch {
            const fault = failure(
              "SUMMARY_CLEANUP_FAILED",
              "The model workspace could not be cleaned up.",
            );
            reportNodeHealthFault(fault);
            throw fault;
          }
        });
        return cleanup;
      });
      const prepared = await this.options.workspaceProvider.prepare(
        envelope,
        {
          signal: child.signal,
          processHost: context.processHost,
          reportProcessCount: (processCount) =>
            context.reportProgress({ phase: "preparing", processCount }),
          reportNodeHealthFault: (fault) => reportNodeHealthFault(fault),
        },
        "model",
      );
      if (
        workspaceDirectories(prepared).some((directory) =>
          validationDirectories.some((original) => !separate(directory, original)),
        )
      ) {
        const fault = failure(
          "SUMMARY_WORKSPACE_NOT_ISOLATED",
          "The summary workspace is not separate from runner validation.",
        );
        reportNodeHealthFault(fault);
        throw fault;
      }
      workspace = prepared;
      child.signal.throwIfAborted();
      if (nodeFault)
        throw failure(
          "SUMMARY_NODE_FAULT",
          "A Worker health fault prevents safe summary execution.",
        );
      await requireOriginalModelSource(workspace, child.signal);
      const result = await this.options.outputRunner.run({
        workspace,
        context: { ...context, signal: child.signal, attemptSignal, reportNodeHealthFault },
        authoritativeSchema: authority,
        prompt,
        hardTimeoutMs: budget,
        noProgressTimeoutMs: Math.min(envelope.executionPolicy.noProgressTimeoutMs, budget),
        correlationId: envelope.lease.runAttemptId,
        launchPolicy: "summary_read_only",
        teardownTimeoutMs: this.#teardownTimeout,
        sensitiveValues: diagnosticSecrets,
      });
      context.signal.throwIfAborted();
      child.signal.throwIfAborted();
      if (nodeFault)
        throw failure(
          "SUMMARY_NODE_FAULT",
          "A Worker health fault invalidates the optional summary.",
        );
      if (result.outcome === "failed") {
        const code =
          typeof result.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,127}$/u.test(result.code) &&
          redactExecutionText(result.code, diagnosticSecrets) === result.code
            ? result.code
            : "SUMMARY_EXECUTION_FAILED";
        const fallback = "CLI did not complete the optional structured summary.";
        const detail = [result.diagnostics?.summary, result.message].find(
          (value) => typeof value === "string" && value.trim().length > 0,
        );
        const message = redactExecutionText(detail ?? fallback, diagnosticSecrets).toWellFormed();
        throw failure(code, message.trim().length > 0 ? message : fallback);
      }
      const originalOutput = {
        outcome: "succeeded" as const,
        result: structuredClone(result.result),
        canonicalResultJson: result.canonicalResultJson,
        resultDigest: result.resultDigest,
        cliExecution: structuredClone(result.cliExecution),
      };
      const originalEvidence = structuredClone(result.commandEvidence);
      const modelWorktree = await requireOriginalModelSource(workspace, child.signal);
      if (result.observedFileChange) {
        throw failure(
          "SUMMARY_CONTEXT_MODIFIED",
          "Model workspace changes invalidate the optional advice.",
        );
      }
      const summary: unknown = originalOutput.result;
      if (
        !Value.Check(authority.resultSchema, summary) ||
        createCanonicalResult(summary).sha256 !== originalOutput.resultDigest
      ) {
        throw failure(
          "SUMMARY_RESULT_INVALID",
          "The summary does not match its authoritative schema and digest.",
        );
      }
      validateObservations(summary);
      let modelOutputArtifact: ModelOutputArtifact | undefined;
      if (summaryInputRef !== undefined) {
        modelOutputArtifact = assertModelOutputArtifact(
          createModelOutputArtifact({
            output: originalOutput,
            executionEvidence: {
              schemaVersion: "ReviewExecutionEvidenceV1",
              source: "worker",
              ...originalEvidence,
              worktree: modelWorktree,
            },
            envelope,
            summaryInputRef,
            sensitiveValues: sensitive,
          }),
          envelope,
          actualPromptSha256,
          canonicalContext.sha256,
        );
      }
      const combined = createCanonicalResult({
        schemaVersion:
          modelOutputArtifact === undefined ? "ValidationJobResultV1" : "ValidationJobResultV2",
        report: modelOutputArtifact === undefined ? { ...report, modelSummary: summary } : report,
        execution,
        modelReview:
          modelOutputArtifact === undefined
            ? { state: "not_requested" }
            : modelOutputReview(modelOutputArtifact),
        ...(observationResults ?? {}),
      });
      if (Buffer.byteLength(combined.json, "utf8") > maximumRunCompletionResultUtf8Bytes) {
        throw failure(
          "SUMMARY_RESULT_TOO_LARGE",
          "The optional summary would exceed the terminal report budget.",
        );
      }
      if (containsProtectedValue(summary, sensitive)) {
        throw failure(
          "SUMMARY_RESULT_UNSAFE",
          "The summary contains protected values and cannot be retained.",
        );
      }
      context.signal.throwIfAborted();
      child.signal.throwIfAborted();
      if (nodeFault)
        throw failure(
          "SUMMARY_NODE_FAULT",
          "A Worker health fault invalidates the optional summary.",
        );
      return Object.freeze({
        state: "completed",
        summary: freeze(structuredClone(summary)),
        contextSha256: canonicalContext.sha256,
        promptSha256: envelope.prompt.promptSha256,
        ...(modelOutputArtifact === undefined ? {} : { modelOutputArtifact, actualPromptSha256 }),
      });
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof LeaseLostError) throw error;
      const known =
        child.signal.aborted && child.signal.reason instanceof SummaryFailure
          ? child.signal.reason
          : error;
      return known instanceof SummaryFailure
        ? {
            state: "failed",
            code: known.code,
            message: known.message,
            ...(nodeFault ? { nodeFault: true } : {}),
            ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
          }
        : {
            state: "failed",
            code: "SUMMARY_EXECUTION_FAILED",
            message: "The optional summary could not be completed safely.",
            ...(nodeFault ? { nodeFault: true } : {}),
            ...(cleanupUnconfirmed ? { cleanupUnconfirmed: true } : {}),
          };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      context.signal.removeEventListener("abort", cancel);
    }
  }
}

function validateSummaryAuthority(envelope: JobExecutionEnvelopeV2) {
  if (!Value.Check(JobExecutionEnvelopeV2Schema, envelope)) {
    throw failure("SUMMARY_ENVELOPE_INVALID", "The summary requires a valid frozen V2 envelope.");
  }
  const validation = envelope.validation;
  const isPr = envelope.resource.kind === "pull_request";
  if (
    (isPr ? validation.workflowKind !== "pr_ui" : validation.workflowKind !== "issue_validation") ||
    validation.profileVersion.workflowKind !== validation.workflowKind ||
    validation.profileVersion.target !== validation.target ||
    validation.profileVersion.repositoryId !== validation.repositoryId ||
    envelope.prompt.name !== validation.promptVersion.templateId ||
    envelope.prompt.version !== String(validation.promptVersion.version) ||
    envelope.job.jobId !== envelope.lease.jobId ||
    !envelope.prompt.renderedPrompt.isWellFormed() ||
    hash(envelope.prompt.renderedPrompt) !== envelope.prompt.promptSha256 ||
    createCanonicalResult(validation.profileVersion.config).sha256 !==
      validation.profileVersion.configSha256 ||
    getValidationProfileConfigIssues(
      validation.profileVersion.config,
      validation.workflowKind,
      validation.target,
    ).length > 0
  ) {
    throw failure(
      "SUMMARY_ENVELOPE_INVALID",
      "The frozen prompt does not authorize this summary workflow.",
    );
  }
  const schema = isPr ? PullRequestValidationSummaryV1Schema : IssueValidationSummaryV1Schema;
  const canonical = createCanonicalResult(JSON.parse(JSON.stringify(schema)));
  const supplied = createCanonicalResult(envelope.prompt.outputSchema);
  if (canonical.sha256 !== envelope.prompt.outputSchemaSha256 || supplied.json !== canonical.json) {
    throw failure(
      "SUMMARY_ENVELOPE_INVALID",
      "The summary must use its deployed authoritative output schema.",
    );
  }
  return Object.freeze({ json: canonical.json, digest: canonical.sha256, resultSchema: schema });
}

function validateEvidenceContext(
  envelope: JobExecutionEnvelopeV2,
  report: ValidationReportV1,
  execution: ValidationExecutionDetails,
  evidence: ValidationSummaryEvidenceContext,
): void {
  if (
    !Value.Check(ValidationReportV1Schema, report) ||
    !Value.Check(ValidationExecutionDetailsSchema, execution) ||
    !Value.Check(evidenceSchema, evidence) ||
    report.workItemKind !== envelope.resource.kind ||
    report.modelSummary !== undefined
  ) {
    throw failure(
      "SUMMARY_CONTEXT_INVALID",
      "The Worker summary context is invalid or already contains model advice.",
    );
  }
  const checks = new Map(report.checks.map((check) => [check.id, check]));
  if (
    checks.size !== report.checks.length ||
    report.checks.some((check) => check.source !== "runner")
  ) {
    throw failure("SUMMARY_CONTEXT_INVALID", "The summary requires distinct runner-owned checks.");
  }
  const expected = new Map<string, { readonly kind: string; readonly required: boolean }>();
  const profile = envelope.validation.profileVersion;
  for (const phase of ["setup", "build", "test", "cleanup"] as const) {
    for (const step of profile.config[phase])
      expected.set(`${profile.id}:${step.id}`, {
        kind: phase === "build" || phase === "test" ? phase : "static",
        required: step.required,
      });
  }
  for (const scenario of profile.config.ui?.scenarios ?? [])
    expected.set(`${profile.id}:${scenario.id}`, { kind: "ui", required: scenario.required });
  if (
    expected.size !== checks.size ||
    [...checks.values()].some(
      (check) =>
        expected.get(check.id)?.kind !== check.kind ||
        expected.get(check.id)?.required !== check.required,
    )
  ) {
    throw failure(
      "SUMMARY_CONTEXT_INVALID",
      "The summary context must retain every frozen runner check.",
    );
  }
  const assets = new Map<string, EvidenceAssetManifest>();
  for (const asset of evidence.assets) {
    const validation = envelope.validation;
    if (
      assets.has(asset.id) ||
      asset.state !== "finalized" ||
      asset.retiredAt !== null ||
      asset.repositoryId !== validation.repositoryId ||
      asset.runId !== validation.runId ||
      asset.requestId !== validation.requestId ||
      asset.jobId !== envelope.job.jobId ||
      asset.runAttemptId !== envelope.lease.runAttemptId ||
      asset.profileVersionId !== validation.profileVersion.id ||
      asset.revisionKey !== validation.revisionKey ||
      asset.planDigest !== validation.planDigest ||
      asset.metadata.checkId === undefined ||
      !checks.get(asset.metadata.checkId)?.evidenceIds.includes(asset.id)
    ) {
      throw failure(
        "SUMMARY_CONTEXT_INVALID",
        "The summary evidence does not belong to this frozen check and attempt.",
      );
    }
    assets.set(asset.id, asset);
  }
  for (const check of checks.values()) {
    if (check.evidenceIds.some((id) => assets.get(id)?.metadata.checkId !== check.id)) {
      throw failure(
        "SUMMARY_CONTEXT_INVALID",
        "The summary context omits finalized evidence references.",
      );
    }
  }
  const scenarios = new Set<string>();
  for (const scenario of evidence.scenarios) {
    const check = checks.get(scenario.checkId);
    const planned = envelope.validation.profileVersion.config.ui?.scenarios.find(
      (candidate) =>
        `${envelope.validation.profileVersion.id}:${candidate.id}` === scenario.checkId,
    );
    if (
      scenarios.has(scenario.checkId) ||
      check?.kind !== "ui" ||
      planned === undefined ||
      scenario.execution.scenarioId !== planned.id ||
      scenario.execution.target !== envelope.validation.target ||
      scenario.execution.steps.length !== planned.steps.length ||
      scenario.execution.steps.some(
        (step, index) =>
          step.stepId !== planned.steps[index]?.id ||
          !matchesObservation(planned.steps[index], step) ||
          (check.outcome === "passed" && step.outcome !== "passed") ||
          step.evidenceIds.some(
            (id) =>
              assets.get(id)?.metadata.kind !== "screenshot" || !check.evidenceIds.includes(id),
          ),
      )
    ) {
      throw failure(
        "SUMMARY_CONTEXT_INVALID",
        "The summary scenario context does not match the frozen UI assertions.",
      );
    }
    const documents = check.evidenceIds
      .map((id) => assets.get(id))
      .filter((asset): asset is EvidenceAssetManifest => asset?.metadata.kind === "steps");
    const serialized = JSON.stringify(scenario.execution);
    if (
      documents.length !== 1 ||
      documents[0]?.metadata.sha256 !== hash(serialized) ||
      documents[0].metadata.sizeBytes !== Buffer.byteLength(serialized, "utf8")
    ) {
      throw failure(
        "SUMMARY_CONTEXT_INVALID",
        "The typed summary observations differ from their finalized evidence document.",
      );
    }
    scenarios.add(scenario.checkId);
  }
  if (
    report.checks.some(
      (check) => check.kind === "ui" && check.evidenceIds.length > 0 && !scenarios.has(check.id),
    )
  ) {
    throw failure("SUMMARY_CONTEXT_INVALID", "The summary context omits recorded UI observations.");
  }
}

function matchesObservation(
  planned: UiScenarioStep | undefined,
  actual: UiStepExecutionEvidence,
): boolean {
  if (
    planned === undefined ||
    actual.name !== planned.name ||
    actual.action !== planned.action ||
    actual.expected !== ("expected" in planned ? planned.expected : null)
  )
    return false;
  if (planned.action === "click" || planned.action === "fill") return actual.actual === null;
  if (actual.outcome !== "passed") return true;
  if (planned.action === "assertText")
    return (
      typeof actual.actual === "string" &&
      (planned.match === "exact"
        ? actual.actual === planned.expected
        : actual.actual.includes(planned.expected))
    );
  return actual.actual === planned.expected;
}

function validateObservations(summary: ValidationSummaryV1): void {
  const ids = new Set<string>();
  for (const observation of summary.observations) {
    const path = observation.path;
    if (
      ids.has(observation.id) ||
      (observation.line !== null && path === null) ||
      (path !== null &&
        (!path.isWellFormed() ||
          /^[\\/]/u.test(path) ||
          /[\\:]/u.test(path) ||
          [...path].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")))
    ) {
      throw failure(
        "SUMMARY_RESULT_INVALID",
        "The model observations contain ambiguous identities or source locations.",
      );
    }
    ids.add(observation.id);
  }
}

async function requireOriginalModelSource(
  workspace: PreparedJobWorkspace,
  signal: AbortSignal,
): Promise<ReviewExecutionEvidence["worktree"]> {
  let state: "clean" | "modified" | "unknown" = "unknown";
  try {
    state = (await workspace.captureWorktreeState?.(signal)) ?? "unknown";
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    signal.throwIfAborted();
  }
  signal.throwIfAborted();
  if (state !== "clean") {
    throw failure(
      state === "modified" ? "SUMMARY_CONTEXT_MODIFIED" : "SUMMARY_CONTEXT_UNKNOWN",
      "The model source is changed or unverified; advice was discarded.",
    );
  }
  return { status: "clean", source: "git_status" };
}

function workspaceDirectories(workspace: PreparedJobWorkspace): readonly string[] {
  return [
    workspace.attemptDirectory,
    workspace.checkoutDirectory,
    workspace.controlDirectory,
    workspace.tempDirectory,
    workspace.userProfileDirectory,
  ].map((directory) => {
    assertWindowsLocalAbsolutePath(directory, "Summary workspace", false);
    return win32.normalize(directory);
  });
}

function separate(left: string, right: string): boolean {
  const relation = win32.relative(
    win32.normalize(left).toLowerCase(),
    win32.normalize(right).toLowerCase(),
  );
  const reverse = win32.relative(
    win32.normalize(right).toLowerCase(),
    win32.normalize(left).toLowerCase(),
  );
  const outside = (value: string): boolean =>
    value === ".." || value.startsWith("..\\") || win32.isAbsolute(value);
  return outside(relation) && outside(reverse);
}

function containsProtectedValue(value: unknown, sensitive: readonly string[]): boolean {
  if (typeof value === "string") return sensitive.some((secret) => value.includes(secret));
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).some((child) => containsProtectedValue(child, sensitive))
  );
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
