import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import {
  type AppendEvidenceChunkRequest,
  type BeginEvidenceUploadRequest,
  type EvidenceAssetManifest,
  type EvidenceAssetMetadata,
  type EvidenceUploadResponse,
  type FinalizeEvidenceUploadRequest,
  maximumAttemptEvidenceAssets,
  maximumEvidenceAssetBytes,
  maximumEvidenceChunkBytes,
  maximumScreenshotBytes,
} from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/database-client.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { EvidenceAssetOperationMap, EvidenceAssetScope } from "../database/evidence-assets.js";
import type { OperatorRequestInput } from "../database/operator-request.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import {
  registerOperatorEvidenceRoutes,
  registerWorkerEvidenceRoutes,
  WORKER_EVIDENCE_REQUESTS_PER_MINUTE,
} from "./evidence-assets.js";

const timestamp = "2026-09-07T00:00:00.000Z";
const publicOrigin = "https://review.example.com";
const sessionToken = "S".repeat(43);
const workerToken = `arw1_${Buffer.alloc(32, 9).toString("base64url")}`;
const otherWorkerToken = `arw1_${Buffer.alloc(32, 10).toString("base64url")}`;
const assetId = "evidence-asset-1";
const scope: EvidenceAssetScope = {
  repositoryId: "repository-1",
  runId: "review-run-1",
  jobId: "job-1",
  runAttemptId: "run-attempt-1",
};
const lease = {
  jobId: scope.jobId,
  runAttemptId: scope.runAttemptId,
  workerNodeId: "worker-node-1",
  workerInstanceId: "worker-instance-1",
  leaseToken: "lease-secret-".repeat(4),
  leaseGeneration: 3,
};
const otherWorkerNodeId = "worker-node-2";
const hash = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");
const content = Buffer.from(
  "Evidence collected from an authenticated validation attempt.\n",
  "utf8",
);
const metadata: EvidenceAssetMetadata = {
  kind: "log",
  mediaType: "text/plain",
  sizeBytes: content.length,
  sha256: hash(content),
  capturedAt: timestamp,
  checkId: "build:compile",
};
const manifest: EvidenceAssetManifest = {
  ...scope,
  id: assetId,
  requestId: "validation-request-1",
  profileVersionId: "profile-version-1",
  revisionKey: "a".repeat(64),
  planDigest: "b".repeat(64),
  metadata,
  state: "finalized",
  createdAt: timestamp,
  finalizedAt: timestamp,
  retiredAt: null,
};
const beginRequest = {
  lease,
  clientAssetId: "client-asset-1",
  metadata,
} satisfies BeginEvidenceUploadRequest;
const appendRequest = {
  lease,
  assetId,
  offset: 0,
  base64: content.toString("base64"),
  chunkSha256: hash(content),
} satisfies AppendEvidenceChunkRequest;
const finalizeRequest = { lease, assetId } satisfies FinalizeEvidenceUploadRequest;
const uploadResponse = { assetId, offset: 0, state: "uploading" } satisfies EvidenceUploadResponse;
const uploadsPath = "/api/v1/worker/evidence/uploads";
const chunksPath = `/api/v1/worker/evidence/${assetId}/chunks`;
const finalizePath = `/api/v1/worker/evidence/${assetId}/finalize`;
const evidencePathFor = (value: EvidenceAssetScope): string =>
  `/api/v1/operator/repositories/${value.repositoryId}/review-runs/${value.runId}/jobs/${value.jobId}/attempts/${value.runAttemptId}/evidence`;
const evidencePath = evidencePathFor(scope);
const manifestPath = `${evidencePath}/${assetId}`;
const contentPath = `${manifestPath}/content`;
type ReadChunk = EvidenceAssetOperationMap["readEvidenceAssetChunk"]["output"];
type ChunkInput = EvidenceAssetOperationMap["readEvidenceAssetChunk"]["input"];

const makeChunk = (bytes: Buffer, value = manifest, offset = 0): ReadChunk => ({
  manifest: value,
  offset,
  base64: bytes.toString("base64"),
  eof: offset + bytes.length === value.metadata.sizeBytes,
});
const makeManifest = (
  bytes: Buffer,
  facts: EvidenceAssetMetadata = metadata,
): EvidenceAssetManifest => ({
  ...manifest,
  metadata: { ...facts, sizeBytes: bytes.length, sha256: hash(bytes) },
});
const session: OperatorSession = {
  issuer: "https://identity.example.com",
  subject: "operator-1",
  displayName: "Test Operator",
  email: "operator@example.com",
  createdAt: timestamp,
  expiresAt: "2026-09-07T01:00:00.000Z",
};
const actor = { issuer: session.issuer, subject: session.subject };
const envelope = (operation: string, input: unknown) => ({
  context: { kind: "operator", actor },
  operation,
  input,
});
const createAuth = (authenticated = true): OperatorAuthRouteService => ({
  publicOrigin,
  postLoginRedirectPath: "/",
  requiresLoopbackRequest: false,
  secureCookies: true,
  usesBrowserBinding: false,
  ensureBrowserBinding: vi.fn(() => undefined),
  startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken, session })),
  completeLogin: vi.fn(async () => {
    throw new Error("Login callbacks are not used by evidence route tests.");
  }),
  getSession: vi.fn(async (token) => (authenticated && token === sessionToken ? session : null)),
  logout: vi.fn(async () => undefined),
});

const createDatabase = (
  implementation?: (operation: string, input: unknown) => Promise<unknown>,
  authenticate?: (input: unknown) => Promise<unknown>,
) => {
  const evidenceRequest = vi.fn(
    implementation ??
      (async (operation: string) => {
        throw new Error(`Unexpected evidence operation: ${operation}`);
      }),
  );
  const authenticateRequest = vi.fn(
    authenticate ??
      (async (input: unknown) => {
        const digest = (input as { workerTokenSha256: string }).workerTokenSha256;
        if (digest === hash(workerToken)) {
          return {
            outcome: "authenticated",
            workerNodeId: lease.workerNodeId,
            authState: "active",
          };
        }
        if (digest === hash(otherWorkerToken)) {
          return { outcome: "authenticated", workerNodeId: otherWorkerNodeId, authState: "active" };
        }
        return { outcome: "rejected" };
      }),
  );
  const request = vi.fn(async (operation: string, input: unknown) => {
    if (operation === "authenticateWorkerToken") return authenticateRequest(input);
    if (
      ["beginEvidenceUpload", "appendEvidenceChunk", "finalizeEvidenceUpload"].includes(operation)
    )
      return evidenceRequest(operation, input);
    expect(operation).toBe("operatorRequest");
    expect(input).toEqual(envelope(expect.any(String), expect.anything()));
    const authorized = input as OperatorRequestInput;
    expect(["listEvidenceAssets", "getEvidenceAsset", "readEvidenceAssetChunk"]).toContain(
      authorized.operation,
    );
    return evidenceRequest(authorized.operation, authorized.input);
  });
  return {
    database: { request } as unknown as DatabaseClient,
    request,
    evidenceRequest,
    authenticateRequest,
  };
};

const apps: FastifyInstance[] = [];
const createApp = (
  options: {
    readonly database?: DatabaseClient;
    readonly auth?: OperatorAuthRouteService;
    readonly recoveryMaintenance?: boolean;
    readonly configureApp?: (app: FastifyInstance) => void;
  } = {},
) => {
  const app = Fastify({ logger: false });
  apps.push(app);
  options.configureApp?.(app);
  const auth = options.auth ?? createAuth();
  const database = options.database ?? createDatabase().database;
  const shutdown = new AbortController();
  registerOperatorAuthRoutes(app, auth);
  registerWorkerEvidenceRoutes(app, {
    database,
    config: { recoveryMaintenance: options.recoveryMaintenance ?? false },
    shutdownSignal: shutdown.signal,
  });
  registerOperatorEvidenceRoutes(app, {
    database,
    operatorAuth: auth,
    shutdownSignal: shutdown.signal,
  });
  return { app, auth, shutdown };
};
const workerHeaders = (token = workerToken) => ({ authorization: `Bearer ${token}` });
const cookieHeaders = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${sessionToken}` });
const expectPrivateResponse = (response: { headers: Record<string, unknown> }): void => {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
};
const expectSafeError = (
  response: { statusCode: number; body: string; json(): unknown },
  statusCode: number,
  code: string,
): void => {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toMatchObject({ code, retryable: false });
  expect(response.body).not.toContain("private/evidence");
  expect(response.body).not.toContain("storage-secret");
  expect(response.body).not.toContain(workerToken);
  expect(response.body).not.toContain(lease.leaseToken);
};

const workerRoutes = [
  {
    name: "begin",
    url: uploadsPath,
    payload: beginRequest,
    operation: "beginEvidenceUpload",
    output: uploadResponse,
  },
  {
    name: "append",
    url: chunksPath,
    payload: appendRequest,
    operation: "appendEvidenceChunk",
    output: { ...uploadResponse, offset: content.length },
  },
  {
    name: "finalize",
    url: finalizePath,
    payload: finalizeRequest,
    operation: "finalizeEvidenceUpload",
    output: manifest,
  },
] as const;
const operatorRoutes = [
  {
    name: "list",
    url: evidencePath,
    operation: "listEvidenceAssets",
    input: scope,
    output: { items: [manifest] },
  },
  {
    name: "manifest",
    url: manifestPath,
    operation: "getEvidenceAsset",
    input: { ...scope, assetId },
    output: manifest,
  },
  {
    name: "content",
    url: contentPath,
    operation: "readEvidenceAssetChunk",
    input: { ...scope, assetId, offset: 0, maximumBytes: maximumEvidenceChunkBytes },
    output: makeChunk(content),
  },
] as const;
const databaseErrors = [
  ["EVIDENCE_INVALID", 400, "evidence_invalid"],
  ["EVIDENCE_LEASE_REJECTED", 409, "evidence_lease_rejected"],
  ["EVIDENCE_CONFLICT", 409, "evidence_conflict"],
  ["EVIDENCE_QUOTA", 413, "evidence_quota"],
  ["EVIDENCE_UNAVAILABLE", 503, "evidence_unavailable"],
  ["EVIDENCE_NOT_FOUND", 404, "evidence_not_found"],
  ["UNRECOGNIZED_PRIVATE_ERROR", 500, "evidence_operation_failed"],
] as const;
const privateErrorMessage = `/private/evidence/storage-secret: ${workerToken} ${lease.leaseToken}`;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("asynchronous evidence verification HTTP errors", () => {
  const routes = [
    {
      method: "POST",
      url: finalizePath,
      headers: workerHeaders(),
      payload: finalizeRequest,
      operation: "finalizeEvidenceUpload",
    },
    {
      method: "GET",
      url: contentPath,
      headers: cookieHeaders(),
      operation: "readEvidenceAssetChunk",
    },
  ] as const;

  it.each([
    "EVIDENCE_VERIFIER_BUSY",
    "EVIDENCE_VERIFIER_TIMEOUT",
    "EVIDENCE_VERIFIER_CANCELLED",
    "EVIDENCE_VERIFIER_UNAVAILABLE",
    "EVIDENCE_VERIFIER_SHUTDOWN",
    "DATABASE_WORKER_SHUTTING_DOWN",
  ])("exposes %s as a bounded retry for finalize and operator download", async (code) => {
    for (const route of routes) {
      const { database, evidenceRequest } = createDatabase(async () => {
        await Promise.resolve();
        throw Object.assign(new DatabaseRequestError(privateErrorMessage, code), {
          cause: new Error(privateErrorMessage),
        });
      });
      const { app } = createApp({ database });
      const response = await app.inject(route);
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.json()).toMatchObject({ code: code.toLowerCase(), retryable: true });
      expect(response.body).not.toContain("private/evidence");
      expect(response.body).not.toContain("storage-secret");
      expect(response.body).not.toContain(workerToken);
      expect(response.body).not.toContain(lease.leaseToken);
      expect(evidenceRequest).toHaveBeenCalledExactlyOnceWith(route.operation, expect.any(Object));
      if (route.method === "GET") expectPrivateResponse(response);
    }
  });

  it.each([
    ["EVIDENCE_INVALID_SNAPSHOT", 400],
    ["EVIDENCE_FILE_UNAVAILABLE", 404],
    ["EVIDENCE_FILE_CHANGED", 409],
    ["EVIDENCE_INTEGRITY_FAILED", 409],
    ["EVIDENCE_SCENARIO_MISMATCH", 409],
    ["EVIDENCE_VERIFIER_PROTOCOL", 503],
  ] as const)(
    "does not advertise broken evidence or verifier protocol as retryable: %s",
    async (code, statusCode) => {
      for (const route of routes) {
        const { database, evidenceRequest } = createDatabase(async () => {
          throw new DatabaseRequestError(privateErrorMessage, code);
        });
        const { app } = createApp({ database });
        const response = await app.inject(route);
        expectSafeError(response, statusCode, code.toLowerCase());
        expect(response.headers["retry-after"]).toBeUndefined();
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.headers["content-disposition"]).toBeUndefined();
        expect(evidenceRequest).toHaveBeenCalledOnce();
      }
    },
  );
});

describe("Worker evidence routes", () => {
  it.each(workerRoutes)("authenticates and forwards the complete $name request", async (route) => {
    const { database, request, evidenceRequest } = createDatabase(async () => route.output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: route.url,
      headers: workerHeaders(),
      payload: route.payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(route.output);
    expect(request).toHaveBeenNthCalledWith(1, "authenticateWorkerToken", {
      workerTokenSha256: hash(workerToken),
    });
    expect(evidenceRequest).toHaveBeenCalledExactlyOnceWith(route.operation, route.payload);
    expect(request).toHaveBeenNthCalledWith(2, route.operation, route.payload);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(workerRoutes)("authenticates $name before parsing an invalid body", async (route) => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: route.url,
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    expectSafeError(response, 401, "worker_authentication_failed");
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(workerRoutes)(
    "rejects a $name lease owned by another authenticated Worker",
    async (route) => {
      const { database, evidenceRequest } = createDatabase();
      const { app } = createApp({ database });
      const response = await app.inject({
        method: "POST",
        url: route.url,
        headers: workerHeaders(),
        payload: { ...route.payload, lease: { ...lease, workerNodeId: otherWorkerNodeId } },
      });

      expectSafeError(response, 403, "worker_identity_mismatch");
      expect(evidenceRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["unknown token", { outcome: "rejected" }, 401, "worker_authentication_failed"],
    [
      "pending registration",
      { outcome: "authenticated", workerNodeId: lease.workerNodeId, authState: "pending" },
      403,
      "worker_registration_required",
    ],
  ] as const)("rejects %s before evidence access", async (_name, identity, statusCode, code) => {
    const { database, evidenceRequest } = createDatabase(undefined, async () => identity);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: uploadsPath,
      headers: workerHeaders(),
      payload: beginRequest,
    });

    expectSafeError(response, statusCode, code);
    expect(evidenceRequest).not.toHaveBeenCalled();
  });

  it.each(workerRoutes)(
    "preserves the $name lease fence for the database to reject",
    async (route) => {
      const { database, evidenceRequest } = createDatabase(async () => {
        throw new DatabaseRequestError(privateErrorMessage, "EVIDENCE_LEASE_REJECTED");
      });
      const { app } = createApp({ database });
      const payload = {
        ...route.payload,
        lease: { ...lease, leaseGeneration: 99, workerInstanceId: "superseded-instance" },
      };
      const response = await app.inject({
        method: "POST",
        url: route.url,
        headers: workerHeaders(),
        payload,
      });

      expectSafeError(response, 409, "evidence_lease_rejected");
      expect(evidenceRequest).toHaveBeenCalledExactlyOnceWith(route.operation, payload);
    },
  );

  it.each(workerRoutes.slice(1))("rejects a $name path/body asset mismatch", async (route) => {
    const { database, evidenceRequest } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: route.url,
      headers: workerHeaders(),
      payload: { ...route.payload, assetId: "another-asset" },
    });

    expectSafeError(response, 400, "evidence_invalid");
    expect(evidenceRequest).not.toHaveBeenCalled();
  });

  it.each(workerRoutes.slice(1))("rejects an invalid $name asset path", async (route) => {
    const { database, evidenceRequest } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: route.url.replace(assetId, "invalid%20asset"),
      headers: workerHeaders(),
      payload: route.payload,
    });

    expectSafeError(response, 400, "evidence_invalid");
    expect(evidenceRequest).not.toHaveBeenCalled();
  });

  it.each(workerRoutes)(
    "rejects unknown body, lease, and query fields for $name",
    async (route) => {
      const { database, evidenceRequest } = createDatabase();
      const { app } = createApp({ database });
      for (const request of [
        { url: route.url, payload: { ...route.payload, path: "/private/evidence/storage-secret" } },
        {
          url: route.url,
          payload: { ...route.payload, lease: { ...lease, repositoryId: scope.repositoryId } },
        },
        { url: `${route.url}?path=storage-secret`, payload: route.payload },
      ]) {
        const response = await app.inject({ method: "POST", headers: workerHeaders(), ...request });
        expectSafeError(response, 400, "evidence_invalid");
      }
      expect(evidenceRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["zero size", { ...metadata, sizeBytes: 0 }],
    ["fractional size", { ...metadata, sizeBytes: 1.5 }],
    ["oversized asset", { ...metadata, sizeBytes: maximumEvidenceAssetBytes + 1 }],
    [
      "oversized screenshot",
      {
        ...metadata,
        kind: "screenshot",
        mediaType: "image/png",
        sizeBytes: maximumScreenshotBytes + 1,
      },
    ],
    ["mismatched kind and media", { ...metadata, kind: "screenshot", mediaType: "text/plain" }],
    ["unsupported media", { ...metadata, mediaType: "text/html" }],
    ["private path", { ...metadata, path: "/private/evidence/storage-secret" }],
  ])("rejects begin metadata with %s", async (_name, invalidMetadata) => {
    const { database, evidenceRequest } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: uploadsPath,
      headers: workerHeaders(),
      payload: { ...beginRequest, metadata: invalidMetadata },
    });

    expectSafeError(response, 400, "evidence_invalid");
    expect(evidenceRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["negative offset", { offset: -1 }],
    ["fractional offset", { offset: 0.5 }],
    ["oversized offset", { offset: maximumEvidenceAssetBytes + 1 }],
    ["empty chunk", { base64: "" }],
    ["noncanonical padding", { base64: "Zh==" }],
    ["base64 whitespace", { base64: "Zg==\n" }],
    [
      "excess decoded byte",
      { base64: Buffer.alloc(maximumEvidenceChunkBytes + 1).toString("base64") },
    ],
  ])("rejects append input with %s before database access", async (_name, overrides) => {
    const { database, evidenceRequest } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: chunksPath,
      headers: workerHeaders(),
      payload: { ...appendRequest, ...overrides },
    });

    expectSafeError(response, 400, "evidence_invalid");
    expect(evidenceRequest).not.toHaveBeenCalled();
  });

  it("accepts an exact 512 KiB chunk within the 1 MiB HTTP body limit", async () => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes, 7);
    const payload = {
      ...appendRequest,
      base64: bytes.toString("base64"),
      chunkSha256: hash(bytes),
    };
    const { database, evidenceRequest } = createDatabase(async () => ({
      ...uploadResponse,
      offset: bytes.length,
    }));
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: chunksPath,
      headers: workerHeaders(),
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(evidenceRequest).toHaveBeenCalledExactlyOnceWith("appendEvidenceChunk", payload);
  });

  it("rejects an HTTP body above 1 MiB before evidence access", async () => {
    const { database, evidenceRequest } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: chunksPath,
      headers: workerHeaders(),
      payload: { ...appendRequest, base64: "A".repeat(1024 * 1024) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.body).not.toContain(lease.leaseToken);
    expect(evidenceRequest).not.toHaveBeenCalled();
  });

  it.each(workerRoutes)("blocks $name during recovery maintenance", async (route) => {
    const { database, evidenceRequest } = createDatabase();
    const { app } = createApp({ database, recoveryMaintenance: true });
    const response = await app.inject({
      method: "POST",
      url: route.url,
      headers: workerHeaders(),
      payload: route.payload,
    });

    expect(response.statusCode).toBe(503);
    expect(evidenceRequest).not.toHaveBeenCalled();
  });

  it.each(databaseErrors)(
    "maps %s to a safe Worker error",
    async (databaseCode, statusCode, responseCode) => {
      const { database } = createDatabase(async () => {
        throw new DatabaseRequestError(privateErrorMessage, databaseCode);
      });
      const { app } = createApp({ database });
      const response = await app.inject({
        method: "POST",
        url: uploadsPath,
        headers: workerHeaders(),
        payload: beginRequest,
      });

      expectSafeError(response, statusCode, responseCode);
    },
  );

  it("hides an unexpected thrown error", async () => {
    const { database } = createDatabase(async () => {
      throw new Error(privateErrorMessage);
    });
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "POST",
      url: uploadsPath,
      headers: workerHeaders(),
      payload: beginRequest,
    });

    expectSafeError(response, 500, "evidence_operation_failed");
  });

  it.each([
    [
      "begin unexpected property",
      uploadsPath,
      beginRequest,
      { ...uploadResponse, storagePath: "/private/evidence/storage-secret" },
    ],
    [
      "begin excessive offset",
      uploadsPath,
      beginRequest,
      { ...uploadResponse, offset: maximumEvidenceAssetBytes + 1 },
    ],
    [
      "begin offset beyond declared size",
      uploadsPath,
      beginRequest,
      { ...uploadResponse, offset: content.length + 1 },
    ],
    [
      "begin incomplete finalized offset",
      uploadsPath,
      beginRequest,
      { ...uploadResponse, state: "finalized", offset: content.length - 1 },
    ],
    [
      "append another asset",
      chunksPath,
      appendRequest,
      { ...uploadResponse, assetId: "another-asset" },
    ],
    [
      "append offset before committed chunk end",
      chunksPath,
      appendRequest,
      { ...uploadResponse, offset: content.length - 1 },
    ],
    ["finalize another asset", finalizePath, finalizeRequest, { ...manifest, id: "another-asset" }],
    ["finalize another job", finalizePath, finalizeRequest, { ...manifest, jobId: "another-job" }],
    [
      "finalize another attempt",
      finalizePath,
      finalizeRequest,
      { ...manifest, runAttemptId: "another-attempt" },
    ],
    [
      "finalize retired state",
      finalizePath,
      finalizeRequest,
      { ...manifest, state: "retired", retiredAt: timestamp },
    ],
    [
      "finalize retirement timestamp",
      finalizePath,
      finalizeRequest,
      { ...manifest, retiredAt: timestamp },
    ],
  ] as const)("rejects a database response containing %s", async (_name, url, payload, output) => {
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({ method: "POST", url, headers: workerHeaders(), payload });

    expectSafeError(response, 502, "evidence_response_invalid");
  });

  it("accepts 256 chunks without the previous 120-request throttle", async () => {
    const bytes = Buffer.from([7]);
    const { database, evidenceRequest } = createDatabase(async (_operation, input) => ({
      ...uploadResponse,
      offset: (input as AppendEvidenceChunkRequest).offset + bytes.length,
    }));
    const { app } = createApp({ database });
    for (let offset = 0; offset < 256; offset++) {
      const response = await app.inject({
        method: "POST",
        url: chunksPath,
        headers: workerHeaders(),
        payload: {
          ...appendRequest,
          offset,
          base64: bytes.toString("base64"),
          chunkSha256: hash(bytes),
        },
      });
      expect(response.statusCode, `Chunk ${offset}`).toBe(200);
    }
    expect(evidenceRequest).toHaveBeenCalledTimes(256);
  });

  it("shares 1200 requests across upload routes by Worker identity and isolates Workers on the same IP", async () => {
    expect(WORKER_EVIDENCE_REQUESTS_PER_MINUTE).toBe(1200);
    const { database, evidenceRequest } = createDatabase(async (operation) => {
      if (operation === "finalizeEvidenceUpload") return manifest;
      if (operation === "appendEvidenceChunk") return { ...uploadResponse, offset: content.length };
      return uploadResponse;
    });
    const { app } = createApp({ database });
    for (let index = 0; index < WORKER_EVIDENCE_REQUESTS_PER_MINUTE; index++) {
      const route = workerRoutes[index % workerRoutes.length];
      if (route === undefined) throw new Error("The Worker evidence route fixture is missing.");
      const response = await app.inject({
        method: "POST",
        url: route.url,
        headers: workerHeaders(),
        payload: route.payload,
        remoteAddress: "192.0.2.7",
      });
      expect(response.statusCode, `Upload request ${index}`).toBe(200);
    }
    const blocked = await app.inject({
      method: "POST",
      url: uploadsPath,
      headers: workerHeaders(),
      payload: beginRequest,
      remoteAddress: "192.0.2.7",
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "evidence_rate_limited", retryable: true });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(evidenceRequest).toHaveBeenCalledTimes(WORKER_EVIDENCE_REQUESTS_PER_MINUTE);

    const other = await app.inject({
      method: "POST",
      url: uploadsPath,
      headers: workerHeaders(otherWorkerToken),
      remoteAddress: "192.0.2.7",
      payload: { ...beginRequest, lease: { ...lease, workerNodeId: otherWorkerNodeId } },
    });
    expect(other.statusCode).toBe(200);
    expect(evidenceRequest).toHaveBeenCalledTimes(WORKER_EVIDENCE_REQUESTS_PER_MINUTE + 1);
  }, 20_000);
});

describe("Operator evidence routes", () => {
  it.each(operatorRoutes)(
    "uses only the session identity despite body and header claims for $name",
    async (route) => {
      const { database, request } = createDatabase(async () => route.output);
      const { app } = createApp({ database });
      const forgedActor = { issuer: "https://attacker.example.com", subject: "admin" };
      const response = await app.inject({
        method: "GET",
        url: route.url,
        headers: { ...cookieHeaders(), "x-operator-subject": forgedActor.subject },
        payload: { actor: forgedActor, context: { kind: "operator", actor: forgedActor } },
      });
      expect(response.statusCode).toBe(200);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "operatorRequest",
        envelope(route.operation, route.input),
      );
    },
  );

  it.each(operatorRoutes)("returns safe asynchronous access errors for $name", async (route) => {
    for (const [code, statusCode] of [
      ["PLATFORM_FORBIDDEN", 403],
      ["PLATFORM_NOT_FOUND", 404],
    ] as const) {
      const { database, request } = createDatabase(async () => {
        await Promise.resolve();
        throw new DatabaseRequestError(privateErrorMessage, code);
      });
      const { app } = createApp({ database });
      const response = await app.inject({
        method: "GET",
        url: route.url,
        headers: cookieHeaders(),
      });
      expectSafeError(response, statusCode, code.toLowerCase());
      expectPrivateResponse(response);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["content-disposition"]).toBeUndefined();
      expect(response.json()).toMatchObject({ message: expect.any(String) });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "operatorRequest",
        envelope(route.operation, route.input),
      );
    }
  });
  it.each(operatorRoutes)(
    "reads $name with a real cookie session and the complete scope",
    async (route) => {
      const { database, request, evidenceRequest } = createDatabase(async () => route.output);
      const { app, auth } = createApp({ database });
      const response = await app.inject({
        method: "GET",
        url: route.url,
        headers: cookieHeaders(),
      });

      expect(response.statusCode).toBe(200);
      expectPrivateResponse(response);
      if (route.name === "content") expect(response.rawPayload).toEqual(content);
      else expect(response.json()).toEqual(route.output);
      expect(auth.getSession).toHaveBeenCalledWith(sessionToken, undefined);
      expect(evidenceRequest).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "operatorRequest",
        envelope(route.operation, route.input),
      );
      expect(response.body).not.toContain("storagePath");
    },
  );

  it.each(operatorRoutes)(
    "requires an operator session before $name database access",
    async (route) => {
      const { database, request } = createDatabase();
      const { app } = createApp({ database });
      const response = await app.inject({ method: "GET", url: route.url });

      expectSafeError(response, 401, "operator_authentication_required");
      expectPrivateResponse(response);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects an expired operator session", async () => {
    const { database, request } = createDatabase();
    const { app } = createApp({ database, auth: createAuth(false) });
    const response = await app.inject({
      method: "GET",
      url: contentPath,
      headers: cookieHeaders(),
    });

    expectSafeError(response, 401, "operator_authentication_required");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(operatorRoutes)(
    "does not accept a Worker Bearer token for Operator $name",
    async (route) => {
      const { database, request } = createDatabase();
      const { app } = createApp({ database });
      const response = await app.inject({
        method: "GET",
        url: route.url,
        headers: workerHeaders(),
      });

      expectSafeError(response, 401, "operator_authentication_required");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(operatorRoutes)("allows $name reads during recovery maintenance", async (route) => {
    const { database, request } = createDatabase(async () => route.output);
    const { app } = createApp({ database, recoveryMaintenance: true });
    const response = await app.inject({ method: "GET", url: route.url, headers: cookieHeaders() });

    expect(response.statusCode).toBe(200);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "operatorRequest",
      envelope(route.operation, route.input),
    );
  });

  it.each(operatorRoutes)("rejects unknown query parameters on $name", async (route) => {
    const { database, evidenceRequest } = createDatabase();
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${route.url}?assetId=another-asset`,
      headers: cookieHeaders(),
    });

    expectSafeError(response, 400, "evidence_invalid");
    expect(evidenceRequest).not.toHaveBeenCalled();
  });

  it.each(["repositoryId", "runId", "jobId", "runAttemptId"] as const)(
    "rejects an invalid %s in the path",
    async (field) => {
      const { database, evidenceRequest } = createDatabase();
      const { app } = createApp({ database });
      const url = evidencePathFor({ ...scope, [field]: "invalid%20identifier" });
      const response = await app.inject({ method: "GET", url, headers: cookieHeaders() });

      expectSafeError(response, 400, "evidence_invalid");
      expect(evidenceRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["repositoryId", "runId", "jobId", "runAttemptId"] as const)(
    "rejects database results crossing the %s scope",
    async (field) => {
      const outside = { ...manifest, [field]: "another-scope" };
      const { database } = createDatabase(async (operation) => {
        if (operation === "listEvidenceAssets") return { items: [outside] };
        if (operation === "readEvidenceAssetChunk") return makeChunk(content, outside);
        return outside;
      });
      const { app } = createApp({ database });
      for (const route of operatorRoutes) {
        const response = await app.inject({
          method: "GET",
          url: route.url,
          headers: cookieHeaders(),
        });
        expectSafeError(response, 502, "evidence_response_invalid");
        expect(response.body).not.toContain("another-scope");
      }
    },
  );

  it("returns 404 for a missing manifest", async () => {
    const { database, evidenceRequest } = createDatabase(async () => null);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: manifestPath,
      headers: cookieHeaders(),
    });

    expectSafeError(response, 404, "evidence_not_found");
    expect(evidenceRequest).toHaveBeenCalledExactlyOnceWith("getEvidenceAsset", {
      ...scope,
      assetId,
    });
  });

  it("prefetches missing content before committing a 200 response", async () => {
    const { database, evidenceRequest } = createDatabase(async () => {
      throw new DatabaseRequestError(privateErrorMessage, "EVIDENCE_NOT_FOUND");
    });
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: contentPath,
      headers: cookieHeaders(),
    });

    expectSafeError(response, 404, "evidence_not_found");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(evidenceRequest).toHaveBeenCalledExactlyOnceWith("readEvidenceAssetChunk", {
      ...scope,
      assetId,
      offset: 0,
      maximumBytes: maximumEvidenceChunkBytes,
    });
  });

  it.each(databaseErrors)(
    "maps %s to a safe Operator error",
    async (databaseCode, statusCode, responseCode) => {
      const { database } = createDatabase(async () => {
        throw new DatabaseRequestError(privateErrorMessage, databaseCode);
      });
      const { app } = createApp({ database });
      const response = await app.inject({
        method: "GET",
        url: manifestPath,
        headers: cookieHeaders(),
      });

      expectSafeError(response, statusCode, responseCode);
      expectPrivateResponse(response);
    },
  );

  it.each([
    ["extra list field", { items: [manifest], path: "/private/evidence/storage-secret" }],
    [
      "too many assets",
      {
        items: Array.from({ length: maximumAttemptEvidenceAssets + 1 }, (_, index) => ({
          ...manifest,
          id: `asset-${index}`,
        })),
      },
    ],
    [
      "invalid manifest",
      { items: [{ ...manifest, metadata: { ...metadata, mediaType: "text/html" } }] },
    ],
  ])("rejects a list response with %s", async (_name, output) => {
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: evidencePath,
      headers: cookieHeaders(),
    });

    expectSafeError(response, 502, "evidence_response_invalid");
  });

  it.each([
    ["another asset", { ...manifest, id: "another-asset" }],
    ["storage path", { ...manifest, storagePath: "/private/evidence/storage-secret" }],
    [
      "oversized asset",
      { ...manifest, metadata: { ...metadata, sizeBytes: maximumEvidenceAssetBytes + 1 } },
    ],
  ])("rejects a manifest response with %s", async (_name, output) => {
    const { database } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: manifestPath,
      headers: cookieHeaders(),
    });

    expectSafeError(response, 502, "evidence_response_invalid");
  });
});

describe("Operator evidence content streaming", () => {
  it("stops emitting bytes when access is revoked after the first authorized chunk", async () => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes + 17, 101);
    const value = makeManifest(bytes);
    let revoked = false;
    const emitted: Buffer[] = [];
    const { database, request, evidenceRequest } = createDatabase(async (_operation, input) => {
      const { offset } = input as ChunkInput;
      if (revoked) throw new DatabaseRequestError(privateErrorMessage, "PLATFORM_NOT_FOUND");
      return makeChunk(bytes.subarray(offset, offset + maximumEvidenceChunkBytes), value, offset);
    });
    const { app } = createApp({
      database,
      configureApp(instance) {
        instance.addHook("onSend", async (_request, _reply, payload) => {
          if (payload instanceof Readable) {
            payload.on("data", (chunk: Buffer) => {
              emitted.push(Buffer.from(chunk));
              revoked = true;
            });
          }
          return payload;
        });
      },
    });
    await expect(
      app.inject({ method: "GET", url: contentPath, headers: cookieHeaders() }),
    ).rejects.toThrow();
    expect(Buffer.concat(emitted)).toEqual(bytes.subarray(0, maximumEvidenceChunkBytes));
    expect(evidenceRequest).toHaveBeenCalledTimes(2);
    expect(request.mock.calls).toEqual(
      [0, maximumEvidenceChunkBytes].map((offset) => [
        "operatorRequest",
        envelope("readEvidenceAssetChunk", {
          ...scope,
          assetId,
          offset,
          maximumBytes: maximumEvidenceChunkBytes,
        }),
      ]),
    );
  });
  it.each([
    ["screenshot", "image/png", "inline", "png"],
    ["trace", "application/zip", "attachment", "zip"],
    ["steps", "application/json", "attachment", "json"],
    ["log", "text/plain", "attachment", "txt"],
  ] as const)(
    "serves %s bytes with safe download headers",
    async (kind, mediaType, disposition, extension) => {
      const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
      const value = makeManifest(bytes, { ...metadata, kind, mediaType } as EvidenceAssetMetadata);
      const { database } = createDatabase(async () => makeChunk(bytes, value));
      const { app } = createApp({ database });
      const response = await app.inject({
        method: "GET",
        url: contentPath,
        headers: cookieHeaders(),
      });

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      expect(response.headers["content-type"]?.split(";")[0]).toBe(mediaType);
      expect(response.headers["content-length"]).toBe(String(bytes.length));
      expect(response.headers["content-disposition"]).toMatch(
        new RegExp(`^${disposition}; filename="?${assetId}\\.${extension}"?$`, "u"),
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expectPrivateResponse(response);
    },
  );

  it("streams multiple exact-sized chunks and a final remainder with the complete scope", async () => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes * 2 + 17, 123);
    const value = makeManifest(bytes);
    const { database, request, evidenceRequest } = createDatabase(async (operation, input) => {
      expect(operation).toBe("readEvidenceAssetChunk");
      const range = input as ChunkInput;
      return makeChunk(
        bytes.subarray(range.offset, range.offset + maximumEvidenceChunkBytes),
        value,
        range.offset,
      );
    });
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: contentPath,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(evidenceRequest.mock.calls).toEqual(
      [0, maximumEvidenceChunkBytes, maximumEvidenceChunkBytes * 2].map((offset) => [
        "readEvidenceAssetChunk",
        { ...scope, assetId, offset, maximumBytes: maximumEvidenceChunkBytes },
      ]),
    );
    expect(request.mock.calls).toEqual(
      [0, maximumEvidenceChunkBytes, maximumEvidenceChunkBytes * 2].map((offset) => [
        "operatorRequest",
        envelope("readEvidenceAssetChunk", {
          ...scope,
          assetId,
          offset,
          maximumBytes: maximumEvidenceChunkBytes,
        }),
      ]),
    );
  });

  it("finishes an exact-boundary asset without requesting an empty trailing chunk", async () => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes, 11);
    const value = makeManifest(bytes);
    const { database, evidenceRequest } = createDatabase(async () => makeChunk(bytes, value));
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: contentPath,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(evidenceRequest).toHaveBeenCalledTimes(1);
  });

  it("sanitizes allowed entity punctuation in the download filename", async () => {
    const punctuatedId = "evidence:asset-1";
    const value = { ...manifest, id: punctuatedId };
    const { database } = createDatabase(async () => makeChunk(content, value));
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: `${evidencePath}/${punctuatedId}/content`,
      headers: cookieHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="evidence_asset-1.txt"',
    );
  });

  it("does not load the full asset before the response stream can be consumed", async () => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes * 4 + 1, 17);
    const value = makeManifest(bytes);
    const { database, evidenceRequest } = createDatabase(async (_operation, input) => {
      const { offset } = input as ChunkInput;
      return makeChunk(bytes.subarray(offset, offset + maximumEvidenceChunkBytes), value, offset);
    });
    let signalOnSend!: () => void;
    let releaseOnSend!: () => void;
    const onSendReached = new Promise<void>((resolve) => {
      signalOnSend = resolve;
    });
    const onSendReleased = new Promise<void>((resolve) => {
      releaseOnSend = resolve;
    });
    const { app } = createApp({
      database,
      configureApp(instance) {
        instance.addHook("onSend", async (_request, _reply, payload) => {
          signalOnSend();
          await onSendReleased;
          return payload;
        });
      },
    });
    const pending = app
      .inject({ method: "GET", url: contentPath, headers: cookieHeaders() })
      .then((response) => response);
    try {
      await onSendReached;
      await setImmediate();
      expect(evidenceRequest.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      releaseOnSend();
    }
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(evidenceRequest).toHaveBeenCalledTimes(5);
  }, 10_000);

  it.each([
    ["another asset", { ...makeChunk(content), manifest: { ...manifest, id: "another-asset" } }],
    ["unexpected property", { ...makeChunk(content), path: "/private/evidence/storage-secret" }],
    ["incorrect offset", { ...makeChunk(content), offset: 1 }],
    ["noninteger offset", { ...makeChunk(content), offset: 0.5 }],
    ["false EOF", { ...makeChunk(content), eof: false }],
    ["nonboolean EOF", { ...makeChunk(content), eof: "true" }],
    [
      "noncanonical base64",
      { ...makeChunk(Buffer.from([102]), makeManifest(Buffer.from([102]))), base64: "Zh==" },
    ],
    [
      "extra encoded whitespace",
      { ...makeChunk(content), base64: `${content.toString("base64")}\n` },
    ],
    ["empty content", { ...makeChunk(content), base64: "" }],
    ["short content", makeChunk(content.subarray(0, -1))],
    [
      "wrong digest",
      makeChunk(content, { ...manifest, metadata: { ...metadata, sha256: "0".repeat(64) } }),
    ],
    [
      "retired content",
      makeChunk(content, { ...manifest, state: "retired", retiredAt: timestamp }),
    ],
    [
      "oversized chunk",
      makeChunk(
        Buffer.alloc(maximumEvidenceChunkBytes + 1),
        makeManifest(Buffer.alloc(maximumEvidenceChunkBytes + 1)),
      ),
    ],
  ])("rejects first-chunk %s before sending binary headers", async (_name, output) => {
    const { database, evidenceRequest } = createDatabase(async () => output);
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: contentPath,
      headers: cookieHeaders(),
    });

    expectSafeError(response, 502, "evidence_response_invalid");
    expect(response.headers["content-type"]).toContain("application/json");
    expect(evidenceRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects an early EOF even when the first chunk matches its declared byte count", async () => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes + 1, 29);
    const value = makeManifest(bytes);
    const { database } = createDatabase(async () => ({
      ...makeChunk(bytes.subarray(0, maximumEvidenceChunkBytes), value),
      eof: true,
    }));
    const { app } = createApp({ database });
    const response = await app.inject({
      method: "GET",
      url: contentPath,
      headers: cookieHeaders(),
    });

    expectSafeError(response, 502, "evidence_response_invalid");
  });

  it.each([
    "manifest scope",
    "manifest metadata",
    "manifest provenance",
    "offset",
    "short chunk",
    "base64",
    "EOF",
    "digest",
    "database failure",
  ])("aborts a response when a later chunk has invalid %s", async (failure) => {
    const bytes = Buffer.alloc(maximumEvidenceChunkBytes + 11, 61);
    const value = makeManifest(bytes);
    const { database, evidenceRequest } = createDatabase(async (_operation, input) => {
      const { offset } = input as ChunkInput;
      if (offset === 0) return makeChunk(bytes.subarray(0, maximumEvidenceChunkBytes), value);
      if (failure === "database failure") throw new Error(privateErrorMessage);
      const output = makeChunk(bytes.subarray(offset), value, offset);
      if (failure === "manifest scope")
        return { ...output, manifest: { ...value, repositoryId: "another-repository" } };
      if (failure === "manifest metadata")
        return {
          ...output,
          manifest: {
            ...value,
            metadata: { ...value.metadata, capturedAt: "2026-09-07T00:00:01.000Z" },
          },
        };
      if (failure === "manifest provenance")
        return { ...output, manifest: { ...value, profileVersionId: "another-profile-version" } };
      if (failure === "offset") return { ...output, offset: offset + 1 };
      if (failure === "short chunk")
        return { ...output, base64: bytes.subarray(offset + 1).toString("base64") };
      if (failure === "base64") return { ...output, base64: `${output.base64}\n` };
      if (failure === "EOF") return { ...output, eof: false };
      return { ...output, base64: Buffer.alloc(11, 62).toString("base64") };
    });
    const { app } = createApp({ database });

    await expect(
      app.inject({ method: "GET", url: contentPath, headers: cookieHeaders() }),
    ).rejects.toThrow();
    expect(evidenceRequest).toHaveBeenCalledTimes(2);
  });
});
