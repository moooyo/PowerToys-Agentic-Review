import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../../dist/config.js";
import type { DatabaseClient } from "../../dist/database/database-client.js";
import { registerWorkerRoutes } from "../../dist/routes/workers.js";

const workerToken = `arw1_${Buffer.alloc(32, 9).toString("base64url")}`;
const claimBody = JSON.stringify({
  protocolVersion: "1.0",
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  availableSlots: 1,
  capabilitiesDigest: "a".repeat(64),
  waitSeconds: 5,
});

const createClaimServer = async (stopOnSecondClaim = false) => {
  const firstClaim = Promise.withResolvers<void>();
  const connectionClosed = Promise.withResolvers<void>();
  const shutdown = new AbortController();
  let claimCount = 0;
  const claim = vi.fn(async () => {
    claimCount += 1;
    firstClaim.resolve();
    return stopOnSecondClaim && claimCount >= 2
      ? { outcome: "worker_unavailable", reason: "draining" }
      : { outcome: "no_work", retryAfterMs: 1_000 };
  });
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (_request, reply) => {
    reply.raw.once("close", () => connectionClosed.resolve());
  });
  registerWorkerRoutes(app, {
    config: {
      protocolVersion: "1.0",
      maxLongPollSeconds: 30,
      leaseTtlSeconds: 120,
      allowInsecureHttp: true,
    } as ServerConfig,
    database: {
      request: async (operation: string) => {
        if (operation === "authenticateWorkerToken") {
          return { outcome: "authenticated", workerNodeId: "worker-node", authState: "active" };
        }
        if (operation === "claimLease") return claim();
        throw new Error(`Unexpected database operation: ${operation}`);
      },
    } as unknown as DatabaseClient,
    shutdownSignal: shutdown.signal,
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = Promise.withResolvers<string>();
  const client = httpRequest(
    `${origin}/api/v1/worker/leases/claim`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerToken}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(claimBody),
      },
    },
    (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.on("end", () => response.resolve(body));
      incoming.on("error", response.reject);
    },
  );
  client.on("error", response.reject);
  // Intentional socket destruction is asserted through the server's close event.
  void response.promise.catch(() => undefined);
  client.end(claimBody);
  return {
    claim,
    client,
    firstClaim: firstClaim.promise,
    connectionClosed: connectionClosed.promise,
    response: response.promise,
    close: async () => {
      shutdown.abort();
      client.destroy();
      await app.close();
    },
  };
};

describe("Worker claim connection lifetime", () => {
  it("stops claiming after the waiting Worker disconnects", async () => {
    const server = await createClaimServer();
    try {
      await server.firstClaim;
      server.client.destroy();
      await server.connectionClosed;
      await delay(1_100);
      expect(server.claim).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("keeps polling after the request body ends while the response connection remains open", async () => {
    const server = await createClaimServer(true);
    try {
      expect(JSON.parse(await server.response)).toMatchObject({
        outcome: "worker_unavailable",
        reason: "draining",
      });
      expect(server.claim).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });
});
