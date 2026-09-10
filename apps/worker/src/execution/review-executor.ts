import { createHash } from "node:crypto";
import { win32 } from "node:path";
import {
  createCanonicalResult,
  IssueTriageV1ModelOutputSchema,
  IssueTriageV1Schema,
  IssueTriageV2ModelOutputSchema,
  IssueTriageV2ModelResultSchema,
  type PrReviewPlanV1,
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV1Schema,
  PrReviewPlanV2ModelOutputSchema,
  PrReviewPlanV2ModelResultSchema,
  type ReviewModelResult,
  redactExecutionText,
} from "@agentic-review/codex";
import {
  type JobExecutionEnvelope,
  type JobExecutionEnvelopeV2,
  maximumRunCompletionResultUtf8Bytes,
} from "@agentic-review/contracts";
import type { Logger } from "../logging/logger.js";
import type { JobExecutionContext, JobExecutionResult, JobExecutor } from "./job-executor.js";
import {
  JobWorkspaceError,
  type JobWorkspaceProvider,
  type PreparedJobWorkspace,
} from "./job-workspace.js";
import {
  assertModelOutputArtifact,
  createModelOutputArtifact,
  ModelOutputArtifactError,
} from "./model-output-artifact.js";
import {
  errorSummary,
  extractExitCode,
  failureCategory,
  PreparedCliOutputRunner,
  type PreparedCliOutputRunnerOptions,
  ReviewExecutionError,
} from "./prepared-cli-output-runner.js";
import { validateProfileEnvelope } from "./profile-envelope.js";

export type {
  ReviewFileHandle,
  ReviewFileIO,
  ReviewFileStat,
} from "./prepared-cli-output-runner.js";
export interface ReviewJobExecutorOptions extends PreparedCliOutputRunnerOptions {
  readonly workspaceProvider: JobWorkspaceProvider;
}

interface AuthoritativeReviewSchema {
  readonly resultSchema:
    | typeof PrReviewPlanV1Schema
    | typeof IssueTriageV1Schema
    | typeof PrReviewPlanV2ModelResultSchema
    | typeof IssueTriageV2ModelResultSchema;
  readonly json: string;
  readonly digest: string;
}

type FailedJobExecution = Extract<JobExecutionResult, { readonly outcome: "failed" }>;

const noOpLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const authoritativePrSchema = createAuthoritativeSchema(
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV1Schema,
);
const authoritativeIssueSchema = createAuthoritativeSchema(
  IssueTriageV1ModelOutputSchema,
  IssueTriageV1Schema,
);
const authoritativePrV2Schema = createAuthoritativeSchema(
  PrReviewPlanV2ModelOutputSchema,
  PrReviewPlanV2ModelResultSchema,
);
const authoritativeIssueV2Schema = createAuthoritativeSchema(
  IssueTriageV2ModelOutputSchema,
  IssueTriageV2ModelResultSchema,
);

export class ReviewJobExecutor implements JobExecutor {
  readonly #prepared: PreparedCliOutputRunner;
  readonly #logger: Logger;

  public constructor(private readonly options: ReviewJobExecutorOptions) {
    this.#prepared = new PreparedCliOutputRunner(options);
    this.#logger = options.logger ?? noOpLogger;
  }

  public async execute(
    envelope: JobExecutionEnvelope,
    context: JobExecutionContext,
  ): Promise<JobExecutionResult> {
    return this.#execute(envelope, context, false);
  }

  public async executeProfileModel(
    envelope: JobExecutionEnvelopeV2,
    context: JobExecutionContext,
  ): Promise<JobExecutionResult> {
    return this.#execute(envelope, context, true);
  }

  async #execute(
    suppliedEnvelope: JobExecutionEnvelope,
    context: JobExecutionContext,
    profileModel: boolean,
  ): Promise<JobExecutionResult> {
    const envelope = structuredClone(suppliedEnvelope);
    context.reportProgress({ phase: "preparing", processCount: 0 });
    let nodeHealthFaultReported = false;
    const reportNodeHealthFaultOnce = (error: Error): void => {
      if (nodeHealthFaultReported) return;
      nodeHealthFaultReported = true;
      context.reportNodeHealthFault(error);
    };
    try {
      context.signal.throwIfAborted();
      const authority = validateEnvelope(envelope, profileModel);
      if (context.deferCleanup === undefined) {
        return failure(
          "CLEANUP_REGISTRATION_UNAVAILABLE",
          "The Worker cannot retain deferred workspace cleanup for this review.",
          false,
        );
      }

      let workspace: PreparedJobWorkspace | undefined;
      let workspaceReady = false;
      context.deferCleanup(
        createIdempotentCleanup(async () => {
          await workspace?.cleanup();
        }),
      );
      try {
        workspace = await this.options.workspaceProvider.prepare(envelope, {
          signal: context.signal,
          processHost: context.processHost,
          reportProcessCount: (processCount) => {
            context.reportProgress({
              phase: workspaceReady ? "validation" : "preparing",
              processCount,
            });
          },
          reportNodeHealthFault: reportNodeHealthFaultOnce,
        });
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof JobWorkspaceError) {
          throw workspacePreparationError(error);
        }
        throw new ReviewExecutionError(
          "WORKSPACE_PREPARATION_FAILED",
          "The isolated review workspace could not be prepared.",
          true,
          { cause: error },
        );
      }
      workspaceReady = true;
      context.signal.throwIfAborted();
      const result = await this.#executePrepared(
        envelope,
        authority,
        workspace,
        context,
        reportNodeHealthFaultOnce,
      );
      return this.#withDiagnostics(result, envelope);
    } catch (error) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? error;
      }
      return this.#withDiagnostics(this.#toFailure(error, envelope), envelope);
    }
  }

  async #executePrepared(
    envelope: JobExecutionEnvelope,
    authority: AuthoritativeReviewSchema,
    workspace: PreparedJobWorkspace,
    context: JobExecutionContext,
    reportNodeHealthFault: (error: Error) => void,
  ): Promise<JobExecutionResult> {
    const prepared = await this.#prepared.run({
      workspace,
      context,
      authoritativeSchema: authority,
      prompt: envelope.prompt.renderedPrompt,
      hardTimeoutMs: envelope.executionPolicy.hardTimeoutMs,
      noProgressTimeoutMs: envelope.executionPolicy.noProgressTimeoutMs,
      correlationId: envelope.lease.runAttemptId,
      launchPolicy: "review",
      sensitiveValues: this.#secrets(envelope),
      reportNodeHealthFault,
    });
    if (prepared.outcome === "failed") return prepared;
    const execution = prepared;
    const original = {
      outcome: "succeeded" as const,
      result: structuredClone(prepared.result),
      canonicalResultJson: prepared.canonicalResultJson,
      resultDigest: prepared.resultDigest,
      cliExecution: structuredClone(prepared.cliExecution),
    };
    const businessError = validateBusinessResult(envelope, execution.result);
    if (businessError !== null) {
      return failure("RESULT_BUSINESS_VALIDATION_FAILED", businessError, false);
    }
    if (
      envelope.resource.kind === "pull_request" &&
      "findings" in execution.result &&
      execution.result.findings.length > 0
    ) {
      if (workspace.validatePrFindingLocations === undefined)
        return failure(
          "FINDING_LOCATION_UNVERIFIED",
          "The Worker cannot verify PR finding locations against the frozen source.",
          false,
        );
      try {
        const verified = await workspace.validatePrFindingLocations(
          {
            baseSha: envelope.resource.baseSha,
            headSha: envelope.resource.headSha,
            findings: execution.result.findings,
          },
          context.signal,
        );
        context.signal.throwIfAborted();
        if (verified.status !== "verified")
          return failure(
            verified.status === "invalid"
              ? "FINDING_LOCATION_INVALID"
              : "FINDING_LOCATION_UNVERIFIED",
            `PR finding location verification failed: ${verified.reason}${verified.findingIndex === undefined ? "" : ` (finding ${verified.findingIndex + 1})`}.`,
            false,
          );
      } catch {
        context.signal.throwIfAborted();
        return failure(
          "FINDING_LOCATION_UNVERIFIED",
          "PR finding location verification did not complete against the frozen source.",
          false,
        );
      }
    }
    if (
      execution.result.schemaVersion === "PrReviewPlanV1" ||
      execution.result.schemaVersion === "IssueTriageV1"
    ) {
      return {
        outcome: "succeeded",
        resultDigest: execution.resultDigest,
        result: execution.result,
      };
    }
    const redact = (text: string) => redactExecutionText(text, this.#secrets(envelope));
    let worktreeStatus: "clean" | "modified" | "unknown" = "unknown";
    try {
      worktreeStatus = (await workspace.captureWorktreeState?.(context.signal)) ?? "unknown";
    } catch {
      context.signal.throwIfAborted();
    }
    const executionEvidence = {
      schemaVersion: "ReviewExecutionEvidenceV1" as const,
      source: "worker" as const,
      ...prepared.commandEvidence,
      worktree: {
        status: worktreeStatus,
        source: worktreeStatus === "unknown" ? ("not_observed" as const) : ("git_status" as const),
      },
    };
    if (
      envelope.envelopeVersion === 2 &&
      envelope.validation.schemaVersion === "ValidationJobContextV2"
    ) {
      if (envelope.envelopeVersion !== 2) throw new ModelOutputArtifactError();
      const artifact = assertModelOutputArtifact(
        createModelOutputArtifact({
          output: original,
          executionEvidence,
          envelope,
          sensitiveValues: this.#secrets(envelope),
        }),
        envelope,
      );
      return {
        outcome: "succeeded",
        result: artifact.result,
        resultDigest: artifact.modelOutputSha256,
        modelOutputArtifact: artifact,
      };
    }
    const result = {
      ...execution.result,
      verification: {
        ...execution.result.verification,
        summary: redact(execution.result.verification.summary),
        commands: execution.result.verification.commands.map((command) => ({
          ...command,
          command: redact(command.command),
        })),
      },
      executionEvidence,
    };
    const canonical = createCanonicalResult(result);
    if (Buffer.byteLength(canonical.json, "utf8") > maximumRunCompletionResultUtf8Bytes) {
      return failure(
        "RESULT_WITH_EVIDENCE_TOO_LARGE",
        "The review result and execution evidence exceed the inline result limit.",
        false,
      );
    }
    return {
      outcome: "succeeded",
      resultDigest: canonical.sha256,
      result,
    };
  }

  #secrets(envelope: JobExecutionEnvelope): readonly string[] {
    return [envelope.lease.leaseToken];
  }

  #withDiagnostics(result: JobExecutionResult, envelope: JobExecutionEnvelope): JobExecutionResult {
    if (result.outcome === "succeeded") return result;
    const redact = (text: string) => redactExecutionText(text, this.#secrets(envelope));
    return {
      ...result,
      message: redact(result.message),
      diagnostics: {
        category: result.diagnostics?.category ?? failureCategory(result.code),
        exitCode: result.diagnostics?.exitCode ?? null,
        summary: redact(result.diagnostics?.summary ?? result.message),
        correlationId: envelope.lease.runAttemptId,
      },
    };
  }

  #toFailure(error: unknown, envelope: JobExecutionEnvelope): FailedJobExecution {
    if (error instanceof ModelOutputArtifactError) return failure(error.code, error.message, false);
    if (error instanceof ReviewExecutionError) {
      return {
        ...failure(error.code, error.message, error.retryable),
        diagnostics: {
          category: failureCategory(error.code),
          exitCode: extractExitCode(error),
          summary: errorSummary(error),
          correlationId: envelope.lease.runAttemptId,
        },
      };
    }
    this.#logger.error("Review job failed unexpectedly.", {
      jobId: envelope.job.jobId,
      runAttemptId: envelope.lease.runAttemptId,
      errorName: errorName(error),
    });
    return {
      ...failure(
        "REVIEW_EXECUTION_FAILED",
        "The review job failed because of an unexpected Worker error.",
        true,
      ),
      diagnostics: {
        category: "internal",
        exitCode: error instanceof Error ? extractExitCode(error) : null,
        summary:
          error instanceof Error ? errorSummary(error) : "A non-error value interrupted execution.",
        correlationId: envelope.lease.runAttemptId,
      },
    };
  }
}

function createAuthoritativeSchema(
  modelOutputSchema:
    | typeof PrReviewPlanV1ModelOutputSchema
    | typeof IssueTriageV1ModelOutputSchema
    | typeof PrReviewPlanV2ModelOutputSchema
    | typeof IssueTriageV2ModelOutputSchema,
  resultSchema: AuthoritativeReviewSchema["resultSchema"],
): AuthoritativeReviewSchema {
  const serialized = JSON.stringify(modelOutputSchema);
  if (serialized === undefined) {
    throw new Error("The authoritative review schema could not be serialized.");
  }
  const snapshot = JSON.parse(serialized) as unknown;
  const canonical = createCanonicalResult(snapshot);
  return Object.freeze({ resultSchema, json: canonical.json, digest: canonical.sha256 });
}

function validateEnvelope(
  envelope: JobExecutionEnvelope,
  profileModel: boolean,
): AuthoritativeReviewSchema {
  if (profileModel) {
    if (envelope.envelopeVersion !== 2) {
      throw contractError("Profile model execution requires the complete V2 envelope.");
    }
    try {
      validateProfileEnvelope(envelope);
    } catch {
      throw contractError("The frozen profile model envelope is invalid.");
    }
    if (!["pr_static_build", "issue_triage"].includes(envelope.validation.workflowKind)) {
      throw contractError("This workflow requires the validation summary executor.");
    }
  } else if (envelope.envelopeVersion !== 1 || "validation" in envelope) {
    throw contractError("Validation profiles require the profile executor.");
  }
  let authority: AuthoritativeReviewSchema;
  if (envelope.job.kind === "pull_request_review") {
    if (envelope.resource.kind !== "pull_request") {
      throw contractError("The PR review job does not target a pull request.");
    }
    authority =
      envelope.prompt.outputSchemaSha256 === authoritativePrV2Schema.digest
        ? authoritativePrV2Schema
        : authoritativePrSchema;
  } else if (envelope.job.kind === "issue_triage") {
    if (envelope.resource.kind !== "issue") {
      throw contractError("The issue triage job does not target an issue.");
    }
    authority =
      envelope.prompt.outputSchemaSha256 === authoritativeIssueV2Schema.digest
        ? authoritativeIssueV2Schema
        : authoritativeIssueSchema;
  } else {
    throw contractError("The job kind is not supported by the review executor.");
  }

  const promptDigest = createHash("sha256")
    .update(envelope.prompt.renderedPrompt, "utf8")
    .digest("hex");
  if (promptDigest !== envelope.prompt.promptSha256) {
    throw contractError("The rendered prompt digest does not match the job envelope.");
  }

  let suppliedSchema: ReturnType<typeof createCanonicalResult>;
  try {
    suppliedSchema = createCanonicalResult(envelope.prompt.outputSchema);
  } catch (error) {
    throw new ReviewExecutionError(
      "JOB_CONTRACT_INVALID",
      "The job output schema is not valid canonical JSON.",
      false,
      { cause: error },
    );
  }
  if (
    suppliedSchema.sha256 !== envelope.prompt.outputSchemaSha256 ||
    suppliedSchema.sha256 !== authority.digest ||
    suppliedSchema.json !== authority.json
  ) {
    throw contractError("The job output schema is not the authoritative schema for its job kind.");
  }
  return authority;
}

function contractError(message: string): ReviewExecutionError {
  return new ReviewExecutionError("JOB_CONTRACT_INVALID", message, false);
}

function workspacePreparationError(error: JobWorkspaceError): ReviewExecutionError {
  const permanentCodes = new Set([
    "INVALID_ENVELOPE",
    "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED",
    "GIT_LOCAL_OR_REVISION_FAILED",
    "GIT_REVISION_MISMATCH",
    "GIT_POLICY_LIMIT_EXCEEDED",
  ]);
  return new ReviewExecutionError(
    `WORKSPACE_${error.code}`,
    "The isolated review workspace could not be prepared.",
    !permanentCodes.has(error.code),
    { cause: error },
  );
}

function validateBusinessResult(
  envelope: JobExecutionEnvelope,
  result: ReviewModelResult,
): string | null {
  const allowedRecipes = new Set(envelope.executionPolicy.allowedRecipeIds);
  if (result.requestedRecipeIds.some((recipeId) => !allowedRecipes.has(recipeId))) {
    return "The review requested a validation recipe outside the job allowlist.";
  }

  if (envelope.job.kind !== "pull_request_review") {
    return null;
  }
  const review = result as PrReviewPlanV1;
  const findingIds = new Set<string>();
  for (const finding of review.findings) {
    if (findingIds.has(finding.findingId)) {
      return "The PR review contains duplicate finding identifiers.";
    }
    findingIds.add(finding.findingId);
    if (finding.endLine !== null && finding.endLine < finding.line) {
      return "The PR review contains a finding whose end line precedes its start line.";
    }
    if (!isNormalizedRepositoryRelativePath(finding.path)) {
      return "The PR review contains a finding path that is not a normalized repository-relative path.";
    }
  }
  return null;
}

function isNormalizedRepositoryRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes(":") ||
    path.startsWith("/") ||
    win32.isAbsolute(path)
  ) {
    return false;
  }
  const normalized = win32.normalize(path).replaceAll("\\", "/");
  return (
    normalized === path &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function createIdempotentCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined;
  return () => {
    cleanupPromise ??= Promise.resolve().then(cleanup);
    return cleanupPromise;
  };
}

function failure(code: string, message: string, retryable: boolean): FailedJobExecution {
  return {
    outcome: "failed",
    code: code.slice(0, 128),
    message: message.slice(0, 2_048),
    retryable,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
