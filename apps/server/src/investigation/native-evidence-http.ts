import {
  EntityIdSchema,
  InvestigationCurrentCommentSchema,
  InvestigationFindingSourceSchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireCondition } from "./errors.js";
import type { InvestigationNativeEvidenceReads } from "./native-evidence-read.js";
import type { InvestigationOperatorAuthenticator } from "./types.js";

export function registerInvestigationNativeEvidenceRoutes(
  app: FastifyInstance,
  options: {
    readonly authenticateOperator: InvestigationOperatorAuthenticator;
    readonly reads: InvestigationNativeEvidenceReads;
  },
): void {
  app.get<{ Params: { id: string } }>(
    "/api/comments/:id/current",
    {
      schema: {
        params: Type.Object({ id: EntityIdSchema }, { additionalProperties: false }),
        response: { 200: InvestigationCurrentCommentSchema },
      },
    },
    async (request, reply) => {
      const actor = await options.authenticateOperator(request);
      requireCondition(
        actor !== null,
        401,
        "operator_authentication_required",
        "Operator authentication is required.",
      );
      reply.header("cache-control", "no-store");
      return options.reads.currentComment(actor, request.params.id);
    },
  );
  app.get<{ Params: { id: string; findingId: string }; Querystring: { locationIndex?: string } }>(
    "/api/reports/:id/findings/:findingId/source",
    {
      schema: {
        params: Type.Object(
          { id: EntityIdSchema, findingId: EntityIdSchema },
          { additionalProperties: false },
        ),
        querystring: Type.Object(
          { locationIndex: Type.Optional(Type.String({ pattern: "^(?:0|[1-9][0-9]{0,5})$" })) },
          { additionalProperties: false },
        ),
        response: { 200: InvestigationFindingSourceSchema },
      },
    },
    async (request, reply) => {
      const actor = await options.authenticateOperator(request);
      requireCondition(
        actor !== null,
        401,
        "operator_authentication_required",
        "Operator authentication is required.",
      );
      reply.header("cache-control", "no-store");
      return options.reads.findingSource(
        actor,
        request.params.id,
        request.params.findingId,
        request.query.locationIndex === undefined ? 0 : Number(request.query.locationIndex),
      );
    },
  );
}
