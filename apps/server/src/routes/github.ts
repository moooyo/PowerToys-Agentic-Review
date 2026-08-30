import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  InvalidGitHubWebhookPayloadError,
  normalizeGitHubWebhookPayload,
  UnsupportedGitHubWebhookActionError,
  UnsupportedGitHubWebhookTargetError,
} from "../github/normalize-webhook.js";
import type { GitHubWebhookEventName, IngestGitHubWebhookEvent } from "../github/types.js";
import { verifyGitHubWebhookSignature } from "../github/webhook-signature.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const deliveryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const supportedEventNames = new Set<GitHubWebhookEventName>(["issues", "pull_request"]);

export const DEFAULT_GITHUB_WEBHOOK_PATH = "/api/v1/github/webhook";

export interface GitHubWebhookRouteConfig {
  readonly path: string;
  readonly webhookSecret: string | Buffer;
  readonly maxPayloadBytes: number;
}

export interface GitHubWebhookRouteDependencies {
  readonly config: GitHubWebhookRouteConfig;
  readonly ingest: IngestGitHubWebhookEvent;
  readonly now?: () => Date;
}

class GitHubWebhookHeaderError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GitHubWebhookHeaderError";
  }
}

const readHeaderValues = (request: FastifyRequest, name: string): readonly string[] => {
  const values: string[] = [];
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
};

const readSingleHeader = (request: FastifyRequest, name: string): string => {
  const values = readHeaderValues(request, name);
  if (values.length !== 1 || values[0] === "") {
    throw new GitHubWebhookHeaderError(
      `invalid_${name.replaceAll("-", "_")}`,
      `${name} must be present exactly once and must not be empty.`,
    );
  }
  return values[0] as string;
};

const readDeliveryId = (request: FastifyRequest): string => {
  const deliveryId = readSingleHeader(request, "x-github-delivery");
  if (!deliveryIdPattern.test(deliveryId)) {
    throw new GitHubWebhookHeaderError(
      "invalid_x_github_delivery",
      "x-github-delivery must be a valid opaque delivery identifier.",
    );
  }
  return deliveryId;
};

const readEventName = (request: FastifyRequest): string => {
  const eventName = readSingleHeader(request, "x-github-event");
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(eventName)) {
    throw new GitHubWebhookHeaderError(
      "invalid_x_github_event",
      "x-github-event must contain a valid GitHub event name.",
    );
  }
  return eventName;
};

const parseJson = (rawBody: Buffer): unknown => {
  try {
    return JSON.parse(utf8Decoder.decode(rawBody)) as unknown;
  } catch (error) {
    throw new InvalidGitHubWebhookPayloadError("The webhook body must contain valid UTF-8 JSON.", {
      cause: error,
    });
  }
};

const sendError = (
  reply: FastifyReply,
  statusCode: 400 | 401 | 422,
  code: string,
  message: string,
): FastifyReply =>
  reply.code(statusCode).send({
    code,
    message,
    retryable: false,
  });

const validateConfig = (config: GitHubWebhookRouteConfig): void => {
  if (!/^\/[A-Za-z0-9/_-]+$/.test(config.path)) {
    throw new Error("The GitHub webhook route path must be an absolute static HTTP path.");
  }
  if (
    (typeof config.webhookSecret === "string" && config.webhookSecret.length === 0) ||
    (Buffer.isBuffer(config.webhookSecret) && config.webhookSecret.length === 0)
  ) {
    throw new Error("The GitHub webhook secret must not be empty.");
  }
  if (!Number.isSafeInteger(config.maxPayloadBytes) || config.maxPayloadBytes <= 0) {
    throw new Error("The GitHub webhook payload limit must be a positive safe integer.");
  }
};

export const registerGitHubWebhookRoutes = (
  app: FastifyInstance,
  dependencies: GitHubWebhookRouteDependencies,
): void => {
  validateConfig(dependencies.config);
  const now = dependencies.now ?? (() => new Date());

  app.register((scope, _options, done) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: dependencies.config.maxPayloadBytes },
      (_request, body, next) => {
        if (!Buffer.isBuffer(body)) {
          next(new TypeError("The GitHub webhook parser did not receive a Buffer."));
          return;
        }
        next(null, body);
      },
    );

    scope.post<{ Body: Buffer }>(
      dependencies.config.path,
      { bodyLimit: dependencies.config.maxPayloadBytes },
      async (request, reply) => {
        const signatureValues = readHeaderValues(request, "x-hub-signature-256");
        const signature = signatureValues.length === 1 ? signatureValues[0] : undefined;
        if (
          !verifyGitHubWebhookSignature(request.body, signature, dependencies.config.webhookSecret)
        ) {
          return sendError(
            reply,
            401,
            "invalid_github_webhook_signature",
            "The GitHub webhook signature is missing or invalid.",
          );
        }

        let deliveryId: string;
        let eventName: string;
        try {
          deliveryId = readDeliveryId(request);
          eventName = readEventName(request);
        } catch (error) {
          if (error instanceof GitHubWebhookHeaderError) {
            return sendError(reply, 400, error.code, error.message);
          }
          throw error;
        }

        if (!supportedEventNames.has(eventName as GitHubWebhookEventName)) {
          return reply.code(202).send({
            status: "ignored",
            deliveryId,
            eventName,
          });
        }
        const supportedEventName = eventName as GitHubWebhookEventName;

        try {
          const receivedAt = now().toISOString();
          const payloadSha256 = createHash("sha256").update(request.body).digest("hex");
          const event = normalizeGitHubWebhookPayload({
            deliveryId,
            eventName: supportedEventName,
            receivedAt,
            payload: parseJson(request.body),
          });
          await dependencies.ingest(event, {
            deliveryId,
            eventName: supportedEventName,
            payloadSha256,
            receivedAt,
          });
          return reply.code(202).send({
            status: "accepted",
            deliveryId,
          });
        } catch (error) {
          if (error instanceof UnsupportedGitHubWebhookActionError) {
            return reply.code(202).send({
              status: "ignored",
              deliveryId,
              eventName,
              reason: "unsupported_action",
            });
          }
          if (error instanceof UnsupportedGitHubWebhookTargetError) {
            return reply.code(202).send({
              status: "ignored",
              deliveryId,
              eventName,
              reason: "unsupported_target",
            });
          }
          if (error instanceof InvalidGitHubWebhookPayloadError) {
            return sendError(reply, 400, "invalid_github_webhook_payload", error.message);
          }
          throw error;
        }
      },
    );
    done();
  });
};
