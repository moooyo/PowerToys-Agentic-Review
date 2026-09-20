import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  ModelOutputValidationError,
  type ModelOutputValidationRule,
  modelOutputSchemaError,
  safeModelOutputValidationIssue,
  safeModelOutputValidationMessage,
} from "./model-output-diagnostics.js";

describe("model output validation diagnostics", () => {
  it("retains the failed rule and record location without retaining rejected values", () => {
    const error = new ModelOutputValidationError("reference_outside_batch", [
      "analysis",
      "candidates",
      2,
      "findingId",
    ]);
    expect(error).toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      rule: "reference_outside_batch",
      paths: ["/analysis/candidates/2/findingId"],
    });
    expect(error.message).toContain("[reference_outside_batch]");
    expect(error.message).toContain("/analysis/candidates/2/findingId");
  });

  it("redacts unknown JSON keys and omits schema messages and rejected values", () => {
    const schema = Type.Object(
      { analysis: Type.Object({ summary: Type.String() }, { additionalProperties: false }) },
      { additionalProperties: false },
    );
    const error = modelOutputSchemaError(
      schema,
      { analysis: { summary: 12345, "private-token-in-key": "private-token-in-value" } },
      "delta",
    );
    expect(error.rule).toBe("delta_schema");
    expect(error.paths).toContain("/analysis/summary");
    expect(error.paths).toContain("/analysis/*");
    expect(error.message).not.toContain("private-token");
    expect(error.message).not.toContain("12345");
    expect(Object.keys(error)).not.toContain("value");
  });

  it.each(["delta", "round", "response"] as const)(
    "distinguishes the %s schema validation stage",
    (stage) => {
      const error = modelOutputSchemaError(Type.String(), {}, stage);
      expect(error.rule).toBe(`${stage}_schema`);
      expect(error.paths).toEqual(["/"]);
    },
  );

  it("redacts numeric object keys instead of mistaking them for array indexes", () => {
    const schema = Type.Object({ summary: Type.String() }, { additionalProperties: false });
    const error = modelOutputSchemaError(schema, { summary: "ok", "123456": "value" }, "delta");
    expect(error.paths).toEqual(["/*"]);
    expect(error.message).not.toContain("123456");
    const direct = new ModelOutputValidationError("reference_outside_batch", "/analysis/123456");
    expect(direct.paths).toEqual(["/analysis/*"]);
  });

  it("bounds and deduplicates locations from a rejected schema", () => {
    const schema = Type.Array(Type.Object({ id: Type.String() }));
    const error = modelOutputSchemaError(
      schema,
      Array.from({ length: 100 }, () => ({ id: false })),
      "delta",
    );
    expect(error.paths).toHaveLength(8);
    expect(error.paths[0]).toBe("/0/id");
    const repeated = new ModelOutputValidationError(
      "delta_schema",
      ["analysis"],
      ["/analysis", "/analysis"],
    );
    expect(repeated.paths).toEqual(["/analysis"]);
  });

  it("sanitizes unsafe path segments and bounds their length", () => {
    const error = new ModelOutputValidationError("response_schema", [
      "analysis",
      "private/path",
      "secret~1key",
      -1,
      Number.MAX_SAFE_INTEGER,
      ...Array.from({ length: 20 }, () => "summary"),
    ]);
    expect(error.paths[0]).toMatch(/^\/analysis\/\*\/\*\/\*\/\*\/summary/);
    expect(error.paths[0]?.split("/")).toHaveLength(18);
    expect(error.message).not.toContain("private");
    expect(error.message).not.toContain("secret");
  });

  it("does not accept forged diagnostics or a modified Error message", () => {
    const error = new ModelOutputValidationError("delta_binding", ["taskId"]);
    const expected = error.message;
    error.message = "private-token-from-model";
    expect(safeModelOutputValidationMessage(error)).toBe(expected);
    expect(
      safeModelOutputValidationMessage({
        code: "MODEL_OUTPUT_INVALID",
        message: "private-token-from-model",
        rule: "delta_binding",
      }),
    ).toBeNull();
    expect(
      safeModelOutputValidationMessage(Object.create(ModelOutputValidationError.prototype)),
    ).toBeNull();
  });

  it("returns detached branded issue metadata instead of mutable Error properties", () => {
    const error = new ModelOutputValidationError("reference_outside_batch", [
      "analysis",
      "candidates",
      0,
      "findingId",
    ]);
    Object.assign(error, { rule: "private-token", paths: ["private-token"] });
    const issue = safeModelOutputValidationIssue(error);
    expect(issue).toEqual({
      rule: "reference_outside_batch",
      paths: ["/analysis/candidates/0/findingId"],
    });
    issue!.paths.push("private-token");
    expect(safeModelOutputValidationIssue(error)?.paths).toEqual([
      "/analysis/candidates/0/findingId",
    ]);
    expect(
      safeModelOutputValidationIssue({ rule: "reference_outside_batch", paths: [] }),
    ).toBeNull();
  });

  it("uses a controlled fallback when a JavaScript caller provides an unknown rule", () => {
    const error = new ModelOutputValidationError("private-token" as ModelOutputValidationRule);
    expect(error.rule).toBe("response_schema");
    expect(error.message).not.toContain("private-token");
  });
});
