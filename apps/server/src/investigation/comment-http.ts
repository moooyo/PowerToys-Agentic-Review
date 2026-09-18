import {
  EntityIdSchema,
  type InvestigationCommentCommand,
  InvestigationCommentCommandSchema,
  InvestigationCommentDeliveryListSchema,
  type InvestigationCommentDeliveryQuery,
  InvestigationCommentDeliveryQuerySchema,
  InvestigationCommentPublicationListSchema,
  type InvestigationCommentPublicationSummary,
  InvestigationCommentPublicationSummarySchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { InvestigationAutomaticReplies } from "./auto-reply.js";
import type { InvestigationCommentDeliveries } from "./comment-deliveries.js";
import { requireCondition } from "./errors.js";
import type { InvestigationProgressReplies } from "./progress-reply.js";
import type { InvestigationOperatorPrincipal } from "./types.js";

export interface InvestigationCommentRoutesOptions {
  readonly authenticateOperator: (request: FastifyRequest) => InvestigationOperatorPrincipal | null;
  readonly deliveries: InvestigationCommentDeliveries;
  readonly progress: InvestigationProgressReplies;
  readonly automaticReplies: InvestigationAutomaticReplies;
}

const params = Type.Object({ id: EntityIdSchema }, { additionalProperties: false });
const pageQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

/** History reads never queue a network operation. Commands have independent capability guards. */
export function registerInvestigationCommentRoutes(
  app: FastifyInstance,
  options: InvestigationCommentRoutesOptions,
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
  const comment = (principal: InvestigationOperatorPrincipal, id: string) =>
    id.startsWith("auto-reply:report:")
      ? options.automaticReplies.getComment(principal, id)
      : options.progress.getComment(principal, id);

  app.get<{ Querystring: InvestigationCommentDeliveryQuery }>(
    "/api/comment-deliveries",
    {
      schema: {
        querystring: InvestigationCommentDeliveryQuerySchema,
        response: { 200: InvestigationCommentDeliveryListSchema },
      },
    },
    async (request, reply) => options.deliveries.list(actor(request, reply), request.query),
  );

  app.get<{ Querystring: { taskIds?: string; commentIds?: string; repositoryId?: string } }>(
    "/api/comments",
    {
      schema: {
        querystring: Type.Object(
          {
            taskIds: Type.Optional(Type.String({ minLength: 1, maxLength: 25_600 })),
            commentIds: Type.Optional(Type.String({ minLength: 1, maxLength: 25_600 })),
            repositoryId: Type.Optional(EntityIdSchema),
          },
          { additionalProperties: false },
        ),
        response: { 200: InvestigationCommentPublicationListSchema },
      },
    },
    async (request, reply) => {
      const principal = actor(request, reply);
      const query = request.query;
      requireCondition(
        (query.taskIds === undefined) !== (query.commentIds === undefined),
        400,
        "comment_summary_query_invalid",
        "Choose either taskIds or commentIds for a bounded summary request.",
      );
      if (query.repositoryId !== undefined)
        requireCondition(
          principal.repositoryIds.includes(query.repositoryId),
          403,
          "repository_forbidden",
          "This identity cannot read that repository's comments.",
        );
      const ids = [...new Set((query.taskIds ?? query.commentIds ?? "").split(","))];
      requireCondition(
        ids.length > 0 && ids.length <= 100 && ids.every((id) => Value.Check(EntityIdSchema, id)),
        400,
        "comment_summary_query_invalid",
        "Comment summary requests require one to one hundred exact IDs.",
      );
      let items: InvestigationCommentPublicationSummary[];
      if (query.taskIds !== undefined) {
        const summaries = [
          ...options.automaticReplies.taskSummaries(principal, ids).items,
          ...options.progress.taskSummaries(principal, ids).items,
        ];
        const selected = new Map<string, InvestigationCommentPublicationSummary>();
        for (const summary of summaries) {
          if (summary.taskId === null) continue;
          const previous = selected.get(summary.taskId);
          if (
            previous === undefined ||
            summary.mode === "progress" ||
            summary.updatedAt > previous.updatedAt
          )
            selected.set(summary.taskId, summary);
        }
        items = [...selected.values()];
      } else {
        items = ids.map((id) => comment(principal, id));
      }
      return {
        items: items.filter(
          (entry) => query.repositoryId === undefined || entry.repositoryId === query.repositoryId,
        ),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/comments/:id",
    { schema: { params, response: { 200: InvestigationCommentPublicationSummarySchema } } },
    async (request, reply) => comment(actor(request, reply), request.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: number } }>(
    "/api/comments/:id/attempts",
    {
      schema: {
        params,
        querystring: pageQuery,
        response: { 200: InvestigationCommentDeliveryListSchema },
      },
    },
    async (request, reply) => {
      const principal = actor(request, reply);
      comment(principal, request.params.id);
      return options.deliveries.list(principal, { ...request.query, commentId: request.params.id });
    },
  );

  for (const operation of ["sync", "reconcile"] as const) {
    app.post<{ Params: { id: string }; Body: InvestigationCommentCommand }>(
      `/api/comments/:id/${operation}`,
      {
        schema: {
          params,
          body: InvestigationCommentCommandSchema,
          response: { 202: InvestigationCommentPublicationSummarySchema },
        },
      },
      async (request, reply) => {
        const principal = actor(request, reply);
        const summary = comment(principal, request.params.id);
        requireCondition(
          summary.mode === "progress",
          409,
          "comment_action_unavailable",
          "Conclusion-only comments retain their existing ActionIntent recovery workflow.",
        );
        const updated = await options.progress[operation](principal, summary.id, request.body);
        return reply.code(202).send(updated);
      },
    );
  }
}
