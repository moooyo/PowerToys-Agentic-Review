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
    expect(candidates.items.anyOf).toHaveLength(3);
    const [retained, pendingOrWithdrawn, merged] = candidates.items.anyOf;
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
});
