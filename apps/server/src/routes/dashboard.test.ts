import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_API_PATHS,
  type DashboardAuthenticationPreHandler,
  type DashboardReadStore,
  registerDashboardRoutes,
} from "../../dist/routes/dashboard.js";

const systemSnapshot = {
  serverVersion: "0.1.0-test",
  protocolVersion: "1.0",
  nodeVersion: "24.20.0",
  sqliteVersion: "3.50.4",
  databaseSizeBytes: 1_024,
  oldestQueuedAt: null,
  activeWorkers: 1,
  activeLeases: 0,
  pendingApprovals: 0,
  health: [
    {
      id: "database",
      name: "Database",
      status: "healthy" as const,
      summary: "Database queries are available.",
      checkedAt: "2026-08-30T04:05:06.000Z",
    },
  ],
};

const createApp = (authenticate?: DashboardAuthenticationPreHandler) => {
  const request = vi.fn(async (operation: string, _input: unknown) => {
    if (operation === "getSystemSnapshot") {
      return systemSnapshot;
    }
    return { items: [], total: 0 };
  });
  const app = Fastify({ logger: false });
  registerDashboardRoutes(app, {
    authenticate: authenticate ?? (async () => undefined),
    database: { request } as unknown as DashboardReadStore,
  });
  return { app, request };
};

const close = async (app: FastifyInstance): Promise<void> => {
  await app.close();
};

describe("dashboard read routes", () => {
  it("normalizes repeated and comma-separated work-item filters", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url:
          `${DASHBOARD_API_PATHS.workItems}?page=3&pageSize=25&search=Power%20Toys` +
          "&kind=issue,pull_request&state=active&state=closed" +
          "&stage=queued,done&authorization=self,denied",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [], total: 0 });
      expect(request).toHaveBeenCalledWith("listWorkItems", {
        page: 3,
        pageSize: 25,
        search: "Power Toys",
        kind: ["issue", "pull_request"],
        state: ["active", "closed"],
        stage: ["queued", "done"],
        authorization: ["self", "denied"],
      });
    } finally {
      await close(app);
    }
  });

  it("passes all job filters to the database operation with contract field names", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url:
          `${DASHBOARD_API_PATHS.jobs}?status=queued,running&phase=leased` +
          "&phase=validation&stage=queued,done&workItemId=item-42",
      });

      expect(response.statusCode).toBe(200);
      expect(request).toHaveBeenCalledWith("listJobs", {
        status: ["queued", "running"],
        phase: ["leased", "validation"],
        stage: ["queued", "done"],
        workItemId: "item-42",
      });
    } finally {
      await close(app);
    }
  });

  it("passes worker filters and preserves omitted optional pagination", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.workers}?status=online,draining&pageSize=200&sort=identity`,
      });

      expect(response.statusCode).toBe(200);
      expect(request).toHaveBeenCalledWith("listWorkers", {
        pageSize: 200,
        sort: "identity",
        status: ["online", "draining"],
      });
    } finally {
      await close(app);
    }
  });

  it.each(["sort=heartbeat", "sort=identity&sort=identity"])(
    "rejects an invalid or repeated worker sort before database access: %s",
    async (query) => {
      const { app, request } = createApp();

      try {
        const response = await app.inject({
          method: "GET",
          url: `${DASHBOARD_API_PATHS.workers}?${query}`,
        });

        expect(response.statusCode).toBe(400);
        expect(request).not.toHaveBeenCalled();
      } finally {
        await close(app);
      }
    },
  );

  it("returns the shared system DTO without route-local synthesis", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({ method: "GET", url: DASHBOARD_API_PATHS.system });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(systemSnapshot);
      expect(request).toHaveBeenCalledWith("getSystemSnapshot", {});
    } finally {
      await close(app);
    }
  });

  it("runs the injected authentication hook on every dashboard endpoint", async () => {
    const authenticate = vi.fn(async () => undefined);
    const { app } = createApp(authenticate);

    try {
      for (const url of Object.values(DASHBOARD_API_PATHS)) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
      }
      expect(authenticate).toHaveBeenCalledTimes(4);
    } finally {
      await close(app);
    }
  });

  it("does not access the database when authentication rejects the request", async () => {
    const authenticate: DashboardAuthenticationPreHandler = async (_request, reply) =>
      reply.code(401).send({ code: "unauthorized" });
    const { app, request } = createApp(authenticate);

    try {
      const response = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.workItems}?page=0`,
      });

      expect(response.statusCode).toBe(401);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it.each([
    ["zero page", "?page=0"],
    ["repeated page", "?page=1&page=2"],
    ["unsafe page", "?page=9007199254740992"],
    ["oversized page", "?pageSize=201"],
    ["empty filter item", "?kind=issue,,pull_request"],
    ["duplicate filter item", "?kind=issue&kind=issue"],
    ["unknown filter value", "?kind=discussion"],
    ["unknown query field", "?sort=title"],
  ])("rejects %s before database access", async (_name, query) => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.workItems}${query}`,
      });

      expect(response.statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it("rejects oversized and repeated search values", async () => {
    const { app, request } = createApp();

    try {
      const oversized = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.jobs}?search=${"a".repeat(513)}`,
      });
      const repeated = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.jobs}?search=first&search=second`,
      });

      expect(oversized.statusCode).toBe(400);
      expect(repeated.statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it.each([
    ["repeated", "workItemId=item-1&workItemId=item-2"],
    ["comma-separated", "workItemId=item-1,item-2"],
    ["malformed", "workItemId=%2Fitem-1"],
  ])("rejects a %s workItemId before database access", async (_name, query) => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.jobs}?${query}`,
      });

      expect(response.statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it("rejects query parameters on the system endpoint", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.system}?details=true`,
      });

      expect(response.statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it("does not expose a write method at dashboard collection paths", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: DASHBOARD_API_PATHS.jobs,
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });
});
