import * as C from "@agentic-review/contracts";
import {
  createEvaluationReproductionCellRecord,
  createEvaluationReproductionManifest,
  evaluationReproductionCellRecordDigest,
  evaluationReproductionSourceDefinitionDigest,
} from "@agentic-review/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { reproductionFixture } from "../../../../packages/domain/src/evaluation-reproduction.testing.js";
import { DatabaseRequestError } from "../database/errors.js";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { registerEvaluationReproductionRoutes } from "./evaluation-reproduction.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";

const actor = { issuer: "https://fixture.invalid", subject: "operator" };
const token = "R".repeat(43),
  origin = "https://reproduction.example.test";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const headers = {
  host: "reproduction.example.test",
  cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
  origin,
};
const base = "/api/v1/operator/repositories/repo";

function data() {
  const f = reproductionFixture();
  const record = createEvaluationReproductionCellRecord(f.input);
  const candidate = createEvaluationReproductionCellRecord({
    ...f.input,
    arm: "candidate",
    cellId: "candidate-cell",
    bindingContext: {
      ...f.input.bindingContext,
      activationId: "candidate-activation",
      requestId: "candidate-request",
    },
  });
  const sourceDefinitionSha256 = evaluationReproductionSourceDefinitionDigest(f.definition);
  const source: C.EvaluationReproductionSourceDefinitionReadV1 = {
    schemaVersion: "EvaluationReproductionSourceDefinitionReadV1",
    repositoryId: "repo",
    sourceId: "source",
    sourceDefinition: f.definition,
    sourceDefinitionSha256,
  };
  const cell: C.EvaluationReproductionCellDetailV1 = {
    schemaVersion: "EvaluationReproductionCellDetailV1",
    repositoryId: "repo",
    evaluationId: "evaluation",
    cellId: record.cellId,
    record,
    cellRecordSha256: evaluationReproductionCellRecordDigest(record),
  };
  const plan: C.EvaluationReproductionPlanV1 = {
    schemaVersion: "EvaluationReproductionPlanV1",
    repositoryId: "repo",
    evaluationId: "evaluation",
    manifest: createEvaluationReproductionManifest({
      evaluationId: "evaluation",
      repositoryId: "repo",
      sources: [{ caseId: "case", definition: f.definition }],
      cells: [record, candidate],
    }),
  };
  const request: C.EvaluationReproductionPreviewRequest = {
    sourceId: "source",
    selection: f.selection,
    baselineProfileVersionId: f.input.bindingContext.profileVersion.id,
    candidateProfileVersionId: f.input.bindingContext.profileVersion.id,
  };
  const arm = {
    profileVersionId: f.input.bindingContext.profileVersion.id,
    profileConfigSha256: f.input.bindingContext.profileVersion.configSha256,
    state: "ready" as const,
    blockers: [],
  };
  const preview: C.EvaluationReproductionPreviewV1 = {
    schemaVersion: "EvaluationReproductionPreviewV1",
    repositoryId: "repo",
    sourceId: "source",
    sourceDefinitionSha256,
    baseline: arm,
    candidate: { ...arm },
  };
  return { source, cell, plan, preview, request };
}
function fixture(output: unknown, options: { authenticated?: boolean; error?: Error } = {}) {
  const session = {
    ...actor,
    displayName: "Synthetic reader",
    email: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    expiresAt: "2099-09-09T00:00:00.000Z",
  };
  const auth: OperatorAuthRouteService = {
    publicOrigin: origin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: () => undefined,
    startLogin: async () => ({ kind: "session", sessionToken: token, session }),
    completeLogin: async () => {
      throw new Error("No external login is used.");
    },
    getSession: async (value) =>
      value === token && options.authenticated !== false ? session : null,
    logout: async () => undefined,
  };
  const db = createOperatorRouteTestDatabase(actor, async () => {
    if (options.error) throw options.error;
    return output;
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerEvaluationReproductionRoutes(app, { database: db.database, operatorAuth: auth });
  return { app, ...db };
}
const paths = [
  {
    name: "source",
    path: `${base}/evaluation-sources/source/reproduction`,
    operation: "getEvaluationSourceReproduction",
  },
  {
    name: "plan",
    path: `${base}/evaluations/evaluation/reproduction`,
    operation: "getEvaluationReproductionPlan",
  },
  {
    name: "cell",
    path: `${base}/evaluations/evaluation/cells/baseline-cell/reproduction`,
    operation: "getEvaluationReproductionCell",
  },
] as const;

describe("evaluation reproduction HTTP boundary", () => {
  it.each(paths)("binds $name to the authenticated repository scope", async (route) => {
    const value = data()[route.name],
      f = fixture(value);
    const result = await f.app.inject({ method: "GET", url: route.path, headers });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual(value);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      route.operation,
      expect.objectContaining({ repositoryId: "repo", actor }),
    );
  });
  it.each(paths)("refuses unauthenticated $name before the owner call", async (route) => {
    const f = fixture(data()[route.name], { authenticated: false });
    expect((await f.app.inject({ method: "GET", url: route.path, headers })).statusCode).toBe(401);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(paths)("rejects query fields on $name", async (route) => {
    const f = fixture(data()[route.name]);
    expect(
      (await f.app.inject({ method: "GET", url: `${route.path}?repositoryId=foreign`, headers }))
        .statusCode,
    ).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each(paths)("rejects a foreign $name response", async (route) => {
    const f = fixture({ ...data()[route.name], repositoryId: "foreign" });
    expect((await f.app.inject({ method: "GET", url: route.path, headers })).statusCode).toBe(502);
  });
  it("checks the complete source and inner binding digests", async () => {
    const value = data().source;
    if (value.sourceDefinition === null) throw new Error("Synthetic definition missing.");
    const changed = structuredClone(value);
    changed.sourceDefinition!.binding.claim = "Changed original claim.";
    changed.sourceDefinitionSha256 = sha256(canonicalJson(changed.sourceDefinition));
    const f = fixture(changed);
    expect((await f.app.inject({ method: "GET", url: paths[0].path, headers })).statusCode).toBe(
      502,
    );
  });
  it("checks the exact cell record digest", async () => {
    const value = data().cell;
    value.cellRecordSha256 = "f".repeat(64);
    const f = fixture(value);
    expect((await f.app.inject({ method: "GET", url: paths[2].path, headers })).statusCode).toBe(
      502,
    );
  });
  it("preserves null definitions and legacy plans as explicit read results", async () => {
    const value = data();
    const f = fixture({ ...value.source, sourceDefinition: null, sourceDefinitionSha256: null });
    expect((await f.app.inject({ method: "GET", url: paths[0].path, headers })).statusCode).toBe(
      200,
    );
    const legacy = fixture({ ...value.plan, manifest: null });
    expect(
      (await legacy.app.inject({ method: "GET", url: paths[1].path, headers })).statusCode,
    ).toBe(200);
  });
  it("previews proposed mappings without returning temporary authority or invoking creation", async () => {
    const value = data(),
      f = fixture(value.preview);
    const result = await f.app.inject({
      method: "POST",
      url: `${base}/evaluation-reproduction/preview`,
      headers,
      payload: value.request,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual(value.preview);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("previewEvaluationReproduction", {
      repositoryId: "repo",
      actor,
      request: value.request,
    });
    for (const key of ["evaluationId", "cellId", "authorization", "reproduction"])
      expect(result.json()).not.toHaveProperty(key);
  });
  it("returns a blocked preview without turning it into an HTTP or creation failure", async () => {
    const value = data();
    value.preview.candidate = {
      ...value.preview.candidate,
      state: "blocked",
      blockers: [{ code: "mapping_unmapped", message: "Select a candidate observation." }],
    };
    const f = fixture(value.preview);
    const result = await f.app.inject({
      method: "POST",
      url: `${base}/evaluation-reproduction/preview`,
      headers,
      payload: value.request,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().candidate.state).toBe("blocked");
  });
  it.each([undefined, "https://foreign.example.test", "null"])(
    "requires exact Origin on preview %s",
    async (originValue) => {
      const value = data(),
        f = fixture(value.preview);
      const { origin: _origin, ...rest } = headers;
      const result = await f.app.inject({
        method: "POST",
        url: `${base}/evaluation-reproduction/preview`,
        headers: { ...rest, ...(originValue === undefined ? {} : { origin: originValue }) },
        payload: value.request,
      });
      expect(result.statusCode).toBe(403);
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it.each(["actor", "repositoryId", "authorization", "cellId"])(
    "rejects caller-supplied %s on preview",
    async (key) => {
      const value = data(),
        f = fixture(value.preview);
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `${base}/evaluation-reproduction/preview`,
            headers,
            payload: { ...value.request, [key]: "forged" },
          })
        ).statusCode,
      ).toBe(400);
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("rejects preview results for another profile selection", async () => {
    const value = data();
    value.preview.candidate.profileVersionId = "foreign-profile";
    const f = fixture(value.preview);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `${base}/evaluation-reproduction/preview`,
          headers,
          payload: value.request,
        })
      ).statusCode,
    ).toBe(502);
  });
  it.each(["PLATFORM_NOT_FOUND", "PLATFORM_FORBIDDEN"])(
    "preserves the owner's %s authorization result",
    async (code) => {
      const f = fixture(null, {
        error: new DatabaseRequestError("Synthetic access rejection.", code),
      });
      expect((await f.app.inject({ method: "GET", url: paths[0].path, headers })).statusCode).toBe(
        code === "PLATFORM_NOT_FOUND" ? 404 : 403,
      );
    },
  );
  it.each(paths)("does not expose a write operation at the $name read endpoint", async (route) => {
    const f = fixture(data()[route.name]);
    const result = await f.app.inject({ method: "POST", url: route.path, headers, payload: {} });
    expect(result.statusCode).toBe(404);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("rejects an oversized preview body before the database operation", async () => {
    const value = data(),
      f = fixture(value.preview);
    const result = await f.app.inject({
      method: "POST",
      url: `${base}/evaluation-reproduction/preview`,
      headers: { ...headers, "content-type": "application/json" },
      payload:
        JSON.stringify(value.request) + " ".repeat(C.maximumEvaluationReproductionRequestUtf8Bytes),
    });
    expect(result.statusCode).toBe(413);
    expect(f.request).not.toHaveBeenCalled();
  });
});
