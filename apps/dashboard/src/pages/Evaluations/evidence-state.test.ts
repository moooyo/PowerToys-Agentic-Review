import { afterEach, describe, expect, it, vi } from "vitest";
import { cellResultFixture } from "@/services/evaluation-batches/fixtures.testing";
import type { EvaluationEvidenceAdapter } from "@/services/evaluation-evidence";
import {
  evidenceBindingFixture,
  evidenceListFixture,
  evidenceManifestFixture,
  evidenceTestBytes,
} from "@/services/evaluation-evidence/fixtures.testing";
import {
  ReviewControlHttpError,
  ReviewControlProtocolError,
} from "@/services/review-control/errors";
import {
  assertResultEvidenceReferences,
  boundedEvidenceText,
  EvaluationEvidenceSession,
  maximumEvidenceTextPreviewBytes,
  resultEvidenceBinding,
  resultEvidenceReferences,
} from "./evidence-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function fixture(
  content: EvaluationEvidenceAdapter["content"] = async (_binding, manifest) =>
    new Blob([evidenceTestBytes], { type: manifest.metadata.mediaType }),
) {
  let url = 0;
  const resources = {
      createObjectURL: vi.fn(() => `blob:verified-${url++}`),
      revokeObjectURL: vi.fn(),
      download: vi.fn(),
    },
    denied = vi.fn();
  const adapter = { mode: "connected" as const, list: vi.fn(), content: vi.fn(content) };
  return {
    owner: new EvaluationEvidenceSession(adapter, evidenceBindingFixture(), resources, denied),
    resources,
    denied,
    adapter,
  };
}
afterEach(() => vi.useRealTimers());

describe("evaluation evidence references", () => {
  it("constructs all binding fields and exactly the recorded report references", () => {
    const result = cellResultFixture();
    expect(resultEvidenceBinding(result)).toEqual(evidenceBindingFixture());
    expect(resultEvidenceReferences(result)).toEqual([
      { assetId: "evidence-build", checkIds: ["profile-baseline:build"] },
    ]);
    expect(() =>
      assertResultEvidenceReferences(
        evidenceListFixture(),
        evidenceBindingFixture(),
        resultEvidenceReferences(result),
      ),
    ).not.toThrow();
    for (const list of [
      { ...evidenceListFixture(), items: [] },
      {
        ...evidenceListFixture(),
        items: [
          ...evidenceListFixture().items,
          { assetId: "unreferenced", checkIds: ["profile-baseline:build"], manifest: null },
        ],
      },
      {
        ...evidenceListFixture(),
        items: [
          { assetId: "evidence-build", checkIds: ["profile-baseline:other"], manifest: null },
        ],
      },
    ])
      expect(() =>
        assertResultEvidenceReferences(
          list,
          evidenceBindingFixture(),
          resultEvidenceReferences(result),
        ),
      ).toThrow(/exactly/u);
  });
  it("preserves every check reference when an asset ID appears more than once", () => {
    const result = cellResultFixture(),
      check = result.report.checks[0];
    if (!check) throw new Error("Check required.");
    result.report.checks.push({ ...check, id: "profile-baseline:test" });
    expect(resultEvidenceReferences(result)).toEqual([
      { assetId: "evidence-build", checkIds: ["profile-baseline:build", "profile-baseline:test"] },
    ]);
  });
});
describe("verified evidence session resources", () => {
  it("never creates an image URL before verified content returns", async () => {
    const response = deferred<Blob>(),
      f = fixture(() => response.promise),
      manifest = evidenceManifestFixture(evidenceTestBytes, "screenshot");
    const pending = f.owner.run("preview", manifest);
    expect(f.resources.createObjectURL).not.toHaveBeenCalled();
    expect(f.owner.snapshot().preview).toBeNull();
    response.resolve(new Blob([evidenceTestBytes], { type: "image/png" }));
    await pending;
    expect(f.resources.createObjectURL).toHaveBeenCalledOnce();
    expect(f.owner.snapshot().preview).toMatchObject({ kind: "image", url: "blob:verified-0" });
    f.owner.closePreview();
    expect(f.resources.revokeObjectURL).toHaveBeenCalledWith("blob:verified-0");
  });
  it("aborts and rejects late bytes after result scope or Drawer disposal", async () => {
    const response = deferred<Blob>(),
      f = fixture(() => response.promise),
      manifest = evidenceManifestFixture(evidenceTestBytes, "screenshot");
    const pending = f.owner.run("preview", manifest);
    const signal = f.adapter.content.mock.calls[0]?.[2];
    f.owner.dispose();
    expect(signal?.aborted).toBe(true);
    response.resolve(new Blob([evidenceTestBytes], { type: "image/png" }));
    await pending;
    expect(f.resources.createObjectURL).not.toHaveBeenCalled();
    expect(f.owner.snapshot().preview).toBeNull();
  });
  it("releases a previous preview before the next operation and allows only one in flight", async () => {
    const response = deferred<Blob>();
    let second = false;
    const f = fixture((_binding, manifest) =>
      second
        ? response.promise
        : Promise.resolve(new Blob([evidenceTestBytes], { type: manifest.metadata.mediaType })),
    );
    const manifest = evidenceManifestFixture(evidenceTestBytes, "screenshot");
    await f.owner.run("preview", manifest);
    second = true;
    const pending = f.owner.run("download", manifest);
    await f.owner.run("download", manifest);
    expect(f.adapter.content).toHaveBeenCalledTimes(2);
    expect(f.resources.revokeObjectURL).toHaveBeenCalledWith("blob:verified-0");
    expect(f.owner.snapshot().preview).toBeNull();
    f.owner.reset();
    response.resolve(new Blob([evidenceTestBytes], { type: "image/png" }));
    await pending;
    expect(f.resources.download).not.toHaveBeenCalled();
  });
  it("downloads verified bytes and revokes every URL on disposal without a delayed leak", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.owner.run("download", evidenceManifestFixture());
    expect(f.resources.download).toHaveBeenCalledWith("blob:verified-0", "evidence-build.txt");
    f.owner.dispose();
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.resources.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:verified-0");
  });
  it.each([401, 403, 404, 410])(
    "keeps HTTP %s distinct and never creates a URL on failure",
    async (status) => {
      const f = fixture(async () => {
        throw new ReviewControlHttpError("Unavailable", {
          operation: "read evidence",
          status,
          retryable: false,
        });
      });
      await f.owner.run("download", evidenceManifestFixture());
      expect(f.owner.snapshot().error?.status).toBe(status);
      expect(f.resources.createObjectURL).not.toHaveBeenCalled();
      expect(f.denied).toHaveBeenCalledTimes(
        status === 401 || status === 403 || status === 404 ? 1 : 0,
      );
    },
  );
  it("keeps digest verification failures and mismatched returned media out of the preview", async () => {
    const f = fixture(async () => {
      throw new ReviewControlProtocolError("read evidence", "Digest mismatch");
    });
    await f.owner.run("preview", evidenceManifestFixture(evidenceTestBytes, "screenshot"));
    expect(f.resources.createObjectURL).not.toHaveBeenCalled();
    const other = fixture(async () => new Blob([evidenceTestBytes], { type: "text/html" }));
    await other.owner.run("preview", evidenceManifestFixture());
    expect(other.owner.snapshot().preview).toBeNull();
    expect(other.resources.createObjectURL).not.toHaveBeenCalled();
  });
  it("previews strict text without creating a URL and keeps trace files download-only", async () => {
    const f = fixture();
    await f.owner.run("preview", evidenceManifestFixture());
    expect(f.owner.snapshot().preview).toMatchObject({
      kind: "text",
      text: new TextDecoder().decode(evidenceTestBytes),
      truncated: false,
    });
    expect(f.resources.createObjectURL).not.toHaveBeenCalled();
    await f.owner.run("preview", evidenceManifestFixture(evidenceTestBytes, "trace"));
    expect(f.owner.snapshot().preview).toBeNull();
    expect(f.owner.snapshot().error?.message).toContain("downloads only");
  });
});
describe("bounded UTF-8 evidence text", () => {
  it("marks the preview truncated without splitting a trailing code point", async () => {
    const text = `${"a".repeat(maximumEvidenceTextPreviewBytes - 1)}😀tail`;
    expect(await boundedEvidenceText(new Blob([text], { type: "text/plain" }))).toEqual({
      text: "a".repeat(maximumEvidenceTextPreviewBytes - 1),
      truncated: true,
    });
  });
  it("rejects malformed UTF-8 rather than rendering a replacement-decoded file", async () => {
    await expect(boundedEvidenceText(new Blob([new Uint8Array([0xff])]))).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    const bytes = new Uint8Array(maximumEvidenceTextPreviewBytes + 1).fill(0x61);
    bytes[maximumEvidenceTextPreviewBytes - 1] = 0xff;
    await expect(boundedEvidenceText(new Blob([bytes]))).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
});
