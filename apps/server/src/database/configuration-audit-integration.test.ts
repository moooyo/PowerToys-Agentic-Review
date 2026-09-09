import type { OperatorPrincipal } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import {
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
  present,
} from "./evidence-control-plane.testing.js";

const administrator: OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "configuration-audit-administrator",
};
const viewer: OperatorPrincipal = { issuer: administrator.issuer, subject: "audit-viewer" };
const fixtures: EvidenceControlPlaneFixture[] = [];

async function fixture() {
  const result = await createEvidenceControlPlaneFixture(1, [administrator]);
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  const outcomes = await Promise.allSettled(fixtures.splice(0).map((item) => item.dispose()));
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Configuration audit integration cleanup failed.",
    );
});

function changeViewerAccess(
  f: EvidenceControlPlaneFixture,
  role: "viewer" | null,
  expectedVersion: number,
) {
  return bindOperatorDatabase(f.client, administrator).request("changeRepositoryAccess", {
    repositoryId: f.run.repositoryId,
    actor: administrator,
    request: {
      principal: viewer,
      role,
      expectedVersion,
      changeId: `audit-viewer-${expectedVersion}`,
      reason: "Exercise configuration audit visibility through the database owner.",
    },
  });
}

const denied = (request: Promise<unknown>, code: "PLATFORM_FORBIDDEN" | "PLATFORM_NOT_FOUND") =>
  expect(request).rejects.toMatchObject({ code });

const linuxDescribe = describe.skipIf(process.platform !== "linux");
linuxDescribe("configuration audit through the real database owner", () => {
  it("persists scheduling limits and records only successful CAS changes through the owner", async () => {
    const f = await fixture();
    const admin = bindOperatorDatabase(f.client, administrator);
    const created = await admin.request("createManagedRepository", {
      actor: administrator,
      request: {
        githubRepositoryId: 2,
        fullName: "example/scheduling-limits",
        schedulingLimits: { maxActiveLeases: 2, maxQueuedJobs: 10 },
      },
    });
    const retained = await admin.request("updateManagedRepository", {
      repositoryId: created.id,
      actor: administrator,
      request: { expectedVersion: created.version, enabled: true },
    });
    expect(retained.schedulingLimits).toEqual(created.schedulingLimits);
    expect(retained.version).toBe(2);
    await expect(
      admin.request("updateManagedRepository", {
        repositoryId: created.id,
        actor: administrator,
        request: {
          expectedVersion: created.version,
          schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
        },
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_CONFLICT" });
    await expect(
      admin.request("updateManagedRepository", {
        repositoryId: created.id,
        actor: administrator,
        request: {
          expectedVersion: retained.version,
          schedulingLimits: { maxActiveLeases: 0, maxQueuedJobs: 10 },
        },
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_INVALID" });
    expect(await admin.request("getManagedRepository", { repositoryId: created.id })).toEqual(
      retained,
    );
    const cleared = await admin.request("updateManagedRepository", {
      repositoryId: created.id,
      actor: administrator,
      request: {
        expectedVersion: retained.version,
        schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
      },
    });
    expect(cleared).toMatchObject({
      version: 3,
      enabled: true,
      schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
    });
    const history = await admin.request("listRepositoryConfigurationAudit", {
      repositoryId: created.id,
    });
    expect(history.total).toBe(3);
    for (const snapshot of [created, retained, cleared]) {
      const event = present(history.items.find((item) => item.version === snapshot.version));
      expect(
        await admin.request("getRepositoryConfigurationAudit", {
          repositoryId: created.id,
          source: "repository",
          eventId: event.id,
        }),
      ).toMatchObject({
        action: snapshot.version === 1 ? "created" : "updated",
        actor: administrator,
        version: snapshot.version,
        snapshot,
      });
    }
    expect(await admin.request("getManagedRepository", { repositoryId: created.id })).toEqual(
      cleared,
    );
  }, 30_000);

  it("enforces repository grants, revocation and global audit scope", async () => {
    const f = await fixture();
    const admin = bindOperatorDatabase(f.client, administrator);
    const reader = bindOperatorDatabase(f.client, viewer);
    const repositoryId = f.run.repositoryId;
    const other = await admin.request("createManagedRepository", {
      actor: administrator,
      request: { githubRepositoryId: 2, fullName: "example/audit-other", enabled: true },
    });
    const ownAudit = await admin.request("listRepositoryConfigurationAudit", { repositoryId });
    const otherAudit = await admin.request("listRepositoryConfigurationAudit", {
      repositoryId: other.id,
    });
    const globalAudit = await admin.request("listGlobalConfigurationAudit", {});
    expect(ownAudit.total).toBeGreaterThan(0);
    expect(ownAudit.items.every((event) => event.repositoryId === repositoryId)).toBe(true);
    expect(new Set(ownAudit.items.map((event) => event.source))).toEqual(
      new Set(["repository", "prompt"]),
    );
    expect(otherAudit).toMatchObject({ repositoryId: other.id, total: 1 });
    expect(otherAudit.items).toMatchObject([
      { source: "repository", action: "created", actor: administrator },
    ]);
    expect(globalAudit.total).toBeGreaterThan(0);
    expect(globalAudit.items.every((event) => event.repositoryId === null)).toBe(true);
    for (const summary of globalAudit.items) {
      const detail = await admin.request("getGlobalConfigurationAudit", { eventId: summary.id });
      expect(detail).toMatchObject(summary);
      expect(detail).toHaveProperty("snapshot");
    }

    const repositoryEvent = present(ownAudit.items.find((event) => event.source === "repository"));
    const promptEvent = present(ownAudit.items.find((event) => event.source === "prompt"));
    const otherEvent = present(otherAudit.items[0]);
    const globalEvent = present(globalAudit.items[0]);
    await denied(
      reader.request("listRepositoryConfigurationAudit", { repositoryId }),
      "PLATFORM_NOT_FOUND",
    );
    await changeViewerAccess(f, "viewer", 0);
    expect(await reader.request("listRepositoryConfigurationAudit", { repositoryId })).toEqual(
      ownAudit,
    );
    for (const summary of ownAudit.items) {
      expect(summary).not.toHaveProperty("snapshot");
      const query = { repositoryId, source: summary.source, eventId: summary.id };
      const detail = await reader.request("getRepositoryConfigurationAudit", query);
      expect(detail).toMatchObject(summary);
      expect(detail).toHaveProperty("snapshot");
      expect(detail).toEqual(await admin.request("getRepositoryConfigurationAudit", query));
    }
    await denied(
      reader.request("listRepositoryConfigurationAudit", { repositoryId: other.id }),
      "PLATFORM_NOT_FOUND",
    );
    await denied(
      reader.request("getRepositoryConfigurationAudit", {
        repositoryId: other.id,
        source: otherEvent.source,
        eventId: otherEvent.id,
      }),
      "PLATFORM_NOT_FOUND",
    );
    await denied(reader.request("listGlobalConfigurationAudit", {}), "PLATFORM_FORBIDDEN");
    await denied(
      reader.request("getGlobalConfigurationAudit", { eventId: globalEvent.id }),
      "PLATFORM_FORBIDDEN",
    );

    for (const query of [
      { repositoryId, source: otherEvent.source, eventId: otherEvent.id },
      { repositoryId, source: "prompt", eventId: globalEvent.id },
      { repositoryId, source: "prompt", eventId: repositoryEvent.id },
      { repositoryId, source: "repository", eventId: promptEvent.id },
      { repositoryId, source: "repository", eventId: "missing-event" },
    ] as const)
      expect(await reader.request("getRepositoryConfigurationAudit", query)).toBeNull();
    for (const eventId of [repositoryEvent.id, promptEvent.id, otherEvent.id, "missing-event"])
      expect(await admin.request("getGlobalConfigurationAudit", { eventId })).toBeNull();

    await changeViewerAccess(f, null, 1);
    await denied(
      reader.request("listRepositoryConfigurationAudit", { repositoryId }),
      "PLATFORM_NOT_FOUND",
    );
    await denied(
      reader.request("getRepositoryConfigurationAudit", {
        repositoryId,
        source: repositoryEvent.source,
        eventId: repositoryEvent.id,
      }),
      "PLATFORM_NOT_FOUND",
    );
    expect(await admin.request("listRepositoryConfigurationAudit", { repositoryId })).toEqual(
      ownAudit,
    );
  }, 30_000);

  it("preserves configuration and history across repeated audit reads", async () => {
    const f = await fixture();
    const admin = bindOperatorDatabase(f.client, administrator);
    const reader = bindOperatorDatabase(f.client, viewer);
    const repositoryId = f.run.repositoryId;
    await changeViewerAccess(f, "viewer", 0);
    const repository = present(await admin.request("getManagedRepository", { repositoryId }));
    await admin.request("updateManagedRepository", {
      repositoryId,
      actor: administrator,
      request: {
        expectedVersion: repository.version,
        enabled: false,
        schedulingLimits: { maxActiveLeases: 3, maxQueuedJobs: 12 },
      },
    });
    const template = present((await admin.request("listPromptTemplates", {})).items[0]);
    const templateId = template.id;
    const published = await admin.request("getPromptVersion", {
      templateId,
      versionId: present(template.latestPublishedVersionId),
    });
    const draftContent = "NEW_DRAFT_MUST_REMAIN_SEPARATE_FROM_PUBLISHED_HISTORY";
    await admin.request("savePromptDraft", {
      templateId,
      actor: administrator,
      request: {
        expectedVersion: template.version,
        content: draftContent,
        outputSchemaVersion: "PrReviewPlanV2",
      },
    });
    await admin.request("savePromptBinding", {
      repositoryId: null,
      workflowKind: "pr_static_build",
      actor: administrator,
      request: { expectedVersion: 0, promptVersionId: published.id },
    });
    const profile = present(f.run.plan.jobs[0]?.profileVersion);
    const profileScope = { repositoryId, profileId: profile.profileId };
    const configurationState = async () => ({
      repository: await admin.request("getManagedRepository", { repositoryId }),
      template: await admin.request("getPromptTemplate", { templateId }),
      versions: await admin.request("listPromptVersions", { templateId }),
      published: await admin.request("getPromptVersion", { templateId, versionId: published.id }),
      repositoryBindings: await admin.request("listPromptBindings", { repositoryId }),
      repositoryBindingHistory: await admin.request("listPromptBindingHistory", {
        repositoryId,
        workflowKind: "pr_static_build",
      }),
      globalBindings: await admin.request("listPromptBindings", { repositoryId: null }),
      globalBindingHistory: await admin.request("listPromptBindingHistory", {
        repositoryId: null,
        workflowKind: "pr_static_build",
      }),
      profileVersions: await admin.request("listValidationProfileVersions", profileScope),
      profileBindingHistory: await admin.request(
        "listValidationProfileBindingHistory",
        profileScope,
      ),
    });
    const before = await configurationState();
    expect(before.template?.draftContent).toBe(draftContent);
    expect(before.published).toEqual(published);
    expect(before.repositoryBindingHistory.total).toBe(1);
    expect(before.globalBindingHistory.total).toBe(1);
    const repositoryAudit = await reader.request("listRepositoryConfigurationAudit", {
      repositoryId,
    });
    const globalAudit = await admin.request("listGlobalConfigurationAudit", {});
    expect(repositoryAudit.total).toBe(repositoryAudit.items.length);
    expect(globalAudit.total).toBe(globalAudit.items.length);
    const readDetails = async () => ({
      repository: await Promise.all(
        repositoryAudit.items.map((event) =>
          reader.request("getRepositoryConfigurationAudit", {
            repositoryId,
            source: event.source,
            eventId: event.id,
          }),
        ),
      ),
      global: await Promise.all(
        globalAudit.items.map((event) =>
          admin.request("getGlobalConfigurationAudit", { eventId: event.id }),
        ),
      ),
    });
    const details = await readDetails();
    expect(details.repository.find((event) => event?.action === "bootstrapped")).toMatchObject({
      snapshot: {
        enabled: true,
        version: repository.version,
        schedulingLimits: { maxActiveLeases: null, maxQueuedJobs: null },
      },
    });
    expect(details.repository.find((event) => event?.action === "updated")).toMatchObject({
      snapshot: before.repository,
    });
    expect(JSON.stringify(details.global)).not.toContain(draftContent);
    expect(await readDetails()).toEqual(details);
    expect(await reader.request("listRepositoryConfigurationAudit", { repositoryId })).toEqual(
      repositoryAudit,
    );
    expect(await admin.request("listGlobalConfigurationAudit", {})).toEqual(globalAudit);
    expect(await configurationState()).toEqual(before);
  }, 30_000);
});
