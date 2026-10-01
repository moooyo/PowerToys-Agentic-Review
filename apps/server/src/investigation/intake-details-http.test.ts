import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationRequestError } from "../../dist/investigation/errors.js";
import { InvestigationIntakeDetailsService } from "../../dist/investigation/intake-details.js";
import { registerInvestigationIntakeDetailsRoutes } from "../../dist/investigation/intake-details-http.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type { InvestigationOperatorPrincipal } from "../../dist/investigation/types.js";
import { InvestigationWebhookSettings } from "../../dist/investigation/webhook-settings.js";

const repository = { id: "repo-1", fullName: "fixture/project", githubRepositoryId: 1 };
const actor: InvestigationOperatorPrincipal = {
  id: "operator-1",
  displayName: "Operator",
  repositoryIds: [repository.id],
  permissions: [],
  actionCapabilities: [],
  allowRepositoryExecution: false,
};
const stores: InvestigationStore[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});

function harness(principal: InvestigationOperatorPrincipal | null) {
  const store = new InvestigationStore();
  stores.push(store);
  store.insert("repositories", repository.id, repository);
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof InvestigationRequestError)
      return reply.code(error.statusCode).send({ code: error.code });
    return reply.code(500).send({ code: "unexpected_error" });
  });
  const identities = {
    resolve: vi.fn().mockResolvedValue({
      githubUserId: 42,
      login: "fixture-user",
      avatarUrl: null,
      htmlUrl: null,
    }),
  };
  const authors = {
    read: vi.fn().mockResolvedValue({
      workItemId: "item-1",
      repositoryId: repository.id,
      author: null,
      source: "unavailable",
      reason: "github_author_unavailable",
    }),
  };
  registerInvestigationIntakeDetailsRoutes(app, {
    details: new InvestigationIntakeDetailsService({
      store,
      settings: new InvestigationWebhookSettings(store),
      publicOrigin: "https://console.example.test",
    }),
    identities,
    authors,
    authenticateOperator: () => principal,
  });
  return { app, identities, authors };
}

describe("scoped native intake detail routes", () => {
  it("projects author metadata through GET with the authenticated actor and exact work item ID", async () => {
    const { app, authors } = harness(actor);
    const response = await app.inject({ method: "GET", url: "/api/work-items/item-1/author" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      workItemId: "item-1",
      author: null,
      source: "unavailable",
    });
    expect(authors.read).toHaveBeenCalledWith(actor, "item-1");
    expect(
      (await app.inject({ method: "POST", url: "/api/work-items/item-1/author" })).statusCode,
    ).toBe(404);
  });

  it("requires authentication before invoking the author reader", async () => {
    const { app, authors } = harness(null);
    expect(
      (await app.inject({ method: "GET", url: "/api/work-items/item-1/author" })).statusCode,
    ).toBe(401);
    expect(authors.read).not.toHaveBeenCalled();
  });

  it("reads configuration and resolves profiles through GET without a write endpoint", async () => {
    const { app, identities } = harness(actor);
    const details = await app.inject({
      method: "GET",
      url: "/api/repositories/repo-1/intake-details",
    });
    expect(details.statusCode).toBe(200);
    expect(details.headers["cache-control"]).toBe("no-store");
    expect(details.json()).toMatchObject({
      repositoryId: "repo-1",
      webhookUrlSource: "public_origin",
      receiverConfigured: false,
      lastDelivery: null,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/repositories/repo-1/github-users/fixture-user",
    });
    expect(response.statusCode).toBe(200);
    expect(identities.resolve).toHaveBeenCalledWith("fixture-user");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/repositories/repo-1/github-users/fixture-user",
        })
      ).statusCode,
    ).toBe(404);
  });

  it.each([null, { ...actor, repositoryIds: [] }])(
    "rejects identity reads before contacting GitHub when access is unavailable",
    async (principal) => {
      const { app, identities } = harness(principal);
      const response = await app.inject({
        method: "GET",
        url: "/api/repositories/repo-1/github-users/fixture-user",
      });
      expect(response.statusCode).toBe(principal === null ? 401 : 403);
      expect(identities.resolve).not.toHaveBeenCalled();
    },
  );
});
