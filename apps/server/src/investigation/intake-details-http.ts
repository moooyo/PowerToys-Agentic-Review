import {
  EntityIdSchema,
  InvestigationGitHubUserSchema,
  InvestigationIntakeDetailsSchema,
  InvestigationWorkItemAuthorSchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireCondition } from "./errors.js";
import type { InvestigationGitHubIdentityResolver } from "./github-identity.js";
import type { InvestigationIntakeDetailsService } from "./intake-details.js";
import type { InvestigationOperatorPrincipal } from "./types.js";
import type { InvestigationWorkItemAuthorReader } from "./work-item-author.js";

export function registerInvestigationIntakeDetailsRoutes(
  app: FastifyInstance,
  options: {
    readonly details: InvestigationIntakeDetailsService;
    readonly identities: Pick<InvestigationGitHubIdentityResolver, "resolve">;
    readonly authors?: Pick<InvestigationWorkItemAuthorReader, "read">;
    readonly authenticateOperator: (
      request: FastifyRequest,
    ) => InvestigationOperatorPrincipal | null;
  },
): void {
  const actor = (request: FastifyRequest, reply: FastifyReply) => {
    const principal = options.authenticateOperator(request);
    requireCondition(
      principal !== null,
      401,
      "operator_authentication_required",
      "Operator authentication is required.",
    );
    reply.header("cache-control", "no-store");
    return principal;
  };
  const params = Type.Object({ id: EntityIdSchema }, { additionalProperties: false });
  if (options.authors !== undefined) {
    const authors = options.authors;
    app.get<{ Params: { id: string } }>(
      "/api/work-items/:id/author",
      { schema: { params, response: { 200: InvestigationWorkItemAuthorSchema } } },
      (request, reply) => authors.read(actor(request, reply), request.params.id),
    );
  }
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/intake-details",
    { schema: { params, response: { 200: InvestigationIntakeDetailsSchema } } },
    (request, reply) => options.details.read(actor(request, reply), request.params.id),
  );
  app.get<{ Params: { id: string; lookup: string } }>(
    "/api/repositories/:id/github-users/:lookup",
    {
      schema: {
        params: Type.Object(
          { id: EntityIdSchema, lookup: Type.String({ minLength: 1, maxLength: 100 }) },
          { additionalProperties: false },
        ),
        response: { 200: InvestigationGitHubUserSchema },
      },
    },
    async (request, reply) => {
      options.details.authorizeIdentityRead(actor(request, reply), request.params.id);
      return options.identities.resolve(request.params.lookup);
    },
  );
}
