import type { DatabaseSync } from "node:sqlite";
import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson } from "../scheduling/canonical-json.js";
import { EvaluationManagementError } from "./evaluation-management.js";
import {
  type EvaluationResultSelection,
  readEvaluationResultSelectionInTransaction,
} from "./evaluation-result-selection.js";
import {
  type EvidenceAssetOperationMap,
  EvidenceStorageError,
  type EvidenceStorageOptions,
  handleEvidenceAssetRequest,
} from "./evidence-assets.js";
import { assertRepositoryPermission } from "./operator-access.js";

type ResultInput = C.EvaluationCellResultReadQuery & { readonly actor: C.OperatorPrincipal };
type AssetInput = C.EvaluationResultEvidenceAssetQuery & { readonly actor: C.OperatorPrincipal };
export interface EvaluationResultEvidenceChunk {
  readonly binding: C.EvaluationEvidenceBinding;
  readonly manifest: C.EvidenceAssetManifest;
  readonly offset: number;
  readonly base64: string;
  readonly eof: boolean;
}
export interface EvaluationEvidenceOperationMap {
  listEvaluationResultEvidence: { input: ResultInput; output: C.EvaluationResultEvidenceListV1 };
  getEvaluationResultEvidenceAsset: {
    input: AssetInput;
    output: C.EvaluationResultEvidenceAssetV1;
  };
  readEvaluationResultEvidenceChunk: {
    input: AssetInput & { readonly offset: number; readonly maximumBytes?: number };
    output: EvaluationResultEvidenceChunk;
  };
}
export type EvaluationEvidenceOperation = keyof EvaluationEvidenceOperationMap;
export type EvaluationEvidenceRequest = {
  [K in EvaluationEvidenceOperation]: {
    readonly operation: K;
    readonly input: EvaluationEvidenceOperationMap[K]["input"];
  };
}[EvaluationEvidenceOperation];

const strict = { additionalProperties: false } as const;
const resultScope = {
  ...C.EvaluationCellResultReadQuerySchema.properties,
  actor: C.OperatorPrincipalSchema,
};
const assetScope = {
  ...C.EvaluationResultEvidenceAssetQuerySchema.properties,
  actor: C.OperatorPrincipalSchema,
};
const schemas = {
  listEvaluationResultEvidence: Type.Object(resultScope, strict),
  getEvaluationResultEvidenceAsset: Type.Object(assetScope, strict),
  readEvaluationResultEvidenceChunk: Type.Object(
    {
      ...assetScope,
      offset: Type.Integer({ minimum: 0, maximum: C.maximumEvidenceAssetBytes }),
      maximumBytes: Type.Optional(
        Type.Integer({ minimum: 1, maximum: C.maximumEvidenceChunkBytes }),
      ),
    },
    strict,
  ),
};
export function isEvaluationEvidenceOperation(
  operation: string,
): operation is EvaluationEvidenceOperation {
  return Object.hasOwn(schemas, operation);
}
function missing(): never {
  throw new EvaluationManagementError(
    "PLATFORM_NOT_FOUND",
    "The evidence asset was not found in this evaluation result.",
  );
}
function corrupt(): never {
  throw new EvaluationManagementError(
    "PLATFORM_CORRUPT",
    "The evaluation evidence binding is inconsistent.",
  );
}
function invalid(): never {
  throw new EvaluationManagementError(
    "PLATFORM_INVALID",
    "The evaluation evidence request is invalid.",
  );
}
function transaction<T>(database: DatabaseSync, read: () => T): T {
  if (database.isTransaction) return read();
  database.exec("BEGIN");
  try {
    const value = read();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
function resultQuery(input: ResultInput): C.EvaluationCellResultReadQuery {
  return {
    repositoryId: input.repositoryId,
    evaluationId: input.evaluationId,
    cellId: input.cellId,
    resultId: input.resultId,
  };
}
function bindingFor(selected: EvaluationResultSelection): C.EvaluationEvidenceBinding {
  const row = selected.row;
  return {
    repositoryId: row.repositoryId,
    evaluationId: row.evaluationId,
    cellId: row.cellId,
    resultId: row.id,
    resultDigest: row.resultDigest,
    runId: row.runId,
    requestId: row.requestId,
    jobId: row.jobId,
    runAttemptId: row.runAttemptId,
    profileVersionId: row.profileVersionId,
    revisionKey: row.revisionKey,
    planDigest: row.planDigest,
  };
}
function referencesFor(selected: EvaluationResultSelection): Map<string, string[]> {
  const references = new Map<string, Set<string>>();
  for (const check of selected.result.report.checks) {
    for (const assetId of check.evidenceIds) {
      const checks = references.get(assetId) ?? new Set<string>();
      checks.add(check.id);
      references.set(assetId, checks);
    }
  }
  if (references.size > C.maximumEvaluationResultEvidenceAssetCount) corrupt();
  return new Map(
    [...references]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([assetId, checks]) => [assetId, [...checks].sort()]),
  );
}
function storageOptions(options: EvidenceStorageOptions | undefined): EvidenceStorageOptions {
  if (options === undefined)
    throw new EvidenceStorageError("EVIDENCE_UNAVAILABLE", "Evidence storage is not configured.");
  return options;
}
function manifestFor(
  database: DatabaseSync,
  binding: C.EvaluationEvidenceBinding,
  assetId: string,
  checkIds: string[],
  now: string,
  options: EvidenceStorageOptions | undefined,
): C.EvidenceAssetManifest | null {
  const manifest = handleEvidenceAssetRequest(
    database,
    {
      operation: "getEvidenceAsset",
      input: {
        repositoryId: binding.repositoryId,
        runId: binding.runId,
        jobId: binding.jobId,
        runAttemptId: binding.runAttemptId,
        assetId,
      },
    },
    now,
    storageOptions(options),
  ) as EvidenceAssetOperationMap["getEvidenceAsset"]["output"];
  if (
    manifest !== null &&
    C.getEvaluationResultEvidenceAssetIssues({
      schemaVersion: "EvaluationResultEvidenceAssetV1",
      binding,
      assetId,
      checkIds,
      manifest,
    }).length
  )
    corrupt();
  return manifest;
}

/** Current read permission and exact immutable result membership are rechecked for every chunk. */
export function handleEvaluationEvidenceRequest(
  database: DatabaseSync,
  request: EvaluationEvidenceRequest,
  now: string,
  administrators: readonly C.OperatorPrincipal[],
  options?: EvidenceStorageOptions,
): EvaluationEvidenceOperationMap[EvaluationEvidenceOperation]["output"] {
  if (
    !request ||
    typeof request !== "object" ||
    Object.keys(request).some((key) => key !== "operation" && key !== "input") ||
    !isEvaluationEvidenceOperation(request.operation) ||
    !Value.Check(schemas[request.operation], request.input) ||
    typeof now !== "string" ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    invalid();
  const query = resultQuery(request.input);
  if (
    C.getEvaluationCellResultReadQueryIssues(query).length ||
    (request.operation !== "listEvaluationResultEvidence" &&
      C.getEvaluationResultEvidenceAssetQueryIssues({ ...query, assetId: request.input.assetId })
        .length)
  )
    invalid();
  return transaction(database, () => {
    assertRepositoryPermission(
      database,
      request.input.actor,
      query.repositoryId,
      "read",
      administrators,
    );
    const selected = readEvaluationResultSelectionInTransaction(database, query);
    if (selected === null) missing();
    const binding = bindingFor(selected);
    const references = referencesFor(selected);
    if (request.operation === "listEvaluationResultEvidence") {
      const value: C.EvaluationResultEvidenceListV1 = {
        schemaVersion: "EvaluationResultEvidenceListV1",
        binding,
        items: [...references].map(([assetId, checkIds]) => ({
          assetId,
          checkIds,
          manifest: manifestFor(database, binding, assetId, checkIds, now, options),
        })),
      };
      if (C.getEvaluationResultEvidenceListIssues(value).length) corrupt();
      return value;
    }
    const { assetId } = request.input;
    const checkIds = references.get(assetId);
    if (checkIds === undefined) missing();
    const manifest = manifestFor(database, binding, assetId, checkIds, now, options);
    if (manifest === null) missing();
    if (request.operation === "getEvaluationResultEvidenceAsset") {
      const value: C.EvaluationResultEvidenceAssetV1 = {
        schemaVersion: "EvaluationResultEvidenceAssetV1",
        binding,
        assetId,
        checkIds,
        manifest,
      };
      return value;
    }
    const chunk = handleEvidenceAssetRequest(
      database,
      {
        operation: "readEvidenceAssetChunk",
        input: {
          repositoryId: binding.repositoryId,
          runId: binding.runId,
          jobId: binding.jobId,
          runAttemptId: binding.runAttemptId,
          assetId,
          offset: request.input.offset,
          ...(request.input.maximumBytes === undefined
            ? {}
            : { maximumBytes: request.input.maximumBytes }),
        },
      },
      now,
      storageOptions(options),
    ) as EvidenceAssetOperationMap["readEvidenceAssetChunk"]["output"];
    if (chunk === null) missing();
    if (canonicalJson(chunk.manifest) !== canonicalJson(manifest)) corrupt();
    return { binding, ...chunk };
  });
}
