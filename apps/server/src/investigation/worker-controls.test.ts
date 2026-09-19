import { afterEach, describe, expect, it } from "vitest";
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
        e2eEnabled: false,
        version: 1,
        lastSeenAt: null,
        advertisedKinds: null,
        effectiveKinds: [],
        status: "static_only",
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
    });
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
