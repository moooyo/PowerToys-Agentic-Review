import { randomUUID } from "node:crypto";
import {
  type InvestigationCheckpointRequest,
  type InvestigationDiagnostic,
  type InvestigationLoopCheckpointV1,
  type InvestigationOutcome,
  type InvestigationRuntimeState,
  isCorrectableInvestigationModelOutputIssue,
  validateInvestigationAnalysisForTask,
  validateInvestigationSourceProvenance,
} from "@agentic-review/contracts";
import {
  applyInvestigationLoopRound,
  evaluateInvestigationCompletion,
  investigationContentDigest,
  investigationTaskBindingDigest,
} from "@agentic-review/domain";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import type { Logger } from "../logging/logger.js";
import { delay } from "../util/async.js";
import {
  InvestigationAttemptHeartbeat,
  InvestigationLeaseLost,
  InvestigationTaskCancelled,
} from "./attempt-heartbeat.js";
import type { E2eAgentRunner } from "./e2e-agent-runner.js";
import type { InvestigationWorkerClient } from "./http-client.js";
import { findModelBudgetExceeded } from "./model-budget.js";
import { safeModelOutputValidationMessage } from "./model-output-diagnostics.js";
import {
  getModelOutputCorrection,
  type ModelTurnExecutionInput,
  type ModelTurnExecutionResult,
  type ModelTurnRunner,
} from "./model-turn-runner.js";
import { type InvestigationPlanExecutor, isInvestigationPlanTask } from "./plan-executor.js";
import { createInvestigationProgressReporter } from "./progress-reporter.js";
import { buildInvestigationReportSubmission } from "./report-builder.js";
import {
  type ClaimedInvestigationTask,
  type InvestigationClaimExecutor,
  InvestigationWorkerShutdown,
} from "./task-service.js";
import type {
  InvestigationWorkspaceProvider,
  PreparedInvestigationWorkspace,
} from "./workspace.js";

export interface InvestigationLoopCoordinatorOptions {
  readonly client: InvestigationWorkerClient;
  readonly processHost: ProcessHostClient;
  readonly modelTurnRunner: ModelTurnRunner;
  readonly e2eAgentRunner?: E2eAgentRunner;
  readonly workspaceProvider: InvestigationWorkspaceProvider;
  readonly planExecutor: InvestigationPlanExecutor;
  readonly logger: Logger;
  readonly heartbeatIntervalMs?: number;
  readonly terminalTimeoutMs?: number;
  readonly requestRetryMs?: number;
  readonly maximumPartBytes?: number;
  readonly onNodeFault?: (code: string) => void;
  readonly onAttemptCleanupConfirmed?: () => Promise<void>;
  readonly onAttemptCleanupUnconfirmed?: (code: string) => Promise<void>;
  readonly now?: () => number;
  readonly createId?: () => string;
}

class InvestigationExecutionStopped extends Error {
  public constructor(
    readonly outcome: InvestigationOutcome,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationExecutionStopped";
  }
}

/** Every accepted round is durable before the next model call can begin. */
export class InvestigationLoopCoordinator implements InvestigationClaimExecutor {
  readonly #now: () => number;
  readonly #createId: () => string;

  public constructor(private readonly options: InvestigationLoopCoordinatorOptions) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
  }

  public async execute(
    claim: ClaimedInvestigationTask,
    shutdownSignal: AbortSignal,
  ): Promise<void> {
    let checkpoint = claim.checkpoint;
    if (checkpoint === null)
      throw new Error("A claimed task must include its server-persisted initial checkpoint.");
    assertAcceptedCheckpoint(claim, checkpoint);
    const heartbeat = new InvestigationAttemptHeartbeat({
      client: this.options.client,
      taskId: claim.task.id,
      lease: claim.lease,
      ...(this.options.heartbeatIntervalMs === undefined
        ? {}
        : { intervalMs: this.options.heartbeatIntervalMs }),
      now: this.#now,
    });
    const progress = createInvestigationProgressReporter({
      client: this.options.client,
      taskId: claim.task.id,
      lease: claim.lease,
      now: this.#now,
      onFailure: () =>
        this.options.logger.warn("Investigation progress delivery is temporarily unavailable."),
    });
    let workspace: PreparedInvestigationWorkspace | undefined;
    let sourcePreparationStarted = false;
    let cleanupConfirmed = true;
    let outcome: InvestigationOutcome = "interrupted";
    let terminalDiagnostics: InvestigationDiagnostic[] = [];
    let pendingModelUsage: { round: number; tokens: number | null } | undefined;
    let pendingInvocationId: string | undefined;
    let pendingInvocationAccepted = false;
    let pendingUsageComplete = false;
    let correction: ModelTurnExecutionInput["correction"];
    let correctedRound: number | undefined;
    const modelRunner =
      claim.task.kind === "pr-e2e" ? this.options.e2eAgentRunner : this.options.modelTurnRunner;
    const budget = new AbortController();
    const remainingDuration = claim.task.budget.maxDurationMs - checkpoint.consumed.durationMs;
    const deadlineAtMs = this.#now() + remainingDuration;
    const deadline = setTimeout(
      () =>
        budget.abort(
          new InvestigationExecutionStopped(
            "interrupted",
            "BUDGET_EXHAUSTED",
            "The frozen task execution duration was exhausted.",
          ),
        ),
      Math.max(1, Math.min(2_147_483_647, remainingDuration)),
    );
    const executionSignal = AbortSignal.any([
      shutdownSignal,
      heartbeat.executionSignal,
      budget.signal,
    ]);
    let lastAccountedAt = this.#now();
    let lastAccountedDuration = checkpoint.consumed.durationMs;
    try {
      await heartbeat.start();
      if (checkpoint.stopReason !== "complete") {
        executionSignal.throwIfAborted();
        await progress.reportProgress("prepare_source", executionSignal);
        sourcePreparationStarted = true;
        workspace = await this.options.workspaceProvider.prepare(
          {
            task: claim.task,
            attempt: claim.attempt,
            inputSnapshot: claim.inputSnapshot,
          },
          { signal: executionSignal, processHost: this.options.processHost },
        );
        const accepted = async (
          request: InvestigationCheckpointRequest,
          signal = executionSignal,
        ): Promise<void> => {
          await progress.reportProgress("save_checkpoint", signal);
          const response = await this.#withRetry(
            () => this.options.client.checkpoint(claim.task.id, request, signal),
            signal,
            heartbeat,
          );
          assertAcceptedCheckpoint(claim, response.checkpoint);
          checkpoint = response.checkpoint;
          if (
            request.kind === "source_provenance" &&
            investigationContentDigest(checkpoint.runtime.sourceProvenance ?? null) !==
              investigationContentDigest(request.provenance)
          )
            throw new Error("The trusted source provenance was not retained by its checkpoint.");
          // The acknowledged analysis already charged this call, including its final budget unit.
          if (request.kind === "analysis" && checkpoint.round === request.round.round) {
            pendingModelUsage = undefined;
            pendingInvocationAccepted = true;
            if (pendingInvocationId !== undefined)
              await modelRunner?.markUsageDisposition?.(pendingInvocationId, "accepted");
            pendingInvocationId = undefined;
          }
          if (request.kind === "rejected_analysis") {
            const retained = checkpoint.runtime.modelOutputRejections?.find(
              (entry) => entry.invocationId === request.invocationId,
            );
            if (
              checkpoint.round !== request.round - 1 ||
              retained?.attemptId !== claim.attempt.id ||
              retained.round !== request.round ||
              investigationContentDigest(retained.issue) !==
                investigationContentDigest(request.issue)
            )
              throw new Error("The rejected model invocation was not retained by its checkpoint.");
            // The acknowledged rejection already charged this invocation through the ledger.
            pendingModelUsage = undefined;
            pendingInvocationId = undefined;
            pendingUsageComplete = false;
          }
          if (checkpoint.stopReason === "budget_exhausted") {
            throw new InvestigationExecutionStopped(
              "interrupted",
              "BUDGET_EXHAUSTED",
              "The accepted checkpoint exhausted the frozen investigation budget.",
            );
          }
        };
        const binding = workspace.sourceBinding;
        const provenance =
          binding !== null && (binding.submodules?.length ?? 0) > 0
            ? structuredClone({
                subjectRef: binding.subjectRef,
                sourceSha: binding.sourceSha,
                submodules: [...binding.submodules!],
              })
            : undefined;
        const previousProvenance = checkpoint.runtime.sourceProvenance;
        if (
          (provenance !== undefined &&
            (claim.task.executionPolicy.mode === "snapshot_only" ||
              !claim.task.executionPolicy.allowedSubjectRefs.includes(provenance.subjectRef) ||
              !validateInvestigationSourceProvenance(provenance, {
                subjectRef: claim.task.subjectRef,
                subjects: claim.task.subjects,
              }).valid)) ||
          (previousProvenance !== undefined &&
            investigationContentDigest(previousProvenance) !==
              investigationContentDigest(provenance ?? null))
        )
          throw new InvestigationExecutionStopped(
            "blocked",
            "SOURCE_SUBMODULE_BINDING_MISMATCH",
            "The materialized dependency graph does not match the task's frozen source provenance.",
          );
        if (provenance !== undefined && previousProvenance === undefined)
          await accepted({ kind: "source_provenance", lease: claim.lease, provenance });
        const uploadArtifacts = async (
          artifacts: InvestigationRuntimeState["artifacts"],
        ): Promise<void> => {
          if (workspace === undefined) throw new Error("The attempt workspace is not prepared.");
          if (artifacts.length > 0)
            await progress.reportProgress("upload_evidence", executionSignal);
          for (const artifact of artifacts) {
            executionSignal.throwIfAborted();
            const bytes = await workspace.readArtifact(artifact.id);
            await this.#withRetry(
              () =>
                this.options.client.uploadArtifact(
                  claim.task.id,
                  {
                    lease: claim.lease,
                    artifact,
                    contentBase64: Buffer.from(bytes).toString("base64"),
                  },
                  executionSignal,
                ),
              executionSignal,
              heartbeat,
            );
          }
        };
        if (claim.task.kind === "pr-review") {
          const observedManifest = await workspace.readPrDiffManifest();
          const manifest = {
            ...observedManifest,
            files: observedManifest.files.map((file) => ({
              ...file,
              chunkIds: [...file.chunkIds],
            })),
            chunks: observedManifest.chunks.map((chunk) => ({ ...chunk })),
          };
          const previousSource = checkpoint.runtime.sourceCoverage;
          if (previousSource !== undefined && previousSource.manifest.digest !== manifest.digest) {
            throw new InvestigationExecutionStopped(
              "blocked",
              "SOURCE_BINDING_MISMATCH",
              "The materialized PR diff does not match the source manifest preserved by this task.",
            );
          }
          if (previousSource === undefined) {
            await accepted({ kind: "source", lease: claim.lease, manifest });
          }
        }
        if (isInvestigationPlanTask(claim.task.kind)) {
          const result = await this.options.planExecutor.execute(
            {
              task: claim.task,
              attempt: claim.attempt,
              plan: claim.plan,
              execution: claim.execution,
              consumedTokens: checkpoint.consumed.tokens,
              workspace,
              priorState: {
                startedSteps: checkpoint.runtime.startedSteps,
                completedSteps: checkpoint.runtime.completedSteps,
              },
            },
            {
              processHost: this.options.processHost,
              signal: executionSignal,
              usageLease: claim.lease,
              invocationBudget: {
                remainingTokens: Math.max(
                  0,
                  claim.task.budget.maxTokens - checkpoint.consumed.tokens,
                ),
                deadlineAtMs,
              },
              onStepStarted: async (event) => {
                await accepted({
                  kind: "execution",
                  lease: claim.lease,
                  execution: {
                    ...checkpoint!.runtime,
                    startedSteps: [...checkpoint!.runtime.startedSteps, event],
                  },
                });
              },
              onRuntimeObservation: async (observation) => {
                const runtime = checkpoint!.runtime;
                const retained = new Set(runtime.artifacts.map((artifact) => artifact.id));
                await uploadArtifacts(
                  observation.artifacts.filter((artifact) => !retained.has(artifact.id)),
                );
                await accepted({
                  kind: "execution",
                  lease: claim.lease,
                  execution: {
                    ...runtime,
                    evidence: mergeRecords(runtime.evidence, observation.evidence),
                    artifacts: mergeRecords(runtime.artifacts, observation.artifacts),
                  },
                });
              },
              onStepCompleted: async (event) => {
                await uploadArtifacts([...event.artifacts]);
                const runtime = checkpoint!.runtime;
                await accepted({
                  kind: "execution",
                  lease: claim.lease,
                  execution: {
                    ...runtime,
                    completedStepIds: [...new Set([...runtime.completedStepIds, event.stepId])],
                    checks: mergeRecords(runtime.checks, event.validation.checks),
                    evidence: mergeRecords(runtime.evidence, event.verificationEvidence),
                    artifacts: mergeRecords(runtime.artifacts, event.artifacts),
                    subjects: mergeRecords(runtime.subjects, event.subjects),
                    completedSteps: [...runtime.completedSteps, event],
                  },
                });
              },
            },
          );
          const runtime = checkpoint.runtime;
          const extraArtifacts = result.artifacts.filter(
            (artifact) => !runtime.artifacts.some((existing) => existing.id === artifact.id),
          );
          await uploadArtifacts([...extraArtifacts]);
          await accepted({
            kind: "execution",
            lease: claim.lease,
            execution: {
              ...runtime,
              checks: mergeRecords(runtime.checks, result.validation.checks),
              evidence: mergeRecords(runtime.evidence, result.verificationEvidence),
              artifacts: mergeRecords(runtime.artifacts, result.artifacts),
              subjects: mergeRecords(runtime.subjects, result.subjects),
            },
          });
          if (result.outcome !== "completed") {
            terminalDiagnostics = [...result.diagnostics];
            throw new InvestigationExecutionStopped(
              result.outcome,
              "SAVED_PLAN_INCOMPLETE",
              "The saved plan could not complete its declared execution scope.",
            );
          }
        }
        if (
          claim.task.kind === "pr-e2e" &&
          checkpoint.runtime.e2e === undefined &&
          checkpoint.runtime.e2eExecution === undefined
        ) {
          // This durable marker precedes the first runtime operation, so recovery never
          // mistakes an interrupted execution for an attempt that has not run yet.
          await accepted({
            kind: "execution",
            lease: claim.lease,
            execution: {
              ...checkpoint.runtime,
              e2eExecution: {
                attemptId: claim.attempt.id,
                status: "started",
                startedAt: new Date(this.#now()).toISOString(),
                completedAt: null,
              },
            },
          });
        }
        while (checkpoint.stopReason === "continuing") {
          executionSignal.throwIfAborted();
          await workspace.assertIntegrity();
          const modelRound = checkpoint.round + 1;
          const observeUsage = (usage: ModelTurnExecutionResult["usage"]): void => {
            if (usage.invocationId !== undefined) pendingInvocationId = usage.invocationId;
            if (pendingModelUsage !== undefined && pendingModelUsage.tokens !== null) {
              if (usage.tokens === null) return;
              if (
                usage.tokens < pendingModelUsage.tokens ||
                (pendingUsageComplete && usage.tokens !== pendingModelUsage.tokens)
              )
                throw new InvestigationExecutionStopped(
                  "failed",
                  "MODEL_USAGE_CONFLICT",
                  "The model invocation attempted to reduce its reported token consumption.",
                );
            }
            pendingModelUsage = { round: modelRound, tokens: usage.tokens };
            if (
              usage.tokens !== null &&
              (usage.completeness === undefined || usage.completeness === "complete")
            )
              pendingUsageComplete = true;
          };
          if (modelRunner === undefined)
            throw new InvestigationExecutionStopped(
              "blocked",
              "E2E_RUNTIME_UNAVAILABLE",
              "The E2E execution runtime is not configured.",
            );
          pendingInvocationAccepted = false;
          pendingUsageComplete = false;
          await progress.reportProgress("model", executionSignal);
          const modelInput = {
            task: claim.task,
            attempt: claim.attempt,
            checkpoint,
            signal: executionSignal,
            workspace,
            onUsage: observeUsage,
            onActivity: progress.onActivity,
            usageLease: claim.lease,
            invocationBudget: {
              remainingTokens: Math.max(
                0,
                claim.task.budget.maxTokens - checkpoint.consumed.tokens,
              ),
              deadlineAtMs,
            },
            ...(correction === undefined ? {} : { correction }),
          };
          let e2eOutcome: InvestigationOutcome | undefined;
          let turn: ModelTurnExecutionResult;
          if (claim.task.kind === "pr-e2e") {
            const result = await this.options.e2eAgentRunner!.execute({
              ...modelInput,
              onRuntimeObservation: async (observation) => {
                if (checkpoint === null)
                  throw new Error("An E2E observation requires a persisted checkpoint.");
                const retained = new Set(
                  checkpoint.runtime.artifacts.map((artifact) => artifact.id),
                );
                await uploadArtifacts(
                  observation.artifacts.filter((artifact) => !retained.has(artifact.id)),
                );
                await accepted({
                  kind: "execution",
                  lease: claim.lease,
                  execution: {
                    ...checkpoint.runtime,
                    evidence: mergeRecords(checkpoint.runtime.evidence, observation.evidence),
                    artifacts: mergeRecords(checkpoint.runtime.artifacts, observation.artifacts),
                  },
                });
                await progress.reportProgress("model", executionSignal);
              },
            });
            observeUsage(result.usage);
            const retainedArtifactIds = new Set(
              checkpoint.runtime.artifacts.map((artifact) => artifact.id),
            );
            await uploadArtifacts(
              result.runtime.artifacts.filter((artifact) => !retainedArtifactIds.has(artifact.id)),
            );
            await accepted({ kind: "execution", lease: claim.lease, execution: result.runtime });
            // Execution is accepted before analysis; bind this trusted projection to that exact state.
            turn = {
              ...result,
              round: {
                ...result.round,
                inputCheckpointRef: {
                  id: checkpoint.id,
                  version: checkpoint.version,
                  digest: checkpoint.digest,
                },
              },
            };
            e2eOutcome = result.outcome;
          } else {
            try {
              turn = await modelRunner.execute(modelInput);
            } catch (error) {
              const proposedCorrection = getModelOutputCorrection(error);
              if (
                (claim.task.kind !== "pr-review" && claim.task.kind !== "issue-investigate") ||
                executionSignal.aborted ||
                proposedCorrection === null ||
                !isCorrectableInvestigationModelOutputIssue(proposedCorrection.issue) ||
                correctedRound === modelRound ||
                checkpoint.runtime.modelOutputRejections?.some(
                  (entry) => entry.attemptId === claim.attempt.id && entry.round === modelRound,
                ) ||
                pendingInvocationId === undefined ||
                pendingModelUsage?.tokens === undefined ||
                pendingModelUsage.tokens === null ||
                !pendingUsageComplete ||
                !cleanupConfirmed ||
                modelRunner.markUsageDisposition === undefined ||
                findUnconfirmedProcess(error) !== null
              )
                throw error;
              const issue = {
                ...proposedCorrection.issue,
                paths: [...proposedCorrection.issue.paths].sort(),
              };
              // This promise includes durable receipt delivery; failure cannot admit another call.
              await modelRunner.markUsageDisposition(pendingInvocationId, "rejected");
              await accepted({
                kind: "rejected_analysis",
                lease: claim.lease,
                inputCheckpointRef: {
                  id: checkpoint.id,
                  version: checkpoint.version,
                  digest: checkpoint.digest,
                },
                round: modelRound,
                invocationId: pendingInvocationId,
                issue,
              });
              if (checkpoint.stopReason !== "continuing")
                throw new InvestigationExecutionStopped(
                  "failed",
                  "MODEL_CORRECTION_NOT_ADMITTED",
                  "The rejected-output checkpoint did not admit another model invocation.",
                );
              correctedRound = modelRound;
              correction = { ...proposedCorrection, issue };
              lastAccountedAt = this.#now();
              lastAccountedDuration = checkpoint.consumed.durationMs;
              continue;
            }
          }
          // Custom runners can return their complete usage without emitting intermediate observations.
          observeUsage(turn.usage);
          executionSignal.throwIfAborted();
          await progress.reportProgress("validate_result", executionSignal);
          await workspace.assertIntegrity();
          if (turn.usage.tokens === null) {
            throw new InvestigationExecutionStopped(
              "interrupted",
              "MODEL_USAGE_UNAVAILABLE",
              "The CLI did not provide token consumption, so the frozen token budget cannot be enforced for another round.",
            );
          }
          const usage = {
            durationMs: Math.max(
              0,
              Math.floor(this.#now() - lastAccountedAt) -
                (checkpoint.consumed.durationMs - lastAccountedDuration),
            ),
            tokens: turn.usage.tokens,
            reportBytes: Buffer.byteLength(JSON.stringify(turn.round.analysis), "utf8"),
          };
          const validity = validateInvestigationAnalysisForTask(
            claim.task,
            turn.round.analysis,
            checkpoint.runtime,
          );
          if (!validity.valid)
            throw new InvestigationExecutionStopped(
              "failed",
              "MODEL_ANALYSIS_INVALID",
              "The model analysis violated the frozen task scope or trusted observation boundary.",
            );
          // Check the same deterministic guards locally before asking the server to accept the round.
          const sourceUnitIds = [...(turn.sourceUnitIds ?? [])];
          applyInvestigationLoopRound(checkpoint, turn.round, {
            recordedAt: new Date(this.#now()).toISOString(),
            usage,
            sourceUnitIds,
            ...(turn.modelIdentity === undefined ? {} : { modelIdentity: turn.modelIdentity }),
          });
          await accepted({
            kind: "analysis",
            lease: claim.lease,
            round: turn.round,
            usage,
            sourceUnitIds,
            ...(turn.usage.invocationId === undefined
              ? {}
              : { invocationId: turn.usage.invocationId }),
            ...(turn.modelIdentity === undefined ? {} : { modelIdentity: turn.modelIdentity }),
          });
          pendingModelUsage = undefined;
          correction = undefined;
          lastAccountedAt = this.#now();
          lastAccountedDuration = checkpoint.consumed.durationMs;
          this.options.logger.info("Investigation checkpoint accepted.", {
            taskId: claim.task.id,
            attemptId: claim.attempt.id,
            round: checkpoint.round,
            findingCount: checkpoint.analysis.findings.length,
            stopReason: checkpoint.stopReason,
          });
          if (e2eOutcome !== undefined && e2eOutcome !== "completed")
            throw new InvestigationExecutionStopped(
              e2eOutcome,
              e2eOutcome === "failed" ? "E2E_ASSERTION_FAILED" : "E2E_COVERAGE_BLOCKED",
              "The E2E session finished without complete successful runtime coverage.",
            );
        }
      }
      const complete = evaluateInvestigationCompletion(checkpoint);
      if (checkpoint.stopReason === "complete" && complete.complete) outcome = "completed";
      else if (checkpoint.stopReason === "blocked") outcome = "blocked";
      else if (checkpoint.stopReason === "error") outcome = "failed";
      else if (checkpoint.stopReason === "cancelled") outcome = "cancelled";
      else {
        outcome = "interrupted";
        terminalDiagnostics.push(
          this.#diagnostic(
            "BUDGET_EXHAUSTED",
            "The investigation stopped before every required unit, candidate, and final finding version was complete.",
            "limitation",
          ),
        );
      }
    } catch (error) {
      if (pendingInvocationId !== undefined && !pendingInvocationAccepted) {
        try {
          await modelRunner?.markUsageDisposition?.(pendingInvocationId, "rejected");
        } catch {
          this.options.logger.warn("Model disposition remains in the durable usage outbox.");
        }
      }
      const processFault = findUnconfirmedProcess(error);
      if (processFault !== null) {
        cleanupConfirmed = false;
        this.options.onNodeFault?.(processFault);
      }
      const stop =
        processFault !== null
          ? {
              outcome: "failed" as const,
              code: processFault,
              message:
                "Owned execution cleanup was not confirmed; its resources remain quarantined.",
            }
          : classifyStop(executionSignal.aborted ? executionSignal.reason : error);
      outcome = stop.outcome;
      terminalDiagnostics.push(
        this.#diagnostic(stop.code, stop.message, outcome === "blocked" ? "blocker" : "error"),
      );
    } finally {
      clearTimeout(deadline);
    }

    try {
      if (heartbeat.leaseLost) throw new InvestigationLeaseLost();
      const reportSignal = AbortSignal.timeout(this.options.terminalTimeoutMs ?? 60_000);
      if (outcome !== "completed" && checkpoint.stopReason !== "complete") {
        const reason =
          outcome === "failed"
            ? "error"
            : outcome === "interrupted" &&
                (checkpoint.stopReason === "budget_exhausted" ||
                  terminalDiagnostics.some((diagnostic) => diagnostic.code === "BUDGET_EXHAUSTED"))
              ? "budget_exhausted"
              : outcome;
        const response = await this.#withRetry(
          () =>
            this.options.client.checkpoint(
              claim.task.id,
              {
                kind: "interrupt",
                lease: claim.lease,
                reason,
                diagnostics: terminalDiagnostics,
                ...(sourcePreparationStarted &&
                workspace === undefined &&
                pendingModelUsage === undefined
                  ? { modelInvocationState: "not_started" as const }
                  : {}),
                ...(pendingModelUsage === undefined
                  ? {}
                  : {
                      modelUsage: {
                        ...pendingModelUsage,
                        ...(pendingInvocationId === undefined
                          ? {}
                          : { invocationId: pendingInvocationId }),
                      },
                    }),
              },
              reportSignal,
            ),
          reportSignal,
          heartbeat,
        );
        checkpoint = response.checkpoint;
        assertAcceptedCheckpoint(claim, checkpoint);
        if (checkpoint.stopReason === "complete") outcome = "completed";
        else if (checkpoint.stopReason === "budget_exhausted") outcome = "interrupted";
      } else if (checkpoint.stopReason === "complete") {
        // Cancellation cannot retroactively rewrite an already accepted complete analysis.
        outcome = "completed";
      }
      await progress.reportProgress("build_report", reportSignal);
      const reportUsage = await this.options.client.reportUsage?.(
        claim.task.id,
        { lease: claim.lease },
        reportSignal,
      );
      const submission = buildInvestigationReportSubmission({
        task: claim.task,
        attempt: claim.attempt,
        checkpoint,
        reportId: claim.reportId,
        outcome,
        parentPlan: claim.plan,
        ...(reportUsage === undefined ? {} : { usage: reportUsage.summary }),
        ...(this.options.maximumPartBytes === undefined
          ? {}
          : { maximumPartBytes: this.options.maximumPartBytes }),
      });
      for (const part of submission.parts) {
        await this.#withRetry(
          () =>
            this.options.client.uploadReportPart(
              claim.task.id,
              { lease: claim.lease, part },
              reportSignal,
            ),
          reportSignal,
          heartbeat,
        );
      }
      await this.#withRetry(
        () =>
          this.options.client.finalize(
            claim.task.id,
            {
              lease: claim.lease,
              header: submission.header,
              manifest: submission.manifest,
            },
            reportSignal,
          ),
        reportSignal,
        heartbeat,
      );
      this.options.logger.info("Investigation report sealed.", {
        taskId: claim.task.id,
        attemptId: claim.attempt.id,
        outcome,
      });
    } finally {
      await heartbeat.stop();
      await progress.reportProgress(
        "cleanup",
        AbortSignal.timeout(this.options.terminalTimeoutMs ?? 60_000),
      );
      try {
        if (workspace !== undefined && cleanupConfirmed) await workspace.cleanup();
        if (!cleanupConfirmed || heartbeat.leaseLost) {
          await this.options.onAttemptCleanupUnconfirmed?.(
            heartbeat.leaseLost ? "LEASE_LOST" : "OWNED_PROCESS_CLEANUP_UNCONFIRMED",
          );
          if (workspace !== undefined)
            this.options.logger.error(
              "Investigation workspace retained because execution cleanup was not confirmed.",
              { taskId: claim.task.id, attemptId: claim.attempt.id },
            );
        } else {
          await this.options.onAttemptCleanupConfirmed?.();
          // Resource release is a separate original-owner receipt, never implied by Task completion.
          await this.options.client.cleanup?.(
            claim.task.id,
            {
              lease: claim.lease,
              ownedProcessesStopped: true,
              desktopRestored: true,
            },
            AbortSignal.timeout(this.options.terminalTimeoutMs ?? 60_000),
          );
        }
      } catch (error) {
        // A released local guard remains released if only the Server acknowledgement was lost.
        await this.options.onAttemptCleanupUnconfirmed?.("ATTEMPT_CLEANUP_UNCONFIRMED");
        // biome-ignore lint/correctness/noUnsafeFinally: A cleanup failure must stop admission even when report delivery also failed.
        throw error;
      } finally {
        await progress.flush();
      }
    }
  }

  async #withRetry<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    heartbeat: InvestigationAttemptHeartbeat,
  ): Promise<T> {
    for (;;) {
      signal.throwIfAborted();
      if (heartbeat.leaseLost) throw new InvestigationLeaseLost();
      try {
        return await operation();
      } catch (error) {
        if (signal.aborted || heartbeat.leaseLost || !isRetryable(error)) throw error;
        await delay(this.options.requestRetryMs ?? 500, signal);
      }
    }
  }

  #diagnostic(
    code: string,
    message: string,
    category: InvestigationDiagnostic["category"],
  ): InvestigationDiagnostic {
    return {
      id: this.#createId(),
      code,
      message,
      category,
      retryable: code !== "E2E_EXECUTION_ALREADY_STARTED",
      evidenceRefs: [],
      prerequisiteRefs: [],
    };
  }
}

function assertAcceptedCheckpoint(
  claim: ClaimedInvestigationTask,
  checkpoint: InvestigationLoopCheckpointV1,
): void {
  const { digest, ...content } = checkpoint;
  if (
    digest !== investigationContentDigest(content) ||
    checkpoint.taskId !== claim.task.id ||
    checkpoint.attemptId !== claim.attempt.id ||
    checkpoint.leaseVersion !== claim.lease.fence ||
    checkpoint.taskBindingDigest !== investigationTaskBindingDigest(claim.task)
  ) {
    throw new Error(
      "The accepted checkpoint does not match the active frozen task and fenced attempt.",
    );
  }
}

function mergeRecords<T extends { readonly id: string }>(
  before: readonly T[],
  additions: readonly T[],
): T[] {
  const records = new Map(before.map((record) => [record.id, record]));
  for (const record of additions) {
    const previous = records.get(record.id);
    if (
      previous !== undefined &&
      investigationContentDigest(previous) !== investigationContentDigest(record)
    ) {
      throw new Error("A worker observation cannot change an already persisted record.");
    }
    records.set(record.id, record);
  }
  return [...records.values()];
}

function classifyStop(error: unknown): {
  readonly outcome: InvestigationOutcome;
  readonly code: string;
  readonly message: string;
} {
  const budget = findModelBudgetExceeded(error);
  if (budget !== null)
    return { outcome: "interrupted", code: "BUDGET_EXHAUSTED", message: budget.message };
  const validationMessage = safeModelOutputValidationMessage(error);
  if (validationMessage !== null)
    return {
      outcome: "failed",
      code: "MODEL_OUTPUT_INVALID",
      message: validationMessage,
    };
  if (error instanceof InvestigationExecutionStopped) return error;
  if (error instanceof InvestigationTaskCancelled)
    return {
      outcome: "cancelled",
      code: "TASK_CANCELLED",
      message: "The task was explicitly cancelled; its last accepted checkpoint was retained.",
    };
  if (error instanceof InvestigationWorkerShutdown)
    return {
      outcome: "interrupted",
      code: "WORKER_SHUTDOWN",
      message:
        "The worker stopped before the investigation completed; its accepted checkpoint can be resumed.",
    };
  if (error instanceof InvestigationLeaseLost)
    return {
      outcome: "interrupted",
      code: "LEASE_LOST",
      message:
        "The attempt lost execution ownership; its last server checkpoint remains authoritative.",
    };
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "INVESTIGATION_EXECUTION_FAILED";
  if (code === "cancellation_requested") {
    return {
      outcome: "cancelled",
      code: "TASK_CANCELLED",
      message:
        "The server cancelled the task before accepting further work; the last accepted checkpoint was retained.",
    };
  }
  if (code === "MODEL_USAGE_UNAVAILABLE")
    return {
      outcome: "interrupted",
      code,
      message:
        "Reliable in-flight model accounting became unavailable; retained usage remains partial and no further call was admitted.",
    };
  const submodulePrerequisites: Readonly<Record<string, string>> = {
    SOURCE_SUBMODULE_UNAVAILABLE:
      "A pinned Git submodule could not be acquired from its recorded public repository. Restore access to the exact dependency commit before resuming.",
    SOURCE_SUBMODULE_UNSUPPORTED:
      "A Git submodule definition uses an unsupported repository URL or configuration. Resolve the recorded source prerequisite before resuming.",
    SOURCE_SUBMODULE_LIMIT_EXCEEDED:
      "The pinned Git submodule graph exceeds the configured depth, count, or materialization budget. Review the source limits before resuming.",
    SOURCE_SUBMODULE_BINDING_MISMATCH:
      "A Git submodule no longer matches its recorded path, parent commit, or pinned dependency commit. Restore the exact source binding before resuming.",
  };
  const submoduleMessage = Object.hasOwn(submodulePrerequisites, code)
    ? submodulePrerequisites[code]
    : undefined;
  if (submoduleMessage !== undefined)
    return { outcome: "blocked", code, message: submoduleMessage };
  if (
    [
      "SOURCE_DIFF_TOO_LARGE",
      "SOURCE_PATCH_TOO_LARGE",
      "SOURCE_OUTPUT_TOO_LARGE",
      "SOURCE_TREE_TOO_LARGE",
      "MODEL_INPUT_LIMIT_EXCEEDED",
      "MODEL_OUTPUT_LIMIT_EXCEEDED",
      "SOURCE_EDIT_LIMIT_EXCEEDED",
      "ARTIFACT_LIMIT_EXCEEDED",
      "WORKSPACE_TREE_LIMIT_EXCEEDED",
    ].includes(code)
  ) {
    return {
      outcome: "interrupted",
      code,
      message:
        "A configured execution or transport budget was exhausted; the accepted investigation scope and records were retained.",
    };
  }
  const blocked = [
    "SOURCE_UNAVAILABLE",
    "SOURCE_BINDING_MISMATCH",
    "SOURCE_REPOSITORY_NOT_ALLOWED",
    "SOURCE_TREE_UNSUPPORTED",
    "SOURCE_DIFF_UNAVAILABLE",
    "SOURCE_DEPENDENCY_UNAVAILABLE",
    "SOURCE_DEPENDENCY_UNREADABLE",
    "SOURCE_DEPENDENCY_LIMIT_EXCEEDED",
    "MODEL_SOURCE_UNAVAILABLE",
    "MODEL_POLICY_UNAVAILABLE",
    "E2E_EXECUTION_ALREADY_STARTED",
  ].includes(code);
  return {
    outcome: blocked ? "blocked" : "failed",
    code,
    message: blocked
      ? "A required source or trusted execution prerequisite was unavailable."
      : "The investigation executor or model protocol failed; the last accepted checkpoint was retained.",
  };
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "retryable" in error && error.retryable === true
  );
}

function findUnconfirmedProcess(error: unknown, visited = new Set<object>()): string | null {
  if (typeof error !== "object" || error === null || visited.has(error)) return null;
  visited.add(error);
  if (
    "code" in error &&
    [
      "MODEL_PROCESS_CLEANUP_UNCONFIRMED",
      "SOURCE_PROCESS_CLEANUP_UNCONFIRMED",
      "UI_PROCESS_CLEANUP_UNCONFIRMED",
      "E2E_CLEANUP_UNCONFIRMED",
      "WORKSPACE_CLEANUP_UNCONFIRMED",
    ].includes(String(error.code))
  ) {
    return String(error.code);
  }
  if ("cause" in error) {
    const cause = findUnconfirmedProcess(error.cause, visited);
    if (cause !== null) return cause;
  }
  if ("errors" in error && Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      const cause = findUnconfirmedProcess(nested, visited);
      if (cause !== null) return cause;
    }
  }
  return null;
}
