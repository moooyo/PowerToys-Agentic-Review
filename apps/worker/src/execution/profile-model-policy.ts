import type { ValidationJobResultV1, ValidationJobResultV2 } from "@agentic-review/codex";
import type { ValidationJobContext, ValidationJobContextV2 } from "@agentic-review/contracts";
import { isEvaluationContext } from "./profile-envelope.js";

export type ProfileModelReview =
  | ValidationJobResultV1["modelReview"]
  | ValidationJobResultV2["modelReview"];

export type ProfileModelPolicy =
  | { readonly kind: "none"; readonly required: false; readonly recorded: false }
  | { readonly kind: "review"; readonly required: true; readonly recorded: boolean }
  | { readonly kind: "summary"; readonly required: boolean; readonly recorded: boolean };

type ProfileModelContext =
  | Pick<ValidationJobContext, "schemaVersion" | "workflowKind">
  | Pick<
      ValidationJobContextV2,
      "schemaVersion" | "workflowKind" | "purpose" | "modelRequirements"
    >;

/** Selects model work only. Envelope consistency, admission and execution authority are separate. */
export function resolveProfileModelPolicy(
  context: ProfileModelContext,
  requireModelInvocation = false,
  optionalSummariesEnabled = true,
): ProfileModelPolicy {
  let evaluationRequired = false;
  if (isEvaluationContext(context)) {
    if (
      context.schemaVersion !== "ValidationJobContextV2" ||
      context.purpose?.kind !== "evaluation" ||
      typeof context.modelRequirements?.required !== "boolean"
    )
      throw new Error("The evaluation model requirement is invalid.");
    if (!context.modelRequirements.required)
      return { kind: "none", required: false, recorded: false };
    evaluationRequired = true;
  }
  const recorded = evaluationRequired || requireModelInvocation;
  switch (context.workflowKind) {
    case "pr_static_build":
    case "issue_triage":
      return { kind: "review", required: true, recorded };
    case "pr_ui":
    case "issue_validation":
      if (!recorded && !optionalSummariesEnabled)
        return { kind: "none", required: false, recorded: false };
      return { kind: "summary", required: recorded, recorded };
    default:
      throw new Error("The profile workflow has no supported model policy.");
  }
}

/** Does not create either model executor for profile-only evaluations. */
export async function dispatchProfileModel(
  policy: ProfileModelPolicy,
  executors: {
    readonly review?: (recorded: boolean) => Promise<ProfileModelReview>;
    readonly summary?: (recorded: boolean) => Promise<ProfileModelReview>;
  },
): Promise<ProfileModelReview> {
  if (policy.kind === "none") return { state: "not_requested" };
  const execute = executors[policy.kind];
  if (execute === undefined) {
    if (!policy.required) return { state: "not_requested" };
    return {
      state: "failed",
      code: "MODEL_EXECUTOR_UNAVAILABLE",
      message: "The required model executor is not configured for this frozen profile.",
    };
  }
  const result = await execute(policy.recorded);
  if (policy.required && result.state === "not_requested")
    return {
      state: "failed",
      code: "MODEL_REVIEW_REQUIRED",
      message: "The frozen profile requires a model result, but none was requested.",
    };
  return result;
}
