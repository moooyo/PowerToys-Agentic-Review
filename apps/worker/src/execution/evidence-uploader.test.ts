import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  type EvidenceAssetManifest,
  maximumEvidenceChunkBytes,
  type UiScenarioExecutionEvidenceV1,
} from "@agentic-review/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtocolError, WorkerApiError } from "../server-client/errors.js";
import { type EvidenceApi, HttpWorkerEvidenceApi } from "../server-client/evidence-api.js";
import {
  EvidenceUploadError,
  EvidenceUploader,
  type EvidenceUploadInput,
  type LocalEvidenceFile,
} from "./evidence-uploader.js";

const fixedFileTimestamps = vi.hoisted(
  () => new Map<string, { mtimeNs: bigint; ctimeNs: bigint }>(),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  function preserveTimestamps<T>(path: unknown, stat: T): T {
    const fixed = typeof path === "string" ? fixedFileTimestamps.get(path) : undefined;
    if (fixed !== undefined && stat !== null && typeof stat === "object" && "mtimeNs" in stat) {
      Object.assign(stat, fixed);
    }
    return stat;
  }
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) =>
      preserveTimestamps(args[0], await actual.lstat(...args)),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (typeof args[0] === "string" && fixedFileTimestamps.has(args[0])) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async (...options: Parameters<typeof handle.stat>) =>
          preserveTimestamps(args[0], await stat(...options))) as typeof handle.stat;
      }
      return handle;
    },
  };
});

const time = "2026-09-07T00:00:00.000Z";
const lease = {
  jobId: "job-1",
  runAttemptId: "attempt-1",
  workerNodeId: "node-1",
  workerInstanceId: "instance-1",
  leaseToken: "L".repeat(32),
  leaseGeneration: 1,
};
const scope = {
  repositoryId: "repo-1",
  runId: "run-1",
  requestId: "request-1",
  profileVersionId: "profile-1",
  revisionKey: "a".repeat(64),
  planDigest: "b".repeat(64),
};
let root = "";
let evidenceDirectory = "";
beforeEach(async () => {
  // Windows runner TEMP can use a short-name or redirected directory alias.
  root = await mkdtemp(join(await realpath(tmpdir()), "evidence-uploader-test-"));
  evidenceDirectory = join(root, "owned");
  await mkdir(evidenceDirectory);
});
afterEach(async () => {
  fixedFileTimestamps.clear();
  await rm(root, { recursive: true, force: true });
});
async function file(id = "local-1", bytes = Buffer.from("{}")): Promise<LocalEvidenceFile> {
  const relativePath = `${id}.json`;
  await writeFile(join(evidenceDirectory, relativePath), bytes);
  return {
    id,
    relativePath,
    kind: "ui_steps",
    mediaType: "application/json",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    checkId: "profile-1:scenario-1",
  };
}
function input(
  files: LocalEvidenceFile[],
  signal = new AbortController().signal,
): EvidenceUploadInput {
  return { lease, scope, evidenceDirectory, capturedAt: time, files, signal };
}
function harness() {
  const metadata = new Map<string, Parameters<EvidenceApi["beginUpload"]>[0]["metadata"]>();
  const chunks = new Map<string, Map<number, Buffer>>();
  const api = {
    beginUpload: vi.fn<EvidenceApi["beginUpload"]>().mockImplementation(async (request) => {
      const id = `server-${request.clientAssetId}`;
      metadata.set(id, request.metadata);
      chunks.set(id, new Map());
      return { assetId: id, state: "uploading", offset: 0 };
    }),
    appendChunk: vi.fn<EvidenceApi["appendChunk"]>().mockImplementation(async (request) => {
      const bytes = Buffer.from(request.base64, "base64");
      expect(bytes.length).toBeLessThanOrEqual(maximumEvidenceChunkBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(request.chunkSha256);
      chunks.get(request.assetId)?.set(request.offset, bytes);
      return {
        assetId: request.assetId,
        offset: request.offset + bytes.length,
        state: "uploading",
      };
    }),
    finalizeUpload: vi.fn<EvidenceApi["finalizeUpload"]>().mockImplementation(async (request) => {
      const value = metadata.get(request.assetId);
      if (value === undefined) throw new Error("Missing fixture metadata.");
      return {
        id: request.assetId,
        ...scope,
        jobId: lease.jobId,
        runAttemptId: lease.runAttemptId,
        metadata: value,
        state: "finalized",
        createdAt: time,
        finalizedAt: time,
        retiredAt: null,
      };
    }),
  } satisfies EvidenceApi;
  return { api, metadata, chunks, uploader: new EvidenceUploader({ api, retryBaseDelayMs: 0 }) };
}

describe("bounded evidence streaming", () => {
  it("uploads through real loopback HTTP with a committed chunk whose acknowledgement is lost", async () => {
    const local = await file(
      "http-fixture",
      Buffer.from(JSON.stringify({ fixture: "x".repeat(maximumEvidenceChunkBytes) })),
    );
    const uploaded = new Map<number, Buffer>();
    let storedMetadata: EvidenceAssetManifest["metadata"] | undefined;
    let ambiguousResponses = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== "Bearer fixture-worker-token") {
        response.statusCode = 401;
        response.end("{}");
        return;
      }
      if (request.url?.endsWith("/uploads")) {
        storedMetadata = body.metadata;
        response.end(JSON.stringify({ assetId: "http-asset", offset: 0, state: "uploading" }));
        return;
      }
      if (request.url?.endsWith("/chunks")) {
        const bytes = Buffer.from(body.base64, "base64");
        uploaded.set(body.offset, bytes);
        if (body.offset === 0 && ambiguousResponses++ === 0) {
          response.statusCode = 503;
          response.end(
            JSON.stringify({
              error: {
                code: "temporary_unavailable",
                message: "Fixture acknowledgement lost.",
                retryable: true,
              },
            }),
          );
          return;
        }
        response.end(
          JSON.stringify({
            assetId: "http-asset",
            offset: body.offset + bytes.length,
            state: "uploading",
          }),
        );
        return;
      }
      const allBytes = Buffer.concat(
        [...uploaded.entries()].sort(([left], [right]) => left - right).map(([, bytes]) => bytes),
      );
      if (createHash("sha256").update(allBytes).digest("hex") !== storedMetadata?.sha256) {
        response.statusCode = 422;
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify({
          id: "http-asset",
          ...scope,
          jobId: lease.jobId,
          runAttemptId: lease.runAttemptId,
          metadata: storedMetadata,
          state: "finalized",
          createdAt: time,
          finalizedAt: time,
          retiredAt: null,
        }),
      );
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Fixture did not listen.");
      const api = new HttpWorkerEvidenceApi(
        {
          serverUrl: new URL(`http://127.0.0.1:${address.port}`),
          workerToken: "fixture-worker-token",
          workerVersion: "test",
          requestTimeoutSeconds: 2,
          allowInsecureHttp: true,
        },
        {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      );
      const result = await new EvidenceUploader({ api, retryBaseDelayMs: 0 }).upload(
        input([local]),
      );
      expect(result.assetIds).toEqual({ "http-fixture": "http-asset" });
      expect(uploaded.size).toBe(2);
      expect(ambiguousResponses).toBe(2);
      expect(result.assets[0]?.metadata.sha256).toBe(local.sha256);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
  it("streams multiple bounded chunks and maps only finalized Server identities", async () => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes * 2 + 17, 42);
    const local = await file("local-1", bytes);
    const h = harness();
    const progress = vi.fn();
    const result = await h.uploader.upload({ ...input([local]), onChunkProgress: progress });
    expect(result.assetIds).toEqual({ "local-1": "server-local-1" });
    expect(result.assets[0]?.metadata).toMatchObject({
      kind: "steps",
      checkId: local.checkId,
      capturedAt: time,
      sha256: local.sha256,
    });
    expect(h.api.appendChunk).toHaveBeenCalledTimes(3);
    expect(Buffer.concat([...(h.chunks.get("server-local-1")?.values() ?? [])])).toEqual(bytes);
    expect(progress.mock.calls.map((call) => call[0].uploadedBytes)).toEqual([
      maximumEvidenceChunkBytes,
      maximumEvidenceChunkBytes * 2,
      bytes.length,
    ]);
    expect(h.api.finalizeUpload).toHaveBeenCalledAfter(h.api.appendChunk);
  });

  it("rejects a wrong digest before sending any upload request", async () => {
    const local = await file();
    const h = harness();
    await expect(
      h.uploader.upload(input([{ ...local, sha256: "c".repeat(64) }])),
    ).rejects.toMatchObject({ code: "DIGEST_MISMATCH", partial: { assetIds: {}, assets: [] } });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });

  it("retries an ambiguous acknowledgement at the same offset without duplicating content", async () => {
    const local = await file();
    const h = harness();
    const append = h.api.appendChunk.getMockImplementation();
    h.api.appendChunk.mockImplementationOnce(async (request, signal) => {
      await append?.(request, signal);
      throw new WorkerApiError("Response lost.", 503);
    });
    const result = await h.uploader.upload(input([local]));
    expect(result.assets).toHaveLength(1);
    expect(h.api.appendChunk).toHaveBeenCalledTimes(2);
    expect(h.api.appendChunk.mock.calls[0]?.[0]).toEqual(h.api.appendChunk.mock.calls[1]?.[0]);
    expect(h.chunks.get("server-local-1")?.size).toBe(1);
  });

  it("resumes an arbitrary acknowledged offset while rehashing the whole captured file", async () => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes + 37, 42);
    const local = await file("local-1", bytes);
    const h = harness();
    const begin = h.api.beginUpload.getMockImplementation();
    h.api.beginUpload.mockImplementation(async (request, signal) => {
      const started = await begin?.(request, signal);
      if (started === undefined) throw new Error("Missing fixture.");
      return { ...started, offset: 17 };
    });
    await h.uploader.upload(input([local]));
    expect(h.api.appendChunk.mock.calls[0]?.[0].offset).toBe(17);
    expect(Buffer.concat([...(h.chunks.get("server-local-1")?.values() ?? [])])).toEqual(
      bytes.subarray(17),
    );
  });

  it("retrieves and verifies an already finalized asset without appending more bytes", async () => {
    const local = await file();
    const h = harness();
    const begin = h.api.beginUpload.getMockImplementation();
    h.api.beginUpload.mockImplementation(async (request, signal) => {
      const started = await begin?.(request, signal);
      if (started === undefined) throw new Error("Missing fixture.");
      return { ...started, offset: local.sizeBytes, state: "finalized" };
    });
    expect((await h.uploader.upload(input([local]))).assets).toHaveLength(1);
    expect(h.api.appendChunk).not.toHaveBeenCalled();
    expect(h.api.finalizeUpload).toHaveBeenCalledOnce();
  });

  it("rejects changed bytes before finalization even if the initial hash matched", async () => {
    const local = await file();
    const h = harness();
    const append = h.api.appendChunk.getMockImplementation();
    h.api.appendChunk.mockImplementation(async (request, signal) => {
      const ack = await append?.(request, signal);
      await writeFile(join(evidenceDirectory, local.relativePath), "[]");
      if (ack === undefined) throw new Error("Missing fixture.");
      return ack;
    });
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
      code: "FILE_CHANGED",
      partial: { assetIds: {} },
    });
    expect(h.api.finalizeUpload).not.toHaveBeenCalled();
  });

  it("rejects changed bytes before finalization even when file timestamps are unchanged", async () => {
    const local = await file();
    const path = join(evidenceDirectory, local.relativePath);
    const initial = await lstat(path, { bigint: true });
    // Only this real file's timestamps are held constant. Reads, writes, size and inode checks
    // remain real, reproducing a same-size rewrite within one filesystem timestamp interval.
    fixedFileTimestamps.set(path, { mtimeNs: initial.mtimeNs, ctimeNs: initial.ctimeNs });
    const h = harness();
    const append = h.api.appendChunk.getMockImplementation();
    h.api.appendChunk.mockImplementation(async (request, signal) => {
      const acknowledgement = await append?.(request, signal);
      await writeFile(path, "[]");
      const changed = await lstat(path, { bigint: true });
      expect(changed.size).toBe(initial.size);
      expect(changed.ino).toBe(initial.ino);
      expect(changed.mtimeNs).toBe(initial.mtimeNs);
      expect(changed.ctimeNs).toBe(initial.ctimeNs);
      if (acknowledgement === undefined) throw new Error("Missing fixture acknowledgement.");
      return acknowledgement;
    });
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
      code: "FILE_CHANGED",
      partial: { assetIds: {}, assets: [] },
    });
    expect(await readFile(path, "utf8")).toBe("[]");
    expect(h.api.appendChunk).toHaveBeenCalledOnce();
    expect(h.api.finalizeUpload).not.toHaveBeenCalled();
  });

  it("preserves completed assets after a later upload fails", async () => {
    const files = [await file("first"), await file("second")];
    const h = harness();
    const begin = h.api.beginUpload.getMockImplementation();
    h.api.beginUpload.mockImplementation(async (request, signal) => {
      if (request.clientAssetId === "second") throw new WorkerApiError("Unavailable.", 503);
      const started = await begin?.(request, signal);
      if (started === undefined) throw new Error("Missing fixture.");
      return started;
    });
    const failure = await h.uploader.upload(input(files)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EvidenceUploadError);
    expect(failure).toMatchObject({
      code: "UPLOAD_FAILED",
      localAssetId: "second",
      isRetryable: true,
      partial: {
        assetIds: { first: "server-first" },
        assets: [expect.objectContaining({ id: "server-first" })],
      },
    });
    expect(h.api.beginUpload).toHaveBeenCalledTimes(4);
    expect(h.api.finalizeUpload).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 409, 422])(
    "does not retry HTTP %s even with an incorrect retryable override",
    async (status) => {
      const local = await file();
      const h = harness();
      h.api.beginUpload.mockRejectedValue(
        new WorkerApiError("Rejected.", status, "rejected", { retryable: true }),
      );
      await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
        code: "UPLOAD_FAILED",
        isRetryable: false,
      });
      expect(h.api.beginUpload).toHaveBeenCalledOnce();
    },
  );

  it("limits retries to three and preserves lease-loss classification", async () => {
    const local = await file();
    const h = harness();
    h.api.beginUpload.mockRejectedValue(new WorkerApiError("Unavailable.", 503));
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      isRetryable: true,
    });
    expect(h.api.beginUpload).toHaveBeenCalledTimes(3);
    h.api.beginUpload.mockClear().mockRejectedValue(new WorkerApiError("Lost.", 409, "lease_lost"));
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
      isLeaseLost: true,
      isRetryable: false,
    });
    expect(h.api.beginUpload).toHaveBeenCalledOnce();
  });

  it("never retries malformed protocol responses", async () => {
    const local = await file();
    const h = harness();
    h.api.beginUpload.mockRejectedValue(new ProtocolError("Invalid response."));
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });
    expect(h.api.beginUpload).toHaveBeenCalledOnce();
  });

  it("aborts during retries and progress without leaking signal or callback reasons", async () => {
    const local = await file();
    const h = harness();
    const controller = new AbortController();
    h.api.beginUpload.mockImplementation(async () => {
      controller.abort(new Error(lease.leaseToken));
      throw new WorkerApiError("Unavailable.", 503);
    });
    const error = await h.uploader
      .upload(input([local], controller.signal))
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "ABORTED" });
    expect(inspect(error, { depth: 8 })).not.toContain(lease.leaseToken);
    expect(h.api.beginUpload).toHaveBeenCalledOnce();
    const second = harness();
    const callbackError = await second.uploader
      .upload({
        ...input([local]),
        onChunkProgress: () => {
          throw new Error(lease.leaseToken);
        },
      })
      .catch((error: unknown) => error);
    expect(callbackError).toMatchObject({ code: "PROGRESS_FAILED" });
    expect(inspect(callbackError, { depth: 8 })).not.toContain(lease.leaseToken);
    expect(second.api.finalizeUpload).not.toHaveBeenCalled();
  });
});

describe("owned evidence file boundary", () => {
  it("rejects aggregate, asset, screenshot and count quotas before reading files", async () => {
    const local = await file();
    const h = harness();
    const oversized = { ...local, sizeBytes: 64 * 1024 * 1024 + 1 };
    await expect(h.uploader.upload(input([oversized]))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      h.uploader.upload(
        input([
          { ...local, kind: "screenshot", mediaType: "image/png", sizeBytes: 16 * 1024 * 1024 + 1 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      h.uploader.upload(
        input(
          Array.from({ length: 3 }, (_, index) => ({
            ...local,
            id: `file-${index}`,
            relativePath: `file-${index}.json`,
            sizeBytes: 64 * 1024 * 1024,
          })),
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      h.uploader.upload(
        input(
          Array.from({ length: 257 }, (_, index) => ({
            ...local,
            id: `file-${index}`,
            relativePath: `file-${index}.json`,
          })),
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });
  it.each([
    "../outside.json",
    "/outside.json",
    "C:/outside.json",
    "safe/../../outside.json",
    "safe\\outside.json",
    "safe//outside.json",
    "safe/./outside.json",
    "CON.json",
    "safe/file.json:stream",
  ])("rejects unsafe relative path %s", async (relativePath) => {
    const local = await file();
    const h = harness();
    await expect(h.uploader.upload(input([{ ...local, relativePath }]))).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });
  it("rejects hard-linked files, directories and size mismatches", async () => {
    const local = await file();
    const h = harness();
    await link(join(evidenceDirectory, local.relativePath), join(root, "outside.json"));
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({ code: "INVALID_PATH" });
    const fresh = await file("fresh");
    await mkdir(join(evidenceDirectory, "directory.json"));
    await expect(
      h.uploader.upload(input([{ ...fresh, relativePath: "directory.json" }])),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(h.uploader.upload(input([{ ...fresh, sizeBytes: 10 }]))).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });
  it("rejects symlinked parent directories before reading outside content", async () => {
    const local = await file();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "value.json"), "{}");
    await symlink(
      outside,
      join(evidenceDirectory, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const h = harness();
    await expect(
      h.uploader.upload(input([{ ...local, relativePath: "link/value.json" }])),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });
  it("rejects duplicate local identities and file paths before uploading anything", async () => {
    const local = await file();
    const h = harness();
    await expect(h.uploader.upload(input([local, local]))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      h.uploader.upload(input([local, { ...local, id: "other" }])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });
});

describe("UI evidence reference normalization", () => {
  async function scenario(target: "web" | "windows_desktop" = "web") {
    const execution: UiScenarioExecutionEvidenceV1 = {
      schemaVersion: "UiScenarioExecutionEvidenceV1",
      source: "ui_driver",
      target,
      scenarioId: "scenario-1",
      steps: [
        {
          stepId: "visible",
          name: "Result visible",
          action: "assertVisible",
          expected: true,
          actual: true,
          outcome: "passed",
          summary: "The assertion passed.",
          evidenceIds: ["shot-1"],
        },
      ],
    };
    const steps = await file("steps-1", Buffer.from(JSON.stringify(execution)));
    const screenshotBytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
    await writeFile(join(evidenceDirectory, "shot-1.png"), screenshotBytes);
    const screenshot: LocalEvidenceFile = {
      id: "shot-1",
      relativePath: "shot-1.png",
      kind: "screenshot",
      mediaType: "image/png",
      sizeBytes: screenshotBytes.length,
      sha256: createHash("sha256").update(screenshotBytes).digest("hex"),
    };
    return { ...input([steps, screenshot]), execution, steps, screenshot };
  }
  it.each(["web", "windows_desktop"] as const)(
    "rewrites %s references only after screenshot finalization and preserves original evidence",
    async (target) => {
      const value = await scenario(target);
      const h = harness();
      const original = await readFile(join(evidenceDirectory, value.steps.relativePath));
      const result = await h.uploader.uploadUiScenarioEvidence(value);
      expect(h.api.beginUpload.mock.calls.map((call) => call[0].clientAssetId)).toEqual([
        "shot-1",
        "steps-1",
      ]);
      expect(result.assetIds).toEqual({ "shot-1": "server-shot-1", "steps-1": "server-steps-1" });
      const uploaded = Buffer.concat([...(h.chunks.get("server-steps-1")?.values() ?? [])]);
      const execution = JSON.parse(uploaded.toString("utf8"));
      expect(execution.steps[0].evidenceIds).toEqual(["server-shot-1"]);
      expect(value.execution.steps[0]?.evidenceIds).toEqual(["shot-1"]);
      expect(await readFile(join(evidenceDirectory, value.steps.relativePath))).toEqual(original);
      expect(result.assets.find((asset) => asset.id === "server-steps-1")?.metadata.sha256).toBe(
        createHash("sha256").update(uploaded).digest("hex"),
      );
      expect(
        result.assets.find((asset) => asset.id === "server-steps-1")?.metadata.sha256,
      ).not.toBe(value.steps.sha256);
      expect(
        result.assets.every((asset) => asset.metadata.checkId === "profile-1:scenario-1"),
      ).toBe(true);
      expect(
        (await readdir(evidenceDirectory)).filter((path) => path.startsWith("normalized-")).length,
      ).toBe(1);
    },
  );
  it("rejects an unmapped local reference before uploading any asset", async () => {
    const value = await scenario();
    const h = harness();
    value.execution.steps[0]?.evidenceIds.push("missing-local-id");
    await expect(h.uploader.uploadUiScenarioEvidence(value)).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      partial: { assetIds: {}, assets: [] },
    });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });
  it("rejects original structured content that differs from the parsed driver evidence", async () => {
    const value = await scenario();
    const h = harness();
    const step = value.execution.steps[0];
    if (step?.action === "assertVisible") step.actual = false;
    await expect(h.uploader.uploadUiScenarioEvidence(value)).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      partial: { assetIds: {} },
    });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });
  it("keeps only finalized screenshot mappings when normalized steps cannot finalize", async () => {
    const value = await scenario();
    const h = harness();
    const finalize = h.api.finalizeUpload.getMockImplementation();
    h.api.finalizeUpload.mockImplementation(async (request, signal) => {
      if (request.assetId === "server-steps-1")
        throw new WorkerApiError("Lost lease.", 409, "lease_lost");
      const result = await finalize?.(request, signal);
      if (result === undefined) throw new Error("Missing fixture.");
      return result;
    });
    await expect(h.uploader.uploadUiScenarioEvidence(value)).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      isLeaseLost: true,
      partial: {
        assetIds: { "shot-1": "server-shot-1" },
        assets: [expect.objectContaining({ id: "server-shot-1" })],
      },
    });
    expect(await readFile(join(evidenceDirectory, value.steps.relativePath))).toEqual(
      Buffer.from(JSON.stringify(value.execution)),
    );
  });
  it("does not create normalized evidence when a prerequisite screenshot failed", async () => {
    const value = await scenario();
    const h = harness();
    h.api.beginUpload.mockRejectedValue(new WorkerApiError("Denied.", 403));
    await expect(h.uploader.uploadUiScenarioEvidence(value)).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      partial: { assetIds: {} },
    });
    expect((await readdir(evidenceDirectory)).some((path) => path.startsWith("normalized-"))).toBe(
      false,
    );
  });
  it("requires exactly one bounded structured file and the authoritative scenario check", async () => {
    const value = await scenario();
    const h = harness();
    await expect(
      h.uploader.uploadUiScenarioEvidence({ ...value, files: [value.screenshot] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      h.uploader.uploadUiScenarioEvidence({
        ...value,
        files: [{ ...value.steps, sizeBytes: 512 * 1024 + 1 }, value.screenshot],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      h.uploader.uploadUiScenarioEvidence({
        ...value,
        files: [{ ...value.steps, checkId: "profile-1:other" }, value.screenshot],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.api.beginUpload).not.toHaveBeenCalled();
  });
});

describe("finalized manifest correlation", () => {
  it.each([
    "repositoryId",
    "runId",
    "requestId",
    "profileVersionId",
    "jobId",
    "runAttemptId",
    "revisionKey",
    "planDigest",
  ])("rejects a manifest for another %s", async (field) => {
    const local = await file();
    const h = harness();
    const finalize = h.api.finalizeUpload.getMockImplementation();
    h.api.finalizeUpload.mockImplementation(
      async (request, signal) =>
        ({
          ...(await finalize?.(request, signal)),
          [field]: field.endsWith("Key") || field.endsWith("Digest") ? "c".repeat(64) : "other",
        }) as EvidenceAssetManifest,
    );
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      partial: { assetIds: {}, assets: [] },
    });
  });
  it.each([
    { sha256: "c".repeat(64) },
    { sizeBytes: 3 },
    { checkId: "profile-1:other" },
    { capturedAt: "2026-09-07T00:00:01.000Z" },
    { kind: "log", mediaType: "text/plain" },
  ])("rejects mismatched immutable metadata %#", async (change) => {
    const local = await file();
    const h = harness();
    const finalize = h.api.finalizeUpload.getMockImplementation();
    h.api.finalizeUpload.mockImplementation(async (request, signal) => {
      const manifest = await finalize?.(request, signal);
      return {
        ...manifest,
        metadata: { ...manifest?.metadata, ...change },
      } as EvidenceAssetManifest;
    });
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      partial: { assetIds: {} },
    });
  });
  it("rejects wrong append offsets before finalizing", async () => {
    const local = await file();
    const h = harness();
    h.api.appendChunk.mockResolvedValue({
      assetId: "server-local-1",
      state: "uploading",
      offset: 1,
    });
    await expect(h.uploader.upload(input([local]))).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      partial: { assetIds: {} },
    });
    expect(h.api.finalizeUpload).not.toHaveBeenCalled();
  });
});
