import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInvestigationNativeEvidenceRoutes } from "./native-evidence-http.js";
import type { InvestigationNativeEvidenceReads } from "./native-evidence-read.js";
import type { InvestigationOperatorPrincipal } from "./types.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const actor: InvestigationOperatorPrincipal = {
  id: "operator",
  displayName: "Synthetic operator",
  repositoryIds: ["repository"],
  permissions: [],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};

function harness(authenticated = true) {
  const currentComment = vi.fn(async () => ({
    commentId: "comment",
    repositoryId: "repository",
    repositoryFullName: "fixture/repository",
    workItemId: "item",
    workItemNumber: 7,
    externalId: "700",
    checkedAt: "2026-10-01T01:00:00.000Z",
    state: "unavailable",
    comparison: "unknown",
    reasonCode: "github_not_configured",
    body: null,
    commentUrl: null,
    upstreamUpdatedAt: null,
    lastConfirmedAt: "2026-10-01T00:00:00.000Z",
    lastConfirmedBody: "Retained body",
  }));
  const findingSource = vi.fn(async () => ({
    reportRef: { id: "report", version: 1, digest: "a".repeat(64) },
    findingId: "finding",
    findingVersion: 1,
    locationIndex: 2,
    repositoryId: "repository",
    repositoryFullName: "fixture/repository",
    workItemId: "item",
    subjectRef: null,
    revisionKey: null,
    commitSha: null,
    blobSha: null,
    contentDigest: null,
    path: null,
    startLine: null,
    endLine: null,
    sourceRepositoryFullName: null,
    sourcePath: null,
    availability: "unavailable",
    reasonCode: "finding_has_no_source_location",
    sourceUrl: null,
    checkedAt: "2026-10-01T01:00:00.000Z",
    contextStartLine: null,
    contextEndLine: null,
    truncated: false,
    lines: [],
  }));
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  apps.push(app);
  registerInvestigationNativeEvidenceRoutes(app, {
    authenticateOperator: async () => (authenticated ? actor : null),
    reads: { currentComment, findingSource } as unknown as InvestigationNativeEvidenceReads,
  });
  return { app, currentComment, findingSource };
}

describe("native evidence GET routes", () => {
  it("awaits asynchronous operator authentication and returns a read-only comment observation", async () => {
    const h = harness();
    const response = await h.app.inject({ method: "GET", url: "/api/comments/comment/current" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(h.currentComment).toHaveBeenCalledWith(actor, "comment");
    expect(response.json()).toMatchObject({
      state: "unavailable",
      lastConfirmedBody: "Retained body",
    });
  });

  it("passes a canonical saved location index to the source reader", async () => {
    const h = harness();
    const response = await h.app.inject({
      method: "GET",
      url: "/api/reports/report/findings/finding/source?locationIndex=2",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(h.findingSource).toHaveBeenCalledWith(actor, "report", "finding", 2);
  });

  it.each(["/api/comments/comment/current", "/api/reports/report/findings/finding/source"])(
    "rejects unauthenticated reads of %s",
    async (url) => {
      const h = harness(false);
      expect((await h.app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect(h.currentComment).not.toHaveBeenCalled();
      expect(h.findingSource).not.toHaveBeenCalled();
    },
  );

  it.each([
    "locationIndex=-1",
    "locationIndex=01",
    "locationIndex=1.5",
    "locationIndex=0&path=other.cpp",
    "ref=main",
  ])("rejects mutable or malformed source selectors %s", async (query) => {
    const h = harness();
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: `/api/reports/report/findings/finding/source?${query}`,
        })
      ).statusCode,
    ).toBe(400);
    expect(h.findingSource).not.toHaveBeenCalled();
  });

  it("does not expose a publication mutation through the read route", async () => {
    const h = harness();
    expect(
      (await h.app.inject({ method: "POST", url: "/api/comments/comment/current", payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(h.currentComment).not.toHaveBeenCalled();
  });
});
