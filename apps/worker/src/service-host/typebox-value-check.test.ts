import { Type } from "@sinclair/typebox";
import { Value as OriginalValue } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { Value as ReviewedValue } from "./typebox-value-check.js";

describe("reviewed TypeBox Value namespace", () => {
  it("uses the original Check implementation and semantics", () => {
    const schema = Type.Object({ value: Type.Integer() }, { additionalProperties: false });

    expect(ReviewedValue.Check).toBe(OriginalValue.Check);
    expect(ReviewedValue.Check(schema, { value: 1 })).toBe(true);
    expect(ReviewedValue.Check(schema, { value: 1.5 })).toBe(false);
    expect(ReviewedValue.Check(schema, { value: 1, extra: true })).toBe(false);
  });
});
