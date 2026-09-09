import * as C from "@agentic-review/contracts";
import {
  evaluationBatchMatch,
  evaluationBatchRequest,
  evaluationBatchResponse,
} from "../evaluation-batches/validation";
import { readVerifiedEvidenceContent } from "../evidence/verified-content";
import { ReviewControlHttpError, ReviewControlProtocolError } from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";

export interface EvaluationEvidenceAdapter {
  readonly mode: "connected";
  list(
    binding: C.EvaluationEvidenceBinding,
    signal?: AbortSignal,
  ): Promise<C.EvaluationResultEvidenceListV1>;
  content(
    binding: C.EvaluationEvidenceBinding,
    previousManifest: C.EvidenceAssetManifest,
    signal?: AbortSignal,
  ): Promise<Blob>;
}
export const evaluationEvidenceBindingKeys = [
  "repositoryId",
  "evaluationId",
  "cellId",
  "resultId",
  "resultDigest",
  "runId",
  "requestId",
  "jobId",
  "runAttemptId",
  "profileVersionId",
  "revisionKey",
  "planDigest",
] as const;
export const evaluationEvidenceBindingMatches = (
  a: C.EvaluationEvidenceBinding,
  b: C.EvaluationEvidenceBinding,
): boolean => evaluationEvidenceBindingKeys.every((key) => a[key] === b[key]);
export function evaluationEvidencePath(binding: C.EvaluationEvidenceBinding): string {
  const value = evaluationBatchRequest(
    C.EvaluationEvidenceBindingSchema,
    binding,
    "read evaluation evidence",
  );
  return `/api/v1/operator/repositories/${value.repositoryId}/evaluations/${value.evaluationId}/cells/${value.cellId}/results/${value.resultId}/evidence`;
}

export class HttpEvaluationEvidenceAdapter implements EvaluationEvidenceAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  async list(input: C.EvaluationEvidenceBinding, signal?: AbortSignal) {
    const operation = "list evaluation evidence";
    const binding = evaluationBatchRequest(C.EvaluationEvidenceBindingSchema, input, operation);
    const result = evaluationBatchResponse(
      C.EvaluationResultEvidenceListV1Schema,
      await this.client.get(evaluationEvidencePath(binding), operation, {
        ...(signal ? { signal } : {}),
        maxResponseBytes: C.maximumEvaluationResultEvidenceUtf8Bytes,
      }),
      operation,
      C.getEvaluationResultEvidenceListIssues,
      C.maximumEvaluationResultEvidenceUtf8Bytes,
    );
    evaluationBatchMatch(evaluationEvidenceBindingMatches(result.binding, binding), operation);
    return result;
  }
  async content(
    input: C.EvaluationEvidenceBinding,
    previousManifest: C.EvidenceAssetManifest,
    signal?: AbortSignal,
  ) {
    const operation = "read evaluation evidence";
    const binding = evaluationBatchRequest(C.EvaluationEvidenceBindingSchema, input, operation);
    const previous = evaluationBatchRequest(
      C.EvaluationResultEvidenceAssetV1Schema,
      {
        schemaVersion: "EvaluationResultEvidenceAssetV1",
        binding,
        assetId: previousManifest.id,
        checkIds: [previousManifest.metadata.checkId],
        manifest: previousManifest,
      },
      operation,
      C.getEvaluationResultEvidenceAssetIssues,
    );
    const path = `${evaluationEvidencePath(binding)}/${previous.assetId}`;
    const refreshed = evaluationBatchResponse(
      C.EvaluationResultEvidenceAssetV1Schema,
      await this.client.get(path, "refresh evaluation evidence manifest", {
        ...(signal ? { signal } : {}),
        maxResponseBytes: C.maximumEvaluationResultEvidenceUtf8Bytes,
      }),
      operation,
      C.getEvaluationResultEvidenceAssetIssues,
      C.maximumEvaluationResultEvidenceUtf8Bytes,
    );
    evaluationBatchMatch(
      evaluationEvidenceBindingMatches(refreshed.binding, binding) &&
        refreshed.assetId === previous.assetId,
      operation,
    );
    const manifest = refreshed.manifest;
    if (manifest.state !== "finalized" || previous.manifest.state !== "finalized")
      throw new ReviewControlHttpError("This evaluation evidence file has been retired.", {
        operation,
        status: 410,
        retryable: false,
        serverCode: "evidence_retired",
      });
    if (
      (
        [
          "id",
          "repositoryId",
          "runId",
          "requestId",
          "jobId",
          "runAttemptId",
          "profileVersionId",
          "revisionKey",
          "planDigest",
          "createdAt",
          "finalizedAt",
        ] as const
      ).some((key) => manifest[key] !== previous.manifest[key]) ||
      (["kind", "mediaType", "sizeBytes", "sha256", "capturedAt", "checkId"] as const).some(
        (key) => manifest.metadata[key] !== previous.manifest.metadata[key],
      )
    )
      throw new ReviewControlProtocolError(
        operation,
        "The evidence metadata changed after selection. Refresh the file list.",
      );
    return readVerifiedEvidenceContent({
      path: `${path}/content`,
      metadata: manifest.metadata,
      fetch: this.fetch,
      timeoutMs: this.timeoutMs,
      operation,
      ...(signal ? { signal } : {}),
      requireFullResponse: true,
    });
  }
}
export const createHttpEvaluationEvidenceAdapter = (
  options: DashboardHttpClientOptions = {},
): EvaluationEvidenceAdapter => new HttpEvaluationEvidenceAdapter(options);
