import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../../../worker/src/config.js";
import { HttpWorkerApi } from "../../../worker/src/server-client/http-worker-api.js";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { registerValidationSummaryInputRoutes as registerBuiltRoutes } from "../../dist/routes/validation-summary-inputs.js";
import { DatabaseRequestError } from "../database/errors.js";
import {
  createModelInvocationFixture,
  exportModelInvocationFixture,
} from "../database/model-invocations.testing.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerFilename,
} from "../database/storage-security.js";
import { validationSummaryInputRequest } from "../database/validation-summary-inputs.testing.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  registerValidationSummaryInputRoutes,
  VALIDATION_SUMMARY_INPUT_PATH,
  type ValidationSummaryInputRouteDependencies,
} from "./validation-summary-inputs.js";

const token = `arw1_${Buffer.alloc(32, 24).toString("base64url")}`;
function body(): C.FreezeValidationSummaryInputRequest {
  return {
    lease: {
      workerNodeId: "node",
      workerInstanceId: "instance",
      jobId: "job",
      runAttemptId: "attempt",
      leaseGeneration: 1,
      leaseToken: "L".repeat(32),
    },
    inputId: "summary-input",
    context: {
      schemaVersion: "ValidationSummaryContextV1",
      runId: "run",
      requestId: "request",
      jobId: "job",
      runAttemptId: "attempt",
      githubRepositoryId: 1,
      profileVersionId: "profile",
      revisionKey: "a".repeat(64),
      planDigest: "b".repeat(64),
      testedSourceRevision: null,
      report: {
        schemaVersion: "ValidationReportV1",
        source: "worker",
        sourceState: "original",
        workItemKind: "pull_request",
        summary: "Synthetic observed failure.",
        checks: [],
      },
      execution: { blockers: [], diagnostics: [], cleanupState: "not_needed" },
      evidence: { assets: [], scenarios: [] },
    },
  };
}
function response(): C.FreezeValidationSummaryInputResponse {
  return {
    schemaVersion: "FreezeValidationSummaryInputResponseV1",
    reference: {
      schemaVersion: "ValidationSummaryInputReferenceV1",
      inputId: "summary-input",
      inputSha256: "c".repeat(64),
      sourcePromptSha256: "d".repeat(64),
      outputSchemaSha256: "e".repeat(64),
      contextSha256: sha256(canonicalJson(body().context)),
      actualPromptSha256: "f".repeat(64),
    },
    frozenAt: "2026-09-08T04:00:01.000Z",
  };
}
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture(
  options: {
    output?: unknown;
    error?: Error;
    invalidToken?: boolean;
    pending?: boolean;
    recovery?: boolean;
    shutdown?: boolean;
  } = {},
) {
  const write = vi.fn(async () => {
    if (options.error) throw options.error;
    return options.output ?? response();
  });
  const rpc = vi.fn(async (operation: string) =>
    operation === "authenticateWorkerToken"
      ? options.invalidToken
        ? { outcome: "invalid" }
        : {
            outcome: "authenticated",
            workerNodeId: "node",
            authState: options.pending ? "pending" : "active",
          }
      : write(),
  );
  const app = Fastify({ logger: false });
  apps.push(app);
  const shutdown = new AbortController();
  if (options.shutdown) shutdown.abort();
  registerValidationSummaryInputRoutes(app, {
    database: { request: rpc } as unknown as ValidationSummaryInputRouteDependencies["database"],
    config: { recoveryMaintenance: options.recovery === true },
    shutdownSignal: shutdown.signal,
  });
  return { app, rpc, write };
}
function request(changes: Partial<InjectOptions> = {}): InjectOptions {
  return {
    method: "POST",
    url: VALIDATION_SUMMARY_INPUT_PATH,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: body(),
    ...changes,
  };
}
describe("Worker summary input HTTP", () => {
  it("uses the actual Worker HTTP client, Fastify and separate SQLite owner, including recovery replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "summary-input-http-owner-"));
    await chmod(root, 0o700);
    const seeded = createModelInvocationFixture({ now: new Date().toISOString() }),
      databasePath = join(root, "summary.sqlite");
    const payload = validationSummaryInputRequest(seeded),
      other = validationSummaryInputRequest(seeded, "candidate");
    const workerToken = seeded.workerToken,
      workerTokenSha256 = seeded.workerTokenSha256;
    let owner: DatabaseClient | undefined;
    let seedClosed = false;
    const app = Fastify({ logger: false });
    try {
      exportModelInvocationFixture(seeded, databasePath);
      seedClosed = true;
      await chmod(databasePath, 0o600);
      await writeFile(
        join(root, databaseInitializationMarkerFilename),
        databaseInitializationMarkerContent,
        { mode: 0o600, flag: "wx" },
      );
      const ownerOptions = {
        databasePath,
        migrationsDirectory: fileURLToPath(new URL("../../../../migrations", import.meta.url)),
      };
      owner = await DatabaseClient.create(ownerOptions);
      registerBuiltRoutes(app, {
        database: owner,
        config: { recoveryMaintenance: false },
        shutdownSignal: new AbortController().signal,
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const config: WorkerConfig = {
        serverUrl: new URL(address),
        protocolVersion: "1.0",
        workerNodeId: payload.lease.workerNodeId,
        workerToken,
        displayName: "Synthetic summary input observer",
        workerVersion: "fixture",
        maxSlots: 1,
        dataDirectory: root,
        executionEnabled: false,
        claimWaitSeconds: 0,
        registrationRetrySeconds: 1,
        idleDelayMilliseconds: 1000,
        heartbeatIntervalSeconds: 5,
        heartbeatSafetyMarginSeconds: 0,
        shutdownGraceSeconds: 1,
        requestTimeoutSeconds: 10,
        logLevel: "error",
        allowInsecureHttp: true,
        capabilities: {
          operatingSystem: "windows",
          architecture: "x64",
          headless: true,
          interactiveDesktop: false,
          codexVersion: "not-configured",
          recipeIds: [],
          labels: { execution: "disabled" },
        },
      };
      const client = new HttpWorkerApi(config, {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      });
      const receipt = await client.freezeValidationSummaryInput(payload);
      expect(C.getFreezeValidationSummaryInputResponseIssues(receipt)).toEqual([]);
      expect(receipt.reference.contextSha256).toBe(sha256(canonicalJson(payload.context)));
      expect(await client.freezeValidationSummaryInput(payload)).toEqual(receipt);
      await app.close();
      await owner.close();
      owner = undefined;
      owner = await DatabaseClient.create({ ...ownerOptions, recoveryMaintenance: true });
      expect(
        await owner.request("freezeValidationSummaryInput", {
          workerTokenSha256,
          request: payload,
        }),
      ).toEqual(receipt);
      await expect(
        owner.request("freezeValidationSummaryInput", { workerTokenSha256, request: other }),
      ).rejects.toMatchObject({ code: "DATABASE_READ_ONLY" });
    } finally {
      await app.close();
      await owner?.close();
      if (!seedClosed) seeded.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("injects only the authenticated bearer digest, validates its receipt, and sends no-store", async () => {
    const f = fixture(),
      result = await f.app.inject(request());
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual(response());
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(f.rpc).toHaveBeenLastCalledWith("freezeValidationSummaryInput", {
      workerTokenSha256: sha256(token),
      request: body(),
    });
    expect(result.body).not.toContain(token);
    expect(result.body).not.toContain(body().lease.leaseToken);
  });
  it.each([
    { invalidToken: true, status: 401 },
    { pending: true, status: 403 },
    { recovery: true, status: 503 },
    { shutdown: true, status: 503 },
  ])("rejects unavailable authority %j", async ({ status, ...options }) => {
    const f = fixture(options),
      result = await f.app.inject(request());
    expect(result.statusCode).toBe(status);
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each([undefined, "Basic invalid", "Bearer arw1_invalid"])(
    "rejects malformed bearer %s",
    async (authorization) => {
      const f = fixture(),
        result = await f.app.inject(
          request({
            headers: {
              ...(authorization ? { authorization } : {}),
              "content-type": "application/json",
            },
          }),
        );
      expect(result.statusCode).toBe(401);
      expect(f.rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects an authenticated actor claiming another Worker node", async () => {
    const payload = body();
    payload.lease.workerNodeId = "another-node";
    const f = fixture();
    const result = await f.app.inject(request({ payload }));
    expect(result.statusCode).toBe(403);
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["actor", "workerTokenSha256", "replayOnly", "sourcePromptSha256", "actualPromptSha256"])(
    "rejects public field %s",
    async (field) => {
      const f = fixture(),
        result = await f.app.inject(request({ payload: { ...body(), [field]: "forged" } }));
      expect(result.statusCode).toBe(400);
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it.each(["?actor=x", "?x=1&x=2", "/"])(
    "rejects URL extension %s without fallback",
    async (suffix) => {
      const f = fixture(),
        result = await f.app.inject(request({ url: VALIDATION_SUMMARY_INPUT_PATH + suffix }));
      expect([400, 404]).toContain(result.statusCode);
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it("rejects a raw empty query separator received over the owned loopback HTTP connection", async () => {
    const f = fixture(),
      address = new URL(await f.app.listen({ host: "127.0.0.1", port: 0 }));
    const payload = JSON.stringify(body());
    const status = await new Promise<number>((resolve, reject) => {
      const operation = requestHttp(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: `${VALIDATION_SUMMARY_INPUT_PATH}?`,
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (response) => {
          response.resume();
          response.once("error", reject);
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      operation.setTimeout(2000, () =>
        operation.destroy(new Error("The owned HTTP request timed out.")),
      );
      operation.once("error", reject);
      operation.end(payload);
    });
    expect(status).toBe(400);
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["GET", "PUT", "PATCH", "DELETE"] as const)("does not expose %s", async (method) => {
    const f = fixture(),
      options = request({ method });
    delete options.payload;
    options.headers = { authorization: `Bearer ${token}` };
    const result = await f.app.inject(options);
    expect(result.statusCode).toBe(404);
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each([
    "{",
    '{"inputId":"one","inputId":"two"}',
    '{"inputId":"one","input\\u0049d":"two"}',
    '{"lease":{"jobId":"a","jobId":"b"}}',
  ])("rejects malformed or duplicate JSON %s", async (payload) => {
    const f = fixture(),
      result = await f.app.inject(request({ payload }));
    expect(result.statusCode).toBe(400);
    expect(f.write).not.toHaveBeenCalled();
  });
  it("rejects unsupported media type and oversized raw bytes with safe errors", async () => {
    const f = fixture();
    const type = await f.app.inject(
      request({
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        payload: "private body",
      }),
    );
    expect(type.statusCode).toBe(415);
    const large = await f.app.inject(
      request({ payload: " ".repeat(C.maximumFreezeValidationSummaryInputRequestUtf8Bytes + 1) }),
    );
    expect(large.statusCode).toBe(413);
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["inputId", "contextSha256"] as const)(
    "rejects a cross-input %s response",
    async (field) => {
      const output = response();
      output.reference[field] = field === "inputId" ? "foreign" : "a".repeat(64);
      const f = fixture({ output }),
        result = await f.app.inject(request());
      expect(result.statusCode).toBe(502);
    },
  );
  it.each([
    ["WORKER_TOKEN_REJECTED", 401],
    ["MODEL_INVOCATION_LEASE_REJECTED", 409],
    ["VALIDATION_SUMMARY_INPUT_CONFLICT", 409],
    ["VALIDATION_SUMMARY_INPUT_INVALID", 400],
    ["DATABASE_READ_ONLY", 503],
    ["VALIDATION_SUMMARY_INPUT_CORRUPT", 500],
  ] as const)("redacts owner %s", async (code, status) => {
    const error = new DatabaseRequestError("PRIVATE_PATH_AND_CREDENTIAL", code);
    const f = fixture({ error }),
      result = await f.app.inject(request());
    expect(result.statusCode).toBe(status);
    expect(result.body).not.toContain("PRIVATE_PATH_AND_CREDENTIAL");
  });
});
