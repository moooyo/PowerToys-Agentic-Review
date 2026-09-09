import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../../../worker/src/config.js";
import { HttpWorkerApi } from "../../../worker/src/server-client/http-worker-api.js";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { registerModelInvocationRoutes as registerBuiltModelInvocationRoutes } from "../../dist/routes/model-invocations.js";
import { DatabaseRequestError } from "../database/errors.js";
import type { ModelInvocationOperationMap } from "../database/model-invocations.js";
import {
  createModelInvocationFixture,
  exportModelInvocationFixture,
  modelInvocationBeginRequest,
  modelInvocationReceiptSet,
  modelInvocationSealRequest,
} from "../database/model-invocations.testing.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerFilename,
} from "../database/storage-security.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  MODEL_INVOCATION_PATHS,
  type ModelInvocationRouteDependencies,
  registerModelInvocationRoutes,
} from "./model-invocations.js";

const token = `arw1_${Buffer.alloc(32, 7).toString("base64url")}`;
const rotatedToken = `arw1_${Buffer.alloc(32, 8).toString("base64url")}`;
const lease: C.LeaseIdentity = {
  jobId: "job-a",
  runAttemptId: "attempt-a",
  workerNodeId: "worker-a",
  workerInstanceId: "instance-a",
  leaseToken: "L".repeat(32),
  leaseGeneration: 1,
};
const runtime: C.ModelInvocationBeginRequest["runtime"] = {
  providerId: "synthetic-provider",
  endpointSha256: "a".repeat(64),
  client: {
    kind: "codex_cli",
    version: "1.0.0",
    executableSha256: "b".repeat(64),
    launchPolicySha256: "c".repeat(64),
  },
  relay: { implementationSha256: "d".repeat(64), policySha256: "e".repeat(64) },
};
const invocationId = "invocation-a";
const scope: C.ModelInvocationScopeV1 = {
  schemaVersion: "ModelInvocationScopeV1",
  repositoryId: "repo-a",
  evaluationId: "evaluation-a",
  cellId: "cell-a",
  runId: "run-a",
  requestId: "request-a",
  jobId: lease.jobId,
  attemptId: lease.runAttemptId,
  invocationId,
  authorizationId: "authorization-a",
  executionManifestSha256: "f".repeat(64),
  promptSha256: "1".repeat(64),
  outputSchemaSha256: "2".repeat(64),
  expectedModelIdentitySha256: "3".repeat(64),
  requestedModel: "configured-model",
  workerNodeId: lease.workerNodeId,
  workerInstanceId: lease.workerInstanceId,
  leaseGeneration: lease.leaseGeneration,
};
const scopeSha256 = sha256(canonicalJson(scope));
const openedAt = "2026-09-08T01:00:00.000Z",
  closedAt = "2026-09-08T01:01:00.000Z";
function begin(): C.ModelInvocationBeginRequest {
  return structuredClone({ lease, invocationId, runtime });
}
function opening(): C.ModelInvocationOpeningV1 {
  return structuredClone({
    schemaVersion: "ModelInvocationOpeningV1",
    scope,
    scopeSha256,
    runtime,
    openedAt,
  });
}
function receiptSet(): C.ModelInvocationReceiptSetV1 {
  return structuredClone({
    schemaVersion: "ModelInvocationReceiptSetV1",
    scope,
    scopeSha256,
    runtime,
    calls: [],
    closedAt,
    state: "cancelled",
    modelOutputSha256: null,
    observedIdentity: null,
    observedIdentitySha256: null,
  });
}
function sealRequest(): C.ModelInvocationSealRequest {
  return structuredClone({
    lease,
    invocationId,
    scopeSha256,
    receiptSetSha256: sha256(canonicalJson(receiptSet())),
    closedAt,
    state: "cancelled",
    callCount: 0,
    lastReceiptSha256: null,
    modelOutputSha256: null,
    observedIdentitySha256: null,
    processClosed: true,
    relayClosed: true,
  });
}
function seal(): C.ModelInvocationSealV1 {
  const request = sealRequest();
  return {
    schemaVersion: "ModelInvocationSealV1",
    invocationId,
    scopeSha256,
    receiptSetSha256: request.receiptSetSha256,
    closedAt,
    state: request.state,
    callCount: request.callCount,
    lastReceiptSha256: request.lastReceiptSha256,
    modelOutputSha256: request.modelOutputSha256,
    observedIdentitySha256: request.observedIdentitySha256,
    processClosed: request.processClosed,
    relayClosed: request.relayClosed,
    recordedAt: "2026-09-08T00:59:00.000Z",
  };
}
function submit(): C.ModelInvocationSubmitRequest {
  return structuredClone({ lease, invocationId, receiptSet: receiptSet() });
}
function submission(): C.ModelInvocationSubmissionV1 {
  return {
    schemaVersion: "ModelInvocationSubmissionV1",
    invocationId,
    scopeSha256,
    receiptSetSha256: sha256(canonicalJson(receiptSet())),
    receivedAt: "2026-09-08T01:02:00.000Z",
    consistency: {
      state: "unavailable",
      reasons: ["INVOCATION_CANCELLED"],
      observedIdentitySha256: null,
    },
    executionAccepted: false,
  };
}
const routePath = (path: string) =>
  path.replace(":runAttemptId", lease.runAttemptId).replace(":invocationId", invocationId);
const routes = [
  {
    name: "begin",
    path: routePath(MODEL_INVOCATION_PATHS.begin),
    operation: "beginModelInvocation",
    body: begin,
    output: opening,
    limit: C.maximumModelInvocationControlRequestUtf8Bytes,
  },
  {
    name: "seal",
    path: routePath(MODEL_INVOCATION_PATHS.seal),
    operation: "sealModelInvocation",
    body: sealRequest,
    output: seal,
    limit: C.maximumModelInvocationControlRequestUtf8Bytes,
  },
  {
    name: "submit",
    path: routePath(MODEL_INVOCATION_PATHS.submit),
    operation: "submitModelInvocationReceipts",
    body: submit,
    output: submission,
    limit: C.maximumModelInvocationSubmitRequestUtf8Bytes,
  },
] as const;
type Route = (typeof routes)[number];
function callOwner(owner: DatabaseClient, route: Route, workerTokenSha256: string) {
  switch (route.name) {
    case "begin":
      return owner.request(route.operation, { workerTokenSha256, request: route.body() });
    case "seal":
      return owner.request(route.operation, { workerTokenSha256, request: route.body() });
    case "submit":
      return owner.request(route.operation, { workerTokenSha256, request: route.body() });
  }
}
const apps: FastifyInstance[] = [],
  roots: string[] = [];
const owners = new Set<DatabaseClient>();
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all([...owners].map((owner) => owner.close()));
  owners.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const headers = (credential = token) => ({
  authorization: `Bearer ${credential}`,
  "content-type": "application/json",
});
function request(route: Route): InjectOptions {
  return { method: "POST", url: route.path, headers: headers(), payload: route.body() };
}
function fixture(
  output: unknown,
  options: {
    authState?: "active" | "pending";
    unavailable?: boolean;
    invalidToken?: boolean;
    error?: Error;
    recovery?: boolean;
    shutdown?: boolean;
  } = {},
) {
  const mutate = vi.fn(async (_operation: string, _input: unknown) => {
    if (options.error) throw options.error;
    return output;
  });
  const transport = vi.fn(async (operation: string, _input: unknown) => {
    if (operation === "authenticateWorkerToken") {
      if (options.unavailable) throw new Error("Private authentication storage details");
      return options.invalidToken
        ? { outcome: "invalid" }
        : {
            outcome: "authenticated",
            workerNodeId: lease.workerNodeId,
            authState: options.authState ?? "active",
          };
    }
    return mutate(operation, _input);
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  const shutdown = new AbortController();
  if (options.shutdown) shutdown.abort();
  registerModelInvocationRoutes(app, {
    database: { request: transport } as unknown as ModelInvocationRouteDependencies["database"],
    config: { recoveryMaintenance: options.recovery === true },
    shutdownSignal: shutdown.signal,
  });
  return { app, transport, mutate };
}

describe("Worker model invocation routes", () => {
  it.each(routes)(
    "authenticates $name and injects only the current bearer digest into RPC",
    async (route) => {
      const f = fixture(route.output());
      const response = await f.app.inject(request(route));
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(route.output());
      expect(f.transport).toHaveBeenNthCalledWith(1, "authenticateWorkerToken", {
        workerTokenSha256: sha256(token),
      });
      expect(f.mutate).toHaveBeenCalledExactlyOnceWith(route.operation, {
        workerTokenSha256: sha256(token),
        request: route.body(),
      });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.body).not.toContain(token);
      expect(response.body).not.toContain(lease.leaseToken);
    },
  );
  it.each(routes)("requires active authenticated Worker credentials for $name", async (route) => {
    for (const options of [
      { authState: "pending" as const },
      { invalidToken: true },
      { unavailable: true },
    ]) {
      const f = fixture(route.output(), options),
        response = await f.app.inject(request(route));
      expect(response.statusCode).toBe(
        "authState" in options ? 403 : "invalidToken" in options ? 401 : 503,
      );
      expect(f.mutate).not.toHaveBeenCalled();
      expect(response.body).not.toContain("Private authentication");
    }
  });
  it.each([undefined, "Basic ignored", "Bearer arw1_bad", [`Bearer ${token}`, `Bearer ${token}`]])(
    "rejects malformed or repeated authorization %j",
    async (authorization) => {
      const f = fixture(opening());
      const response = await f.app.inject({
        method: "POST",
        url: routes[0].path,
        headers: {
          ...(authorization === undefined ? {} : { authorization }),
          "content-type": "application/json",
        } as unknown as NonNullable<InjectOptions["headers"]>,
        payload: begin(),
      });
      expect(response.statusCode).toBe(401);
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    "rejects forged nested lease owner and route identity for $name",
    async (route) => {
      const f = fixture(route.output()),
        body = route.body();
      body.lease.workerNodeId = "forged-worker";
      if ("receiptSet" in body) {
        body.receiptSet.scope.workerNodeId = "forged-worker";
        body.receiptSet.scopeSha256 = sha256(canonicalJson(body.receiptSet.scope));
      }
      expect((await f.app.inject({ ...request(route), payload: body })).statusCode).toBe(403);
      expect(
        (
          await f.app.inject({
            ...request(route),
            url: route.path.replace(lease.runAttemptId, "other-attempt"),
          })
        ).statusCode,
      ).toBe(400);
      if (route.name !== "begin")
        expect(
          (
            await f.app.inject({
              ...request(route),
              url: route.path.replace(invocationId, "other-invocation"),
            })
          ).statusCode,
        ).toBe(400);
      expect(f.mutate).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    "rejects unknown query and trusted fields in the public $name body",
    async (route) => {
      const f = fixture(route.output());
      for (const addition of [
        { workerTokenSha256: sha256(token) },
        { replayOnly: true },
        { readOnly: false },
        { authenticatedWorker: lease.workerNodeId },
      ]) {
        expect(
          (await f.app.inject({ ...request(route), payload: { ...route.body(), ...addition } }))
            .statusCode,
        ).toBe(400);
      }
      expect(
        (await f.app.inject({ ...request(route), url: `${route.path}?replayOnly=true` }))
          .statusCode,
      ).toBe(400);
      expect(f.mutate).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    "retains exact body and response across repeated $name submissions",
    async (route) => {
      const f = fixture(route.output()),
        payload = JSON.stringify(route.body());
      const first = await f.app.inject({ ...request(route), payload }),
        second = await f.app.inject({ ...request(route), payload });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json()).toEqual(second.json());
      expect(f.mutate.mock.calls[0]).toEqual(f.mutate.mock.calls[1]);
    },
  );
  it.each(routes)(
    "enforces raw UTF-8 byte limits including whitespace for $name",
    async (route) => {
      const f = fixture(route.output()),
        serialized = JSON.stringify(route.body());
      const payload = `${serialized}${" ".repeat(route.limit - Buffer.byteLength(serialized, "utf8"))}`;
      expect((await f.app.inject({ ...request(route), payload })).statusCode).toBe(200);
      expect((await f.app.inject({ ...request(route), payload: `${payload} ` })).statusCode).toBe(
        413,
      );
      expect(f.mutate).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    (value: string) =>
      value.replace('"invocationId":', '"invocationId":"discarded","invocationId":'),
    (value: string) =>
      value.replace('"invocationId":', '"invocationId":"discarded","invocation\\u0049d":'),
    (value: string) => value.replace('"jobId":', '"jobId":"discarded","jo\\u0062Id":'),
    (value: string) => value.replace('"providerId":', '"providerId":"discarded","providerId":'),
  ])("rejects duplicate decoded JSON keys before owner dispatch", async (change) => {
    const f = fixture(opening());
    const response = await f.app.inject({
      ...request(routes[0]),
      payload: change(JSON.stringify(begin())),
    });
    expect(response.statusCode).toBe(400);
    expect(f.mutate).not.toHaveBeenCalled();
  });
  it("rejects invalid UTF-8, trailing JSON, malformed escapes and excessive JSON depth", async () => {
    const f = fixture(opening());
    const original = JSON.stringify(begin());
    const marker = "synthetic-provider",
      start = original.indexOf(marker);
    const badUtf8 = Buffer.concat([
      Buffer.from(original.slice(0, start)),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(original.slice(start + marker.length)),
    ]);
    for (const payload of [
      badUtf8,
      `${original}{}`,
      original.replace("synthetic-provider", "bad\\q"),
      `${"[".repeat(66)}0${"]".repeat(66)}`,
      `\uFEFF${original}`,
    ]) {
      expect((await f.app.inject({ ...request(routes[0]), payload })).statusCode).toBe(400);
    }
    expect(f.mutate).not.toHaveBeenCalled();
  });
  it("keeps its strict parser encapsulated from existing JSON routes", async () => {
    const f = fixture(opening());
    f.app.post("/ordinary-json", async (incoming) => incoming.body);
    const response = await f.app.inject({
      method: "POST",
      url: "/ordinary-json",
      headers: { "content-type": "application/json" },
      payload: '{"value":1,"value":2}',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ value: 2 });
  });
  it.each(routes)("does not offer unrequested methods for $name", async (route) => {
    const f = fixture(route.output());
    for (const method of ["GET", "PUT", "PATCH", "DELETE"] as const)
      expect(
        (
          await f.app.inject({
            method,
            url: route.path,
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(404);
    expect(f.mutate).not.toHaveBeenCalled();
  });
  it.each(routes)(
    "rejects $name during recovery or shutdown before authentication",
    async (route) => {
      for (const options of [{ recovery: true }, { shutdown: true }]) {
        const f = fixture(route.output(), options),
          response = await f.app.inject(request(route));
        expect(response.statusCode).toBe(503);
        expect(f.transport).not.toHaveBeenCalled();
      }
    },
  );
  it.each([
    ["MODEL_INVOCATION_INVALID", 400, false],
    ["MODEL_INVOCATION_NOT_FOUND", 404, false],
    ["MODEL_INVOCATION_CONFLICT", 409, false],
    ["MODEL_INVOCATION_LEASE_REJECTED", 409, false],
    ["WORKER_TOKEN_REJECTED", 401, false],
    ["DATABASE_READ_ONLY", 503, true],
    ["DATABASE_WORKER_SHUTTING_DOWN", 503, true],
    ["MODEL_INVOCATION_CORRUPT", 500, false],
  ] as const)("maps %s without exposing owner diagnostics", async (code, status, retryable) => {
    const f = fixture(opening(), {
      error: new DatabaseRequestError(`private-path ${token} ${lease.leaseToken}`, code),
    });
    const response = await f.app.inject(request(routes[0]));
    expect(response.statusCode).toBe(status);
    expect(response.json().retryable).toBe(retryable);
    expect(response.body).not.toContain("private-path");
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(lease.leaseToken);
    if (status === 401) expect(response.headers["www-authenticate"]).toBe("Bearer");
  });
  it.each([
    "job",
    "attempt",
    "worker",
    "instance",
    "generation",
    "invocation",
    "runtime",
    "digest",
  ])("rejects an opening with changed %s", async (field) => {
    const result = opening();
    if (field === "job") result.scope.jobId = "other";
    if (field === "attempt") result.scope.attemptId = "other";
    if (field === "worker") result.scope.workerNodeId = "other";
    if (field === "instance") result.scope.workerInstanceId = "other";
    if (field === "generation") result.scope.leaseGeneration = 2;
    if (field === "invocation") result.scope.invocationId = "other";
    if (field === "runtime") result.runtime.client.version = "other";
    result.scopeSha256 = field === "digest" ? "0".repeat(64) : sha256(canonicalJson(result.scope));
    expect((await fixture(result).app.inject(request(routes[0]))).statusCode).toBe(502);
  });
  it.each(["scopeSha256", "receiptSetSha256", "processClosed", "relayClosed", "closedAt"] as const)(
    "rejects changed seal %s",
    async (field) => {
      const result = seal();
      if (field === "scopeSha256" || field === "receiptSetSha256") result[field] = "0".repeat(64);
      else if (field === "closedAt") result.closedAt = "2026-09-08T02:00:00.000Z";
      else result[field] = false;
      expect((await fixture(result).app.inject(request(routes[1]))).statusCode).toBe(502);
    },
  );
  it.each(["invocationId", "scopeSha256", "receiptSetSha256", "executionAccepted"] as const)(
    "rejects changed submission %s",
    async (field) => {
      const result: Record<string, unknown> = submission();
      result[field] =
        field === "executionAccepted" ? true : field === "invocationId" ? "other" : "0".repeat(64);
      expect((await fixture(result).app.inject(request(routes[2]))).statusCode).toBe(502);
    },
  );
  it.each(routes)(
    "rejects unknown response data for $name rather than serializing it",
    async (route) => {
      const result = await fixture({
        ...route.output(),
        credential: "must-not-disclose",
      }).app.inject(request(route));
      expect(result.statusCode).toBe(502);
      expect(result.body).not.toContain("must-not-disclose");
    },
  );
});

describe("Model invocation real owner authentication boundary", () => {
  it("uses the actual Worker HTTP client, routes, RPC owner and stored records with exact replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-invocation-http-rpc-"));
    roots.push(root);
    await chmod(root, 0o700);
    const databasePath = join(root, "invocations.sqlite");
    // This shared fixture seeds a constrained synthetic attempt. It deliberately retains
    // production required-model claim refusal and makes no actual provider or executor call.
    const seeded = createModelInvocationFixture({ now: new Date().toISOString() });
    const beginRequest = modelInvocationBeginRequest(seeded);
    const candidateRequest = modelInvocationBeginRequest(seeded, "candidate");
    exportModelInvocationFixture(seeded, databasePath);
    await chmod(databasePath, 0o600);
    await writeFile(
      join(root, databaseInitializationMarkerFilename),
      databaseInitializationMarkerContent,
      { mode: 0o600, flag: "wx" },
    );
    const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
    const start = async (recoveryMaintenance = false) => {
      const value = await DatabaseClient.create({
        databasePath,
        migrationsDirectory,
        recoveryMaintenance,
      });
      owners.add(value);
      return value;
    };
    let owner = await start();
    const app = Fastify({ logger: false });
    apps.push(app);
    // The real client and route share the compiled production error classes.
    registerBuiltModelInvocationRoutes(app, {
      database: owner,
      config: { recoveryMaintenance: false },
      shutdownSignal: new AbortController().signal,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const clientConfig: WorkerConfig = {
      serverUrl: new URL(address),
      protocolVersion: "1.0",
      workerNodeId: beginRequest.lease.workerNodeId,
      workerToken: seeded.workerToken,
      displayName: "Synthetic HTTP invocation observer",
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
    const client = new HttpWorkerApi(clientConfig, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const opened = await client.beginModelInvocation(beginRequest);
    expect(opened.scope.attemptId).toBe(beginRequest.lease.runAttemptId);
    expect(opened.scope.expectedModelIdentitySha256).toBe(seeded.registration.identitySha256);
    expect(opened.scopeSha256).toBe(sha256(canonicalJson(opened.scope)));
    expect(await client.beginModelInvocation(beginRequest)).toEqual(opened);
    // The ledger is explicit synthetic metadata, not evidence that a model ran.
    const ledger = modelInvocationReceiptSet(opened, seeded.identity.modelId);
    const closureRequest = modelInvocationSealRequest(beginRequest.lease, ledger);
    const closed = await client.sealModelInvocation(closureRequest);
    expect(await client.sealModelInvocation(closureRequest)).toEqual(closed);
    const submitRequest: C.ModelInvocationSubmitRequest = {
      lease: beginRequest.lease,
      invocationId: beginRequest.invocationId,
      receiptSet: ledger,
    };
    const submitted = await client.submitModelInvocationReceipts(submitRequest);
    expect(submitted.consistency).toEqual({
      state: "matched",
      reasons: [],
      observedIdentitySha256: ledger.observedIdentitySha256,
    });
    expect(submitted.executionAccepted).toBe(false);
    expect(submitted.receiptSetSha256).toBe(sha256(canonicalJson(ledger)));
    expect(await client.submitModelInvocationReceipts(submitRequest)).toEqual(submitted);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    await owner.close();
    owners.delete(owner);

    owner = await start(true);
    expect(
      await owner.request("beginModelInvocation", {
        workerTokenSha256: seeded.workerTokenSha256,
        request: beginRequest,
      }),
    ).toEqual(opened);
    expect(
      await owner.request("sealModelInvocation", {
        workerTokenSha256: seeded.workerTokenSha256,
        request: closureRequest,
      }),
    ).toEqual(closed);
    expect(
      await owner.request("submitModelInvocationReceipts", {
        workerTokenSha256: seeded.workerTokenSha256,
        request: submitRequest,
      }),
    ).toEqual(submitted);
    await expect(
      owner.request("beginModelInvocation", {
        workerTokenSha256: seeded.workerTokenSha256,
        request: candidateRequest,
      }),
    ).rejects.toMatchObject({ code: "DATABASE_READ_ONLY" });
    await owner.close();
    owners.delete(owner);
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (const table of [
        "model_invocation_openings",
        "model_invocation_seals",
        "model_invocation_submissions",
      ] as const)
        expect(reader.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
          count: 1,
        });
      const stored = reader
        .prepare("SELECT response_json FROM model_invocation_submissions WHERE invocation_id = ?")
        .get(beginRequest.invocationId) as { response_json: string };
      expect(JSON.parse(stored.response_json)).toEqual(submitted);
      expect(reader.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get()).toEqual({
        count: 0,
      });
      expect(
        reader.prepare("SELECT status FROM jobs WHERE id = ?").get(beginRequest.lease.jobId),
      ).toEqual({ status: "running" });
    } finally {
      reader.close();
    }
  });
  it("checks current credentials across RPC, token rotation and recovery without enabling model claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-invocation-rpc-"));
    roots.push(root);
    await chmod(root, 0o700);
    const databasePath = join(root, "invocations.sqlite"),
      migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
    const start = async (recoveryMaintenance = false) => {
      const value = await DatabaseClient.create({
        databasePath,
        migrationsDirectory,
        recoveryMaintenance,
      });
      owners.add(value);
      return value;
    };
    let owner = await start();
    await owner.request("createWorkerNodeCredential", {
      workerNodeId: lease.workerNodeId,
      displayName: "Synthetic invocation route Worker",
      workerTokenSha256: sha256(token),
      createdByIssuer: "route-fixture",
      createdBySubject: "route-fixture",
    });
    const routeApp = (recovery = false) => {
      const app = Fastify({ logger: false });
      apps.push(app);
      registerBuiltModelInvocationRoutes(app, {
        database: owner,
        config: { recoveryMaintenance: recovery },
        shutdownSignal: new AbortController().signal,
      });
      return app;
    };
    const pending = routeApp();
    expect((await pending.inject(request(routes[0]))).statusCode).toBe(403);
    await owner.request("registerWorker", {
      protocolVersion: "1.0",
      workerNodeId: lease.workerNodeId,
      workerTokenSha256: sha256(token),
      workerInstanceId: lease.workerInstanceId,
      displayName: "Synthetic invocation route Worker",
      workerVersion: "1.0.0",
      maxSlots: 1,
      capabilities: {
        operatingSystem: "windows",
        architecture: "x64",
        headless: true,
        interactiveDesktop: false,
        codexVersion: "1.0.0",
        recipeIds: [],
        labels: {},
      },
    });
    for (const route of routes) {
      // No production model claim or fake evaluation result is created. A valid credential
      // reaches the actual owner, which must reject this deliberately nonexistent attempt.
      const noHash = {
        request: route.body(),
      } as unknown as ModelInvocationOperationMap[Route["operation"]]["input"];
      await expect(owner.request(route.operation, noHash)).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:WORKER_TOKEN_REJECTED|MODEL_INVOCATION_INVALID)$/u),
      });
      await expect(callOwner(owner, route, "0".repeat(64))).rejects.toMatchObject({
        code: "WORKER_TOKEN_REJECTED",
      });
    }
    const active = routeApp();
    const initial = await active.inject(request(routes[0]));
    expect(initial.statusCode, initial.body).toBe(409);
    expect(initial.json().code).toBe("model_invocation_lease_rejected");
    const credentials = await owner.request("listWorkerNodeCredentials", { offset: 0, limit: 20 });
    const credential = credentials.items.find((item) => item.workerNodeId === lease.workerNodeId);
    if (!credential) throw new Error("The fixture Worker credential is missing.");
    const racing = routeApp();
    let rotated = false;
    racing.addHook("preHandler", async () => {
      if (rotated) return;
      rotated = true;
      await owner.request("rotateWorkerToken", {
        workerNodeId: lease.workerNodeId,
        workerTokenSha256: sha256(rotatedToken),
        expectedUpdatedAt: credential.updatedAt,
        rotatedByIssuer: "route-fixture",
        rotatedBySubject: "route-fixture",
      });
    });
    const raced = await racing.inject(request(routes[0]));
    expect(raced.statusCode, raced.body).toBe(401);
    expect(raced.json().code).toBe("worker_token_rejected");
    expect((await active.inject(request(routes[0]))).statusCode).toBe(401);
    const newToken = await active.inject({ ...request(routes[0]), headers: headers(rotatedToken) });
    expect(newToken.statusCode, newToken.body).toBe(409);
    expect(newToken.json().code).toBe("model_invocation_lease_rejected");
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await owner.close();
    owners.delete(owner);
    owner = await start(true);
    const recovery = routeApp(true);
    const blocked = await recovery.inject({
      ...request(routes[0]),
      headers: headers(rotatedToken),
    });
    expect(blocked.statusCode, blocked.body).toBe(503);
    expect(blocked.json().code).toBe("worker_api_maintenance");
    // The owner validates the real attempt before consulting recovery replay. This absent
    // attempt therefore remains a lease rejection; it is not a positive replay fixture.
    for (const route of routes)
      await expect(callOwner(owner, route, sha256(rotatedToken))).rejects.toMatchObject({
        code: "MODEL_INVOCATION_LEASE_REJECTED",
      });
    await expect(
      owner.request("beginModelInvocation", { workerTokenSha256: sha256(token), request: begin() }),
    ).rejects.toMatchObject({ code: "WORKER_TOKEN_REJECTED" });
  });
});
