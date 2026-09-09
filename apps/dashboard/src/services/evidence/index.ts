import {
  type EvidenceAssetManifest,
  EvidenceAssetManifestSchema,
  maximumAttemptEvidenceAssets,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "../review-control/errors";
import {
  DashboardHttpClient,
  type DashboardHttpClientOptions,
} from "../review-control/http-client";
import { validateRunEntityId } from "../runs/validation";
import { readVerifiedEvidenceContent } from "./verified-content";

export interface EvidenceScope {
  readonly repositoryId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly requestId: string;
  readonly profileVersionId: string;
  readonly revisionKey: string;
  readonly planDigest: string;
}

export interface EvidenceAdapter {
  readonly mode: "connected" | "sample";
  list(scope: EvidenceScope): Promise<EvidenceAssetManifest[]>;
  content(scope: EvidenceScope, manifest: EvidenceAssetManifest): Promise<Blob>;
}

const listSchema = Type.Object(
  { items: Type.Array(EvidenceAssetManifestSchema, { maxItems: maximumAttemptEvidenceAssets }) },
  { additionalProperties: false },
);
const scopeKeys = [
  "repositoryId",
  "runId",
  "jobId",
  "runAttemptId",
  "requestId",
  "profileVersionId",
  "revisionKey",
  "planDigest",
] as const;
const operation = "read evidence";

export function evidencePath(scope: EvidenceScope): string {
  for (const key of scopeKeys) {
    if (key === "revisionKey" || key === "planDigest") {
      if (!/^[a-f0-9]{64}(?![\s\S])/u.test(scope[key]))
        throw new ReviewControlRequestError(
          operation,
          key,
          "Evidence requires its frozen revision and plan digests.",
        );
    } else validateRunEntityId(scope[key], operation, key);
  }
  return `/api/v1/operator/repositories/${scope.repositoryId}/review-runs/${scope.runId}/jobs/${scope.jobId}/attempts/${scope.runAttemptId}/evidence`;
}

function protocol(message: string): never {
  throw new ReviewControlProtocolError(operation, message);
}

export function validateEvidenceManifest(
  value: unknown,
  scope: EvidenceScope,
  expectedId?: string,
): EvidenceAssetManifest {
  if (!Value.Check(EvidenceAssetManifestSchema, value))
    protocol("The evidence manifest does not match its supported schema.");
  validateRunEntityId(value.id, operation, "assetId");
  if (
    scopeKeys.some((key) => value[key] !== scope[key]) ||
    (expectedId !== undefined && value.id !== expectedId)
  )
    protocol("The evidence manifest belongs to another run, request, profile, or attempt.");
  if ((value.state === "retired") !== (value.retiredAt !== null))
    protocol("The evidence manifest has an inconsistent retirement state.");
  return value;
}

export class HttpEvidenceAdapter implements EvidenceAdapter {
  readonly mode = "connected";
  private readonly client: DashboardHttpClient;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.client = new DashboardHttpClient(options);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async list(scope: EvidenceScope): Promise<EvidenceAssetManifest[]> {
    const value = await this.client.get(evidencePath(scope), "list evidence");
    if (!Value.Check(listSchema, value))
      protocol("The evidence list does not match its supported schema.");
    const ids = new Set<string>();
    return value.items.map((item) => {
      const manifest = validateEvidenceManifest(item, scope);
      if (ids.has(manifest.id)) protocol("The evidence list repeats an asset identity.");
      ids.add(manifest.id);
      return manifest;
    });
  }

  async content(scope: EvidenceScope, previousManifest: EvidenceAssetManifest): Promise<Blob> {
    const path = evidencePath(scope);
    validateEvidenceManifest(previousManifest, scope);
    const manifest = validateEvidenceManifest(
      await this.client.get(`${path}/${previousManifest.id}`, "refresh evidence manifest"),
      scope,
      previousManifest.id,
    );
    if (manifest.state !== "finalized")
      throw new ReviewControlHttpError("This evidence file has been retired.", {
        operation,
        status: 410,
        serverCode: "evidence_retired",
        retryable: false,
      });
    if (
      (["kind", "mediaType", "sizeBytes", "sha256", "capturedAt", "checkId"] as const).some(
        (key) => manifest.metadata[key] !== previousManifest.metadata[key],
      )
    )
      protocol("The evidence metadata changed after it was selected. Refresh the file list.");
    return readVerifiedEvidenceContent({
      path: `${path}/${manifest.id}/content`,
      metadata: manifest.metadata,
      fetch: this.fetch,
      timeoutMs: this.timeoutMs,
      operation,
    });
  }
}

export class SampleEvidenceAdapter implements EvidenceAdapter {
  readonly mode = "sample";
  async list(scope: EvidenceScope): Promise<EvidenceAssetManifest[]> {
    evidencePath(scope);
    return [];
  }
  async content(): Promise<Blob> {
    throw new ReviewControlRequestError(
      operation,
      "mode",
      "Sample evidence references do not contain uploaded files.",
    );
  }
}

export const evidence: EvidenceAdapter =
  process.env.NODE_ENV === "development" ? new SampleEvidenceAdapter() : new HttpEvidenceAdapter();
