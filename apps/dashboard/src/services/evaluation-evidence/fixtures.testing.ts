import { createHash } from "node:crypto";
import type * as C from "@agentic-review/contracts";
import { cellResultFixture } from "../evaluation-batches/fixtures.testing";
import { evaluationEvidenceBindingKeys } from "./index";

export const evidenceTestBytes = new TextEncoder().encode("Recorded evaluation output.\n");
export function evidenceBindingFixture(): C.EvaluationEvidenceBinding {
  const result = cellResultFixture();
  return Object.fromEntries(
    evaluationEvidenceBindingKeys.map((key) => [key, result[key]]),
  ) as unknown as C.EvaluationEvidenceBinding;
}
export function evidenceManifestFixture(
  bytes = evidenceTestBytes,
  kind: C.EvidenceAssetKind = "log",
): C.EvidenceAssetManifest {
  const {
    repositoryId,
    runId,
    requestId,
    jobId,
    runAttemptId,
    profileVersionId,
    revisionKey,
    planDigest,
  } = evidenceBindingFixture();
  return {
    id: "evidence-build",
    repositoryId,
    runId,
    requestId,
    jobId,
    runAttemptId,
    profileVersionId,
    revisionKey,
    planDigest,
    metadata: {
      kind,
      mediaType:
        kind === "screenshot"
          ? "image/png"
          : kind === "log"
            ? "text/plain"
            : kind === "steps"
              ? "application/json"
              : "application/zip",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      capturedAt: "2026-09-08T00:00:00.000Z",
      checkId: `${profileVersionId}:build`,
    } as C.EvidenceAssetMetadata,
    state: "finalized",
    createdAt: "2026-09-08T00:00:00.000Z",
    finalizedAt: "2026-09-08T00:00:01.000Z",
    retiredAt: null,
  };
}
export function evidenceAssetFixture(
  manifest = evidenceManifestFixture(),
): C.EvaluationResultEvidenceAssetV1 {
  return {
    schemaVersion: "EvaluationResultEvidenceAssetV1",
    binding: evidenceBindingFixture(),
    assetId: manifest.id,
    checkIds: [manifest.metadata.checkId ?? ""],
    manifest,
  };
}
export function evidenceListFixture(
  manifest: C.EvidenceAssetManifest | null = evidenceManifestFixture(),
): C.EvaluationResultEvidenceListV1 {
  return {
    schemaVersion: "EvaluationResultEvidenceListV1",
    binding: evidenceBindingFixture(),
    items: [
      {
        assetId: manifest?.id ?? "evidence-build",
        checkIds: [`${evidenceBindingFixture().profileVersionId}:build`],
        manifest,
      },
    ],
  };
}
