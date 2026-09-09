import { DashboardHealthComponentSchema } from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import type { GitHubIntegrationConfig, ServerConfig } from "../config.js";
import { createGitHubIngestionHealthTracker } from "./ingestion-health.js";

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value)),
);

const firstRepository = { githubRepositoryId: 1, fullName: "owner/first" };
const secondRepository = { githubRepositoryId: 2, fullName: "owner/second" };
const thirdRepository = { githubRepositoryId: 3, fullName: "owner/third" };
const initialTime = Date.parse("2026-09-06T01:00:00.000Z");
const pollingTarget = (repository = firstRepository, githubUserId = 3) => ({
  repository,
  reviewer: { githubUserId },
});

const githubConfig = (intervalSeconds = 60): GitHubIntegrationConfig => ({
  legacyBootstrap: {
    repositories: [firstRepository, secondRepository],
    reviewer: { githubUserId: 3, login: "reviewer" },
    authorizationPolicy: {
      kind: "self_or_allowlist",
      policyVersion: 1,
      schedulingTargetGithubUserId: 3,
      allowlistedActorGithubUserIds: [],
      unknownActorPolicy: "deny",
      newRevisionPolicy: "inherit_authorized_epoch",
    },
  },
  promptDirectory: "/prompts",
  webhook: undefined,
  polling: { token: "polling-secret", intervalSeconds },
});

const createTracker = (
  config: Pick<ServerConfig, "github" | "recoveryMaintenance"> = {
    github: githubConfig(),
    recoveryMaintenance: false,
  },
) => {
  let currentTime = initialTime;
  return {
    tracker: createGitHubIngestionHealthTracker(config, () => new Date(currentTime)),
    setTime: (milliseconds: number) => {
      currentTime = initialTime + milliseconds;
    },
  };
};

describe("GitHub ingestion runtime health", () => {
  it("treats disabled ingestion as healthy without event history", () => {
    const { tracker, setTime } = createTracker({
      github: undefined,
      recoveryMaintenance: false,
    });
    setTime(24 * 60 * 60 * 1_000);

    expect(tracker.getHealth()).toEqual({
      id: "github",
      name: "GitHub ingestion",
      status: "healthy",
      summary: "GitHub ingestion is disabled by configuration.",
      checkedAt: "2026-09-07T01:00:00.000Z",
    });
  });

  it("keeps recovery maintenance healthy even with configured polling failures", () => {
    const { tracker, setTime } = createTracker({
      github: githubConfig(),
      recoveryMaintenance: true,
    });
    tracker.recordReconciliationFailure(firstRepository);
    setTime(24 * 60 * 60 * 1_000);

    expect(tracker.getHealth()).toMatchObject({
      status: "healthy",
      summary: "GitHub ingestion is paused during recovery maintenance.",
    });
  });

  it("does not infer a webhook delivery failure from an idle repository", () => {
    const { tracker, setTime } = createTracker({
      github: {
        ...githubConfig(),
        polling: undefined,
        webhook: {
          path: "/api/v1/github/webhook",
          secret: Buffer.from("webhook-secret"),
          maxPayloadBytes: 1_024,
        },
      },
      recoveryMaintenance: false,
    });
    tracker.recordReconciliationFailure(firstRepository);
    setTime(24 * 60 * 60 * 1_000);

    const health = tracker.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.summary).toContain("Idle delivery periods are expected");
    expect(health.summary).toContain("remote webhook delivery is not verified");
  });

  it("expires first-reconciliation grace after three configured polling intervals", () => {
    const { tracker, setTime } = createTracker();

    expect(tracker.getHealth()).toMatchObject({ status: "healthy" });
    expect(tracker.getHealth().summary).toContain("2 await their first reconciliation");
    setTime(179_999);
    expect(tracker.getHealth().status).toBe("healthy");
    setTime(180_000);
    expect(tracker.getHealth().status).toBe("healthy");
    setTime(180_001);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("2 initial reconciliations are overdue");

    tracker.recordReconciliationSuccess(firstRepository);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("1 initial reconciliations are overdue");
    tracker.recordReconciliationSuccess(secondRepository);
    expect(tracker.getHealth().status).toBe("healthy");
  });

  it("uses a long polling interval for both startup grace and successful reconciliation freshness", () => {
    const { tracker, setTime } = createTracker({
      github: githubConfig(3_600),
      recoveryMaintenance: false,
    });
    setTime(30 * 60 * 1_000);
    expect(tracker.getHealth().status).toBe("healthy");
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordReconciliationSuccess(secondRepository);

    setTime((30 * 60 + 3 * 3_600) * 1_000);
    expect(tracker.getHealth().status).toBe("healthy");
    setTime((30 * 60 + 3 * 3_600) * 1_000 + 1);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("2 successful reconciliations are overdue");
  });

  it("keeps a failed repository degraded until that same repository succeeds", () => {
    const { tracker, setTime } = createTracker();
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordReconciliationSuccess(secondRepository);
    setTime(1_000);
    tracker.recordReconciliationFailure(secondRepository);

    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("1 latest reconciliations failed");
    expect(tracker.getHealth().summary).toContain("Latest failure: 2026-09-06T01:00:01.000Z");
    setTime(2_000);
    tracker.recordReconciliationSuccess(firstRepository);
    expect(tracker.getHealth().status).toBe("degraded");
    tracker.recordReconciliationSuccess(secondRepository);
    expect(tracker.getHealth().status).toBe("healthy");
  });

  it("does not let another repository's activity hide a stale reconciliation", () => {
    const { tracker, setTime } = createTracker();
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordReconciliationSuccess(secondRepository);
    setTime(180_001);
    tracker.recordReconciliationSuccess(firstRepository);

    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("1 of 2 configured repositories");
    expect(tracker.getHealth().summary).toContain("1 successful reconciliations are overdue");
  });

  it("ignores unconfigured repository IDs and renamed identities", () => {
    const { tracker, setTime } = createTracker();
    tracker.recordReconciliationSuccess({ githubRepositoryId: 100, fullName: "owner/first" });
    tracker.recordReconciliationSuccess({ githubRepositoryId: 1, fullName: "owner/historical" });
    setTime(180_001);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("2 initial reconciliations are overdue");

    tracker.recordReconciliationSuccess({ githubRepositoryId: 1, fullName: "OWNER/FIRST" });
    tracker.recordReconciliationSuccess(secondRepository);
    tracker.recordReconciliationFailure({ githubRepositoryId: 100, fullName: "owner/first" });
    tracker.recordReconciliationFailure({ githubRepositoryId: 1, fullName: "owner/historical" });
    expect(tracker.getHealth().status).toBe("healthy");
  });

  it("uses callback order when success and failure share a timestamp", () => {
    const { tracker } = createTracker();
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordReconciliationSuccess(secondRepository);
    tracker.recordReconciliationFailure(firstRepository);
    expect(tracker.getHealth().status).toBe("degraded");
    tracker.recordReconciliationSuccess(firstRepository);
    expect(tracker.getHealth().status).toBe("healthy");
  });

  it("reports polling failure when webhook ingestion is also configured", () => {
    const { tracker } = createTracker({
      github: {
        ...githubConfig(),
        webhook: {
          path: "/api/v1/github/webhook",
          secret: Buffer.from("webhook-secret"),
          maxPayloadBytes: 1_024,
        },
      },
      recoveryMaintenance: false,
    });
    tracker.recordReconciliationFailure(firstRepository);

    expect(tracker.getHealth().status).toBe("degraded");
  });

  it("returns contract-valid fresh snapshots without exposing credentials", () => {
    const { tracker, setTime } = createTracker();
    const firstSnapshot = tracker.getHealth();
    firstSnapshot.summary = "Modified by the caller.";
    setTime(1_000);
    tracker.recordReconciliationFailure(firstRepository);
    const nextSnapshot = tracker.getHealth();

    expect(Value.Check(DashboardHealthComponentSchema, nextSnapshot)).toBe(true);
    expect(nextSnapshot.checkedAt).toBe("2026-09-06T01:00:01.000Z");
    expect(nextSnapshot.summary).not.toContain("Modified by the caller");
    expect(JSON.stringify(nextSnapshot)).not.toContain("polling-secret");
  });

  it("gives newly managed targets their own initial grace period without resetting existing history", () => {
    const { tracker, setTime } = createTracker();
    setTime(600_000);
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordReconciliationSuccess(secondRepository);
    tracker.updatePollingTargets([
      pollingTarget(firstRepository),
      pollingTarget(secondRepository),
      pollingTarget(thirdRepository),
    ]);

    expect(tracker.getHealth().status).toBe("healthy");
    expect(tracker.getHealth().summary).toContain(
      "3 repositories; 1 await their first reconciliation",
    );
    setTime(780_000);
    expect(tracker.getHealth().status).toBe("healthy");
    setTime(780_001);
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordReconciliationSuccess(secondRepository);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("1 initial reconciliations are overdue");

    tracker.recordReconciliationSuccess(thirdRepository);
    expect(tracker.getHealth().status).toBe("healthy");
    expect(tracker.getHealth().summary).toContain("all 3 configured repositories");
  });

  it("does not restart initial grace when the same authoritative target set is refreshed", () => {
    const { tracker, setTime } = createTracker();
    setTime(180_001);
    tracker.updatePollingTargets([pollingTarget(firstRepository), pollingTarget(secondRepository)]);

    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("2 initial reconciliations are overdue");
    tracker.recordReconciliationFailure(firstRepository);
    tracker.updatePollingTargets([pollingTarget(firstRepository), pollingTarget(secondRepository)]);
    expect(tracker.getHealth().summary).toContain("1 latest reconciliations failed");
  });

  it("retires polling obligations while preserving their failure history for reactivation", () => {
    const { tracker } = createTracker();
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordReconciliationFailure(secondRepository);
    tracker.updatePollingTargets([pollingTarget(firstRepository)]);

    expect(tracker.getHealth().status).toBe("healthy");
    expect(tracker.getHealth().summary).toContain("all 1 configured repositories");
    tracker.updatePollingTargets([pollingTarget(firstRepository), pollingTarget(secondRepository)]);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("1 latest reconciliations failed");
    tracker.recordReconciliationSuccess(secondRepository);
    expect(tracker.getHealth().status).toBe("healthy");
  });

  it("keeps an in-flight result for a retired target without reactivating it", () => {
    const { tracker } = createTracker();
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.updatePollingTargets([pollingTarget(firstRepository)]);
    tracker.recordReconciliationFailure(secondRepository);

    expect(tracker.getHealth().status).toBe("healthy");
    tracker.updatePollingTargets([pollingTarget(firstRepository), pollingTarget(secondRepository)]);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("1 latest reconciliations failed");
  });

  it("accepts an empty authoritative set and replaces environment-only targets", () => {
    const { tracker } = createTracker();
    tracker.recordReconciliationFailure(firstRepository);
    tracker.updatePollingTargets([]);
    expect(tracker.getHealth()).toMatchObject({
      status: "healthy",
      summary: "Polling has no active repository targets.",
    });

    tracker.updatePollingTargets([pollingTarget(thirdRepository, 10)]);
    tracker.recordReconciliationSuccess(thirdRepository, 10);
    expect(tracker.getHealth().status).toBe("healthy");
    expect(tracker.getHealth().summary).toContain("all 1 configured repositories");
  });

  it("tracks database-managed targets without any legacy bootstrap repository or reviewer", () => {
    const { tracker, setTime } = createTracker({
      github: { ...githubConfig(), legacyBootstrap: undefined },
      recoveryMaintenance: false,
    });
    expect(tracker.getHealth()).toMatchObject({
      status: "healthy",
      summary: "Polling has no active repository targets.",
    });
    tracker.updatePollingTargets([pollingTarget(thirdRepository, 30)]);
    tracker.recordReconciliationSuccess(thirdRepository);
    setTime(180_001);
    expect(tracker.getHealth().summary).toContain("1 initial reconciliations are overdue");
    tracker.recordReconciliationSuccess(thirdRepository, 30);
    expect(tracker.getHealth().status).toBe("healthy");
  });

  it("does not let one reviewer mask another reviewer's failure in the same repository", () => {
    const { tracker } = createTracker();
    tracker.updatePollingTargets([
      pollingTarget(firstRepository, 3),
      pollingTarget(firstRepository, 4),
    ]);
    tracker.recordReconciliationFailure(firstRepository, 3);
    tracker.recordReconciliationSuccess(firstRepository, 4);

    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("1 of 1 configured repositories");
    expect(tracker.getHealth().summary).toContain("Tracking 2 repository/reviewer targets");
    tracker.recordReconciliationSuccess(firstRepository, 3);
    expect(tracker.getHealth().status).toBe("healthy");
    tracker.recordReconciliationFailure(firstRepository, 4);
    tracker.recordReconciliationSuccess(firstRepository);
    expect(tracker.getHealth().status).toBe("degraded");
  });

  it("preserves stable repository history across an authoritative rename and rejects old-name callbacks", () => {
    const { tracker } = createTracker();
    const renamed = { ...firstRepository, fullName: "owner/renamed" };
    tracker.recordReconciliationFailure(firstRepository);
    tracker.updatePollingTargets([pollingTarget(renamed)]);
    tracker.recordReconciliationSuccess(firstRepository);

    expect(tracker.getHealth().status).toBe("degraded");
    tracker.recordReconciliationSuccess({ ...renamed, fullName: "OWNER/RENAMED" });
    expect(tracker.getHealth().status).toBe("healthy");
  });

  it("snapshots target identities and rejects conflicting updates atomically", () => {
    const { tracker } = createTracker();
    const target = pollingTarget({ ...thirdRepository }, 4);
    tracker.updatePollingTargets([target, target]);
    target.repository.fullName = "owner/mutated";
    target.reviewer.githubUserId = 20;
    tracker.recordReconciliationSuccess(thirdRepository, 4);

    expect(tracker.getHealth().status).toBe("healthy");
    expect(() =>
      tracker.updatePollingTargets([
        pollingTarget(firstRepository),
        pollingTarget({ ...firstRepository, fullName: "owner/conflicting" }, 4),
      ]),
    ).toThrow("conflicting repository identities");
    expect(tracker.getHealth().summary).toContain("all 1 configured repositories");
    expect(tracker.getHealth().status).toBe("healthy");
  });
});

describe("GitHub webhook processing observations", () => {
  const webhookConfig = (polling = false): GitHubIntegrationConfig => ({
    ...githubConfig(),
    polling: polling ? githubConfig().polling : undefined,
    webhook: {
      path: "/api/v1/github/webhook",
      secret: Buffer.from("webhook-secret"),
      maxPayloadBytes: 1_024,
    },
  });

  it("tracks accepted dynamic repositories without imposing an idle delivery deadline", () => {
    const { tracker, setTime } = createTracker({
      github: webhookConfig(),
      recoveryMaintenance: false,
    });
    tracker.recordWebhookSuccess(thirdRepository);
    setTime(24 * 60 * 60 * 1_000);

    const health = tracker.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.summary).toContain("1 observed repositories");
    expect(health.summary).toContain("Latest processing success: 2026-09-06T01:00:00.000Z");
    expect(health.summary).toContain("Idle delivery periods are expected");
    expect(health.summary).toContain("remote webhook delivery is not verified");
    expect(Value.Check(DashboardHealthComponentSchema, health)).toBe(true);
    expect(JSON.stringify(health)).not.toContain("webhook-secret");
  });

  it("retains a repository's failed processing until that repository processes a delivery successfully", () => {
    const { tracker } = createTracker({ github: webhookConfig(), recoveryMaintenance: false });
    tracker.recordWebhookFailure(thirdRepository);
    tracker.recordWebhookSuccess(firstRepository);

    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain(
      "Webhook processing failed for 1 of 2 observed repositories",
    );
    tracker.recordWebhookSuccess(thirdRepository);
    expect(tracker.getHealth().status).toBe("healthy");
    expect(tracker.getHealth().summary).toContain(
      "Successfully processed webhooks for 2 observed repositories",
    );
  });

  it("keeps webhook and polling outcomes independent", () => {
    const { tracker, setTime } = createTracker({
      github: webhookConfig(true),
      recoveryMaintenance: false,
    });
    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordReconciliationSuccess(secondRepository);
    tracker.recordReconciliationFailure(firstRepository);
    tracker.recordWebhookSuccess(firstRepository);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("1 latest reconciliations failed");

    tracker.recordReconciliationSuccess(firstRepository);
    tracker.recordWebhookFailure(thirdRepository);
    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("Webhook processing failed");
    tracker.recordWebhookSuccess(thirdRepository);
    setTime(180_001);
    tracker.recordWebhookSuccess(firstRepository);
    expect(tracker.getHealth().summary).toContain("2 successful reconciliations are overdue");
  });

  it("does not make a webhook observation an active polling target or erase it when polling targets change", () => {
    const { tracker } = createTracker({ github: webhookConfig(true), recoveryMaintenance: false });
    tracker.recordWebhookFailure(thirdRepository);
    expect(tracker.getHealth().summary).toContain(
      "2 repositories; 2 await their first reconciliation",
    );
    tracker.updatePollingTargets([]);

    expect(tracker.getHealth().status).toBe("degraded");
    expect(tracker.getHealth().summary).toContain("Polling has no active repository targets");
    expect(tracker.getHealth().summary).toContain(
      "Webhook processing failed for 1 of 1 observed repositories",
    );
    tracker.recordWebhookSuccess(thirdRepository);
    expect(tracker.getHealth().status).toBe("healthy");
  });

  it("ignores observations when webhooks are disabled or ingestion is in recovery maintenance", () => {
    const disabled = createTracker({ github: undefined, recoveryMaintenance: false }).tracker;
    disabled.recordWebhookFailure(thirdRepository);
    expect(disabled.getHealth()).toMatchObject({
      status: "healthy",
      summary: "GitHub ingestion is disabled by configuration.",
    });

    const maintenance = createTracker({
      github: webhookConfig(true),
      recoveryMaintenance: true,
    }).tracker;
    maintenance.recordWebhookFailure(thirdRepository);
    maintenance.recordWebhookSuccess(firstRepository);
    expect(maintenance.getHealth()).toMatchObject({
      status: "healthy",
      summary: "GitHub ingestion is paused during recovery maintenance.",
    });
  });
});
