import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEvaluationBatchFixture } from "./evaluation-batches.testing.js";
import * as reproduction from "./evaluation-reproduction.js";
import { createEvaluationReproductionFixture } from "./evaluation-reproduction.testing.js";
import {
  EvaluationReproductionRebuildError,
  runEvaluationReproductionRebuild,
} from "./evaluation-reproduction-rebuild.js";
import { runMigrations } from "./migrations.js";

const migrationDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const migrationName = "0033_evaluation_reproduction.sql";
const directories: string[] = [];
const fixtures: { readonly database: DatabaseSync; close(): void }[] = [];
const formats = new Map(["date-time", "uri"].map((name) => [name, FormatRegistry.Get(name)]));
beforeAll(() => {
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    if (fixture.database.isTransaction) fixture.database.exec("ROLLBACK");
    fixture.close();
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
afterAll(() => {
  for (const [name, format] of formats) {
    if (format === undefined) FormatRegistry.Delete(name);
    else FormatRegistry.Set(name, format);
  }
});
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
function schema(database: DatabaseSync) {
  return database
    .prepare(
      "SELECT 'main' AS schema_name,type,name,tbl_name,sql FROM main.sqlite_schema UNION ALL SELECT 'temp' AS schema_name,type,name,tbl_name,sql FROM temp.sqlite_schema ORDER BY schema_name,type,name",
    )
    .all();
}
function snapshot(database: DatabaseSync) {
  const definitions = schema(database);
  const tables = definitions
    .filter((entry) => entry.schema_name === "main" && entry.type === "table")
    .map((entry) => String(entry.name));
  return {
    schema: definitions,
    rows: Object.fromEntries(
      tables.map((table) => {
        const definitions = database
          .prepare("SELECT name,pk FROM pragma_table_info(?) ORDER BY cid")
          .all(table);
        const columns = definitions.map((entry) => String(entry.name));
        const withoutRowid =
          database
            .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
            .get(table)?.wr === 1;
        const order = withoutRowid
          ? definitions
              .filter((entry) => Number(entry.pk) > 0)
              .sort((a, b) => Number(a.pk) - Number(b.pk))
              .map((entry) => quote(String(entry.name)))
              .join(",")
          : "rowid";
        const statement = database.prepare(
          "SELECT " +
            (withoutRowid ? "" : "rowid AS physical_rowid,") +
            columns
              .flatMap((name, index) => [
                "typeof(" + quote(name) + ") AS " + quote("type_" + index),
                "hex(CAST(" + quote(name) + " AS BLOB)) AS " + quote("bytes_" + index),
              ])
              .join(",") +
            " FROM " +
            quote(table) +
            " ORDER BY " +
            order,
        );
        statement.setReadBigInts(true);
        return [table, [...statement.iterate()]];
      }),
    ),
    foreignKeys: Object.fromEntries(
      tables.map((table) => [
        table,
        database.prepare("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id,seq").all(table),
      ]),
    ),
  };
}
function captureError(action: () => unknown): EvaluationReproductionRebuildError {
  let error: unknown;
  try {
    action();
  } catch (value) {
    error = value;
  }
  expect(error).toBeInstanceOf(EvaluationReproductionRebuildError);
  return error as EvaluationReproductionRebuildError;
}
function restored(database: DatabaseSync): void {
  expect(database.isTransaction).toBe(false);
  expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}
async function install(directory: string, sql?: string): Promise<void> {
  await writeFile(
    join(directory, migrationName),
    sql ?? (await readFile(join(migrationDirectory, migrationName), "utf8")),
  );
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-reproduction-m32-"));
  directories.push(directory);
  const files = (await readdir(migrationDirectory)).filter(
    (name) => /^\d{4}_.*\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 32,
  );
  expect(files).toHaveLength(32);
  await Promise.all(
    files.map((name) => copyFile(join(migrationDirectory, name), join(directory, name))),
  );
  const base = createEvaluationBatchFixture("issue", {
    migrationsDirectory: directory,
    notApplicableCase: false,
  });
  fixtures.push(base);
  const database = base.database;
  const prepare = database.prepare.bind(database);
  const injected = vi
    .spyOn(database, "prepare")
    .mockImplementation((sql) =>
      prepare(
        /^INSERT INTO evaluations\s*\(/u.test(sql)
          ? sql
              .replace("INSERT INTO evaluations (", "INSERT INTO evaluations (rowid,")
              .replace("VALUES (", "VALUES (4000000041,")
          : sql,
      ),
    );
  try {
    const batch = base.create({
      ...base.input,
      request: { ...base.input.request, mode: "profile_only" },
    });
    return { ...base, directory, evaluationId: batch.id };
  } finally {
    injected.mockRestore();
  }
}

describe("controlled evaluation reproduction migration rebuild", () => {
  it("rejects a coherent new V1 batch when the owner omits an actual source reproduction definition", () => {
    const value = createEvaluationReproductionFixture();
    fixtures.push(value);
    const before = snapshot(value.database);
    const input = structuredClone(value.input);
    delete input.request.reproductionMappings;
    // Fault only the owner's source resolution. The actual source, original Run, complete
    // V1 manifests, new Run inserts, and all SQL guards remain real synthetic records.
    const omitted = vi
      .spyOn(reproduction, "readEvaluationSourceReproductionInTransaction")
      .mockReturnValue(null);
    expect(() => value.create(input)).toThrow(
      "V1 evaluation Run cannot omit its source reproduction definition",
    );
    expect(omitted).toHaveBeenCalled();
    restored(value.database);
    expect(snapshot(value.database)).toEqual(before);
    expect(
      value.database.prepare("SELECT plan_json FROM review_runs WHERE id = ?").get(value.run.id)
        ?.plan_json,
    ).toBe(value.originalPlanJson);
  });

  it("preserves every historical table byte, rowid, foreign key and guard while allowing V2 storage", async () => {
    const value = await fixture(),
      before = snapshot(value.database);
    await install(value.directory);
    expect(runMigrations(value.database, value.directory)).toBe(33);
    restored(value.database);
    const after = snapshot(value.database);
    for (const [table, rows] of Object.entries(before.rows)) {
      if (table !== "schema_migrations") expect(after.rows[table]).toEqual(rows);
      expect(after.foreignKeys[table]).toEqual(before.foreignKeys[table]);
    }
    for (const object of before.schema) {
      if (object.type === "table" && object.name === "evaluations") continue;
      if (object.type === "trigger" && object.name === "tr_evaluation_review_run_insert") {
        const current = after.schema.find(
          (entry) => entry.type === "trigger" && entry.name === object.name,
        );
        expect(typeof current?.sql).toBe("string");
        let reverted = String(current?.sql);
        // Reverting exactly these three additions must recover every byte of the deployed
        // trigger, including all existing source, authorization, profile, and model guards.
        const versionExtensions = [
          [
            "json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IN ('EvaluationCellManifestV1', 'EvaluationCellManifestV2')",
            "json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV1'",
          ],
          [
            "(SELECT COUNT(*) FROM json_each(manifest_cell.value)) = 14 + (json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV2')",
            "(SELECT COUNT(*) FROM json_each(manifest_cell.value)) = 14",
          ],
          [
            "'renderedPromptDigest', 'outputSchemaDigest', 'modelRequirements', 'reproduction')",
            "'renderedPromptDigest', 'outputSchemaDigest', 'modelRequirements')",
          ],
        ] as const;
        for (const [expanded, original] of versionExtensions) {
          expect(reverted.split(expanded)).toHaveLength(2);
          reverted = reverted.replace(expanded, original);
        }
        expect(reverted).toBe(object.sql);
        continue;
      }
      expect(after.schema).toContainEqual(object);
    }
    const row = value.database
      .prepare("SELECT rowid,cell_manifest_json FROM evaluations WHERE id = ?")
      .get(value.evaluationId);
    expect(row?.rowid).toBe(4_000_000_041);
    expect(String(row?.cell_manifest_json)).toContain("EvaluationCellManifestV1");
    expect(JSON.parse(String(row?.cell_manifest_json)).schemaVersion).toBe(
      "EvaluationCellManifestV1",
    );
    expect(
      value.database.prepare("SELECT COUNT(*) AS count FROM evaluation_reproduction_cells").get()
        ?.count,
    ).toBe(0);
    expect(() =>
      value.database.exec("UPDATE evaluations SET cell_manifest_json = cell_manifest_json"),
    ).toThrow(/immutable/u);
    expect(() => value.database.exec("DELETE FROM evaluations")).toThrow();
    expect(runMigrations(value.database, value.directory)).toBe(33);
    expect(snapshot(value.database)).toEqual(after);
  });

  it.each([
    ["copy", "FROM evaluations;"],
    ["drop", "DROP TABLE evaluations;"],
    ["rename", "ALTER TABLE new_evaluations RENAME TO evaluations;"],
  ])(
    "rolls back schema, byte history and ledger after the %s phase fails",
    async (_phase, marker) => {
      const value = await fixture(),
        before = snapshot(value.database);
      const sql = await readFile(join(migrationDirectory, migrationName), "utf8");
      expect(sql.split(marker)).toHaveLength(2);
      await install(
        value.directory,
        sql.replace(marker, marker + "\nSELECT * FROM missing_reproduction_rebuild_fault;"),
      );
      const error = captureError(() => runMigrations(value.database, value.directory));
      expect(error.committed).toBe(false);
      expect(String(error.failures[0]?.error)).toContain("missing_reproduction_rebuild_fault");
      restored(value.database);
      expect(snapshot(value.database)).toEqual(before);
    },
  );

  it.each([
    ["index", "CREATE INDEX unknown_evaluation_index ON evaluations(created_at)"],
    ["view", "CREATE VIEW unknown_evaluation_view AS SELECT id FROM evaluations"],
    [
      "trigger",
      "CREATE TRIGGER unknown_evaluation_trigger AFTER INSERT ON jobs BEGIN SELECT id FROM evaluations; END",
    ],
    [
      "foreign key",
      "CREATE TABLE unknown_evaluation_child (evaluation_id TEXT REFERENCES evaluations(id))",
    ],
    ["temporary view", "CREATE TEMP VIEW unknown_evaluation_temp AS SELECT id FROM evaluations"],
  ])("rejects an unknown dependent %s before dropping retained guards", async (_kind, sql) => {
    const value = await fixture();
    value.database.exec(sql);
    const before = snapshot(value.database);
    await install(value.directory);
    const exec = vi.spyOn(value.database, "exec");
    const error = captureError(() => runMigrations(value.database, value.directory));
    expect(String(error.failures[0]?.error)).toMatch(
      /Unknown dependent|Unexpected .*foreign keys/u,
    );
    expect(exec.mock.calls.some(([statement]) => /^DROP /u.test(statement))).toBe(false);
    restored(value.database);
    expect(snapshot(value.database)).toEqual(before);
  });

  it("retains a caller-owned transaction and does not invoke migration actions", async () => {
    const value = await fixture();
    value.database.exec(
      "CREATE TEMP TABLE caller_marker(value TEXT); BEGIN IMMEDIATE; INSERT INTO caller_marker VALUES ('retained')",
    );
    const apply = vi.fn();
    const error = captureError(() =>
      runEvaluationReproductionRebuild(value.database, { isPending: () => true, apply }),
    );
    expect(error.committed).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(value.database.isTransaction).toBe(true);
    expect(value.database.prepare("SELECT value FROM caller_marker").get()?.value).toBe("retained");
    value.database.exec("ROLLBACK");
    restored(value.database);
  });

  it("rejects an unexpected deployed Run version predicate before dropping any retained guard", async () => {
    const value = await fixture();
    const trigger = value.database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'tr_evaluation_review_run_insert'",
      )
      .get()?.sql;
    if (typeof trigger !== "string") throw new Error("The synthetic Run trigger is missing.");
    value.database.exec("DROP TRIGGER tr_evaluation_review_run_insert");
    value.database.exec(
      trigger.replace(
        "json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV1'",
        "json_extract(evaluation.cell_manifest_json, '$.schemaVersion') = 'EvaluationCellManifestV1'",
      ),
    );
    const before = snapshot(value.database);
    await install(value.directory);
    const exec = vi.spyOn(value.database, "exec");
    const error = captureError(() => runMigrations(value.database, value.directory));
    expect(String(error.failures[0]?.error)).toContain(
      "Unexpected evaluation Run trigger definition",
    );
    expect(exec.mock.calls.some(([statement]) => /^DROP /u.test(statement))).toBe(false);
    restored(value.database);
    expect(snapshot(value.database)).toEqual(before);
  });

  it("rejects disabled foreign keys without changing the caller state", async () => {
    const value = await fixture();
    value.database.exec("PRAGMA foreign_keys = OFF");
    const apply = vi.fn();
    captureError(() =>
      runEvaluationReproductionRebuild(value.database, { isPending: () => true, apply }),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(value.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(0);
    value.database.exec("PRAGMA foreign_keys = ON");
  });

  it("reports a committed migration with failed foreign-key restoration as unconfirmed", async () => {
    const value = await fixture();
    await install(value.directory);
    const original = value.database.exec.bind(value.database);
    const spy = vi.spyOn(value.database, "exec").mockImplementation((sql) => {
      if (sql === "PRAGMA foreign_keys = ON") throw new Error("synthetic restoration failure");
      return original(sql);
    });
    const error = captureError(() => runMigrations(value.database, value.directory));
    expect(error.committed).toBe(true);
    expect(error.failures.map((failure) => failure.phase)).toEqual(["restore"]);
    spy.mockRestore();
    value.database.exec("PRAGMA foreign_keys = ON");
    expect(runMigrations(value.database, value.directory)).toBe(33);
    restored(value.database);
  });

  it("rejects a migration that changes unrelated historical bytes", async () => {
    const value = await fixture(),
      before = snapshot(value.database);
    const sql = await readFile(join(migrationDirectory, migrationName), "utf8");
    await install(
      value.directory,
      sql + "\nUPDATE managed_repositories SET updated_at = 'synthetic-corruption';",
    );
    const error = captureError(() => runMigrations(value.database, value.directory));
    expect(error.committed).toBe(false);
    expect(String(error.failures[0]?.error)).toContain("changed historical bytes");
    restored(value.database);
    expect(snapshot(value.database)).toEqual(before);
  });
});
