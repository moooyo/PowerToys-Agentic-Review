import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type OperatorAuthRouteService, readOperatorSession } from "./auth.js";

export const operatorConfigurationRateLimits = {
  // The IP boundary runs before authentication and protects the owner from aggregate abuse.
  // Normal operator budgets are independent of a shared NAT, proxy, or loopback address.
  ipRequestsPerMinute: 6_000,
  // An active Run view polls about 38 times per minute. Leave room for several tabs,
  // repository/System polling, initial loads, and refreshes after explicit operator actions.
  readsPerPrincipalPerMinute: 600,
  mutationsPerPrincipalPerMinute: 120,
} as const;

type RateLimitResult = Awaited<ReturnType<ReturnType<FastifyInstance["createRateLimit"]>>>;

function sendLimit(reply: FastifyReply, result: RateLimitResult): FastifyReply | undefined {
  if (result.isAllowed || !result.isExceeded) return undefined;
  return reply
    .header("cache-control", "private, no-store")
    .header("vary", "Cookie")
    .header("referrer-policy", "no-referrer")
    .header("x-ratelimit-limit", result.max)
    .header("x-ratelimit-remaining", 0)
    .header("x-ratelimit-reset", result.ttlInSeconds)
    .header("retry-after", result.ttlInSeconds)
    .code(429)
    .send({
      code: "request_rate_limited",
      message: "Too many requests were received. Retry later.",
      retryable: true,
    });
}

export async function registerOperatorConfigurationRateLimits(
  scope: FastifyInstance,
  auth: OperatorAuthRouteService,
): Promise<void> {
  await scope.register(rateLimit, { global: false, timeWindow: "1 minute" });
  const ipLimit = scope.createRateLimit({
    max: operatorConfigurationRateLimits.ipRequestsPerMinute,
    timeWindow: "1 minute",
  });
  const principals = new WeakMap<FastifyRequest, string>();
  const keyGenerator = (request: FastifyRequest): string => {
    const key = principals.get(request);
    if (key === undefined) throw new Error("An authenticated operator rate-limit key is required.");
    return key;
  };
  const readLimit = scope.createRateLimit({
    max: operatorConfigurationRateLimits.readsPerPrincipalPerMinute,
    timeWindow: "1 minute",
    keyGenerator,
  });
  const mutationLimit = scope.createRateLimit({
    max: operatorConfigurationRateLimits.mutationsPerPrincipalPerMinute,
    timeWindow: "1 minute",
    keyGenerator,
  });

  // createRateLimit deliberately supports both layers. Two rateLimit() hooks would share
  // the plugin's request marker and silently skip the second limiter.
  scope.addHook("onRequest", async (request, reply) => sendLimit(reply, await ipLimit(request)));
  scope.addHook("preHandler", async (request, reply) => {
    // Existing route onRequest guards have already checked origin, session and read-only mode.
    // readOperatorSession memoizes the verified result for this request without another RPC.
    const session = await readOperatorSession(request, auth);
    if (session === null)
      return reply.code(401).send({
        code: "operator_authentication_required",
        message: "An authenticated operator session is required.",
        retryable: false,
      });
    principals.set(
      request,
      createHash("sha256")
        .update(JSON.stringify([session.issuer, session.subject]))
        .digest("hex"),
    );
    const limit = request.method === "GET" || request.method === "HEAD" ? readLimit : mutationLimit;
    const result = await limit(request);
    const denied = sendLimit(reply, result);
    if (denied !== undefined) return denied;
    if (!result.isAllowed) {
      reply
        .header("x-ratelimit-limit", result.max)
        .header("x-ratelimit-remaining", result.remaining)
        .header("x-ratelimit-reset", result.ttlInSeconds);
    }
  });
}
