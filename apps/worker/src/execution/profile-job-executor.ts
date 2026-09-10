import { createHash } from "node:crypto";
import { win32 } from "node:path";
import {
  createCanonicalResult,
  getValidationJobResultV2Issues,
  IssueTriageV2ModelResultSchema,
  IssueTriageV2Schema,
  PrReviewPlanV2ModelResultSchema,
  PrReviewPlanV2Schema,
  redactExecutionText,
  ValidationJobResultV1Schema,
  ValidationJobResultV2Schema,
} from "@agentic-review/codex";
import {
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  IssueValidationSummaryV1Schema,
  type JobExecutionEnvelope,
  JobExecutionEnvelopeSchema,
  type JobExecutionEnvelopeV2,
  matchesUiScenarioObservations,
  maximumRunCompletionResultUtf8Bytes,
  maximumValidationCheckEvidenceReferences,
  PullRequestValidationSummaryV1Schema,
  type UiScenarioExecutionEvidenceV1,
  UiScenarioExecutionEvidenceV1Schema,
  type ValidationCheckResult,
  type ValidationExecutionDetails,
  ValidationExecutionDetailsSchema,
  type ValidationLifecyclePhase,
  type ValidationProfileVersion,
  type ValidationReportV1,
  ValidationReportV1Schema,
  type ValidationStepDiagnostic,
  type ValidationSummaryV1,
} from "@agentic-review/contracts";
import { jobRequiresModelExecution } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { ExecutionTimeoutError, LeaseLostError } from "../leases/errors.js";
import {
  EvidenceUploadError,
  type EvidenceUploader,
  type EvidenceUploadResult,
  type UiScenarioEvidenceUploadInput,
} from "./evidence-uploader.js";
import {
  createReproductionAssessment,
  createTestProbeReceipts,
  type ValidationObservationResults,
} from "./issue-reproduction-results.js";
import type {
  JobExecutionContext,
  JobExecutionResult,
  JobExecutor,
  ProfileModelExecutor,
} from "./job-executor.js";
import {
  JobWorkspaceError,
  type JobWorkspaceProvider,
  type PreparedJobWorkspace,
} from "./job-workspace.js";
import { assertModelOutputArtifact, modelOutputReview } from "./model-output-artifact.js";
import { validateProfileEnvelope } from "./profile-envelope.js";
import {
  dispatchProfileModel,
  type ProfileModelReview,
  resolveProfileModelPolicy,
} from "./profile-model-policy.js";
import type { UiProfileResult, UiProfileRunner } from "./ui-profile-runner.js";
import type {
  HeadlessValidationCheckResult,
  HeadlessValidationCheckRunner,
} from "./validation-check-runner.js";
import {
  composeSummaryPrompt,
  createValidationSummaryContext,
  type ValidationSummaryAttempt,
  type ValidationSummaryEvidenceContext,
  type ValidationSummaryExecutor,
  type ValidationSummaryInput,
} from "./validation-summary-executor.js";

type ModelReview = ProfileModelReview;

export interface ProfileJobExecutorOptions {
  readonly modelExecutionEnabled?: boolean;
  readonly legacyExecutor: JobExecutor;
  readonly workspaceProvider: JobWorkspaceProvider;
  readonly headlessRunner?: Pick<HeadlessValidationCheckRunner, "run">;
  readonly createHeadlessRunner?: (
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
    workspace: PreparedJobWorkspace,
  ) => Pick<HeadlessValidationCheckRunner, "run">;
  readonly createUiRunner?: (
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
    workspace: PreparedJobWorkspace,
  ) => Pick<UiProfileRunner, "run">;
  readonly createModelExecutor?: (
    workspaceProvider: JobWorkspaceProvider,
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
  ) => ProfileModelExecutor;
  readonly evidenceUploader?: Pick<EvidenceUploader, "uploadUiScenarioEvidence">;
  readonly createSummaryExecutor?: (
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
  ) => Pick<ValidationSummaryExecutor, "execute"> | undefined;
  /** Applies only to optional ordinary summaries, never to frozen evaluation requirements. */
  readonly optionalSummariesEnabled?: boolean;
  readonly now?: () => Date;
}
class ProfileExecutionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ProfileExecutionError";
  }
}
interface ExpectedCheck {
  readonly name: string;
  readonly kind: ValidationCheckResult["kind"];
  readonly phase: ValidationLifecyclePhase;
  readonly required: boolean;
}
interface SummaryEvidence {
  readonly context: ValidationSummaryEvidenceContext;
  readonly complete: boolean;
}
/** Dispatches frozen profile jobs without allowing model work to alter runner evidence. */
export class ProfileJobExecutor implements JobExecutor {
  public constructor(private readonly options: ProfileJobExecutorOptions) {}

  public async execute(
    envelope: JobExecutionEnvelope,
    context: JobExecutionContext,
  ): Promise<JobExecutionResult> {
    if (this.options.modelExecutionEnabled === false) {
      registerWorkerContractFormats();
      if (!Value.Check(JobExecutionEnvelopeSchema, envelope))
        return failed("VALIDATION_ENVELOPE_INVALID", "The execution envelope is invalid.");
      if (jobRequiresModelExecution(envelope))
        return failed(
          "MODEL_EXECUTION_DISABLED",
          "This Worker does not execute models; the required model task was not started.",
        );
    }
    if (envelope.envelopeVersion === 1) {
      if ("validation" in envelope)
        return failed("VALIDATION_ENVELOPE_INVALID", "The execution envelope is invalid.");
      return this.options.legacyExecutor.execute(envelope, context);
    }
    registerWorkerContractFormats();
    try {
      validateProfileEnvelope(envelope);
    } catch {
      return failed(
        "VALIDATION_ENVELOPE_INVALID",
        "The validation envelope, frozen profile, or prompt identity is invalid.",
      );
    }
    if (context.deferCleanup === undefined)
      return failed(
        "CLEANUP_REGISTRATION_UNAVAILABLE",
        "The Worker cannot retain validation workspaces through terminal reporting.",
      );
    const frozen = structuredClone(envelope);
    const profile = frozen.validation.profileVersion;
    const now = this.options.now ?? (() => new Date());
    const remaining = Math.min(
      frozen.executionPolicy.hardTimeoutMs,
      Date.parse(frozen.executionDeadlineAt) - now().getTime(),
    );
    const execution = new AbortController();
    const abort = (): void => execution.abort(context.signal.reason);
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    const timer = setTimeout(
      () => execution.abort(new ExecutionTimeoutError(Math.max(0, remaining))),
      Math.max(0, remaining),
    );
    timer.unref();
    if (remaining <= 0) execution.abort(new ExecutionTimeoutError(0));
    const scopedContext: JobExecutionContext = {
      signal: execution.signal,
      attemptSignal: context.attemptSignal ?? context.signal,
      processHost: context.processHost,
      reportProgress: (progress) => context.reportProgress(progress),
      reportNodeHealthFault: (error) => context.reportNodeHealthFault(error),
      deferCleanup: (cleanup) => context.deferCleanup?.(cleanup),
    };
    let workspace: PreparedJobWorkspace | undefined;
    const cleanupValidation = cleanupOnce(async () => {
      try {
        await workspace?.cleanup();
      } catch (error) {
        context.reportNodeHealthFault(asError(error, "Validation workspace cleanup failed."));
        throw error;
      }
    });
    context.deferCleanup(cleanupValidation);
    try {
      execution.signal.throwIfAborted();
      scopedContext.reportProgress({ phase: "preparing", processCount: 0 });
      workspace = await this.options.workspaceProvider.prepare(
        frozen,
        preparationContext(scopedContext),
        "validation",
      );
      execution.signal.throwIfAborted();
      scopedContext.reportProgress({ phase: "validation", processCount: 0 });
      let observed: HeadlessValidationCheckResult | UiProfileResult;
      if (profile.target === "headless") {
        const runner =
          this.options.createHeadlessRunner?.(frozen, scopedContext, workspace) ??
          this.options.headlessRunner;
        if (runner === undefined)
          throw new ProfileExecutionError(
            "PROFILE_EXECUTOR_UNAVAILABLE",
            "The headless profile executor is not configured.",
          );
        observed = await runner.run({
          profile,
          workspace,
          workItemKind: frozen.resource.kind,
          processHost: scopedContext.processHost,
          signal: execution.signal,
        });
      } else {
        const runner = this.options.createUiRunner?.(frozen, scopedContext, workspace);
        if (runner === undefined)
          throw new ProfileExecutionError(
            "PROFILE_EXECUTOR_UNAVAILABLE",
            "The requested UI profile executor is not configured.",
          );
        observed = await runner.run({
          envelope: frozen,
          profile,
          workspace,
          processHost: scopedContext.processHost,
          signal: execution.signal,
          reportNodeHealthFault: scopedContext.reportNodeHealthFault,
        });
      }
      execution.signal.throwIfAborted();
      const normalized = normalizeRunnerResult(observed, profile, frozen.resource.kind);
      const report = normalized.report;
      const details = normalized.execution;
      let summaryEvidence: SummaryEvidence = {
        context: { assets: [], scenarios: [] },
        complete: true,
      };
      if (profile.target !== "headless") {
        if (!("scenarioEvidence" in observed) || !Array.isArray(observed.scenarioEvidence))
          throw new ProfileExecutionError(
            "UI_EVIDENCE_SCOPE_INVALID",
            "The UI runner did not return its typed evidence bundles.",
          );
        summaryEvidence = await this.#uploadEvidence(
          frozen,
          scopedContext,
          observed,
          report,
          details,
          now,
        );
      }
      execution.signal.throwIfAborted();
      const probeReceipts = createTestProbeReceipts(
        frozen,
        report,
        details,
        observed.probeCaptures,
      );
      const initialAssessment = createReproductionAssessment(
        frozen,
        report,
        details,
        summaryEvidence.context,
        probeReceipts,
      );
      if (report.workItemKind === "issue" && initialAssessment !== undefined)
        report.reproductionConclusion = initialAssessment.conclusion;
      const observations: ValidationObservationResults = {
        ...(probeReceipts === undefined ? {} : { probeReceipts }),
        ...(initialAssessment === undefined ? {} : { reproductionAssessment: initialAssessment }),
      };
      if (
        Buffer.byteLength(
          createCanonicalResult({
            schemaVersion: "ValidationJobResultV1",
            report,
            execution: details,
            modelReview: { state: "not_requested" },
            ...observations,
          }).json,
          "utf8",
        ) > maximumRunCompletionResultUtf8Bytes
      )
        throw new ProfileExecutionError(
          "VALIDATION_RESULT_TOO_LARGE",
          "The complete runner observations exceed the terminal reporting limit.",
        );
      const modelPolicy = resolveProfileModelPolicy(
        frozen.validation,
        this.options.modelExecutionEnabled === false
          ? false
          : this.options.optionalSummariesEnabled,
      );
      const useV2 = modelPolicy.retainModelOutput;
      if (useV2) {
        // Reserve the largest bounded failure wrapper before starting an evaluation model.
        // Runner facts that cannot fit a complete failure result are rejected before dispatch.
        const reservedExecution = structuredClone(details);
        let blockerUtf8Reserve = 0;
        if (reservedExecution.blockers.length < 160) {
          reservedExecution.blockers.push({
            phase: "model_review",
            stepId: null,
            code: "MODEL_REVIEW_REQUIRED",
            message: "x".repeat(2048),
          });
          blockerUtf8Reserve = 3 * 2048;
        }
        const reservedReport = structuredClone(report);
        const reservedAssessment = createReproductionAssessment(
          frozen,
          reservedReport,
          reservedExecution,
          summaryEvidence.context,
          probeReceipts,
        );
        if (reservedReport.workItemKind === "issue" && reservedAssessment !== undefined)
          reservedReport.reproductionConclusion = reservedAssessment.conclusion;
        const reserved = {
          schemaVersion: "ValidationJobResultV2",
          report: reservedReport,
          execution: reservedExecution,
          modelReview: { state: "failed", code: "X".repeat(128), message: "x".repeat(4 * 2048) },
          ...(probeReceipts === undefined ? {} : { probeReceipts }),
          ...(reservedAssessment === undefined
            ? {}
            : { reproductionAssessment: reservedAssessment }),
        };
        if (
          Buffer.byteLength(createCanonicalResult(reserved).json, "utf8") + blockerUtf8Reserve >
          maximumRunCompletionResultUtf8Bytes
        )
          throw new ProfileExecutionError(
            "VALIDATION_RESULT_TOO_LARGE",
            "The complete runner observations leave insufficient capacity for required model failure reporting.",
          );
      }
      const validationWorkspace = workspace;
      let modelReview = await dispatchProfileModel(modelPolicy, {
        review: (retainModelOutput) =>
          this.#reviewModel(frozen, scopedContext, validationWorkspace, retainModelOutput),
        ...(this.options.createSummaryExecutor === undefined
          ? {}
          : {
              summary: (retainModelOutput: boolean) =>
                this.#optionalSummary(
                  frozen,
                  scopedContext,
                  validationWorkspace,
                  report,
                  details,
                  summaryEvidence,
                  observations,
                  retainModelOutput,
                ),
            }),
      });
      if (
        modelPolicy.required &&
        modelReview.state !== "completed" &&
        (!useV2 || details.blockers.length < 160)
      )
        details.blockers.push({
          phase: "model_review",
          stepId: null,
          code: "MODEL_REVIEW_REQUIRED",
          message: "The required model step did not complete for this frozen prompt.",
        });
      execution.signal.throwIfAborted();
      const reproductionAssessment = createReproductionAssessment(
        frozen,
        report,
        details,
        summaryEvidence.context,
        probeReceipts,
      );
      if (report.workItemKind === "issue" && reproductionAssessment !== undefined)
        report.reproductionConclusion = reproductionAssessment.conclusion;
      const result: Record<string, unknown> = {
        schemaVersion: useV2 ? "ValidationJobResultV2" : "ValidationJobResultV1",
        report,
        execution: details,
        modelReview,
        ...(probeReceipts === undefined ? {} : { probeReceipts }),
        ...(reproductionAssessment === undefined ? {} : { reproductionAssessment }),
      };
      if (
        useV2 &&
        modelReview.state === "completed" &&
        Buffer.byteLength(createCanonicalResult(result).json, "utf8") >
          maximumRunCompletionResultUtf8Bytes
      ) {
        modelReview = {
          state: "failed",
          code: "MODEL_RESULT_TOO_LARGE",
          message:
            "The complete model output exceeds the remaining terminal capacity; runner observations are retained.",
        };
        result.modelReview = modelReview;
        if (modelPolicy.required && details.blockers.length < 160)
          details.blockers.push({
            phase: "model_review",
            stepId: null,
            code: "MODEL_REVIEW_REQUIRED",
            message: "The required model output could not be retained within the result budget.",
          });
      }
      if (
        useV2
          ? !Value.Check(ValidationJobResultV2Schema, result) ||
            getValidationJobResultV2Issues(result).length > 0
          : !Value.Check(ValidationJobResultV1Schema, result)
      )
        throw new ProfileExecutionError(
          "VALIDATION_RESULT_INVALID",
          "The combined validation result failed its strict schema.",
        );
      const canonical = createCanonicalResult(result);
      if (Buffer.byteLength(canonical.json, "utf8") > maximumRunCompletionResultUtf8Bytes)
        throw new ProfileExecutionError(
          "VALIDATION_RESULT_TOO_LARGE",
          "The combined validation result exceeds the terminal reporting limit.",
        );
      execution.signal.throwIfAborted();
      scopedContext.reportProgress({ phase: "completing", processCount: 0 });
      return {
        outcome: "succeeded",
        resultDigest: canonical.sha256,
        result: JSON.parse(canonical.json),
      };
    } catch (error) {
      if (execution.signal.aborted) throw execution.signal.reason;
      if (error instanceof LeaseLostError) throw error;
      if (error instanceof ProfileExecutionError)
        return failed(error.code, error.message, error.retryable);
      if (error instanceof JobWorkspaceError)
        return failed(
          `WORKSPACE_${error.code}`,
          "The original validation workspace could not be prepared.",
          !permanentWorkspaceErrors.has(error.code),
        );
      return failed(
        "PROFILE_EXECUTION_FAILED",
        "The profile executor could not produce a complete typed result.",
        true,
      );
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", abort);
      // Workspace cleanup is retained by WorkerService until terminal reporting finishes.
    }
  }

  async #optionalSummary(
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
    validationWorkspace: PreparedJobWorkspace,
    report: ValidationReportV1,
    execution: ValidationExecutionDetails,
    evidence: SummaryEvidence,
    observations: ValidationObservationResults,
    retainModelOutput: boolean,
  ): Promise<ModelReview> {
    context.signal.throwIfAborted();
    if (!evidence.complete)
      return {
        state: "failed",
        code: "SUMMARY_CONTEXT_UNAVAILABLE",
        message: "The complete finalized UI evidence context is unavailable for optional advice.",
      };
    let nodeFault: Error | undefined;
    const reportFault = (error: Error): void => {
      if (nodeFault === undefined) {
        nodeFault = error;
        context.reportNodeHealthFault(error);
      }
    };
    const summaryContext: JobExecutionContext = { ...context, reportNodeHealthFault: reportFault };
    // Only these immutable data snapshots enter the model context. The adapter receives the
    // workspace object solely to enforce separation; no arbitrary evidence paths are re-read.
    const input: ValidationSummaryInput = Object.freeze({
      envelope: freezeData(structuredClone(envelope)),
      validationWorkspace,
      runnerReport: freezeData(structuredClone(report)),
      runnerExecution: freezeData(structuredClone(execution)),
      evidenceContext: freezeData(structuredClone(evidence.context)),
      ...(Object.keys(observations).length === 0
        ? {}
        : { observationResults: freezeData(structuredClone(observations)) }),
    });
    let attempt: ValidationSummaryAttempt;
    try {
      const executor = this.options.createSummaryExecutor?.(input.envelope, summaryContext);
      if (executor === undefined) return { state: "not_requested" };
      // ValidationSummaryExecutor owns the sole optional timeout, no-progress limit, teardown
      // budget, and terminal-report reserve. Parent lease cancellation is always propagated.
      attempt = await executor.execute(input, summaryContext);
      context.signal.throwIfAborted();
      if (attempt.state === "failed" && (attempt.nodeFault || attempt.cleanupUnconfirmed)) {
        reportFault(
          new ProfileExecutionError(
            attempt.cleanupUnconfirmed ? "SUMMARY_CLEANUP_UNCONFIRMED" : "SUMMARY_NODE_FAULT",
            "The optional model execution could not confirm a safe lifecycle.",
          ),
        );
      }
      if (nodeFault !== undefined) {
        if (!retainModelOutput || execution.blockers.length < 160)
          execution.blockers.push({
            phase: "model_review",
            stepId: null,
            code: "SUMMARY_LIFECYCLE_UNCONFIRMED",
            message:
              "The optional model execution reported an unconfirmed cleanup or Worker health fault.",
          });
        return {
          state: "failed",
          code: "SUMMARY_LIFECYCLE_UNCONFIRMED",
          message: "The optional model execution could not confirm safe completion.",
        };
      }
      if (attempt.state === "failed") {
        const fallback =
          "The optional validation summary could not complete; deterministic runner results are retained.";
        const message = redactExecutionText(
          typeof attempt.message === "string" && attempt.message.trim().length > 0
            ? attempt.message
            : fallback,
          [envelope.lease.leaseToken],
        ).toWellFormed();
        return {
          state: "failed",
          code: safeCode(attempt.code, "SUMMARY_EXECUTION_FAILED", [envelope.lease.leaseToken]),
          message: message.trim().length > 0 ? message : fallback,
        };
      }
      const expectedContext = createValidationSummaryContext(input);
      if (
        attempt.contextSha256 !== expectedContext.sha256 ||
        attempt.promptSha256 !== envelope.prompt.promptSha256 ||
        !validSummary(attempt.summary, report.workItemKind)
      ) {
        return {
          state: "failed",
          code: "SUMMARY_RESULT_INVALID",
          message:
            "The optional summary did not match its frozen prompt, evidence context, or result schema.",
        };
      }
      if (!retainModelOutput && attempt.modelOutputArtifact !== undefined)
        return {
          state: "failed",
          code: "SUMMARY_RESULT_INVALID",
          message: "An ordinary summary returned an unexpected evaluation output artifact.",
        };
      if (retainModelOutput) {
        const actualPromptSha256 = createHash("sha256")
          .update(
            composeSummaryPrompt(envelope.prompt.renderedPrompt, expectedContext.json),
            "utf8",
          )
          .digest("hex");
        if (
          attempt.modelOutputArtifact === undefined ||
          attempt.actualPromptSha256 !== actualPromptSha256
        )
          return {
            state: "failed",
            code: "SUMMARY_EXECUTION_MISSING",
            message: "The summary did not retain its original output and CLI execution details.",
          };
        const artifact = assertModelOutputArtifact(
          attempt.modelOutputArtifact,
          envelope,
          actualPromptSha256,
          expectedContext.sha256,
        );
        if (createCanonicalResult(attempt.summary).json !== artifact.canonicalResultJson)
          return {
            state: "failed",
            code: "SUMMARY_RESULT_INVALID",
            message: "The retained raw summary differs from its CLI output.",
          };
        return modelOutputReview(artifact);
      }
      const candidate = createCanonicalResult({
        schemaVersion: "ValidationJobResultV1",
        report: { ...report, modelSummary: attempt.summary },
        execution,
        modelReview: { state: "not_requested" },
        ...observations,
      });
      if (Buffer.byteLength(candidate.json, "utf8") > maximumRunCompletionResultUtf8Bytes)
        return {
          state: "failed",
          code: "SUMMARY_RESULT_TOO_LARGE",
          message:
            "The optional summary exceeds the remaining terminal report capacity; runner facts are retained.",
        };
      if (report.workItemKind === "pull_request" && attempt.summary.workItemKind === "pull_request")
        report.modelSummary = structuredClone(attempt.summary);
      else if (report.workItemKind === "issue" && attempt.summary.workItemKind === "issue")
        report.modelSummary = structuredClone(attempt.summary);
      else
        return {
          state: "failed",
          code: "SUMMARY_RESULT_INVALID",
          message: "The optional summary belongs to another work item kind.",
        };
      return { state: "not_requested" };
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof LeaseLostError) throw error;
      if (error instanceof ProfileExecutionError && error.code === "VALIDATION_RESULT_TOO_LARGE")
        throw error;
      if (nodeFault !== undefined) {
        if (!retainModelOutput || execution.blockers.length < 160)
          execution.blockers.push({
            phase: "model_review",
            stepId: null,
            code: "SUMMARY_LIFECYCLE_UNCONFIRMED",
            message: "The optional model execution reported an unconfirmed Worker lifecycle.",
          });
      }
      return {
        state: "failed",
        code:
          nodeFault === undefined ? "SUMMARY_EXECUTION_FAILED" : "SUMMARY_LIFECYCLE_UNCONFIRMED",
        message:
          "The optional validation summary could not complete safely; runner facts are retained.",
      };
    }
  }

  async #reviewModel(
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
    validationWorkspace: PreparedJobWorkspace,
    retainModelOutput: boolean,
  ): Promise<ModelReview> {
    if (this.options.createModelExecutor === undefined)
      return {
        state: "failed",
        code: "MODEL_EXECUTOR_UNAVAILABLE",
        message: "The required model executor is not configured.",
      };
    let modelWorkspace: PreparedJobWorkspace | undefined;
    let prepared = false;
    const cleanupModel = cleanupOnce(async () => {
      try {
        await modelWorkspace?.cleanup();
      } catch (error) {
        context.reportNodeHealthFault(asError(error, "Model workspace cleanup failed."));
        throw error;
      }
    });
    context.deferCleanup?.(cleanupModel);
    const provider: JobWorkspaceProvider = {
      prepare: async (requestedEnvelope, preparation) => {
        if (
          prepared ||
          createCanonicalResult(requestedEnvelope).sha256 !==
            createCanonicalResult(envelope).sha256 ||
          preparation.processHost !== context.processHost ||
          preparation.signal !== context.signal
        )
          throw new ProfileExecutionError(
            "MODEL_WORKSPACE_SCOPE_INVALID",
            "The model requested an invalid workspace scope.",
          );
        prepared = true;
        const result = await this.options.workspaceProvider.prepare(envelope, preparation, "model");
        if (
          !separateDirectories(validationWorkspace.attemptDirectory, result.attemptDirectory) ||
          !separateDirectories(validationWorkspace.checkoutDirectory, result.checkoutDirectory)
        ) {
          context.reportNodeHealthFault(
            new ProfileExecutionError(
              "MODEL_WORKSPACE_NOT_ISOLATED",
              "The model workspace aliases the validation workspace.",
            ),
          );
          throw new ProfileExecutionError(
            "MODEL_WORKSPACE_NOT_ISOLATED",
            "The model workspace must be isolated from runner validation.",
          );
        }
        modelWorkspace = result;
        const capture = result.captureWorktreeState;
        const validateLocations = result.validatePrFindingLocations;
        return {
          attemptDirectory: result.attemptDirectory,
          checkoutDirectory: result.checkoutDirectory,
          controlDirectory: result.controlDirectory,
          tempDirectory: result.tempDirectory,
          userProfileDirectory: result.userProfileDirectory,
          startDiskMonitoring: (signal) => result.startDiskMonitoring(signal),
          ...(capture === undefined
            ? {}
            : { captureWorktreeState: (signal: AbortSignal) => capture.call(result, signal) }),
          ...(validateLocations === undefined
            ? {}
            : {
                validatePrFindingLocations: (
                  ...args: Parameters<
                    NonNullable<PreparedJobWorkspace["validatePrFindingLocations"]>
                  >
                ) => validateLocations.call(result, ...args),
              }),
          cleanup: cleanupModel,
        };
      },
    };
    try {
      context.signal.throwIfAborted();
      const executor = this.options.createModelExecutor(provider, envelope, context);
      const result = await executor.executeProfileModel(structuredClone(envelope), context);
      context.signal.throwIfAborted();
      if (result.outcome === "failed")
        return {
          state: "failed",
          code: safeCode(result.code, "MODEL_REVIEW_FAILED"),
          message: "The required model review could not complete; inspect its Worker diagnostics.",
        };
      if (!retainModelOutput && result.modelOutputArtifact !== undefined)
        return {
          state: "failed",
          code: "MODEL_RESULT_INVALID",
          message: "An ordinary review returned an unexpected evaluation output artifact.",
        };
      if (retainModelOutput) {
        if (!prepared || modelWorkspace === undefined || result.modelOutputArtifact === undefined)
          return {
            state: "failed",
            code: "MODEL_EXECUTION_MISSING",
            message:
              "The required review did not retain an original model output and CLI execution details.",
          };
        const artifact = assertModelOutputArtifact(result.modelOutputArtifact, envelope);
        if (
          createCanonicalResult(result.result).json !== artifact.canonicalResultJson ||
          result.resultDigest !== artifact.modelOutputSha256 ||
          !validModelResult(envelope, artifact.result, true)
        )
          return {
            state: "failed",
            code: "MODEL_RESULT_INVALID",
            message: "The original model output differs from its retained validation result.",
          };
        return modelOutputReview(artifact);
      }
      if (
        !prepared ||
        modelWorkspace === undefined ||
        createCanonicalResult(result.result).sha256 !== result.resultDigest ||
        !validModelResult(envelope, result.result)
      )
        return {
          state: "failed",
          code: "MODEL_RESULT_INVALID",
          message:
            "The model review did not produce valid V2 evidence from its isolated workspace.",
        };
      const nested = result.result;
      if (Value.Check(PrReviewPlanV2Schema, nested))
        return { state: "completed", result: structuredClone(nested) };
      if (Value.Check(IssueTriageV2Schema, nested))
        return { state: "completed", result: structuredClone(nested) };
      return {
        state: "failed",
        code: "MODEL_RESULT_INVALID",
        message: "The model review result is invalid.",
      };
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof LeaseLostError) throw error;
      if (error instanceof ProfileExecutionError && error.code === "VALIDATION_RESULT_TOO_LARGE")
        throw error;
      return {
        state: "failed",
        code: "MODEL_REVIEW_FAILED",
        message: "The required model review could not complete in its isolated workspace.",
      };
    }
  }

  async #uploadEvidence(
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
    observed: UiProfileResult,
    report: ValidationReportV1,
    details: ValidationExecutionDetails,
    now: () => Date,
  ): Promise<SummaryEvidence> {
    const expected = expectedChecks(envelope.validation.profileVersion);
    const seenScenarios = new Set<string>();
    const assets = new Map<string, EvidenceAssetManifest>();
    const summaryScenarios: { checkId: string; execution: UiScenarioExecutionEvidenceV1 }[] = [];
    let completeContext = true;
    for (const check of report.checks) if (check.kind === "ui") check.evidenceIds = [];
    for (const scenario of observed.scenarioEvidence) {
      context.signal.throwIfAborted();
      const check = report.checks.find((candidate) => candidate.id === scenario.scenarioCheckId);
      if (
        check?.kind !== "ui" ||
        expected.get(check.id)?.phase !== "ui" ||
        scenario.execution.scenarioId !==
          check.id.slice(envelope.validation.profileVersion.id.length + 1) ||
        seenScenarios.has(check.id)
      )
        throw new ProfileExecutionError(
          "UI_EVIDENCE_SCOPE_INVALID",
          "The UI evidence does not match its frozen scenario.",
        );
      const planned = envelope.validation.profileVersion.config.ui?.scenarios.find(
        (candidate) => candidate.id === scenario.execution.scenarioId,
      );
      if (
        !Value.Check(UiScenarioExecutionEvidenceV1Schema, scenario.execution) ||
        planned === undefined ||
        scenario.execution.target !== envelope.validation.target ||
        !matchesUiScenarioObservations(planned.steps, scenario.execution.steps, {
          requireCapture: envelope.validation.reproduction !== undefined,
          checkOutcome: check.outcome,
        })
      )
        throw new ProfileExecutionError(
          "UI_EVIDENCE_SCOPE_INVALID",
          "The UI step observations do not match the frozen assertions.",
        );
      seenScenarios.add(check.id);
      let complete = true;
      let uploaded: EvidenceUploadResult = { assetIds: {}, assets: [] };
      if (this.options.evidenceUploader === undefined) complete = false;
      else {
        const input: UiScenarioEvidenceUploadInput = {
          lease: envelope.lease,
          scope: {
            repositoryId: envelope.validation.repositoryId,
            runId: envelope.validation.runId,
            requestId: envelope.validation.requestId,
            profileVersionId: envelope.validation.profileVersion.id,
            revisionKey: envelope.validation.revisionKey,
            planDigest: envelope.validation.planDigest,
          },
          evidenceDirectory: scenario.evidenceDirectory,
          capturedAt: now().toISOString(),
          files: scenario.evidenceFiles,
          execution: scenario.execution,
          signal: context.signal,
          onChunkProgress: () => context.reportProgress({ phase: "uploading", processCount: 0 }),
        };
        try {
          uploaded = await this.options.evidenceUploader.uploadUiScenarioEvidence(input);
        } catch (error) {
          context.signal.throwIfAborted();
          if (error instanceof LeaseLostError) throw error;
          if (error instanceof EvidenceUploadError && error.isLeaseLost)
            throw new LeaseLostError("Evidence upload lost its lease authority.", error.code);
          if (error instanceof EvidenceUploadError) uploaded = error.partial;
          complete = false;
        }
      }
      context.signal.throwIfAborted();
      const valid = validateUploadedAssets(uploaded, envelope, check.id);
      for (const asset of valid) {
        const previous = assets.get(asset.id);
        if (
          previous !== undefined &&
          createCanonicalResult(previous).sha256 !== createCanonicalResult(asset).sha256
        )
          throw new ProfileExecutionError(
            "UI_EVIDENCE_SCOPE_INVALID",
            "An evidence asset identity changed across scenarios.",
          );
        assets.set(asset.id, asset);
      }
      const sorted = [...valid].sort(
        (left, right) =>
          Number(right.metadata.kind === "steps") - Number(left.metadata.kind === "steps"),
      );
      if (sorted.length > maximumValidationCheckEvidenceReferences) {
        complete = false;
        check.evidenceIds = [];
        details.blockers.push({
          phase: "evidence",
          stepId: null,
          code: "EVIDENCE_REFERENCE_LIMIT_EXCEEDED",
          message:
            "The finalized scenario asset set exceeds the supported per-check reference limit.",
        });
      } else check.evidenceIds = sorted.map((asset) => asset.id);
      const allLocalIds = scenario.evidenceFiles.map((file) => file.id);
      if (
        !allLocalIds.every(
          (id) =>
            uploaded.assetIds[id] !== undefined &&
            valid.some((asset) => asset.id === uploaded.assetIds[id]),
        ) ||
        !valid.some((asset) => asset.metadata.kind === "steps")
      )
        complete = false;
      if (!complete) {
        if (check.outcome === "passed") check.outcome = "blocked";
        check.summary =
          "UI execution evidence could not be completely finalized; retained asset references are partial.";
        details.blockers.push({
          phase: "evidence",
          stepId: envelope.validation.reproduction === undefined ? null : check.id,
          code:
            envelope.validation.reproduction === undefined
              ? "EVIDENCE_UPLOAD_INCOMPLETE"
              : "UI_EVIDENCE_INCOMPLETE",
          message: "A UI scenario did not finalize every required evidence asset under this lease.",
        });
      }
      const remapped = complete
        ? verifiedRemappedSteps(scenario, uploaded, valid, check.evidenceIds)
        : undefined;
      if (remapped === undefined) completeContext = false;
      else summaryScenarios.push({ checkId: check.id, execution: remapped });
    }
    for (const check of report.checks) {
      if (check.kind === "ui" && check.outcome !== "not_run" && !seenScenarios.has(check.id)) {
        completeContext = false;
        if (check.outcome === "passed") check.outcome = "blocked";
        details.blockers.push({
          phase: "evidence",
          stepId: envelope.validation.reproduction === undefined ? null : check.id,
          code:
            envelope.validation.reproduction === undefined
              ? "UI_EVIDENCE_MISSING"
              : "UI_EVIDENCE_INCOMPLETE",
          message: "An executed UI scenario did not return its typed local evidence bundle.",
        });
      }
    }
    synchronizeDiagnostics(report, details, expected);
    const referencedAssets = [...assets.values()].filter((asset) =>
      report.checks.some(
        (check) => check.id === asset.metadata.checkId && check.evidenceIds.includes(asset.id),
      ),
    );
    if (referencedAssets.length !== assets.size) completeContext = false;
    return {
      context: { assets: referencedAssets, scenarios: summaryScenarios },
      complete: completeContext,
    };
  }
}

function expectedChecks(profile: ValidationProfileVersion): Map<string, ExpectedCheck> {
  const expected = new Map<string, ExpectedCheck>();
  for (const phase of ["setup", "build", "test", "cleanup"] as const)
    for (const step of profile.config[phase])
      expected.set(`${profile.id}:${step.id}`, {
        phase,
        name: step.name,
        kind: phase === "build" || phase === "test" ? phase : "static",
        required: step.required,
      });
  for (const scenario of profile.config.ui?.scenarios ?? [])
    expected.set(`${profile.id}:${scenario.id}`, {
      phase: "ui",
      name: scenario.name,
      kind: "ui",
      required: scenario.required,
    });
  return expected;
}
function normalizeRunnerResult(
  observed: HeadlessValidationCheckResult,
  profile: ValidationProfileVersion,
  kind: "issue" | "pull_request",
): { report: ValidationReportV1; execution: ValidationExecutionDetails } {
  const report = structuredClone(observed.report);
  const details: ValidationExecutionDetails = structuredClone({
    blockers: observed.blockers,
    diagnostics: observed.diagnostics,
    cleanupState: observed.cleanupState,
  });
  if (
    !Value.Check(ValidationReportV1Schema, report) ||
    !Value.Check(ValidationExecutionDetailsSchema, details) ||
    report.modelSummary !== undefined ||
    report.workItemKind !== kind
  )
    throw new ProfileExecutionError(
      "VALIDATION_RESULT_INVALID",
      "The runner returned an invalid validation report.",
    );
  const expected = expectedChecks(profile);
  const seen = new Set<string>();
  for (const check of report.checks) {
    const planned = expected.get(check.id);
    if (
      seen.has(check.id) ||
      planned === undefined ||
      planned.kind !== check.kind ||
      planned.required !== check.required ||
      check.source !== "runner"
    )
      throw new ProfileExecutionError(
        "VALIDATION_RESULT_INVALID",
        "The runner changed a frozen validation check.",
      );
    seen.add(check.id);
    if (check.kind !== "ui" && check.evidenceIds.length > 0)
      throw new ProfileExecutionError(
        "VALIDATION_RESULT_INVALID",
        "A headless runner cannot invent server evidence references.",
      );
  }
  for (const [id, check] of expected)
    if (!seen.has(id))
      report.checks.push({
        id,
        name: check.name,
        kind: check.kind,
        required: check.required,
        source: "runner",
        outcome: "not_run",
        summary: "The runner did not reach this frozen check.",
        expected: null,
        actual: null,
        evidenceIds: [],
      });
  const phases = new Map([...expected].map(([id, check]) => [id, check.phase]));
  for (const step of profile.config.launch) phases.set(`${profile.id}:${step.id}`, "launch");
  details.blockers = details.blockers.map((blocker) => {
    if (blocker.stepId === null || phases.get(blocker.stepId) === blocker.phase) return blocker;
    if (["evidence", "model_review", "profile", "source"].includes(blocker.phase))
      return { ...blocker, stepId: null };
    throw new ProfileExecutionError(
      "VALIDATION_RESULT_INVALID",
      "A runner blocker does not match its frozen lifecycle step.",
    );
  });
  if (profile.config.cleanup.length === 0 && details.cleanupState === "completed")
    details.cleanupState = "not_needed";
  synchronizeDiagnostics(report, details, expected, phases);
  return { report, execution: details };
}
function synchronizeDiagnostics(
  report: ValidationReportV1,
  details: ValidationExecutionDetails,
  expected: ReadonlyMap<string, ExpectedCheck>,
  phases?: ReadonlyMap<string, ValidationLifecyclePhase>,
): void {
  const diagnostics = new Map<string, ValidationStepDiagnostic>();
  for (const diagnostic of details.diagnostics) {
    if (
      diagnostics.has(diagnostic.stepId) ||
      (phases !== undefined && phases.get(diagnostic.stepId) !== diagnostic.phase)
    )
      throw new ProfileExecutionError(
        "VALIDATION_RESULT_INVALID",
        "The runner repeated or changed a frozen diagnostic.",
      );
    const check = report.checks.find((candidate) => candidate.id === diagnostic.stepId);
    const outcome = check?.outcome ?? diagnostic.outcome;
    if (
      outcome === "passed" &&
      diagnostic.phase !== "ui" &&
      diagnostic.phase !== "launch" &&
      diagnostic.exitCode !== 0
    )
      throw new ProfileExecutionError(
        "VALIDATION_RESULT_INVALID",
        "A passing command diagnostic has no successful exit status.",
      );
    diagnostics.set(diagnostic.stepId, {
      ...diagnostic,
      outcome,
      exitCode: outcome === "not_run" || outcome === "skipped" ? null : diagnostic.exitCode,
    });
  }
  for (const check of report.checks) {
    const planned = expected.get(check.id);
    if (planned !== undefined && !diagnostics.has(check.id)) {
      if (check.outcome !== "not_run" && check.outcome !== "skipped")
        throw new ProfileExecutionError(
          "VALIDATION_RESULT_INVALID",
          "An executed check has no runner diagnostic.",
        );
      diagnostics.set(check.id, {
        stepId: check.id,
        phase: planned.phase,
        outcome: check.outcome,
        exitCode: null,
        summary: check.summary,
      });
    }
  }
  details.diagnostics = [...diagnostics.values()];
}
function validateUploadedAssets(
  uploaded: EvidenceUploadResult,
  envelope: JobExecutionEnvelopeV2,
  checkId: string,
): EvidenceAssetManifest[] {
  const seen = new Set<string>();
  for (const asset of uploaded.assets) {
    const scope = envelope.validation;
    if (
      !Value.Check(EvidenceAssetManifestSchema, asset) ||
      seen.has(asset.id) ||
      asset.state !== "finalized" ||
      asset.retiredAt !== null ||
      asset.repositoryId !== scope.repositoryId ||
      asset.runId !== scope.runId ||
      asset.requestId !== scope.requestId ||
      asset.profileVersionId !== scope.profileVersion.id ||
      asset.jobId !== envelope.job.jobId ||
      asset.runAttemptId !== envelope.lease.runAttemptId ||
      asset.revisionKey !== scope.revisionKey ||
      asset.planDigest !== scope.planDigest ||
      asset.metadata.checkId !== checkId
    )
      throw new ProfileExecutionError(
        "UI_EVIDENCE_SCOPE_INVALID",
        "An uploaded asset does not belong to this frozen check and attempt.",
      );
    seen.add(asset.id);
  }
  if (Object.values(uploaded.assetIds).some((id) => !seen.has(id)))
    throw new ProfileExecutionError(
      "UI_EVIDENCE_SCOPE_INVALID",
      "An evidence mapping has no finalized manifest.",
    );
  return structuredClone([...uploaded.assets]);
}
function validModelResult(envelope: JobExecutionEnvelopeV2, value: unknown, raw = false): boolean {
  if (envelope.resource.kind === "issue")
    return (
      Value.Check(raw ? IssueTriageV2ModelResultSchema : IssueTriageV2Schema, value) &&
      value.requestedRecipeIds.every((id) => envelope.executionPolicy.allowedRecipeIds.includes(id))
    );
  if (
    !Value.Check(raw ? PrReviewPlanV2ModelResultSchema : PrReviewPlanV2Schema, value) ||
    !value.requestedRecipeIds.every((id) => envelope.executionPolicy.allowedRecipeIds.includes(id))
  )
    return false;
  const ids = new Set<string>();
  return value.findings.every((finding) => {
    if (
      ids.has(finding.findingId) ||
      (finding.endLine !== null && finding.endLine < finding.line) ||
      finding.path.includes(":") ||
      finding.path.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      return false;
    ids.add(finding.findingId);
    return true;
  });
}
function verifiedRemappedSteps(
  scenario: UiProfileResult["scenarioEvidence"][number],
  uploaded: EvidenceUploadResult,
  assets: readonly EvidenceAssetManifest[],
  checkEvidenceIds: readonly string[],
): UiScenarioExecutionEvidenceV1 | undefined {
  const files = new Map(scenario.evidenceFiles.map((file) => [file.id, file]));
  const manifests = new Map(assets.map((asset) => [asset.id, asset]));
  const mappings = Object.entries(uploaded.assetIds);
  const steps = scenario.evidenceFiles.filter((file) => file.kind === "ui_steps");
  if (
    files.size !== scenario.evidenceFiles.length ||
    mappings.length !== files.size ||
    manifests.size !== files.size ||
    steps.length !== 1 ||
    new Set(mappings.map(([, id]) => id)).size !== mappings.length ||
    mappings.some(
      ([localId, serverId]) =>
        !files.has(localId) || !manifests.has(serverId) || !checkEvidenceIds.includes(serverId),
    )
  )
    return undefined;
  for (const file of files.values()) {
    const manifest = manifests.get(uploaded.assetIds[file.id] ?? "");
    if (
      manifest === undefined ||
      manifest.metadata.mediaType !== file.mediaType ||
      manifest.metadata.kind !== (file.kind === "ui_steps" ? "steps" : file.kind)
    )
      return undefined;
    // The steps document is rewritten by the uploader after screenshot IDs are finalized.
    // Every other file must retain the exact driver-observed content identity.
    if (
      file.kind !== "ui_steps" &&
      (manifest.metadata.sizeBytes !== file.sizeBytes || manifest.metadata.sha256 !== file.sha256)
    )
      return undefined;
  }
  const remapped = structuredClone(scenario.execution);
  for (const step of remapped.steps) {
    const ids: string[] = [];
    for (const localId of step.evidenceIds) {
      const serverId = uploaded.assetIds[localId];
      if (
        serverId === undefined ||
        files.get(localId)?.kind !== "screenshot" ||
        manifests.get(serverId)?.metadata.kind !== "screenshot"
      )
        return undefined;
      ids.push(serverId);
    }
    if (new Set(ids).size !== ids.length) return undefined;
    step.evidenceIds = ids;
  }
  const stepsFile = steps[0];
  if (stepsFile === undefined) return undefined;
  const manifest = manifests.get(uploaded.assetIds[stepsFile.id] ?? "");
  const serialized = JSON.stringify(remapped);
  if (
    manifest?.metadata.sizeBytes !== Buffer.byteLength(serialized, "utf8") ||
    manifest.metadata.sha256 !== hash(serialized)
  )
    return undefined;
  return remapped;
}
function validSummary(
  value: unknown,
  kind: "pull_request" | "issue",
): value is ValidationSummaryV1 {
  if (
    kind === "pull_request"
      ? !Value.Check(PullRequestValidationSummaryV1Schema, value)
      : !Value.Check(IssueValidationSummaryV1Schema, value)
  )
    return false;
  const summary = value as ValidationSummaryV1;
  const ids = new Set<string>();
  return summary.observations.every((observation) => {
    const path = observation.path;
    if (
      ids.has(observation.id) ||
      (observation.line !== null && path === null) ||
      (path !== null &&
        (!path.isWellFormed() ||
          /^[\\/]/u.test(path) ||
          path.includes("\\") ||
          path.includes(":") ||
          [...path].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          path.split("/").some((part) => part === "" || part === "." || part === "..")))
    )
      return false;
    ids.add(observation.id);
    return true;
  });
}
function freezeData<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
function separateDirectories(first: string, second: string): boolean {
  const left = win32.normalize(first).toLowerCase();
  const right = win32.normalize(second).toLowerCase();
  return left !== right && !left.startsWith(`${right}\\`) && !right.startsWith(`${left}\\`);
}
function preparationContext(context: JobExecutionContext) {
  return {
    signal: context.signal,
    processHost: context.processHost,
    reportProcessCount: (processCount: number) =>
      context.reportProgress({ phase: "preparing", processCount }),
    reportNodeHealthFault: context.reportNodeHealthFault,
  };
}
const permanentWorkspaceErrors = new Set<JobWorkspaceError["code"]>([
  "INVALID_CONFIGURATION",
  "INVALID_ENVELOPE",
  "WORKSPACE_ROOT_UNSAFE",
  "WORKSPACE_PATH_UNSAFE",
  "ATTEMPT_ALREADY_EXISTS",
  "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED",
  "GIT_LOCAL_OR_REVISION_FAILED",
  "GIT_REVISION_MISMATCH",
  "GIT_POLICY_LIMIT_EXCEEDED",
]);
function cleanupOnce(cleanup: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= cleanup();
    return pending;
  };
}
function failed(code: string, message: string, retryable = false): JobExecutionResult {
  return { outcome: "failed", code, message, retryable };
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function safeCode(
  value: unknown,
  fallback: string,
  sensitiveValues: readonly string[] = [],
): string {
  return typeof value === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) &&
    redactExecutionText(value, sensitiveValues) === value
    ? value
    : fallback;
}
function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
