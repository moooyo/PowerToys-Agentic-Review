import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  InvestigationPlanDraftSchema,
  investigationCanonicalJson,
  investigationPlanDigestPayload,
  validateInvestigationResult,
} from "./investigation.js";
import { InvestigationExecutablePlanStepSchema } from "./investigation-execution.js";
import { createInvestigationPreview } from "./investigation-preview.js";
import {
  getInvestigationRecipeStepIssues,
  type InvestigationRecipeRequest,
  InvestigationRecipeRequestSchema,
  type InvestigationRecipeStep,
  InvestigationRecipeStepSchema,
} from "./investigation-recipes.js";

type QueryRecipeStep = InvestigationRecipeStep & {
  request: Extract<InvestigationRecipeRequest, { recipeId: "powertoys-run-query" }>;
};

function queryRecipe(): QueryRecipeStep {
  return {
    request: {
      recipeId: "powertoys-run-query",
      plugin: "Calculator",
      scenarios: [
        {
          query: "=0-1e0",
          feature: {
            id: "scientific-subtraction",
            title: "Subtract a number in scientific notation",
            paths: ["src/modules/launcher/Plugins/Calculator/CalculateHelper.cs"],
            scenario: "Enter a subtraction expression and inspect its result.",
            userVisible: true,
            assertions: [
              {
                id: "result",
                kind: "ui",
                description: "The result retains the subtraction operator.",
                selector: { name: "-1" },
                assertion: { property: "text", expected: "-1", match: "equals" },
              },
            ],
          },
        },
        {
          query: "=1-2e-2",
          feature: {
            id: "negative-exponent",
            title: "Preserve a negative exponent",
            paths: ["src/modules/launcher/Plugins/Calculator/CalculateHelper.cs"],
            scenario: "Enter an expression with a negative exponent and inspect its result.",
            userVisible: true,
            assertions: [
              {
                id: "result",
                kind: "ui",
                description: "The exponent remains negative.",
                selector: { automationId: "ResultTitle" },
                assertion: { property: "text", expected: "0.98", match: "equals" },
              },
            ],
          },
          requires: "scientific-subtraction",
        },
      ],
    },
    checks: [
      {
        checkId: "check-subtraction",
        featureId: "scientific-subtraction",
        assertionId: "result",
        scenarioId: "scenario-subtraction",
      },
      {
        checkId: "check-exponent",
        featureId: "negative-exponent",
        assertionId: "result",
        scenarioId: "scenario-exponent",
      },
    ],
  };
}

function checkIds(recipe: InvestigationRecipeStep): string[] {
  return recipe.checks.map((check) => check.checkId);
}

function previewWithRecipe() {
  const { result } = createInvestigationPreview("pr");
  const plan = result.plans[0]!;
  const step = plan.steps[0]!;
  const recipe = queryRecipe();
  recipe.request.scenarios = [recipe.request.scenarios[0]!];
  recipe.checks = [
    {
      ...recipe.checks[0]!,
      checkId: step.checkIds[0]!,
      scenarioId: result.validation.checks[0]!.scenarioId,
    },
  ];
  step.recipe = recipe;
  return { result, plan, recipe };
}

describe("investigation recipe declarations", () => {
  it("accepts ordered query assertions with earlier dependencies and scoped assertion IDs", () => {
    const recipe = queryRecipe();
    expect(Value.Check(InvestigationRecipeRequestSchema, recipe.request)).toBe(true);
    expect(Value.Check(InvestigationRecipeStepSchema, recipe)).toBe(true);
    expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([]);
    expect(
      Value.Check(InvestigationExecutablePlanStepSchema, {
        stepId: "step-query",
        digest: "a".repeat(64),
        operation: { kind: "recipe", recipe },
      }),
    ).toBe(true);
  });

  it("accepts the supported UnitConverter plugin and bundled calculator request", () => {
    const recipe = queryRecipe();
    recipe.request.plugin = "UnitConverter";
    recipe.request.scenarios[0]!.query = "1 m in cm";
    expect(Value.Check(InvestigationRecipeRequestSchema, recipe.request)).toBe(true);
    expect(
      Value.Check(InvestigationRecipeRequestSchema, { recipeId: "powertoys-calculator" }),
    ).toBe(true);
  });

  it("rejects a UI assertion without a selector declaration", () => {
    const recipe = queryRecipe();
    const scenario = recipe.request.scenarios[0]!;
    const assertion = scenario.feature.assertions[0]!;
    expect(
      Value.Check(InvestigationRecipeRequestSchema, {
        ...recipe.request,
        scenarios: [
          {
            ...scenario,
            feature: {
              ...scenario.feature,
              assertions: [
                {
                  id: assertion.id,
                  kind: assertion.kind,
                  description: assertion.description,
                  assertion: assertion.assertion,
                },
              ],
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it.each(["command", "endpoint"])("rejects an arbitrary %s at every recipe boundary", (field) => {
    const recipe = queryRecipe();
    const scenario = recipe.request.scenarios[0]!;
    const assertion = scenario.feature.assertions[0]!;
    const extra = { [field]: "untrusted-execution-target" };
    const withScenario = (replacement: unknown) => ({
      ...recipe,
      request: { ...recipe.request, scenarios: [replacement] },
    });
    const withAssertion = (replacement: unknown) =>
      withScenario({ ...scenario, feature: { ...scenario.feature, assertions: [replacement] } });
    const candidates = [
      { location: "recipe", value: { ...recipe, ...extra } },
      { location: "request", value: { ...recipe, request: { ...recipe.request, ...extra } } },
      { location: "scenario", value: withScenario({ ...scenario, ...extra }) },
      {
        location: "feature",
        value: withScenario({ ...scenario, feature: { ...scenario.feature, ...extra } }),
      },
      { location: "assertion", value: withAssertion({ ...assertion, ...extra }) },
      {
        location: "selector",
        value: withAssertion({ ...assertion, selector: { ...assertion.selector, ...extra } }),
      },
      {
        location: "expectation",
        value: withAssertion({ ...assertion, assertion: { ...assertion.assertion, ...extra } }),
      },
      { location: "check", value: { ...recipe, checks: [{ ...recipe.checks[0]!, ...extra }] } },
    ];
    for (const candidate of candidates)
      expect(Value.Check(InvestigationRecipeStepSchema, candidate.value), candidate.location).toBe(
        false,
      );
    expect(
      Value.Check(InvestigationRecipeRequestSchema, {
        recipeId: "powertoys-calculator",
        ...extra,
      }),
    ).toBe(false);
    expect(
      Value.Check(InvestigationExecutablePlanStepSchema, {
        stepId: "step-query",
        digest: "a".repeat(64),
        operation: { kind: "recipe", recipe, ...extra },
      }),
    ).toBe(false);
  });
});

describe("investigation recipe check bindings", () => {
  it.each([
    ["missing", ["check-subtraction"]],
    ["extra", ["check-subtraction", "check-exponent", "check-extra"]],
    ["reordered", ["check-exponent", "check-subtraction"]],
    ["renamed", ["check-subtraction", "check-other"]],
  ] as const)("rejects %s saved check IDs", (_name, ids) => {
    expect(getInvestigationRecipeStepIssues(queryRecipe(), ids)).toEqual([
      "Recipe checks must match the saved step check IDs exactly in order.",
    ]);
  });

  it("rejects duplicate saved check IDs even when the recipe order matches", () => {
    const recipe = queryRecipe();
    recipe.checks[1]!.checkId = recipe.checks[0]!.checkId;
    expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([
      "Recipe checks must match the saved step check IDs exactly in order.",
    ]);
  });

  it("rejects two checks for one assertion even when their scenario IDs differ", () => {
    const recipe = queryRecipe();
    recipe.checks[1]!.featureId = recipe.checks[0]!.featureId;
    expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([
      "A recipe assertion cannot stand for multiple saved checks.",
      "Checks of one recipe feature must identify the same saved scenario.",
    ]);
  });

  it.each(["featureId", "assertionId"] as const)("rejects an undeclared %s", (field) => {
    const recipe = queryRecipe();
    recipe.checks[1]![field] = "undeclared";
    expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([
      "Every saved recipe check must identify a declared UI assertion.",
    ]);
  });

  it("rejects duplicate feature IDs even when their assertions differ", () => {
    const recipe = queryRecipe();
    const repeated = recipe.request.scenarios[1]!.feature;
    repeated.id = recipe.request.scenarios[0]!.feature.id;
    repeated.assertions[0]!.id = "other-result";
    recipe.checks[1]!.featureId = repeated.id;
    recipe.checks[1]!.assertionId = repeated.assertions[0]!.id;
    expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([
      "Recipe feature IDs must be unique.",
      "Checks of one recipe feature must identify the same saved scenario.",
    ]);
  });

  it("rejects duplicate assertion IDs within one feature", () => {
    const recipe = queryRecipe();
    const feature = recipe.request.scenarios[0]!.feature;
    feature.assertions.push(structuredClone(feature.assertions[0]!));
    expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([
      "Assertion IDs must be unique within their feature.",
    ]);
  });

  it.each([
    ["unknown", "missing-feature"],
    ["self", "scientific-subtraction"],
    ["later", "negative-exponent"],
  ])("rejects a dependency on a %s feature", (_name, dependency) => {
    const recipe = queryRecipe();
    recipe.request.scenarios[0]!.requires = dependency;
    expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([
      "A recipe dependency must identify an earlier feature.",
    ]);
  });

  it.each(["empty", "type-only"])(
    "rejects a %s selector without a name or automation ID",
    (kind) => {
      const recipe = queryRecipe();
      const assertion = recipe.request.scenarios[0]!.feature.assertions[0]!;
      if (kind === "empty") assertion.selector = {};
      else assertion.selector = { controlType: "Text", className: "TextBlock", index: 0 };
      expect(Value.Check(InvestigationRecipeStepSchema, recipe)).toBe(true);
      expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([
        "Recipe assertions must identify a named or automated control.",
      ]);
    },
  );

  it("reports recipe binding failures at the saved plan step", () => {
    const { result, recipe } = previewWithRecipe();
    recipe.checks[0]!.assertionId = "undeclared";
    expect(validateInvestigationResult(result).errors).toContainEqual({
      path: "/plans/0/steps/0/recipe",
      code: "RECIPE_CHECK_BINDING_INVALID",
      message: "Every saved recipe check must identify a declared UI assertion.",
    });
  });

  it("rejects recipes attached to an implementation plan", () => {
    const { result, plan } = previewWithRecipe();
    plan.kind = "implementation";
    expect(validateInvestigationResult(result).errors).toContainEqual({
      path: "/plans/0/steps/0/recipe",
      code: "RECIPE_PLAN_KIND_INVALID",
      message: "Bundled UI recipes require a verification plan.",
    });
  });
});

describe("investigation recipe plan digest payload", () => {
  it.each(["query", "plugin", "expected result", "selector", "dependency", "check mapping"])(
    "includes a change to the recipe %s in the canonical plan payload",
    (change) => {
      const { result } = createInvestigationPreview("pr");
      const plan = result.plans[0]!;
      const recipe = queryRecipe();
      plan.steps[0]!.recipe = recipe;
      plan.steps[0]!.checkIds = checkIds(recipe);
      const payload = investigationPlanDigestPayload(plan);
      expect(Value.Check(InvestigationPlanDraftSchema, payload)).toBe(true);
      expect(payload.steps[0]!.recipe).toEqual(recipe);
      const original = investigationCanonicalJson(payload);
      const savedDigest = plan.digest;
      const assertion = recipe.request.scenarios[0]!.feature.assertions[0]!;
      if (change === "query") recipe.request.scenarios[0]!.query = "=2-1e0";
      if (change === "plugin") recipe.request.plugin = "UnitConverter";
      if (change === "expected result") assertion.assertion.expected = "1";
      if (change === "selector") assertion.selector = { automationId: "OtherResultTitle" };
      if (change === "dependency") delete recipe.request.scenarios[1]!.requires;
      if (change === "check mapping") recipe.checks[0]!.scenarioId = "another-scenario";
      expect(Value.Check(InvestigationRecipeStepSchema, recipe)).toBe(true);
      expect(getInvestigationRecipeStepIssues(recipe, checkIds(recipe))).toEqual([]);
      expect(investigationCanonicalJson(investigationPlanDigestPayload(plan))).not.toBe(original);
      expect(plan.digest).toBe(savedDigest);
    },
  );
});
