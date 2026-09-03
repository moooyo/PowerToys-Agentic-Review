import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../dist/database/database-client.js";
import {
  createWorkerAuthenticationHooks,
  getAuthenticatedWorkerIdentity,
  getAuthenticatedWorkerTokenSha256,
  type WorkerAuthenticationPolicy,
} from "../../dist/security/worker-identity.js";

const token = `arw1_${Buffer.alloc(32, 7).toString("base64url")}`;
const tokenSha256 = createHash("sha256").update(token, "ascii").digest("hex");

const createApp = (
  authenticate: ReturnType<typeof vi.fn>,
  policy: WorkerAuthenticationPolicy = "active",
): FastifyInstance => {
  const app = Fastify({ logger: false });
  const hooks = createWorkerAuthenticationHooks(
    { request: authenticate } as unknown as DatabaseClient,
    policy,
  );
  app.post(
    "/worker",
    { onRequest: hooks.onRequest, preValidation: hooks.preValidation },
    async (request) => ({
      ...getAuthenticatedWorkerIdentity(request),
      workerTokenSha256: getAuthenticatedWorkerTokenSha256(request),
    }),
  );
  return app;
};

describe("Worker bearer-token identity", () => {
  it("authenticates a canonical token through the database on every request", async () => {
    const authenticate = vi.fn(async () => ({
      outcome: "authenticated" as const,
      workerNodeId: "worker:node-1",
      authState: "active" as const,
    }));
    const app = createApp(authenticate);
    try {
      for (let index = 0; index < 2; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/worker",
          headers: { authorization: `Bearer ${token}` },
          payload: { workerNodeId: "worker:node-1" },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          workerNodeId: "worker:node-1",
          authState: "active",
          authenticationMethod: "bearer-token",
          workerTokenSha256: tokenSha256,
        });
      }
      expect(authenticate).toHaveBeenCalledTimes(2);
      expect(authenticate).toHaveBeenCalledWith("authenticateWorkerToken", {
        workerTokenSha256: tokenSha256,
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    undefined,
    token,
    `bearer ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token} `,
    `Bearer arw1_${"a".repeat(42)}`,
    `Bearer arw1_${"a".repeat(44)}`,
    `Bearer arw1_${"a".repeat(42)}+`,
    `Bearer arw1_${Buffer.alloc(32, 7).toString("base64url")}=`,
  ])("rejects a missing or non-canonical Authorization value indistinguishably", async (value) => {
    const authenticate = vi.fn();
    const app = createApp(authenticate);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/worker",
        headers: value === undefined ? {} : { authorization: value },
        payload: { workerNodeId: "worker:node-1" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json()).toEqual({
        code: "worker_authentication_failed",
        message: "Worker authentication failed.",
        retryable: false,
      });
      expect(authenticate).not.toHaveBeenCalled();
      expect(response.body).not.toContain(token);
    } finally {
      await app.close();
    }
  });

  it("makes unknown and revoked tokens indistinguishable from malformed tokens", async () => {
    const authenticate = vi.fn(async () => ({ outcome: "invalid" as const }));
    const app = createApp(authenticate);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/worker",
        headers: { authorization: `Bearer ${token}` },
        payload: { workerNodeId: "worker:node-1" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
      expect(response.json()).toMatchObject({ code: "worker_authentication_failed" });
      expect(response.body).not.toContain(token);
      expect(response.body).not.toContain(tokenSha256);
    } finally {
      await app.close();
    }
  });

  it("rejects duplicate Authorization fields", async () => {
    const authenticate = vi.fn();
    const app = createApp(authenticate);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/worker",
        headers: { authorization: [`Bearer ${token}`, `Bearer ${token}`] },
        payload: { workerNodeId: "worker:node-1" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "worker_authentication_failed" });
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("allows pending credentials only on the registration policy", async () => {
    const authenticate = vi.fn(async () => ({
      outcome: "authenticated" as const,
      workerNodeId: "worker:node-1",
      authState: "pending" as const,
    }));
    const activeApp = createApp(authenticate);
    const registrationApp = createApp(authenticate, "registration");
    const request = {
      method: "POST" as const,
      url: "/worker",
      headers: { authorization: `Bearer ${token}` },
      payload: { workerNodeId: "worker:node-1" },
    };
    try {
      const denied = await activeApp.inject(request);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "worker_registration_required" });

      const allowed = await registrationApp.inject(request);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ authState: "pending" });
    } finally {
      await Promise.all([activeApp.close(), registrationApp.close()]);
    }
  });

  it.each([
    { workerNodeId: "worker:other" },
    {
      workerNodeId: "worker:node-1",
      activeLeases: [{ workerNodeId: "worker:other" }],
    },
  ])("rejects every mismatched body identity", async (payload) => {
    const authenticate = vi.fn(async () => ({
      outcome: "authenticated" as const,
      workerNodeId: "worker:node-1",
      authState: "active" as const,
    }));
    const app = createApp(authenticate);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/worker",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "worker_identity_mismatch" });
    } finally {
      await app.close();
    }
  });

  it("fails closed without exposing a database error or credential", async () => {
    const authenticate = vi.fn(async () => {
      throw new Error(`lookup failed for ${token}`);
    });
    const app = createApp(authenticate);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/worker",
        headers: { authorization: `Bearer ${token}` },
        payload: { workerNodeId: "worker:node-1" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "worker_authentication_unavailable",
        message: "Worker authentication is temporarily unavailable.",
        retryable: true,
      });
      expect(response.body).not.toContain(token);
      expect(response.body).not.toContain("lookup failed");
    } finally {
      await app.close();
    }
  });
});
