import {
  EntityIdSchema,
  InvestigationNativePromptBindingSchema,
  type InvestigationNativePromptBindRequest,
  InvestigationNativePromptBindRequestSchema,
  InvestigationNativePromptCatalogSchema,
  type InvestigationNativePromptKind,
  InvestigationNativePromptKindSchema,
  type InvestigationNativePromptPublishRequest,
  InvestigationNativePromptPublishRequestSchema,
  InvestigationNativePromptVersionSchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireCondition } from "./errors.js";
import type { InvestigationNativePrompts } from "./native-prompts.js";
import type { InvestigationOperatorAuthenticator } from "./types.js";

const repositoryParams = Type.Object(
  { repositoryId: EntityIdSchema },
  { additionalProperties: false },
);
const kindParams = Type.Object(
  { ...repositoryParams.properties, kind: InvestigationNativePromptKindSchema },
  { additionalProperties: false },
);
type Scope = { repositoryId: string; kind: InvestigationNativePromptKind };

export function registerInvestigationNativePromptRoutes(
  app: FastifyInstance,
  options: {
    prompts: InvestigationNativePrompts;
    authenticateOperator: InvestigationOperatorAuthenticator;
  },
): void {
  const actor = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await options.authenticateOperator(request);
    requireCondition(
      principal !== null,
      401,
      "operator_authentication_required",
      "Operator authentication is required.",
    );
    reply.header("cache-control", "no-store");
    return principal;
  };
  app.get<{ Params: Pick<Scope, "repositoryId"> }>(
    "/api/repositories/:repositoryId/native-prompts",
    {
      schema: {
        params: repositoryParams,
        response: { 200: InvestigationNativePromptCatalogSchema },
      },
    },
    async (request, reply) =>
      options.prompts.catalog(await actor(request, reply), request.params.repositoryId),
  );
  app.post<{ Params: Scope; Body: InvestigationNativePromptPublishRequest }>(
    "/api/repositories/:repositoryId/native-prompts/:kind/versions",
    {
      schema: {
        params: kindParams,
        body: InvestigationNativePromptPublishRequestSchema,
        response: { 201: InvestigationNativePromptVersionSchema },
      },
    },
    async (request, reply) => {
      const version = options.prompts.publish(
        await actor(request, reply),
        request.params.repositoryId,
        request.params.kind,
        request.body,
      );
      return reply.code(201).send(version);
    },
  );
  app.post<{ Params: Scope; Body: InvestigationNativePromptBindRequest }>(
    "/api/repositories/:repositoryId/native-prompts/:kind/binding",
    {
      schema: {
        params: kindParams,
        body: InvestigationNativePromptBindRequestSchema,
        response: { 200: InvestigationNativePromptBindingSchema },
      },
    },
    async (request, reply) =>
      options.prompts.bind(
        await actor(request, reply),
        request.params.repositoryId,
        request.params.kind,
        request.body,
      ),
  );
}
