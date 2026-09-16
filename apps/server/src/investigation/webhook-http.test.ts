import { createHash, createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationRequestError } from "../../dist/investigation/errors.js";
import {
  type InvestigationWebhookAcceptance,
  type InvestigationWebhookDeliveryInput,
  registerInvestigationWebhookRoute,
} from "../../dist/investigation/webhook-http.js";

const secret = "Synthetic webhook secret with 32 bytes";
const url = "/api/github/webhook";
const deliveryId = "11111111-2222-3333-4444-555555555555";
const receivedAt = "2026-09-16T08:00:00.000Z";
const payload = { action: "assigned", sender: { id: 100, type: "User" }, assignee: { id: 200 } };
const body = JSON.stringify(payload);
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function headersFor(
  rawBody: string | Buffer,
  eventName = "issues",
): Record<string, string | string[]> {
  return {
    "content-type": "application/json",
    "x-github-delivery": deliveryId,
    "x-github-event": eventName,
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  };
}

function createApp(
  accept: (input: InvestigationWebhookDeliveryInput) => InvestigationWebhookAcceptance,
  maximumPayloadBytes = 64 * 1_024,
): FastifyInstance {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerInvestigationWebhookRoute(app, {
    secret,
    maximumPayloadBytes,
    accept,
    now: () => new Date(receivedAt),
  });
  return app;
}

describe("investigation webhook HTTP boundary", () => {
  it("verifies the exact bytes and synchronously accepts a delivery before acknowledging it", async () => {
    const rawBody = '{\r\n  "action": "assigned", "title": "Résumé"\r\n}';
    let persisted = false;
    const accept = vi.fn(
      (_input: InvestigationWebhookDeliveryInput): InvestigationWebhookAcceptance => {
        persisted = true;
        return { status: "accepted", taskId: "task-1" };
      },
    );
    const app = createApp(accept);
    const response = await app.inject({
      method: "POST",
      url,
      headers: headersFor(rawBody),
      payload: rawBody,
    });
    expect(response.statusCode).toBe(202);
    expect(persisted).toBe(true);
    expect(response.json()).toEqual({ status: "accepted", deliveryId, taskId: "task-1" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(accept).toHaveBeenCalledExactlyOnceWith({
      deliveryId,
      eventName: "issues",
      payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
      receivedAt,
      payload: { action: "assigned", title: "Résumé" },
    });
  });

  it.each(["accepted", "duplicate", "ignored"] as const)(
    "returns the durable %s receipt without changing its meaning",
    async (status) => {
      const accept = vi.fn(() => ({ status, reason: "fixture_reason" }));
      const app = createApp(accept);
      const response = await app.inject({
        method: "POST",
        url,
        headers: headersFor(body),
        payload: body,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status, deliveryId, reason: "fixture_reason" });
      expect(accept).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "", `sha256=${"0".repeat(64)}`, "sha1=invalid", "sha256=not-a-digest"])(
    "rejects absent or invalid signatures before parsing JSON",
    async (signature) => {
      const accept = vi.fn(() => ({ status: "accepted" as const }));
      const app = createApp(accept);
      const rawBody = "{ invalid JSON";
      const headers = headersFor(rawBody);
      if (signature === undefined) delete headers["x-hub-signature-256"];
      else headers["x-hub-signature-256"] = signature;
      const response = await app.inject({ method: "POST", url, headers, payload: rawBody });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "invalid_github_webhook_signature",
        retryable: false,
      });
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it("does not authenticate a reserialized or altered payload with the original signature", async () => {
    const accept = vi.fn(() => ({ status: "accepted" as const }));
    const app = createApp(accept);
    const response = await app.inject({
      method: "POST",
      url,
      headers: headersFor(body),
      payload: JSON.stringify(payload, null, 2),
    });
    expect(response.statusCode).toBe(401);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    ["x-hub-signature-256", 401],
    ["x-github-delivery", 400],
    ["x-github-event", 400],
    ["content-type", 415],
  ] as const)("rejects duplicate %s headers", async (name, expectedStatus) => {
    const accept = vi.fn(() => ({ status: "accepted" as const }));
    const app = createApp(accept);
    const headers = headersFor(body);
    headers[name] = [headers[name] as string, headers[name] as string];
    const response = await app.inject({ method: "POST", url, headers, payload: body });
    expect(response.statusCode).toBe(expectedStatus);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    ["x-github-delivery", undefined],
    ["x-github-delivery", ""],
    ["x-github-delivery", "delivery,forged"],
    ["x-github-delivery", "x".repeat(129)],
    ["x-github-event", undefined],
    ["x-github-event", "issues,pull_request"],
    ["x-github-event", "Issues"],
    ["x-github-event", "issues "],
    ["x-github-event", "x".repeat(65)],
  ] as const)("rejects malformed %s metadata %s", async (name, value) => {
    const accept = vi.fn(() => ({ status: "accepted" as const }));
    const app = createApp(accept);
    const headers = headersFor(body);
    if (value === undefined) delete headers[name];
    else headers[name] = value;
    const response = await app.inject({ method: "POST", url, headers, payload: body });
    expect(response.statusCode).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    "{ invalid JSON",
    "",
    Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
  ])("rejects signed malformed JSON or invalid UTF-8 bytes", async (rawBody) => {
    const accept = vi.fn(() => ({ status: "accepted" as const }));
    const app = createApp(accept);
    const response = await app.inject({
      method: "POST",
      url,
      headers: headersFor(rawBody),
      payload: rawBody,
    });
    expect(response.statusCode).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/json; charset=latin1",
    "application/json; charset=utf-8; charset=latin1",
  ])("rejects missing, unsupported, or ambiguous content types", async (contentType) => {
    const accept = vi.fn(() => ({ status: "accepted" as const }));
    const app = createApp(accept);
    const headers = headersFor(body);
    if (contentType === undefined) delete headers["content-type"];
    else headers["content-type"] = contentType;
    const response = await app.inject({ method: "POST", url, headers, payload: body });
    expect(response.statusCode).toBe(415);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each(["gzip", "br", "identity,gzip", ["identity", "identity"]])(
    "rejects compressed or ambiguous content encoding",
    async (contentEncoding) => {
      const accept = vi.fn(() => ({ status: "accepted" as const }));
      const app = createApp(accept);
      const response = await app.inject({
        method: "POST",
        url,
        headers: { ...headersFor(body), "content-encoding": contentEncoding },
        payload: body,
      });
      expect(response.statusCode).toBe(415);
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it("accepts explicit UTF-8 identity encoding without using cookies or Origin as identity", async () => {
    const accept = vi.fn(() => ({ status: "accepted" as const }));
    const app = createApp(accept);
    const response = await app.inject({
      method: "POST",
      url,
      headers: {
        ...headersFor(body),
        "content-type": 'application/json; charset="UTF-8"',
        "content-encoding": "identity",
        cookie: "admin=forged",
        origin: "https://untrusted.example",
      },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(accept).toHaveBeenCalledOnce();
    expect(accept.mock.calls[0]?.[0]).not.toHaveProperty("cookie");
    expect(accept.mock.calls[0]?.[0]).not.toHaveProperty("origin");
  });

  it("rejects an unsigned request even when it carries forged operator credentials", async () => {
    const accept = vi.fn(() => ({ status: "accepted" as const }));
    const app = createApp(accept);
    const headers = { ...headersFor(body), cookie: "admin=forged", authorization: "Bearer forged" };
    delete headers["x-hub-signature-256"];
    const response = await app.inject({ method: "POST", url, headers, payload: body });
    expect(response.statusCode).toBe(401);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each(["push", "pull_request_review", "ping"])(
    "lets the durable inbox classify the validated %s event",
    async (eventName) => {
      const accept = vi.fn((_input: InvestigationWebhookDeliveryInput) => ({
        status: "ignored" as const,
        reason: "unsupported_event",
      }));
      const app = createApp(accept);
      const response = await app.inject({
        method: "POST",
        url,
        headers: headersFor(body, eventName),
        payload: body,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ status: "ignored", reason: "unsupported_event" });
      expect(accept).toHaveBeenCalledWith(expect.objectContaining({ eventName }));
    },
  );

  it("enforces the route body limit while leaving ordinary JSON routes intact", async () => {
    const accept = vi.fn(() => ({ status: "accepted" as const }));
    const app = createApp(accept, 64);
    app.post<{ Body: typeof payload }>("/ordinary-json", async (request) => ({
      parsedAsObject: !Buffer.isBuffer(request.body),
      action: request.body.action,
    }));
    const response = await app.inject({
      method: "POST",
      url,
      headers: headersFor(body),
      payload: body,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "request_too_large", retryable: false });
    expect(accept).not.toHaveBeenCalled();
    const ordinaryResponse = await app.inject({
      method: "POST",
      url: "/ordinary-json",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(ordinaryResponse.statusCode).toBe(200);
    expect(ordinaryResponse.json()).toEqual({ parsedAsObject: true, action: "assigned" });
  });

  it("does not acknowledge failed durable acceptance or expose its error details", async () => {
    const accept = vi.fn((): InvestigationWebhookAcceptance => {
      throw new Error(`Persistence failed: ${secret}; ${body}`);
    });
    const app = createApp(accept);
    const response = await app.inject({
      method: "POST",
      url,
      headers: headersFor(body),
      payload: body,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: "webhook_acceptance_failed",
      message: "GitHub webhook delivery could not be accepted.",
      retryable: true,
    });
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain(body);
    expect(accept).toHaveBeenCalledOnce();
  });

  it("preserves safe business rejections such as a reused delivery ID with different bytes", async () => {
    const app = createApp(() => {
      throw new InvestigationRequestError(
        409,
        "webhook_delivery_conflict",
        "Delivery ID was already used with a different payload.",
      );
    });
    const response = await app.inject({
      method: "POST",
      url,
      headers: headersFor(body),
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "webhook_delivery_conflict", retryable: false });
  });

  it("does not acknowledge an accidentally asynchronous acceptance callback", async () => {
    const app = createApp(
      () => Promise.resolve({ status: "accepted" }) as unknown as InvestigationWebhookAcceptance,
    );
    const response = await app.inject({
      method: "POST",
      url,
      headers: headersFor(body),
      payload: body,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "webhook_acceptance_failed" });
  });
});
