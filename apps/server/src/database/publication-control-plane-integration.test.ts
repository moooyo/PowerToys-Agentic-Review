import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type {
  OperatorPrincipal,
  OperatorRepositoryRole,
  PublicationConfirmRequest,
  PublicationPreviewV1,
} from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachDatabaseClientForTest,
  type DatabaseClient,
  type DatabaseWorkerTransport,
} from "../../dist/database/database-client.js";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import type { DatabaseWorkerOptions } from "../../dist/database/protocol.js";
import type { PublicationLease } from "../../dist/database/publications.js";
import {
  completion,
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
  present,
  uploadEvidence,
} from "./evidence-control-plane.testing.js";

/** The owner and evidence verifier remain real Workers. This testing-only wrapper pauses a real
 * I/O response before the coordinator issues its single-turn prepared-evidence capability. */
class PublicationEvidenceGate {
  readonly #control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  readonly reads: { repositoryId: string; reviewRunId: string }[] = [];
  #paused: (() => void) | undefined;
  #pause: Promise<void> | undefined;

  arm(): void {
    if (Atomics.load(this.#control, 0) !== 0) throw new Error("An evidence gate is already armed.");
    this.#pause = new Promise((resolve) => {
      this.#paused = resolve;
    });
    Atomics.store(this.#control, 0, 1);
  }

  async waitUntilPaused(): Promise<void> {
    if (!this.#pause) throw new Error("The evidence gate is not armed.");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#pause,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("The real evidence preparation did not reach its test gate.")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  release(): void {
    Atomics.store(this.#control, 0, 0);
    Atomics.notify(this.#control, 0);
  }

  setBusy(value: boolean): void {
    Atomics.store(this.#control, 1, value ? 1 : 0);
  }

  async createClient(options: DatabaseWorkerOptions): Promise<DatabaseClient> {
    const coordinatorUrl = new URL("../../dist/database/evidence-verification.js", import.meta.url)
      .href;
    const ownerUrl = new URL("../../dist/database/database-worker.js", import.meta.url).href;
    const clientUrl = new URL(
      "../../dist/database/evidence-verification-client.js",
      import.meta.url,
    ).href;
    const protocolUrl = new URL(
      "../../dist/database/evidence-verification-protocol.js",
      import.meta.url,
    ).href;
    const source = `
      const { parentPort, workerData } = require("node:worker_threads");
      const control = new Int32Array(workerData.publicationTestControl);
      (async () => {
        const { EvidenceVerificationCoordinator } = await import(${JSON.stringify(coordinatorUrl)});
        const original = EvidenceVerificationCoordinator.prototype.prepareRunReadEvidence;
        EvidenceVerificationCoordinator.prototype.prepareRunReadEvidence = async function(scope, signal) {
          parentPort.postMessage({ publicationTestEvidenceRead: true, repositoryId: scope.repositoryId, reviewRunId: scope.reviewRunId });
          if (Atomics.load(control, 1) === 1) {
            const { EvidenceVerificationError } = await import(${JSON.stringify(protocolUrl)});
            throw new EvidenceVerificationError("EVIDENCE_VERIFIER_BUSY");
          }
          return original.call(this, scope, signal);
        };
        const { EvidenceVerificationClient } = await import(${JSON.stringify(clientUrl)});
        for (const method of ["probeIdentities", "verifyAsset", "verifyScenario"]) {
          const verify = EvidenceVerificationClient.prototype[method];
          EvidenceVerificationClient.prototype[method] = async function(...args) {
            const attestation = await verify.apply(this, args);
            if (Atomics.compareExchange(control, 0, 1, 2) === 1) {
              parentPort.postMessage({ publicationTestEvidencePaused: true });
              while (Atomics.load(control, 0) === 2) await Atomics.waitAsync(control, 0, 2).value;
            }
            return attestation;
          };
        }
        await import(${JSON.stringify(ownerUrl)});
      })().catch(error => { setImmediate(() => { throw error; }); });
    `;
    const worker = new Worker(source, {
      eval: true,
      workerData: { ...options, publicationTestControl: this.#control.buffer },
    });
    const emitter = new EventEmitter();
    worker.on("message", (message: unknown) => {
      if (message && typeof message === "object") {
        const event = message as Record<string, unknown>;
        if (event.publicationTestEvidenceRead === true) {
          this.reads.push({
            repositoryId: String(event.repositoryId),
            reviewRunId: String(event.reviewRunId),
          });
          return;
        }
        if (event.publicationTestEvidencePaused === true) {
          this.#paused?.();
          return;
        }
      }
      emitter.emit("message", message);
    });
    worker.on("error", (error) => emitter.emit("error", error));
    worker.on("exit", (code) => emitter.emit("exit", code));
    const transport = Object.assign(emitter, {
      postMessage: (value: unknown) => worker.postMessage(value),
      terminate: () => worker.terminate(),
    }) as DatabaseWorkerTransport;
    return attachDatabaseClientForTest(transport);
  }
}

const administrator: OperatorPrincipal = {
  issuer: "https://identity.example.test",
  subject: "publication-owner-admin",
};
const operator: OperatorPrincipal = {
  issuer: administrator.issuer,
  subject: "publication-owner-operator",
};
const publisher = { githubUserId: 777 };
const fixtures: { fixture: EvidenceControlPlaneFixture; gate: PublicationEvidenceGate }[] = [];
const bound = (fixture: EvidenceControlPlaneFixture, actor = operator) =>
  bindOperatorDatabase(fixture.client, actor);

afterEach(async () => {
  for (const entry of fixtures) {
    entry.gate.setBusy(false);
    entry.gate.release();
  }
  const results = await Promise.allSettled(
    fixtures.splice(0).map((entry) => entry.fixture.dispose()),
  );
  const errors = results.filter(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected",
  );
  if (errors.length)
    throw new AggregateError(
      errors.map((entry) => entry.reason),
      "Publication owner integration cleanup failed.",
    );
});

function grant(
  fixture: EvidenceControlPlaneFixture,
  role: OperatorRepositoryRole | null,
  version = 0,
  repositoryId = fixture.run.repositoryId,
) {
  return bound(fixture, administrator).request("changeRepositoryAccess", {
    repositoryId,
    actor: administrator,
    request: {
      changeId: `access-${repositoryId}-${version}`,
      principal: operator,
      role,
      expectedVersion: version,
      reason: "Exercise isolated publication owner authorization.",
    },
  });
}

async function fixture(availablePublisher = true) {
  const gate = new PublicationEvidenceGate();
  const f = await createEvidenceControlPlaneFixture(1, [administrator], {
    ...(availablePublisher ? { publicationPublisher: publisher } : {}),
    createClient: (options) => gate.createClient(options),
  });
  fixtures.push({ fixture: f, gate });
  await grant(f, "maintainer");
  const envelope = present((await f.claimAll())[0]);
  const assetId = await uploadEvidence(f, envelope, "publication-owner-evidence", 4096);
  expect(await f.client.request("completeLease", completion(envelope, [assetId]))).toMatchObject({
    runState: "succeeded",
  });
  const access = bound(f);
  await access.request("updateRepositoryPublicationPolicy", {
    repositoryId: f.run.repositoryId,
    actor: operator,
    changeId: "enable-publication",
    expectedVersion: 0,
    enabled: true,
  });
  const current = await access.request("getReviewRunDecisionContext", {
    ...f.query,
    actor: operator,
  });
  const decision = (
    await access.request("changeReviewRunDecision", {
      ...f.query,
      actor: operator,
      changeId: "selected-comment",
      action: "comment",
      expectedVersion: current.version,
      expectedRevisionKey: current.revisionKey,
      expectedPlanDigest: current.planDigest,
      expectedResultSetDigest: current.resultSetDigest,
      reason: "Publish the exact isolated validation result after a separate preview.",
    })
  ).change;
  const preview = () =>
    bound(f).request("getPublicationPreview", {
      ...f.query,
      actor: operator,
      decisionId: decision.id,
    });
  let candidate = await preview();
  if (candidate.blockers.includes("evidence_unavailable")) {
    await expect
      .poll(
        async () => {
          candidate = await preview();
          return candidate.blockers.includes("evidence_unavailable");
        },
        { timeout: 3000 },
      )
      .toBe(false);
  }
  return { f, gate, decision, preview, candidate, envelope };
}

function confirmation(
  candidate: PublicationPreviewV1,
  changeId = "confirm-publication",
): PublicationConfirmRequest {
  return {
    changeId,
    publicationId: candidate.publicationId,
    rendererVersion: candidate.rendererVersion,
    expectedSelectedDecisionId: candidate.binding.selectedDecisionId,
    expectedSelectedDecisionVersion: candidate.binding.selectedDecisionVersion,
    expectedDecisionContextVersion: candidate.binding.decisionContextVersion,
    expectedPolicyVersion: candidate.policyVersion,
    expectedPublisherGitHubUserId: candidate.publisherGitHubUserId ?? publisher.githubUserId,
    expectedRevisionKey: candidate.binding.revisionKey,
    expectedPlanDigest: candidate.binding.planDigest,
    expectedResultSetDigest: candidate.binding.resultSetDigest,
    expectedPayloadSha256: present(candidate.payloadSha256),
  };
}
const confirm = (f: EvidenceControlPlaneFixture, input: PublicationConfirmRequest) =>
  bound(f).request("confirmPublication", { ...f.query, actor: operator, ...input });
const leaseKey = (lease: PublicationLease) => ({
  publicationId: lease.publication.intent.publicationId,
  ownerId: lease.ownerId,
  fence: lease.fence,
});
const read = (f: EvidenceControlPlaneFixture, publicationId: string) =>
  bound(f, administrator).request("getPublication", {
    repositoryId: f.run.repositoryId,
    publicationId,
    actor: administrator,
  });
const count = (
  f: EvidenceControlPlaneFixture,
  table: "publication_intents" | "publication_attempt_events",
) =>
  f.read(
    (db) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  );
const observed = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

const linuxDescribe = describe.skipIf(process.platform !== "linux");
linuxDescribe("publication control plane through the real owner and evidence workers", () => {
  it("denies every internal publication RPC through the operator envelope and rejects actor forgery", async () => {
    const { f } = await fixture();
    for (const operation of [
      "claimPublicationDelivery",
      "claimPublicationReconciliation",
      "renewPublicationLease",
      "beginPublicationSend",
      "completePublicationDelivery",
      "completePublicationReconciliation",
      "recoverExpiredPublications",
    ]) {
      await expect(
        f.client.request("operatorRequest", {
          context: { kind: "operator", actor: administrator },
          operation,
          input: {},
        }),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
    }
    await expect(
      f.client.request("operatorRequest", {
        context: { kind: "operator", actor: operator },
        operation: "updateRepositoryPublicationPolicy",
        input: {
          repositoryId: f.run.repositoryId,
          actor: administrator,
          changeId: "forged-policy",
          expectedVersion: 1,
          enabled: false,
        },
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
    expect(count(f, "publication_intents")).toBe(0);
  }, 30_000);

  it("does not acquire publication capability without configured runtime publisher identity", async () => {
    const { f, candidate } = await fixture(false);
    expect(candidate).toMatchObject({
      canConfirm: false,
      publisherAvailability: "unavailable",
      publisherGitHubUserId: null,
    });
    await expect(confirm(f, confirmation(candidate))).rejects.toMatchObject({
      code: "PLATFORM_CONFLICT",
    });
    expect(
      await f.client.request("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 30_000,
      }),
    ).toBeNull();
    expect(count(f, "publication_intents")).toBe(0);
  }, 30_000);

  it("serializes duplicate confirmation receipts and refuses another change ID for the same logical publication", async () => {
    const { f, gate, candidate } = await fixture();
    const input = confirmation(candidate);
    const accepted = await Promise.all([confirm(f, input), confirm(f, input)]);
    expect(accepted.map((item) => item.replayed).sort()).toEqual([false, true]);
    expect(accepted[0]?.intent).toEqual(accepted[1]?.intent);
    await expect(
      confirm(f, { ...input, changeId: "duplicate-logical-publication" }),
    ).rejects.toMatchObject({ code: "PLATFORM_CONFLICT" });
    expect(count(f, "publication_intents")).toBe(1);
    gate.setBusy(true);
    const before = gate.reads.length;
    expect(await confirm(f, input)).toMatchObject({ replayed: true });
    expect(gate.reads.length).toBe(before);
    await grant(f, null, 1);
    await expect(confirm(f, input)).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
    expect(gate.reads.length).toBe(before);
  }, 30_000);

  it("rejects foreign repository retry before preparing that publication's evidence", async () => {
    const { f, gate, candidate } = await fixture();
    const intent = (await confirm(f, confirmation(candidate))).intent;
    const other = await bound(f, administrator).request("createManagedRepository", {
      actor: administrator,
      request: { githubRepositoryId: 2, fullName: "example/project-2" },
    });
    await grant(f, "maintainer", 0, other.id);
    gate.setBusy(true);
    const before = gate.reads.length;
    await expect(
      bound(f).request("retryPublication", {
        repositoryId: other.id,
        publicationId: intent.publicationId,
        actor: operator,
        changeId: "foreign-retry",
        expectedVersion: 1,
        expectedPayloadSha256: intent.payloadSha256,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
    expect(gate.reads.length).toBe(before);
    expect(count(f, "publication_attempt_events")).toBe(0);
  }, 30_000);

  it.each(["revoke", "source"] as const)(
    "does not confirm when %s changes after real evidence preparation",
    async (mutation) => {
      const { f, gate, candidate } = await fixture();
      gate.arm();
      const pending = observed(confirm(f, confirmation(candidate)));
      await gate.waitUntilPaused();
      await f.client.request("ping", {});
      if (mutation === "revoke") await grant(f, null, 1);
      else await f.closeSource();
      gate.release();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("A stale publication confirmation was accepted.");
      expect(outcome.error).toMatchObject({
        code: mutation === "revoke" ? "PLATFORM_NOT_FOUND" : "PLATFORM_CONFLICT",
      });
      expect(count(f, "publication_intents")).toBe(0);
    },
    30_000,
  );

  it.each(["revoke", "source"] as const)(
    "does not cross the send boundary when %s changes during evidence preparation",
    async (mutation) => {
      const { f, gate, candidate } = await fixture();
      const intent = (await confirm(f, confirmation(candidate))).intent;
      const lease = present(
        await f.client.request("claimPublicationDelivery", {
          ownerId: "publisher",
          leaseDurationMs: 30_000,
        }),
      );
      gate.arm();
      const pending = observed(
        f.client.request("beginPublicationSend", {
          ...leaseKey(lease),
          expectedPayloadSha256: intent.payloadSha256,
        }),
      );
      await gate.waitUntilPaused();
      if (mutation === "revoke") await grant(f, null, 1);
      else await f.closeSource();
      gate.release();
      const outcome = await pending;
      expect(outcome).toMatchObject({ ok: true, value: null });
      const publication = await read(f, intent.publicationId);
      expect(publication.delivery).toMatchObject({
        status: "blocked",
        failure: { code: mutation === "revoke" ? "authorization_changed" : "source_changed" },
      });
      const attempts = await bound(f, administrator).request("listPublicationAttempts", {
        repositoryId: f.run.repositoryId,
        publicationId: intent.publicationId,
        actor: administrator,
      });
      expect(attempts.items.some((item) => item.phase === "sending")).toBe(false);
    },
    30_000,
  );

  it("rejects a lease that expires while prepared evidence is paused", async () => {
    const { f, gate, candidate } = await fixture();
    const intent = (await confirm(f, confirmation(candidate))).intent;
    const lease = present(
      await f.client.request("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 1000,
      }),
    );
    gate.arm();
    const pending = observed(
      f.client.request("beginPublicationSend", {
        ...leaseKey(lease),
        expectedPayloadSha256: intent.payloadSha256,
      }),
    );
    await gate.waitUntilPaused();
    await delay(1100);
    gate.release();
    expect(await pending).toMatchObject({ ok: true, value: null });
    await f.client.request("recoverExpiredPublications", {});
    expect((await read(f, intent.publicationId)).delivery.status).toBe("failed");
  }, 30_000);

  it("preserves unknown after sending expiry and rejects stale completion fences", async () => {
    const { f, candidate } = await fixture();
    const intent = (await confirm(f, confirmation(candidate))).intent;
    const lease = present(
      await f.client.request("claimPublicationDelivery", {
        ownerId: "publisher",
        leaseDurationMs: 1000,
      }),
    );
    expect(
      await f.client.request("beginPublicationSend", {
        ...leaseKey(lease),
        expectedPayloadSha256: intent.payloadSha256,
      }),
    ).not.toBeNull();
    await delay(1100);
    await f.client.request("recoverExpiredPublications", {});
    expect((await read(f, intent.publicationId)).delivery.status).toBe("unknown");
    await expect(
      f.client.request("completePublicationDelivery", {
        ...leaseKey(lease),
        outcome: "unknown",
        failure: {
          code: "ambiguous_delivery",
          message: "A late response cannot regain ownership.",
        },
        remoteReceipt: null,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_CONFLICT" });
    expect(
      await f.client.request("claimPublicationDelivery", {
        ownerId: "publisher-next",
        leaseDurationMs: 30_000,
      }),
    ).toBeNull();
  }, 30_000);

  it.each(["stale_fence", "revoked", "disabled"] as const)(
    "handles %s before an unavailable evidence verifier can run",
    async (condition) => {
      const { f, gate, candidate } = await fixture();
      const intent = (await confirm(f, confirmation(candidate))).intent;
      const lease = present(
        await f.client.request("claimPublicationDelivery", {
          ownerId: "publisher",
          leaseDurationMs: 30_000,
        }),
      );
      if (condition === "revoked") await grant(f, null, 1);
      if (condition === "disabled")
        await bound(f, administrator).request("updateRepositoryPublicationPolicy", {
          repositoryId: f.run.repositoryId,
          actor: administrator,
          changeId: "disable-before-send",
          expectedVersion: 1,
          enabled: false,
        });
      gate.setBusy(true);
      const before = gate.reads.length;
      const key = leaseKey(lease);
      if (condition === "stale_fence") key.fence += 1;
      expect(
        await f.client.request("beginPublicationSend", {
          ...key,
          expectedPayloadSha256: intent.payloadSha256,
        }),
      ).toBeNull();
      expect(gate.reads.length).toBe(before);
      expect((await read(f, intent.publicationId)).delivery.status).toBe(
        condition === "stale_fence" ? "delivering" : "blocked",
      );
    },
    30_000,
  );
});
