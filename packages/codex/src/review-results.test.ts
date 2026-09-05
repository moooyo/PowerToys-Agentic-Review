import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  IssueTriageV1ModelOutputSchema,
  IssueTriageV1Schema,
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV1Schema,
} from "./review-results.js";

const supportedStructuredOutputKeywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "const",
  "enum",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "description",
  "$defs",
  "$ref",
]);

const validPrReviewPlan = {
  schemaVersion: "PrReviewPlanV1",
  summary: "The change is mostly sound but has one correctness issue.",
  assessment: "request_changes",
  findings: [
    {
      findingId: "finding-1",
      priority: 1,
      title: "Reject an expired lease before accepting the result",
      body: "The completion path does not compare the server time with the lease expiry.",
      path: "apps/server/src/lease-service.ts",
      line: 47,
      endLine: 52,
      confidence: 0.98,
    },
  ],
  requestedRecipeIds: ["server-unit-tests"],
} as const;

const validIssueTriage = {
  schemaVersion: "IssueTriageV1",
  summary: "The report describes a reproducible crash in the launcher.",
  category: "bug",
  priority: 1,
  confidence: 0.91,
  suggestedLabels: ["Product-Launcher", "Issue-Bug"],
  missingInformation: ["Provide the Windows build number."],
  duplicateCandidates: [{ number: 12345, reason: "The stack trace has the same top frame." }],
  requestedRecipeIds: ["launcher-static-analysis"],
} as const;

describe("PrReviewPlanV1Schema", () => {
  it("accepts a bounded review plan with repository-relative locations", () => {
    expect(Value.Check(PrReviewPlanV1Schema, validPrReviewPlan)).toBe(true);
  });

  it("requires an explicit nullable end line for every finding", () => {
    const findingWithoutEndLine: Record<string, unknown> = {
      ...validPrReviewPlan.findings[0],
    };
    delete findingWithoutEndLine.endLine;

    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [findingWithoutEndLine],
      }),
    ).toBe(false);
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], endLine: null }],
      }),
    ).toBe(true);
  });

  it("rejects additional fields at the root and finding levels", () => {
    expect(Value.Check(PrReviewPlanV1Schema, { ...validPrReviewPlan, command: "build.cmd" })).toBe(
      false,
    );
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], executable: "cmd.exe" }],
      }),
    ).toBe(false);
  });

  it("rejects absolute paths, invalid lines, and duplicate recipe IDs", () => {
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], path: "C:\\repo\\file.ts" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], line: 0 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        requestedRecipeIds: ["server-unit-tests", "server-unit-tests"],
      }),
    ).toBe(false);
  });

  it.each([
    "/src/file.ts",
    "C:/repo/file.ts",
    "c:relative.ts",
    "\\\\server\\share\\file.ts",
    "../file.ts",
    "src/../file.ts",
    "src/..",
    "src/file\u0000.ts",
    "src/file\r.ts",
    "src/file\n.ts",
    "src/file\u001f.ts",
  ])("rejects unsafe repository paths at the authoritative runtime boundary: %j", (path) => {
    expect(
      Value.Check(PrReviewPlanV1Schema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], path }],
      }),
    ).toBe(false);
  });
});

describe("IssueTriageV1Schema", () => {
  it("accepts a bounded issue triage result", () => {
    expect(Value.Check(IssueTriageV1Schema, validIssueTriage)).toBe(true);
  });

  it("rejects unknown fields and executable recipe requests", () => {
    expect(
      Value.Check(IssueTriageV1Schema, {
        ...validIssueTriage,
        privateNotes: "not part of the protocol",
      }),
    ).toBe(false);
    expect(
      Value.Check(IssueTriageV1Schema, {
        ...validIssueTriage,
        requestedRecipeIds: ["powershell -Command build"],
      }),
    ).toBe(false);
  });

  it("rejects unbounded collection growth", () => {
    expect(
      Value.Check(IssueTriageV1Schema, {
        ...validIssueTriage,
        missingInformation: Array.from({ length: 33 }, (_, index) => `Question ${index}`),
      }),
    ).toBe(false);
  });
});

describe("model output schemas", () => {
  it.each([
    ["PR review", PrReviewPlanV1ModelOutputSchema],
    ["issue triage", IssueTriageV1ModelOutputSchema],
  ] as const)("keeps the %s schema within the Structured Outputs subset", (_name, schema) => {
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("anyOf");
    assertStructuredOutputSchema(schema, "$");
  });

  it.each([
    "src/file.ts",
    ".github/workflows/ci.yml",
    "docs with spaces/guide.md",
    "src/\u4e2d\u6587.ts",
  ])("accepts portable repository paths in model output: %s", (path) => {
    expect(
      Value.Check(PrReviewPlanV1ModelOutputSchema, {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], path }],
      }),
    ).toBe(true);
  });

  it.each(["../file.ts", "src/../file.ts", "C:/repo/file.ts"])(
    "still rejects unsafe model output with the authoritative runtime schema: %s",
    (path) => {
      const result = {
        ...validPrReviewPlan,
        findings: [{ ...validPrReviewPlan.findings[0], path }],
      };
      expect(Value.Check(PrReviewPlanV1ModelOutputSchema, result)).toBe(true);
      expect(Value.Check(PrReviewPlanV1Schema, result)).toBe(false);
    },
  );
});

function assertStructuredOutputSchema(schema: unknown, path: string): void {
  expect(schema, `${path} must be a schema object`).toBeTypeOf("object");
  expect(schema, `${path} must not be null`).not.toBeNull();
  expect(Array.isArray(schema), `${path} must not be an array`).toBe(false);
  const record = schema as Record<string, unknown>;
  for (const keyword of Object.keys(record)) {
    expect(
      supportedStructuredOutputKeywords.has(keyword),
      `${path} uses unsupported keyword ${keyword}`,
    ).toBe(true);
  }

  if (record.pattern !== undefined) {
    expect(record.pattern, `${path}.pattern`).toBeTypeOf("string");
    const pattern = record.pattern as string;
    expect(pattern, `${path}.pattern must not use lookaround`).not.toMatch(/\(\?(?:[=!]|<[=!])/u);
    expect(pattern, `${path}.pattern must not use backreferences`).not.toMatch(/\\(?:[1-9]|k<)/u);
    expect(() => new RegExp(pattern, "u")).not.toThrow();
  }

  if (record.type === "object") {
    expect(record.additionalProperties, `${path}.additionalProperties`).toBe(false);
    const properties = record.properties as Record<string, unknown>;
    expect(properties, `${path}.properties`).toBeTypeOf("object");
    expect(record.required, `${path}.required`).toEqual(Object.keys(properties));
    for (const [name, propertySchema] of Object.entries(properties)) {
      assertStructuredOutputSchema(propertySchema, `${path}.properties.${name}`);
    }
  }
  if (record.items !== undefined) {
    assertStructuredOutputSchema(record.items, `${path}.items`);
  }
  if (record.anyOf !== undefined) {
    expect(Array.isArray(record.anyOf), `${path}.anyOf`).toBe(true);
    for (const [index, memberSchema] of (record.anyOf as unknown[]).entries()) {
      assertStructuredOutputSchema(memberSchema, `${path}.anyOf[${index}]`);
    }
  }
  if (record.$defs !== undefined) {
    for (const [name, definition] of Object.entries(record.$defs as Record<string, unknown>)) {
      assertStructuredOutputSchema(definition, `${path}.$defs.${name}`);
    }
  }
}
