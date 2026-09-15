import { type Static, type TProperties, Type } from "@sinclair/typebox";
import {
  EntityIdSchema,
  GitObjectIdSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
} from "./common.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const path = Type.String({ minLength: 1, maxLength: 4_096 });
const ids = Type.Array(EntityIdSchema, { uniqueItems: true });

export const maximumInvestigationSourceChunkBytes = 65_536;
export const InvestigationPrDiffChunkDescriptorSchema = object({
  id: EntityIdSchema,
  path,
  kind: Type.Union([Type.Literal("diff"), Type.Literal("base"), Type.Literal("head")]),
  ordinal: NonNegativeIntegerSchema,
  encoding: Type.Union([Type.Literal("utf8"), Type.Literal("base64")]),
  contentDigest: Sha256Schema,
  byteLength: Type.Integer({ minimum: 0, maximum: maximumInvestigationSourceChunkBytes }),
});
export type InvestigationPrDiffChunkDescriptor = Static<
  typeof InvestigationPrDiffChunkDescriptorSchema
>;
export const InvestigationPrDiffChunkV1Schema = object({
  ...InvestigationPrDiffChunkDescriptorSchema.properties,
  content: Type.String({ maxLength: maximumInvestigationSourceChunkBytes }),
});
export type InvestigationPrDiffChunkV1 = Static<typeof InvestigationPrDiffChunkV1Schema>;
export const InvestigationPrDiffManifestV1Schema = object({
  schemaVersion: Type.Literal("InvestigationPrDiffManifestV1"),
  subjectRef: EntityIdSchema,
  baseSha: GitObjectIdSchema,
  headSha: GitObjectIdSchema,
  mergeBaseSha: GitObjectIdSchema,
  files: Type.Array(
    object({
      path,
      previousPath: Type.Null(),
      status: Type.Union([
        Type.Literal("added"),
        Type.Literal("modified"),
        Type.Literal("deleted"),
      ]),
      chunkIds: Type.Array(EntityIdSchema, { minItems: 1, uniqueItems: true }),
    }),
  ),
  chunks: Type.Array(InvestigationPrDiffChunkDescriptorSchema),
  digest: Sha256Schema,
});
export type InvestigationPrDiffManifestV1 = Static<typeof InvestigationPrDiffManifestV1Schema>;
export const InvestigationSourceCoverageSchema = object({
  manifest: InvestigationPrDiffManifestV1Schema,
  brokeredUnitIds: ids,
});
export type InvestigationSourceCoverage = Static<typeof InvestigationSourceCoverageSchema>;

export function investigationPrDiffManifestDigestPayload(
  manifest: InvestigationPrDiffManifestV1,
): Omit<InvestigationPrDiffManifestV1, "digest"> {
  const { digest: _digest, ...payload } = manifest;
  return payload;
}

export interface InvestigationSourceSemanticIssue {
  path: string;
  code: string;
  message: string;
}
export interface InvestigationSourceSemanticValidation {
  valid: boolean;
  errors: InvestigationSourceSemanticIssue[];
}

/** Checks the complete file/chunk graph after structural validation; trusted callers also verify its canonical SHA-256. */
export function validateInvestigationPrDiffManifest(
  manifest: InvestigationPrDiffManifestV1,
  subject?: { id: string; kind: string; baseSha?: string; headSha?: string },
): InvestigationSourceSemanticValidation {
  const errors: InvestigationSourceSemanticIssue[] = [];
  const add = (path: string, code: string, message: string) => {
    errors.push({ path, code, message });
  };
  if (
    subject !== undefined &&
    (subject.kind !== "original_pr" ||
      subject.id !== manifest.subjectRef ||
      subject.baseSha !== manifest.baseSha ||
      subject.headSha !== manifest.headSha)
  )
    add(
      "/subjectRef",
      "SOURCE_MANIFEST_BINDING_MISMATCH",
      "The manifest must preserve the exact original PR subject and base/head pair.",
    );
  const validPath = (value: string) => {
    if (/^[A-Za-z]:/u.test(value) || value.startsWith("/") || value.includes("\\")) return false;
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code < 32 || code === 127) return false;
    }
    return value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..");
  };
  const files = new Map<string, InvestigationPrDiffManifestV1["files"][number]>();
  const referencedChunks = new Set<string>();
  const chunkFile = new Map<string, string>();
  for (const [index, file] of manifest.files.entries()) {
    const key = file.path.toLowerCase();
    if (!validPath(file.path))
      add(
        `/files/${index}/path`,
        "UNSAFE_SOURCE_PATH",
        "Source paths must remain repository-relative and unambiguous on Windows.",
      );
    if (files.has(key))
      add(
        `/files/${index}/path`,
        "DUPLICATE_SOURCE_PATH",
        "Each changed path must be recorded exactly once, including case-insensitive aliases.",
      );
    files.set(key, file);
    for (const id of file.chunkIds) {
      if (referencedChunks.has(id))
        add(
          `/files/${index}/chunkIds`,
          "DUPLICATE_SOURCE_CHUNK_REFERENCE",
          "A chunk must belong to exactly one changed file.",
        );
      referencedChunks.add(id);
      chunkFile.set(id, file.path);
    }
  }
  const chunks = new Map<string, InvestigationPrDiffChunkDescriptor>();
  const streams = new Map<string, { ordinals: Set<number>; encoding: string }>();
  const kinds = new Map<string, Set<InvestigationPrDiffChunkDescriptor["kind"]>>();
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (chunks.has(chunk.id))
      add(
        `/chunks/${index}/id`,
        "DUPLICATE_SOURCE_CHUNK",
        "Source chunk IDs must be unique across the complete manifest.",
      );
    chunks.set(chunk.id, chunk);
    if (
      !validPath(chunk.path) ||
      chunkFile.get(chunk.id) !== chunk.path ||
      !files.has(chunk.path.toLowerCase())
    )
      add(
        `/chunks/${index}/path`,
        "SOURCE_CHUNK_FILE_MISMATCH",
        "Each descriptor must be referenced under its exact changed file path.",
      );
    const streamId = JSON.stringify([chunk.path, chunk.kind]);
    const stream = streams.get(streamId) ?? {
      ordinals: new Set<number>(),
      encoding: chunk.encoding,
    };
    if (stream.ordinals.has(chunk.ordinal))
      add(
        `/chunks/${index}/ordinal`,
        "DUPLICATE_SOURCE_CHUNK_ORDINAL",
        "Chunk ordinals must be unique within each file and content kind.",
      );
    if (stream.encoding !== chunk.encoding)
      add(
        `/chunks/${index}/encoding`,
        "SOURCE_STREAM_ENCODING_MISMATCH",
        "A content stream must use one encoding across every chunk.",
      );
    stream.ordinals.add(chunk.ordinal);
    streams.set(streamId, stream);
    const fileKinds =
      kinds.get(chunk.path) ?? new Set<InvestigationPrDiffChunkDescriptor["kind"]>();
    fileKinds.add(chunk.kind);
    kinds.set(chunk.path, fileKinds);
  }
  if (referencedChunks.size !== chunks.size || [...referencedChunks].some((id) => !chunks.has(id)))
    add(
      "/chunks",
      "INCOMPLETE_SOURCE_CHUNK_GRAPH",
      "Every registered chunk and every file reference must be present exactly once.",
    );
  for (const [streamId, stream] of streams) {
    for (let ordinal = 0; ordinal < stream.ordinals.size; ordinal += 1) {
      if (!stream.ordinals.has(ordinal)) {
        add("/chunks", "SOURCE_CHUNK_GAP", `Content stream ${streamId} has missing ordinals.`);
        break;
      }
    }
  }
  for (const [index, file] of manifest.files.entries()) {
    const expected =
      file.status === "added"
        ? ["diff", "head"]
        : file.status === "deleted"
          ? ["diff", "base"]
          : ["diff", "base", "head"];
    const present = kinds.get(file.path) ?? new Set<string>();
    if (present.size !== expected.length || expected.some((kind) => !present.has(kind)))
      add(
        `/files/${index}/chunkIds`,
        "SOURCE_CONTENT_MISSING",
        "Changed files require complete diff and all applicable base/head content streams.",
      );
  }
  return { valid: errors.length === 0, errors };
}

export function validateInvestigationSourceCoverage(
  coverage: InvestigationSourceCoverage,
  subject?: { id: string; kind: string; baseSha?: string; headSha?: string },
): InvestigationSourceSemanticValidation {
  const result = validateInvestigationPrDiffManifest(coverage.manifest, subject);
  const known = new Set(coverage.manifest.chunks.map((chunk) => chunk.id));
  if (
    new Set(coverage.brokeredUnitIds).size !== coverage.brokeredUnitIds.length ||
    coverage.brokeredUnitIds.some((id) => !known.has(id))
  )
    result.errors.push({
      path: "/brokeredUnitIds",
      code: "UNKNOWN_BROKERED_SOURCE_UNIT",
      message: "Delivered source units must be unique chunk IDs from the frozen manifest.",
    });
  return { valid: result.errors.length === 0, errors: result.errors };
}
