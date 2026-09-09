import type { ValidationJobResultV1, ValidationJobResultV2 } from "@agentic-review/codex";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  decodeStoredValidationResult,
  StoredValidationResultError,
} from "./stored-validation-result.js";

function value(
  version: "ValidationJobResultV1" | "ValidationJobResultV2",
): ValidationJobResultV1 | ValidationJobResultV2 {
  const common = {
    report: {
      schemaVersion: "ValidationReportV1",
      source: "worker",
      workItemKind: "issue",
      summary: "Stored result",
      sourceState: "unknown",
      checks: [],
      reproductionConclusion: "inconclusive",
    },
    execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
    modelReview: { state: "not_requested" },
  } satisfies Omit<ValidationJobResultV2, "schemaVersion">;
  if (version === "ValidationJobResultV1") {
    return { ...common, schemaVersion: "ValidationJobResultV1" };
  }
  return { ...common, schemaVersion: "ValidationJobResultV2" };
}
describe("versioned stored validation result decoding", () => {
  it.each(["ValidationJobResultV1", "ValidationJobResultV2"] as const)(
    "preserves %s bytes, digest identity and actual schema",
    (version) => {
      const original = value(version),
        json = canonicalJson(original),
        digest = sha256(json);
      const result = decodeStoredValidationResult(version, json, digest);
      expect(result).toEqual(original);
      expect(result.schemaVersion).toBe(version);
      expect(canonicalJson(result)).toBe(json);
      expect(sha256(json)).toBe(digest);
    },
  );
  it.each([
    "version",
    "hash",
    "noncanonical",
    "duplicate",
    "null",
    "truncated",
    "extra",
    "oversize",
  ])("rejects invalid stored %s without returning a partial result", (change) => {
    const result = value("ValidationJobResultV2");
    let json: string | null = canonicalJson(result),
      schemaId = result.schemaVersion,
      digest = sha256(json);
    if (change === "version") schemaId = "ValidationJobResultV1";
    if (change === "hash") digest = "0".repeat(64);
    if (change === "noncanonical") {
      json = JSON.stringify(result, null, 2);
      digest = sha256(json);
    }
    if (change === "duplicate") {
      json = json.replace(
        '"schemaVersion":"ValidationJobResultV2"',
        '"schemaVersion":"ValidationJobResultV1","schemaVersion":"ValidationJobResultV2"',
      );
      digest = sha256(json);
    }
    if (change === "null") json = null;
    if (change === "truncated" && json !== null) {
      json = json.slice(0, -1);
      digest = sha256(json);
    }
    if (change === "extra") {
      json = canonicalJson({ ...result, trusted: true });
      digest = sha256(json);
    }
    if (change === "oversize") {
      json = `${json}${" ".repeat(2 * 1024 * 1024)}`;
      digest = sha256(json);
    }
    expect(() => decodeStoredValidationResult(schemaId, json, digest)).toThrow(
      StoredValidationResultError,
    );
  });
  it("retains V1 check-source semantics without applying the stricter V2 runner-only rule", () => {
    const original = value("ValidationJobResultV1");
    original.report.checks.push({
      id: "profile:step",
      name: "Historical model check",
      kind: "static",
      required: false,
      outcome: "not_run",
      summary: "No runner execution",
      expected: null,
      actual: null,
      evidenceIds: [],
      source: "model",
    });
    const old = canonicalJson(original);
    expect(decodeStoredValidationResult("ValidationJobResultV1", old, sha256(old))).toEqual(
      original,
    );
    const newer = canonicalJson({ ...original, schemaVersion: "ValidationJobResultV2" });
    expect(() =>
      decodeStoredValidationResult("ValidationJobResultV2", newer, sha256(newer)),
    ).toThrow(StoredValidationResultError);
  });
});
