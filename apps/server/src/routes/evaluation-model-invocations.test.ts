import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "@agentic-review/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { registerOperatorAuthRoutes as registerBuiltAuthRoutes } from "../../dist/routes/auth.js";
import { registerEvaluationModelInvocationRoutes as registerBuiltHistoryRoutes } from "../../dist/routes/evaluation-model-invocations.js";
import { DatabaseRequestError } from "../database/errors.js";
import {
  evaluationActor,
  evaluationAdministrator,
  setEvaluationManagementRole,
} from "../database/evaluation-management.testing.js";
import {
  invocationHistoryInput,
  recordInvocationHistory,
} from "../database/evaluation-model-invocations.testing.js";
import {
  createModelInvocationFixture,
  exportModelInvocationFixture,
  modelInvocationFixtureIdentity,
} from "../database/model-invocations.testing.js";
import { bindOperatorDatabase } from "../database/operator-database.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerFilename,
} from "../database/storage-security.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  DEVELOPMENT_OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import {
  EVALUATION_MODEL_INVOCATIONS_PATH,
  registerEvaluationModelInvocationRoutes,
} from "./evaluation-model-invocations.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";

const actor = evaluationActor,
  token = "I".repeat(43),
  now = "2026-09-08T06:00:00.000Z";
const ids = { repositoryId: "repo-a", evaluationId: "evaluation-a", cellId: "cell-a" };
function path(scope = ids): string {
  return EVALUATION_MODEL_INVOCATIONS_PATH.replace(":repositoryId", scope.repositoryId)
    .replace(":evaluationId", scope.evaluationId)
    .replace(":cellId", scope.cellId);
}
const headers = { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` };
function auth(authenticated = true, loopbackOrigin?: () => string): OperatorAuthRouteService {
  const session = {
    ...actor,
    displayName: "Invocation history reader",
    email: null,
    createdAt: now,
    expiresAt: "2099-09-09T00:00:00.000Z",
  };
  return {
    get publicOrigin() {
      return loopbackOrigin?.() ?? "https://invocation-history.example.test";
    },
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: loopbackOrigin !== undefined,
    secureCookies: loopbackOrigin === undefined,
    usesBrowserBinding: false,
    ensureBrowserBinding: () => undefined,
    startLogin: async () => ({ kind: "session" as const, sessionToken: token, session }),
    completeLogin: async () => {
      throw new Error("No external authentication is used.");
    },
    getSession: async (value) => (authenticated && value === token ? session : null),
    logout: async () => undefined,
  };
}
function output(): C.EvaluationCellInvocationListV1 {
  const identity = modelInvocationFixtureIdentity(),
    identitySha256 = sha256(canonicalJson(identity));
  const expected: C.ModelRuntimeRegistrationV1 = {
    schemaVersion: "ModelRuntimeRegistrationV1",
    id: "runtime-a",
    name: "Expected runtime",
    requestedModel: "requested-model",
    identity,
    identitySha256,
    createdAt: "2026-09-08T03:00:00.000Z",
    createdBy: evaluationAdministrator,
  };
  const scope: C.ModelInvocationScopeV1 = {
    schemaVersion: "ModelInvocationScopeV1",
    ...ids,
    runId: "run-a",
    requestId: "request-a",
    jobId: "job-a",
    attemptId: "attempt-a",
    invocationId: "invocation-a",
    authorizationId: "authorization-a",
    executionManifestSha256: "a".repeat(64),
    promptSha256: "b".repeat(64),
    outputSchemaSha256: "c".repeat(64),
    expectedModelIdentitySha256: identitySha256,
    requestedModel: expected.requestedModel,
    workerNodeId: "worker-a",
    workerInstanceId: "instance-a",
    leaseGeneration: 1,
  };
  const { schemaVersion: _schema, modelId: _model, ...runtime } = identity;
  return {
    schemaVersion: "EvaluationCellInvocationListV1",
    ...ids,
    expectedRuntimeRegistration: expected,
    page: 1,
    pageSize: 10,
    total: 1,
    sampledAt: now,
    items: [
      {
        opening: {
          schemaVersion: "ModelInvocationOpeningV1",
          scope,
          scopeSha256: sha256(canonicalJson(scope)),
          runtime,
          openedAt: "2026-09-08T04:00:00.000Z",
        },
        seal: null,
        submission: null,
        callOutcomes: null,
        observedIdentity: null,
      },
    ],
  };
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
function fixture(value: unknown = output(), authenticated = true, error?: Error) {
  const database = createOperatorRouteTestDatabase(actor, async () => {
    if (error) throw error;
    return value;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  const service = auth(authenticated);
  registerOperatorAuthRoutes(app, service);
  registerEvaluationModelInvocationRoutes(app, {
    database: database.database,
    operatorAuth: service,
  });
  return { app, ...database };
}
describe("evaluation invocation history HTTP", () => {
  it("recomputes the observed identity digest even when all declared digest references agree", async () => {
    const value = output(),
      item = value.items[0];
    if (!item) throw new Error("An item is required.");
    const claimedDigest = "0".repeat(64),
      ledgerDigest = "1".repeat(64);
    item.observedIdentity = {
      ...modelInvocationFixtureIdentity(),
      modelId: "different-reported-model",
    };
    item.seal = {
      schemaVersion: "ModelInvocationSealV1",
      invocationId: item.opening.scope.invocationId,
      scopeSha256: item.opening.scopeSha256,
      receiptSetSha256: ledgerDigest,
      closedAt: "2020-01-01T00:00:00.000Z",
      state: "closed",
      callCount: 1,
      lastReceiptSha256: "2".repeat(64),
      modelOutputSha256: "3".repeat(64),
      observedIdentitySha256: claimedDigest,
      processClosed: true,
      relayClosed: true,
      recordedAt: "2026-09-08T04:01:00.000Z",
    };
    item.submission = {
      schemaVersion: "ModelInvocationSubmissionV1",
      invocationId: item.opening.scope.invocationId,
      scopeSha256: item.opening.scopeSha256,
      receiptSetSha256: ledgerDigest,
      receivedAt: "2026-09-08T04:02:00.000Z",
      consistency: {
        state: "mismatched",
        reasons: ["RUNTIME_IDENTITY_MISMATCH"],
        observedIdentitySha256: claimedDigest,
      },
      executionAccepted: false,
    };
    item.callOutcomes = {
      completed: 1,
      provider_failed: 0,
      provider_incomplete: 0,
      transport_failed: 0,
      cancelled: 0,
      protocol_invalid: 0,
      budget_exceeded: 0,
    };
    expect(C.getEvaluationCellInvocationListIssues(value)).toEqual([]);
    const response = await fixture(value).app.inject({ method: "GET", url: path(), headers });
    expect(response.statusCode, response.body).toBe(502);
  });
  it("binds a current cookie identity to an explicit read-only operator RPC", async () => {
    const f = fixture();
    const result = await f.app.inject({ method: "GET", url: path(), headers });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual(output());
    expect(f.transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: "listEvaluationCellModelInvocations",
      input: { ...ids, actor, query: { page: 1, pageSize: 10 } },
    });
    expect(result.headers["cache-control"]).toBe("private, no-store");
  });
  it("requires a valid session and accepts explicit bounded pagination", async () => {
    const absent = fixture(output(), false);
    expect((await absent.app.inject({ method: "GET", url: path(), headers })).statusCode).toBe(401);
    expect(absent.transport).not.toHaveBeenCalled();
    const value = { ...output(), page: 2, pageSize: 1, items: [] };
    const f = fixture(value);
    expect(
      (await f.app.inject({ method: "GET", url: `${path()}?page=2&pageSize=1`, headers }))
        .statusCode,
    ).toBe(200);
  });
  it.each([
    "page=0",
    "page=01",
    "page=1.5",
    "page=1&page=2",
    "pageSize=11",
    "pageSize=0",
    "page=9007199254740991&pageSize=10",
    "actor=forged",
    "replayOnly=true",
    "page=1%0A",
  ])("rejects invalid or unknown query %s", async (query) => {
    const f = fixture();
    expect(
      (await f.app.inject({ method: "GET", url: `${path()}?${query}`, headers })).statusCode,
    ).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["repositoryId", "evaluationId", "cellId"] as const)(
    "rejects a nonexact %s",
    async (key) => {
      const f = fixture();
      expect(
        (
          await f.app.inject({
            method: "GET",
            url: path({ ...ids, [key]: `${ids[key]}%0A` }),
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each([
    "repositoryId",
    "evaluationId",
    "cellId",
    "page",
    "digest",
    "expectedDigest",
    "observedWithoutSubmission",
    "rawLedger",
    "futureTime",
  ])("rejects corrupted response %s without rendering its data", async (field) => {
    const value = output(),
      item = value.items[0];
    if (!item) throw new Error("An item is required.");
    if (field === "repositoryId" || field === "evaluationId" || field === "cellId")
      value[field] = "other";
    if (field === "page") value.page = 2;
    if (field === "digest") item.opening.scopeSha256 = "0".repeat(64);
    if (field === "expectedDigest" && value.expectedRuntimeRegistration) {
      value.expectedRuntimeRegistration.identitySha256 = "0".repeat(64);
      item.opening.scope.expectedModelIdentitySha256 = "0".repeat(64);
      item.opening.scopeSha256 = sha256(canonicalJson(item.opening.scope));
    }
    if (field === "observedWithoutSubmission")
      item.observedIdentity = modelInvocationFixtureIdentity();
    if (field === "rawLedger") Object.assign(item, { receiptSet: "private-raw-ledger" });
    if (field === "futureTime") item.opening.openedAt = "2099-01-01T00:00:00.000Z";
    const result = await fixture(value).app.inject({ method: "GET", url: path(), headers });
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain("private-raw-ledger");
  });
  it.each(["POST", "PATCH", "DELETE"] as const)(
    "does not expose %s mutation access",
    async (method) => {
      const f = fixture();
      expect((await f.app.inject({ method, url: path(), headers })).statusCode).toBe(404);
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["PLATFORM_NOT_FOUND", 404],
    ["PLATFORM_FORBIDDEN", 403],
    ["PLATFORM_CORRUPT", 500],
  ] as const)("maps %s without exposing storage details", async (code, status) => {
    const result = await fixture(
      output(),
      true,
      new DatabaseRequestError("private-storage-detail", code),
    ).app.inject({ method: "GET", url: path(), headers });
    expect(result.statusCode).toBe(status);
    expect(result.body).not.toContain("private-storage-detail");
  });
});

it("reads historical diagnostics through real HTTP/RPC in recovery and rechecks revoked reader permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-invocations-http-"));
  roots.push(root);
  await chmod(root, 0o700);
  const seeded = createModelInvocationFixture({ now: new Date().toISOString() });
  const written = recordInvocationHistory(seeded, { now: new Date().toISOString() });
  const scope = invocationHistoryInput(seeded);
  setEvaluationManagementRole(seeded.database, seeded.repositoryId, "viewer", 1);
  seeded.database
    .prepare(
      "UPDATE worker_node_credentials SET auth_state = 'revoked', revoked_at = ? WHERE worker_node_id = ?",
    )
    .run(new Date().toISOString(), seeded.lease().workerNodeId);
  const databasePath = join(root, "history.sqlite");
  exportModelInvocationFixture(seeded, databasePath);
  await chmod(databasePath, 0o600);
  await writeFile(
    join(root, databaseInitializationMarkerFilename),
    databaseInitializationMarkerContent,
    { mode: 0o600, flag: "wx" },
  );
  const start = async (recoveryMaintenance: boolean) => {
    const db = await DatabaseClient.create({
      databasePath,
      migrationsDirectory: fileURLToPath(new URL("../../../../migrations", import.meta.url)),
      recoveryMaintenance,
      operatorAccess: { administrators: [evaluationAdministrator] },
    });
    owners.add(db);
    return db;
  };
  let owner = await start(true);
  const serve = async (db: DatabaseClient) => {
    const app = Fastify({ logger: false });
    apps.push(app);
    let publicOrigin = "http://127.0.0.1";
    const service = auth(true, () => publicOrigin);
    registerBuiltAuthRoutes(app, service);
    registerBuiltHistoryRoutes(app, { database: db, operatorAuth: service });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    publicOrigin = new URL(address).origin;
    return { app, address };
  };
  let running = await serve(owner);
  const developmentHeaders = { cookie: `${DEVELOPMENT_OPERATOR_SESSION_COOKIE}=${token}` };
  const read = () => fetch(new URL(path(scope), running.address), { headers: developmentHeaders });
  const response = await read();
  const value = (await response.json()) as C.EvaluationCellInvocationListV1;
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(value.items[0]).toMatchObject(written);
  expect(value.items[0]?.observedIdentity).toEqual(seeded.identity);
  expect(value.items[0]?.submission?.executionAccepted).toBe(false);
  await expect(owner.request("listEvaluationCellModelInvocations", scope)).rejects.toMatchObject({
    code: "PLATFORM_FORBIDDEN",
  });
  await expect(
    owner.request("operatorRequest", {
      context: { kind: "operator", actor },
      operation: "listEvaluationCellModelInvocations",
      input: { ...scope, actor: evaluationAdministrator },
    }),
  ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
  expect(
    (
      await fetch(new URL(path({ ...scope, cellId: "other-cell" }), running.address), {
        headers: developmentHeaders,
      })
    ).status,
  ).toBe(404);
  await running.app.close();
  apps.splice(apps.indexOf(running.app), 1);
  await owner.close();
  owners.delete(owner);
  owner = await start(false);
  running = await serve(owner);
  await bindOperatorDatabase(owner, evaluationAdministrator).request("changeRepositoryAccess", {
    actor: evaluationAdministrator,
    repositoryId: scope.repositoryId,
    request: {
      principal: actor,
      role: null,
      expectedVersion: 2,
      changeId: "revoke-history-reader",
      reason: "Verify current permission before every history read.",
    },
  });
  expect((await read()).status).toBe(404);
});
