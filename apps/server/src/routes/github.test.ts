import { createHash, createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GITHUB_WEBHOOK_PATH,
  registerGitHubWebhookRoutes,
} from "../../dist/routes/github.js";

const secret = "test-webhook-secret";
const deliveryId = "11111111-2222-3333-4444-555555555555";

const identity = (id: number, login: string) => ({
  id,
  node_id: `U_${id}`,
  login,
  type: "User",
});

const validPayload = {
  action: "assigned",
  issue: {
    id: 20,
    node_id: "I_20",
    number: 123,
    title: "Issue title",
    body: "Issue body",
    state: "open",
    html_url: "https://github.com/microsoft/PowerToys/issues/123",
    created_at: "2026-08-29T01:02:03Z",
    updated_at: "2026-08-30T01:02:03Z",
    closed_at: null,
    user: identity(101, "author"),
    assignee: identity(404, "decoy"),
    assignees: [identity(404, "decoy")],
  },
  assignee: identity(303, "target"),
  sender: identity(202, "scheduler"),
  repository: {
    id: 10,
    node_id: "R_10",
    name: "PowerToys",
    full_name: "microsoft/PowerToys",
    html_url: "https://github.com/microsoft/PowerToys",
    default_branch: "main",
    private: false,
    owner: identity(1, "microsoft"),
  },
};

const signatureFor = (body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const signedHeaders = (body: string, eventName = "issues") => ({
  "content-type": "application/json",
  "x-github-delivery": deliveryId,
  "x-github-event": eventName,
  "x-hub-signature-256": signatureFor(body),
});

const createApp = (
  ingest: (event: unknown, delivery: unknown) => Promise<void>,
  maxPayloadBytes = 64 * 1_024,
): FastifyInstance => {
  const app = Fastify({ logger: false });
  registerGitHubWebhookRoutes(app, {
    config: {
      path: DEFAULT_GITHUB_WEBHOOK_PATH,
      webhookSecret: secret,
      maxPayloadBytes,
    },
    ingest,
    now: () => new Date("2026-08-30T03:04:05.000Z"),
  });
  return app;
};

describe("GitHub webhook route", () => {
  it("verifies, normalizes, and ingests a supported delivery before acknowledging it", async () => {
    const ingest = vi.fn(async (_event: unknown, _delivery: unknown) => undefined);
    const app = createApp(ingest);
    const body = JSON.stringify(validPayload);

    try {
      const response = await app.inject({
        method: "POST",
        url: DEFAULT_GITHUB_WEBHOOK_PATH,
        headers: signedHeaders(body),
        payload: body,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: "accepted", deliveryId });
      expect(ingest).toHaveBeenCalledOnce();
      expect(ingest.mock.calls[0]?.[0]).toMatchObject({
        contractVersion: 1,
        source: "webhook",
        sourceEventId: deliveryId,
        action: "request_opened",
        requestKind: "assignment",
        observedAt: "2026-08-30T03:04:05.000Z",
        author: { githubUserId: 101 },
        actor: { githubUserId: 202 },
        target: { githubUserId: 303 },
      });
      expect(ingest.mock.calls[0]?.[1]).toEqual({
        deliveryId,
        eventName: "issues",
        payloadSha256: createHash("sha256").update(body).digest("hex"),
        receivedAt: "2026-08-30T03:04:05.000Z",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a bad signature before attempting to parse JSON", async () => {
    const ingest = vi.fn(async (_event: unknown) => undefined);
    const app = createApp(ingest);
    const malformedJson = "{ definitely-not-json";

    try {
      const response = await app.inject({
        method: "POST",
        url: DEFAULT_GITHUB_WEBHOOK_PATH,
        headers: {
          ...signedHeaders(malformedJson),
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        },
        payload: malformedJson,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "invalid_github_webhook_signature" });
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects malformed JSON after a valid signature", async () => {
    const ingest = vi.fn(async (_event: unknown) => undefined);
    const app = createApp(ingest);
    const malformedJson = "{ definitely-not-json";

    try {
      const response = await app.inject({
        method: "POST",
        url: DEFAULT_GITHUB_WEBHOOK_PATH,
        headers: signedHeaders(malformedJson),
        payload: malformedJson,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_github_webhook_payload" });
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires a single delivery identifier and event name", async () => {
    const ingest = vi.fn(async (_event: unknown) => undefined);
    const app = createApp(ingest);
    const body = JSON.stringify(validPayload);
    const headers = signedHeaders(body);
    const { "x-github-delivery": _delivery, ...headersWithoutDelivery } = headers;

    try {
      const response = await app.inject({
        method: "POST",
        url: DEFAULT_GITHUB_WEBHOOK_PATH,
        headers: headersWithoutDelivery,
        payload: body,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_x_github_delivery" });
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects unsupported event names and actions", async () => {
    const ingest = vi.fn(async (_event: unknown) => undefined);
    const app = createApp(ingest);
    const validBody = JSON.stringify(validPayload);
    const unsupportedActionBody = JSON.stringify({ ...validPayload, action: "labeled" });

    try {
      const unsupportedEventResponse = await app.inject({
        method: "POST",
        url: DEFAULT_GITHUB_WEBHOOK_PATH,
        headers: signedHeaders(validBody, "push"),
        payload: validBody,
      });
      const unsupportedActionResponse = await app.inject({
        method: "POST",
        url: DEFAULT_GITHUB_WEBHOOK_PATH,
        headers: signedHeaders(unsupportedActionBody),
        payload: unsupportedActionBody,
      });

      expect(unsupportedEventResponse.statusCode).toBe(202);
      expect(unsupportedEventResponse.json()).toMatchObject({
        status: "ignored",
      });
      expect(unsupportedActionResponse.statusCode).toBe(202);
      expect(unsupportedActionResponse.json()).toMatchObject({
        status: "ignored",
        reason: "unsupported_action",
      });
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("enforces the route-local payload limit", async () => {
    const ingest = vi.fn(async (_event: unknown) => undefined);
    const app = createApp(ingest, 64);
    const body = JSON.stringify(validPayload);

    try {
      const response = await app.inject({
        method: "POST",
        url: DEFAULT_GITHUB_WEBHOOK_PATH,
        headers: signedHeaders(body),
        payload: body,
      });

      expect(response.statusCode).toBe(413);
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not acknowledge a delivery when durable ingestion fails", async () => {
    const ingest = vi.fn(async (_event: unknown): Promise<void> => {
      throw new Error("persistence unavailable");
    });
    const app = createApp(ingest);
    const body = JSON.stringify(validPayload);

    try {
      const response = await app.inject({
        method: "POST",
        url: DEFAULT_GITHUB_WEBHOOK_PATH,
        headers: signedHeaders(body),
        payload: body,
      });

      expect(response.statusCode).toBe(500);
      expect(ingest).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("does not replace the JSON parser for routes outside the webhook scope", async () => {
    const ingest = vi.fn(async (_event: unknown) => undefined);
    const app = createApp(ingest);
    app.post<{ Body: { value: string } }>("/ordinary-json", async (request) => ({
      parsedAsObject: !Buffer.isBuffer(request.body),
      value: request.body.value,
    }));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/ordinary-json",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ value: "kept" }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ parsedAsObject: true, value: "kept" });
    } finally {
      await app.close();
    }
  });
});
