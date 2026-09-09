import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../../dist/scheduling/canonical-json.js";
import {
  completion,
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
  present,
  resultQuery,
  uploadEvidence,
} from "./evidence-control-plane.testing.js";

const fixtures: EvidenceControlPlaneFixture[] = [];
async function fixture(profileCount = 2) {
  const created = await createEvidenceControlPlaneFixture(profileCount);
  fixtures.push(created);
  return created;
}
afterEach(async () => {
  const outcomes = await Promise.allSettled(fixtures.splice(0).map((item) => item.dispose()));
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Evidence integration cleanup failed.",
    );
});

function persistedCount(f: EvidenceControlPlaneFixture): number {
  return f.read(
    (reader) =>
      (
        reader.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get() as {
          count: number;
        }
      ).count,
  );
}
function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

// These fixtures use the compiled DatabaseClient and its fixed production verification Worker.
// Relative response ordering demonstrates independent message dispatch without timing thresholds.
const linuxDescribe = describe.skipIf(process.platform !== "linux");
linuxDescribe("evidence control plane through real database and verification Workers", () => {
  it("processes ping and a lease heartbeat before a large finalization finishes", async () => {
    const f = await fixture(1);
    const envelope = present((await f.claimAll())[0]);
    const assetId = await uploadEvidence(f, envelope, "large-upload", 8 * 1024 * 1024, false);
    const order: string[] = [];
    const finalized = f.client
      .request("finalizeEvidenceUpload", { lease: envelope.lease, assetId })
      .then((value) => {
        order.push("finalized");
        return value;
      });
    const ping = f.client.request("ping", {}).then((value) => {
      order.push("ping");
      return value;
    });
    const heartbeat = f.heartbeat(envelope).then((value) => {
      order.push("heartbeat");
      return value;
    });
    await ping;
    expect(await heartbeat).toMatchObject({ command: "continue" });
    expect(order).not.toContain("finalized");
    expect(await finalized).toMatchObject({ id: assetId, state: "finalized" });
    expect(order.indexOf("ping")).toBeLessThan(order.indexOf("finalized"));
    expect(order.indexOf("heartbeat")).toBeLessThan(order.indexOf("finalized"));
  }, 30_000);

  it("keeps heartbeats and cancellation responsive during multi-asset completion and cold run reads", async () => {
    const f = await fixture();
    const [completed, active] = await f.claimAll();
    const resultLease = present(completed);
    const activeLease = present(active);
    const assetIds: string[] = [];
    for (let index = 0; index < 4; index += 1)
      assetIds.push(await uploadEvidence(f, resultLease, `multi-asset-${index}`, 8 * 1024 * 1024));
    await f.restart();
    const order: string[] = [];
    const sent = completion(resultLease, assetIds);
    const writing = f.client.request("completeLease", sent).then((value) => {
      order.push("completed");
      return value;
    });
    const heartbeat = f.heartbeat(activeLease).then((value) => {
      order.push("heartbeat");
      return value;
    });
    const ping = f.client.request("ping", {}).then((value) => {
      order.push("ping");
      return value;
    });
    expect(await heartbeat).toMatchObject({ command: "continue" });
    await ping;
    expect(order).not.toContain("completed");
    expect(await writing).toMatchObject({ jobState: "succeeded", runState: "succeeded" });
    expect(persistedCount(f)).toBe(1);

    // Restart drops the real verifier cache while preserving both the result and the other lease.
    await f.restart();
    const cold = present(await f.client.request("getDashboardReviewRun", f.query));
    const summary = present(
      cold.requests.find((request) => request.requestId === resultLease.validation.requestId),
    ).latestResult;
    expect(summary).toMatchObject({
      evidenceComplete: false,
      evidenceVerificationPending: true,
      checks: { passed: 1 },
    });
    expect(cold.execution).toMatchObject({ succeeded: 1, active: 1 });
    expect(cold.policy.eligible).toBe(false);
    const concurrentHeartbeat = f.heartbeat(activeLease, 2);
    const concurrentPing = f.client.request("ping", {});
    const cancellation = f.cancel(activeLease);
    const coldResult = f.client.request(
      "getDashboardReviewRunJobResult",
      resultQuery(f, resultLease),
    );
    expect(await concurrentHeartbeat).toMatchObject({ command: "continue" });
    await concurrentPing;
    expect(await cancellation).toMatchObject({ changed: true, jobState: "cancel_requested" });
    const pendingResult = present(await coldResult);
    expect(pendingResult).toMatchObject({
      evidenceComplete: false,
      evidenceVerificationPending: true,
      resultDigest: sent.resultDigest,
    });
    expect(pendingResult.report.checks[0]?.outcome).toBe("passed");
    expect(
      f.read((reader) =>
        reader
          .prepare("SELECT status, current_run_attempt_id FROM jobs WHERE id = ?")
          .get(activeLease.job.jobId),
      ),
    ).toMatchObject({
      status: "cancel_requested",
      current_run_attempt_id: activeLease.lease.runAttemptId,
    });
    await expect
      .poll(
        async () => {
          const result = await f.client.request(
            "getDashboardReviewRunJobResult",
            resultQuery(f, resultLease),
          );
          return result?.evidenceComplete;
        },
        { timeout: 15_000, interval: 50 },
      )
      .toBe(true);
    expect(persistedCount(f)).toBe(1);
  }, 60_000);

  it("replays an immutable terminal result after the real evidence file is deleted", async () => {
    const f = await fixture(1);
    const envelope = present((await f.claimAll())[0]);
    const assetId = await uploadEvidence(f, envelope, "terminal-replay", 1024);
    const sent = completion(envelope, [assetId]);
    const original = await f.client.request("completeLease", sent);
    await f.closeOwner();
    await unlink(join(f.evidenceDirectory, `${assetId}.asset`));
    await f.restart();
    expect(await f.client.request("completeLease", sent)).toEqual(original);
    expect(persistedCount(f)).toBe(1);
    const cold = present(
      await f.client.request("getDashboardReviewRunJobResult", resultQuery(f, envelope)),
    );
    expect(cold.resultDigest).toBe(sent.resultDigest);
    expect(cold.evidenceComplete).toBe(false);
    expect(cold.report.checks[0]?.outcome).toBe("passed");
  }, 30_000);

  it.each(["operator_cancel", "source_closure", "worker_supersession"] as const)(
    "does not commit a completion when %s is processed during its preflight",
    async (change) => {
      const f = await fixture(1);
      const envelope = present((await f.claimAll())[0]);
      const assetId = await uploadEvidence(f, envelope, "preflight-change", 1024 * 1024);
      await f.restart();
      const order: string[] = [];
      const pending = settled(
        f.client.request("completeLease", completion(envelope, [assetId])),
      ).then((value) => {
        order.push("completion");
        return value;
      });
      const mutation = (
        change === "operator_cancel"
          ? f.cancel(envelope)
          : change === "source_closure"
            ? f.closeSource()
            : f.supersedeWorker()
      ).then((value) => {
        order.push("mutation");
        return value;
      });
      const changed = await mutation;
      if (change === "operator_cancel")
        expect(changed).toMatchObject({ jobState: "cancel_requested" });
      if (change === "source_closure")
        expect(changed).toMatchObject({ cancelRequestedJobCount: 1 });
      const outcome = await pending;
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected")
        throw new Error("A revoked completion unexpectedly committed.");
      expect(outcome.reason).toEqual(
        expect.objectContaining({
          code: expect.stringMatching(/^(?:LEASE_LOST|EVIDENCE_LEASE_REJECTED)$/u),
        }),
      );
      expect(order.indexOf("mutation")).toBeLessThan(order.indexOf("completion"));
      expect(persistedCount(f)).toBe(0);
      expect(
        f.read((reader) =>
          reader
            .prepare("SELECT result_digest FROM run_attempts WHERE id = ?")
            .get(envelope.lease.runAttemptId),
        ),
      ).toMatchObject({ result_digest: null });
      await f.client.request("ping", {});
    },
    30_000,
  );

  it("drains simultaneous completion and finalization before confirming database shutdown", async () => {
    const f = await fixture();
    const [first, second] = await f.claimAll();
    const completeLease = present(first);
    const finalizeLease = present(second);
    const finalizedId = await uploadEvidence(f, completeLease, "shutdown-finalized", 1024 * 1024);
    const uploadingId = await uploadEvidence(
      f,
      finalizeLease,
      "shutdown-uploading",
      1024 * 1024,
      false,
    );
    await f.restart();
    const order: string[] = [];
    const completing = settled(
      f.client.request("completeLease", completion(completeLease, [finalizedId])),
    ).then((value) => {
      order.push("completion");
      return value;
    });
    const finalizing = settled(
      f.client.request("finalizeEvidenceUpload", {
        lease: finalizeLease.lease,
        assetId: uploadingId,
      }),
    ).then((value) => {
      order.push("finalization");
      return value;
    });
    const ping = f.client.request("ping", {});
    const closing = f.closeOwner().then(() => {
      order.push("closed");
    });
    await ping;
    const outcomes = await Promise.all([completing, finalizing]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected")
        throw new Error("Shutdown admitted a pending evidence mutation.");
      expect(outcome.reason).toEqual(
        expect.objectContaining({
          code: expect.stringMatching(
            /^(?:EVIDENCE_VERIFIER_SHUTDOWN|DATABASE_WORKER_SHUTTING_DOWN)$/u,
          ),
        }),
      );
    }
    await closing;
    expect(order.at(-1)).toBe("closed");
    expect(persistedCount(f)).toBe(0);
    expect(
      f.read((reader) =>
        reader.prepare("SELECT state FROM evidence_assets WHERE id = ?").get(uploadingId),
      ),
    ).toMatchObject({ state: "uploading" });
    expect(f.read((reader) => reader.prepare("PRAGMA integrity_check").get())).toMatchObject({
      integrity_check: "ok",
    });
  }, 30_000);

  it.each(["same_digest", "different_digest"] as const)(
    "preserves terminal idempotency for concurrent %s submissions",
    async (mode) => {
      const f = await fixture(1);
      const envelope = present((await f.claimAll())[0]);
      const assetId = await uploadEvidence(f, envelope, "concurrent-result", 1024 * 1024);
      await f.restart();
      const first = completion(envelope, [assetId]);
      const second = structuredClone(first);
      if (mode === "different_digest") {
        second.result.report.summary = "A different valid report for the same attempt.";
        second.resultDigest = sha256(canonicalJson(second.result));
      }
      const outcomes = await Promise.all([
        settled(f.client.request("completeLease", first)),
        settled(f.client.request("completeLease", second)),
      ]);
      if (mode === "same_digest") {
        expect(outcomes[0]).toMatchObject({
          status: "fulfilled",
          value: { jobState: "succeeded", runState: "succeeded" },
        });
        expect(outcomes[1]).toEqual(outcomes[0]);
      } else {
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        const rejected = present(outcomes.find((outcome) => outcome.status === "rejected"));
        expect(rejected).toMatchObject({
          status: "rejected",
          reason: { code: "TERMINAL_SUBMISSION_CONFLICT" },
        });
      }
      expect(persistedCount(f)).toBe(1);
      const stored = f.read((reader) =>
        reader
          .prepare("SELECT result_digest FROM validation_job_results WHERE run_attempt_id = ?")
          .get(envelope.lease.runAttemptId),
      ) as { result_digest: string };
      expect([first.resultDigest, second.resultDigest]).toContain(stored.result_digest);
    },
    30_000,
  );

  it("deduplicates matching finalizations without sharing authority with different lease credentials", async () => {
    const f = await fixture(1);
    const envelope = present((await f.claimAll())[0]);
    const assetId = await uploadEvidence(f, envelope, "concurrent-finalize", 1024 * 1024, false);
    const input = { lease: envelope.lease, assetId };
    const first = f.client.request("finalizeEvidenceUpload", input);
    const second = f.client.request("finalizeEvidenceUpload", structuredClone(input));
    const wrongToken = settled(
      f.client.request("finalizeEvidenceUpload", {
        assetId,
        lease: { ...envelope.lease, leaseToken: `${envelope.lease.leaseToken}-invalid` },
      }),
    );
    const wrongGeneration = settled(
      f.client.request("finalizeEvidenceUpload", {
        assetId,
        lease: { ...envelope.lease, leaseGeneration: envelope.lease.leaseGeneration + 1 },
      }),
    );
    const [finalized, replay, rejectedToken, rejectedGeneration] = await Promise.all([
      first,
      second,
      wrongToken,
      wrongGeneration,
    ]);
    expect(finalized).toMatchObject({
      id: assetId,
      state: "finalized",
      jobId: envelope.job.jobId,
      runAttemptId: envelope.lease.runAttemptId,
    });
    expect(replay).toEqual(finalized);
    for (const rejected of [rejectedToken, rejectedGeneration])
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: expect.stringMatching(/^(?:LEASE_LOST|EVIDENCE_LEASE_REJECTED)$/u) },
      });
    expect(
      f.read((reader) =>
        reader
          .prepare(
            "SELECT COUNT(*) AS count FROM evidence_assets WHERE id = ? AND state = 'finalized'",
          )
          .get(assetId),
      ),
    ).toMatchObject({ count: 1 });
    expect(
      f.read((reader) =>
        reader
          .prepare(
            "SELECT COUNT(*) AS count FROM evidence_asset_audit WHERE asset_id = ? AND action = 'finalized'",
          )
          .get(assetId),
      ),
    ).toMatchObject({ count: 1 });
  }, 30_000);
});
