import {
  evaluationExecutionCapabilityLabel,
  evaluationModelExecutionCapabilityLabels,
  type ReviewRunRunnerSupport,
  validationExecutorCapabilityLabels,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { createEvaluationReproductionCellRecord } from "./evaluation-reproduction.js";
import { evaluationPlanFixture, reproductionFixture } from "./evaluation-reproduction.testing.js";
import { evaluateEvaluationRunReadiness } from "./review-run-plan.js";

function plan() {
  const record = createEvaluationReproductionCellRecord(reproductionFixture().input);
  if (record.reproduction === null || record.reproduction === undefined)
    throw new Error("The evaluation fixture requires a reproduction binding.");
  return evaluationPlanFixture(record.reproduction);
}

const runner: ReviewRunRunnerSupport = {
  workflowKind: "issue_validation",
  target: "headless",
  capabilities: [
    evaluationExecutionCapabilityLabel,
    evaluationModelExecutionCapabilityLabels.summary,
    validationExecutorCapabilityLabels.reproduction,
    validationExecutorCapabilityLabels.probes,
  ],
  evidenceDelivery: false,
};

describe("evaluation model readiness", () => {
  it("allows required model execution with the required executor capabilities", () => {
    const selected = plan();
    selected.modelRequirements = { required: true };
    const before = structuredClone(selected);
    expect(evaluateEvaluationRunReadiness(selected, [runner])).toEqual([
      { requestId: "new-request", required: true, state: "ready", reasons: [] },
    ]);
    expect(selected).toEqual(before);
  });

  it("keeps a required model blocked when the executor lacks model support", () => {
    const selected = plan();
    selected.modelRequirements = { required: true };
    expect(
      evaluateEvaluationRunReadiness(selected, [
        {
          ...runner,
          capabilities: runner.capabilities.filter(
            (capability) => capability !== evaluationModelExecutionCapabilityLabels.summary,
          ),
        },
      ]),
    ).toEqual([
      {
        requestId: "new-request",
        required: true,
        state: "blocked",
        reasons: [
          {
            code: "missing_capability",
            capability: evaluationModelExecutionCapabilityLabels.summary,
          },
        ],
      },
    ]);
  });

  it("still requires the evaluation protocol from a compatible executor", () => {
    const selected = plan();
    selected.modelRequirements = { required: true };
    expect(
      evaluateEvaluationRunReadiness(selected, [
        {
          ...runner,
          capabilities: runner.capabilities.filter(
            (capability) => capability !== evaluationExecutionCapabilityLabel,
          ),
        },
      ]),
    ).toEqual([
      {
        requestId: "new-request",
        required: true,
        state: "blocked",
        reasons: [{ code: "missing_capability", capability: evaluationExecutionCapabilityLabel }],
      },
    ]);
    expect(evaluateEvaluationRunReadiness(selected, [])[0]?.reasons).toEqual([
      { code: "unsupported_target" },
    ]);
  });

  it("allows profile-only execution without model support", () => {
    const profileRunner = {
      ...runner,
      capabilities: runner.capabilities.filter(
        (capability) => capability !== evaluationModelExecutionCapabilityLabels.summary,
      ),
    };
    expect(evaluateEvaluationRunReadiness(plan(), [profileRunner])[0]).toMatchObject({
      state: "ready",
      reasons: [],
    });
  });
});
