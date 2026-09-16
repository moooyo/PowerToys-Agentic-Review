import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyGitHubWebhookSignature } from "../github/webhook-signature.js";
import { InvestigationRequestError } from "./errors.js";

export interface InvestigationWebhookDeliveryInput {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadSha256: string;
  readonly receivedAt: string;
  readonly payload: unknown;
}

export interface InvestigationWebhookAcceptance {
  readonly status: "accepted" | "duplicate" | "ignored";
  readonly reason?: string;
  readonly taskId?: string;
}

export interface InvestigationWebhookRouteOptions {
  readonly secret: string;
  readonly maximumPayloadBytes: number;
  readonly accept: (input: InvestigationWebhookDeliveryInput) => InvestigationWebhookAcceptance;
  readonly now?: () => Date;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const deliveryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const eventNamePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const jsonContentTypePattern =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu;

function headerValues(request: FastifyRequest, name: string): string[] {
  const values: string[] = [];
  const headers = request.raw.rawHeaders;
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() === name) values.push(headers[index + 1] ?? "");
  }
  return values;
}

function singleHeader(request: FastifyRequest, name: string, pattern: RegExp): string {
  const values = headerValues(request, name);
  const value = values.length === 1 ? values[0] : undefined;
  if (value === undefined || !pattern.test(value)) {
    throw new InvestigationRequestError(
      400,
      `invalid_${name.replaceAll("-", "_")}`,
      `${name} must occur exactly once with a valid value.`,
    );
  }
  return value;
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ code, message, retryable: statusCode >= 500 });
}

export function registerInvestigationWebhookRoute(
  app: FastifyInstance,
  options: InvestigationWebhookRouteOptions,
): void {
  if (
    typeof options.secret !== "string" ||
    Buffer.byteLength(options.secret, "utf8") < 32 ||
    Buffer.byteLength(options.secret, "utf8") > 4_096 ||
    options.secret.trim() !== options.secret
  ) {
    throw new Error("GitHub webhook secret must contain 32 to 4096 exact UTF-8 bytes.");
  }
  if (
    !Number.isSafeInteger(options.maximumPayloadBytes) ||
    options.maximumPayloadBytes < 1 ||
    options.maximumPayloadBytes > 32 * 1_024 * 1_024
  ) {
    throw new Error("GitHub webhook payload limit must be an integer from 1 to 33554432 bytes.");
  }
  const now = options.now ?? (() => new Date());

  app.register((scope, _pluginOptions, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: options.maximumPayloadBytes },
      (_request, body, next) => {
        if (!Buffer.isBuffer(body)) {
          next(new TypeError("GitHub webhook parser requires raw bytes."));
          return;
        }
        next(null, body);
      },
    );
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof InvestigationRequestError) {
        return sendError(reply, error.statusCode, error.code, error.message);
      }
      const statusCode =
        error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
      if (statusCode === 413) {
        return sendError(
          reply,
          413,
          "request_too_large",
          "GitHub webhook payload exceeds its limit.",
        );
      }
      if (statusCode >= 400 && statusCode < 500) {
        return sendError(
          reply,
          statusCode,
          "invalid_request",
          "GitHub webhook request is invalid.",
        );
      }
      return sendError(
        reply,
        500,
        "webhook_acceptance_failed",
        "GitHub webhook delivery could not be accepted.",
      );
    });

    scope.post<{ Body: Buffer }>(
      "/api/github/webhook",
      {
        bodyLimit: options.maximumPayloadBytes,
        onRequest: async (request, reply) => {
          reply.header("cache-control", "no-store");
          const contentTypes = headerValues(request, "content-type");
          if (contentTypes.length !== 1 || !jsonContentTypePattern.test(contentTypes[0] ?? "")) {
            throw new InvestigationRequestError(
              415,
              "unsupported_webhook_content_type",
              "GitHub webhooks require one application/json content type with UTF-8 encoding.",
            );
          }
          const contentEncodings = headerValues(request, "content-encoding");
          if (
            contentEncodings.length > 1 ||
            (contentEncodings.length === 1 && contentEncodings[0]?.toLowerCase() !== "identity")
          ) {
            throw new InvestigationRequestError(
              415,
              "unsupported_webhook_content_encoding",
              "GitHub webhooks require an uncompressed request body.",
            );
          }
        },
      },
      (request, reply) => {
        const signatures = headerValues(request, "x-hub-signature-256");
        const signature = signatures.length === 1 ? signatures[0] : undefined;
        if (
          !Buffer.isBuffer(request.body) ||
          !verifyGitHubWebhookSignature(request.body, signature, options.secret)
        ) {
          return sendError(
            reply,
            401,
            "invalid_github_webhook_signature",
            "GitHub webhook signature is missing or invalid.",
          );
        }
        const deliveryId = singleHeader(request, "x-github-delivery", deliveryIdPattern);
        const eventName = singleHeader(request, "x-github-event", eventNamePattern);
        let payload: unknown;
        try {
          payload = JSON.parse(utf8Decoder.decode(request.body)) as unknown;
        } catch {
          return sendError(
            reply,
            400,
            "invalid_github_webhook_payload",
            "GitHub webhook body must contain valid UTF-8 JSON.",
          );
        }

        // Acceptance must commit the inbox record synchronously before acknowledging delivery.
        const result = options.accept({
          deliveryId,
          eventName,
          payloadSha256: createHash("sha256").update(request.body).digest("hex"),
          receivedAt: now().toISOString(),
          payload,
        });
        if (!["accepted", "duplicate", "ignored"].includes(result.status)) {
          throw new Error("GitHub webhook acceptance must return a synchronous receipt.");
        }
        return reply.code(202).send({
          status: result.status,
          deliveryId,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
        });
      },
    );
    done();
  });
}
