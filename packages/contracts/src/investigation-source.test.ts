import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  type InvestigationPrDiffManifestV1,
  InvestigationPrDiffManifestV1Schema,
  InvestigationSourceCoverageSchema,
  validateInvestigationPrDiffManifest,
  validateInvestigationSourceCoverage,
} from "./investigation-source.js";

function manifest(fileCount = 1): InvestigationPrDiffManifestV1 {
  const files: InvestigationPrDiffManifestV1["files"] = [];
  const chunks: InvestigationPrDiffManifestV1["chunks"] = [];
  for (let index = 0; index < fileCount; index += 1) {
    const path = `src/module-${index}.ts`;
    const ids: string[] = [];
    for (const kind of ["diff", "base", "head"] as const) {
      const id = `chunk-${index}-${kind}`;
      chunks.push({
        id,
        path,
        kind,
        ordinal: 0,
        encoding: "utf8",
        contentDigest: "a".repeat(64),
        byteLength: 16,
      });
      ids.push(id);
    }
    files.push({ path, previousPath: null, status: "modified", chunkIds: ids });
  }
  return {
    schemaVersion: "InvestigationPrDiffManifestV1",
    subjectRef: "original-pr",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    mergeBaseSha: "d".repeat(40),
    files,
    chunks,
    digest: "e".repeat(64),
  };
}

function reject(value: InvestigationPrDiffManifestV1, code: string): void {
  expect(Value.Check(InvestigationPrDiffManifestV1Schema, value)).toBe(true);
  expect(validateInvestigationPrDiffManifest(value).errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ code })]),
  );
}

describe("complete PR source manifests", () => {
  it("preserves every diff, base, and head stream across more than one hundred files", () => {
    const value = manifest(151);
    expect(value.files).toHaveLength(151);
    expect(value.chunks).toHaveLength(453);
    expect(Value.Check(InvestigationPrDiffManifestV1Schema, value)).toBe(true);
    expect(
      validateInvestigationPrDiffManifest(value, {
        id: value.subjectRef,
        kind: "original_pr",
        baseSha: value.baseSha,
        headSha: value.headSha,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects silently omitted head content even when remaining references agree", () => {
    const value = manifest();
    value.chunks = value.chunks.filter((chunk) => chunk.kind !== "head");
    value.files[0]!.chunkIds = value.chunks.map((chunk) => chunk.id);
    reject(value, "SOURCE_CONTENT_MISSING");
  });

  it("rejects missing descriptors and chunk references owned by another path", () => {
    const value = manifest(2);
    value.chunks[0]!.path = value.files[1]!.path;
    reject(value, "SOURCE_CHUNK_FILE_MISMATCH");
    value.chunks.pop();
    reject(value, "INCOMPLETE_SOURCE_CHUNK_GRAPH");
  });

  it("requires contiguous ordinals separately for every path and content kind", () => {
    const value = manifest();
    value.chunks[1]!.ordinal = 1;
    reject(value, "SOURCE_CHUNK_GAP");
  });

  it("rejects mixed encodings within a single source stream", () => {
    const value = manifest();
    value.chunks.push({
      ...value.chunks[0]!,
      id: "chunk-diff-continued",
      ordinal: 1,
      encoding: "base64",
    });
    value.files[0]!.chunkIds.push("chunk-diff-continued");
    reject(value, "SOURCE_STREAM_ENCODING_MISMATCH");
  });

  it("does not alias two Windows paths or permit repository traversal", () => {
    const value = manifest(2);
    value.files[1]!.path = value.files[0]!.path.toUpperCase();
    reject(value, "DUPLICATE_SOURCE_PATH");
    value.files[0]!.path = "../outside.ts";
    reject(value, "UNSAFE_SOURCE_PATH");
  });

  it("does not reuse a valid manifest against another PR head", () => {
    const value = manifest();
    const result = validateInvestigationPrDiffManifest(value, {
      id: value.subjectRef,
      kind: "original_pr",
      baseSha: value.baseSha,
      headSha: "f".repeat(40),
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SOURCE_MANIFEST_BINDING_MISMATCH" }),
      ]),
    );
  });

  it("admits only frozen chunk IDs as trusted delivered source units", () => {
    const value = manifest();
    const sourceCoverage = { manifest: value, brokeredUnitIds: [value.chunks[0]!.id] };
    expect(Value.Check(InvestigationSourceCoverageSchema, sourceCoverage)).toBe(true);
    expect(validateInvestigationSourceCoverage(sourceCoverage)).toEqual({
      valid: true,
      errors: [],
    });
    sourceCoverage.brokeredUnitIds.push("model-claimed-unit");
    expect(validateInvestigationSourceCoverage(sourceCoverage).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_BROKERED_SOURCE_UNIT" })]),
    );
  });
});
