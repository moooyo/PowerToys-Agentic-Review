import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultInvestigationEvidencePolicy } from "../../dist/investigation/evidence-store.js";
import {
  InvestigationOperations,
  type InvestigationOperationsDependencies,
} from "../../dist/investigation/operations.js";
import { InvestigationStore } from "../../dist/investigation/store.js";

const stores: InvestigationStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function fixture(dependencies: InvestigationOperationsDependencies = {}, memory = false) {
  const store = new InvestigationStore();
  stores.push(store);
  const fileStat = vi.fn(async () => ({ size: 9_007_199_254_740_993n, isFile: () => true }));
  const fileSystemStat = vi.fn(async () => ({
    bsize: 4096n,
    blocks: 9_007_199_254_740_993n,
    bfree: 3n,
    bavail: 2n,
  }));
  const operations = new InvestigationOperations(
    {
      store,
      databasePath: memory ? ":memory:" : "private-investigation.sqlite",
      authDatabasePath: memory ? ":memory:" : "private-authentication.sqlite",
      evidencePolicy: defaultInvestigationEvidencePolicy,
    },
    {
      now: () => new Date("2026-09-26T00:00:00.000Z"),
      uptime: () => 120,
      realpath: async (path) => path,
      stat: fileStat,
      statfs: fileSystemStat,
      ...dependencies,
    },
  );
  return { store, operations, fileStat, fileSystemStat };
}

describe("read-only investigation operations snapshots", () => {
  it("aggregates bounded state dimensions without loading task bodies or exposing identifiers", async () => {
    const f = fixture();
    f.store.put("tasks", "private-task-a", { state: "queued", secret: "private-source-content" });
    f.store.put("tasks", "private-task-b", { state: "queued" });
    f.store.put("tasks", "private-task-c", { state: "running" });
    f.store.put("tasks", "private-task-d", { state: "private-invalid-state" });
    f.store.put("tasks", "private-task-e", { malformed: true });
    f.store.put("resourceLeases", "private-lease-a", { pool: "e2e", state: "held" });
    f.store.put("resourceLeases", "private-lease-b", { pool: "e2e", state: "needs_cleanup" });
    f.store.put("resourceLeases", "private-lease-c", { pool: "static", state: "released" });
    f.store.put("resourceLeases", "private-lease-d", { pool: "private-pool", state: "secret" });
    f.store.put("evidenceUsage", "global", {
      bytes: 123,
      count: 2,
      cleanupCursor: "private-cursor",
    });
    const list = vi.spyOn(f.store, "list");
    const writeTransaction = vi.spyOn(f.store, "transaction");
    const put = vi.spyOn(f.store, "put");

    const snapshot = await f.operations.read();

    expect(snapshot.tasks).toEqual({
      total: 5,
      byState: {
        queued: 2,
        running: 1,
        completed: 0,
        blocked: 0,
        failed: 0,
        cancelled: 0,
        interrupted: 0,
        unknown: 2,
      },
    });
    expect(snapshot.resourceLeases).toEqual({
      total: 4,
      byPoolAndState: {
        static: { held: 0, needs_cleanup: 0, released: 1, unknown: 0 },
        e2e: { held: 1, needs_cleanup: 1, released: 0, unknown: 0 },
        unknown: { held: 0, needs_cleanup: 0, released: 0, unknown: 1 },
      },
    });
    expect(snapshot.evidence).toEqual({
      ...defaultInvestigationEvidencePolicy,
      retainedBytes: 123,
      count: 2,
    });
    expect(list).not.toHaveBeenCalled();
    expect(writeTransaction).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(f.store.inTransaction).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("private-");
  });

  it("preserves exact file and volume bytes independently of the evidence quota", async () => {
    const f = fixture();
    const snapshot = await f.operations.read();
    expect(snapshot.storage.investigation.files.database).toEqual({
      status: "present",
      byteLength: "9007199254740993",
    });
    expect(snapshot.storage.authentication.fileSystem).toEqual({
      status: "available",
      totalBytes: (4096n * 9_007_199_254_740_993n).toString(),
      freeBytes: "12288",
      availableBytes: "8192",
    });
    const sqlite = snapshot.storage.investigation.sqlite;
    expect(sqlite.logicalBytes).toBe(
      (BigInt(sqlite.pageCount) * BigInt(sqlite.pageSizeBytes)).toString(),
    );
    expect(sqlite.reusableBytes).toBe(
      (BigInt(sqlite.freePageCount) * BigInt(sqlite.pageSizeBytes)).toString(),
    );
    expect(snapshot.evidence.retainedBytes).toBe(0);
    expect(snapshot.runtime).toMatchObject({
      processUptimeSeconds: 120,
      processStartedAt: "2026-09-25T23:58:00.000Z",
    });
    expect(f.fileSystemStat.mock.calls).toEqual([
      ["private-investigation.sqlite"],
      ["private-authentication.sqlite"],
    ]);
  });

  it("distinguishes missing and unavailable measurements without returning private errors", async () => {
    const f = fixture({
      stat: async (path) => {
        throw Object.assign(new Error(`Private failure at ${path}`), {
          code: path.endsWith("-wal") ? "ENOENT" : "EACCES",
        });
      },
      statfs: async () => {
        throw new Error("Private unsupported volume");
      },
    });
    const snapshot = await f.operations.read();
    expect(snapshot.storage.authentication.files).toEqual({
      database: { status: "unavailable", byteLength: null },
      wal: { status: "missing", byteLength: null },
      sharedMemory: { status: "unavailable", byteLength: null },
    });
    expect(snapshot.storage.investigation.fileSystem).toEqual({
      status: "unavailable",
      totalBytes: null,
      freeBytes: null,
      availableBytes: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("Private");
  });

  it("resolves redirected database files before asking for filesystem capacity", async () => {
    const f = fixture({ realpath: async (path) => `resolved-volume/${path}` });
    const snapshot = await f.operations.read();
    expect(f.fileSystemStat.mock.calls).toEqual([
      ["resolved-volume/private-investigation.sqlite"],
      ["resolved-volume/private-authentication.sqlite"],
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("resolved-volume");
  });

  it("does not probe filesystem paths for in-memory databases", async () => {
    const f = fixture({}, true);
    const snapshot = await f.operations.read();
    expect(snapshot.storage.investigation.files.database).toEqual({
      status: "in_memory",
      byteLength: null,
    });
    expect(snapshot.storage.authentication.fileSystem.status).toBe("in_memory");
    expect(f.fileStat).not.toHaveBeenCalled();
    expect(f.fileSystemStat).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous samples and refreshes after five monotonic seconds", async () => {
    let uptime = 120;
    const f = fixture({ uptime: () => uptime });
    const read = vi.spyOn(f.store, "operationsStatistics");
    const first = f.operations.read();
    const concurrent = f.operations.read();
    expect(concurrent).toBe(first);
    const snapshot = await first;
    uptime = 124.99;
    expect(await f.operations.read()).toBe(snapshot);
    expect(read).toHaveBeenCalledTimes(1);
    f.store.put("tasks", "new-task", { state: "queued" });
    uptime = 125;
    const refreshed = await f.operations.read();
    expect(refreshed.tasks.total).toBe(1);
    expect(refreshed.runtime.processStartedAt).toBe(snapshot.runtime.processStartedAt);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a snapshot across separate runtimes", async () => {
    const first = fixture();
    const second = fixture();
    first.store.put("tasks", "one", { state: "completed" });
    expect((await first.operations.read()).tasks.total).toBe(1);
    expect((await second.operations.read()).tasks.total).toBe(0);
  });

  it("rejects unavailable or corrupt statistics and clears failed samples for retry", async () => {
    const f = fixture();
    const statistics = vi.spyOn(f.store, "operationsStatistics");
    statistics.mockImplementationOnce(() => {
      throw new Error("Private database path or schema failure");
    });
    await expect(f.operations.read()).rejects.toMatchObject({
      statusCode: 503,
      code: "operations_snapshot_unavailable",
      message: "The operations snapshot is temporarily unavailable.",
    });
    f.store.put("evidenceUsage", "global", null);
    await expect(f.operations.read()).rejects.toMatchObject({ statusCode: 503 });
    expect(f.store.inTransaction).toBe(false);
    f.store.put("evidenceUsage", "global", { count: 1 });
    await expect(f.operations.read()).rejects.toMatchObject({ statusCode: 503 });
    f.store.put("evidenceUsage", "global", { bytes: 2, count: 1 });
    expect((await f.operations.read()).evidence.retainedBytes).toBe(2);
    expect(f.store.inTransaction).toBe(false);
  });

  it("rejects nested statistics without disturbing the caller's transaction", () => {
    const f = fixture();
    f.store.transaction(() => {
      f.store.put("tasks", "retained", { state: "queued" });
      expect(() => f.store.operationsStatistics()).toThrow(/independent read snapshot/u);
      expect(f.store.inTransaction).toBe(true);
    });
    expect(f.store.operationsStatistics().taskStates).toEqual([{ state: "queued", count: 1 }]);
  });

  it("reports reusable database pages after deletion separately from retained logical evidence", () => {
    const f = fixture({}, true);
    f.store.put("evidenceAssets", "synthetic-content", { contentBase64: "a".repeat(131_072) });
    const populated = f.store.operationsStatistics();
    f.store.delete("evidenceAssets", "synthetic-content");
    const cleaned = f.store.operationsStatistics();
    expect(cleaned.pageCount).toBe(populated.pageCount);
    expect(cleaned.freePageCount).toBeGreaterThan(populated.freePageCount);
    expect(cleaned.evidenceUsage).toEqual({ bytes: 0, count: 0 });
  });
});
