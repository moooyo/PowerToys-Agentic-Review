import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerEvaluationEvidenceRoutes } from "./evaluation-evidence.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";

const actor = { issuer: "https://identity.example.test", subject: "evaluation-viewer" };
const token = "E".repeat(43),
  timestamp = "2026-09-08T00:00:00.000Z";
const query = {
  repositoryId: "repo-a",
  evaluationId: "evaluation-a",
  cellId: "cell-a",
  resultId: "result-a",
};
const assetId = "asset-a";
const binding: C.EvaluationEvidenceBinding = {
  ...query,
  resultDigest: "a".repeat(64),
  runId: "run-a",
  requestId: "request-a",
  jobId: "job-a",
  runAttemptId: "attempt-a",
  profileVersionId: "profile-a",
  revisionKey: "b".repeat(64),
  planDigest: "c".repeat(64),
};
const listPath = `/api/v1/operator/repositories/${query.repositoryId}/evaluations/${query.evaluationId}/cells/${query.cellId}/results/${query.resultId}/evidence`;
const assetPath = `${listPath}/${assetId}`,
  contentPath = `${assetPath}/content`;
const headers = { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` };
const bytes = Buffer.from("A scoped evaluation evidence stream.\n");
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const privateMessage = "private/evidence storage-secret arw1_" + "a".repeat(43);

function manifest(content = bytes): C.EvidenceAssetManifest {
  return {
    id: assetId,
    repositoryId: binding.repositoryId,
    runId: binding.runId,
    requestId: binding.requestId,
    jobId: binding.jobId,
    runAttemptId: binding.runAttemptId,
    profileVersionId: binding.profileVersionId,
    revisionKey: binding.revisionKey,
    planDigest: binding.planDigest,
    metadata: {
      kind: "log",
      mediaType: "text/plain",
      sizeBytes: content.length,
      sha256: hash(content),
      capturedAt: timestamp,
      checkId: `${binding.profileVersionId}:compile`,
    },
    state: "finalized",
    createdAt: timestamp,
    finalizedAt: timestamp,
    retiredAt: null,
  };
}
function asset(value = manifest()): C.EvaluationResultEvidenceAssetV1 {
  return {
    schemaVersion: "EvaluationResultEvidenceAssetV1",
    binding: structuredClone(binding),
    assetId,
    checkIds: [`${binding.profileVersionId}:compile`],
    manifest: value,
  };
}
function list(value = manifest()): C.EvaluationResultEvidenceListV1 {
  return {
    schemaVersion: "EvaluationResultEvidenceListV1",
    binding: structuredClone(binding),
    items: [{ assetId, checkIds: [`${binding.profileVersionId}:compile`], manifest: value }],
  };
}
function chunk(content = bytes, value = manifest(content), offset = 0) {
  const selected = content.subarray(offset, offset + C.maximumEvidenceChunkBytes);
  return {
    binding: structuredClone(binding),
    manifest: value,
    offset,
    base64: selected.toString("base64"),
    eof: offset + selected.length === content.length,
  };
}
function auth(authenticated = true): OperatorAuthRouteService {
  const session = {
    ...actor,
    displayName: "Evaluation Viewer",
    email: null,
    createdAt: timestamp,
    expiresAt: "2026-09-09T00:00:00.000Z",
  };
  return {
    publicOrigin: "https://review.example.test",
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: () => undefined,
    startLogin: async () => ({ kind: "session", sessionToken: token, session }),
    completeLogin: async () => {
      throw new Error("Unused authentication callback.");
    },
    getSession: vi.fn(async (value) => (authenticated && value === token ? session : null)),
    logout: async () => undefined,
  };
}
const apps: FastifyInstance[] = [];
function fixture(
  implementation: (operation: string, input: unknown) => Promise<unknown>,
  configure?: (app: FastifyInstance, shutdown: AbortController) => void,
  authenticated = true,
) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const database = createOperatorRouteTestDatabase(actor, implementation);
  const shutdown = new AbortController();
  configure?.(app, shutdown);
  const operatorAuth = auth(authenticated);
  registerOperatorAuthRoutes(app, operatorAuth);
  registerEvaluationEvidenceRoutes(app, {
    database: database.database,
    operatorAuth,
    shutdownSignal: shutdown.signal,
  });
  return { app, shutdown, ...database };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function privateHeaders(response: { headers: Record<string, unknown> }) {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers.location).toBeUndefined();
}
function safeError(
  response: { statusCode: number; body: string; json(): unknown },
  status: number,
  code: string,
) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toMatchObject({ code });
  for (const secret of ["private/evidence", "storage-secret", "arw1_", token])
    expect(response.body).not.toContain(secret);
}

describe("evaluation evidence read routes", () => {
  it.each([listPath, assetPath, contentPath])(
    "requires a real session before reading %s",
    async (url) => {
      const value = fixture(
        async () => {
          throw new Error("No RPC should be made.");
        },
        undefined,
        false,
      );
      const response = await value.app.inject({ method: "GET", url, headers });
      safeError(response, 401, "operator_authentication_required");
      privateHeaders(response);
      expect(value.transport).not.toHaveBeenCalled();
    },
  );

  it.each(["list", "manifest"] as const)(
    "binds the actual actor and exact result scope for %s",
    async (kind) => {
      const expected = kind === "list" ? list() : asset();
      const value = fixture(async () => expected);
      const response = await value.app.inject({
        method: "GET",
        url: kind === "list" ? listPath : assetPath,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      privateHeaders(response);
      expect(value.request).toHaveBeenCalledExactlyOnceWith(
        kind === "list" ? "listEvaluationResultEvidence" : "getEvaluationResultEvidenceAsset",
        { ...query, ...(kind === "manifest" ? { assetId } : {}), actor },
      );
    },
  );

  it("keeps a missing referenced asset explicit in the list", async () => {
    const expected = list();
    expected.items[0] = {
      assetId,
      checkIds: [`${binding.profileVersionId}:compile`],
      manifest: null,
    };
    const value = fixture(async () => expected);
    const response = await value.app.inject({ method: "GET", url: listPath, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
  });

  it.each([listPath, assetPath, contentPath])(
    "rejects query fields on %s before RPC",
    async (url) => {
      const value = fixture(async () => list());
      const response = await value.app.inject({
        method: "GET",
        url: `${url}?actor=platform-admin`,
        headers,
      });
      safeError(response, 400, "evidence_invalid");
      expect(value.request).not.toHaveBeenCalled();
    },
  );

  it.each(["repositoryId", "evaluationId", "cellId", "resultId"] as const)(
    "rejects a valid-shaped response from another %s",
    async (field) => {
      const expected = list();
      expected.binding[field] = "another-identity";
      if (field === "repositoryId" && expected.items[0]?.manifest)
        expected.items[0].manifest.repositoryId = "another-identity";
      const value = fixture(async () => expected);
      const response = await value.app.inject({ method: "GET", url: listPath, headers });
      safeError(response, 502, "evidence_response_invalid");
    },
  );

  it.each(["asset", "check", "manifest", "extra", "null"])(
    "rejects an invalid manifest response: %s",
    async (failure) => {
      const expected = asset();
      const output =
        failure === "null"
          ? null
          : failure === "extra"
            ? { ...expected, location: "https://untrusted.example.test" }
            : expected;
      if (failure === "asset") {
        expected.assetId = "another-asset";
        expected.manifest.id = "another-asset";
      }
      if (failure === "check") expected.checkIds = [`${binding.profileVersionId}:another-check`];
      if (failure === "manifest") expected.manifest.runAttemptId = "another-attempt";
      const value = fixture(async () => output);
      const response = await value.app.inject({ method: "GET", url: assetPath, headers });
      safeError(response, 502, "evidence_response_invalid");
      expect(response.headers.location).toBeUndefined();
    },
  );

  it.each([
    ["PLATFORM_NOT_FOUND", 404, "platform_not_found"],
    ["PLATFORM_FORBIDDEN", 403, "platform_forbidden"],
    ["PLATFORM_CORRUPT", 502, "evidence_response_invalid"],
    ["PLATFORM_INVALID", 400, "evidence_invalid"],
  ] as const)("retains the safe owner error %s", async (code, status, publicCode) => {
    const value = fixture(async () => {
      throw new DatabaseRequestError(privateMessage, code);
    });
    const response = await value.app.inject({ method: "GET", url: contentPath, headers });
    safeError(response, status, publicCode);
    privateHeaders(response);
    expect(response.headers["content-disposition"]).toBeUndefined();
  });

  it("retains retired metadata while refusing content before a chunk request", async () => {
    const retired = { ...manifest(), state: "retired" as const, retiredAt: timestamp };
    const value = fixture(async () => asset(retired));
    expect((await value.app.inject({ method: "GET", url: assetPath, headers })).statusCode).toBe(
      200,
    );
    const response = await value.app.inject({ method: "GET", url: contentPath, headers });
    safeError(response, 410, "evidence_retired");
    expect(
      value.request.mock.calls.every(
        ([operation]) => operation === "getEvaluationResultEvidenceAsset",
      ),
    ).toBe(true);
  });
});

describe("evaluation evidence shares the bounded integrity stream", () => {
  it.each([
    ["screenshot", "image/png", "inline", "png"],
    ["trace", "application/zip", "attachment", "zip"],
    ["steps", "application/json", "attachment", "json"],
    ["log", "text/plain", "attachment", "txt"],
  ] as const)(
    "serves %s using its exact binary bytes and safe headers",
    async (kind, mediaType, disposition, extension) => {
      const metadata = manifest();
      metadata.metadata = { ...metadata.metadata, kind, mediaType } as C.EvidenceAssetMetadata;
      const value = fixture(async (operation) =>
        operation === "getEvaluationResultEvidenceAsset" ? asset(metadata) : chunk(bytes, metadata),
      );
      const response = await value.app.inject({ method: "GET", url: contentPath, headers });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      privateHeaders(response);
      expect(response.headers["content-type"]?.split(";")[0]).toBe(mediaType);
      expect(response.headers["content-length"]).toBe(String(bytes.length));
      expect(response.headers["content-disposition"]).toBe(
        `${disposition}; filename="${assetId}.${extension}"`,
      );
      expect(response.headers["accept-ranges"]).toBe("none");
      expect(value.request.mock.calls).toEqual([
        ["getEvaluationResultEvidenceAsset", { ...query, assetId, actor }],
        [
          "readEvaluationResultEvidenceChunk",
          { ...query, assetId, actor, offset: 0, maximumBytes: C.maximumEvidenceChunkBytes },
        ],
      ]);
    },
  );

  it.each([C.maximumEvidenceChunkBytes, C.maximumEvidenceChunkBytes * 2 + 17])(
    "streams %s bytes without an empty trailing request",
    async (length) => {
      const content = Buffer.alloc(length, 41),
        metadata = manifest(content);
      const value = fixture(async (operation, input) =>
        operation === "getEvaluationResultEvidenceAsset"
          ? asset(metadata)
          : chunk(content, metadata, (input as { offset: number }).offset),
      );
      const response = await value.app.inject({ method: "GET", url: contentPath, headers });
      expect(response.rawPayload).toEqual(content);
      const offsets = Array.from(
        { length: Math.ceil(length / C.maximumEvidenceChunkBytes) },
        (_, index) => index * C.maximumEvidenceChunkBytes,
      );
      expect(value.request.mock.calls.slice(1)).toEqual(
        offsets.map((offset) => [
          "readEvaluationResultEvidenceChunk",
          { ...query, assetId, actor, offset, maximumBytes: C.maximumEvidenceChunkBytes },
        ]),
      );
    },
  );

  it.each(["range", "if-range"])(
    "rejects %s rather than returning an unchecked range",
    async (header) => {
      const value = fixture(async () => asset());
      const response = await value.app.inject({
        method: "GET",
        url: contentPath,
        headers: { ...headers, [header]: "bytes=0-1" },
      });
      safeError(response, 416, "evidence_range_not_supported");
      expect(value.request).not.toHaveBeenCalled();
    },
  );

  it.each(["binding", "manifest", "offset", "base64", "short", "eof", "digest", "extra"])(
    "rejects first-chunk %s before sending binary headers",
    async (failure) => {
      const output = chunk();
      if (failure === "binding") output.binding.resultDigest = "f".repeat(64);
      if (failure === "manifest")
        output.manifest = { ...output.manifest, createdAt: "2026-09-08T00:00:01.000Z" };
      if (failure === "offset") output.offset = 1;
      if (failure === "base64") output.base64 += "\n";
      if (failure === "short") output.base64 = bytes.subarray(1).toString("base64");
      if (failure === "eof") output.eof = false;
      if (failure === "digest") output.base64 = Buffer.alloc(bytes.length, 99).toString("base64");
      const value = fixture(async (operation) =>
        operation === "getEvaluationResultEvidenceAsset"
          ? asset()
          : failure === "extra"
            ? { ...output, location: "https://untrusted.example.test" }
            : output,
      );
      const response = await value.app.inject({ method: "GET", url: contentPath, headers });
      safeError(response, 502, "evidence_response_invalid");
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["content-disposition"]).toBeUndefined();
    },
  );

  it.each(Object.keys(binding) as (keyof C.EvaluationEvidenceBinding)[])(
    "pins binding field %s across chunks",
    async (field) => {
      const content = Buffer.alloc(C.maximumEvidenceChunkBytes + 11, 51),
        metadata = manifest(content);
      const emitted: Buffer[] = [];
      const value = fixture(
        async (operation, input) => {
          if (operation === "getEvaluationResultEvidenceAsset") return asset(metadata);
          const offset = (input as { offset: number }).offset,
            output = chunk(content, metadata, offset);
          if (offset > 0)
            output.binding[field] =
              field.endsWith("Digest") || field === "revisionKey"
                ? "f".repeat(64)
                : "another-identity";
          return output;
        },
        (app) =>
          app.addHook("onSend", async (_request, _reply, payload) => {
            if (payload instanceof Readable)
              payload.on("data", (part: Buffer) => emitted.push(Buffer.from(part)));
            return payload;
          }),
      );
      await expect(
        value.app.inject({ method: "GET", url: contentPath, headers }),
      ).rejects.toThrow();
      expect(Buffer.concat(emitted)).toEqual(content.subarray(0, C.maximumEvidenceChunkBytes));
      expect(value.request).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["manifest", "offset", "base64", "short", "eof", "digest"])(
    "aborts rather than emitting an invalid later %s",
    async (failure) => {
      const content = Buffer.alloc(C.maximumEvidenceChunkBytes + 11, 61),
        metadata = manifest(content);
      const value = fixture(async (operation, input) => {
        if (operation === "getEvaluationResultEvidenceAsset") return asset(metadata);
        const offset = (input as { offset: number }).offset,
          output = chunk(content, metadata, offset);
        if (offset > 0) {
          if (failure === "manifest")
            output.manifest = { ...metadata, profileVersionId: "another-profile" };
          if (failure === "offset") output.offset++;
          if (failure === "base64") output.base64 += "\n";
          if (failure === "short") output.base64 = content.subarray(offset + 1).toString("base64");
          if (failure === "eof") output.eof = false;
          if (failure === "digest") output.base64 = Buffer.alloc(11, 62).toString("base64");
        }
        return output;
      });
      await expect(
        value.app.inject({ method: "GET", url: contentPath, headers }),
      ).rejects.toThrow();
      expect(value.request).toHaveBeenCalledTimes(3);
    },
  );

  it("stops after the first authorized chunk when repository access is revoked", async () => {
    const content = Buffer.alloc(C.maximumEvidenceChunkBytes + 17, 71),
      metadata = manifest(content);
    let revoked = false;
    const emitted: Buffer[] = [];
    const value = fixture(
      async (operation, input) => {
        if (revoked) throw new DatabaseRequestError(privateMessage, "PLATFORM_NOT_FOUND");
        return operation === "getEvaluationResultEvidenceAsset"
          ? asset(metadata)
          : chunk(content, metadata, (input as { offset: number }).offset);
      },
      (app) =>
        app.addHook("onSend", async (_request, _reply, payload) => {
          if (payload instanceof Readable)
            payload.on("data", (part: Buffer) => {
              emitted.push(Buffer.from(part));
              revoked = true;
            });
          return payload;
        }),
    );
    await expect(value.app.inject({ method: "GET", url: contentPath, headers })).rejects.toThrow();
    expect(Buffer.concat(emitted)).toEqual(content.subarray(0, C.maximumEvidenceChunkBytes));
    expect(value.request.mock.calls.at(-1)).toEqual([
      "readEvaluationResultEvidenceChunk",
      {
        ...query,
        assetId,
        actor,
        offset: C.maximumEvidenceChunkBytes,
        maximumBytes: C.maximumEvidenceChunkBytes,
      },
    ]);
  });

  it.each(["disconnect", "shutdown"])("stops the shared stream on %s", async (condition) => {
    const content = Buffer.alloc(C.maximumEvidenceChunkBytes * 3, 81),
      metadata = manifest(content);
    const emitted: Buffer[] = [];
    const value = fixture(
      async (operation, input) =>
        operation === "getEvaluationResultEvidenceAsset"
          ? asset(metadata)
          : chunk(content, metadata, (input as { offset: number }).offset),
      (app, shutdown) =>
        app.addHook("onSend", async (_request, reply, payload) => {
          if (payload instanceof Readable)
            payload.on("data", (part: Buffer) => {
              emitted.push(Buffer.from(part));
              if (condition === "disconnect") reply.raw.destroy();
              else shutdown.abort();
            });
          return payload;
        }),
    );
    await expect(value.app.inject({ method: "GET", url: contentPath, headers })).rejects.toThrow();
    expect(Buffer.concat(emitted)).toEqual(content.subarray(0, C.maximumEvidenceChunkBytes));
    expect(
      value.request.mock.calls.filter(
        ([operation]) => operation === "readEvaluationResultEvidenceChunk",
      ),
    ).toEqual([
      [
        "readEvaluationResultEvidenceChunk",
        { ...query, assetId, actor, offset: 0, maximumBytes: C.maximumEvidenceChunkBytes },
      ],
    ]);
  });

  it.each(["disconnect", "shutdown"])(
    "ignores a pending later chunk after %s without reading another chunk",
    async (condition) => {
      const content = Buffer.alloc(C.maximumEvidenceChunkBytes * 3, 91),
        metadata = manifest(content);
      const emitted: Buffer[] = [];
      const firstConsumed = Promise.withResolvers<void>();
      const secondStarted = Promise.withResolvers<void>();
      const secondChunk = Promise.withResolvers<ReturnType<typeof chunk>>();
      const streamClosed = Promise.withResolvers<void>();
      const responseClosed = Promise.withResolvers<void>();
      let rawResponse: FastifyReply["raw"] | undefined;
      const value = fixture(
        async (operation, input) => {
          if (operation === "getEvaluationResultEvidenceAsset") return asset(metadata);
          const offset = (input as { offset: number }).offset;
          if (offset === C.maximumEvidenceChunkBytes) {
            secondStarted.resolve();
            return secondChunk.promise;
          }
          return chunk(content, metadata, offset);
        },
        (app) =>
          app.addHook("onSend", async (_request, reply, payload) => {
            if (payload instanceof Readable) {
              rawResponse = reply.raw;
              reply.raw.once("close", () => responseClosed.resolve());
              payload.once("close", () => streamClosed.resolve());
              payload.on("data", (part: Buffer) => {
                emitted.push(Buffer.from(part));
                firstConsumed.resolve();
              });
            }
            return payload;
          }),
      );
      const pending = value.app.inject({ method: "GET", url: contentPath, headers }).then(
        () => ({ completed: true }),
        (error: unknown) => ({ completed: false, error }),
      );
      try {
        await Promise.all([firstConsumed.promise, secondStarted.promise]);
        expect(Buffer.concat(emitted)).toEqual(content.subarray(0, C.maximumEvidenceChunkBytes));
        expect(rawResponse).toBeDefined();
        if (condition === "disconnect") rawResponse?.destroy();
        else value.shutdown.abort();
        await Promise.all([streamClosed.promise, responseClosed.promise]);
        expect(rawResponse?.destroyed).toBe(true);
        secondChunk.resolve(chunk(content, metadata, C.maximumEvidenceChunkBytes));
        await setImmediate();
        expect(await pending).toMatchObject({ completed: false, error: expect.any(Error) });
        expect(Buffer.concat(emitted)).toEqual(content.subarray(0, C.maximumEvidenceChunkBytes));
        expect(
          value.request.mock.calls
            .filter(([operation]) => operation === "readEvaluationResultEvidenceChunk")
            .map(([, input]) => (input as { offset: number }).offset),
        ).toEqual([0, C.maximumEvidenceChunkBytes]);
      } finally {
        secondChunk.resolve(chunk(content, metadata, C.maximumEvidenceChunkBytes));
        value.shutdown.abort();
        rawResponse?.destroy();
        await pending;
      }
    },
  );

  it("cancels a pending first chunk on shutdown and ignores its late completion", async () => {
    let started!: () => void, finish!: (value: ReturnType<typeof chunk>) => void;
    const pendingRead = new Promise<void>((resolve) => {
      started = resolve;
    });
    const value = fixture(async (operation) => {
      if (operation === "getEvaluationResultEvidenceAsset") return asset();
      started();
      return new Promise<ReturnType<typeof chunk>>((resolve) => {
        finish = resolve;
      });
    });
    const pending = value.app.inject({ method: "GET", url: contentPath, headers });
    await pendingRead;
    value.shutdown.abort();
    const response = await pending;
    safeError(response, 503, "evidence_unavailable");
    expect(response.headers["content-disposition"]).toBeUndefined();
    finish(chunk());
    await setImmediate();
    expect(value.request).toHaveBeenCalledTimes(2);
  });
});
