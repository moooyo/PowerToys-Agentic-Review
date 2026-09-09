import { PrReviewPlanV2ModelOutputSchema } from "@agentic-review/codex";
import type {
  GitHubRepository,
  OperatorPrincipal,
  OperatorRepositoryRole,
  SchedulingRequestOpenedEvent,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import { canonicalJson, sha256 } from "../../dist/scheduling/canonical-json.js";
import {
  completion,
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
  present,
  resultQuery,
  uploadEvidence,
} from "./evidence-control-plane.testing.js";

const platform: OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "platform-admin",
};
const member: OperatorPrincipal = { issuer: platform.issuer, subject: "member" };
const delegate: OperatorPrincipal = { issuer: platform.issuer, subject: "delegate" };
const fixtures: EvidenceControlPlaneFixture[] = [];
async function fixture(profileCount = 1) {
  const f = await createEvidenceControlPlaneFixture(profileCount, [platform]);
  fixtures.push(f);
  return f;
}
const bound = (f: EvidenceControlPlaneFixture, actor = member) =>
  bindOperatorDatabase(f.client, actor);
const denied = (promise: Promise<unknown>, code = "PLATFORM_FORBIDDEN") =>
  expect(promise).rejects.toMatchObject({ code });
afterEach(async () => {
  const outcomes = await Promise.allSettled(fixtures.splice(0).map((f) => f.dispose()));
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Operator access integration cleanup failed.",
    );
});
function changeInput(
  f: EvidenceControlPlaneFixture,
  principal: OperatorPrincipal,
  role: OperatorRepositoryRole | null,
  expectedVersion = 0,
  actor = platform,
  repositoryId = f.run.repositoryId,
  changeId = `change-${principal.subject}-${role}-${expectedVersion}`,
) {
  return {
    actor,
    repositoryId,
    request: {
      principal,
      role,
      expectedVersion,
      changeId,
      reason: "Exercise authenticated operator access.",
    },
  };
}
const grant = (
  f: EvidenceControlPlaneFixture,
  role: OperatorRepositoryRole | null,
  expectedVersion = 0,
  principal = member,
  repositoryId = f.run.repositoryId,
) =>
  bound(f, platform).request(
    "changeRepositoryAccess",
    changeInput(f, principal, role, expectedVersion, platform, repositoryId),
  );

async function secondRepository(f: EvidenceControlPlaneFixture) {
  const admin = bound(f, platform);
  const now = new Date().toISOString();
  const original = f.run.plan.workItem;
  if (original.kind !== "pull_request") throw new Error("The fixture requires a pull request.");
  const repository: GitHubRepository = {
    githubRepositoryId: 2,
    githubNodeId: "second-repository",
    ownerLogin: "example",
    name: "project-2",
    fullName: "example/project-2",
    htmlUrl: "https://github.com/example/project-2",
    defaultBranch: "main",
    isPrivate: false,
  };
  const created = await admin.request("createManagedRepository", {
    actor: platform,
    metadata: repository,
    request: { githubRepositoryId: 2, fullName: repository.fullName, enabled: true },
  });
  await admin.request("updateManagedRepository", {
    repositoryId: created.id,
    actor: platform,
    request: {
      expectedVersion: created.version,
      enabled: true,
      reviewerGithubUserId: original.author.githubUserId,
      reviewerGithubLogin: original.author.login,
      authorizationPolicy: f.run.plan.authorization.policy,
    },
  });
  const event: SchedulingRequestOpenedEvent = {
    contractVersion: 1,
    eventId: "second-repository-open",
    source: "webhook",
    sourceEventId: "second-repository-delivery",
    occurredAt: now,
    observedAt: now,
    repository,
    author: original.author,
    actor: original.author,
    target: original.author,
    action: "request_opened",
    requestKind: "review_request",
    workItem: {
      ...original,
      githubRepositoryId: 2,
      githubWorkItemId: 2001,
      githubNodeId: "PR_SECOND_1",
      htmlUrl: `${repository.htmlUrl}/pull/1`,
      createdAt: now,
      updatedAt: now,
    },
    revision: {
      kind: "pull_request",
      githubRepositoryId: 2,
      githubWorkItemId: 2001,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      revisionKey: f.run.revisionKey,
      observedAt: now,
      sourceUpdatedAt: now,
    },
  };
  const prompt = "Review the exact source revision.";
  const result = await f.client.request("ingestSchedulingEvent", {
    event,
    policy: f.run.plan.authorization.policy,
    delivery: {
      deliveryId: event.sourceEventId,
      eventName: "pull_request",
      receivedAt: now,
      payloadSha256: sha256(canonicalJson(event)),
    },
    schedule: {
      jobKind: "pull_request_review",
      priority: 1,
      intentVersion: 1,
      maxAttempts: 2,
      requiredCapabilities: [],
      executionTemplate: {
        repository: { githubRepositoryId: 2, fullName: repository.fullName },
        resource: {
          kind: "pull_request",
          githubNodeId: event.workItem.githubNodeId,
          number: 1,
          title: original.title,
          author: original.author,
          canonicalSnapshot: event.workItem,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          isDraft: false,
        },
        prompt: {
          name: "review",
          version: "fixture",
          renderedPrompt: prompt,
          promptSha256: sha256(prompt),
          outputSchema: PrReviewPlanV2ModelOutputSchema,
          outputSchemaSha256: sha256(canonicalJson(PrReviewPlanV2ModelOutputSchema)),
        },
        executionPolicy: {
          hardTimeoutMs: 600_000,
          noProgressTimeoutMs: 120_000,
          allowedRecipeIds: [],
          requiredCapabilityLabels: {},
        },
      },
    },
  });
  expect(result).toMatchObject({ authorized: true, jobCreated: true, repositoryId: created.id });
  return { repositoryId: created.id, workItemId: result.workItemId, jobId: present(result.jobId) };
}

const linuxDescribe = describe.skipIf(process.platform !== "linux");
linuxDescribe("operator authorization through the real database owner", () => {
  it("filters ungranted identities and isolates identical PR numbers before list totals and pagination", async () => {
    const f = await fixture();
    const other = await secondRepository(f);
    const reader = bound(f);
    for (const operation of ["listManagedRepositories", "listWorkItems", "listJobs"] as const)
      expect(await reader.request(operation, { page: 1, pageSize: 1 })).toMatchObject({
        items: [],
        total: 0,
      });
    await grant(f, "viewer");
    const repositories = await reader.request("listManagedRepositories", {});
    expect(repositories.total).toBe(1);
    expect(repositories.items.map((item) => item.id)).toEqual([f.run.repositoryId]);
    const items = await reader.request("listWorkItems", {
      page: 1,
      pageSize: 1,
      search: "Validate",
    });
    expect(items.total).toBe(1);
    expect(items.items).toMatchObject([{ repositoryId: f.run.repositoryId, number: 1 }]);
    const allItems = await bound(f, platform).request("listWorkItems", {});
    expect(allItems.total).toBe(2);
    expect(allItems.items.every((item) => item.number === 1)).toBe(true);
    const ownJobs = await bound(f, platform).request("listJobs", {
      repositoryId: f.run.repositoryId,
    });
    const allJobs = await bound(f, platform).request("listJobs", {});
    expect(allJobs.total).toBeGreaterThan(ownJobs.total);
    const seen: string[] = [];
    for (let page = 1; page <= ownJobs.total + 1; page += 1) {
      const listed = await reader.request("listJobs", { page, pageSize: 1 });
      expect(listed.total).toBe(ownJobs.total);
      expect(listed.items.every((job) => job.repositoryId === f.run.repositoryId)).toBe(true);
      seen.push(...listed.items.map((job) => job.id));
    }
    expect(new Set(seen).size).toBe(ownJobs.total);
    expect(seen).not.toContain(other.jobId);
    await denied(
      reader.request("getManagedRepository", { repositoryId: other.repositoryId }),
      "PLATFORM_NOT_FOUND",
    );
    await denied(reader.request("getJob", { jobId: other.jobId }), "PLATFORM_NOT_FOUND");
    await denied(
      reader.request("getPromptWorkItemContext", { workItemId: other.workItemId }),
      "PLATFORM_NOT_FOUND",
    );
    await denied(
      reader.request("listJobs", { repositoryId: other.repositoryId }),
      "PLATFORM_NOT_FOUND",
    );
    await grant(f, "viewer", 0, member, other.repositoryId);
    const pages = await Promise.all([
      reader.request("listWorkItems", { page: 1, pageSize: 1 }),
      reader.request("listWorkItems", { page: 2, pageSize: 1 }),
    ]);
    expect(pages.every((page) => page.total === 2 && page.items.length === 1)).toBe(true);
    expect(new Set(pages.flatMap((page) => page.items.map((item) => item.repositoryId)))).toEqual(
      new Set([f.run.repositoryId, other.repositoryId]),
    );
    expect(
      await reader.request("getDashboardReviewRun", {
        repositoryId: other.repositoryId,
        reviewRunId: f.run.id,
      }),
    ).toBeNull();
    const profile = present(f.run.plan.jobs[0]?.profileVersion);
    await denied(
      reader.request("getValidationProfileVersion", {
        repositoryId: other.repositoryId,
        profileId: profile.profileId,
        versionId: profile.id,
      }),
      "PLATFORM_INVALID",
    );
    await f.restart();
    expect((await bound(f).request("listManagedRepositories", {})).total).toBe(2);
    expect(
      (await bound(f, platform).request("getOperatorAccessContext", { actor: platform }))
        .platformAdministrator,
    ).toBe(true);
  }, 30_000);

  it("does not grant access to a matching subject at another issuer or with different case", async () => {
    const f = await fixture();
    await grant(f, "viewer");
    for (const principal of [
      { ...member, issuer: "https://other.example.test" },
      { ...member, subject: "Member" },
      { ...platform, subject: "Platform-admin" },
      { ...platform, issuer: platform.issuer.toUpperCase() },
    ]) {
      const other = bound(f, principal);
      expect((await other.request("listManagedRepositories", {})).total).toBe(0);
      await denied(
        other.request("getManagedRepository", { repositoryId: f.run.repositoryId }),
        "PLATFORM_NOT_FOUND",
      );
      await denied(other.request("operatorCheckPermission", {}));
    }
    await denied(
      bound(f).request("updateRepositoryConnection", {
        repositoryId: f.run.repositoryId,
        status: "ready",
        message: null,
      }),
    );
    await denied(
      f.client.request("operatorRequest", {
        context: { kind: "operator", actor: member },
        operation: "updateManagedRepository",
        input: {
          repositoryId: f.run.repositoryId,
          actor: platform,
          request: { expectedVersion: 1, enabled: true },
        },
      }),
    );
  }, 30_000);

  it.each(["viewer", "reviewer", "maintainer", "admin"] as const)(
    "enforces real read/write operations for the %s role",
    async (role) => {
      const f = await fixture();
      await grant(f, role);
      const operator = bound(f);
      expect(
        (await operator.request("getManagedRepository", { repositoryId: f.run.repositoryId }))?.id,
      ).toBe(f.run.repositoryId);
      expect(
        (await operator.request("listValidationProfiles", { repositoryId: f.run.repositoryId }))
          .total,
      ).toBe(1);
      const create = () =>
        operator.request("createOperatorReviewRun", {
          repositoryId: f.run.repositoryId,
          workItemId: f.run.workItemId,
          actor: member,
          request: { activationId: `run-${role}`, expectedRevisionKey: f.run.revisionKey },
        });
      if (role === "viewer") await denied(create());
      else {
        const run = await create();
        expect(run.createdBy).toEqual(member);
        const selected = present(run.requests[0]);
        const job = present(selected.jobs[0]);
        expect(
          await operator.request("cancelValidationJob", {
            repositoryId: run.repositoryId,
            reviewRunId: run.id,
            requestId: selected.requestId,
            jobId: job.jobId,
            actor: member,
          }),
        ).toMatchObject({ changed: true, jobState: "cancelled" });
      }
      const configure = () =>
        operator.request("updateRepositoryConnection", {
          repositoryId: f.run.repositoryId,
          status: "ready",
          message: "Configuration permission verified.",
        });
      if (role === "viewer" || role === "reviewer") await denied(configure());
      else expect((await configure()).connectionStatus).toBe("ready");
      const change = changeInput(f, delegate, "viewer", 0, member);
      if (role === "admin")
        expect((await operator.request("changeRepositoryAccess", change)).change.actor).toEqual(
          member,
        );
      else await denied(operator.request("changeRepositoryAccess", change));
      for (const operation of ["listPromptTemplates", "listWorkers", "getSystemSnapshot"] as const)
        await denied(operator.request(operation, {}));
      await denied(operator.request("listWorkerNodeCredentials", { offset: 0, limit: 50 }));
      await denied(
        operator.request("createWorkerNodeCredential", {
          workerNodeId: "forbidden-node",
          displayName: "Forbidden",
          workerTokenSha256: "a".repeat(64),
          createdByIssuer: member.issuer,
          createdBySubject: member.subject,
        }),
      );
      await denied(operator.request("listPromptBindings", { repositoryId: null }));
      expect(
        (await bound(f, platform).request("listWorkerNodeCredentials", { offset: 0, limit: 50 }))
          .total,
      ).toBe(1);
    },
    30_000,
  );

  it("keeps CAS, last-admin protection and historical replay from restoring revoked authority", async () => {
    const f = await fixture();
    const admin = bound(f, platform);
    const operator = bound(f);
    const original = changeInput(f, member, "admin");
    expect((await admin.request("changeRepositoryAccess", original)).replayed).toBe(false);
    const delegated = changeInput(f, delegate, "viewer", 0, member);
    expect((await operator.request("changeRepositoryAccess", delegated)).replayed).toBe(false);
    expect((await operator.request("changeRepositoryAccess", delegated)).replayed).toBe(true);
    await denied(
      operator.request("changeRepositoryAccess", changeInput(f, delegate, "admin", 0, member)),
      "PLATFORM_CONFLICT",
    );
    await denied(
      operator.request("changeRepositoryAccess", changeInput(f, member, "viewer", 1, member)),
      "PLATFORM_CONFLICT",
    );
    expect((await grant(f, "viewer", 1)).change.version).toBe(2);
    await denied(operator.request("changeRepositoryAccess", delegated));
    const old = await admin.request("changeRepositoryAccess", original);
    expect(old).toMatchObject({ replayed: true, change: { role: "admin", version: 1 } });
    expect(
      (
        await operator.request("getOperatorAccessContext", {
          actor: member,
          repositoryId: f.run.repositoryId,
        })
      ).repository,
    ).toMatchObject({ role: "viewer" });
    await denied(
      admin.request("changeRepositoryAccess", {
        ...original,
        request: { ...original.request, changeId: "stale-restore" },
      }),
      "PLATFORM_CONFLICT",
    );
    await grant(f, null, 2);
    await denied(
      operator.request("getManagedRepository", { repositoryId: f.run.repositoryId }),
      "PLATFORM_NOT_FOUND",
    );
    expect((await operator.request("listJobs", {})).total).toBe(0);
    expect((await admin.request("changeRepositoryAccess", original)).replayed).toBe(true);
    const grants = await admin.request("listRepositoryAccessGrants", {
      actor: platform,
      repositoryId: f.run.repositoryId,
    });
    expect(grants.items.find((item) => item.principal.subject === member.subject)).toMatchObject({
      role: null,
      version: 3,
    });
    const audit = await admin.request("listRepositoryAccessAudit", {
      actor: platform,
      repositoryId: f.run.repositoryId,
      page: 1,
      pageSize: 1,
    });
    expect(audit.total).toBe(4);
    expect(audit.items).toHaveLength(1);
  }, 30_000);

  it("keeps trusted Worker and polling RPCs independent of operator membership", async () => {
    const f = await fixture();
    const envelope = present((await f.claimAll())[0]);
    expect(await f.heartbeat(envelope)).toMatchObject({ command: "continue" });
    const key = {
      githubRepositoryId: 1,
      repositoryFullName: f.run.plan.repository.fullName,
      reviewerGithubUserId: f.run.plan.authorization.targetGithubUserId,
    };
    const projection = {
      version: 1 as const,
      ...key,
      reviewerLogin: f.run.plan.workItem.author.login,
      workItems: [],
    };
    expect(
      await f.client.request("writeGitHubPollingProjection", {
        key,
        projection,
        updatedAt: new Date().toISOString(),
      }),
    ).toEqual({ written: true });
    const restored = await f.client.request("readGitHubPollingProjection", key);
    expect(restored).toMatchObject({
      projection: {
        ...key,
        version: 1,
        reviewerLogin: projection.reviewerLogin,
        workItems: [
          {
            workItem: {
              githubRepositoryId: 1,
              githubWorkItemId: f.run.plan.workItem.githubWorkItemId,
              number: 1,
            },
            activeRequests: [{ requestKind: "review_request" }],
          },
        ],
      },
    });
    for (const operation of [
      "claimLease",
      "readGitHubPollingProjection",
      "operatorRequest",
      "shutdown",
    ])
      await denied(
        f.client.request("operatorRequest", {
          context: { kind: "operator", actor: platform },
          operation,
          input: {},
        }),
      );
    await f.client.request("ping", {});
    expect(await f.heartbeat(envelope, 2)).toMatchObject({ command: "continue" });
  }, 30_000);

  it("rechecks repository access on each evidence chunk RPC", async () => {
    const f = await fixture();
    const envelope = present((await f.claimAll())[0]);
    const assetId = await uploadEvidence(f, envelope, "access-chunks", 1024);
    await grant(f, "viewer");
    const reader = bound(f);
    const scope = {
      repositoryId: f.run.repositoryId,
      runId: f.run.id,
      jobId: envelope.job.jobId,
      runAttemptId: envelope.lease.runAttemptId,
      assetId,
    };
    expect(
      (await reader.request("readEvidenceAssetChunk", { ...scope, offset: 0, maximumBytes: 256 }))
        .base64.length,
    ).toBeGreaterThan(0);
    await grant(f, null, 1);
    await denied(
      reader.request("readEvidenceAssetChunk", { ...scope, offset: 256, maximumBytes: 256 }),
      "PLATFORM_NOT_FOUND",
    );
    await denied(reader.request("getEvidenceAsset", scope), "PLATFORM_NOT_FOUND");
    expect(
      (
        await f.client.request("readEvidenceAssetChunk", {
          ...scope,
          offset: 256,
          maximumBytes: 256,
        })
      ).base64.length,
    ).toBeGreaterThan(0);
  }, 30_000);

  it.each(["getDashboardReviewRun", "getDashboardReviewRunJobResult"] as const)(
    "rejects %s when access is revoked during a real 32 MiB evidence preflight",
    async (operation) => {
      const f = await fixture(2);
      const leases = await f.claimAll();
      const resultLease = present(leases[0]);
      const activeLease = present(leases[1]);
      const assetId = await uploadEvidence(f, resultLease, "access-race", 32 * 1024 * 1024);
      const sent = completion(resultLease, [assetId]);
      expect(await f.client.request("completeLease", sent)).toMatchObject({
        runState: "succeeded",
      });
      await grant(f, "viewer");
      const reader = bound(f);
      const admin = bound(f, platform);
      const order: string[] = [];
      const input = operation === "getDashboardReviewRun" ? f.query : resultQuery(f, resultLease);
      const pending = reader
        .request(operation, input)
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        )
        .then((outcome) => {
          order.push("read");
          return outcome;
        });
      const heartbeat = f.heartbeat(activeLease).then((value) => {
        order.push("heartbeat");
        return value;
      });
      const revoked = admin
        .request("changeRepositoryAccess", changeInput(f, member, null, 1))
        .then((value) => {
          order.push("revoked");
          return value;
        });
      expect(await heartbeat).toMatchObject({ command: "continue" });
      expect((await revoked).change.role).toBeNull();
      const outcome = await pending;
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected")
        throw new Error("Revoked access exposed a previously prepared evidence projection.");
      expect(outcome.reason).toEqual(
        expect.objectContaining({
          code: expect.stringMatching(/^PLATFORM_(?:NOT_FOUND|FORBIDDEN)$/u),
        }),
      );
      expect(order.indexOf("heartbeat")).toBeLessThan(order.indexOf("read"));
      expect(order.indexOf("revoked")).toBeLessThan(order.indexOf("read"));
      expect(await f.heartbeat(activeLease, 2)).toMatchObject({ command: "continue" });
      expect(
        f.read((database) =>
          database
            .prepare("SELECT result_digest FROM validation_job_results WHERE job_id = ?")
            .get(resultLease.job.jobId),
        ),
      ).toMatchObject({ result_digest: sent.resultDigest });
      await denied(
        reader.request("getDashboardReviewRunJobResult", resultQuery(f, resultLease)),
        "PLATFORM_NOT_FOUND",
      );
    },
    60_000,
  );
});
