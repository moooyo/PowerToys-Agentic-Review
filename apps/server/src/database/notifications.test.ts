import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { NotificationState, OperatorPrincipal } from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations.js";
import {
  handleNotificationRequest,
  type NotificationOperation,
  type NotificationOperationMap,
  type NotificationRequest,
} from "./notifications.js";

const migrationUrl = new URL("../../../../migrations/0027_notifications.sql", import.meta.url);
const initial = "2026-09-07T10:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "reader-a" };
const other = { ...actor, subject: "reader-b" };
const administrator = { ...actor, subject: "administrator" };
const databases: DatabaseSync[] = [];
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("The notification fixture is incomplete.");
  return value;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

// A focused SQL fixture isolates this migration's triggers and accounting. A separate test
// below applies the full production migration chain; owner integration covers real completions.
function fixture(install = true) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let now = initial;
  db.function("strftime", { varargs: true }, (format) => {
    if (format === "%Y-%m-%dT%H:%M:%fZ") return now;
    if (format === "%Y-%m-%dT00:00:00.000Z") return `${now.slice(0, 10)}T00:00:00.000Z`;
    if (format === "%Y-%m-%d") return now.slice(0, 10);
    throw new Error("The notification fixture received an unexpected clock format.");
  });
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE managed_repositories(id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
    CREATE TABLE work_items(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, UNIQUE(id, repository_id));
    CREATE TABLE review_runs(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, work_item_id TEXT NOT NULL, revision_key TEXT NOT NULL, plan_json TEXT NOT NULL);
    CREATE TABLE review_run_requests(review_run_id TEXT NOT NULL, request_id TEXT NOT NULL, workflow_kind TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(review_run_id, request_id));
    CREATE TABLE jobs(id TEXT PRIMARY KEY, status TEXT NOT NULL, current_run_attempt_id TEXT, completed_at TEXT, updated_at TEXT NOT NULL, attempt_count INTEGER NOT NULL);
    CREATE TABLE run_attempts(id TEXT PRIMARY KEY);
    CREATE TABLE review_run_job_links(review_run_id TEXT NOT NULL, request_id TEXT NOT NULL, activation_number INTEGER NOT NULL, job_id TEXT NOT NULL UNIQUE, PRIMARY KEY(review_run_id, request_id, activation_number));
    CREATE TABLE validation_job_results(id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, run_attempt_id TEXT NOT NULL, result_json TEXT NOT NULL, evidence_complete INTEGER NOT NULL);
    CREATE TABLE publication_intents(publication_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, review_run_id TEXT NOT NULL, intent_json TEXT NOT NULL);
    CREATE TABLE publication_attempt_events(id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, repository_id TEXT NOT NULL, receipt_json TEXT NOT NULL);
    CREATE TABLE repository_operator_grants(repository_id TEXT NOT NULL, principal_issuer TEXT NOT NULL, principal_subject TEXT NOT NULL, role TEXT, PRIMARY KEY(repository_id, principal_issuer, principal_subject));`);
  for (const repositoryId of ["repo-a", "repo-b"]) {
    const kind = repositoryId === "repo-a" ? "pull_request" : "issue";
    db.prepare("INSERT INTO managed_repositories VALUES (?, ?)").run(
      repositoryId,
      `synthetic/${repositoryId}`,
    );
    db.prepare("INSERT INTO work_items VALUES (?, ?)").run(`item-${repositoryId}`, repositoryId);
    db.prepare("INSERT INTO review_runs VALUES (?, ?, ?, ?, ?)").run(
      `run-${repositoryId}`,
      repositoryId,
      `item-${repositoryId}`,
      "a".repeat(64),
      JSON.stringify({ workItem: { kind, number: 7 } }),
    );
    db.prepare("INSERT INTO review_run_requests VALUES (?, 'request-1', ?, 'headless')").run(
      `run-${repositoryId}`,
      kind === "pull_request" ? "pr_static_build" : "issue_triage",
    );
  }
  function grant(
    principal: OperatorPrincipal,
    repositoryId = "repo-a",
    role: string | null = "viewer",
  ) {
    db.prepare(`INSERT INTO repository_operator_grants VALUES (?, ?, ?, ?)
      ON CONFLICT(repository_id, principal_issuer, principal_subject) DO UPDATE SET role = excluded.role`).run(
      repositoryId,
      principal.issuer,
      principal.subject,
      role,
    );
  }
  grant(actor);
  grant(other);
  function installMigration() {
    db.exec(readFileSync(migrationUrl, "utf8"));
  }
  if (install) installMigration();
  let number = 0;
  const activations = new Map<string, number>();
  function addJob(
    repositoryId = "repo-a",
    status = "failed",
    checks: { outcome: string; required: boolean }[] = [],
    activeAttempt = true,
  ) {
    number++;
    const id = `job-${number}`,
      attemptId = activeAttempt ? `attempt-${number}` : null;
    const activation = (activations.get(repositoryId) ?? 0) + 1;
    activations.set(repositoryId, activation);
    if (attemptId) db.prepare("INSERT INTO run_attempts VALUES (?)").run(attemptId);
    db.prepare("INSERT INTO jobs VALUES (?, ?, ?, NULL, ?, ?)").run(
      id,
      activeAttempt ? "running" : "queued",
      attemptId,
      now,
      activeAttempt ? 1 : 0,
    );
    db.prepare("INSERT INTO review_run_job_links VALUES (?, 'request-1', ?, ?)").run(
      `run-${repositoryId}`,
      activation,
      id,
    );
    if (status === "succeeded")
      db.prepare("INSERT INTO validation_job_results VALUES (?, ?, ?, ?, 1)").run(
        `result-${number}`,
        id,
        attemptId,
        JSON.stringify({
          report: {
            checks,
            sourceState: "original",
            summary: "This body must never enter notifications.",
          },
          execution: {
            blockers: [],
            cleanupState: "completed",
            diagnostics: [{ stdout: "This log must remain private." }],
          },
        }),
      );
    db.prepare(
      "UPDATE jobs SET status = ?, current_run_attempt_id = NULL, completed_at = ?, updated_at = ? WHERE id = ?",
    ).run(status, now, now, id);
    return id;
  }
  function addPublication(
    repositoryId = "repo-a",
    outcome = "unknown",
    phase = "outcome",
    publicationId = `publication-${++number}`,
  ) {
    const kind = repositoryId === "repo-a" ? "pull_request" : "issue";
    db.prepare("INSERT OR IGNORE INTO publication_intents VALUES (?, ?, ?, ?)").run(
      publicationId,
      repositoryId,
      `run-${repositoryId}`,
      JSON.stringify({
        binding: { repositoryId, workItemId: `item-${repositoryId}`, revisionKey: "a".repeat(64) },
        target: { kind, number: 7 },
        payload: { body: "Never copy the upstream body." },
      }),
    );
    const sourceId = `publication-attempt-${++number}`;
    db.prepare("INSERT INTO publication_attempt_events VALUES (?, ?, ?, ?)").run(
      sourceId,
      publicationId,
      repositoryId,
      JSON.stringify({
        phase,
        createdAt: now,
        kind: phase === "outcome" ? "reconciliation" : "delivery",
        attemptNumber: 1,
        outcome: phase === "outcome" ? outcome : null,
        failure:
          outcome === "published"
            ? null
            : { code: "reconciliation_incomplete", message: "Never copy failure messages." },
      }),
    );
    return { sourceId, publicationId };
  }
  function call<K extends NotificationOperation>(
    operation: K,
    input: NotificationOperationMap[K]["input"],
  ): NotificationOperationMap[K]["output"] {
    return handleNotificationRequest(db, { operation, input } as NotificationRequest, now, [
      administrator,
    ]) as NotificationOperationMap[K]["output"];
  }
  function list(principal = actor, repositoryId = "repo-a", query = {}) {
    return call("listRepositoryNotifications", { actor: principal, repositoryId, query });
  }
  function state(
    notificationId: string,
    state: NotificationState,
    expectedVersion = 0,
    principal = actor,
    changeId = `change-${++number}`,
  ) {
    return call("changeNotificationStates", {
      actor: principal,
      repositoryId: "repo-a",
      request: { changeId, changes: [{ notificationId, state, expectedVersion }] },
    });
  }
  return {
    db,
    call,
    list,
    grant,
    addJob,
    addPublication,
    state,
    installMigration,
    setTime(value: string) {
      now = value;
    },
  };
}

describe.skipIf(process.platform !== "linux")("notification persistence", () => {
  it("applies the production migration chain without backfilling source history", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec("PRAGMA foreign_keys = ON");
    expect(
      runMigrations(db, fileURLToPath(new URL("../../../../migrations", import.meta.url))),
    ).toBe(31);
    expect(db.prepare("SELECT COUNT(*) AS total FROM notification_events").get()).toMatchObject({
      total: 0,
    });
    const f = fixture(false);
    f.addJob();
    f.installMigration();
    expect(f.list().items).toEqual([]);
    expect(f.list()).toMatchObject({
      coverageStart: initial,
      retainedAfter: "2026-09-07T00:00:00.000Z",
    });
  });

  it("records completion with failed checks without inventing approval eligibility or copying content", () => {
    const f = fixture();
    const jobId = f.addJob("repo-a", "succeeded", [
      { outcome: "passed", required: true },
      { outcome: "failed", required: true },
      { outcome: "not_run", required: false },
    ]);
    const first = f.list().items[0];
    expect(first).toMatchObject({
      event: {
        kind: "validation",
        jobId,
        jobStatus: "succeeded",
        result: {
          checks: { total: 3, passed: 1, failed: 1, not_run: 1 },
          requiredNonPassed: 1,
          lifecycleBlockers: 0,
          evidenceComplete: true,
        },
      },
      state: { state: "unread", version: 0, updatedAt: null },
    });
    expect(JSON.stringify(first)).not.toMatch(/summary|stdout|approve|eligib|Never copy/);
    expect(f.db.prepare("SELECT summary_json FROM notification_events").get()).not.toEqual(
      expect.objectContaining({ summary_json: expect.stringContaining("This body") }),
    );
    f.db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(jobId);
    expect(f.list().items).toHaveLength(1);
  });

  it.each(["failed", "dead_letter", "cancelled", "stale"])(
    "records %s without requiring a successful attempt",
    (status) => {
      const f = fixture();
      f.addJob("repo-a", status, [], false);
      expect(f.list().items[0]?.event).toMatchObject({
        kind: "validation",
        jobStatus: status,
        runAttemptId: null,
        result: null,
      });
    },
  );

  it("ignores retry/cancel intent states and distinguishes explicit reruns", () => {
    const f = fixture();
    f.addJob("repo-a", "retry_waiting");
    f.addJob("repo-a", "cancel_requested");
    expect(f.list().items).toEqual([]);
    const first = f.addJob(),
      second = f.addJob();
    expect(f.list().items.map((entry) => entry.event.sourceId)).toEqual([second, first]);
    expect(
      f.list().items.map((entry) => entry.event.kind === "validation" && entry.event.jobActivation),
    ).toEqual([4, 3]);
  });

  it("keeps outcome attempts distinct, including repeated unknown reconciliation", () => {
    const f = fixture();
    const start = f.addPublication("repo-a", "unknown", "preflight");
    expect(f.list().items).toEqual([]);
    const first = f.addPublication("repo-a", "unknown", "outcome", start.publicationId);
    const second = f.addPublication("repo-a", "unknown", "outcome", start.publicationId);
    f.addPublication("repo-a", "published", "outcome", start.publicationId);
    expect(f.list().items).toHaveLength(3);
    expect(f.list().items[0]?.event).toMatchObject({
      kind: "publication",
      outcome: "published",
      failureCode: null,
    });
    expect(
      f
        .list()
        .items.slice(1)
        .map((entry) => entry.event.sourceId),
    ).toEqual([second.sourceId, first.sourceId]);
    expect(JSON.stringify(f.list())).not.toContain("Never copy");
  });

  it("scopes overview, capped global summary, and personal state to current repository ACL", () => {
    const f = fixture();
    for (let i = 0; i < 101; i++) f.addJob();
    f.addJob("repo-b");
    expect(f.call("getNotificationSummary", { actor })).toMatchObject({
      unreadCount: 99,
      capped: true,
    });
    const overview = f.call("listNotificationOverview", { actor });
    expect(overview.total).toBe(1);
    expect(overview.items[0]).toMatchObject({
      repositoryId: "repo-a",
      counts: { total: 101, unread: 101, read: 0, archived: 0 },
    });
    expect(f.call("listNotificationOverview", { actor: administrator }).total).toBe(2);
    expect(() => f.list(actor, "repo-b")).toThrowError(
      expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
    );
    const id = present(f.list().items[0]).event.id;
    f.state(id, "read");
    expect(f.list(other).items[0]?.state).toMatchObject({ version: 0, state: "unread" });
    f.state(id, "archived", 1);
    expect(f.call("listNotificationOverview", { actor }).items[0]?.counts).toEqual({
      total: 101,
      unread: 100,
      read: 0,
      archived: 1,
    });
    f.state(id, "unread", 2);
    expect(f.call("listNotificationOverview", { actor }).items[0]?.counts).toEqual({
      total: 101,
      unread: 101,
      read: 0,
      archived: 0,
    });
  });

  it("replays exact receipts only after ACL, and rolls all state/count updates back on a batch conflict", () => {
    const f = fixture();
    f.addJob();
    f.addJob();
    const entries = f.list().items;
    const a = present(entries[0]),
      b = present(entries[1]);
    const request = {
      changeId: "lost-response",
      changes: [{ notificationId: a.event.id, expectedVersion: 0, state: "read" as const }],
    };
    const first = f.call("changeNotificationStates", { actor, repositoryId: "repo-a", request });
    f.state(a.event.id, "archived", 1);
    expect(f.call("changeNotificationStates", { actor, repositoryId: "repo-a", request })).toEqual({
      ...first,
      replayed: true,
    });
    expect(() =>
      f.call("changeNotificationStates", {
        actor,
        repositoryId: "repo-a",
        request: {
          changeId: "atomic-conflict",
          changes: [
            { notificationId: b.event.id, expectedVersion: 0, state: "read" },
            { notificationId: a.event.id, expectedVersion: 0, state: "read" },
          ],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "PLATFORM_CONFLICT" }));
    expect(f.list().items.find((entry) => entry.event.id === b.event.id)?.state.version).toBe(0);
    expect(f.call("listNotificationOverview", { actor }).items[0]?.counts).toEqual({
      total: 2,
      unread: 1,
      read: 0,
      archived: 1,
    });
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) AS total FROM notification_change_receipts WHERE change_id = 'atomic-conflict'",
        )
        .get(),
    ).toMatchObject({ total: 0 });
    f.grant(actor, "repo-a", null);
    expect(() =>
      f.call("changeNotificationStates", { actor, repositoryId: "repo-a", request }),
    ).toThrowError(expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }));
    expect(f.call("getNotificationSummary", { actor })).toMatchObject({ unreadCount: 0 });
  });

  it("bounds sparse unread scans to 256 repository candidates and continues from an empty page", () => {
    const f = fixture();
    for (let i = 0; i < 260; i++) {
      f.addJob();
      if (i % 20 === 0) f.addJob("repo-b");
    }
    const ids = (
      f.db
        .prepare(
          "SELECT id FROM notification_events WHERE repository_id = 'repo-a' AND sequence > 1 ORDER BY sequence",
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
    for (let i = 0; i < ids.length; i += 50)
      f.call("changeNotificationStates", {
        actor,
        repositoryId: "repo-a",
        request: {
          changeId: `batch-${i}`,
          changes: ids
            .slice(i, i + 50)
            .map((id) => ({ notificationId: id, expectedVersion: 0, state: "read" })),
        },
      });
    const first = f.list(actor, "repo-a", { state: "unread" });
    expect(first).toMatchObject({ items: [], scanLimited: true, nextCursor: "5" });
    const next = f.list(actor, "repo-a", { state: "unread", cursor: present(first.nextCursor) });
    expect(next.items).toHaveLength(1);
    expect(next).toMatchObject({ nextCursor: null, scanLimited: false });
    expect(f.list(administrator, "repo-b").items).toHaveLength(13);
  });

  it("expires all visibility atomically before bounded physical cleanup without unread rebounds", () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) f.addJob();
    const old = f.list().items;
    for (const entry of old) f.state(entry.event.id, "read");
    f.setTime("2026-12-10T10:00:00.000Z");
    f.addJob();
    const fresh = present(f.list().items[0]);
    f.state(fresh.event.id, "archived");
    let maintenance = f.call("maintainNotifications", { limit: 1 });
    expect(maintenance).toMatchObject({
      retainedAfter: "2026-09-12T00:00:00.000Z",
      deletedStates: 1,
    });
    expect(() => f.state(present(old[0]).event.id, "unread", 1)).toThrowError(
      expect.objectContaining({ code: "PLATFORM_NOT_FOUND" }),
    );
    let steps = 0;
    do {
      expect(f.call("listNotificationOverview", { actor }).items[0]?.counts).toEqual({
        total: 1,
        unread: 0,
        read: 0,
        archived: 1,
      });
      expect(f.call("getNotificationSummary", { actor })).toMatchObject({
        unreadCount: 0,
        capped: false,
      });
      expect(f.list().items.map((entry) => entry.event.id)).toEqual([fresh.event.id]);
      expect(
        maintenance.deletedStates +
          maintenance.deletedReceipts +
          maintenance.deletedEvents +
          maintenance.deletedCounters,
      ).toBeLessThanOrEqual(1);
      maintenance = f.call("maintainNotifications", { limit: 1 });
      steps++;
      if (steps > 20) throw new Error("Notification cleanup did not finish its bounded phases.");
    } while (maintenance.hasMore);
    expect(f.db.prepare("SELECT COUNT(*) AS total FROM notification_events").get()).toMatchObject({
      total: 1,
    });
    expect(f.db.prepare("SELECT COUNT(*) AS total FROM jobs").get()).toMatchObject({ total: 4 });
    f.addJob();
    expect(
      f.db.prepare("SELECT MAX(sequence) AS maximum FROM notification_events").get(),
    ).toMatchObject({ maximum: 5 });
  });

  it("rejects scope mismatches, replacement, and retention/sequence regression at the SQL boundary", () => {
    const f = fixture();
    f.addJob();
    const id = present(f.list().items[0]).event.id;
    expect(() =>
      f.db
        .prepare(
          "INSERT INTO notification_read_states VALUES ('repo-b', ?, '2026-09-07', ?, ?, 'read', 1, ?)",
        )
        .run(id, actor.issuer, actor.subject, initial),
    ).toThrow(/FOREIGN KEY/);
    expect(() => f.db.prepare("DELETE FROM notification_events WHERE id = ?").run(id)).toThrow(
      /retention/,
    );
    expect(() =>
      f.db.exec(
        "INSERT OR REPLACE INTO notification_retention VALUES (1, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')",
      ),
    ).toThrow(/cannot be replaced/);
    expect(() =>
      f.db.exec("INSERT OR REPLACE INTO notification_repository_counters VALUES ('repo-a', 0)"),
    ).toThrow(/cannot be replaced/);
    expect(() =>
      f.db.exec("DELETE FROM notification_repository_counters WHERE repository_id = 'repo-a'"),
    ).toThrow(/retained/);
    expect(() =>
      f.db.exec(
        "UPDATE notification_repository_counters SET next_sequence = 0 WHERE repository_id = 'repo-a'",
      ),
    ).toThrow(/inserted event/);
  });

  it("expires a mixed receipt with its oldest event even when the receipt itself is recent", () => {
    const f = fixture();
    const oldJob = f.addJob();
    const old = present(f.list().items[0]);
    f.setTime("2026-09-10T10:00:00.000Z");
    f.addJob();
    const fresh = present(f.list().items[0]);
    const request = {
      changeId: "mixed-retention",
      changes: [old, fresh].map((entry) => ({
        notificationId: entry.event.id,
        expectedVersion: 0,
        state: "read" as const,
      })),
    };
    f.call("changeNotificationStates", { actor, repositoryId: "repo-a", request });
    f.setTime("2026-12-08T10:00:00.000Z");
    let cleaned = f.call("maintainNotifications", { limit: 128 });
    expect(cleaned.retainedAfter).toBe("2026-09-10T00:00:00.000Z");
    expect(() =>
      f.call("changeNotificationStates", { actor, repositoryId: "repo-a", request }),
    ).toThrowError(expect.objectContaining({ code: "PLATFORM_CONFLICT" }));
    for (let count = 0; cleaned.hasMore && count < 10; count++)
      cleaned = f.call("maintainNotifications", { limit: 128 });
    expect(cleaned.hasMore).toBe(false);
    expect(f.list().items).toHaveLength(1);
    expect(f.list().items[0]).toMatchObject({
      event: { id: fresh.event.id },
      state: { state: "read", version: 1 },
    });
    f.db.prepare("UPDATE jobs SET status = 'dead_letter' WHERE id = ?").run(oldJob);
    expect(f.list().items).toHaveLength(1);
    expect(f.call("listNotificationOverview", { actor }).items[0]?.counts).toEqual({
      total: 1,
      unread: 0,
      read: 1,
      archived: 0,
    });
  });

  it("rejects oversized, duplicate, unknown-field and invalid cursor inputs", () => {
    const f = fixture();
    f.addJob();
    const id = present(f.list().items[0]).event.id;
    for (const cursor of ["0", "01", "-1", "9007199254740992", "1\n"])
      expect(() => f.list(actor, "repo-a", { cursor })).toThrowError(
        expect.objectContaining({ code: "PLATFORM_INVALID" }),
      );
    expect(() =>
      f.call("changeNotificationStates", {
        actor,
        repositoryId: "repo-a",
        request: {
          changeId: "duplicate",
          changes: [
            { notificationId: id, state: "read", expectedVersion: 0 },
            { notificationId: id, state: "archived", expectedVersion: 0 },
          ],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "PLATFORM_INVALID" }));
    expect(() => f.call("maintainNotifications", { limit: 129 })).toThrowError(
      expect.objectContaining({ code: "PLATFORM_INVALID" }),
    );
  });
});
