import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { EntityIdSchema } from "./common.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const text = Type.String({ minLength: 1, maxLength: 4_096, pattern: "\\S" });
const localId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });

export const InvestigationRecipeAssertionSchema = object({
  id: localId,
  kind: Type.Literal("ui"),
  description: text,
  selector: object({
    automationId: Type.Optional(text),
    name: Type.Optional(text),
    controlType: Type.Optional(text),
    className: Type.Optional(text),
    index: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  }),
  assertion: object({
    property: Type.Union(
      (["exists", "text", "value", "enabled", "offscreen", "focused", "toggleState"] as const).map(
        (value) => Type.Literal(value),
      ),
    ),
    expected: Type.Union([Type.String({ maxLength: 8_192 }), Type.Boolean()]),
    match: Type.Optional(Type.Union([Type.Literal("equals"), Type.Literal("contains")])),
  }),
});

export const InvestigationRecipeRequestSchema = Type.Union([
  object({ recipeId: Type.Literal("powertoys-calculator") }),
  object({
    recipeId: Type.Literal("powertoys-run-query"),
    plugin: Type.Union([Type.Literal("Calculator"), Type.Literal("UnitConverter")]),
    scenarios: Type.Array(
      object({
        query: Type.String({ minLength: 1, maxLength: 8_192, pattern: "\\S" }),
        feature: object({
          id: localId,
          title: text,
          paths: Type.Array(text, { minItems: 1, maxItems: 128, uniqueItems: true }),
          scenario: text,
          userVisible: Type.Literal(true),
          assertions: Type.Array(InvestigationRecipeAssertionSchema, { minItems: 1, maxItems: 64 }),
        }),
        requires: Type.Optional(localId),
      }),
      { minItems: 1, maxItems: 8 },
    ),
  }),
]);

/** Declarative UI work; it contains no command, executable, endpoint or deployment path. */
export const InvestigationRecipeStepSchema = object({
  request: InvestigationRecipeRequestSchema,
  checks: Type.Array(
    object({
      checkId: EntityIdSchema,
      featureId: localId,
      assertionId: localId,
      scenarioId: EntityIdSchema,
    }),
    { minItems: 1, maxItems: 512 },
  ),
});
export type InvestigationRecipeStep = Static<typeof InvestigationRecipeStepSchema>;
export type InvestigationRecipeRequest = Static<typeof InvestigationRecipeRequestSchema>;

/** Checks remain one-to-one with actual UI assertions instead of inheriting a group outcome. */
export function getInvestigationRecipeStepIssues(
  recipe: InvestigationRecipeStep,
  checkIds: readonly string[],
): string[] {
  const issues: string[] = [];
  if (
    recipe.checks.length !== checkIds.length ||
    recipe.checks.some((check, index) => check.checkId !== checkIds[index]) ||
    new Set(checkIds).size !== checkIds.length
  )
    issues.push("Recipe checks must match the saved step check IDs exactly in order.");
  if (
    new Set(recipe.checks.map((check) => JSON.stringify([check.featureId, check.assertionId])))
      .size !== recipe.checks.length
  )
    issues.push("A recipe assertion cannot stand for multiple saved checks.");
  if (recipe.request.recipeId === "powertoys-run-query") {
    const assertions = new Set<string>();
    const features = new Set<string>();
    for (const scenario of recipe.request.scenarios) {
      if (features.has(scenario.feature.id)) issues.push("Recipe feature IDs must be unique.");
      if (scenario.requires !== undefined && !features.has(scenario.requires))
        issues.push("A recipe dependency must identify an earlier feature.");
      features.add(scenario.feature.id);
      for (const assertion of scenario.feature.assertions) {
        const key = JSON.stringify([scenario.feature.id, assertion.id]);
        if (assertions.has(key)) issues.push("Assertion IDs must be unique within their feature.");
        assertions.add(key);
        if (!assertion.selector.name && !assertion.selector.automationId)
          issues.push("Recipe assertions must identify a named or automated control.");
      }
    }
    for (const check of recipe.checks)
      if (!assertions.has(JSON.stringify([check.featureId, check.assertionId])))
        issues.push("Every saved recipe check must identify a declared UI assertion.");
    if (assertions.size !== recipe.checks.length)
      issues.push("Every declared recipe assertion must have exactly one saved check.");
    const scenarioByFeature = new Map<string, string>();
    for (const check of recipe.checks) {
      const scenario = scenarioByFeature.get(check.featureId);
      if (scenario !== undefined && scenario !== check.scenarioId)
        issues.push("Checks of one recipe feature must identify the same saved scenario.");
      scenarioByFeature.set(check.featureId, check.scenarioId);
    }
  }
  return issues;
}
