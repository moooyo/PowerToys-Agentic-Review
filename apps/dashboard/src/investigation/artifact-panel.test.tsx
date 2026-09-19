import { createHash } from "node:crypto";
import type { InvestigationArtifactMetadataV1 } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactDetails,
  ArtifactPanel,
  artifactPreviewKind,
  assertArtifactBinding,
  createArtifactPreview,
  createAutomaticImagePreviewBudget,
  evidenceAccessDenied,
  evidenceAccessQueryKey,
  maximumAutomaticImageBytes,
  observeAutomaticImagePreview,
  readVerifiedArtifactContent,
  useEvidenceAccessGate,
} from "./artifact-panel";
import { createSampleInvestigationApi } from "./sample-adapter";
import { InvestigationHttpError } from "./transport";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("artifact access revocation", () => {
  it("requires an explicit retry after denial, including after a reader remount", () => {
    const client = new QueryClient();
    const reader: { access?: ReturnType<typeof useEvidenceAccessGate> } = {};
    function Reader({ identity = "viewer" }: { identity?: string }) {
      const access = useEvidenceAccessGate(identity, "artifact", "artifact-one");
      reader.access = access;
      return <span>{access.denied ? "Access denied" : "Access allowed"}</span>;
    }
    const render = (identity = "viewer") =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <Reader identity={identity} />
        </QueryClientProvider>,
      );
    try {
      expect(render()).toContain("Access allowed");
      const access = reader.access;
      if (!access) throw new Error("The access reader was not rendered.");
      access.deny();
      expect(() => access.assertAllowed()).toThrow("explicit retry");
      expect(
        client.getQueryData(evidenceAccessQueryKey("viewer", "artifact", "artifact-one")),
      ).toBe(true);
      expect(render()).toContain("Access denied");
      expect(render("another-viewer")).toContain("Access allowed");
      expect(render()).toContain("Access denied");
      access.retry();
      expect(render()).toContain("Access allowed");
      expect(() => access.assertAllowed()).not.toThrow();
    } finally {
      client.clear();
    }
  });

  it("distinguishes access revocation from retryable storage failures", () => {
    expect(evidenceAccessDenied(new InvestigationHttpError(401, "Expired"))).toBe(true);
    expect(evidenceAccessDenied(new InvestigationHttpError(403, "Denied"))).toBe(true);
    expect(evidenceAccessDenied(new InvestigationHttpError(500, "Storage unavailable"))).toBe(
      false,
    );
    expect(evidenceAccessDenied(new Error("Integrity check failed"))).toBe(false);
  });
});

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

  it("identifies workspace records without implying that a saved report or publication exists", async () => {
    const { artifact, metadata } = await fixture();
    const html = renderToStaticMarkup(
      <ArtifactDetails
        artifact={artifact}
        metadata={metadata}
        recordSource="workspace"
        busy={false}
        onDownload={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain("Availability recorded in workspace");
    expect(html).toContain("workspace record is preserved");
    expect(html).toContain("Evidence source and digest");
    expect(html).toContain("SHA-256");
    expect(html).not.toContain("Availability recorded in report");
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
  it("limits automatic loads to four available allowlisted images of at most 8 MiB each", async () => {
    const { artifact } = await imageFixture();
    const budget = createAutomaticImagePreviewBudget();
    expect(budget.claim({ ...artifact, mediaType: "video/mp4" })).toBe(false);
    expect(budget.claim({ ...artifact, mediaType: "image/svg+xml" })).toBe(false);
    expect(budget.claim({ ...artifact, availability: "expired" })).toBe(false);
    expect(budget.claim({ ...artifact, availability: "missing" })).toBe(false);
    expect(budget.claim({ ...artifact, byteLength: maximumAutomaticImageBytes + 1 })).toBe(false);
    expect(budget.claim({ ...artifact, byteLength: 0 })).toBe(false);
    budget.suppress(artifact.id);
    expect(budget.claim(artifact)).toBe(false);
    for (let index = 0; index < 4; index += 1) {
      const image = {
        ...artifact,
        id: `automatic-image-${index}`,
        byteLength: maximumAutomaticImageBytes,
      };
      expect(budget.claim(image)).toBe(true);
      expect(budget.claim(image)).toBe(false);
    }
    expect(budget.claim({ ...artifact, id: "fifth-image" })).toBe(false);
  });

  it("waits for visibility and consumes each automatic attempt once, even across a reader restart", async () => {
    const { artifact, metadata } = await imageFixture();
    const element = {} as Element;
    let emit = (_entries: { target: Element; isIntersecting: boolean }[]) => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof emit) {
          emit = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const budget = createAutomaticImagePreviewBudget();
    const load = vi.fn();
    const stop = observeAutomaticImagePreview(element, artifact, metadata, budget, load);
    expect(observe).toHaveBeenCalledWith(element);
    expect(load).not.toHaveBeenCalled();
    emit([{ target: element, isIntersecting: false }]);
    expect(load).not.toHaveBeenCalled();
    emit([{ target: element, isIntersecting: true }]);
    expect(load).toHaveBeenCalledOnce();
    emit([{ target: element, isIntersecting: true }]);
    expect(load).toHaveBeenCalledOnce();
    stop();
    const stopAgain = observeAutomaticImagePreview(element, artifact, metadata, budget, load);
    emit([{ target: element, isIntersecting: true }]);
    expect(load).toHaveBeenCalledOnce();
    stopAgain();
    expect(disconnect).toHaveBeenCalled();
  });

  it("does not start an automatic load after leaving the view or for unavailable, rebound, or video content", async () => {
    const { artifact, metadata } = await imageFixture();
    const element = {} as Element;
    let emit = (_entries: { target: Element; isIntersecting: boolean }[]) => {};
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof emit) {
          emit = callback;
        }
        observe = observe;
        disconnect() {}
      },
    );
    const load = vi.fn();
    const budget = createAutomaticImagePreviewBudget();
    const stop = observeAutomaticImagePreview(element, artifact, metadata, budget, load);
    stop();
    emit([{ target: element, isIntersecting: true }]);
    expect(load).not.toHaveBeenCalled();
    observe.mockClear();
    const video = { ...artifact, mediaType: "video/mp4" };
    observeAutomaticImagePreview(element, video, { ...metadata, artifact: video }, budget, load);
    observeAutomaticImagePreview(
      element,
      artifact,
      { ...metadata, artifact: { ...artifact, availability: "expired" } },
      budget,
      load,
    );
    expect(() =>
      observeAutomaticImagePreview(
        element,
        artifact,
        { ...metadata, artifact: { ...artifact, taskId: "foreign-task" } },
        budget,
        load,
      ),
    ).toThrow("does not match");
    expect(observe).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

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
    expect(html).toContain(kind === "image" ? "Open screenshot" : "Play recording");
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
      } else {
        expect(html).toContain("Open screenshot");
        expect(html).toContain('aria-haspopup="dialog"');
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
      expect(html).not.toContain("Open screenshot");
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
      expect(html).not.toContain("Open screenshot");
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
