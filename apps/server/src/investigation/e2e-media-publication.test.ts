import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInvestigationPreview,
  type InvestigationArtifactV1,
  type InvestigationResultV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type E2eMediaUploadReceipt,
  InvestigationE2eMediaPublications,
} from "./e2e-media-publication.js";
import { InvestigationEvidenceStore } from "./evidence-store.js";
import { GitHubMediaUploader, type InvestigationMediaUploader } from "./gh-media-upload.js";
import { InvestigationStore } from "./store.js";

const stores: InvestigationStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
const mp4 = Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex");
const imageUrl = "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
const videoUrl = "https://github.com/user-attachments/assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function harness(uploader?: InvestigationMediaUploader, databasePath?: string) {
  const store = new InvestigationStore(databasePath);
  stores.push(store);
  const evidence = new InvestigationEvidenceStore(store);
  const preview = createInvestigationPreview("pr", { findingCount: 0 });
  const task: InvestigationTaskV1 = { ...preview.task, kind: "pr-e2e" };
  const subject = task.subjects.find((entry) => entry.id === task.subjectRef)!;
  if (subject.kind !== "original_pr") throw new Error("invalid fixture");
  const assets = [
    {
      id: "image-evidence",
      name: "feature.png",
      mediaType: "image/png",
      kind: "image",
      bytes: png,
    },
    {
      id: "video-evidence",
      name: "feature.mp4",
      mediaType: "video/mp4",
      kind: "video",
      bytes: mp4,
    },
  ] as const;
  const artifacts = assets.map(
    (asset): InvestigationArtifactV1 => ({
      id: asset.id,
      taskId: task.id,
      attemptId: preview.result.context.attempt.id,
      subjectRef: task.subjectRef,
      kind: asset.kind,
      name: asset.name,
      mediaType: asset.mediaType,
      digest: createHash("sha256").update(asset.bytes).digest("hex"),
      byteLength: asset.bytes.length,
      availability: "available",
    }),
  );
  for (const [index, artifact] of artifacts.entries())
    evidence.upload(artifact, assets[index]!.bytes.toString("base64"), () => undefined);
  const report: InvestigationResultV1 = {
    ...preview.result,
    context: {
      ...preview.result.context,
      task: { ...preview.result.context.task, kind: "pr-e2e" },
      e2e: {
        headSha: subject.headSha,
        buildIdentity: "Synthetic pinned build",
        features: artifacts.map((artifact, index) => ({
          id: `feature-${index}`,
          title: `Feature ${index}`,
          paths: ["src/test.cs"],
          scenario: "Synthetic scenario",
          userVisible: true,
          outcome: "passed",
          assertions: [
            {
              id: `assertion-${index}`,
              expected: "The feature behaves correctly.",
              observed: "The feature behaved correctly.",
              outcome: "passed",
              evidenceRefs: [`assertion-receipt-${index}`],
            },
          ],
          artifactRefs: [artifact.id],
          limitations: [],
        })),
        cleanup: {
          confirmed: true,
          recordedAt: "2026-09-19T00:00:00.000Z",
          summary: "Owned processes stopped.",
        },
      },
    },
    artifacts,
    verificationEvidence: artifacts.flatMap((artifact, index) => [
      {
        id: `assertion-receipt-${index}`,
        subjectRef: task.subjectRef,
        source: "executor_observation" as const,
        authority: "worker" as const,
        summary: "The trusted runtime assertion passed.",
        artifactRefs: [],
        evidenceRefs: [],
        provenance: {
          taskId: task.id,
          attemptId: preview.result.context.attempt.id,
          producer: "e2e-tool-server",
          recordedAt: "2026-09-19T00:00:00.000Z",
        },
      },
      {
        id: `capture-receipt-${index}`,
        subjectRef: task.subjectRef,
        source: "visual_observation" as const,
        authority: "worker" as const,
        summary: "Worker captured the feature after the assertion.",
        artifactRefs: [artifact.id],
        evidenceRefs: [],
        provenance: {
          taskId: task.id,
          attemptId: preview.result.context.attempt.id,
          producer: "e2e-tool-server",
          recordedAt: "2026-09-19T00:00:00.000Z",
        },
      },
    ]),
  };
  let clock = Date.parse("2026-09-19T00:00:00.000Z");
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const target = new URL(String(input));
    if (target.pathname === "/user") return Response.json({ id: 42 });
    if (target.hostname === "api.github.com")
      return Response.json({
        id: task.repository.githubRepositoryId,
        full_name: task.repository.fullName,
        permissions: { push: true },
      });
    return Response.json({
      url: target.searchParams.get("content_type") === "image/png" ? imageUrl : videoUrl,
    });
  });
  const options = {
    store,
    evidence,
    enableExternalWrites: true,
    now: () => new Date(clock),
    uploader:
      uploader ??
      new GitHubMediaUploader({ token: "synthetic-secret", expectedGitHubUserId: 42, fetch }),
  };
  return {
    store,
    evidence,
    task,
    report,
    artifacts,
    fetch,
    options,
    media: new InvestigationE2eMediaPublications(options),
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

describe("durable E2E media publication", () => {
  it("uploads bytes before rendering embeds and reuses receipts across comment retry and service restart", async () => {
    const h = harness();
    h.media.prepare(h.report, h.task);
    expect(h.media.render(h.report.report.id)).toContain("pending");
    await h.media.publish(h.report.report.id);
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(h.media.render(h.report.report.id)).toContain(`![feature.png](${imageUrl})`);
    expect(h.media.render(h.report.report.id)).toContain(`\n\n${videoUrl}`);
    expect(h.media.render(h.report.report.id)).not.toContain(`[feature.mp4](${videoUrl})`);
    const restarted = new InvestigationE2eMediaPublications(h.options);
    restarted.prepare(h.report, h.task);
    await restarted.publish(h.report.report.id);
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    for (const receipt of restarted.uploads(h.report.report.id)) {
      expect(receipt.state).toBe("uploaded");
      expect(receipt.headSha).toBe(h.report.context.e2e!.headSha);
      expect(receipt.bindings[0]?.assertionIds).toHaveLength(1);
      expect(receipt.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("retains uploaded URLs through closing and reopening the SQLite database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "e2e-media-receipts-"));
    directories.push(directory);
    const path = join(directory, "investigation.sqlite");
    const h = harness(undefined, path);
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id);
    h.store.close();
    stores.splice(stores.indexOf(h.store), 1);
    const reopened = new InvestigationStore(path);
    stores.push(reopened);
    const media = new InvestigationE2eMediaPublications({
      ...h.options,
      store: reopened,
      evidence: new InvestigationEvidenceStore(reopened),
    });
    media.prepare(h.report, h.task);
    await media.publish(h.report.report.id);
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(media.render(h.report.report.id)).toContain(videoUrl);
  });

  it("does not retry an upload whose response was lost, even after restart", async () => {
    const upload = vi.fn<InvestigationMediaUploader["upload"]>(async (_input, beforeDispatch) => {
      beforeDispatch();
      throw new Error("connection closed");
    });
    const h = harness({ upload });
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id);
    const restarted = new InvestigationE2eMediaPublications(h.options);
    await restarted.publish(h.report.report.id);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(
      restarted.uploads(h.report.report.id).every((receipt) => receipt.state === "unknown"),
    ).toBe(true);
    expect(restarted.render(h.report.report.id)).toContain("will not be sent again automatically");
    expect(restarted.render(h.report.report.id)).not.toContain("connection closed");
  });

  it("turns expired dispatched claims into unknown without repeating the POST", async () => {
    const upload = vi.fn<InvestigationMediaUploader["upload"]>();
    const h = harness({ upload });
    h.media.prepare(h.report, h.task);
    for (const receipt of h.media.uploads(h.report.report.id))
      h.store.put("idempotency", receipt.id, {
        ...receipt,
        state: "uploading",
        claim: { ownerId: "crashed-process", expiresAt: 1 },
      } satisfies E2eMediaUploadReceipt);
    await h.media.publish(h.report.report.id);
    expect(upload).not.toHaveBeenCalled();
    expect(
      h.media
        .uploads(h.report.report.id)
        .every(
          (receipt) => receipt.state === "unknown" && receipt.code === "media_upload_interrupted",
        ),
    ).toBe(true);
  });

  it("serializes concurrent publication calls for the same artifact", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const upload = vi.fn<InvestigationMediaUploader["upload"]>(async (input, beforeDispatch) => {
      beforeDispatch();
      await blocked;
      return {
        state: "uploaded",
        url: input.artifact.mediaType === "image/png" ? imageUrl : videoUrl,
      };
    });
    const h = harness({ upload });
    h.media.prepare(h.report, h.task);
    const first = h.media.publish(h.report.report.id);
    const second = new InvestigationE2eMediaPublications(h.options).publish(h.report.report.id);
    unblock();
    await Promise.all([first, second]);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(
      h.media.uploads(h.report.report.id).every((receipt) => receipt.state === "uploaded"),
    ).toBe(true);
  });

  it("shows missing evidence separately without changing a passed test outcome", async () => {
    const h = harness();
    h.report.context.e2e!.features[0]!.artifactRefs = [];
    h.report.context.e2e!.features[0]!.assertions[0]!.evidenceRefs = [];
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id);
    expect(h.media.render(h.report.report.id)).toContain("missing_feature_media:feature-0");
    expect(h.media.render(h.report.report.id)).toContain("Test results are unchanged");
    expect(h.report.context.e2e!.features[0]!.outcome).toBe("passed");
  });

  it("blocks provenance mismatch and never publishes another attempt's evidence", async () => {
    const h = harness();
    h.report.artifacts[0]!.attemptId = "different-attempt";
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id);
    expect(h.media.render(h.report.report.id)).toContain(
      "media_provenance_mismatch:image-evidence",
    );
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(h.media.render(h.report.report.id)).not.toContain(imageUrl);
  });

  it("retains original producer provenance when a resumed report adopts a prior attempt", async () => {
    const h = harness();
    const originalAttemptId = h.report.context.attempt.id;
    h.report.context.attempt.id = "resumed-attempt";
    h.report.context.adoptedAttemptIds.push(originalAttemptId);
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id);
    expect(h.media.render(h.report.report.id)).toContain("Published.");
    expect(h.media.uploads(h.report.report.id)[0]).toMatchObject({
      attemptId: "resumed-attempt",
      artifact: { attemptId: originalAttemptId },
    });
  });

  it("resolves Worker assertion evidence IDs instead of accepting artifact IDs as assertions", async () => {
    const h = harness();
    h.report.context.e2e!.features[0]!.assertions[0]!.evidenceRefs = [h.artifacts[0]!.id];
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id);
    expect(h.media.render(h.report.report.id)).toContain("missing_feature_assertion:feature-0");
    expect(h.media.uploads(h.report.report.id)[0]!.bindings[0]!.assertionIds).toHaveLength(0);
  });

  it("binds uploads to the pinned revision and rejects a changed sealed manifest", async () => {
    const h = harness();
    h.report.context.e2e!.headSha = "0".repeat(40);
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.media.render(h.report.report.id)).toContain("coverage_revision_mismatch");
    h.report.artifacts[0]!.digest = "0".repeat(64);
    expect(() => h.media.prepare(h.report, h.task)).toThrow("sealed evidence manifest");
  });

  it("does not trust a model-provided remote URL or an uploader missing dispatch provenance", async () => {
    const upload = vi.fn<InvestigationMediaUploader["upload"]>(async () => ({
      state: "uploaded",
      url: imageUrl,
    }));
    const h = harness({ upload });
    h.report.context.e2e!.features[0]!.scenario = "https://attacker.invalid/not-evidence.png";
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id);
    expect(h.media.render(h.report.report.id)).not.toContain("attacker.invalid");
    expect(h.media.render(h.report.report.id)).not.toContain(imageUrl);
    expect(
      h.media.uploads(h.report.report.id).every((receipt) => receipt.state === "blocked"),
    ).toBe(true);
  });

  it("honors the external-write gate and rechecks stored bytes", async () => {
    const h = harness();
    const disabled = new InvestigationE2eMediaPublications({
      ...h.options,
      enableExternalWrites: false,
    });
    disabled.prepare(h.report, h.task);
    await disabled.publish(h.report.report.id);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(disabled.render(h.report.report.id)).toContain("media_publication_disabled");
    h.store.put("evidenceAssets", h.artifacts[0]!.id, {
      contentBase64: Buffer.from("corrupted").toString("base64"),
    });
    await h.media.publish(h.report.report.id);
    expect(h.media.render(h.report.report.id)).toContain("media_evidence_unavailable");
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("revalidates the publication grant after upload preflight and before sending bytes", async () => {
    const h = harness();
    h.media.prepare(h.report, h.task);
    await h.media.publish(h.report.report.id, undefined, () => {
      throw new Error("The publication grant was revoked.");
    });
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(
      h.media.uploads(h.report.report.id).every((receipt) => receipt.state === "blocked"),
    ).toBe(true);
  });
});
