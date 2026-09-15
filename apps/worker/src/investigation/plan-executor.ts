import { createHash, randomUUID } from "node:crypto";
import { createCanonicalResult } from "@agentic-review/codex";
import type {
  InvestigationArtifactV1,
  InvestigationAttemptV1,
  InvestigationDiagnostic,
  InvestigationEvidenceV1,
  InvestigationExecutablePlanStep,
  InvestigationModelEditsV1,
  InvestigationOutcome,
  InvestigationPlanExecutionBinding,
  InvestigationPlanStepStarted,
  InvestigationPlanV1,
  InvestigationRuntimeState,
  InvestigationSubjectV1,
  InvestigationTaskV1,
  InvestigationValidation,
} from "@agentic-review/contracts";
import {
  InvestigationModelEditsV1Schema,
  InvestigationPlanExecutionBindingSchema,
  investigationCanonicalJson,
  investigationPlanDigestPayload,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  ManagedProcessRunError,
  type ManagedProcessRunner,
  ProductionManagedProcessRunner,
} from "../execution/managed-process-runner.js";
import {
  assertValidProcessLaunchSpec,
  type ProcessHostClient,
  type ProcessResourceLimits,
} from "../execution/process-host-protocol.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

export type {
  InvestigationExecutablePlanStep,
  InvestigationPlanExecutionBinding,
  InvestigationPlanStepStarted,
};

export type InvestigationPlanStepCompleted = InvestigationRuntimeState["completedSteps"][number];

/** Only server-persisted worker events may be supplied as resumable state. */
export interface InvestigationPlanExecutionState {
  readonly startedSteps: readonly InvestigationPlanStepStarted[];
  readonly completedSteps: readonly InvestigationPlanStepCompleted[];
}

export interface InvestigationPlanExecutorInput {
  readonly task: InvestigationTaskV1;
  readonly attempt: InvestigationAttemptV1;
  readonly plan: InvestigationPlanV1 | null;
  readonly execution: InvestigationPlanExecutionBinding | null;
  readonly workspace: PreparedInvestigationWorkspace;
  readonly priorState?: InvestigationPlanExecutionState;
  readonly consumedTokens?: number;
}

export interface InvestigationPlanExecutorContext {
  readonly processHost: ProcessHostClient;
  readonly signal: AbortSignal;
  readonly onProgress?: () => void;
  /** Persist before starting a step, so an interrupted side effect is never replayed silently. */
  readonly onStepStarted: (event: InvestigationPlanStepStarted) => Promise<void>;
  /** Persist before moving to the next step. */
  readonly onStepCompleted: (event: InvestigationPlanStepCompleted) => Promise<void>;
}

export interface InvestigationPlanExecutionResult {
  readonly outcome: InvestigationOutcome;
  readonly validation: InvestigationValidation;
  readonly verificationEvidence: readonly InvestigationEvidenceV1[];
  readonly artifacts: readonly InvestigationArtifactV1[];
  readonly diagnostics: readonly InvestigationDiagnostic[];
  readonly subjects: readonly InvestigationSubjectV1[];
  readonly state: InvestigationPlanExecutionState;
}

export interface InvestigationPlanExecutor {
  execute(
    input: InvestigationPlanExecutorInput,
    context: InvestigationPlanExecutorContext,
  ): Promise<InvestigationPlanExecutionResult>;
}

export interface InvestigationUiPlanAdapter {
  execute(
    input: {
      readonly scenarioId: string;
      readonly task: InvestigationTaskV1;
      readonly attempt: InvestigationAttemptV1;
      readonly workspace: PreparedInvestigationWorkspace;
    },
    context: { readonly signal: AbortSignal; readonly processHost: ProcessHostClient },
  ): Promise<{
    readonly status: "passed" | "failed" | "blocked";
    readonly summary: string;
    readonly observation: unknown;
    readonly artifacts?: readonly InvestigationUiArtifact[];
  }>;
}

export interface InvestigationUiArtifact {
  readonly name: string;
  readonly mediaType: string;
  readonly kind: "image" | "log" | "trace";
  readonly bytes: Uint8Array;
}

export interface InvestigationModelEditAdapter {
  execute(
    input: {
      readonly task: InvestigationTaskV1;
      readonly attempt: InvestigationAttemptV1;
      readonly plan: InvestigationPlanV1;
      readonly stepId: string;
      readonly description: string;
      readonly expectedObservation: string;
      readonly allowedPaths: readonly string[];
      readonly workspace: PreparedInvestigationWorkspace;
    },
    context: {
      readonly signal: AbortSignal;
      readonly processHost: ProcessHostClient;
      readonly onProgress?: () => void;
    },
  ): Promise<{
    readonly proposal: InvestigationModelEditsV1;
    readonly usage: {
      readonly tokens: number | null;
      readonly source: "cli" | "unavailable";
      readonly durationMs?: number;
    };
  }>;
}

export interface ProductionInvestigationPlanExecutorOptions {
  /** Identifiers resolve only to executables approved in worker configuration. */
  readonly executables?: Readonly<Record<string, string>>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly processLimits: ProcessResourceLimits;
  readonly processRunner?: ManagedProcessRunner;
  readonly uiAdapters?: Readonly<Record<string, InvestigationUiPlanAdapter>>;
  readonly modelEditAdapter?: InvestigationModelEditAdapter;
  readonly createId?: () => string;
  readonly now?: () => Date;
}

const executionKinds = new Set<InvestigationTaskV1["kind"]>([
  "pr-verify",
  "issue-verify",
  "reproduction-setup",
  "issue-fix",
  "feature-implement",
]);
const expectedPlanKinds: Partial<Record<InvestigationTaskV1["kind"], InvestigationPlanV1["kind"]>> =
  {
    "pr-verify": "verification",
    "issue-verify": "verification",
    "reproduction-setup": "reproduction",
    "issue-fix": "fix",
    "feature-implement": "implementation",
  };

export function isInvestigationPlanTask(kind: InvestigationTaskV1["kind"]): boolean {
  return executionKinds.has(kind);
}

export function digestInvestigationExecutableStep(
  step: Omit<InvestigationExecutablePlanStep, "digest">,
): string {
  return createCanonicalResult(step).sha256;
}

export class ProductionInvestigationPlanExecutor implements InvestigationPlanExecutor {
  readonly #runner: ManagedProcessRunner;
  readonly #createId: () => string;
  readonly #now: () => Date;

  public constructor(private readonly options: ProductionInvestigationPlanExecutorOptions) {
    this.#runner = options.processRunner ?? new ProductionManagedProcessRunner();
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  public async execute(
    supplied: InvestigationPlanExecutorInput,
    context: InvestigationPlanExecutorContext,
  ): Promise<InvestigationPlanExecutionResult> {
    const input = {
      ...supplied,
      task: structuredClone(supplied.task),
      attempt: structuredClone(supplied.attempt),
      plan: structuredClone(supplied.plan),
      execution: structuredClone(supplied.execution),
      priorState: structuredClone(supplied.priorState ?? { startedSteps: [], completedSteps: [] }),
    };
    context.signal.throwIfAborted();
    const state = {
      startedSteps: [...input.priorState.startedSteps],
      completedSteps: [...input.priorState.completedSteps],
    };
    const priorModelTokens = state.completedSteps.reduce(
      (total, step) => total + (step.modelUsage?.tokens ?? 0),
      0,
    );
    let consumedTokens = input.consumedTokens ?? priorModelTokens;
    const result = (
      outcome: InvestigationOutcome,
      diagnostics: readonly InvestigationDiagnostic[] = [],
      subjects: readonly InvestigationSubjectV1[] = [],
      artifacts: readonly InvestigationArtifactV1[] = [],
    ): InvestigationPlanExecutionResult => ({
      outcome,
      validation: {
        checks: state.completedSteps.flatMap((step) => step.validation.checks),
        summary:
          outcome === "completed"
            ? "All saved plan steps completed with worker observations."
            : "The saved plan did not complete.",
      },
      verificationEvidence: state.completedSteps.flatMap((step) => step.verificationEvidence),
      artifacts: [...state.completedSteps.flatMap((step) => step.artifacts), ...artifacts],
      diagnostics: [...state.completedSteps.flatMap((step) => step.diagnostics), ...diagnostics],
      subjects: [...state.completedSteps.flatMap((step) => step.subjects), ...subjects],
      state,
    });
    const block = (code: string, message: string): InvestigationPlanExecutionResult =>
      result("blocked", [this.diagnostic(code, message)]);
    if (
      !Number.isSafeInteger(consumedTokens) ||
      consumedTokens < 0 ||
      consumedTokens < priorModelTokens
    )
      return block("PLAN_MODEL_USAGE_INVALID", "The persisted model token consumption is invalid.");
    const reason = validatePlanBinding(input);
    if (reason !== null) return block(reason.code, reason.message);
    const plan = input.plan;
    const execution = input.execution;
    if (plan === null || execution === null)
      return block("PLAN_EXECUTION_UNAVAILABLE", "A saved executable plan is required.");
    await input.workspace.assertIntegrity();
    if (input.workspace.sourceDirectory === null || input.workspace.sourceBinding === null)
      return block("PLAN_SOURCE_UNAVAILABLE", "The plan requires a verified source workspace.");
    if (!matchesSourceSubject(input))
      return block(
        "PLAN_SOURCE_BINDING_MISMATCH",
        "The source workspace does not match the exact plan subject and patch.",
      );
    await input.workspace.assertSourceBinding();
    const resumeProblem = validatePriorState(input, execution, plan);
    if (resumeProblem !== null) return block("PLAN_RESUME_UNSAFE", resumeProblem);
    if (isMutationTask(input.task) && state.completedSteps.length > 0) {
      const previousPatch = state.completedSteps.flatMap((step) => step.subjects).at(-1);
      if (previousPatch === undefined || previousPatch.kind !== "local_patch")
        return block(
          "PLAN_MUTATION_RESUME_UNSAFE",
          "Prior implementation steps require a restorable verified patch before resuming.",
        );
      let currentPatch: { readonly baseSha: string; readonly bytes: Uint8Array };
      try {
        currentPatch = await input.workspace.capturePatch(context.signal);
      } catch (error) {
        rethrowUnconfirmedProcessCleanup(error);
        context.signal.throwIfAborted();
        return block(
          "PLAN_MUTATION_RESUME_UNSAFE",
          "The previous implementation patch could not be restored and verified.",
        );
      }
      if (
        currentPatch.baseSha !== previousPatch.baseSha ||
        hashBytes(currentPatch.bytes) !== previousPatch.patchDigest
      )
        return block(
          "PLAN_MUTATION_RESUME_UNSAFE",
          "The current workspace does not contain the exact persisted implementation patch.",
        );
    }

    for (const executable of execution.steps) {
      context.signal.throwIfAborted();
      const completed = state.completedSteps.find((event) => event.stepId === executable.stepId);
      if (completed !== undefined) {
        if (completed.outcome !== "completed") return result(completed.outcome);
        continue;
      }
      const step = plan.steps.find((candidate) => candidate.id === executable.stepId);
      if (step === undefined)
        return block("PLAN_STEP_MISSING", "The executable step is absent from the saved plan.");
      if (
        executable.operation.kind === "model-edit" &&
        consumedTokens >= input.task.budget.maxTokens
      )
        return block(
          "PLAN_MODEL_TOKEN_BUDGET_EXCEEDED",
          "The task has no model token budget remaining for this edit step.",
        );
      await input.workspace.assertIntegrity();
      await input.workspace.assertSourceBinding();
      const started: InvestigationPlanStepStarted = {
        taskId: input.task.id,
        attemptId: input.attempt.id,
        planRef: execution.planRef,
        subjectRef: execution.subjectRef,
        subjectRevisionKey: execution.subjectRevisionKey,
        stepId: executable.stepId,
        stepDigest: executable.digest,
      };
      await context.onStepStarted(structuredClone(started));
      state.startedSteps.push(started);
      let observation = await this.observeStep(executable, { ...input, consumedTokens }, context);
      if (observation.modelUsage !== undefined) consumedTokens += observation.modelUsage.tokens;
      context.signal.throwIfAborted();
      await input.workspace.assertIntegrity();
      await input.workspace.assertSourceBinding();
      const subjects: InvestigationSubjectV1[] = [];
      const patchArtifacts: InvestigationArtifactV1[] = [];
      if (isMutationTask(input.task) && observation.outcome === "completed") {
        try {
          const captured = await input.workspace.capturePatch(context.signal);
          if (captured.bytes.byteLength > 0) {
            const subjectId = this.#createId();
            const patchArtifact = await input.workspace.writePatchArtifact({
              subjectRef: subjectId,
              baseSubjectRef: input.task.subjectRef,
              baseSha: captured.baseSha,
              bytes: captured.bytes,
            });
            const patchDigest = hashBytes(captured.bytes);
            subjects.push({
              id: subjectId,
              repositoryId: input.task.repository.id,
              workItemId: input.task.workItem.id,
              kind: "local_patch",
              baseSubjectRef: input.task.subjectRef,
              baseSha: captured.baseSha,
              patchDigest,
              artifactRef: patchArtifact.id,
              revisionKey: createCanonicalResult({ baseSha: captured.baseSha, patchDigest }).sha256,
            });
            patchArtifacts.push(patchArtifact);
          }
        } catch (error) {
          rethrowUnconfirmedProcessCleanup(error);
          context.signal.throwIfAborted();
          observation = {
            ...observation,
            status: "blocked",
            outcome: "blocked",
            summary: "The worker could not bind this step to its actual source patch.",
            details: {
              priorObservation: {
                status: observation.status,
                outcome: observation.outcome,
                summary: observation.summary,
                details: observation.details,
              },
            },
          };
        }
      }
      const observedSubjectRef = subjects.at(-1)?.id ?? execution.subjectRef;
      const observedArtifacts: InvestigationArtifactV1[] = [];
      for (const output of observation.artifacts ?? []) {
        observedArtifacts.push(
          await input.workspace.writeArtifact({ ...output, subjectRef: observedSubjectRef }),
        );
      }
      const artifact = await input.workspace.writeArtifact({
        name: `plan-step-${this.#createId()}.json`,
        mediaType: "application/json",
        kind: "log",
        subjectRef: observedSubjectRef,
        bytes: Buffer.from(
          createCanonicalResult({
            ...started,
            observedSubjectRef,
            subjects,
            observation: {
              status: observation.status,
              outcome: observation.outcome,
              summary: observation.summary,
              details: observation.details,
              artifactRefs: observedArtifacts.map((entry) => entry.id),
            },
          }).json,
          "utf8",
        ),
      });
      const evidence: InvestigationEvidenceV1 = {
        id: this.#createId(),
        subjectRef: observedSubjectRef,
        source: "executor_observation",
        authority: "worker",
        summary: observation.summary,
        artifactRefs: [
          artifact.id,
          ...patchArtifacts.map((entry) => entry.id),
          ...observedArtifacts.map((entry) => entry.id),
        ],
        evidenceRefs: [],
        provenance: {
          taskId: input.task.id,
          attemptId: input.attempt.id,
          producer: `saved-plan:${executable.operation.kind}`,
          recordedAt: this.#now().toISOString(),
        },
      };
      const event: InvestigationPlanStepCompleted = {
        ...started,
        outcome: observation.outcome,
        validation: {
          checks: step.checkIds.map((checkId) => ({
            id: checkId,
            scenarioId:
              executable.operation.kind === "ui" ? executable.operation.scenarioId : step.id,
            subjectRef: observedSubjectRef,
            planRef: execution.planRef,
            required: true,
            description: step.description,
            status:
              executable.operation.kind === "model-edit" && observation.outcome === "completed"
                ? "not_run"
                : observation.status,
            executor:
              executable.operation.kind === "model-edit" && observation.outcome === "completed"
                ? null
                : evidence.provenance.producer,
            evidenceRefs:
              executable.operation.kind === "model-edit" && observation.outcome === "completed"
                ? []
                : [evidence.id],
            authoritativeAttemptId:
              executable.operation.kind === "model-edit" && observation.outcome === "completed"
                ? null
                : input.attempt.id,
          })),
          summary: observation.summary,
        },
        verificationEvidence: [evidence],
        artifacts: [artifact, ...patchArtifacts, ...observedArtifacts],
        subjects,
        diagnostics:
          observation.status === "blocked"
            ? [
                this.diagnostic(
                  observation.diagnosticCode ?? "PLAN_EXECUTOR_UNAVAILABLE",
                  observation.summary,
                  [evidence.id],
                ),
              ]
            : [],
        ...(observation.modelUsage === undefined ? {} : { modelUsage: observation.modelUsage }),
      };
      await context.onStepCompleted(structuredClone(event));
      state.completedSteps.push(event);
      if (event.outcome !== "completed") return result(event.outcome);
    }

    if (isMutationTask(input.task)) {
      let captured: { readonly baseSha: string; readonly bytes: Uint8Array };
      try {
        captured = await input.workspace.capturePatch(context.signal);
      } catch (error) {
        rethrowUnconfirmedProcessCleanup(error);
        context.signal.throwIfAborted();
        return block(
          "PLAN_PATCH_UNAVAILABLE",
          "The worker could not capture the actual source patch.",
        );
      }
      if (captured.bytes.byteLength === 0)
        return block("PLAN_PATCH_EMPTY", "The implementation plan produced no source patch.");
      const finalSubject = state.completedSteps.flatMap((step) => step.subjects).at(-1);
      if (
        finalSubject?.kind !== "local_patch" ||
        finalSubject.baseSha !== captured.baseSha ||
        finalSubject.patchDigest !== hashBytes(captured.bytes)
      )
        return block(
          "PLAN_PATCH_CHANGED",
          "The final source patch changed after its last worker observation.",
        );
    }
    return result("completed");
  }

  private diagnostic(
    code: string,
    message: string,
    evidenceRefs: string[] = [],
  ): InvestigationDiagnostic {
    return {
      id: this.#createId(),
      code,
      category: "blocker",
      message,
      retryable: false,
      evidenceRefs,
      prerequisiteRefs: [],
    };
  }

  private async observeStep(
    step: InvestigationExecutablePlanStep,
    input: InvestigationPlanExecutorInput,
    context: InvestigationPlanExecutorContext,
  ): Promise<{
    readonly status: "passed" | "failed" | "blocked";
    readonly outcome: "completed" | "failed" | "blocked";
    readonly summary: string;
    readonly details: unknown;
    readonly diagnosticCode?: string;
    readonly modelUsage?: { readonly tokens: number; readonly durationMs: number };
    readonly artifacts?: readonly InvestigationUiArtifact[];
  }> {
    const operation = step.operation;
    if (operation.kind === "model-edit") {
      const adapter = this.options.modelEditAdapter;
      if (adapter === undefined)
        return {
          status: "blocked",
          outcome: "blocked",
          summary: "The saved model edit adapter is unavailable.",
          details: null,
        };
      const plan = input.plan;
      const savedStep = plan?.steps.find((entry) => entry.id === step.stepId);
      if (!isMutationTask(input.task) || plan === null || savedStep === undefined)
        return {
          status: "blocked",
          outcome: "blocked",
          summary: "This task cannot apply saved model edits.",
          details: null,
        };
      const startedAt = performance.now();
      const response = await adapter.execute(
        {
          task: structuredClone(input.task),
          attempt: structuredClone(input.attempt),
          plan: structuredClone(plan),
          stepId: savedStep.id,
          description: savedStep.description,
          expectedObservation: savedStep.expectedObservation,
          allowedPaths: [...operation.allowedPaths],
          workspace: input.workspace,
        },
        {
          signal: context.signal,
          processHost: context.processHost,
          ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
        },
      );
      const durationMs = Math.max(0, Math.ceil(performance.now() - startedAt));
      context.signal.throwIfAborted();
      const proposal = response.proposal;
      if (!Value.Check(InvestigationModelEditsV1Schema, proposal))
        throw new Error("The model edit adapter returned an invalid structured proposal.");
      if (
        response.usage.source !== "cli" ||
        response.usage.tokens === null ||
        !Number.isSafeInteger(response.usage.tokens) ||
        response.usage.tokens < 0
      )
        return {
          status: "blocked",
          outcome: "blocked",
          diagnosticCode: "PLAN_MODEL_USAGE_UNAVAILABLE",
          summary:
            "The model edit proposal was not applied because trusted token usage is unavailable.",
          details: { durationMs, usageSource: response.usage.source },
        };
      const modelUsage = { tokens: response.usage.tokens, durationMs };
      if ((input.consumedTokens ?? 0) + modelUsage.tokens > input.task.budget.maxTokens)
        return {
          status: "blocked",
          outcome: "blocked",
          diagnosticCode: "PLAN_MODEL_TOKEN_BUDGET_EXCEEDED",
          modelUsage,
          summary: "The model edit proposal exceeded the task token budget and was not applied.",
          details: { modelUsage },
        };
      await input.workspace.applyEdits({
        edits: structuredClone(proposal.edits),
        allowedPaths: [...operation.allowedPaths],
      });
      return {
        status: "passed",
        outcome: "completed",
        summary: `The worker applied ${proposal.edits.length} structured source edits from the saved model step.`,
        modelUsage,
        details: {
          proposalSummary: proposal.summary,
          edits: proposal.edits.map((edit) => ({
            path: edit.path,
            expectedDigest: edit.expectedDigest,
            resultingDigest:
              edit.content === null ? null : hashBytes(Buffer.from(edit.content, "utf8")),
          })),
        },
      };
    }
    if (operation.kind === "ui") {
      const adapter = ownValue(this.options.uiAdapters, operation.adapterId);
      if (adapter === undefined)
        return {
          status: "blocked",
          outcome: "blocked",
          summary: "The saved UI adapter is unavailable.",
          details: null,
        };
      const observed = await adapter.execute(
        {
          scenarioId: operation.scenarioId,
          task: structuredClone(input.task),
          attempt: structuredClone(input.attempt),
          workspace: input.workspace,
        },
        context,
      );
      if (
        !["passed", "failed", "blocked"].includes(observed.status) ||
        observed.summary.trim().length === 0
      )
        throw new Error("The UI adapter returned an invalid observation.");
      if (
        observed.artifacts !== undefined &&
        (!Array.isArray(observed.artifacts) ||
          observed.artifacts.length > 128 ||
          observed.artifacts.some(
            (artifact) =>
              !["image", "log", "trace"].includes(artifact.kind) ||
              !(artifact.bytes instanceof Uint8Array) ||
              artifact.name.length === 0 ||
              artifact.mediaType.length === 0,
          ))
      )
        throw new Error("The UI adapter returned invalid evidence artifacts.");
      return {
        status: observed.status,
        outcome: observed.status === "blocked" ? "blocked" : "completed",
        summary: observed.summary,
        details: observed.observation,
        ...(observed.artifacts === undefined
          ? {}
          : {
              artifacts: observed.artifacts.map((artifact) => ({
                ...artifact,
                bytes: Uint8Array.from(artifact.bytes),
              })),
            }),
      };
    }
    const executable = ownValue(this.options.executables, operation.executableId);
    if (executable === undefined)
      return {
        status: "blocked",
        outcome: "blocked",
        summary: "The saved command executable is unavailable.",
        details: null,
      };
    const workingDirectory =
      operation.workingDirectory === "."
        ? input.workspace.sourceDirectory
        : await input.workspace.resolveSourcePath(operation.workingDirectory);
    if (workingDirectory === null)
      return {
        status: "blocked",
        outcome: "blocked",
        summary: "The source directory is unavailable.",
        details: null,
      };
    const spec = {
      executable,
      arguments: [...operation.arguments],
      workingDirectory,
      environmentMode: "replace" as const,
      environment: { ...this.options.environment },
      limits: { ...this.options.processLimits },
    };
    assertValidProcessLaunchSpec(spec);
    try {
      const observed = await this.#runner.run(spec, {
        processHost: context.processHost,
        signal: context.signal,
        ...(context.onProgress === undefined ? {} : { onProgress: context.onProgress }),
      });
      const passed = observed.exitCode === operation.expectedExitCode;
      return {
        status: passed ? "passed" : "failed",
        outcome: "completed",
        summary: `Saved command exited with code ${observed.exitCode}.`,
        details: observed,
      };
    } catch (error) {
      if (context.signal.aborted) context.signal.throwIfAborted();
      if (!(error instanceof ManagedProcessRunError)) throw error;
      const passed =
        error.code === "NON_ZERO_EXIT" && error.exitCode === operation.expectedExitCode;
      const unavailable = error.code === "PROCESS_START_FAILED";
      return {
        status: passed ? "passed" : unavailable ? "blocked" : "failed",
        outcome: error.code === "NON_ZERO_EXIT" ? "completed" : unavailable ? "blocked" : "failed",
        summary: `Saved command observation: ${error.code}.`,
        details: {
          code: error.code,
          exitCode: error.exitCode,
          stdout: error.stdout,
          stderr: error.stderr,
        },
      };
    }
  }
}

function validatePlanBinding(
  input: InvestigationPlanExecutorInput,
): { code: string; message: string } | null {
  const reject = (code: string, message: string): { code: string; message: string } => ({
    code,
    message,
  });
  const { task, attempt, plan, execution } = input;
  if (!isInvestigationPlanTask(task.kind))
    return reject("PLAN_TASK_KIND_UNSUPPORTED", "This task kind does not execute a saved plan.");
  if (attempt.taskId !== task.id)
    return reject("PLAN_ATTEMPT_MISMATCH", "The attempt does not belong to this task.");
  if (plan === null || execution === null || task.planRef === null)
    return reject(
      "PLAN_EXECUTION_UNAVAILABLE",
      "A saved plan and trusted executable steps are required.",
    );
  if (!Value.Check(InvestigationPlanExecutionBindingSchema, execution))
    return reject("PLAN_EXECUTABLE_STEPS_INVALID", "The trusted execution binding is invalid.");
  if (
    plan.state !== "saved" ||
    plan.kind !== expectedPlanKinds[task.kind] ||
    (plan.subjectRef !== task.subjectRef && !hasExplicitIssueSourcePlanBinding(task, plan)) ||
    task.planRef.id !== plan.id ||
    task.planRef.version !== plan.version ||
    task.planRef.digest !== plan.digest ||
    task.parentTaskId === null ||
    task.parentReportRef === null ||
    task.parentReportRef.id !== plan.sourceReportRef.id ||
    task.parentReportRef.version !== plan.sourceReportRef.version ||
    !same(execution.planRef, task.planRef)
  )
    return reject(
      "PLAN_BINDING_MISMATCH",
      "The executable plan does not match the task's saved plan reference.",
    );
  if (
    plan.digest !==
    hashBytes(Buffer.from(investigationCanonicalJson(investigationPlanDigestPayload(plan)), "utf8"))
  )
    return reject(
      "PLAN_DIGEST_MISMATCH",
      "The saved plan content no longer matches its frozen digest.",
    );
  const subject = task.subjects.find((candidate) => candidate.id === task.subjectRef);
  if (
    subject === undefined ||
    execution.subjectRef !== subject.id ||
    execution.subjectRevisionKey !== subject.revisionKey
  )
    return reject(
      "PLAN_SUBJECT_MISMATCH",
      "The plan is not bound to the exact task subject revision.",
    );
  if (isMutationTask(task) && subject.kind === "local_patch")
    return reject(
      "PLAN_MUTATION_BASE_UNSUPPORTED",
      "A new implementation patch requires an immutable source subject as its base.",
    );
  const policy = task.executionPolicy;
  if (
    policy.mode !== "execute" ||
    !policy.allowRepositoryExecution ||
    policy.authorizationRef === null ||
    !policy.allowedSubjectRefs.includes(subject.id) ||
    execution.authorizationRef !== policy.authorizationRef ||
    execution.executionPolicyDigest !== createCanonicalResult(policy).sha256
  )
    return reject(
      "PLAN_EXECUTION_NOT_AUTHORIZED",
      "The exact saved plan execution policy is not authorized.",
    );
  if (
    plan.prerequisites.some(
      (prerequisite) => !execution.satisfiedPrerequisiteRefs.includes(prerequisite.id),
    )
  )
    return reject(
      "PLAN_PREREQUISITES_UNSATISFIED",
      "A saved plan prerequisite has not been satisfied.",
    );
  if (
    plan.steps.length === 0 ||
    execution.steps.length !== plan.steps.length ||
    new Set(plan.steps.map((step) => step.id)).size !== plan.steps.length ||
    new Set(execution.steps.map((step) => step.stepId)).size !== execution.steps.length ||
    execution.steps.some(
      (step, index) =>
        step.stepId !== plan.steps[index]?.id ||
        step.digest !==
          digestInvestigationExecutableStep({ stepId: step.stepId, operation: step.operation }),
    )
  )
    return reject(
      "PLAN_EXECUTABLE_STEPS_INVALID",
      "Every saved plan step must have one exact trusted executable operation in order.",
    );
  const checks = plan.steps.flatMap((step) => step.checkIds);
  if (new Set(checks).size !== checks.length || (!isMutationTask(task) && checks.length === 0))
    return reject(
      "PLAN_CHECK_BINDING_INVALID",
      "Saved validation plans require checks, and check identifiers must be distinct.",
    );
  if (execution.steps.some((step) => step.operation.kind === "model-edit") && !isMutationTask(task))
    return reject(
      "PLAN_MODEL_EDIT_NOT_AUTHORIZED",
      "Only implementation tasks may apply saved model edits.",
    );
  if (isMutationTask(task) && !execution.steps.some((step) => step.operation.kind === "model-edit"))
    return reject(
      "PLAN_MODEL_EDIT_REQUIRED",
      "Implementation tasks require a saved model edit operation.",
    );
  return null;
}

function validatePriorState(
  input: InvestigationPlanExecutorInput,
  execution: InvestigationPlanExecutionBinding,
  plan: InvestigationPlanV1,
): string | null {
  const state = input.priorState ?? { startedSteps: [], completedSteps: [] };
  const seenStarted = new Set<string>();
  const seenCompleted = new Set<string>();
  const validBinding = (event: InvestigationPlanStepStarted): boolean => {
    const step = execution.steps.find((candidate) => candidate.stepId === event.stepId);
    return (
      event.taskId === input.task.id &&
      same(event.planRef, execution.planRef) &&
      event.subjectRef === execution.subjectRef &&
      event.subjectRevisionKey === execution.subjectRevisionKey &&
      step !== undefined &&
      step.digest === event.stepDigest
    );
  };
  for (const event of state.startedSteps) {
    if (!validBinding(event) || seenStarted.has(event.stepId))
      return "A prior started step has an invalid or duplicate binding.";
    seenStarted.add(event.stepId);
  }
  for (const [index, event] of state.completedSteps.entries()) {
    if (
      !validBinding(event) ||
      seenCompleted.has(event.stepId) ||
      !seenStarted.has(event.stepId) ||
      !state.startedSteps.some(
        (started) => started.stepId === event.stepId && started.attemptId === event.attemptId,
      ) ||
      (index > 0 && state.completedSteps[index - 1]?.outcome !== "completed") ||
      execution.steps[index]?.stepId !== event.stepId
    )
      return "Completed plan steps must be an exact ordered prefix of this saved plan.";
    seenCompleted.add(event.stepId);
    if (
      event.subjects.length > 1 ||
      event.subjects.some(
        (subject) =>
          !isMutationTask(input.task) ||
          subject.kind !== "local_patch" ||
          subject.baseSubjectRef !== input.task.subjectRef ||
          subject.repositoryId !== input.task.repository.id ||
          subject.workItemId !== input.task.workItem.id ||
          subject.baseSha !== input.workspace.sourceBinding?.sourceSha ||
          subject.revisionKey !==
            createCanonicalResult({ baseSha: subject.baseSha, patchDigest: subject.patchDigest })
              .sha256 ||
          !event.artifacts.some(
            (artifact) =>
              artifact.id === subject.artifactRef &&
              artifact.kind === "patch" &&
              artifact.subjectRef === subject.id &&
              artifact.digest === subject.patchDigest &&
              artifact.availability === "available",
          ),
      )
    )
      return "A prior implementation subject does not match its persisted patch artifact and exact base.";
    const observedSubjectRef = event.subjects.at(-1)?.id ?? event.subjectRef;
    const checks = plan.steps[index]?.checkIds ?? [];
    const operation = execution.steps[index]?.operation;
    const scenarioId = operation?.kind === "ui" ? operation.scenarioId : event.stepId;
    const producer = `saved-plan:${operation?.kind}`;
    const editObservationOnly = operation?.kind === "model-edit" && event.outcome === "completed";
    if (
      editObservationOnly &&
      (event.modelUsage === undefined ||
        !Number.isSafeInteger(event.modelUsage.tokens) ||
        event.modelUsage.tokens < 0 ||
        !Number.isSafeInteger(event.modelUsage.durationMs) ||
        event.modelUsage.durationMs < 0)
    )
      return "A prior model edit is missing its trusted model usage receipt.";
    const validStatus = (status: string): boolean =>
      editObservationOnly
        ? status === "not_run"
        : event.outcome === "completed"
          ? status === "passed" || status === "failed"
          : status === event.outcome;
    if (
      event.validation.checks.length !== checks.length ||
      event.verificationEvidence.length === 0 ||
      event.validation.checks.some(
        (check, checkIndex) =>
          check.id !== checks[checkIndex] ||
          check.subjectRef !== observedSubjectRef ||
          !same(check.planRef, event.planRef) ||
          check.scenarioId !== scenarioId ||
          !check.required ||
          check.executor !== (editObservationOnly ? null : producer) ||
          check.authoritativeAttemptId !== (editObservationOnly ? null : event.attemptId) ||
          !validStatus(check.status) ||
          (editObservationOnly
            ? check.evidenceRefs.length !== 0
            : check.evidenceRefs.length === 0) ||
          check.evidenceRefs.some(
            (id) => !event.verificationEvidence.some((evidence) => evidence.id === id),
          ),
      ) ||
      event.verificationEvidence.some(
        (evidence) =>
          evidence.authority !== "worker" ||
          evidence.source !== "executor_observation" ||
          evidence.subjectRef !== observedSubjectRef ||
          evidence.provenance.producer !== producer ||
          evidence.provenance.taskId !== event.taskId ||
          evidence.provenance.attemptId !== event.attemptId ||
          evidence.artifactRefs.length === 0 ||
          evidence.artifactRefs.some(
            (id) =>
              !event.artifacts.some(
                (artifact) =>
                  artifact.id === id &&
                  artifact.taskId === event.taskId &&
                  artifact.attemptId === event.attemptId &&
                  artifact.subjectRef === observedSubjectRef &&
                  artifact.availability === "available",
              ),
          ),
      )
    )
      return "A prior completed step is missing authoritative observations or exact check and artifact bindings.";
  }
  if (state.startedSteps.some((event) => !seenCompleted.has(event.stepId)))
    return "A previous step may have executed before interruption; its effects require reconciliation before resuming.";
  return null;
}

function same(left: unknown, right: unknown): boolean {
  return createCanonicalResult(left).json === createCanonicalResult(right).json;
}

function isMutationTask(task: InvestigationTaskV1): boolean {
  return task.kind === "issue-fix" || task.kind === "feature-implement";
}

function hasExplicitIssueSourcePlanBinding(
  task: InvestigationTaskV1,
  plan: InvestigationPlanV1,
): boolean {
  if (
    !["issue-verify", "reproduction-setup", "issue-fix", "feature-implement"].includes(task.kind) ||
    task.workItem.kind !== "issue"
  )
    return false;
  const source = task.subjects.find((subject) => subject.id === task.subjectRef);
  const snapshot = task.subjects.find((subject) => subject.id === plan.subjectRef);
  return (
    source?.kind === "source_commit" &&
    snapshot?.kind === "issue_snapshot" &&
    source.repositoryId === task.repository.id &&
    snapshot.repositoryId === task.repository.id &&
    source.workItemId === task.workItem.id &&
    snapshot.workItemId === task.workItem.id &&
    task.parentReportRef !== null &&
    task.parentReportRef.id === plan.sourceReportRef.id &&
    task.parentReportRef.version === plan.sourceReportRef.version
  );
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rethrowUnconfirmedProcessCleanup(error: unknown): void {
  const pending = [error];
  const visited = new Set<Error>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) continue;
    visited.add(current);
    if (
      "code" in current &&
      (current.code === "SOURCE_PROCESS_CLEANUP_UNCONFIRMED" ||
        current.code === "UI_PROCESS_CLEANUP_UNCONFIRMED" ||
        current.code === "MODEL_PROCESS_CLEANUP_UNCONFIRMED")
    )
      throw current;
    if (current.cause !== undefined) pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
}

function ownValue<T>(values: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return values !== undefined && Object.hasOwn(values, key) ? values[key] : undefined;
}

function matchesSourceSubject(input: InvestigationPlanExecutorInput): boolean {
  const source = input.workspace.sourceBinding;
  const subject = input.task.subjects.find((candidate) => candidate.id === input.task.subjectRef);
  if (
    source === null ||
    subject === undefined ||
    source.subjectRef !== subject.id ||
    source.revisionKey !== subject.revisionKey
  )
    return false;
  if (subject.kind === "local_patch")
    return (
      source.sourceSha === subject.baseSha &&
      source.patchDigest === subject.patchDigest &&
      source.artifactRef === subject.artifactRef
    );
  if (source.patchDigest !== null) return false;
  if (subject.kind === "original_pr" || subject.kind === "remote_branch")
    return source.sourceSha === subject.headSha;
  if (subject.kind === "source_commit") return source.sourceSha === subject.commitSha;
  return false;
}
