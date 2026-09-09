import * as C from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import {
  evaluationBatchMatch,
  evaluationBatchPageMatches,
  evaluationBatchRequest,
  evaluationBatchResponse,
} from "../evaluation-batches/validation";
import { ReviewControlProtocolError } from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
  MAX_DASHBOARD_RESPONSE_BYTES,
} from "../review-control/http-client";

export interface EvaluationModelInvocationScope {
  readonly repositoryId: string;
  readonly evaluationId: string;
  readonly cellId: string;
}

export interface EvaluationModelInvocationAdapter {
  readonly mode: "connected";
  list(
    scope: EvaluationModelInvocationScope,
    query?: C.EvaluationCellInvocationListQuery,
    signal?: AbortSignal,
  ): Promise<C.EvaluationCellInvocationListV1>;
}

const scopeSchema = Type.Object(
  { repositoryId: C.EntityIdSchema, evaluationId: C.EntityIdSchema, cellId: C.EntityIdSchema },
  { additionalProperties: false },
);
const operation = "read evaluation model invocation diagnostics";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error("Diagnostic metadata must contain JSON values.");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

async function verifyDigest(value: unknown, expected: string, signal?: AbortSignal): Promise<void> {
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
      "The model invocation metadata could not be verified.",
    );
  }
  signal?.throwIfAborted();
  evaluationBatchMatch(digest === expected, operation);
}

export class HttpEvaluationModelInvocationAdapter implements EvaluationModelInvocationAdapter {
  readonly mode = "connected" as const;
  private readonly client: DashboardHttpClient;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
  }

  async list(
    input: EvaluationModelInvocationScope,
    filters: C.EvaluationCellInvocationListQuery = {},
    signal?: AbortSignal,
  ): Promise<C.EvaluationCellInvocationListV1> {
    const scope = evaluationBatchRequest(scopeSchema, input, operation);
    const request = evaluationBatchRequest(
      C.EvaluationCellInvocationListQuerySchema,
      filters,
      operation,
      C.getEvaluationCellInvocationListQueryIssues,
    );
    const query = { page: request.page ?? 1, pageSize: request.pageSize ?? 10 };
    const parameters = new URLSearchParams({
      page: String(query.page),
      pageSize: String(query.pageSize),
    });
    const value = evaluationBatchResponse(
      C.EvaluationCellInvocationListV1Schema,
      await this.client.get(
        `/api/v1/operator/repositories/${scope.repositoryId}/evaluations/${scope.evaluationId}/cells/${scope.cellId}/model-invocations?${parameters}`,
        operation,
        {
          ...(signal === undefined ? {} : { signal }),
          maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES,
        },
      ),
      operation,
      C.getEvaluationCellInvocationListIssues,
      MAX_DASHBOARD_RESPONSE_BYTES,
    );
    evaluationBatchMatch(
      value.repositoryId === scope.repositoryId &&
        value.evaluationId === scope.evaluationId &&
        value.cellId === scope.cellId &&
        evaluationBatchPageMatches(value, scope.repositoryId, query),
      operation,
    );
    const registration = value.expectedRuntimeRegistration;
    if (registration !== null)
      await verifyDigest(registration.identity, registration.identitySha256, signal);
    for (const item of value.items) {
      await verifyDigest(item.opening.scope, item.opening.scopeSha256, signal);
      if (item.observedIdentity !== null) {
        const expectedDigest = item.submission?.consistency.observedIdentitySha256;
        evaluationBatchMatch(expectedDigest !== undefined && expectedDigest !== null, operation);
        await verifyDigest(item.observedIdentity, expectedDigest as string, signal);
      }
    }
    signal?.throwIfAborted();
    // The validated Server snapshot records diagnostic consistency only. No polling, sample
    // substitution or execution authorization is inferred from a matched submission.
    return value;
  }
}

export function createHttpEvaluationModelInvocationAdapter(
  options: DashboardHttpClientOptions = {},
): EvaluationModelInvocationAdapter {
  return new HttpEvaluationModelInvocationAdapter(options);
}
