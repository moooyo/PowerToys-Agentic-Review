import { createHash } from "node:crypto";
import type { InvestigationArtifactMetadataV1 } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactDetails,
  ArtifactPanel,
  artifactPreviewKind,
  assertArtifactBinding,
  createArtifactPreview,
  readVerifiedArtifactContent,
} from "./artifact-panel";
import { createSampleInvestigationApi } from "./sample-adapter";

async function fixture() {
  const api = createSampleInvestigationApi();
  const report = await api.exportReport("sample-pr-partial-report");
  const artifact = report.artifacts[0];
  if (!artifact) throw new Error("The partial report omitted its artifact.");
  return { artifact, metadata: await api.artifact(artifact.id) };
}

async function imageFixture() {
  const { artifact, metadata } = await fixture();
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=",
    "base64",
  );
  const image = {
    ...artifact,
    id: "artifact:preview",
    kind: "image" as const,
    name: "screenshot.png",
    mediaType: "image/png",
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    availability: "available" as const,
  };
  return {
    artifact: image,
    metadata: { ...metadata, artifact: image, expiredAt: null },
    content: new Blob([bytes], { type: image.mediaType }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("current artifact availability", () => {
  it("preserves an inherited patch's producer identity and rejects reassignment to the child task", async () => {
    const { artifact, metadata } = await fixture();
    const inherited = {
      ...artifact,
      kind: "patch" as const,
      taskId: "ancestor-task",
      attemptId: "ancestor-attempt",
    };
    const current = { ...metadata, artifact: { ...inherited, availability: "expired" as const } };
    const html = renderToStaticMarkup(
      <ArtifactDetails
        artifact={inherited}
        metadata={current}
        busy={false}
        onDownload={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain("Producer task: ancestor-task");
    expect(html).toContain("Attempt: ancestor-attempt");
    expect(html).toContain("Current availability: expired");
    expect(html).not.toContain("Download artifact");
    expect(() => assertArtifactBinding(inherited, current)).not.toThrow();
    expect(() =>
      assertArtifactBinding(inherited, {
        ...current,
        artifact: { ...current.artifact, taskId: "child-task", attemptId: "child-attempt" },
      }),
    ).toThrow("does not match");
  });

  it("labels inherited patch inputs separately from this task's produced artifacts and validation", () => {
    const inherited = renderToStaticMarkup(<ArtifactPanel artifacts={[]} origin="inherited" />);
    const produced = renderToStaticMarkup(<ArtifactPanel artifacts={[]} />);
    expect(inherited).toContain("Inherited patch sources");
    expect(inherited).toContain("Patch inputs produced by ancestor tasks");
    expect(inherited).toContain("separate from this task&#x27;s validation evidence");
    expect(inherited).not.toContain("Artifacts produced by this task");
    expect(produced).toContain("Artifacts produced by this task");
    expect(produced).not.toContain("Inherited patch sources");
  });

  it("preserves the report snapshot while making expired content unavailable for download", async () => {
    const { artifact, metadata } = await fixture();
    const html = renderToStaticMarkup(
      <ArtifactDetails
        artifact={artifact}
        metadata={metadata}
        busy={false}
        onDownload={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain("Availability recorded in report: available");
    expect(html).toContain("Current availability: expired");
    expect(html).toContain("Artifact content expired");
    expect(html).toContain("historical report is unchanged");
    expect(html).not.toContain("Download artifact");
    expect(html).not.toContain("/content");
  });

  it("does not offer a download while availability is unverified or refreshing has failed", async () => {
    const { artifact, metadata } = await fixture();
    const available: InvestigationArtifactMetadataV1 = {
      ...metadata,
      artifact: { ...artifact, availability: "available" },
      expiredAt: null,
    };
    for (const state of [
      { metadata: undefined, error: undefined },
      { metadata: available, error: "Current availability could not be verified." },
    ]) {
      const html = renderToStaticMarkup(
        <ArtifactDetails
          artifact={artifact}
          {...state}
          busy={false}
          onDownload={() => {}}
          onRefresh={() => {}}
        />,
      );
      expect(html).not.toContain("Download artifact");
    }
  });

  it("accepts availability changes but rejects bytes or lineage from another artifact", async () => {
    const { artifact, metadata } = await fixture();
    expect(() => assertArtifactBinding(artifact, metadata)).not.toThrow();
    for (const changed of [
      { taskId: "another-task" },
      { subjectRef: "another-subject" },
      { digest: "f".repeat(64) },
      { byteLength: artifact.byteLength + 1 },
    ]) {
      expect(() =>
        assertArtifactBinding(artifact, {
          ...metadata,
          artifact: { ...metadata.artifact, ...changed },
        }),
      ).toThrow("does not match");
    }
  });
});

describe("artifact media preview", () => {
  it.each([
    ["image/png", "image"],
    ["image/jpeg", "image"],
    ["image/webp", "image"],
    ["image/gif", "image"],
    ["video/mp4", "video"],
    ["video/webm", "video"],
    ["video/quicktime", "video"],
  ] as const)("offers an inline %s preview while retaining download", async (mediaType, kind) => {
    const { artifact, metadata } = await imageFixture();
    const mediaArtifact = { ...artifact, mediaType };
    const html = renderToStaticMarkup(
      <ArtifactDetails
        artifact={mediaArtifact}
        metadata={{ ...metadata, artifact: mediaArtifact }}
        busy={false}
        onDownload={() => {}}
        onRefresh={() => {}}
        onPreview={() => {}}
      />,
    );
    expect(artifactPreviewKind(mediaType)).toBe(kind);
    expect(html).toContain(`Preview ${kind}`);
    expect(html).toContain("Download artifact");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
  });

  it("renders verified images and videos with native playback controls", async () => {
    const { artifact, metadata } = await imageFixture();
    for (const mediaType of ["image/png", "video/mp4", "video/webm", "video/quicktime"]) {
      const kind = artifactPreviewKind(mediaType);
      if (!kind) throw new Error("The fixture omitted a supported preview type.");
      const mediaArtifact = { ...artifact, mediaType };
      const html = renderToStaticMarkup(
        <ArtifactDetails
          artifact={mediaArtifact}
          metadata={{ ...metadata, artifact: mediaArtifact }}
          busy={false}
          onDownload={() => {}}
          onRefresh={() => {}}
          onClosePreview={() => {}}
          preview={{ kind, url: "blob:verified-preview" }}
        />,
      );
      expect(html).toContain(kind === "image" ? "<img" : "<video");
      expect(html).toContain('src="blob:verified-preview"');
      expect(html).toContain("Close preview");
      expect(html).toContain("Download artifact");
      if (kind === "video") {
        expect(html).toContain('controls=""');
        expect(html).toContain('preload="metadata"');
        expect(html).not.toContain("autoplay");
        expect(html).toContain("download the artifact to view it");
      }
    }
  });

  it.each(["image/svg+xml", "text/html", "application/pdf", "application/octet-stream"])(
    "keeps %s download-only even when a file has an image extension",
    async (mediaType) => {
      const { artifact, metadata } = await imageFixture();
      const mediaArtifact = { ...artifact, mediaType };
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected fetch."));
      const html = renderToStaticMarkup(
        <ArtifactDetails
          artifact={mediaArtifact}
          metadata={{ ...metadata, artifact: mediaArtifact }}
          busy={false}
          onDownload={() => {}}
          onRefresh={() => {}}
          onPreview={() => {}}
          preview={{ kind: "image", url: "blob:unused-preview" }}
        />,
      );
      expect(artifactPreviewKind(mediaType)).toBeUndefined();
      expect(html).toContain("Download artifact");
      expect(html).not.toContain("Preview image");
      expect(html).not.toContain("<img");
      await expect(
        createArtifactPreview(
          mediaArtifact,
          { ...metadata, artifact: mediaArtifact },
          new AbortController().signal,
        ),
      ).rejects.toThrow("download only");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("hides previews when availability cannot be verified and preserves download after a codec error", async () => {
    const { artifact, metadata } = await imageFixture();
    for (const state of [
      { metadata: undefined, error: undefined },
      { metadata, error: "Current availability could not be verified." },
      { metadata: { ...metadata, artifact: { ...artifact, availability: "expired" as const } } },
      { metadata: { ...metadata, artifact: { ...artifact, availability: "missing" as const } } },
    ]) {
      const html = renderToStaticMarkup(
        <ArtifactDetails
          artifact={artifact}
          {...state}
          busy={false}
          onDownload={() => {}}
          onRefresh={() => {}}
          onPreview={() => {}}
          preview={{ kind: "image", url: "blob:unavailable-preview" }}
        />,
      );
      expect(html).not.toContain("Preview image");
      expect(html).not.toContain("blob:unavailable-preview");
    }
    const html = renderToStaticMarkup(
      <ArtifactDetails
        artifact={artifact}
        metadata={metadata}
        busy={false}
        onDownload={() => {}}
        onRefresh={() => {}}
        previewError="This browser could not display the preview."
      />,
    );
    expect(html).toContain("This browser could not display the preview.");
    expect(html).toContain("Download artifact");
  });

  it("fetches the authenticated content endpoint and creates a revocable URL only for verified bytes", async () => {
    const { artifact, metadata, content } = await imageFixture();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(content));
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:verified-preview");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const preview = await createArtifactPreview(artifact, metadata, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/artifacts/artifact%3Apreview/content",
      expect.objectContaining({ credentials: "include", cache: "no-store", redirect: "error" }),
    );
    expect(preview).toMatchObject({ kind: "image", url: "blob:verified-preview" });
    expect(createUrl).toHaveBeenCalledOnce();
    const verified = createUrl.mock.calls[0]?.[0];
    expect(verified).toBeInstanceOf(Blob);
    expect((verified as Blob).type).toBe("image/png");
    expect(await (verified as Blob).arrayBuffer()).toEqual(await content.arrayBuffer());
    expect(revokeUrl).not.toHaveBeenCalled();
    preview.release();
    preview.release();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:verified-preview");
  });

  it("rejects unavailable or reassigned metadata before fetching content", async () => {
    const { artifact, metadata } = await imageFixture();
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fetch."));
    for (const changed of [
      { taskId: "another-task" },
      { subjectRef: "another-subject" },
      { digest: "f".repeat(64) },
      { availability: "expired" as const },
      { availability: "missing" as const },
    ]) {
      await expect(
        readVerifiedArtifactContent(
          artifact,
          { ...metadata, artifact: { ...artifact, ...changed } },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects incorrect response types, lengths, and digests without creating preview URLs", async () => {
    const { artifact, metadata, content } = await imageFixture();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const createUrl = vi.spyOn(URL, "createObjectURL");
    for (const response of [
      content.slice(0, content.size, "image/svg+xml"),
      content.slice(0, content.size - 1, "image/png"),
      new Blob([new Uint8Array(content.size)], { type: "image/png" }),
    ]) {
      fetcher.mockResolvedValueOnce(new Response(response));
      await expect(
        createArtifactPreview(artifact, metadata, new AbortController().signal),
      ).rejects.toThrow(/does not match|integrity check/u);
    }
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("does not adopt bytes that arrive after cancellation", async () => {
    const { artifact, metadata, content } = await imageFixture();
    let complete!: (content: Blob) => void;
    const response = new Response(content);
    const read = vi.spyOn(response, "blob").mockImplementation(
      () =>
        new Promise<Blob>((resolve) => {
          complete = resolve;
        }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const request = new AbortController();
    const pending = createArtifactPreview(artifact, metadata, request.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    request.abort();
    complete(content);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(createUrl).not.toHaveBeenCalled();
  });

  it("releases an active preview URL when its request owner is cancelled", async () => {
    const { artifact, metadata, content } = await imageFixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(content));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cancelled-preview");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const request = new AbortController();
    const preview = await createArtifactPreview(artifact, metadata, request.signal);
    request.abort();
    preview.release();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:cancelled-preview");
  });
});
