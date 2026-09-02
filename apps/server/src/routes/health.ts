import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";

export interface ArtifactReadinessProbe {
  read(): Readonly<{ readonly ready: boolean }>;
}

export const registerHealthRoutes = (
  app: FastifyInstance,
  database: DatabaseClient,
  artifactReadiness: ArtifactReadinessProbe,
  shutdownSignal: AbortSignal,
): void => {
  app.get("/health/live", async () => ({
    status: "ok",
    serverTime: new Date().toISOString(),
  }));

  app.get("/health/ready", async (_request, reply) => {
    const sendNotReady = () =>
      reply.code(503).send({
        status: "not_ready",
        serverTime: new Date().toISOString(),
      });
    const isReady = (): boolean => {
      if (shutdownSignal.aborted) {
        return false;
      }
      try {
        return artifactReadiness.read().ready === true;
      } catch {
        return false;
      }
    };

    if (!isReady()) {
      return sendNotReady();
    }
    try {
      await database.request("ping", {});
      if (!isReady()) {
        return sendNotReady();
      }
      return {
        status: "ready",
        serverTime: new Date().toISOString(),
      };
    } catch {
      return sendNotReady();
    }
  });
};
