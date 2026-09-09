import { createHash } from "node:crypto";
import type { EvidenceAssetManifest } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlTimeoutError,
} from "../review-control/errors";
import { DashboardHttpClient } from "../review-control/http-client";
import {
  type EvidenceScope,
  evidencePath,
  HttpEvidenceAdapter,
  SampleEvidenceAdapter,
} from "./index";

const scope: EvidenceScope = {
  repositoryId: "repo-one",
  runId: "run-one",
  jobId: "job-one",
  runAttemptId: "attempt-one",
  requestId: "request-one",
  profileVersionId: "profile-version-one",
  revisionKey: "a".repeat(64),
  planDigest: "b".repeat(64),
};
const content = new TextEncoder().encode("Recorded validation output.\n");
const manifest: EvidenceAssetManifest = {
  ...scope,
  id: "asset-one",
  metadata: {
    kind: "log",
    mediaType: "text/plain",
    sizeBytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    capturedAt: "2026-09-07T10:00:00.000Z",
    checkId: "profile-version-one:compile",
  },
  state: "finalized",
  createdAt: "2026-09-07T10:00:00.000Z",
  finalizedAt: "2026-09-07T10:00:01.000Z",
  retiredAt: null,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const binary = (bytes: Uint8Array = content, headers: Record<string, string> = {}) =>
  new Response(bytes as BodyInit, {
    headers: {
      "content-type": "text/plain",
      "content-length": String(content.byteLength),
      ...headers,
    },
  });
const setup = (...responses: Response[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return { fetch, adapter: new HttpEvidenceAdapter({ fetch }) };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scoped evidence reads", () => {
  it("reads only the exact attempt and preserves retired files", async () => {
    const retired = {
      ...manifest,
      id: "asset-retired",
      state: "retired",
      retiredAt: "2026-09-07T11:00:00.000Z",
    };
    const { adapter, fetch } = setup(json({ items: [manifest, retired] }));
    await expect(adapter.list(scope)).resolves.toEqual([manifest, retired]);
    expect(fetch).toHaveBeenCalledWith(
      evidencePath(scope),
      expect.objectContaining({
        credentials: "include",
        redirect: "error",
        method: "GET",
        cache: "no-store",
      }),
    );
  });

  it.each([
    "repositoryId",
    "runId",
    "jobId",
    "runAttemptId",
    "requestId",
    "profileVersionId",
    "revisionKey",
    "planDigest",
  ] as const)("rejects mismatched %s in the manifest", async (field) => {
    const { adapter } = setup(
      json({
        items: [
          {
            ...manifest,
            [field]: field.endsWith("Key") || field.endsWith("Digest") ? "c".repeat(64) : "other",
          },
        ],
      }),
    );
    await expect(adapter.list(scope)).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each(["../other", "asset-one\n", "asset-one?download=1", "https://example.test/file"])(
    "rejects unsafe IDs before any fetch: %s",
    async (id) => {
      const { adapter, fetch } = setup();
      await expect(adapter.list({ ...scope, runAttemptId: id })).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate and inconsistent retirement manifests", async () => {
    for (const items of [
      [manifest, manifest],
      [{ ...manifest, state: "retired", retiredAt: null }],
    ]) {
      const { adapter } = setup(json({ items }));
      await expect(adapter.list(scope)).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
  });

  it("restricts the shared JSON client to manifest reads, never arbitrary content URLs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    for (const path of [
      `${evidencePath(scope)}/asset-one/content`,
      `${evidencePath(scope)}?all=true`,
      `${evidencePath(scope)}/asset-one?download=true`,
    ])
      await expect(client.get(path, "unsafe evidence read")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes the manifest and verifies bytes before returning a typed download", async () => {
    const { adapter, fetch } = setup(json(manifest), binary());
    const blob = await adapter.content(scope, manifest);
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe(new TextDecoder().decode(content));
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${evidencePath(scope)}/${manifest.id}/content`,
      expect.objectContaining({
        credentials: "include",
        redirect: "error",
        cache: "no-store",
        headers: { Accept: "text/plain" },
      }),
    );
  });

  it("allows metadata property order to differ without changing content identity", async () => {
    const metadata = Object.fromEntries(Object.entries(manifest.metadata).reverse());
    const { adapter } = setup(json({ ...manifest, metadata }), binary());
    await expect(adapter.content(scope, manifest)).resolves.toBeInstanceOf(Blob);
  });

  it("never downloads retired or missing files", async () => {
    const retired = setup(
      json({ ...manifest, state: "retired", retiredAt: "2026-09-07T11:00:00.000Z" }),
    );
    await expect(retired.adapter.content(scope, manifest)).rejects.toMatchObject({ status: 410 });
    expect(retired.fetch).toHaveBeenCalledTimes(1);
    const missing = setup(json({ code: "evidence_not_found" }, 404));
    await expect(missing.adapter.content(scope, manifest)).rejects.toMatchObject({ status: 404 });
    expect(missing.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects replaced metadata before requesting content", async () => {
    const { adapter, fetch } = setup(
      json({ ...manifest, metadata: { ...manifest.metadata, sha256: "c".repeat(64) } }),
    );
    await expect(adapter.content(scope, manifest)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["media-type", "declared-size", "truncated", "oversized", "digest"])(
    "rejects content with an invalid %s",
    async (failure) => {
      const bytes =
        failure === "truncated"
          ? content.slice(0, -1)
          : failure === "oversized"
            ? new Uint8Array(content.byteLength + 1)
            : failure === "digest"
              ? new Uint8Array(content.byteLength)
              : content;
      const headers: Record<string, string> =
        failure === "media-type"
          ? { "content-type": "text/html" }
          : failure === "declared-size"
            ? { "content-length": "999" }
            : {};
      const { adapter } = setup(json(manifest), binary(bytes, headers));
      await expect(adapter.content(scope, manifest)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    },
  );

  it("reports unavailable content without returning an error document as a file", async () => {
    const { adapter } = setup(json(manifest), json({ code: "evidence_unavailable" }, 503));
    await expect(adapter.content(scope, manifest)).rejects.toBeInstanceOf(ReviewControlHttpError);
  });

  it("enforces an absolute content deadline even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(manifest))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const adapter = new HttpEvidenceAdapter({ fetch, timeoutMs: 10 });
    const response = adapter.content(scope, manifest);
    const failure = expect(response).rejects.toBeInstanceOf(ReviewControlTimeoutError);
    await vi.advanceTimersByTimeAsync(11);
    await failure;
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });

  it("keeps sample references separate from uploaded evidence", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const adapter = new SampleEvidenceAdapter();
    expect(adapter.mode).toBe("sample");
    await expect(adapter.list(scope)).resolves.toEqual([]);
    await expect(adapter.content()).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
