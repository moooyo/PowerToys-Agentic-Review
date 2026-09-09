import type { ValidationJobContext, ValidationJobContextV2 } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { modelArtifactEvaluationFixture } from "./model-output-artifact.testing.js";
import {
  dispatchProfileModel,
  type ProfileModelReview,
  resolveProfileModelPolicy,
} from "./profile-model-policy.js";

const workflows = ["pr_static_build", "issue_triage", "pr_ui", "issue_validation"] as const;

function evaluation(workflowKind: ValidationJobContext["workflowKind"], required: boolean) {
  const context = modelArtifactEvaluationFixture().envelope.validation;
  // This is only the policy selector's input projection, not execution authority or an envelope.
  return {
    schemaVersion: context.schemaVersion,
    workflowKind,
    purpose: context.purpose,
    modelRequirements: { required, expectedModelIdentityDigest: null },
  } satisfies Pick<
    ValidationJobContextV2,
    "schemaVersion" | "workflowKind" | "purpose" | "modelRequirements"
  >;
}

describe("frozen profile model dispatch", () => {
  it.each(workflows)(
    "never creates model work for profile-only %s, including a global recording override",
    async (workflow) => {
      const review = vi.fn(),
        summary = vi.fn();
      for (const forceRecording of [false, true]) {
        const policy = resolveProfileModelPolicy(evaluation(workflow, false), forceRecording);
        expect(policy).toEqual({ kind: "none", required: false, recorded: false });
        expect(await dispatchProfileModel(policy, { review, summary })).toEqual({
          state: "not_requested",
        });
      }
      expect(review).not.toHaveBeenCalled();
      expect(summary).not.toHaveBeenCalled();
    },
  );

  it.each(workflows)("requires the recorded model branch for %s", async (workflow) => {
    const policy = resolveProfileModelPolicy(evaluation(workflow, true));
    const expectedKind =
      workflow === "pr_ui" || workflow === "issue_validation" ? "summary" : "review";
    expect(policy).toEqual({ kind: expectedKind, required: true, recorded: true });
    const failure: ProfileModelReview = {
      state: "failed",
      code: "TEST_FAILURE",
      message: "Synthetic failure.",
    };
    const review = vi.fn(async () => failure),
      summary = vi.fn(async () => failure);
    expect(await dispatchProfileModel(policy, { review, summary })).toBe(failure);
    expect(expectedKind === "review" ? review : summary).toHaveBeenCalledExactlyOnceWith(true);
    expect(expectedKind === "review" ? summary : review).not.toHaveBeenCalled();
    expect(await dispatchProfileModel(policy, {})).toMatchObject({
      state: "failed",
      code: "MODEL_EXECUTOR_UNAVAILABLE",
    });
  });

  it.each(["pr_ui", "issue_validation"] as const)(
    "does not reinterpret a required but unrequested %s summary as optional",
    async (workflow) => {
      const summary = vi.fn(async () => ({ state: "not_requested" as const }));
      expect(
        await dispatchProfileModel(resolveProfileModelPolicy(evaluation(workflow, true)), {
          summary,
        }),
      ).toMatchObject({ state: "failed", code: "MODEL_REVIEW_REQUIRED" });
    },
  );

  it.each(workflows)(
    "preserves ordinary %s policy independently of evaluation",
    async (workflowKind) => {
      const policy = resolveProfileModelPolicy({
        schemaVersion: "ValidationJobContextV1",
        workflowKind,
      });
      const required = workflowKind === "pr_static_build" || workflowKind === "issue_triage";
      expect(policy).toEqual({ kind: required ? "review" : "summary", required, recorded: false });
      expect(await dispatchProfileModel(policy, {})).toMatchObject(
        required
          ? { state: "failed", code: "MODEL_EXECUTOR_UNAVAILABLE" }
          : { state: "not_requested" },
      );
      expect(
        resolveProfileModelPolicy({ schemaVersion: "ValidationJobContextV1", workflowKind }, true),
      ).toMatchObject({ required: true, recorded: true });
    },
  );

  it("preserves cancellation from the selected executor", async () => {
    const reason = new Error("Synthetic lease cancellation.");
    const summary = vi.fn(async () => {
      throw reason;
    });
    await expect(
      dispatchProfileModel(resolveProfileModelPolicy(evaluation("issue_validation", true)), {
        summary,
      }),
    ).rejects.toBe(reason);
  });

  it.each(["pr_ui", "issue_validation"] as const)(
    "keeps optional %s opt-in independent from required evaluation summaries",
    async (workflowKind) => {
      const summary = vi.fn();
      const disabled = resolveProfileModelPolicy(
        { schemaVersion: "ValidationJobContextV1", workflowKind },
        false,
        false,
      );
      expect(await dispatchProfileModel(disabled, { summary })).toEqual({ state: "not_requested" });
      expect(summary).not.toHaveBeenCalled();
      expect(resolveProfileModelPolicy(evaluation(workflowKind, true), false, false)).toEqual({
        kind: "summary",
        required: true,
        recorded: true,
      });
    },
  );

  it.each([
    { schemaVersion: "ValidationJobContextV2" },
    { schemaVersion: "ValidationJobContextV1", purpose: { kind: "evaluation" } },
    {
      schemaVersion: "ValidationJobContextV2",
      purpose: { kind: "review" },
      modelRequirements: { required: false },
    },
    {
      schemaVersion: "ValidationJobContextV2",
      purpose: { kind: "evaluation" },
      modelRequirements: { required: "false" },
    },
  ])("never downgrades a malformed evaluation marker %# to ordinary model work", (marker) => {
    expect(() =>
      resolveProfileModelPolicy({ workflowKind: "pr_ui", ...marker } as ValidationJobContextV2),
    ).toThrow("evaluation model requirement");
  });
});
