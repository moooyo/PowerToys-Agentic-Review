import { describe, expect, it } from "vitest";
import { findModelBudgetExceeded, ModelBudgetExceededError } from "./model-budget.js";

describe("model invocation budget failures", () => {
  it("recovers a budget stop through accounting wrappers without following cyclic causes", () => {
    const budget = new ModelBudgetExceededError("duration");
    const cyclic = new Error("Synthetic cyclic cause.");
    cyclic.cause = cyclic;
    const wrapped = new AggregateError(
      [cyclic, new Error("Synthetic accounting wrapper.", { cause: budget })],
      "The model and its accounting stopped.",
    );
    expect(findModelBudgetExceeded(wrapped)).toBe(budget);
    expect(findModelBudgetExceeded(cyclic)).toBeNull();
  });

  it("does not promote an unrelated error carrying a copied code into a trusted budget stop", () => {
    expect(
      findModelBudgetExceeded(
        Object.assign(new Error("Untrusted error."), { code: "MODEL_BUDGET_EXCEEDED" }),
      ),
    ).toBeNull();
  });
});
