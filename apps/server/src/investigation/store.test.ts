import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type InvestigationCollection,
  InvestigationStore,
  InvestigationStoreError,
  investigationCollections,
  investigationSchemaVersion,
} from "../../dist/investigation/store.js";

const stores: InvestigationStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function open(path?: string): InvestigationStore {
  const store = new InvestigationStore(path);
  stores.push(store);
  return store;
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "investigation-store-"));
  directories.push(directory);
  return join(directory, "investigation.sqlite");
}

describe("InvestigationStore", () => {
  it("persists every entity collection and the schema identity across restarts", async () => {
    const path = await databasePath();
    const first = open(path);
    for (const collection of investigationCollections) {
      first.insert(collection, "entity-1", { id: "entity-1", collection, nested: [1, null, true] });
    }
    first.close();

    const second = open(path);
    for (const collection of investigationCollections) {
      expect(second.get(collection, "entity-1")).toEqual({
        id: "entity-1",
        collection,
        nested: [1, null, true],
      });
    }
    second.close();

    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        reader
          .prepare('SELECT "value" FROM investigation_metadata WHERE "key" = ?')
          .get("schema_version")?.value,
      ).toBe(investigationSchemaVersion);
      expect(reader.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    } finally {
      reader.close();
    }
  });

  it("commits and rolls back related entities atomically", () => {
    const store = open();
    const result = store.transaction(() => {
      store.insert("tasks", "task-1", { state: "queued" });
      store.insert("attempts", "attempt-1", { taskId: "task-1" });
      return "committed";
    });
    expect(result).toBe("committed");

    const failure = new Error("Report publication failed.");
    expect(() =>
      store.transaction(() => {
        store.put("tasks", "task-1", { state: "completed" });
        store.delete("attempts", "attempt-1");
        store.insert("reports", "report-1", { taskId: "task-1" });
        throw failure;
      }),
    ).toThrow(failure);
    expect(store.get("tasks", "task-1")).toEqual({ state: "queued" });
    expect(store.get("attempts", "attempt-1")).toEqual({ taskId: "task-1" });
    expect(store.get("reports", "report-1")).toBeUndefined();
    store.transaction(() => store.put("tasks", "task-1", { state: "running" }));
    expect(store.get("tasks", "task-1")).toEqual({ state: "running" });
  });

  it("reports duplicate IDs as typed conflicts without replacing their values", () => {
    const store = open();
    store.insert("reports", "report-1", { version: 1 });
    expect(() => store.insert("reports", "report-1", { version: 2 })).toThrow(
      InvestigationStoreError,
    );
    expect(() => store.insert("reports", "report-1", { version: 2 })).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(store.get("reports", "report-1")).toEqual({ version: 1 });
  });

  it("returns complete ordered collections, supports filtering, and isolates returned objects", () => {
    const store = open();
    for (let index = 0; index < 150; index += 1) {
      const id = `finding-${String(index).padStart(3, "0")}`;
      store.insert("findings", id, { id, priority: index % 4 });
    }
    const findings = store.list<{ id: string; priority: number }>("findings");
    expect(findings).toHaveLength(150);
    expect(findings[0]?.id).toBe("finding-000");
    expect(findings[149]?.id).toBe("finding-149");
    expect(
      store.list<{ priority: number }>("findings", (finding) => finding.priority === 0),
    ).toHaveLength(38);
    const finding = store.get<{ id: string; priority: number }>("findings", "finding-000");
    if (finding === undefined) {
      throw new Error("Expected a persisted finding.");
    }
    finding.priority = 3;
    expect(store.get("findings", "finding-000")).toEqual({ id: "finding-000", priority: 0 });
  });

  it("parameterizes entity IDs and JSON content and rejects unknown collections", () => {
    const store = open();
    const id = "report'); DROP TABLE tasks; --";
    const value = { body: "'); DROP TABLE reports; --", title: 'Quoted "report"' };
    store.insert("reports", id, value);
    expect(store.get("reports", id)).toEqual(value);
    store.put("reports", id, { updated: true });
    expect(store.get("reports", id)).toEqual({ updated: true });
    store.delete("reports", id);
    expect(store.get("reports", id)).toBeUndefined();
    expect(store.list("tasks")).toEqual([]);
    expect(() => store.list("tasks; DROP TABLE reports" as InvestigationCollection)).toThrow(
      expect.objectContaining({ code: "invalid_collection" }),
    );
  });

  it("rejects unsupported JSON values before changing storage", () => {
    const store = open();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const value of [undefined, () => undefined, 1n, circular]) {
      expect(() => store.insert("reports", "report-1", value)).toThrow(
        expect.objectContaining({ code: "invalid_value" }),
      );
    }
    expect(store.list("reports")).toEqual([]);
  });

  it("rejects nested and asynchronous transactions and remains usable", () => {
    const store = open();
    expect(() =>
      store.transaction(() => {
        store.insert("tasks", "task-1", {});
        store.transaction(() => undefined);
      }),
    ).toThrow(expect.objectContaining({ code: "transaction_state" }));
    expect(store.list("tasks")).toEqual([]);

    expect(() =>
      store.transaction(() => {
        store.insert("tasks", "task-2", {});
        return Promise.resolve();
      }),
    ).toThrow(expect.objectContaining({ code: "transaction_state" }));
    expect(store.list("tasks")).toEqual([]);
    store.transaction(() => store.insert("tasks", "task-3", {}));
    expect(store.list("tasks")).toEqual([{}]);
  });

  it("refuses a legacy database without adding tables or changing its data", async () => {
    const path = await databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    legacy.prepare("INSERT INTO jobs (id, status) VALUES (?, ?)").run("job-1", "queued");
    legacy.close();

    expect(() => open(path)).toThrow(expect.objectContaining({ code: "incompatible_schema" }));
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(reader.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([
        { name: "jobs" },
      ]);
      expect(reader.prepare("SELECT * FROM jobs").all()).toEqual([
        { id: "job-1", status: "queued" },
      ]);
      expect(reader.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    } finally {
      reader.close();
    }
  });

  it("refuses an unsupported version and incomplete investigation schemas", async () => {
    const path = await databasePath();
    open(path).close();
    const writer = new DatabaseSync(path);
    writer
      .prepare('UPDATE investigation_metadata SET "value" = ? WHERE "key" = ?')
      .run("investigation-v2", "schema_version");
    writer.close();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: "incompatible_schema" }));

    const incomplete = new DatabaseSync(path);
    incomplete
      .prepare('UPDATE investigation_metadata SET "value" = ? WHERE "key" = ?')
      .run(investigationSchemaVersion, "schema_version");
    incomplete.exec('DROP TABLE "reportParts"');
    incomplete.close();
    expect(() => open(path)).toThrow(expect.objectContaining({ code: "incompatible_schema" }));
  });
});
