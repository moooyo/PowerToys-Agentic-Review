import type {
  InvestigationArtifactV1,
  InvestigationAttemptV1,
  InvestigationEvidenceV1,
  InvestigationPlanV1,
  InvestigationRecipeStep,
  InvestigationTaskV1,
  InvestigationValidation,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { ProcessHostClient } from "../execution/process-host-protocol.js";
import { E2eAgentResultSchema, projectE2eResult } from "./e2e-agent-runner.js";
import { prepareE2eRecipe } from "./e2e-recipes.js";
import {
  type E2eToolReceipt,
  E2eToolServer,
  type E2eToolServerOptions,
} from "./e2e-tool-server.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

export interface InvestigationRecipeObservation {
  readonly summary: string;
  readonly checks: InvestigationValidation["checks"];
  readonly evidence: readonly InvestigationEvidenceV1[];
  readonly artifacts: readonly InvestigationArtifactV1[];
}

export interface InvestigationRecipePlanAdapter {
  execute(
    input: {
      readonly task: InvestigationTaskV1;
      readonly attempt: InvestigationAttemptV1;
      readonly plan: InvestigationPlanV1;
      readonly recipe: InvestigationRecipeStep;
      readonly workspace: PreparedInvestigationWorkspace;
    },
    context: {
      readonly signal: AbortSignal;
      readonly processHost: ProcessHostClient;
      readonly onProgress?: () => void;
      readonly onRuntimeObservation?: E2eToolServerOptions["onRuntimeObservation"];
    },
  ): Promise<InvestigationRecipeObservation>;
}

type RecipeTools = Pick<
  E2eToolServer,
  | "start"
  | "execute"
  | "cleanup"
  | "assertObservationsPersisted"
  | "receipts"
  | "evidence"
  | "artifacts"
  | "features"
  | "builds"
>;

export type RecipePlanAdapterOptions = Pick<
  E2eToolServerOptions,
  | "environment"
  | "processLimits"
  | "powershellExecutablePath"
  | "gitExecutablePath"
  | "buildTools"
  | "buildToolDigests"
  | "msbuildToolchain"
  | "ffmpegExecutablePath"
  | "desktopDriverPath"
> & {
  readonly createTools?: (options: E2eToolServerOptions) => RecipeTools;
};

/** Saved-plan execution shares controlled E2E tools without becoming a root E2E task. */
export function createRecipePlanAdapter(
  options: RecipePlanAdapterOptions,
): InvestigationRecipePlanAdapter {
  return {
    async execute(input, context) {
      context.signal.throwIfAborted();
      const subject = input.task.subjects.find((entry) => entry.id === input.task.subjectRef);
      if (
        input.task.kind !== "pr-verify" ||
        subject?.kind !== "original_pr" ||
        input.task.planRef === null ||
        input.task.planRef.id !== input.plan.id ||
        input.task.planRef.version !== input.plan.version ||
        input.task.planRef.digest !== input.plan.digest ||
        input.task.executionPolicy.mode !== "execute" ||
        !input.task.executionPolicy.allowRepositoryExecution ||
        input.task.executionPolicy.authorizationRef === null ||
        !input.task.executionPolicy.allowedSubjectRefs.includes(subject.id) ||
        input.attempt.taskId !== input.task.id ||
        input.workspace.sourceDirectory === null ||
        input.workspace.sourceBinding?.subjectRef !== subject.id ||
        input.workspace.sourceBinding.revisionKey !== subject.revisionKey ||
        input.workspace.sourceBinding?.sourceSha !== subject.headSha
      )
        throw new Error(
          "Recipe verification requires an authorized saved plan and pinned PR source.",
        );
      await input.workspace.assertSourceBinding();
      const manifest = await input.workspace.readPrDiffManifest();
      if (manifest.headSha !== subject.headSha || manifest.baseSha !== subject.baseSha)
        throw new Error("The recipe source manifest does not match the frozen PR revision.");
      const changedPaths = manifest.files.map((file) => file.path);
      const request = { operation: "run-recipe", ...input.recipe.request };
      const prepared = prepareE2eRecipe(request, input.task.repository.fullName, changedPaths);
      const mappedAssertions = new Set(
        input.recipe.checks.map((mapping) =>
          JSON.stringify([mapping.featureId, mapping.assertionId]),
        ),
      );
      if (
        mappedAssertions.size !== input.recipe.checks.length ||
        prepared.scenarios.some(({ feature }) =>
          feature.assertions.some(
            (assertion) => !mappedAssertions.has(JSON.stringify([feature.id, assertion.id])),
          ),
        )
      )
        throw new Error(
          "Every declared recipe assertion must map to exactly one saved plan check.",
        );
      for (const mapping of input.recipe.checks) {
        const feature = prepared.scenarios.find((entry) => entry.feature.id === mapping.featureId);
        if (!feature?.feature.assertions.some((assertion) => assertion.id === mapping.assertionId))
          throw new Error("A saved recipe check does not identify a registered feature assertion.");
      }
      const { createTools, ...configuration } = options;
      const tools = (createTools ?? ((value) => new E2eToolServer(value)))({
        ...configuration,
        task: input.task,
        attempt: input.attempt,
        workspace: input.workspace,
        processHost: context.processHost,
        signal: context.signal,
        changedPaths,
        ...(context.onRuntimeObservation === undefined
          ? {}
          : { onRuntimeObservation: context.onRuntimeObservation }),
        ...(context.onProgress === undefined ? {} : { onActivity: () => context.onProgress?.() }),
      });
      let receipt: E2eToolReceipt;
      try {
        await tools.start();
        receipt = await tools.execute(request);
      } finally {
        try {
          await tools.cleanup();
        } catch {
          // biome-ignore lint/correctness/noUnsafeFinally: A failed cleanup must retain the exclusive desktop slot.
          throw Object.assign(new Error("Recipe process and desktop cleanup was not confirmed."), {
            code: "E2E_CLEANUP_UNCONFIRMED",
          });
        }
      }
      context.signal.throwIfAborted();
      tools.assertObservationsPersisted();
      await input.workspace.assertSourceBinding();
      const observed = object(receipt.observed);
      const candidate = { summary: observed?.summary, features: observed?.features };
      const result = Value.Check(E2eAgentResultSchema, candidate)
        ? candidate
        : {
            summary: receipt.summary,
            features: prepared.scenarios.map(({ feature }) => ({
              featureId: feature.id,
              outcome: "blocked" as const,
              reason: "The recipe did not return a complete execution result.",
              assertionReceiptIds: [],
              mediaReceiptIds: [],
              limitations: [],
            })),
          };
      // A saved plan verifies its declared scope, not every changed feature in the PR.
      const coveredPaths = [...new Set(prepared.scenarios.flatMap(({ feature }) => feature.paths))];
      const projected = projectE2eResult(
        result,
        tools.receipts,
        tools.artifacts,
        coveredPaths,
        subject.headSha,
        tools.features,
        tools.builds,
      );
      const checks = input.recipe.checks.map((mapping) => {
        const feature = tools.features.find((entry) => entry.id === mapping.featureId);
        const assertionIndex = feature?.assertions.findIndex(
          (entry) => entry.id === mapping.assertionId,
        );
        const assertion =
          assertionIndex === undefined || assertionIndex < 0
            ? undefined
            : projected.e2e.features.find((entry) => entry.id === mapping.featureId)?.assertions[
                assertionIndex
              ];
        const proposed = result.features.find((entry) => entry.featureId === mapping.featureId);
        const assertionReceipts = tools.receipts.filter((entry) =>
          assertion?.evidenceRefs.includes(entry.id),
        );
        const media = tools.receipts.filter(
          (entry) =>
            proposed?.mediaReceiptIds.includes(entry.id) &&
            entry.status === "passed" &&
            ["screenshot", "video-stop"].includes(entry.operation) &&
            entry.featureId === mapping.featureId &&
            entry.artifactRefs.some((ref) =>
              tools.artifacts.some(
                (artifact) =>
                  artifact.id === ref &&
                  artifact.availability === "available" &&
                  ["image", "video"].includes(artifact.kind),
              ),
            ) &&
            assertionReceipts.some(
              (asserted) =>
                asserted.status === "passed" &&
                proposed?.assertionReceiptIds.includes(asserted.id) &&
                entry.relatedAssertionIds?.includes(asserted.id) &&
                entry.buildRef === asserted.buildRef &&
                entry.processRef === asserted.processRef &&
                entry.targetPid === asserted.targetPid &&
                entry.windowHandle === asserted.windowHandle,
            ),
        );
        const status =
          assertion?.outcome === "failed"
            ? "failed"
            : assertion?.outcome === "passed" &&
                media.length > 0 &&
                observed?.cleanupConfirmed === true
              ? "passed"
              : "blocked";
        // Linked verification consumes executor observations; media stays in the full evidence set.
        const refs = assertionReceipts.map((entry) => entry.id);
        return {
          id: mapping.checkId,
          scenarioId: mapping.scenarioId,
          subjectRef: input.task.subjectRef,
          planRef: { ...input.task.planRef! },
          required: true,
          description: assertion?.expected ?? "The saved recipe assertion was not executed.",
          status,
          executor: "e2e-tool-server",
          evidenceRefs: [...new Set(refs.length > 0 ? refs : [receipt.id])],
          authoritativeAttemptId: input.attempt.id,
        } satisfies InvestigationValidation["checks"][number];
      });
      return {
        summary: result.summary,
        checks,
        evidence: [...tools.evidence],
        artifacts: [...tools.artifacts],
      };
    },
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
