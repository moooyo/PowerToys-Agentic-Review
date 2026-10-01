import { createInvestigationPreview } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { InvestigationResourceLease } from "../../dist/investigation/resource-scheduler.js";
import { InvestigationStore } from "../../dist/investigation/store.js";
import type {
  InvestigationOperatorPrincipal,
  InvestigationWorkerPrincipal,
} from "../../dist/investigation/types.js";
import { InvestigationWorkerControls } from "../../dist/investigation/worker-controls.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const store = new InvestigationStore();
  stores.push(store);
  let now = Date.parse("2026-09-19T00:00:00.000Z");
  const clock = () => new Date(now);
  const controls = new InvestigationWorkerControls(store, clock);
  const worker: InvestigationWorkerPrincipal = { id: "worker-1", repositoryIds: ["repo-1"] };
  const admin: InvestigationOperatorPrincipal = {
    id: "admin-1",
    isAdmin: true,
    displayName: "Synthetic administrator",
    repositoryIds: [],
    permissions: [],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  };
  controls.initialize([worker]);
  return {
    store,
    controls,
    worker,
    admin,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("durable Worker E2E controls", () => {
  it("defaults every trusted identity to static-only and records authenticated contact", () => {
    const f = fixture();
    expect(f.controls.list(f.admin).items).toMatchObject([
      {
        id: "worker-1",
        displayName: "worker-1",
        e2eEnabled: false,
        version: 1,
        lastSeenAt: null,
        advertisedKinds: null,
        effectiveKinds: [],
        status: "static_only",
        contactStatus: "never",
        activityStatus: "offline",
        activeTaskIds: [],
      },
    ]);
    expect(
      f.controls.policy(f.worker, { supportedKinds: ["pr-review", "pr-e2e", "issue-fix"] }),
    ).toMatchObject({ e2eEnabled: false, effectiveKinds: ["pr-review"] });
    expect(f.controls.get(f.worker.id)?.lastSeenAt).toBe(f.clock().toISOString());
    const before = f.controls.get(f.worker.id);
    f.advance(1_000);
    f.controls.observe(f.worker);
    expect(f.controls.get(f.worker.id)).toMatchObject({
      version: 1,
      advertisedKinds: ["pr-review", "pr-e2e", "issue-fix"],
      updatedAt: before!.updatedAt,
      lastSeenAt: f.clock().toISOString(),
      contactStatus: "recent",
      activityStatus: "online",
    });
  });

  it("updates friendly names from trusted configuration without changing admission history", () => {
    const f = fixture();
    const named = { ...f.worker, displayName: "Windows Review Worker" };
    f.controls.initialize([named]);
    f.controls.policy(named, { supportedKinds: ["pr-review"] });
    f.controls.update(f.admin, named.id, { version: 1, e2eEnabled: true }, () => {});
    const before = f.controls.get(named.id)!;
    f.advance(1_000);
    const renamed = { ...named, displayName: "Windows Desktop Worker" };
    f.controls.initialize([renamed]);
    expect(f.controls.get(named.id)).toMatchObject({
      displayName: renamed.displayName,
      version: before.version,
      e2eEnabled: true,
      updatedAt: before.updatedAt,
      lastSeenAt: before.lastSeenAt,
    });
    expect(f.store.pagePrefix("idempotency", "worker-control-audit:v1:", 10)).toHaveLength(1);
    const restarted = new InvestigationWorkerControls(f.store, f.clock);
    expect(restarted.get(named.id)?.displayName).toBe(renamed.displayName);
    restarted.initialize([f.worker]);
    expect(restarted.get(named.id)?.displayName).toBe(named.id);
  });

  it("projects legacy controls without a saved friendly name and migrates them on initialization", () => {
    const f = fixture();
    const key = "worker-control:v1:worker-1";
    const { displayName: _displayName, ...legacy } = f.store.get<Record<string, unknown>>(
      "idempotency",
      key,
    )!;
    f.store.put("idempotency", key, legacy);
    expect(f.controls.get(f.worker.id)).toMatchObject({ displayName: f.worker.id, version: 1 });
    f.controls.initialize([{ ...f.worker, displayName: "Migrated Worker" }]);
    expect(f.store.get("idempotency", key)).toMatchObject({ displayName: "Migrated Worker" });
  });

  it("preserves maximum-length legacy worker IDs as unnamed display values", () => {
    const f = fixture();
    const worker = { ...f.worker, id: "W".repeat(128) };
    f.controls.initialize([worker]);
    expect(f.controls.get(worker.id)?.displayName).toBe(worker.id);
  });

  it("uses the server clock for contact expiry without treating it as a process health probe", () => {
    const f = fixture();
    f.controls.observe(f.worker);
    f.advance(119_999);
    expect(f.controls.get(f.worker.id)).toMatchObject({
      contactStatus: "recent",
      activityStatus: "online",
    });
    f.advance(1);
    expect(f.controls.get(f.worker.id)).toMatchObject({
      contactStatus: "stale",
      activityStatus: "offline",
    });
    f.controls.observe(f.worker);
    expect(f.controls.get(f.worker.id)).toMatchObject({
      contactStatus: "recent",
      activityStatus: "online",
      version: 1,
    });
  });

  it("retains static and E2E ownership after contact expires and prioritizes pending cleanup", () => {
    const f = fixture();
    f.controls.observe(f.worker);
    const lease: InvestigationResourceLease = {
      attemptId: "static-attempt",
      taskId: "static-task",
      workerId: f.worker.id,
      fence: 1,
      pool: "static",
      state: "held",
      acquiredAt: f.clock().toISOString(),
      updatedAt: f.clock().toISOString(),
      releasedAt: null,
      reason: null,
    };
    f.store.insert("resourceLeases", lease.attemptId, lease);
    expect(f.controls.get(f.worker.id)).toMatchObject({
      activityStatus: "busy",
      activeTaskIds: ["static-task"],
      activeE2eTaskIds: [],
      status: "static_only",
    });
    f.advance(120_000);
    expect(f.controls.get(f.worker.id)).toMatchObject({
      contactStatus: "stale",
      activityStatus: "busy",
      activeTaskIds: ["static-task"],
    });
    const cleanup: InvestigationResourceLease = {
      ...lease,
      attemptId: "e2e-attempt",
      taskId: "finished-e2e-task",
      pool: "e2e",
      state: "needs_cleanup",
    };
    f.store.insert("resourceLeases", cleanup.attemptId, cleanup);
    expect(f.controls.get(f.worker.id)).toMatchObject({
      contactStatus: "stale",
      activityStatus: "cleaning",
      activeTaskIds: ["finished-e2e-task", "static-task"],
      activeE2eTaskIds: ["finished-e2e-task"],
      cleanupPendingAttemptIds: ["e2e-attempt"],
    });
    f.store.put("resourceLeases", cleanup.attemptId, { ...cleanup, state: "released" });
    expect(f.controls.get(f.worker.id)?.activityStatus).toBe("busy");
    f.store.put("resourceLeases", lease.attemptId, { ...lease, state: "released" });
    expect(f.controls.get(f.worker.id)).toMatchObject({
      activityStatus: "offline",
      activeTaskIds: [],
      cleanupPendingAttemptIds: [],
    });
  });

  it("includes active task ownership when no capacity lease exists and excludes historical owners", () => {
    const f = fixture();
    const preview = createInvestigationPreview("pr", { findingCount: 0 });
    const task = { ...preview.task, state: "running" as const };
    const attempt = {
      ...preview.attempt,
      workerId: f.worker.id,
      state: "running" as const,
      finishedAt: null,
    };
    f.store.insert("tasks", task.id, task);
    f.store.insert("attempts", attempt.id, { attempt });
    expect(f.controls.get(f.worker.id)).toMatchObject({
      contactStatus: "never",
      activityStatus: "busy",
      activeTaskIds: [task.id],
    });
    f.store.put("attempts", attempt.id, { attempt: { ...attempt, state: "completed" } });
    expect(f.controls.get(f.worker.id)?.activityStatus).toBe("offline");
    f.store.put("attempts", attempt.id, { attempt });
    f.store.put("tasks", task.id, { ...task, state: "completed" });
    expect(f.controls.get(f.worker.id)?.activeTaskIds).toEqual([]);
  });

  it("persists administrator changes, audits them, and never raises a static local role", () => {
    const f = fixture();
    f.controls.policy(f.worker, { supportedKinds: ["pr-review", "issue-investigate"] });
    const result = f.controls.update(f.admin, f.worker.id, { version: 1, e2eEnabled: true }, () => {
      throw new Error("Enabling must not cancel attempts.");
    });
    expect(result).toMatchObject({
      e2eEnabled: true,
      version: 2,
      status: "static_only",
      effectiveKinds: ["pr-review", "issue-investigate"],
      updatedBy: f.admin.id,
    });
    const restarted = new InvestigationWorkerControls(f.store, f.clock);
    restarted.initialize([f.worker]);
    expect(restarted.allowsE2e(f.worker)).toBe(true);
    expect(restarted.get(f.worker.id)?.version).toBe(2);
    expect(f.store.pagePrefix("idempotency", "worker-control-audit:v1:", 10)).toEqual([
      {
        workerId: f.worker.id,
        version: 2,
        actorId: f.admin.id,
        recordedAt: f.clock().toISOString(),
        previousE2eEnabled: false,
        e2eEnabled: true,
      },
    ]);
  });

  it("rejects non-admin updates and stale versions without invoking cancellation", () => {
    const f = fixture();
    let cancellations = 0;
    const cancel = () => {
      cancellations += 1;
    };
    expect(() => f.controls.list({ ...f.admin, isAdmin: false })).toThrow(/administrator/);
    expect(() =>
      f.controls.update(
        { ...f.admin, isAdmin: false },
        f.worker.id,
        {
          version: 1,
          e2eEnabled: true,
        },
        cancel,
      ),
    ).toThrow(/administrator/);
    f.controls.update(f.admin, f.worker.id, { version: 1, e2eEnabled: true }, cancel);
    expect(() =>
      f.controls.update(f.admin, f.worker.id, { version: 1, e2eEnabled: false }, cancel),
    ).toThrow(/refresh/);
    expect(cancellations).toBe(0);
    expect(f.controls.get(f.worker.id)?.e2eEnabled).toBe(true);
  });

  it("atomically disables policy and cancellation, retaining cleanup until explicit confirmation", () => {
    const f = fixture();
    f.controls.policy(f.worker, { supportedKinds: ["pr-review", "pr-e2e"] });
    f.controls.update(f.admin, f.worker.id, { version: 1, e2eEnabled: true }, () => {});
    const lease = {
      attemptId: "attempt-1",
      taskId: "task-1",
      workerId: f.worker.id,
      fence: 1,
      pool: "e2e",
      state: "held",
      acquiredAt: f.clock().toISOString(),
      updatedAt: f.clock().toISOString(),
      releasedAt: null,
      reason: null,
    };
    f.store.insert("resourceLeases", lease.attemptId, lease);
    expect(() =>
      f.controls.update(f.admin, f.worker.id, { version: 2, e2eEnabled: false }, () => {
        f.store.put("resourceLeases", lease.attemptId, { ...lease, state: "needs_cleanup" });
        throw new Error("Synthetic cancellation failure");
      }),
    ).toThrow(/Synthetic cancellation failure/);
    expect(f.controls.get(f.worker.id)).toMatchObject({ e2eEnabled: true, version: 2 });
    expect(f.store.get("resourceLeases", lease.attemptId)).toMatchObject({ state: "held" });
    const disabled = f.controls.update(
      f.admin,
      f.worker.id,
      { version: 2, e2eEnabled: false },
      () => {
        expect(f.store.inTransaction).toBe(true);
        f.store.put("resourceLeases", lease.attemptId, { ...lease, state: "needs_cleanup" });
      },
    );
    expect(disabled).toMatchObject({
      e2eEnabled: false,
      status: "disabling",
      activeE2eTaskIds: ["task-1"],
      cleanupPendingAttemptIds: ["attempt-1"],
      effectiveKinds: ["pr-review"],
    });
    f.advance(120_001);
    expect(f.controls.get(f.worker.id)?.status).toBe("awaiting_confirmation");
    f.store.put("resourceLeases", lease.attemptId, { ...lease, state: "released" });
    expect(f.controls.get(f.worker.id)?.status).toBe("static_only");
  });

  it("fails closed on malformed persisted control data", () => {
    const f = fixture();
    f.store.put("idempotency", "worker-control:v1:worker-1", { e2eEnabled: true });
    expect(() => f.controls.allowsE2e(f.worker)).toThrow(/stored worker control is invalid/);
  });
});
