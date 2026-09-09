import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type RequestListener, type Server } from "node:http";
import type { RequestOptions } from "node:https";
import type { SecureContext } from "node:tls";
import { inspect } from "node:util";
import {
  type BeginEvidenceUploadRequest,
  type EvidenceAssetManifest,
  maximumEvidenceChunkBytes,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger.js";
import { ProtocolError, WorkerApiError } from "./errors.js";
import { HttpWorkerEvidenceApi, type WorkerEvidenceApiConfig } from "./evidence-api.js";

const workerToken = `arw1_${"a".repeat(43)}`;
const lease = {
  jobId: "job-1",
  runAttemptId: "attempt-1",
  workerNodeId: "node-1",
  workerInstanceId: "instance-1",
  leaseToken: "L".repeat(32),
  leaseGeneration: 1,
};
const time = "2026-09-07T00:00:00.000Z";
const metadata = {
  kind: "steps" as const,
  mediaType: "application/json" as const,
  sizeBytes: 2,
  sha256: createHash("sha256").update("{}").digest("hex"),
  capturedAt: time,
};
const begin: BeginEvidenceUploadRequest = { lease, clientAssetId: "local-1", metadata };
const manifest: EvidenceAssetManifest = {
  id: "asset-1",
  repositoryId: "repo-1",
  runId: "run-1",
  jobId: lease.jobId,
  runAttemptId: lease.runAttemptId,
  requestId: "request-1",
  profileVersionId: "profile-1",
  revisionKey: "a".repeat(64),
  planDigest: "b".repeat(64),
  metadata,
  state: "finalized",
  createdAt: time,
  finalizedAt: time,
  retiredAt: null,
};
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
async function fixture(handler: RequestListener): Promise<WorkerEvidenceApiConfig> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fixture did not listen.");
  return {
    serverUrl: new URL(`http://127.0.0.1:${address.port}`),
    workerToken,
    workerVersion: "test",
    requestTimeoutSeconds: 2,
    allowInsecureHttp: true,
  };
}
function logger(entries: unknown[] = []): Logger {
  return {
    debug: (message, fields) => entries.push({ message, fields }),
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

describe("authenticated evidence HTTP transport", () => {
  it("uses the three authenticated routes and accepts a maximum-size chunk", async () => {
    const calls: { path: string; body: unknown; headers: unknown; size: number }[] = [];
    const config = await fixture(async (request, response) => {
      const buffers: Buffer[] = [];
      for await (const part of request) buffers.push(Buffer.from(part));
      const bytes = Buffer.concat(buffers);
      const body = JSON.parse(bytes.toString("utf8"));
      calls.push({ path: request.url ?? "", body, headers: request.headers, size: bytes.length });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.endsWith("/finalize")
            ? manifest
            : {
                assetId: "asset-1",
                state: "uploading",
                offset: request.url?.endsWith("/chunks") ? maximumEvidenceChunkBytes : 0,
              },
        ),
      );
    });
    const logs: unknown[] = [];
    const api = new HttpWorkerEvidenceApi(config, logger(logs));
    expect((await api.beginUpload(begin)).assetId).toBe("asset-1");
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes, 42);
    expect(
      (
        await api.appendChunk({
          lease,
          assetId: "asset-1",
          offset: 0,
          base64: bytes.toString("base64"),
          chunkSha256: createHash("sha256").update(bytes).digest("hex"),
        })
      ).offset,
    ).toBe(maximumEvidenceChunkBytes);
    expect(await api.finalizeUpload({ lease, assetId: "asset-1" })).toEqual(manifest);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/worker/evidence/uploads",
      "/api/v1/worker/evidence/asset-1/chunks",
      "/api/v1/worker/evidence/asset-1/finalize",
    ]);
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
      });
      expect(call.size).toBeLessThan(1024 * 1024);
    }
    expect(inspect(logs)).not.toContain(workerToken);
    expect(inspect(logs)).not.toContain(lease.leaseToken);
  });

  it("reuses Server trust with verification enabled and no client credential material", async () => {
    const http = await fixture((_request, response) =>
      response.end(JSON.stringify({ assetId: "asset-1", offset: 0, state: "uploading" })),
    );
    const context = {} as SecureContext;
    const contexts = vi.fn().mockReturnValue(context);
    const options: RequestOptions[] = [];
    const config: WorkerEvidenceApiConfig = {
      ...http,
      serverUrl: new URL(http.serverUrl.href.replace("http:", "https:")),
      tls: {
        ca: Buffer.from("fixture-ca"),
        serverName: "worker.internal",
        rejectUnauthorized: true,
      },
    };
    const api = new HttpWorkerEvidenceApi(config, logger(), {
      createSecureContext: contexts,
      httpsRequest: (_url, input, callback) => {
        options.push(input);
        return httpRequest(http.serverUrl, input, callback);
      },
    });
    await api.beginUpload(begin);
    await api.beginUpload(begin);
    expect(contexts).toHaveBeenCalledOnce();
    expect(contexts).toHaveBeenCalledWith({ ca: config.tls?.ca });
    for (const value of options) {
      expect(value).toMatchObject({
        secureContext: context,
        servername: "worker.internal",
        rejectUnauthorized: true,
      });
      expect(value).not.toHaveProperty("cert");
      expect(value).not.toHaveProperty("key");
    }
  });

  it("rejects insecure or malformed transport configuration before making requests", async () => {
    const config = await fixture((_req, response) => response.end());
    expect(
      () => new HttpWorkerEvidenceApi({ ...config, allowInsecureHttp: false }, logger()),
    ).toThrow(ProtocolError);
    expect(
      () =>
        new HttpWorkerEvidenceApi(
          { ...config, serverUrl: new URL("https://example.com") },
          logger(),
        ),
    ).toThrow(ProtocolError);
    expect(
      () =>
        new HttpWorkerEvidenceApi(
          { ...config, serverUrl: new URL("http://user:secret@example.com") },
          logger(),
        ),
    ).toThrow(ProtocolError);
  });

  it.each([workerToken, lease.leaseToken])(
    "does not surface reflected authentication material",
    async (secret) => {
      const config = await fixture((_request, response) => {
        response.statusCode = 500;
        response.end(
          JSON.stringify({ error: { code: "upstream_failed", message: secret, retryable: true } }),
        );
      });
      const failure = await new HttpWorkerEvidenceApi(config, logger())
        .beginUpload(begin)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProtocolError);
      expect(inspect(failure, { depth: 5, showHidden: true })).not.toContain(secret);
    },
  );

  it("preserves safe error codes without retaining the error body or cause", async () => {
    const config = await fixture((_request, response) => {
      response.statusCode = 409;
      response.end(
        JSON.stringify({
          error: { code: "lease_lost", message: "private fixture body", retryable: false },
        }),
      );
    });
    const error = await new HttpWorkerEvidenceApi(config, logger())
      .beginUpload(begin)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(WorkerApiError);
    expect(error).toMatchObject({
      statusCode: 409,
      errorCode: "lease_lost",
      isLeaseLost: true,
      isRetryable: false,
    });
    expect(inspect(error, { depth: 5 })).not.toContain("private fixture body");
  });

  it("bounds response bytes and rejects invalid UTF-8", async () => {
    const oversized = await fixture((_request, response) => response.end("x".repeat(65537)));
    await expect(
      new HttpWorkerEvidenceApi(oversized, logger()).beginUpload(begin),
    ).rejects.toBeInstanceOf(ProtocolError);
    const invalid = await fixture((_request, response) =>
      response.end(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])),
    );
    await expect(
      new HttpWorkerEvidenceApi(invalid, logger()).beginUpload(begin),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it("enforces an absolute deadline despite a trickling response", async () => {
    const config = await fixture((_request, response) => {
      response.write("{");
      const timer = setInterval(() => response.write(" "), 5);
      response.once("close", () => clearInterval(timer));
    });
    await expect(
      new HttpWorkerEvidenceApi({ ...config, requestTimeoutSeconds: 0.04 }, logger()).beginUpload(
        begin,
      ),
    ).rejects.toMatchObject({ statusCode: 408 });
  });

  it("aborts before or during HTTP without reflecting signal reasons", async () => {
    const controller = new AbortController();
    const config = await fixture(() => controller.abort(new Error(lease.leaseToken)));
    const error = await new HttpWorkerEvidenceApi(config, logger())
      .beginUpload(begin, controller.signal)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ errorCode: "request_aborted", isRetryable: false });
    expect(inspect(error, { depth: 5 })).not.toContain(lease.leaseToken);
    const factory = vi.fn();
    await expect(
      new HttpWorkerEvidenceApi(config, logger(), { httpRequest: factory }).beginUpload(
        begin,
        controller.signal,
      ),
    ).rejects.toMatchObject({ errorCode: "request_aborted" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("sanitizes transport errors while preserving permanent TLS classification", async () => {
    const config = await fixture((_request, response) => response.end());
    const error = Object.assign(new Error(workerToken), { code: "CERT_HAS_EXPIRED" });
    const api = new HttpWorkerEvidenceApi(config, logger(), {
      httpRequest: () => {
        throw error;
      },
    });
    const failure = await api.beginUpload(begin).catch((failure: unknown) => failure);
    expect(failure).toMatchObject({ isRetryable: false });
    expect(inspect(failure, { depth: 5 })).not.toContain(workerToken);
  });
});

describe("evidence response contracts", () => {
  it.each([
    { assetId: "asset-1", offset: 3, state: "uploading" },
    { assetId: "asset-1", offset: 1, state: "finalized" },
    { assetId: "asset-1", offset: 0, state: "uploading", extra: true },
  ])("rejects impossible begin acknowledgement %#", async (body) => {
    const config = await fixture((_request, response) => response.end(JSON.stringify(body)));
    await expect(
      new HttpWorkerEvidenceApi(config, logger()).beginUpload(begin),
    ).rejects.toBeInstanceOf(ProtocolError);
  });
  it.each([
    { assetId: "other", offset: 2, state: "uploading" },
    { assetId: "asset-1", offset: 1, state: "uploading" },
    { assetId: "asset-1", offset: 2, state: "finalized" },
  ])("rejects a mismatched chunk acknowledgement %#", async (body) => {
    const config = await fixture((_request, response) => response.end(JSON.stringify(body)));
    await expect(
      new HttpWorkerEvidenceApi(config, logger()).appendChunk({
        lease,
        assetId: "asset-1",
        offset: 0,
        base64: "e30=",
        chunkSha256: metadata.sha256,
      }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });
  it.each([
    { id: "other" },
    { jobId: "other" },
    { runAttemptId: "other" },
    { state: "retired", retiredAt: time },
    { extra: true },
  ])("rejects a mismatched finalized manifest %#", async (change) => {
    const config = await fixture((_request, response) =>
      response.end(JSON.stringify({ ...manifest, ...change })),
    );
    await expect(
      new HttpWorkerEvidenceApi(config, logger()).finalizeUpload({ lease, assetId: "asset-1" }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });
});
