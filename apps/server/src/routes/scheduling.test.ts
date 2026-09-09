import {
  type JobAdmission,
  type SchedulingDiagnostics,
  SchedulingDiagnosticsV1Schema,
  SchedulingDiagnosticsV2Schema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseRequestError } from "../database/errors.js";
import type { OperatorSession } from "../security/operator-auth.js";
import {
  OPERATOR_SESSION_COOKIE,
  type OperatorAuthRouteService,
  registerOperatorAuthRoutes,
} from "./auth.js";
import { createOperatorRouteTestDatabase } from "./operator-database.testing.js";
import { registerSchedulingRoutes } from "./scheduling.js";

const publicOrigin = "https://review.example.com";
const token = "S".repeat(43);
const timestamp = "2026-09-07T12:00:00.000Z";
const actor = { issuer: "https://identity.example.com", subject: "operator-1" };
const scope = {
  repositoryId: "repository-1",
  workItemId: "work-item-1",
  reviewRunId: "run-1",
  requestId: "request-1",
  jobId: "job-1",
};
const repositoryPath = `/api/v1/operator/repositories/${scope.repositoryId}`;
const admission = {
  state: "admitted",
  attemptBase: 0,
  requestedAt: "2026-09-07T11:00:00.000Z",
  timestampBasis: "recorded",
  admittedAt: timestamp,
} satisfies JobAdmission;
const repositoryObservation = {
  schemaVersion: "SchedulingDiagnosticsV3",
  observedAt: timestamp,
  subject: {
    kind: "repository_job",
    repositoryId: scope.repositoryId,
    workItemId: scope.workItemId,
    jobId: scope.jobId,
  },
  stage: "waiting",
  job: {
    jobId: scope.jobId,
    status: "queued",
    attemptCount: 0,
    createdAt: "2026-09-07T11:00:00.000Z",
    nextAttemptAt: "2026-09-07T11:00:00.000Z",
    admission,
  },
  workerInspection: { state: "complete", latestContactAt: timestamp },
  requirements: { names: ["labels.executionEnvelope", "labels.validationWeb"], truncated: false },
  reasons: [],
  reasonsTruncated: false,
  policy: {
    repository: {
      repositoryId: scope.repositoryId,
      version: 2,
      enabled: true,
      limits: { maxActiveLeases: null, maxQueuedJobs: null },
      usage: {
        activeLeases: 0,
        admittedQueuedJobs: 1,
        awaitingAdmissionJobs: 0,
        awaitingConfigurationRequests: 0,
      },
      overage: { activeLeases: 0, admittedQueuedJobs: 0 },
    },
    platform: {
      visibility: "restricted",
      version: 1,
      activeCapacity: "available",
      queueCapacity: "available",
    },
  },
} satisfies SchedulingDiagnostics;
const requestObservation = {
  ...repositoryObservation,
  subject: {
    kind: "validation_request",
    repositoryId: scope.repositoryId,
    workItemId: scope.workItemId,
    reviewRunId: scope.reviewRunId,
    requestId: scope.requestId,
  },
} satisfies SchedulingDiagnostics;
const platformObservation = {
  ...repositoryObservation,
  subject: { kind: "platform_job", jobId: scope.jobId, association: "unassociated_legacy" },
  policy: {
    repository: null,
    platform: {
      visibility: "full",
      configuration: {
        version: 1,
        limits: { maxActiveLeases: null, maxQueuedJobs: null },
        policyId: "repository-service-v1",
        updatedAt: timestamp,
      },
      usage: repositoryObservation.policy.repository.usage,
      overage: repositoryObservation.policy.repository.overage,
    },
  },
} satisfies SchedulingDiagnostics;
const platformRepositoryObservation = {
  ...repositoryObservation,
  policy: {
    repository: repositoryObservation.policy.repository,
    platform: platformObservation.policy.platform,
  },
} satisfies SchedulingDiagnostics;
const routes = [
  {
    name: "repository job",
    url: `${repositoryPath}/jobs/${scope.jobId}/scheduling`,
    operation: "getRepositoryJobScheduling",
    input: { repositoryId: scope.repositoryId, jobId: scope.jobId },
    output: repositoryObservation,
  },
  {
    name: "validation request",
    url: `${repositoryPath}/review-runs/${scope.reviewRunId}/requests/${scope.requestId}/scheduling`,
    operation: "getValidationRequestScheduling",
    input: {
      repositoryId: scope.repositoryId,
      reviewRunId: scope.reviewRunId,
      requestId: scope.requestId,
    },
    output: requestObservation,
  },
  {
    name: "platform job",
    url: `/api/v1/operator/scheduling/jobs/${scope.jobId}`,
    operation: "getPlatformJobScheduling",
    input: { jobId: scope.jobId },
    output: platformObservation,
  },
] as const;
const applications: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});
const headers = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${token}` });
function expectNoStore(response: { headers: Record<string, unknown> }): void {
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers.vary).toBe("Cookie");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
}
function fixture(
  output: unknown = null,
  options: {
    readOnly?: boolean;
    validSession?: boolean;
    failure?: Error;
    sessionFailure?: Error;
  } = {},
) {
  const session: OperatorSession = {
    ...actor,
    displayName: "Operator",
    email: "operator@example.com",
    createdAt: timestamp,
    expiresAt: "2026-09-07T13:00:00.000Z",
  };
  const auth: OperatorAuthRouteService = {
    publicOrigin,
    postLoginRedirectPath: "/",
    requiresLoopbackRequest: false,
    secureCookies: true,
    usesBrowserBinding: false,
    ensureBrowserBinding: vi.fn(() => undefined),
    startLogin: vi.fn(async () => ({ kind: "session" as const, sessionToken: token, session })),
    completeLogin: vi.fn(async () => {
      throw new Error("Scheduling route tests do not use an external identity provider.");
    }),
    getSession: vi.fn(async (sessionToken) => {
      if (options.sessionFailure) throw options.sessionFailure;
      return sessionToken === token && options.validSession !== false ? session : null;
    }),
    logout: vi.fn(async () => undefined),
  };
  const database = createOperatorRouteTestDatabase(actor, async () => {
    if (options.failure !== undefined) {
      await Promise.resolve();
      throw options.failure;
    }
    return output;
  });
  const app = Fastify({ logger: false });
  applications.push(app);
  registerOperatorAuthRoutes(app, auth);
  registerSchedulingRoutes(app, {
    database: database.database,
    operatorAuth: auth,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  return { app, auth, ...database };
}

describe("read-only scheduling authorization and requests", () => {
  it.each(routes)("binds $name reads to the session principal", async (route) => {
    const f = fixture();
    const response = await f.app.inject({
      method: "GET",
      url: route.url,
      headers: { ...headers(), "x-operator-subject": "forged-subject" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "platform_not_found",
      message: "The requested resource was not found.",
      retryable: false,
    });
    expectNoStore(response);
    expect(f.transport).toHaveBeenCalledExactlyOnceWith("operatorRequest", {
      context: { kind: "operator", actor },
      operation: route.operation,
      input: route.input,
    });
    expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    expect(f.permissions).not.toHaveBeenCalled();
  });
  it.each(routes)("rejects anonymous $name reads before database access", async (route) => {
    const f = fixture();
    const response = await f.app.inject({ method: "GET", url: route.url });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("operator_authentication_required");
    expectNoStore(response);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)("rejects expired sessions for $name", async (route) => {
    const f = fixture(null, { validSession: false });
    const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
    expect(response.statusCode).toBe(401);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)("hides session lookup failures for $name", async (route) => {
    const f = fixture(null, { sessionFailure: new Error("private-session-details") });
    const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private-session-details");
    expectNoStore(response);
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)("permits $name reads in recovery maintenance", async (route) => {
    const f = fixture(route.output, { readOnly: true });
    const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(route.output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
  });
  it.each([undefined, publicOrigin, "https://another.example"])(
    "preserves existing GET semantics with Origin=%s",
    async (origin) => {
      const f = fixture();
      const response = await f.app.inject({
        method: "GET",
        url: routes[0].url,
        headers: { ...headers(), ...(origin === undefined ? {} : { origin }) },
      });
      expect(response.statusCode).toBe(404);
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(routes)("rejects query overrides on $name", async (route) => {
    const f = fixture();
    for (const query of [
      "actor=forged",
      "jobId=other",
      "repositoryId=other",
      "probe=true",
      "page=1&page=2",
    ]) {
      const response = await f.app.inject({
        method: "GET",
        url: `${route.url}?${query}`,
        headers: headers(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("configuration_query_invalid");
    }
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)("validates all $name path identities before database access", async (route) => {
    const f = fixture();
    for (const identity of Object.values(route.input)) {
      for (const invalidId of ["%20invalid", "%2Finvalid", "x".repeat(129)]) {
        const response = await f.app.inject({
          method: "GET",
          url: route.url.replace(identity, invalidId),
          headers: headers(),
        });
        expect(response.statusCode).toBe(invalidId.length > 128 ? 414 : 400);
      }
    }
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)("does not register mutation methods for $name", async (route) => {
    const f = fixture();
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const response = await f.app.inject({
        method,
        url: route.url,
        headers: { ...headers(), origin: publicOrigin },
        ...(method === "DELETE" ? {} : { payload: {} }),
      });
      expect(response.statusCode).toBe(404);
    }
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(routes)("maps unauthorized or missing $name scopes to opaque errors", async (route) => {
    for (const [code, status] of [
      ["PLATFORM_NOT_FOUND", 404],
      ["PLATFORM_FORBIDDEN", 403],
    ] as const) {
      const f = fixture(null, {
        failure: new DatabaseRequestError("foreign-private-identity", code),
      });
      const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
      expect(response.statusCode).toBe(status);
      expect(response.json().code).toBe(code.toLowerCase());
      expect(response.body).not.toContain("foreign-private-identity");
      expectNoStore(response);
    }
  });
  it.each(routes)("does not leak unexpected $name database failures", async (route) => {
    const f = fixture(null, { failure: new Error("private-database-details") });
    const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private-database-details");
    expect(response.json()).not.toHaveProperty("subject");
  });
});

describe("scheduling response scope and data minimization", () => {
  it.each(routes)(
    "returns a validated $name observation without performing another RPC",
    async (route) => {
      const f = fixture(route.output);
      const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(route.output);
      expectNoStore(response);
      expect(f.transport).toHaveBeenCalledTimes(1);
      expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    },
  );
  it("allows a platform administrator to inspect an associated job through the platform endpoint", async () => {
    const f = fixture(platformRepositoryObservation);
    const response = await f.app.inject({ method: "GET", url: routes[2].url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(platformRepositoryObservation);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("getPlatformJobScheduling", {
      jobId: scope.jobId,
    });
  });
  it("allows a validation request that has no legal job yet", async () => {
    const output = {
      ...requestObservation,
      job: null,
      workerInspection: { state: "not_applicable", latestContactAt: null },
      requirements: { names: [], truncated: false },
      reasons: [
        {
          code: "plan_prerequisite_missing",
          effect: "current_prerequisite",
          requirement: "profile",
        },
      ],
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: routes[1].url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
  it.each([
    [
      "foreign repository",
      routes[0].url,
      {
        ...repositoryObservation,
        subject: { ...repositoryObservation.subject, repositoryId: "other-repository" },
      },
    ],
    [
      "foreign repository job",
      routes[0].url,
      {
        ...repositoryObservation,
        subject: { ...repositoryObservation.subject, jobId: "other-job" },
        job: { ...repositoryObservation.job, jobId: "other-job" },
      },
    ],
    [
      "foreign request repository",
      routes[1].url,
      {
        ...requestObservation,
        subject: { ...requestObservation.subject, repositoryId: "other-repository" },
      },
    ],
    [
      "foreign run",
      routes[1].url,
      {
        ...requestObservation,
        subject: { ...requestObservation.subject, reviewRunId: "other-run" },
      },
    ],
    [
      "foreign request",
      routes[1].url,
      {
        ...requestObservation,
        subject: { ...requestObservation.subject, requestId: "other-request" },
      },
    ],
    [
      "foreign platform job",
      routes[2].url,
      {
        ...platformObservation,
        subject: { ...platformObservation.subject, jobId: "other-job" },
        job: { ...platformObservation.job, jobId: "other-job" },
      },
    ],
    [
      "foreign associated platform job",
      routes[2].url,
      {
        ...repositoryObservation,
        subject: { ...repositoryObservation.subject, jobId: "other-job" },
        job: { ...repositoryObservation.job, jobId: "other-job" },
      },
    ],
    ["platform subject on repository endpoint", routes[0].url, platformObservation],
    ["request subject on job endpoint", routes[0].url, requestObservation],
    ["job subject on request endpoint", routes[1].url, repositoryObservation],
    ["request subject on platform endpoint", routes[2].url, requestObservation],
    [
      "mismatched nested job",
      routes[0].url,
      { ...repositoryObservation, job: { ...repositoryObservation.job, jobId: "other-job" } },
    ],
    [
      "missing platform association",
      routes[2].url,
      { ...platformObservation, subject: { kind: "platform_job", jobId: scope.jobId } },
    ],
  ])("rejects %s without returning the substituted object", async (_name, url, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: url as string, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("subject");
    expect(response.body).not.toContain("other-");
  });
  it.each([
    ["worker inventory", { ...repositoryObservation, workers: [{ nodeId: "private-worker" }] }],
    ["global usage", { ...repositoryObservation, globalActiveLeases: 12 }],
    ["fake admission", { ...repositoryObservation, admission: "admitted" }],
    [
      "misplaced limits",
      { ...repositoryObservation, schedulingLimits: { maxActiveLeases: 1, maxQueuedJobs: 2 } },
    ],
    ["lease reservation", { ...repositoryObservation, reservationId: "private-reservation" }],
    [
      "execution template",
      {
        ...repositoryObservation,
        job: { ...repositoryObservation.job, executionTemplate: "private-template" },
      },
    ],
    [
      "raw capabilities",
      {
        ...repositoryObservation,
        workerInspection: {
          ...repositoryObservation.workerInspection,
          capabilities: { private: "payload" },
        },
      },
    ],
    [
      "foreign concurrency holder",
      {
        ...repositoryObservation,
        reasons: [
          { code: "concurrency_busy", effect: "claim_gate", holderJobId: "private-holder" },
        ],
      },
    ],
    [
      "unobserved desktop cause",
      { ...repositoryObservation, reasons: [{ code: "desktop_locked", effect: "claim_gate" }] },
    ],
    [
      "credential cause",
      {
        ...repositoryObservation,
        reasons: [{ code: "credentials_missing", effect: "claim_gate" }],
      },
    ],
    [
      "source observation as a claim gate",
      { ...repositoryObservation, reasons: [{ code: "source_obsolete", effect: "claim_gate" }] },
    ],
    [
      "committed capacity as a claim gate",
      {
        ...repositoryObservation,
        reasons: [{ code: "worker_capacity_unavailable", effect: "claim_gate" }],
      },
    ],
  ])("rejects unsupported or private %s", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: routes[0].url, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("private-");
    expect(response.json()).not.toHaveProperty("subject");
    expectNoStore(response);
  });
});

describe("current scheduling policy observations", () => {
  it.each(routes)("requires a strict current policy for $name", async (route) => {
    const { policy: _policy, ...missingPolicy } = route.output;
    for (const output of [
      missingPolicy,
      { ...route.output, policy: null },
      { ...route.output, policy: { ...route.output.policy, currentLimit: 3 } },
      {
        ...route.output,
        policy: { ...route.output.policy, platform: { visibility: "restricted" } },
      },
    ]) {
      const f = fixture(output);
      const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.json()).not.toHaveProperty("policy");
      expectNoStore(response);
    }
  });

  it.each([repositoryObservation, requestObservation])(
    "rejects a substituted repository policy for $subject.kind",
    async (output) => {
      const route = output.subject.kind === "repository_job" ? routes[0] : routes[1];
      for (const repository of [
        null,
        { ...output.policy.repository, repositoryId: "foreign-private-repository" },
      ]) {
        const f = fixture({ ...output, policy: { ...output.policy, repository } });
        const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
        expect(response.statusCode).toBe(502);
        expect(response.body).not.toContain("foreign-private-repository");
      }
    },
  );

  it.each([repositoryObservation, platformObservation])(
    "requires full platform details through the platform endpoint for $subject.kind",
    async (output) => {
      const f = fixture({
        ...output,
        policy: { ...output.policy, platform: repositoryObservation.policy.platform },
      });
      const response = await f.app.inject({
        method: "GET",
        url: routes[2].url,
        headers: headers(),
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).not.toHaveProperty("policy");
    },
  );

  it("does not accept global counts or foreign holders inside restricted platform capacity", async () => {
    for (const extra of [
      { usage: platformObservation.policy.platform.usage },
      { holderRepositoryId: "foreign-private-holder" },
    ]) {
      const f = fixture({
        ...repositoryObservation,
        policy: {
          ...repositoryObservation.policy,
          platform: { ...repositoryObservation.policy.platform, ...extra },
        },
      });
      const response = await f.app.inject({
        method: "GET",
        url: routes[0].url,
        headers: headers(),
      });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain("foreign-private-holder");
      expect(response.json()).not.toHaveProperty("policy");
    }
  });

  it("requires proven quota gates and preserves explicit restricted capacity", async () => {
    const output = {
      ...repositoryObservation,
      job: {
        ...repositoryObservation.job,
        admission: { ...admission, state: "pending", admittedAt: null },
      },
      policy: {
        repository: {
          ...repositoryObservation.policy.repository,
          limits: { maxActiveLeases: 1, maxQueuedJobs: 1 },
          usage: {
            ...repositoryObservation.policy.repository.usage,
            activeLeases: 1,
            awaitingAdmissionJobs: 1,
          },
        },
        platform: {
          ...repositoryObservation.policy.platform,
          activeCapacity: "limited",
          queueCapacity: "limited",
        },
      },
      reasons: [
        { code: "awaiting_admission", effect: "claim_gate" },
        { code: "repository_queue_limit", effect: "admission_gate" },
        { code: "platform_queue_limit", effect: "admission_gate" },
        { code: "repository_active_limit", effect: "claim_gate" },
        { code: "platform_active_limit", effect: "claim_gate" },
      ],
    } satisfies SchedulingDiagnostics;
    const valid = fixture(output);
    const accepted = await valid.app.inject({
      method: "GET",
      url: routes[0].url,
      headers: headers(),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(output);
    for (const invalid of [
      { ...output, reasons: output.reasons.slice(0, 1) },
      {
        ...output,
        reasons: output.reasons.map((reason) =>
          reason.effect === "admission_gate" ? { ...reason, effect: "claim_gate" } : reason,
        ),
      },
      {
        ...repositoryObservation,
        reasons: [{ code: "repository_active_limit", effect: "claim_gate" }],
      },
    ]) {
      const f = fixture(invalid);
      const rejected = await f.app.inject({
        method: "GET",
        url: routes[0].url,
        headers: headers(),
      });
      expect(rejected.statusCode).toBe(502);
      expect(rejected.json()).not.toHaveProperty("policy");
    }
  });
});

describe("current scheduling admission observations", () => {
  const pendingAdmission = { ...admission, state: "pending", admittedAt: null } as const;
  const awaitingAdmission = { code: "awaiting_admission", effect: "claim_gate" } as const;
  const pendingObservation = {
    ...repositoryObservation,
    job: { ...repositoryObservation.job, admission: pendingAdmission },
    reasons: [awaitingAdmission],
  } satisfies SchedulingDiagnostics;

  it.each(routes)(
    "rejects exact historical V1 responses on the current $name endpoint",
    async (route) => {
      const { admission: _admission, ...historicalJob } = route.output.job;
      const { policy: _policy, ...historicalObservation } = route.output;
      const historical = {
        ...historicalObservation,
        schemaVersion: "SchedulingDiagnosticsV1",
        job: historicalJob,
      };
      expect(Value.Check(SchedulingDiagnosticsV1Schema, historical)).toBe(true);
      const f = fixture(historical);
      const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.json()).not.toHaveProperty("subject");
      expectNoStore(response);
    },
  );

  it.each(routes)(
    "rejects exact historical V2 responses on the current $name endpoint",
    async (route) => {
      const { policy: _policy, ...historicalObservation } = route.output;
      const historical = { ...historicalObservation, schemaVersion: "SchedulingDiagnosticsV2" };
      expect(Value.Check(SchedulingDiagnosticsV2Schema, historical)).toBe(true);
      const f = fixture(historical);
      const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
      expect(response.statusCode).toBe(502);
      expect(response.json()).not.toHaveProperty("policy");
    },
  );

  it.each(routes)("returns the exact pending episode and claim gate for $name", async (route) => {
    const output = {
      ...route.output,
      job: { ...route.output.job, admission: pendingAdmission },
      reasons: [awaitingAdmission],
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: route.url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(route.operation, route.input);
    expectNoStore(response);
  });

  it.each([
    [
      "missing waiting episode",
      { ...repositoryObservation, job: { ...repositoryObservation.job, admission: null } },
    ],
    [
      "missing admission field",
      { ...repositoryObservation, job: { ...repositoryObservation.job, admission: undefined } },
    ],
    [
      "episode from another attempt",
      { ...pendingObservation, job: { ...pendingObservation.job, attemptCount: 1 } },
    ],
    ["pending episode without its claim gate", { ...pendingObservation, reasons: [] }],
    [
      "admitted episode with a pending gate",
      { ...repositoryObservation, reasons: [awaitingAdmission] },
    ],
    [
      "pending gate mislabeled as a prerequisite",
      {
        ...pendingObservation,
        reasons: [{ ...awaitingAdmission, effect: "current_prerequisite" }],
      },
    ],
    [
      "pending gate mislabeled as an observation",
      { ...pendingObservation, reasons: [{ ...awaitingAdmission, effect: "observation" }] },
    ],
    [
      "pending episode with an admission timestamp",
      {
        ...pendingObservation,
        job: {
          ...pendingObservation.job,
          admission: { ...pendingAdmission, admittedAt: timestamp },
        },
      },
    ],
    [
      "admitted episode without an admission timestamp",
      {
        ...repositoryObservation,
        job: { ...repositoryObservation.job, admission: { ...admission, admittedAt: null } },
      },
    ],
    [
      "noncanonical admission request time",
      {
        ...pendingObservation,
        job: {
          ...pendingObservation.job,
          admission: { ...pendingAdmission, requestedAt: "2026-09-07T11:00:00Z" },
        },
      },
    ],
    [
      "noncanonical admission time",
      {
        ...repositoryObservation,
        job: {
          ...repositoryObservation.job,
          admission: { ...admission, admittedAt: "2026-09-07T12:00:00Z" },
        },
      },
    ],
    [
      "private episode sequence",
      {
        ...pendingObservation,
        job: { ...pendingObservation.job, admission: { ...pendingAdmission, episodeSequence: 12 } },
      },
    ],
    [
      "active job exposing a queue episode",
      {
        ...repositoryObservation,
        stage: "executing",
        job: { ...repositoryObservation.job, status: "running", nextAttemptAt: null },
        workerInspection: { state: "not_applicable", latestContactAt: null },
      },
    ],
    [
      "terminal job exposing a queue episode",
      {
        ...repositoryObservation,
        stage: "terminal",
        job: { ...repositoryObservation.job, status: "cancelled", nextAttemptAt: null },
        workerInspection: { state: "not_applicable", latestContactAt: null },
      },
    ],
  ])("rejects %s without disclosing the invalid observation", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: routes[0].url, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("subject");
    expect(response.json()).not.toHaveProperty("job");
    expectNoStore(response);
  });

  it("rejects an awaiting-admission claim for a request without a Job", async () => {
    const f = fixture({
      ...requestObservation,
      job: null,
      workerInspection: { state: "not_applicable", latestContactAt: null },
      reasons: [awaitingAdmission],
    });
    const response = await f.app.inject({ method: "GET", url: routes[1].url, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("subject");
    expectNoStore(response);
  });
});

describe("scheduling observation semantics", () => {
  it.each([
    [
      "partial inventory",
      {
        ...repositoryObservation,
        workerInspection: { state: "partial", latestContactAt: timestamp },
        reasons: [{ code: "inspection_incomplete", effect: "observation" }],
      },
    ],
    [
      "current local capacity report",
      {
        ...repositoryObservation,
        reasons: [{ code: "worker_capacity_unavailable", effect: "observation" }],
      },
    ],
    [
      "current source prerequisite",
      {
        ...repositoryObservation,
        reasons: [{ code: "source_obsolete", effect: "current_prerequisite" }],
      },
    ],
    [
      "future retry eligibility",
      {
        ...repositoryObservation,
        job: {
          ...repositoryObservation.job,
          status: "retry_waiting",
          attemptCount: 1,
          admission: { ...admission, attemptBase: 1 },
          nextAttemptAt: "2026-09-07T12:01:00.000Z",
        },
        reasons: [
          { code: "retry_backoff", effect: "claim_gate", until: "2026-09-07T12:01:00.000Z" },
        ],
      },
    ],
    [
      "complete inventory with no worker",
      {
        ...repositoryObservation,
        workerInspection: { state: "complete", latestContactAt: null },
        reasons: [{ code: "no_registered_worker", effect: "claim_gate" }],
      },
    ],
    [
      "leased job",
      {
        ...repositoryObservation,
        stage: "executing",
        job: {
          ...repositoryObservation.job,
          status: "leased",
          attemptCount: 1,
          admission: null,
          nextAttemptAt: null,
        },
        workerInspection: { state: "not_applicable", latestContactAt: null },
      },
    ],
    [
      "cancel request still executing",
      {
        ...repositoryObservation,
        stage: "executing",
        job: {
          ...repositoryObservation.job,
          status: "cancel_requested",
          attemptCount: 1,
          admission: null,
          nextAttemptAt: null,
        },
        workerInspection: { state: "not_applicable", latestContactAt: null },
      },
    ],
    [
      "completed job",
      {
        ...repositoryObservation,
        stage: "terminal",
        job: {
          ...repositoryObservation.job,
          status: "succeeded",
          attemptCount: 1,
          admission: null,
          nextAttemptAt: null,
        },
        workerInspection: { state: "not_applicable", latestContactAt: null },
      },
    ],
    [
      "cancelled pending job",
      {
        ...repositoryObservation,
        stage: "terminal",
        job: {
          ...repositoryObservation.job,
          status: "cancelled",
          admission: null,
          nextAttemptAt: null,
        },
        workerInspection: { state: "not_applicable", latestContactAt: null },
      },
    ],
    [
      "recorded creation time after a wall-clock rollback",
      {
        ...repositoryObservation,
        job: { ...repositoryObservation.job, createdAt: "2026-09-07T13:00:00.000Z" },
      },
    ],
    [
      "recorded contact time after a wall-clock rollback",
      {
        ...repositoryObservation,
        workerInspection: { state: "complete", latestContactAt: "2026-09-07T12:00:01.000Z" },
      },
    ],
    [
      "bounded requirement projection that omitted unsupported names",
      {
        ...repositoryObservation,
        requirements: { names: ["labels.validationWeb"], truncated: true },
      },
    ],
  ])("preserves an honest %s observation", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: routes[0].url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
  it.each([
    [
      "noncanonical observation timestamp",
      { ...repositoryObservation, observedAt: "2026-09-07T12:00:00Z" },
    ],
    [
      "noncanonical creation timestamp",
      {
        ...repositoryObservation,
        job: { ...repositoryObservation.job, createdAt: "2026-09-07T11:00:00Z" },
      },
    ],
    [
      "noncanonical contact timestamp",
      {
        ...repositoryObservation,
        workerInspection: { state: "complete", latestContactAt: "2026-09-07T12:00:00Z" },
      },
    ],
    [
      "contact without inspection",
      {
        ...repositoryObservation,
        workerInspection: { state: "not_applicable", latestContactAt: timestamp },
      },
    ],
    ["jobless repository subject", { ...repositoryObservation, job: null }],
    ["queued executing mismatch", { ...repositoryObservation, stage: "executing" }],
    [
      "terminal waiting mismatch",
      {
        ...repositoryObservation,
        job: { ...repositoryObservation.job, status: "failed", admission: null },
      },
    ],
    [
      "active job inspected as waiting",
      {
        ...repositoryObservation,
        stage: "executing",
        job: {
          ...repositoryObservation.job,
          status: "running",
          admission: null,
          nextAttemptAt: null,
        },
      },
    ],
    [
      "active job with retry eligibility",
      {
        ...repositoryObservation,
        stage: "executing",
        job: { ...repositoryObservation.job, status: "running", admission: null },
        workerInspection: { state: "not_applicable", latestContactAt: null },
      },
    ],
    [
      "terminal job with blocker",
      {
        ...repositoryObservation,
        stage: "terminal",
        job: {
          ...repositoryObservation.job,
          status: "failed",
          admission: null,
          nextAttemptAt: null,
        },
        workerInspection: { state: "not_applicable", latestContactAt: null },
        reasons: [{ code: "repository_paused", effect: "claim_gate" }],
      },
    ],
    [
      "partial inventory without marker",
      {
        ...repositoryObservation,
        workerInspection: { state: "partial", latestContactAt: timestamp },
      },
    ],
    [
      "complete inventory with incomplete marker",
      {
        ...repositoryObservation,
        reasons: [{ code: "inspection_incomplete", effect: "observation" }],
      },
    ],
    [
      "partial inventory proves absence",
      {
        ...repositoryObservation,
        workerInspection: { state: "partial", latestContactAt: timestamp },
        reasons: [
          { code: "inspection_incomplete", effect: "observation" },
          { code: "no_registered_worker", effect: "claim_gate" },
        ],
      },
    ],
    [
      "partial inventory proves incompatibility",
      {
        ...repositoryObservation,
        workerInspection: { state: "partial", latestContactAt: timestamp },
        reasons: [
          { code: "inspection_incomplete", effect: "observation" },
          { code: "no_compatible_worker", effect: "claim_gate" },
        ],
      },
    ],
    [
      "no inspection proves occupied slots",
      {
        ...repositoryObservation,
        workerInspection: { state: "not_applicable", latestContactAt: null },
        reasons: [{ code: "worker_slots_occupied", effect: "claim_gate" }],
      },
    ],
    [
      "backoff timestamp disagrees with job",
      {
        ...repositoryObservation,
        reasons: [
          { code: "retry_backoff", effect: "claim_gate", until: "2026-09-07T12:01:00.000Z" },
        ],
      },
    ],
    [
      "past backoff marked as blocking",
      {
        ...repositoryObservation,
        reasons: [
          {
            code: "retry_backoff",
            effect: "claim_gate",
            until: repositoryObservation.job.nextAttemptAt,
          },
        ],
      },
    ],
    [
      "noncanonical retry time",
      {
        ...repositoryObservation,
        job: { ...repositoryObservation.job, nextAttemptAt: "2026-09-07T12:01:00Z" },
      },
    ],
    ["false reason truncation", { ...repositoryObservation, reasonsTruncated: true }],
    [
      "duplicate requirements",
      {
        ...repositoryObservation,
        requirements: { names: ["labels.validationWeb", "labels.validationWeb"], truncated: false },
      },
    ],
    [
      "duplicate reasons",
      {
        ...repositoryObservation,
        reasons: [
          { code: "repository_paused", effect: "claim_gate" },
          { code: "repository_paused", effect: "claim_gate" },
        ],
      },
    ],
    [
      "existing job gate mislabeled as prerequisite",
      {
        ...repositoryObservation,
        reasons: [{ code: "repository_paused", effect: "current_prerequisite" }],
      },
    ],
    [
      "one gate reported with two effects",
      {
        ...repositoryObservation,
        reasons: [
          { code: "repository_paused", effect: "claim_gate" },
          { code: "repository_paused", effect: "current_prerequisite" },
        ],
      },
    ],
    [
      "capacity report without inspecting workers",
      {
        ...repositoryObservation,
        workerInspection: { state: "not_applicable", latestContactAt: null },
        reasons: [{ code: "worker_capacity_unavailable", effect: "observation" }],
      },
    ],
    [
      "absent workers with occupied worker slots",
      {
        ...repositoryObservation,
        workerInspection: { state: "complete", latestContactAt: null },
        reasons: [
          { code: "no_registered_worker", effect: "claim_gate" },
          { code: "worker_slots_occupied", effect: "claim_gate" },
        ],
      },
    ],
    [
      "incompatible inventory with a compatible unavailable worker",
      {
        ...repositoryObservation,
        reasons: [
          { code: "no_compatible_worker", effect: "claim_gate" },
          { code: "compatible_worker_unavailable", effect: "claim_gate" },
        ],
      },
    ],
    [
      "oversized requirement name",
      { ...repositoryObservation, requirements: { names: ["x".repeat(129)], truncated: false } },
    ],
    [
      "unbounded requirements",
      {
        ...repositoryObservation,
        requirements: {
          names: Array.from({ length: 65 }, (_, index) => `requirement-${index}`),
          truncated: false,
        },
      },
    ],
    [
      "unbounded reasons",
      {
        ...repositoryObservation,
        reasons: Array.from({ length: 33 }, (_, index) => ({
          code: "plan_prerequisite_missing",
          effect: "current_prerequisite",
          requirement: `requirement-${index}`,
        })),
      },
    ],
    [
      "unsafe requirement text",
      {
        ...repositoryObservation,
        requirements: { names: ["private value with spaces"], truncated: false },
      },
    ],
  ])("rejects %s through shared semantic and structural validation", async (_name, output) => {
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: routes[0].url, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("subject");
  });
  it("does not claim a lease gate for a request with no job", async () => {
    const f = fixture({
      ...requestObservation,
      job: null,
      reasons: [{ code: "repository_paused", effect: "claim_gate" }],
    });
    const response = await f.app.inject({ method: "GET", url: routes[1].url, headers: headers() });
    expect(response.statusCode).toBe(502);
  });
  it("accepts complete bounded previews whose truncation is explicit", async () => {
    const output = {
      ...requestObservation,
      job: null,
      requirements: {
        names: Array.from({ length: 64 }, (_, index) => `requirement-${index}`),
        truncated: true,
      },
      reasons: Array.from({ length: 32 }, (_, index) => ({
        code: "plan_prerequisite_missing",
        effect: "current_prerequisite",
        requirement: `requirement-${index}`,
      })),
      reasonsTruncated: true,
    };
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: routes[1].url, headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(output);
  });
  it("rejects a pathological response larger than the 64 KiB wire limit", async () => {
    const output = { ...repositoryObservation, observedAt: `2026-09-07${" ".repeat(65_536)}` };
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeGreaterThan(65_536);
    const f = fixture(output);
    const response = await f.app.inject({ method: "GET", url: routes[0].url, headers: headers() });
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty("subject");
  });
});
