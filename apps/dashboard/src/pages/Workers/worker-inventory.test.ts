import { describe, expect, it, vi } from "vitest";
import type { WorkerCredential, WorkerNode } from "@/services/review-control";
import {
  createWorkerInventorySnapshotCache,
  DEFAULT_WORKER_INVENTORY_PAGE_SIZE,
  filterWorkerInventory,
  isCanonicalWorkerNodeId,
  MAX_WORKER_INVENTORY_PAGE_SIZE,
  mergeWorkerInventory,
  paginateWorkerInventory,
  type WorkerInventoryRow,
} from "./worker-inventory";

const credential = (overrides: Partial<WorkerCredential> = {}): WorkerCredential => ({
  workerNodeId: "worker:11111111-1111-4111-8111-111111111111",
  displayName: "Seattle worker",
  authState: "active",
  createdAt: "2026-09-04T01:00:00.000Z",
  activatedAt: "2026-09-04T01:01:00.000Z",
  rotatedAt: null,
  revokedAt: null,
  updatedAt: "2026-09-04T01:01:00.000Z",
  ...overrides,
});

const worker = (overrides: Partial<WorkerNode> = {}): WorkerNode => ({
  id: "worker:11111111-1111-4111-8111-111111111111",
  serverId: "worker-instance-record",
  displayName: "Runtime name",
  instanceId: "instance-1",
  status: "online",
  version: "0.1.0",
  location: "Seattle",
  activeSlots: 1,
  maxSlots: 2,
  capabilities: ["static-review"],
  currentJobs: [],
  lastHeartbeatAt: "2026-09-04T01:02:00.000Z",
  diskFreeGb: 100,
  ...overrides,
});

const inventoryRow = (index: number): WorkerInventoryRow => ({
  workerNodeId: `worker-${index}`,
  displayName: `Worker ${index}`,
  authState: "active",
  runtimeState: "not_connected",
});

describe("worker inventory", () => {
  it("joins runtime data to credential records by worker node id", () => {
    const rows = mergeWorkerInventory([credential()], [worker()]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      displayName: "Seattle worker",
      authState: "active",
      runtimeState: "online",
      runtime: { instanceId: "instance-1" },
    });
  });

  it("keeps pending and revoked credentials without runtime instances", () => {
    const rows = mergeWorkerInventory(
      [
        credential({ authState: "pending" }),
        credential({
          workerNodeId: "worker:22222222-2222-4222-8222-222222222222",
          authState: "revoked",
        }),
      ],
      [],
    );

    expect(rows.map(({ authState, runtimeState }) => ({ authState, runtimeState }))).toEqual([
      { authState: "pending", runtimeState: "not_connected" },
      { authState: "revoked", runtimeState: "not_connected" },
    ]);
  });

  it("preserves a runtime-only worker as an unknown credential record", () => {
    expect(mergeWorkerInventory([], [worker()])[0]).toMatchObject({
      authState: "unknown",
      runtimeState: "online",
    });
  });

  it("filters across credential and runtime fields", () => {
    const rows = mergeWorkerInventory([credential()], [worker()]);

    expect(filterWorkerInventory(rows, { search: "static-review" })).toHaveLength(1);
    expect(filterWorkerInventory(rows, { authState: "revoked" })).toHaveLength(0);
    expect(filterWorkerInventory(rows, { runtimeState: ["online"] })).toHaveLength(1);
  });

  it("allows mutations only for canonical generated worker node ids", () => {
    expect(isCanonicalWorkerNodeId("worker:11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isCanonicalWorkerNodeId("powertoys-worker-sea-01")).toBe(false);
  });

  it("paginates locally with a default of 50 and a hard maximum of 200", () => {
    const rows = Array.from({ length: 250 }, (_, index) => inventoryRow(index));

    const defaultPage = paginateWorkerInventory(rows, undefined, undefined);
    expect(defaultPage.items).toHaveLength(DEFAULT_WORKER_INVENTORY_PAGE_SIZE);
    expect(defaultPage.items[0]?.workerNodeId).toBe("worker-0");
    expect(defaultPage.items.at(-1)?.workerNodeId).toBe("worker-49");
    expect(defaultPage.total).toBe(250);

    const secondPage = paginateWorkerInventory(rows, 2, 100);
    expect(secondPage.items).toHaveLength(100);
    expect(secondPage.items[0]?.workerNodeId).toBe("worker-100");

    const clampedPage = paginateWorkerInventory(rows, 1, 10_000);
    expect(clampedPage.items).toHaveLength(MAX_WORKER_INVENTORY_PAGE_SIZE);
  });

  it("reuses a cached snapshot until invalidated", async () => {
    const rows = [inventoryRow(0)];
    const loadSnapshot = vi.fn(async () => rows);
    const cache = createWorkerInventorySnapshotCache(loadSnapshot);

    const first = cache.load();
    const second = cache.load();
    expect(second).toBe(first);
    await expect(first).resolves.toBe(rows);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    cache.invalidate();
    await expect(cache.load()).resolves.toBe(rows);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("clears a rejected snapshot so the next request can retry", async () => {
    const rows = [inventoryRow(0)];
    const loadSnapshot = vi
      .fn<() => Promise<WorkerInventoryRow[]>>()
      .mockRejectedValueOnce(new Error("inventory unavailable"))
      .mockResolvedValueOnce(rows);
    const cache = createWorkerInventorySnapshotCache(loadSnapshot);

    await expect(cache.load()).rejects.toThrow("inventory unavailable");
    await expect(cache.load()).resolves.toBe(rows);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });
});
