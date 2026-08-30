import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";

export const registerHealthRoutes = (app: FastifyInstance, database: DatabaseClient): void => {
  app.get("/health/live", async () => ({
    status: "ok",
    serverTime: new Date().toISOString(),
  }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      const health = await database.request("ping", {});
      return {
        status: "ready",
        serverTime: new Date().toISOString(),
        database: health,
      };
    } catch {
      return reply.code(503).send({
        status: "not_ready",
        serverTime: new Date().toISOString(),
      });
    }
  });
};
