import type { OperatorPrincipal } from "@agentic-review/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../../dist/database/errors.js";
import type { OperatorRequestInput } from "../../dist/database/operator-request.js";
import type { GitHubIngestionHealthSource } from "../../dist/github/ingestion-health.js";
import {
  DASHBOARD_API_PATHS,
  type DashboardAuthenticationPreHandler,
  type DashboardReadStore,
  registerDashboardRoutes,
} from "../../dist/routes/dashboard.js";

const sessionActor: OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "dashboard-operator",
};
const operatorCall = (operation: string, input: unknown) =>
  [
    "operatorRequest",
    { context: { kind: "operator", actor: sessionActor }, operation, input },
  ] as const;

const systemSnapshot = {
  serverVersion: "0.1.0-test",
  protocolVersion: "1.0",
  nodeVersion: "24.20.0",
  sqliteVersion: "3.50.4",
  databaseSizeBytes: 1_024,
  oldestQueuedAt: null,
  queuedJobs: 0,
  awaitingAdmissionJobs: 0,
  pendingValidationRequests: 0,
  oldestAwaitingAdmissionAt: null,
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

const jobDetailSnapshot = {
  id: "job-1",
  repositoryId: "repository-1",
  workItemId: "item-1",
  workItemRef: "microsoft/PowerToys#501",
  title: "PR review",
  generation: 1,
  status: "succeeded" as const,
  admission: null,
  phase: null,
  attempt: 1,
  maxAttempts: 3,
  workerNodeId: null,
  leaseGeneration: null,
  leaseExpiresAt: null,
  progressUpdatedAt: null,
  elapsedSeconds: 42,
  targetRevisionKey: "revision-1",
  outcome: "success" as const,
  createdAt: "2026-08-30T04:05:06.000Z",
  updatedAt: "2026-08-30T04:06:06.000Z",
  failureCode: null,
  failureMessage: null,
  resultDigest: "a".repeat(64),
  reviewResult: {
    reviewResultId: "result-1",
    schemaId: "PrReviewPlanV1",
    resultDigest: "a".repeat(64),
    summary: "The change is ready.",
    requestedRecipeIds: ["pull-request-review"],
    createdAt: "2026-08-30T04:06:06.000Z",
    prReview: {
      assessment: "comment" as const,
      findings: [],
    },
    issueTriage: null,
  },
};

const dashboardJobPath = (jobId: string): string =>
  DASHBOARD_API_PATHS.jobById.replace(":jobId", jobId);

const createApp = (
  authenticate?: DashboardAuthenticationPreHandler,
  options?: {
    readonly jobDetail?: typeof jobDetailSnapshot | null;
    readonly githubHealth?: GitHubIngestionHealthSource;
    readonly databaseFailure?: Error;
  },
) => {
  const request = vi.fn(async (outerOperation: string, input: OperatorRequestInput) => {
    expect(outerOperation).toBe("operatorRequest");
    expect(input.context).toEqual({ kind: "operator", actor: sessionActor });
    if (options?.databaseFailure !== undefined) throw options.databaseFailure;
    const operation = input.operation;
    if (operation === "operatorCheckPermission") return { authorized: true };
    if (operation === "getSystemSnapshot") {
      return systemSnapshot;
    }
    if (operation === "getJob") {
      return options?.jobDetail === undefined ? jobDetailSnapshot : options.jobDetail;
    }
    return { items: [], total: 0 };
  });
  const app = Fastify({ logger: false });
  const sessions = new WeakMap<FastifyRequest, OperatorPrincipal>();
  const actor = vi.fn((request: FastifyRequest) => {
    const principal = sessions.get(request);
    if (principal === undefined) throw new Error("The authenticated principal is missing.");
    return principal;
  });
  registerDashboardRoutes(app, {
    authenticate: async (request, reply) => {
      await authenticate?.call(app, request, reply);
      if (!reply.sent) sessions.set(request, sessionActor);
    },
    actor,
    database: { request } as unknown as DashboardReadStore,
    ...(options?.githubHealth === undefined ? {} : { githubHealth: options.githubHealth }),
  });
  return { app, request, actor };
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
          "&stage=queued,done&authorization=self,denied&repositoryId=repository-1",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [], total: 0 });
      expect(request).toHaveBeenCalledWith(
        ...operatorCall("listWorkItems", {
          page: 3,
          pageSize: 25,
          search: "Power Toys",
          repositoryId: "repository-1",
          kind: ["issue", "pull_request"],
          state: ["active", "closed"],
          stage: ["queued", "done"],
          authorization: ["self", "denied"],
        }),
      );
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
          "&phase=validation&stage=queued,done&admission=pending&workItemId=item-42&repositoryId=repository-1",
      });

      expect(response.statusCode).toBe(200);
      expect(request).toHaveBeenCalledWith(
        ...operatorCall("listJobs", {
          status: ["queued", "running"],
          phase: ["leased", "validation"],
          stage: ["queued", "done"],
          admission: "pending",
          workItemId: "item-42",
          repositoryId: "repository-1",
        }),
      );
    } finally {
      await close(app);
    }
  });

  it.each([
    ["admission=pending", "pending"],
    ["admission=admitted", "admitted"],
    ["admission=pending,admitted", ["pending", "admitted"]],
    ["admission=pending&admission=admitted", ["pending", "admitted"]],
  ])("normalizes the declared Job admission query %s", async (query, admission) => {
    const { app, request } = createApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.jobs}?repositoryId=repository-1&${query}`,
      });
      expect(response.statusCode).toBe(200);
      expect(request).toHaveBeenCalledWith(
        ...operatorCall("listJobs", { repositoryId: "repository-1", admission }),
      );
    } finally {
      await close(app);
    }
  });

  it.each([
    "admission=waiting",
    "admission=",
    "admission=pending,,admitted",
    "admission=pending&admission=pending",
    "admission=pending,admitted,pending",
  ])("rejects invalid Job admission input %s before database access", async (query) => {
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

  it("passes worker filters and preserves omitted optional pagination", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: `${DASHBOARD_API_PATHS.workers}?status=online,draining&pageSize=200&sort=identity`,
      });

      expect(response.statusCode).toBe(200);
      expect(request).toHaveBeenCalledWith(
        ...operatorCall("listWorkers", {
          pageSize: 200,
          sort: "identity",
          status: ["online", "draining"],
        }),
      );
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
      expect(request).toHaveBeenNthCalledWith(1, ...operatorCall("operatorCheckPermission", {}));
      expect(request).toHaveBeenNthCalledWith(2, ...operatorCall("getSystemSnapshot", {}));
    } finally {
      await close(app);
    }
  });

  it("samples current runtime GitHub health for each authenticated system request", async () => {
    const initialHealth = {
      id: "github",
      name: "GitHub ingestion",
      status: "healthy" as const,
      summary: "Polling is configured; the first reconciliation is pending.",
      checkedAt: "2026-09-06T01:00:00.000Z",
    };
    const failedHealth = {
      ...initialHealth,
      status: "degraded" as const,
      summary: "The latest reconciliation failed for a configured repository.",
      checkedAt: "2026-09-06T01:01:00.000Z",
    };
    const getHealth = vi.fn().mockReturnValueOnce(initialHealth).mockReturnValueOnce(failedHealth);
    const { app, request } = createApp(undefined, { githubHealth: { getHealth } });

    try {
      const first = await app.inject({ method: "GET", url: DASHBOARD_API_PATHS.system });
      const second = await app.inject({ method: "GET", url: DASHBOARD_API_PATHS.system });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(getHealth).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(
        2,
        ...operatorCall("getSystemSnapshot", {
          githubHealth: initialHealth,
        }),
      );
      expect(request).toHaveBeenNthCalledWith(
        4,
        ...operatorCall("getSystemSnapshot", {
          githubHealth: failedHealth,
        }),
      );
    } finally {
      await close(app);
    }
  });

  it("does not sample runtime health before system authentication succeeds", async () => {
    const authenticate: DashboardAuthenticationPreHandler = async (_request, reply) =>
      reply.code(401).send({ code: "unauthorized" });
    const getHealth = vi.fn();
    const { app, request } = createApp(authenticate, { githubHealth: { getHealth } });

    try {
      const response = await app.inject({ method: "GET", url: DASHBOARD_API_PATHS.system });

      expect(response.statusCode).toBe(401);
      expect(request).not.toHaveBeenCalled();
      expect(getHealth).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it("returns one job detail with structured review result projections", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: dashboardJobPath("job-1"),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(jobDetailSnapshot);
      expect(request).toHaveBeenCalledWith(...operatorCall("getJob", { jobId: "job-1" }));
    } finally {
      await close(app);
    }
  });

  it("returns 404 when the requested job does not exist", async () => {
    const { app, request } = createApp(undefined, { jobDetail: null });

    try {
      const response = await app.inject({
        method: "GET",
        url: dashboardJobPath("job-404"),
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: "dashboard_job_not_found",
        message: "The dashboard job does not exist.",
        retryable: false,
      });
      expect(request).toHaveBeenCalledWith(...operatorCall("getJob", { jobId: "job-404" }));
    } finally {
      await close(app);
    }
  });

  it("rejects an invalid dashboard job identifier before database access", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: dashboardJobPath("_job-1"),
      });

      expect(response.statusCode).toBe(400);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it("runs the injected authentication hook on every dashboard endpoint", async () => {
    const authenticate = vi.fn(async (_request: FastifyRequest) => undefined);
    const { app, actor } = createApp(authenticate);

    try {
      for (const url of [
        DASHBOARD_API_PATHS.workItems,
        DASHBOARD_API_PATHS.jobs,
        dashboardJobPath("job-1"),
        DASHBOARD_API_PATHS.workers,
        DASHBOARD_API_PATHS.system,
      ]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
      }
      expect(authenticate).toHaveBeenCalledTimes(5);
      expect(actor).toHaveBeenCalledTimes(5);
      for (const [index, [request]] of actor.mock.calls.entries()) {
        expect(request).toBe(authenticate.mock.calls[index]?.[0]);
      }
    } finally {
      await close(app);
    }
  });

  it("fails closed without a published session principal instead of using an unbound database", async () => {
    const request = vi.fn();
    const app = Fastify({ logger: false });
    registerDashboardRoutes(app, {
      authenticate: async () => undefined,
      actor: () => {
        throw new Error("The authenticated principal was not published.");
      },
      database: { request } as unknown as DashboardReadStore,
    });
    try {
      const response = await app.inject({ method: "GET", url: DASHBOARD_API_PATHS.workers });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "configuration_operation_failed" });
      expect(response.body).not.toContain("principal was not published");
      expect(request).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it.each([
    DASHBOARD_API_PATHS.workItems,
    DASHBOARD_API_PATHS.jobs,
    dashboardJobPath("job-1"),
    DASHBOARD_API_PATHS.workers,
    DASHBOARD_API_PATHS.system,
  ])("does not let forged actor headers bypass database authorization for %s", async (url) => {
    const getHealth = vi.fn();
    const { app, request } = createApp(undefined, {
      databaseFailure: new DatabaseRequestError(
        "Private repository inventory and worker token must remain hidden.",
        "PLATFORM_FORBIDDEN",
      ),
      githubHealth: { getHealth },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url,
        headers: {
          "x-operator-issuer": "https://forged.example.test",
          "x-operator-subject": "admin",
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "platform_forbidden", retryable: false });
      expect(response.body).not.toContain("Private repository");
      expect(response.body).not.toContain("worker token");
      expect(response.body).not.toContain("items");
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[1].context).toEqual({ kind: "operator", actor: sessionActor });
      expect(getHealth).not.toHaveBeenCalled();
    } finally {
      await close(app);
    }
  });

  it("returns an opaque missing-resource response from the standalone dashboard routes", async () => {
    const { app } = createApp(undefined, {
      databaseFailure: new DatabaseRequestError(
        "The private job exists in repository secret-repository.",
        "PLATFORM_NOT_FOUND",
      ),
    });
    try {
      const response = await app.inject({ method: "GET", url: dashboardJobPath("private-job") });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "platform_not_found", retryable: false });
      expect(response.body).not.toContain("private job");
      expect(response.body).not.toContain("secret-repository");
    } finally {
      await close(app);
    }
  });

  it.each(["actor=admin", "issuer=https%3A%2F%2Fforged.example", "subject=admin"])(
    "rejects actor fields in the query before accessing any data: %s",
    async (query) => {
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
    },
  );

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

  it.each([DASHBOARD_API_PATHS.workItems, DASHBOARD_API_PATHS.jobs])(
    "rejects invalid or repeated repository scopes on %s before database access",
    async (path) => {
      const { app, request } = createApp();
      try {
        for (const query of [
          "repositoryId=repository-1&repositoryId=repository-2",
          "repositoryId=repository-1&repositoryId=repository-1",
          "repositoryId=repository-1,repository-2",
          "repositoryId=%2Frepository-1",
          "repositoryId=owner%2Frepo",
          "repositoryId=",
          `repositoryId=${"x".repeat(129)}`,
        ]) {
          const response = await app.inject({ method: "GET", url: `${path}?${query}` });
          expect(response.statusCode, query).toBe(400);
        }
        expect(request).not.toHaveBeenCalled();
      } finally {
        await close(app);
      }
    },
  );

  it.each([
    [DASHBOARD_API_PATHS.workItems, "listWorkItems"],
    [DASHBOARD_API_PATHS.jobs, "listJobs"],
  ])("preserves unscoped requests on %s", async (path, operation) => {
    const { app, request } = createApp();
    try {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(200);
      expect(request).toHaveBeenCalledWith(...operatorCall(operation, {}));
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

  it("rejects query parameters on the dashboard job detail endpoint", async () => {
    const { app, request } = createApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: `${dashboardJobPath("job-1")}?details=true`,
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
