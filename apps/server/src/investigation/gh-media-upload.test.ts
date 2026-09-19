import { createHash } from "node:crypto";
import type { InvestigationArtifactV1 } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubMediaUploader,
  isGitHubMediaUrl,
  validateInvestigationMedia,
} from "./gh-media-upload.js";

const repository = { id: "repo-test", fullName: "fixture/example", githubRepositoryId: 123 };
const url = "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";
const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
function artifact(
  bytes = png,
  mediaType = "image/png",
  name = "evidence.png",
): InvestigationArtifactV1 {
  return {
    id: "artifact-test",
    taskId: "task-test",
    attemptId: "attempt-test",
    subjectRef: "subject-test",
    kind: mediaType === "image/png" ? "image" : "video",
    name,
    mediaType,
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    availability: "available",
  };
}
function harness(upload: () => Promise<Response> = async () => Response.json({ url })) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const value = String(input);
    if (value === "https://api.github.com/user") return Response.json({ id: 42 });
    if (value === "https://api.github.com/repos/fixture/example")
      return Response.json({
        id: 123,
        full_name: "fixture/example",
        permissions: { push: true },
        parent: { id: 987, full_name: "upstream/example" },
      });
    return upload();
  });
  return {
    fetch,
    uploader: new GitHubMediaUploader({
      token: "synthetic-test-token",
      expectedGitHubUserId: 42,
      fetch,
    }),
  };
}

describe("GitHub E2E upload-only transport", () => {
  it("uploads the exact bytes to the numeric fork and returns a trusted URL without touching comments", async () => {
    const { fetch, uploader } = harness();
    const before = vi.fn();
    expect(
      await uploader.upload({ repository, artifact: artifact(), content: png }, before),
    ).toEqual({ state: "uploaded", url });
    expect(before).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    const [endpoint, init] = fetch.mock.calls[2]!;
    expect(String(endpoint)).toContain("https://uploads.github.com/user-attachments/assets?");
    expect(new URL(String(endpoint)).searchParams.get("repository_id")).toBe("123");
    expect(new URL(String(endpoint)).searchParams.get("content_type")).toBe("image/png");
    expect(init?.method).toBe("POST");
    expect(init?.body).toEqual(png);
    expect(init?.redirect).toBe("error");
    expect(
      fetch.mock.calls.every(
        ([input]) => !String(input).includes("upstream") && !String(input).includes("comments"),
      ),
    ).toBe(true);
  });

  it.each([401, 403, 404, 422, 429])(
    "records explicit HTTP %s rejection without guessing upload success",
    async (status) => {
      const { uploader } = harness(async () => new Response(null, { status }));
      expect(
        await uploader.upload({ repository, artifact: artifact(), content: png }, () => undefined),
      ).toEqual({ state: "rejected", code: `media_http_${status}`, retryable: status === 429 });
    },
  );

  it.each([408, 500, 502])(
    "does not make a repeated mutation after ambiguous HTTP %s",
    async (status) => {
      const { fetch, uploader } = harness(async () => new Response(null, { status }));
      expect(
        await uploader.upload({ repository, artifact: artifact(), content: png }, () => undefined),
      ).toMatchObject({ state: "unknown", retryable: false });
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it("keeps a lost response unknown and never returns raw transport errors or credentials", async () => {
    const { uploader } = harness(async () => {
      throw new Error("synthetic-test-token secret transport body");
    });
    const result = await uploader.upload(
      { repository, artifact: artifact(), content: png },
      () => undefined,
    );
    expect(result).toEqual({
      state: "unknown",
      code: "media_upload_effect_unknown",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects identity drift before any mutation", async () => {
    const { fetch, uploader } = harness();
    fetch.mockImplementation(async () => Response.json({ id: 99 }));
    const before = vi.fn();
    expect(
      await uploader.upload({ repository, artifact: artifact(), content: png }, before),
    ).toMatchObject({ state: "blocked", code: "media_publisher_identity_changed" });
    expect(before).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not accept a remote-controlled URL or HTML as a successful receipt", async () => {
    const { uploader } = harness(async () =>
      Response.json({ url: "https://example.invalid/video.mp4" }),
    );
    expect(
      await uploader.upload({ repository, artifact: artifact(), content: png }, () => undefined),
    ).toMatchObject({ state: "unknown", code: "media_upload_receipt_invalid" });
    expect(isGitHubMediaUrl(`${url}?token=untrusted`)).toBe(false);
    expect(
      isGitHubMediaUrl(
        `https://github.com@attacker.invalid/user-attachments/assets/11111111-2222-3333-4444-555555555555`,
      ),
    ).toBe(false);
  });

  it("checks hash, provenance metadata and file signatures before preflight", async () => {
    const { fetch, uploader } = harness();
    expect(
      await uploader.upload(
        { repository, artifact: { ...artifact(), digest: "0".repeat(64) }, content: png },
        () => undefined,
      ),
    ).toMatchObject({ state: "blocked", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      validateInvestigationMedia(
        artifact(Buffer.from("not a screenshot")),
        Buffer.from("not a screenshot"),
      ),
    ).toThrow("media_container_invalid");
    expect(() => validateInvestigationMedia({ ...artifact(), name: "../image.png" }, png)).toThrow(
      "media_identity_invalid",
    );
  });

  it.each([
    [
      "video/mp4",
      "capture.mp4",
      Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex"),
    ],
    [
      "video/quicktime",
      "capture.mov",
      Buffer.from("0000001466747970717420200000000071742020", "hex"),
    ],
    ["video/webm", "capture.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from("webm")])],
  ])("accepts the supported %s media container", (mediaType, name, bytes) => {
    expect(() => validateInvestigationMedia(artifact(bytes, mediaType, name), bytes)).not.toThrow();
  });
});
