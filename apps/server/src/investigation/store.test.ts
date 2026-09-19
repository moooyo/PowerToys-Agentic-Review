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

function createV2(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE "investigation_metadata" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "value" TEXT NOT NULL
    ) STRICT`);
    database
      .prepare('INSERT INTO "investigation_metadata" ("key", "value") VALUES (?, ?)')
      .run("schema_version", "investigation-v2");
    for (const collection of investigationCollections.filter(
      (name) =>
        ![
          "commentDeliveries",
          "resourceLeases",
          "schedulerSettings",
          "outputEvents",
          "outputStreams",
          "outputBatches",
          "reportDirectory",
        ].includes(name),
    ))
      database.exec(`CREATE TABLE "${collection}" (
        "id" TEXT PRIMARY KEY NOT NULL,
        "value" TEXT NOT NULL CHECK (json_valid("value"))
      ) STRICT`);
  } finally {
    database.close();
  }
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

  it("keyset-pages within a prefix in either direction and rejects a foreign cursor", () => {
    const store = open();
    for (const id of ["older:1", "reply:1", "reply:2", "reply:3", "reply:4", "task:1"])
      store.insert("idempotency", id, { id });
    expect(store.pagePrefix("idempotency", "reply:", 2)).toEqual([
      { id: "reply:1" },
      { id: "reply:2" },
    ]);
    expect(store.pagePrefix("idempotency", "reply:", 2, false, "reply:2")).toEqual([
      { id: "reply:3" },
      { id: "reply:4" },
    ]);
    expect(store.pagePrefix("idempotency", "reply:", 2, true)).toEqual([
      { id: "reply:4" },
      { id: "reply:3" },
    ]);
    expect(store.pagePrefix("idempotency", "reply:", 2, true, "reply:3")).toEqual([
      { id: "reply:2" },
      { id: "reply:1" },
    ]);
    expect(store.pagePrefix("idempotency", "reply:", 2, false, "reply:4")).toEqual([]);
    for (const cursor of ["older:1", "task:1", "reply:\uffff"])
      expect(() => store.pagePrefix("idempotency", "reply:", 2, false, cursor)).toThrow(
        expect.objectContaining({ code: "invalid_value" }),
      );
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
      .run("investigation-v1", "schema_version");
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

  it("additively migrates the exact v2 schema without rewriting existing JSON or definitions", async () => {
    const path = await databasePath();
    createV2(path);
    const raw = ' { "body" : "Retained publication bytes", "unknown" : true } ';
    const writer = new DatabaseSync(path);
    let before: { name: string; sql: string }[];
    try {
      writer
        .prepare('INSERT INTO "idempotency" ("id", "value") VALUES (?, ?)')
        .run("progress-reply:task:retained", raw);
      writer.prepare('INSERT INTO "tasks" ("id", "value") VALUES (?, ?)').run("retained-task", raw);
      before = writer
        .prepare(
          "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all() as { name: string; sql: string }[];
    } finally {
      writer.close();
    }
    open(path).close();
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      for (const table of before!) {
        expect(
          reader.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table.name)?.sql,
        ).toBe(table.sql);
      }
      expect(
        reader
          .prepare('SELECT "value" FROM "idempotency" WHERE "id" = ?')
          .get("progress-reply:task:retained")?.value,
      ).toBe(raw);
      expect(
        reader.prepare('SELECT "value" FROM "tasks" WHERE "id" = ?').get("retained-task")?.value,
      ).toBe(raw);
      expect(
        reader
          .prepare('SELECT "value" FROM "investigation_metadata" WHERE "key" = ?')
          .get("schema_version")?.value,
      ).toBe(investigationSchemaVersion);
      expect(reader.prepare('SELECT count(*) AS count FROM "commentDeliveries"').get()?.count).toBe(
        0,
      );
      expect(
        reader
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND name GLOB 'comment_deliveries_*'",
          )
          .all(),
      ).toHaveLength(4);
    } finally {
      reader.close();
    }
    expect(open(path).get("idempotency", "progress-reply:task:retained")).toEqual({
      body: "Retained publication bytes",
      unknown: true,
    });
  });

  it("adds scheduler storage to an exact v3 database without altering historical receipts", async () => {
    const path = await databasePath();
    open(path).close();
    const raw = ' { "state" : "failed", "effect" : "not_sent", "reason" : "Historical receipt" } ';
    const writer = new DatabaseSync(path);
    try {
      writer.exec(
        'DROP TABLE "outputEvents"; DROP TABLE "outputStreams"; DROP TABLE "outputBatches"; DROP TABLE "reportDirectory"; DROP INDEX "evidence_metadata_task"; DROP INDEX "work_items_repository"; DROP INDEX "tasks_repository"; DROP INDEX "publications_repository";',
      );
      writer.exec('DROP TABLE "resourceLeases"; DROP TABLE "schedulerSettings";');
      writer
        .prepare('UPDATE "investigation_metadata" SET "value" = ? WHERE "key" = ?')
        .run("investigation-v3", "schema_version");
      writer
        .prepare('INSERT INTO "commentDeliveries" ("id", "value") VALUES (?, ?)')
        .run("historical-delivery", raw);
    } finally {
      writer.close();
    }
    const migrated = open(path);
    expect(migrated.list("resourceLeases")).toEqual([]);
    expect(migrated.list("schedulerSettings")).toEqual([]);
    migrated.close();
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        reader
          .prepare('SELECT "value" FROM "commentDeliveries" WHERE "id" = ?')
          .get("historical-delivery")?.value,
      ).toBe(raw);
      expect(
        reader
          .prepare('SELECT "value" FROM "investigation_metadata" WHERE "key" = ?')
          .get("schema_version")?.value,
      ).toBe(investigationSchemaVersion);
    } finally {
      reader.close();
    }
  });

  it("adds output storage and bounded directory indexes to the exact v4 schema", async () => {
    const path = await databasePath();
    open(path).close();
    const writer = new DatabaseSync(path);
    try {
      writer.exec(
        'DROP TABLE "outputEvents"; DROP TABLE "outputStreams"; DROP TABLE "outputBatches"; DROP TABLE "reportDirectory"; DROP INDEX "evidence_metadata_task"; DROP INDEX "work_items_repository"; DROP INDEX "tasks_repository"; DROP INDEX "publications_repository";',
      );
      writer
        .prepare('UPDATE "investigation_metadata" SET "value" = ? WHERE "key" = ?')
        .run("investigation-v4", "schema_version");
      writer
        .prepare('INSERT INTO "tasks" ("id", "value") VALUES (?, ?)')
        .run("retained-task", '{"id":"retained-task","state":"completed"}');
    } finally {
      writer.close();
    }
    const migrated = open(path);
    expect(migrated.get("tasks", "retained-task")).toEqual({
      id: "retained-task",
      state: "completed",
    });
    expect(migrated.list("outputEvents")).toEqual([]);
    expect(migrated.list("reportDirectory")).toEqual([]);
    migrated.close();
    expect(open(path).get("tasks", "retained-task")).toMatchObject({ state: "completed" });
  });

  it.each(["extra-index", "partial-new-table", "wrong-version", "changed-definition"])(
    "refuses an unrecognized v2 migration candidate without modifications: %s",
    async (variant) => {
      const path = await databasePath();
      createV2(path);
      const writer = new DatabaseSync(path);
      let before: unknown[];
      try {
        if (variant === "extra-index") writer.exec('CREATE INDEX "unexpected" ON "tasks" ("id")');
        if (variant === "partial-new-table")
          writer.exec('CREATE TABLE "commentDeliveries" ("id" TEXT PRIMARY KEY, "value" TEXT)');
        if (variant === "wrong-version")
          writer
            .prepare('UPDATE "investigation_metadata" SET "value" = ? WHERE "key" = ?')
            .run("investigation-v1", "schema_version");
        if (variant === "changed-definition") {
          writer.exec('DROP TABLE "plans"');
          writer.exec(
            'CREATE TABLE "plans" ("id" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL) STRICT',
          );
        }
        writer
          .prepare('INSERT INTO "idempotency" ("id", "value") VALUES (?, ?)')
          .run("retained", '{ "unmodified" : true }');
        before = writer
          .prepare(
            "SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
          )
          .all();
      } finally {
        writer.close();
      }
      expect(() => open(path)).toThrow(expect.objectContaining({ code: "incompatible_schema" }));
      const reader = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          reader
            .prepare(
              "SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
            )
            .all(),
        ).toEqual(before!);
        expect(
          reader.prepare('SELECT "value" FROM "idempotency" WHERE "id" = ?').get("retained")?.value,
        ).toBe('{ "unmodified" : true }');
        expect(reader.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
      } finally {
        reader.close();
      }
    },
  );
});
