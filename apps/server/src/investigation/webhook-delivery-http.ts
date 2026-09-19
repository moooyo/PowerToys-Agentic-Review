import {
  InvestigationWebhookDeliveryListSchema,
  type InvestigationWebhookDeliveryQuery,
  InvestigationWebhookDeliveryQuerySchema,
  InvestigationWebhookDeliverySchema,
  type InvestigationWebhookRetryRequest,
  InvestigationWebhookRetryRequestSchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireCondition } from "./errors.js";
import type { InvestigationOperatorPrincipal } from "./types.js";
import type { InvestigationWebhookDeliveryControls } from "./webhook-delivery-controls.js";

const params = Type.Object(
  {
    deliveryId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
  },
  { additionalProperties: false },
);
const decimal = Type.String({ minLength: 1, maxLength: 16, pattern: "^[1-9][0-9]*(?![\\s\\S])" });
const query = Type.Object(
  {
    ...Type.Omit(InvestigationWebhookDeliveryQuerySchema, ["number", "limit"]).properties,
    number: Type.Optional(decimal),
    limit: Type.Optional(decimal),
  },
  { additionalProperties: false },
);
type HttpQuery = Omit<InvestigationWebhookDeliveryQuery, "number" | "limit"> & {
  number?: string;
  limit?: string;
};

function queryInput(input: HttpQuery): InvestigationWebhookDeliveryQuery {
  const parse = (value: string, maximum: number) => {
    const result = Number(value);
    requireCondition(
      typeof value === "string" &&
        /^[1-9][0-9]*$/u.test(value) &&
        String(result) === value &&
        Number.isSafeInteger(result) &&
        result <= maximum,
      400,
      "webhook_delivery_query_invalid",
      "Numeric filters must be canonical positive safe integers within their limits.",
    );
    return result;
  };
  const { number, limit, ...filters } = input;
  return {
    ...filters,
    ...(number === undefined ? {} : { number: parse(number, Number.MAX_SAFE_INTEGER) }),
    ...(limit === undefined ? {} : { limit: parse(limit, 50) }),
  };
}

/** Inspection remains available while intake is disabled; retry requires configured intake. */
export function registerInvestigationWebhookDeliveryRoutes(
  app: FastifyInstance,
  options: {
    controls: InvestigationWebhookDeliveryControls;
    authenticateOperator: (request: FastifyRequest) => InvestigationOperatorPrincipal | null;
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
  app.get<{ Querystring: HttpQuery }>(
    "/api/github/webhook-deliveries",
    {
      schema: { querystring: query, response: { 200: InvestigationWebhookDeliveryListSchema } },
    },
    async (request, reply) =>
      options.controls.list(actor(request, reply), queryInput(request.query)),
  );
  app.get<{ Params: { deliveryId: string } }>(
    "/api/github/webhook-deliveries/:deliveryId",
    {
      schema: { params, response: { 200: InvestigationWebhookDeliverySchema } },
    },
    async (request, reply) =>
      options.controls.read(actor(request, reply), request.params.deliveryId),
  );
  app.post<{ Params: { deliveryId: string }; Body: InvestigationWebhookRetryRequest }>(
    "/api/github/webhook-deliveries/:deliveryId/retry",
    {
      schema: {
        params,
        body: InvestigationWebhookRetryRequestSchema,
        response: { 200: InvestigationWebhookDeliverySchema },
      },
    },
    async (request, reply) =>
      options.controls.retry(actor(request, reply), request.params.deliveryId, request.body),
  );
}
