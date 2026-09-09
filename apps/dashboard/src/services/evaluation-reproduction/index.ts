import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import type { EvaluationBatchScope } from "../evaluation-batches";
import {
  EvaluationBatchScopeSchema,
  evaluationBatchMatch,
  evaluationBatchRequest,
  evaluationBatchResponse,
} from "../evaluation-batches/validation";
import type { EvaluationSourceScope } from "../evaluations";
import { EvaluationSourceScopeSchema } from "../evaluations/validation";
import { ReviewControlProtocolError } from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";

export interface EvaluationReproductionCellScope extends EvaluationBatchScope {
  readonly cellId: string;
}
export interface EvaluationReproductionAdapter {
  readonly mode: "connected";
  preview(
    repositoryId: string,
    request: C.EvaluationReproductionPreviewRequest,
    signal?: AbortSignal,
  ): Promise<C.EvaluationReproductionPreviewV1>;
  getSource(
    scope: EvaluationSourceScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationReproductionSourceDefinitionReadV1>;
  getPlan(
    scope: EvaluationBatchScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationReproductionPlanV1>;
  getCell(
    scope: EvaluationReproductionCellScope,
    signal?: AbortSignal,
  ): Promise<C.EvaluationReproductionCellDetailV1>;
}
const cellScopeSchema = Type.Object(
  { ...EvaluationBatchScopeSchema.properties, cellId: C.EntityIdSchema },
  { additionalProperties: false },
);
const readLimit = C.maximumEvaluationReproductionReadUtf8Bytes;
const planLimit = C.maximumEvaluationReproductionManifestUtf8Bytes + 8 * 1024;
const root = (repositoryId: string) => `/api/v1/operator/repositories/${repositoryId}`;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Reproduction metadata must contain JSON values.");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

async function verifyDigest(
  value: unknown,
  expected: string,
  operation: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let digest: string;
  try {
    const bytes = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value)),
    );
    digest = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    signal?.throwIfAborted();
    throw new ReviewControlProtocolError(
      operation,
      "The reproduction metadata digest could not be verified.",
    );
  }
  signal?.throwIfAborted();
  evaluationBatchMatch(digest === expected, operation);
}

export class HttpEvaluationReproductionAdapter implements EvaluationReproductionAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async preview(
    repositoryId: string,
    input: C.EvaluationReproductionPreviewRequest,
    signal?: AbortSignal,
  ) {
    const operation = "preview evaluation reproduction mapping";
    const scope = evaluationBatchRequest(
      Type.Object({ repositoryId: C.EntityIdSchema }, { additionalProperties: false }),
      { repositoryId },
      operation,
    );
    const request = evaluationBatchRequest(
      C.EvaluationReproductionPreviewRequestSchema,
      input,
      operation,
      C.getEvaluationReproductionPreviewRequestIssues,
      C.maximumEvaluationReproductionRequestUtf8Bytes,
    );
    const value = evaluationBatchResponse(
      C.EvaluationReproductionPreviewV1Schema,
      await this.client.post(
        `${root(scope.repositoryId)}/evaluation-reproduction/preview`,
        operation,
        request,
        { ...(signal ? { signal } : {}) },
      ),
      operation,
      C.getEvaluationReproductionPreviewIssues,
      2 * 1024 * 1024,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId &&
        value.sourceId === request.sourceId &&
        value.baseline.profileVersionId === request.baselineProfileVersionId &&
        value.candidate.profileVersionId === request.candidateProfileVersionId,
      operation,
    );
    signal?.throwIfAborted();
    return value;
  }

  async getSource(input: EvaluationSourceScope, signal?: AbortSignal) {
    const operation = "read evaluation source reproduction";
    const scope = evaluationBatchRequest(EvaluationSourceScopeSchema, input, operation);
    const value = evaluationBatchResponse(
      C.EvaluationReproductionSourceDefinitionReadV1Schema,
      await this.client.get(
        `${root(scope.repositoryId)}/evaluation-sources/${scope.sourceId}/reproduction`,
        operation,
        { ...(signal ? { signal } : {}), maxResponseBytes: readLimit },
      ),
      operation,
      C.getEvaluationReproductionSourceDefinitionReadIssues,
      readLimit,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId && value.sourceId === scope.sourceId,
      operation,
    );
    if (value.sourceDefinition && value.sourceDefinitionSha256) {
      await verifyDigest(value.sourceDefinition, value.sourceDefinitionSha256, operation, signal);
      await verifyDigest(
        value.sourceDefinition.binding,
        value.sourceDefinition.bindingDigest,
        operation,
        signal,
      );
    }
    signal?.throwIfAborted();
    return value;
  }

  async getPlan(input: EvaluationBatchScope, signal?: AbortSignal) {
    const operation = "read evaluation reproduction plan";
    const scope = evaluationBatchRequest(EvaluationBatchScopeSchema, input, operation);
    const value = evaluationBatchResponse(
      C.EvaluationReproductionPlanV1Schema,
      await this.client.get(
        `${root(scope.repositoryId)}/evaluations/${scope.evaluationId}/reproduction`,
        operation,
        { ...(signal ? { signal } : {}), maxResponseBytes: planLimit },
      ),
      operation,
      C.getEvaluationReproductionPlanIssues,
      planLimit,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId && value.evaluationId === scope.evaluationId,
      operation,
    );
    signal?.throwIfAborted();
    return value;
  }

  async getCell(input: EvaluationReproductionCellScope, signal?: AbortSignal) {
    const operation = "read evaluation reproduction cell";
    const scope = evaluationBatchRequest(cellScopeSchema, input, operation);
    const value = evaluationBatchResponse(
      C.EvaluationReproductionCellDetailV1Schema,
      await this.client.get(
        `${root(scope.repositoryId)}/evaluations/${scope.evaluationId}/cells/${scope.cellId}/reproduction`,
        operation,
        { ...(signal ? { signal } : {}), maxResponseBytes: readLimit },
      ),
      operation,
      C.getEvaluationReproductionCellDetailIssues,
      readLimit,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId &&
        value.evaluationId === scope.evaluationId &&
        value.cellId === scope.cellId,
      operation,
    );
    await verifyDigest(value.record, value.cellRecordSha256, operation, signal);
    if (value.record.reproduction)
      await verifyDigest(
        value.record.reproduction.binding,
        value.record.reproduction.bindingDigest,
        operation,
        signal,
      );
    signal?.throwIfAborted();
    return value;
  }
}

export function createHttpEvaluationReproductionAdapter(
  options: DashboardHttpClientOptions = {},
): EvaluationReproductionAdapter {
  return new HttpEvaluationReproductionAdapter(options);
}
