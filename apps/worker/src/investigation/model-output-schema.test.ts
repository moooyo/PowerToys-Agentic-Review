import { InvestigationModelEditsV1Schema } from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createInvestigationModelOutputSchema } from "./model-output-schema.js";
import { InvestigationModelTurnDeltaV1Schema } from "./model-turn-projection.js";

describe("strict model output schema projection", () => {
  it.each([InvestigationModelEditsV1Schema, InvestigationModelTurnDeltaV1Schema])(
    "exports the actual investigation model contracts without worker-only constraints",
    (schema) => {
      const before = JSON.stringify(schema);
      const projected = createInvestigationModelOutputSchema(schema);
      expect(projected.type).toBe("object");
      expect(projected.additionalProperties).toBe(false);
      const output = JSON.stringify(projected);
      expect(output).not.toContain('"uniqueItems"');
      expect(output).not.toContain('"minLength"');
      expect(output).not.toContain('"maxLength"');
      expect(JSON.stringify(schema)).toBe(before);
    },
  );

  it("retains full runtime validation after omitting a generation-only unsupported constraint", () => {
    const authoritative = Type.Object(
      { ids: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }) },
      { additionalProperties: false },
    );
    const projected = createInvestigationModelOutputSchema(authoritative);
    expect(projected.properties).toMatchObject({
      ids: { type: "array", items: { type: "string" } },
    });
    expect(Value.Check(authoritative, { ids: ["one", "one"] })).toBe(false);
    expect(Value.Check(authoritative, { ids: [""] })).toBe(false);
    expect(Value.Check(authoritative, { ids: ["one", "two"] })).toBe(true);
  });

  it("retains status-specific candidate link constraints in the strict generation schema", () => {
    const projected = createInvestigationModelOutputSchema(InvestigationModelTurnDeltaV1Schema);
    const properties = projected.properties as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    const candidates = properties.analysis!.properties.candidates as {
      items: {
        anyOf: Array<{
          additionalProperties: boolean;
          required: string[];
          properties: Record<string, unknown>;
        }>;
      };
    };
    expect(candidates.items.anyOf).toHaveLength(6);
    const ordinary = candidates.items.anyOf.filter(
      (branch) => !Object.hasOwn(branch.properties, "reviewBaselineFindingRef"),
    );
    const baseline = candidates.items.anyOf.filter((branch) =>
      Object.hasOwn(branch.properties, "reviewBaselineFindingRef"),
    );
    expect(ordinary).toHaveLength(3);
    expect(baseline).toHaveLength(3);
    for (const group of [ordinary, baseline]) {
      const [retained, pendingOrWithdrawn, merged] = group;
      expect(retained!.properties).toMatchObject({
        status: { anyOf: [{ const: "confirmed" }, { const: "unresolved" }] },
        findingId: { type: "string" },
        findingVersion: { type: "integer", minimum: 1 },
        mergedIntoCandidateId: { type: "null" },
      });
      expect(retained!.properties.findingId).not.toHaveProperty("anyOf");
      expect(retained!.properties.findingVersion).not.toHaveProperty("anyOf");
      expect(pendingOrWithdrawn!.properties).toMatchObject({
        findingId: { anyOf: [{ type: "string" }, { type: "null" }] },
        mergedIntoCandidateId: { type: "null" },
      });
      expect(merged!.properties).toMatchObject({
        status: { const: "merged" },
        findingId: { anyOf: [{ type: "string" }, { type: "null" }] },
        mergedIntoCandidateId: { type: "string" },
      });
    }
    for (const branch of ordinary) {
      expect(branch.properties.discoveredRound).toMatchObject({ type: "integer", minimum: 1 });
      expect(branch.properties).not.toHaveProperty("reviewDisposition");
    }
    for (const branch of baseline) {
      expect(branch.properties.discoveredRound).toMatchObject({ const: 0 });
      expect(branch.required).toContain("reviewBaselineFindingRef");
      expect(branch.required).toContain("reviewDisposition");
      expect(branch.properties.reviewBaselineFindingRef).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["id", "version"],
      });
    }
    for (const branch of candidates.items.anyOf) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required.toSorted()).toEqual(Object.keys(branch.properties).toSorted());
    }
  });

  it("rejects optional or open objects rather than silently weakening the protocol", () => {
    expect(() =>
      createInvestigationModelOutputSchema(
        Type.Object({ value: Type.Optional(Type.String()) }, { additionalProperties: false }),
      ),
    ).toThrow("must be required");
    expect(() =>
      createInvestigationModelOutputSchema(Type.Object({ value: Type.String() })),
    ).toThrow("additionalProperties=false");
    expect(() =>
      createInvestigationModelOutputSchema(Type.Union([Type.String(), Type.Null()])),
    ).toThrow("object root");
  });

  it("keeps both existing plans and structured recipe steps strict for model generation", () => {
    const projected = createInvestigationModelOutputSchema(InvestigationModelTurnDeltaV1Schema);
    type Schema = {
      properties: Record<string, Schema>;
      items: Schema;
      anyOf: Schema[];
      required: string[];
    };
    const analysis = (projected.properties as Record<string, Schema>).analysis!;
    const plans = analysis.properties.plans!;
    const branches = plans.items.properties.steps!.items.anyOf;
    expect(branches).toHaveLength(2);
    expect(branches[0]!.properties).not.toHaveProperty("recipe");
    expect(branches[1]!.required).toContain("recipe");
    const inspect = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      const schema = value as Record<string, unknown>;
      if (schema.type === "object") {
        expect((schema.required as string[]).toSorted()).toEqual(
          Object.keys(schema.properties as object).toSorted(),
        );
        expect(schema.additionalProperties).toBe(false);
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(inspect);
        else inspect(child);
      }
    };
    inspect(plans);
  });
});
