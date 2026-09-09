import type { OperatorPrincipal } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { bindOperatorDatabase } from "../../dist/database/operator-database.js";
import { canonicalJson, sha256 } from "../../dist/scheduling/canonical-json.js";
import {
  completion,
  createEvidenceControlPlaneFixture,
  type EvidenceControlPlaneFixture,
  present,
} from "./evidence-control-plane.testing.js";

const administrator = {
  issuer: "https://notification-owner.example.test",
  subject: "administrator",
};
const reader = { issuer: administrator.issuer, subject: "reader-a" };
const other = { issuer: administrator.issuer, subject: "reader-b" };
const fixtures: EvidenceControlPlaneFixture[] = [];
const bound = (f: EvidenceControlPlaneFixture, actor: OperatorPrincipal = reader) =>
  bindOperatorDatabase(f.client, actor);
const inbox = (f: EvidenceControlPlaneFixture, actor: OperatorPrincipal = reader) =>
  bound(f, actor).request("listRepositoryNotifications", {
    repositoryId: f.run.repositoryId,
    actor,
    query: {},
  });
const summary = (f: EvidenceControlPlaneFixture, actor: OperatorPrincipal = reader) =>
  bound(f, actor).request("getNotificationSummary", { repositoryId: f.run.repositoryId, actor });

afterEach(async () => {
  const results = await Promise.allSettled(fixtures.splice(0).map((f) => f.dispose()));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      "Notification owner cleanup failed.",
    );
});
async function grant(
  f: EvidenceControlPlaneFixture,
  actor: OperatorPrincipal,
  version = 0,
  role: "viewer" | null = "viewer",
) {
  return bound(f, administrator).request("changeRepositoryAccess", {
    repositoryId: f.run.repositoryId,
    actor: administrator,
    request: {
      changeId: `notification-access-${actor.subject}-${version}`,
      principal: actor,
      expectedVersion: version,
      role,
      reason: "Exercise synthetic personal notification access.",
    },
  });
}
async function fixture() {
  const f = await createEvidenceControlPlaneFixture(1, [administrator]);
  fixtures.push(f);
  await grant(f, reader);
  await grant(f, other);
  return f;
}
async function completeFailedChecks(f: EvidenceControlPlaneFixture) {
  const envelope = present((await f.claimAll())[0]);
  const input = completion(envelope, []);
  input.result.report.summary = "PRIVATE_REPORT_TEXT_MUST_NOT_ENTER_NOTIFICATIONS";
  const check = present(input.result.report.checks[0]);
  check.outcome = "failed";
  check.summary = "A synthetic required compile check failed; no compiler process was executed.";
  check.actual = "Exit code 1";
  const diagnostic = present(input.result.execution.diagnostics[0]);
  diagnostic.outcome = "failed";
  diagnostic.exitCode = 1;
  diagnostic.summary = check.summary;
  input.resultDigest = sha256(canonicalJson(input.result));
  expect(await f.client.request("completeLease", input)).toMatchObject({ runState: "succeeded" });
  return { envelope, input };
}

describe.skipIf(process.platform !== "linux")(
  "notifications through the real database owner",
  () => {
    it("records measured failed checks in a succeeded completion and deduplicates terminal replay", async () => {
      const f = await fixture();
      expect((await inbox(f)).items).toEqual([]);
      const { envelope, input } = await completeFailedChecks(f);
      const first = await inbox(f);
      expect(first.items).toHaveLength(1);
      const item = present(first.items[0]);
      expect(item.event).toMatchObject({
        kind: "validation",
        sourceId: envelope.job.jobId,
        jobId: envelope.job.jobId,
        reviewRunId: f.run.id,
        requestId: envelope.validation.requestId,
        jobActivation: 1,
        jobStatus: "succeeded",
        result: { checks: { total: 1, passed: 0, failed: 1 }, requiredNonPassed: 1 },
      });
      expect(JSON.stringify(first)).not.toContain("PRIVATE_REPORT_TEXT");
      expect(item.state).toMatchObject({ state: "unread", version: 0 });
    expect(await f.client.request("completeLease", input)).toEqual({
      jobId: input.jobId,
      runAttemptId: input.runAttemptId,
      jobState: "succeeded",
      runState: "succeeded",
      });
      expect((await inbox(f)).items).toEqual(first.items);
      expect(await summary(f)).toMatchObject({ unreadCount: 1, capped: false });
    }, 30_000);

    it("preserves source events and independent personal receipts across an owner process restart", async () => {
      const f = await fixture();
      await completeFailedChecks(f);
      const event = present((await inbox(f)).items[0]).event;
      const request = {
        changeId: "personal-state-recovery",
        changes: [{ notificationId: event.id, expectedVersion: 0, state: "read" as const }],
      };
      const input = { repositoryId: f.run.repositoryId, actor: reader, request };
      const receipt = await bound(f).request("changeNotificationStates", input);
      expect(await summary(f)).toMatchObject({ unreadCount: 0 });
      expect(await summary(f, other)).toMatchObject({ unreadCount: 1 });
      await f.restart();
      expect(await bound(f).request("changeNotificationStates", input)).toEqual({
        ...receipt,
        replayed: true,
      });
      expect(present((await inbox(f)).items[0]).event).toEqual(event);
      expect(present((await inbox(f)).items[0]).state).toEqual(receipt.changes[0]?.state);
      expect(present((await inbox(f, other)).items[0]).state).toMatchObject({
        state: "unread",
        version: 0,
      });
      await grant(f, reader, 1, null);
      await expect(bound(f).request("changeNotificationStates", input)).rejects.toMatchObject({
        code: "PLATFORM_NOT_FOUND",
      });
      await expect(summary(f)).rejects.toMatchObject({ code: "PLATFORM_NOT_FOUND" });
    }, 30_000);

    it("records an actual terminal lease failure without inventing a validation report", async () => {
      const f = await fixture();
      const envelope = present((await f.claimAll())[0]);
      await f.client.request("failLease", {
        ...envelope.lease,
        failureCode: "SYNTHETIC_NOTIFICATION_FAILURE",
        failureMessage: "PRIVATE_FAILURE_TEXT_MUST_NOT_ENTER_NOTIFICATIONS",
        retryable: false,
        retryDelaySeconds: 0,
      });
      const value = await inbox(f);
      expect(value.items).toHaveLength(1);
      expect(present(value.items[0]).event).toMatchObject({
        kind: "validation",
        jobId: envelope.job.jobId,
      jobStatus: "failed",
        result: null,
      });
      expect(JSON.stringify(value)).not.toContain("PRIVATE_FAILURE_TEXT");
    }, 30_000);

    it("records queued cancellation without adding an execution attempt", async () => {
      const f = await fixture();
      const link = present(
        f.read((db) =>
          db
            .prepare("SELECT request_id, job_id FROM review_run_job_links WHERE review_run_id = ?")
            .get(f.run.id),
        ),
      ) as { request_id: string; job_id: string };
      const input = {
        ...f.query,
        requestId: link.request_id,
        jobId: link.job_id,
        actor: administrator,
      };
      await bound(f, administrator).request("cancelValidationJob", input);
      const value = await inbox(f);
      expect(value.items).toHaveLength(1);
      expect(present(value.items[0]).event).toMatchObject({
        jobId: link.job_id,
        jobStatus: "cancelled",
        runAttemptId: null,
        result: null,
      });
      expect(
        f.read((db) =>
          db
            .prepare("SELECT COUNT(*) AS count FROM run_attempts WHERE job_id = ?")
            .get(link.job_id),
        ),
      ).toMatchObject({ count: 0 });
      await bound(f, administrator).request("cancelValidationJob", input);
      expect((await inbox(f)).items).toEqual(value.items);
    }, 30_000);

    it("records ingestion staleness for an unclaimed validation job", async () => {
      const f = await fixture();
      await f.closeSource();
      const value = await inbox(f);
      expect(value.items).toHaveLength(1);
      expect(present(value.items[0]).event).toMatchObject({
        kind: "validation",
        jobStatus: "stale",
        runAttemptId: null,
        result: null,
      });
    }, 30_000);

    it("keeps maintenance internal and refuses actor substitution before personal state work", async () => {
      const f = await fixture();
      await completeFailedChecks(f);
      const event = present((await inbox(f)).items[0]).event;
      await expect(
        f.client.request("operatorRequest", {
          context: { kind: "operator", actor: administrator },
          operation: "maintainNotifications",
          input: { limit: 128 },
        }),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
      await expect(
        f.client.request("operatorRequest", {
          context: { kind: "operator", actor: reader },
          operation: "changeNotificationStates",
          input: {
            repositoryId: f.run.repositoryId,
            actor: other,
            request: {
              changeId: "forged-actor",
              changes: [{ notificationId: event.id, expectedVersion: 0, state: "read" }],
            },
          },
        }),
      ).rejects.toMatchObject({ code: "PLATFORM_FORBIDDEN" });
      expect(await summary(f)).toMatchObject({ unreadCount: 1 });
      expect(await summary(f, other)).toMatchObject({ unreadCount: 1 });
    }, 30_000);
  },
);
