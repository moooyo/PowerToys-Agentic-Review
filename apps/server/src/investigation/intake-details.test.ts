import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalInvestigationWebhookUrl,
  InvestigationIntakeDetailsService,
} from "../../dist/investigation/intake-details.js";
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
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const now = () => new Date("2026-10-01T10:00:00.000Z");

function harness(webhookPublicUrl?: string) {
  const store = new InvestigationStore();
  stores.push(store);
  store.insert("repositories", repository.id, repository);
  return {
    store,
    service: new InvestigationIntakeDetailsService({
      store,
      settings: new InvestigationWebhookSettings(store, [], true),
      publicOrigin: "https://console.example.test",
      ...(webhookPublicUrl === undefined ? {} : { webhookPublicUrl }),
      now,
    }),
  };
}

describe("intake configuration and receipt observations", () => {
  it("distinguishes explicit endpoint configuration from a public-origin candidate without manufacturing connectivity", () => {
    const candidate = harness().service.read(actor, repository.id);
    expect(candidate).toEqual({
      repositoryId: repository.id,
      canonicalWebhookUrl: "https://console.example.test/api/github/webhook",
      webhookUrlSource: "public_origin",
      receiverConfigured: true,
      lastDelivery: null,
      observedAt: now().toISOString(),
    });
    const configured = harness("https://gateway.example.test/receive").service.read(
      actor,
      repository.id,
    );
    expect(configured.canonicalWebhookUrl).toBe("https://gateway.example.test/receive");
    expect(configured.webhookUrlSource).toBe("explicit");
    expect(configured).not.toHaveProperty("healthy");
    expect(configured).not.toHaveProperty("verified");
  });

  it("reports the latest retained repository receipt across static and E2E intake only", () => {
    const { store, service } = harness();
    store.insert("idempotency", "webhook:delivery:first", {
      id: "webhook:delivery:first",
      deliveryId: "first",
      assignment: { repository },
      receivedAt: "2026-10-01T08:00:00.000Z",
      eventName: "pull_request",
    });
    store.insert("idempotency", "e2e:webhook:second", {
      id: "e2e:webhook:second",
      deliveryId: "second",
      repository,
      receivedAt: "2026-10-01T09:00:00.000Z",
      eventName: "issue_comment",
    });
    store.insert("idempotency", "webhook:delivery:hidden", {
      id: "webhook:delivery:hidden",
      deliveryId: "hidden",
      assignment: { repository: { ...repository, id: "other-repo" } },
      receivedAt: "2026-10-01T09:30:00.000Z",
      eventName: "issues",
    });
    expect(service.read(actor, repository.id).lastDelivery).toEqual({
      deliveryId: "second",
      receivedAt: "2026-10-01T09:00:00.000Z",
      eventName: "issue_comment",
    });
    expect(() => service.read({ ...actor, repositoryIds: [] }, repository.id)).toThrow(
      "This identity has no access",
    );
  });

  it("rejects endpoint URLs that would expose credentials or fail to identify a clean receiver endpoint", () => {
    for (const value of [
      "/webhook",
      "ftp://example.test/webhook",
      "https://user:secret@example.test/webhook",
      "https://example.test/webhook?secret=x",
      "https://example.test/webhook#fragment",
      " https://example.test/webhook",
    ])
      expect(() => canonicalInvestigationWebhookUrl(value)).toThrow("public webhook URL");
  });
});
