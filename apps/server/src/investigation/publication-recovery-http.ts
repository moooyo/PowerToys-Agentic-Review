import {
  EntityIdSchema,
  type InvestigationPublicationRecoveryRequest,
  InvestigationPublicationRecoveryRequestSchema,
  InvestigationPublicationRecoveryStatusSchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireCondition } from "./errors.js";
import type { InvestigationPublicationRecovery } from "./publication-recovery.js";
import type { InvestigationOperatorPrincipal } from "./types.js";

export function registerInvestigationPublicationRecoveryRoutes(
  app: FastifyInstance,
  options: {
    readonly recovery: InvestigationPublicationRecovery;
    readonly authenticateOperator: (
      request: FastifyRequest,
    ) => InvestigationOperatorPrincipal | null;
  },
): void {
  const params = Type.Object({ id: EntityIdSchema }, { additionalProperties: false });
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
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/publication-recovery",
    { schema: { params, response: { 200: InvestigationPublicationRecoveryStatusSchema } } },
    (request, reply) => options.recovery.read(actor(request, reply), request.params.id),
  );
  app.post<{ Params: { id: string }; Body: InvestigationPublicationRecoveryRequest }>(
    "/api/tasks/:id/publication-recovery",
    {
      schema: {
        params,
        body: InvestigationPublicationRecoveryRequestSchema,
        response: { 202: InvestigationPublicationRecoveryStatusSchema },
      },
    },
    (request, reply) =>
      reply
        .code(202)
        .send(options.recovery.enqueue(actor(request, reply), request.params.id, request.body)),
  );
}
