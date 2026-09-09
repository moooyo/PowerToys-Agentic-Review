import type * as C from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlTimeoutError,
} from "../review-control/errors";
import {
  evidenceAssetFixture,
  evidenceBindingFixture,
  evidenceListFixture,
  evidenceManifestFixture,
  evidenceTestBytes,
} from "./fixtures.testing";
import {
  createHttpEvaluationEvidenceAdapter,
  evaluationEvidenceBindingKeys,
  evaluationEvidencePath,
} from "./index";

const binding = evidenceBindingFixture(),
  manifest = evidenceManifestFixture();
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const binary = (bytes = evidenceTestBytes, headers: Record<string, string> = {}) =>
  new Response(bytes as BodyInit, {
    headers: {
      "content-type": manifest.metadata.mediaType,
      "content-length": String(manifest.metadata.sizeBytes),
      ...headers,
    },
  });
const setup = (...responses: Response[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return { fetch, adapter: createHttpEvaluationEvidenceAdapter({ fetch }) };
};
afterEach(() => vi.useRealTimers());

describe("evaluation evidence binding and content", () => {
  it("uses only evaluation-scoped list, refreshed manifest and binary paths", async () => {
    const { fetch, adapter } = setup(
      json(evidenceListFixture()),
      json(evidenceAssetFixture()),
      binary(),
    );
    expect(await adapter.list(binding)).toEqual(evidenceListFixture());
    const blob = await adapter.content(binding, manifest);
    expect(await blob.text()).toBe(new TextDecoder().decode(evidenceTestBytes));
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      evaluationEvidencePath(binding),
      `${evaluationEvidencePath(binding)}/${manifest.id}`,
      `${evaluationEvidencePath(binding)}/${manifest.id}/content`,
    ]);
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        method: "GET",
        credentials: "include",
        redirect: "error",
        cache: "no-store",
      });
  });
  it.each(evaluationEvidenceBindingKeys)(
    "rejects a changed %s in the result evidence binding",
    async (key) => {
      const list = evidenceListFixture();
      list.binding[key] =
        key.endsWith("Digest") || key.endsWith("Key") ? "f".repeat(64) : "another-identity";
      const { adapter } = setup(json(list));
      await expect(adapter.list(binding)).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );
  it("retains genuine missing references and retired manifests", async () => {
    expect(await setup(json(evidenceListFixture(null))).adapter.list(binding)).toEqual(
      evidenceListFixture(null),
    );
    const retired = {
      ...manifest,
      state: "retired" as const,
      retiredAt: "2026-09-08T01:00:00.000Z",
    };
    expect(
      (await setup(json(evidenceListFixture(retired))).adapter.list(binding)).items[0]?.manifest
        ?.state,
    ).toBe("retired");
  });
  it("rejects unsafe scope, extra fields, missing check ownership and oversized metadata before fetching", async () => {
    for (const input of [
      { ...binding, cellId: "../cell" },
      { ...binding, unexpected: true },
    ]) {
      const { adapter, fetch } = setup();
      await expect(adapter.list(input as C.EvaluationEvidenceBinding)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    }
    for (const selected of [
      { ...manifest, id: "bad/id" },
      { ...manifest, metadata: { ...manifest.metadata, checkId: undefined } },
      { ...manifest, metadata: { ...manifest.metadata, sizeBytes: 64 * 1024 * 1024 + 1 } },
      {
        ...manifest,
        metadata: {
          ...manifest.metadata,
          kind: "screenshot",
          mediaType: "image/png",
          sizeBytes: 16 * 1024 * 1024 + 1,
        },
      },
    ]) {
      const { adapter, fetch } = setup();
      await expect(
        adapter.content(binding, selected as C.EvidenceAssetManifest),
      ).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it.each(["sha256", "capturedAt", "sizeBytes", "checkId"] as const)(
    "never requests content when immutable %s changed",
    async (key) => {
      const asset = evidenceAssetFixture();
      asset.manifest.metadata = {
        ...asset.manifest.metadata,
        [key]:
          key === "sizeBytes"
            ? manifest.metadata.sizeBytes + 1
            : key === "capturedAt"
              ? "2026-09-08T02:00:00.000Z"
              : key === "sha256"
                ? "e".repeat(64)
                : `${binding.profileVersionId}:other`,
      };
      if (key === "checkId") asset.checkIds = [`${binding.profileVersionId}:other`];
      const { adapter, fetch } = setup(json(asset));
      await expect(adapter.content(binding, manifest)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each(["media", "length", "short", "long", "digest", "redirect"])(
    "rejects invalid %s content before creating a Blob",
    async (failure) => {
      const bytes =
        failure === "short"
          ? evidenceTestBytes.slice(0, -1)
          : failure === "long"
            ? new Uint8Array(evidenceTestBytes.length + 1)
            : failure === "digest"
              ? new Uint8Array(evidenceTestBytes.length)
              : evidenceTestBytes;
      const response = binary(
        bytes,
        failure === "media"
          ? { "content-type": "text/html" }
          : failure === "length"
            ? { "content-length": "999" }
            : {},
      );
      if (failure === "redirect") Object.defineProperty(response, "redirected", { value: true });
      await expect(
        setup(json(evidenceAssetFixture()), response).adapter.content(binding, manifest),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );
  it.each([401, 403, 404, 410])(
    "preserves HTTP %s instead of returning an error body as a file",
    async (status) => {
      const { adapter, fetch } = setup(
        json(evidenceAssetFixture()),
        json({ error: "Unavailable" }, status),
      );
      await expect(adapter.content(binding, manifest)).rejects.toMatchObject({ status });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it("does not fetch bytes for a newly retired manifest", async () => {
    const retired = {
      ...manifest,
      state: "retired" as const,
      retiredAt: "2026-09-08T01:00:00.000Z",
    };
    const { adapter, fetch } = setup(json(evidenceAssetFixture(retired)));
    await expect(adapter.content(binding, manifest)).rejects.toMatchObject({ status: 410 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("checks refreshed result and asset identity before requesting bytes", async () => {
    const otherResult = evidenceAssetFixture();
    otherResult.binding.resultDigest = "f".repeat(64);
    const otherAsset = evidenceAssetFixture();
    otherAsset.assetId = "another-asset";
    otherAsset.manifest.id = "another-asset";
    for (const refreshed of [otherResult, otherAsset]) {
      const { adapter, fetch } = setup(json(refreshed));
      await expect(adapter.content(binding, manifest)).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it.each(["screenshot", "steps", "trace"] as const)(
    "returns verified %s bytes with their declared media type",
    async (kind) => {
      const selected = evidenceManifestFixture(evidenceTestBytes, kind);
      const { adapter } = setup(
        json(evidenceAssetFixture(selected)),
        binary(evidenceTestBytes, { "content-type": selected.metadata.mediaType }),
      );
      const blob = await adapter.content(binding, selected);
      expect(blob.type).toBe(selected.metadata.mediaType);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(evidenceTestBytes);
    },
  );
  it("cancels an unfinished content stream when its result owner aborts", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(evidenceTestBytes.slice(0, 1));
      },
      cancel,
    });
    const { adapter, fetch } = setup(
      json(evidenceAssetFixture()),
      new Response(stream, {
        headers: {
          "content-type": "text/plain",
          "content-length": String(evidenceTestBytes.length),
        },
      }),
    );
    const controller = new AbortController(),
      pending = adapter.content(binding, manifest, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("propagates caller abort even when the binary fetch ignores its signal", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(evidenceAssetFixture()))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController(),
      adapter = createHttpEvaluationEvidenceAdapter({ fetch });
    const pending = adapter.content(binding, manifest, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });
  it("applies an absolute deadline to an ignored binary fetch", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(evidenceAssetFixture()))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const pending = createHttpEvaluationEvidenceAdapter({ fetch, timeoutMs: 10 }).content(
      binding,
      manifest,
    );
    const rejected = expect(pending).rejects.toBeInstanceOf(ReviewControlTimeoutError);
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
  });
});
