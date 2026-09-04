import type { FastifyInstance } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";

export interface ServerAdmissionProbe {
  read(): boolean;
}

export const registerHealthRoutes = (
  app: FastifyInstance,
  database: DatabaseClient,
  serverAdmission: ServerAdmissionProbe,
  recoveryMaintenance = false,
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
      try {
        return serverAdmission.read() === true;
      } catch {
        return false;
      }
    };

    if (recoveryMaintenance || !isReady()) {
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
