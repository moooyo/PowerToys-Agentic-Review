import { Readable } from "node:stream";
import {
  EntityIdSchema,
  InvestigationArtifactContentRequestSchema,
  InvestigationArtifactV1Schema,
  InvestigationCheckpointRequestSchema,
  InvestigationClaimRequestSchema,
  InvestigationConfirmActionIntentRequestSchema,
  InvestigationCreateActionIntentRequestSchema,
  InvestigationCreateTaskRequestV1Schema,
  InvestigationFinalizeRequestSchema,
  InvestigationHeartbeatRequestSchema,
  InvestigationReportPartRequestSchema,
  InvestigationTaskKindSchema,
  InvestigationWorkerLeaseSchema,
} from "@agentic-review/contracts";
import { InvestigationLoopError } from "@agentic-review/domain";
import { type Static, Type } from "@sinclair/typebox";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { InvestigationRequestError } from "./errors.js";
import {
  type InvestigationActionContextQuery,
  type InvestigationDirectoryQuery,
  type InvestigationFindingsQuery,
  InvestigationRepositoryRecordSchema,
  InvestigationResumeTaskRequestSchema,
  InvestigationWorkItemRecordSchema,
} from "./protocol.js";
import { InvestigationService, type InvestigationServiceOptions } from "./service.js";
import { InvestigationStore, InvestigationStoreError } from "./store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorAuthenticator,
  InvestigationOperatorPrincipal,
  InvestigationWorkerAuthenticator,
  InvestigationWorkerPrincipal,
} from "./types.js";

export interface InvestigationAppOptions
  extends Pick<
    InvestigationServiceOptions,
    "prepareTaskInput" | "resolveTaskSource" | "resolvePlanPrerequisites" | "maxReportBytes"
  > {
  readonly databasePath?: string;
  readonly store?: InvestigationStore;
  readonly authenticateOperator?: InvestigationOperatorAuthenticator;
  readonly authenticateWorker?: InvestigationWorkerAuthenticator;
  readonly actionTransport?: InvestigationActionTransport;
  readonly enableExternalWrites?: boolean;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly leaseDurationMs?: number;
  readonly https?: { key: string | Buffer; cert: string | Buffer; passphrase?: string };
  readonly logger?: FastifyServerOptions["logger"];
}

const idParamsSchema = Type.Object({ id: EntityIdSchema }, { additionalProperties: false });
const emptyBodySchema = Type.Object({}, { additionalProperties: false });
const artifactUploadBodySchema = Type.Object(
  {
    lease: InvestigationWorkerLeaseSchema,
    artifact: InvestigationArtifactV1Schema,
    contentBase64: Type.String({ maxLength: 44_739_244 }),
  },
  { additionalProperties: false },
);
type IdParams = Static<typeof idParamsSchema>;

const workItemQuerySchema = Type.Object(
  {
    repositoryId: Type.Optional(EntityIdSchema),
    workItemId: Type.Optional(EntityIdSchema),
    kind: Type.Optional(Type.Union([Type.Literal("pull_request"), Type.Literal("issue")])),
  },
  { additionalProperties: false },
);
const taskQuerySchema = Type.Object(
  {
    repositoryId: Type.Optional(EntityIdSchema),
    workItemId: Type.Optional(EntityIdSchema),
    kind: Type.Optional(InvestigationTaskKindSchema),
  },
  { additionalProperties: false },
);
const findingsQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    limit: Type.Optional(
      Type.Union([
        Type.Integer({ minimum: 1, maximum: 1_000 }),
        Type.String({ pattern: "^(?:[1-9][0-9]{0,2}|1000)$" }),
      ]),
    ),
  },
  { additionalProperties: false },
);
const actionContextQuerySchema = Type.Object(
  { reportId: Type.Optional(EntityIdSchema) },
  { additionalProperties: false },
);

type BodyOf<Method extends (...args: never[]) => unknown> = Parameters<Method>[1];
type LastBodyOf<Method extends (...args: never[]) => unknown> = Parameters<Method>[2];

export function buildInvestigationApp(options: InvestigationAppOptions = {}): FastifyInstance {
  const store = options.store ?? new InvestigationStore(options.databasePath);
  let service: InvestigationService;
  try {
    service = new InvestigationService({ ...options, store });
  } catch (error) {
    if (options.store === undefined) store.close();
    throw error;
  }

  const app = Fastify({
    ...(options.logger === undefined ? { logger: false } : { logger: options.logger }),
    ...(options.https === undefined ? {} : { https: options.https }),
    // This limit applies to a request segment, never to the assembled report or export.
    bodyLimit: 32 * 1_024 * 1_024,
    requestTimeout: 40_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });

  if (options.store === undefined) {
    app.addHook("onClose", async () => store.close());
  }

  const operators = new WeakMap<object, InvestigationOperatorPrincipal>();
  const workers = new WeakMap<object, InvestigationWorkerPrincipal>();

  async function authenticateOperator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const principal = await options.authenticateOperator?.(request);
    if (principal === undefined || principal === null) {
      throw new InvestigationRequestError(
        401,
        "operator_authentication_required",
        "Operator authentication is required.",
      );
    }
    operators.set(request, principal);
    reply.header("cache-control", "no-store");
  }

  async function authenticateWorker(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const principal = await options.authenticateWorker?.(request);
    if (principal === undefined || principal === null) {
      throw new InvestigationRequestError(
        401,
        "worker_authentication_required",
        "Worker authentication is required.",
      );
    }
    workers.set(request, principal);
    reply.header("cache-control", "no-store");
  }

  function actor(request: object): InvestigationOperatorPrincipal {
    const principal = operators.get(request);
    if (principal === undefined) {
      throw new InvestigationRequestError(
        401,
        "operator_authentication_required",
        "Operator authentication is required.",
      );
    }
    return principal;
  }

  function worker(request: object): InvestigationWorkerPrincipal {
    const principal = workers.get(request);
    if (principal === undefined) {
      throw new InvestigationRequestError(
        401,
        "worker_authentication_required",
        "Worker authentication is required.",
      );
    }
    return principal;
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof InvestigationLoopError) {
      return reply.code(409).send({ code: error.code, message: error.message, retryable: false });
    }
    if (error instanceof InvestigationRequestError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        retryable: error.statusCode >= 500,
      });
    }
    if (error instanceof InvestigationStoreError && error.code === "conflict") {
      return reply.code(409).send({
        code: "conflict",
        message: "An entity with this ID already exists.",
        retryable: false,
      });
    }
    if (error instanceof Error && "validation" in error && error.validation !== undefined) {
      return reply.code(400).send({
        code: "invalid_request",
        message: "The request does not match the investigation API contract.",
        retryable: false,
      });
    }
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({
        code: error.statusCode === 413 ? "request_too_large" : "invalid_request",
        message:
          error.statusCode === 413
            ? "The request segment exceeds the transport limit."
            : "The request could not be processed.",
        retryable: false,
      });
    }
    request.log.error({ code: "investigation_internal_error" }, "Investigation request failed.");
    return reply.code(500).send({
      code: "internal_error",
      message: "The investigation request could not be completed.",
      retryable: true,
    });
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get(
    "/api/repositories",
    { preHandler: authenticateOperator },
    async (request) => await service.listRepositories(actor(request)),
  );
  app.post<{ Body: BodyOf<InvestigationService["registerRepository"]> }>(
    "/api/repositories",
    { preHandler: authenticateOperator, schema: { body: InvestigationRepositoryRecordSchema } },
    async (request, reply) => {
      const result = await service.registerRepository(actor(request), request.body);
      return reply.code(201).send(result);
    },
  );
  app.get<{ Querystring: InvestigationDirectoryQuery }>(
    "/api/work-items",
    { preHandler: authenticateOperator, schema: { querystring: workItemQuerySchema } },
    async (request) => await service.listWorkItems(actor(request), request.query),
  );
  app.post<{ Body: BodyOf<InvestigationService["registerWorkItem"]> }>(
    "/api/work-items",
    { preHandler: authenticateOperator, schema: { body: InvestigationWorkItemRecordSchema } },
    async (request, reply) => {
      const result = await service.registerWorkItem(actor(request), request.body);
      return reply.code(201).send(result);
    },
  );
  app.get<{ Params: IdParams }>(
    "/api/work-items/:id",
    { preHandler: authenticateOperator, schema: { params: idParamsSchema } },
    async (request) => await service.getWorkItem(actor(request), request.params.id),
  );

  app.get<{ Querystring: InvestigationDirectoryQuery }>(
    "/api/tasks",
    { preHandler: authenticateOperator, schema: { querystring: taskQuerySchema } },
    async (request) => await service.listTasks(actor(request), request.query),
  );
  app.post<{ Body: BodyOf<InvestigationService["createTask"]> }>(
    "/api/tasks",
    { preHandler: authenticateOperator, schema: { body: InvestigationCreateTaskRequestV1Schema } },
    async (request, reply) => {
      const result = await service.createTask(actor(request), request.body);
      return reply.code(201).send(result);
    },
  );
  app.get<{ Params: IdParams }>(
    "/api/tasks/:id",
    { preHandler: authenticateOperator, schema: { params: idParamsSchema } },
    async (request) => await service.getTask(actor(request), request.params.id),
  );
  app.post<{ Params: IdParams; Body: LastBodyOf<InvestigationService["resumeTask"]> }>(
    "/api/tasks/:id/resume",
    {
      preHandler: authenticateOperator,
      schema: { params: idParamsSchema, body: InvestigationResumeTaskRequestSchema },
    },
    async (request) => await service.resumeTask(actor(request), request.params.id, request.body),
  );
  app.post<{ Params: IdParams }>(
    "/api/tasks/:id/cancel",
    { preHandler: authenticateOperator, schema: { params: idParamsSchema, body: emptyBodySchema } },
    async (request) => await service.cancelTask(actor(request), request.params.id),
  );

  app.get<{ Params: IdParams }>(
    "/api/reports/:id",
    { preHandler: authenticateOperator, schema: { params: idParamsSchema } },
    async (request) => await service.reportHeader(actor(request), request.params.id),
  );
  app.get<{ Params: IdParams; Querystring: InvestigationFindingsQuery }>(
    "/api/reports/:id/findings",
    {
      preHandler: authenticateOperator,
      schema: { params: idParamsSchema, querystring: findingsQuerySchema },
    },
    async (request) =>
      await service.reportFindings(actor(request), request.params.id, request.query),
  );
  app.get<{ Params: IdParams }>(
    "/api/reports/:id/export",
    { preHandler: authenticateOperator, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const result = await service.reportExport(actor(request), request.params.id);
      const stream = Readable.from([JSON.stringify(result)], { encoding: "utf8" });
      return reply
        .type("application/json; charset=utf-8")
        .header("content-disposition", `attachment; filename="${request.params.id}.json"`)
        .send(stream);
    },
  );
  app.get<{ Params: IdParams }>(
    "/api/artifacts/:id/content",
    { preHandler: authenticateOperator, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const { artifact, content } = await service.artifactContent(
        actor(request),
        request.params.id,
      );
      const filename = encodeURIComponent(artifact.name).replace(
        /['()*]/gu,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return reply
        .type(artifact.mediaType)
        .header("content-disposition", `attachment; filename*=UTF-8''${filename}`)
        .header("content-length", content.byteLength)
        .header("etag", `"${artifact.digest}"`)
        .header("x-content-type-options", "nosniff")
        .send(content);
    },
  );

  app.get<{ Params: IdParams; Querystring: InvestigationActionContextQuery }>(
    "/api/work-items/:id/action-context",
    {
      preHandler: authenticateOperator,
      schema: { params: idParamsSchema, querystring: actionContextQuerySchema },
    },
    async (request) =>
      await service.actionContext(actor(request), request.params.id, request.query),
  );
  app.post<{ Body: BodyOf<InvestigationService["createIntent"]> }>(
    "/api/action-intents",
    {
      preHandler: authenticateOperator,
      schema: { body: InvestigationCreateActionIntentRequestSchema },
    },
    async (request, reply) => {
      const result = await service.createIntent(actor(request), request.body);
      return reply.code(201).send(result);
    },
  );
  app.get<{ Params: IdParams }>(
    "/api/action-intents/:id",
    { preHandler: authenticateOperator, schema: { params: idParamsSchema } },
    async (request) => await service.getIntent(actor(request), request.params.id),
  );
  app.post<{ Params: IdParams; Body: LastBodyOf<InvestigationService["confirmIntent"]> }>(
    "/api/action-intents/:id/confirm",
    {
      preHandler: authenticateOperator,
      schema: { params: idParamsSchema, body: InvestigationConfirmActionIntentRequestSchema },
    },
    async (request) => await service.confirmIntent(actor(request), request.params.id, request.body),
  );
  app.post<{ Params: IdParams }>(
    "/api/action-intents/:id/reconcile",
    { preHandler: authenticateOperator, schema: { params: idParamsSchema, body: emptyBodySchema } },
    async (request) => await service.reconcileIntent(actor(request), request.params.id),
  );

  app.post<{ Body: BodyOf<InvestigationService["workerClaim"]> }>(
    "/api/worker/claims",
    { preHandler: authenticateWorker, schema: { body: InvestigationClaimRequestSchema } },
    async (request) => await service.workerClaim(worker(request), request.body),
  );
  app.post<{ Params: IdParams; Body: LastBodyOf<InvestigationService["workerHeartbeat"]> }>(
    "/api/worker/tasks/:id/heartbeat",
    {
      preHandler: authenticateWorker,
      schema: { params: idParamsSchema, body: InvestigationHeartbeatRequestSchema },
    },
    async (request) =>
      await service.workerHeartbeat(worker(request), request.params.id, request.body),
  );
  app.post<{ Params: IdParams; Body: LastBodyOf<InvestigationService["workerCheckpoint"]> }>(
    "/api/worker/tasks/:id/checkpoints",
    {
      preHandler: authenticateWorker,
      bodyLimit: Math.max(
        96 * 1_024 * 1_024,
        Math.ceil((options.maxReportBytes ?? 64 * 1_024 * 1_024) * 1.5),
      ),
      schema: { params: idParamsSchema, body: InvestigationCheckpointRequestSchema },
    },
    async (request) =>
      await service.workerCheckpoint(worker(request), request.params.id, request.body),
  );
  app.post<{ Params: IdParams; Body: LastBodyOf<InvestigationService["workerPart"]> }>(
    "/api/worker/tasks/:id/report-parts",
    {
      preHandler: authenticateWorker,
      schema: { params: idParamsSchema, body: InvestigationReportPartRequestSchema },
    },
    async (request) => await service.workerPart(worker(request), request.params.id, request.body),
  );
  app.post<{ Params: IdParams; Body: LastBodyOf<InvestigationService["workerArtifact"]> }>(
    "/api/worker/tasks/:id/artifacts",
    {
      preHandler: authenticateWorker,
      // A 32 MiB artifact expands to about 43 MiB when encoded as base64.
      bodyLimit: 48 * 1_024 * 1_024,
      schema: { params: idParamsSchema, body: artifactUploadBodySchema },
    },
    async (request) =>
      await service.workerArtifact(worker(request), request.params.id, request.body),
  );
  app.post<{ Params: IdParams; Body: LastBodyOf<InvestigationService["workerArtifactContent"]> }>(
    "/api/worker/tasks/:id/artifact-content",
    {
      preHandler: authenticateWorker,
      schema: { params: idParamsSchema, body: InvestigationArtifactContentRequestSchema },
    },
    async (request) =>
      await service.workerArtifactContent(worker(request), request.params.id, request.body),
  );
  app.post<{ Params: IdParams; Body: LastBodyOf<InvestigationService["workerFinalize"]> }>(
    "/api/worker/tasks/:id/finalize",
    {
      preHandler: authenticateWorker,
      schema: { params: idParamsSchema, body: InvestigationFinalizeRequestSchema },
    },
    async (request) =>
      await service.workerFinalize(worker(request), request.params.id, request.body),
  );

  return app;
}
