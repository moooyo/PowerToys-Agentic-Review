import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

interface SchemaObject {
  readonly schemaName: string;
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}
interface RebuildActions {
  readonly isPending: () => boolean;
  readonly apply: () => void;
}
interface RebuildFailure {
  readonly phase: "primary" | "rollback" | "restore";
  readonly error: unknown;
}
export class ValidationResultRebuildError extends AggregateError {
  readonly committed: boolean;
  constructor(
    committed: boolean,
    readonly failures: readonly RebuildFailure[],
  ) {
    super(
      failures.map((failure) => failure.error),
      "Validation result migration could not confirm its transaction and restored foreign keys.",
      { cause: failures[0]?.error },
    );
    this.name = "ValidationResultRebuildError";
    this.committed = committed;
  }
}

const parent = "validation_job_results";
const replacement = "new_validation_job_results";
const children = [
  "evaluation_adjudication_events",
  "finding_disposition_events",
  "finding_dispositions",
] as const;
const restoredObjects = [
  ["index", "ix_validation_job_results_review_run", parent],
  ["index", "ix_validation_job_results_work_item_created", parent],
  ["trigger", "tr_evaluation_adjudication_insert", "evaluation_adjudication_events"],
  ["trigger", "tr_finding_disposition_event_insert", "finding_disposition_events"],
  ["trigger", "tr_job_success_review_result_consistency", "jobs"],
  ["trigger", "tr_notification_validation_terminal", "jobs"],
  ["trigger", "tr_review_result_reject_validation_job", "review_results"],
  ["trigger", "tr_run_attempt_completed_validation_identity_immutable", "run_attempts"],
  ["trigger", "tr_validation_job_result_insert_consistency", parent],
  ["trigger", "tr_validation_job_results_immutable_delete", parent],
  ["trigger", "tr_validation_job_results_immutable_update", parent],
  ["trigger", "tr_validation_result_evidence_references", parent],
  [
    "trigger",
    "tr_work_item_revision_completed_validation_identity_immutable",
    "work_item_revisions",
  ],
] as const;
const addedTrigger = "tr_validation_job_result_v2_binding";
const objectKey = (
  object: Pick<SchemaObject, "schemaName" | "type" | "name" | "tableName">,
): string => JSON.stringify([object.schemaName, object.type, object.name, object.tableName]);
const restoredObjectKeys = new Set(
  restoredObjects.map(([type, name, tableName]) =>
    objectKey({ schemaName: "main", type, name, tableName }),
  ),
);
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const foreignKeys = (database: DatabaseSync, value: 0 | 1): void => {
  const row = database.prepare("PRAGMA foreign_keys").get();
  if (row?.foreign_keys !== value) throw new Error("Unexpected migration foreign-key state.");
};
const requireClosedTransaction = (database: DatabaseSync): void => {
  if (database.isTransaction)
    throw new Error("Validation result rebuild left an active transaction.");
};
const objects = (database: DatabaseSync): readonly SchemaObject[] =>
  database
    .prepare(`SELECT 'main' AS schemaName, type, name, tbl_name AS tableName, sql
    FROM main.sqlite_schema UNION ALL
    SELECT 'temp' AS schemaName, type, name, tbl_name AS tableName, sql FROM temp.sqlite_schema
    ORDER BY schemaName, type, name`)
    .all() as unknown as SchemaObject[];
const tableForeignKeys = (database: DatabaseSync, table: string): string =>
  JSON.stringify(
    database
      .prepare("SELECT * FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq")
      .all(table),
  );

function tableRowsDigest(database: DatabaseSync, table: string): string {
  const columns = database
    .prepare("SELECT name, pk FROM pragma_table_info(?, 'main') ORDER BY cid")
    .all(table) as unknown as { name: string; pk: number }[];
  const state = database
    .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
    .get(table);
  const order =
    state?.wr === 1
      ? columns
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => quote(column.name))
          .join(",")
      : "rowid";
  if (order.length === 0 || columns.length === 0)
    throw new Error("Unexpected migration table shape.");
  // Read SQLite's actual TEXT/BLOB bytes as hex, rather than hashing Node-decoded text.
  // Type markers distinguish nulls and numeric values without losing large rowid precision.
  const names = [...(state?.wr === 1 ? [] : ["rowid"]), ...columns.map((column) => column.name)];
  const projection = names
    .flatMap((name, index) => [
      `typeof(${quote(name)}) AS ${quote(`column_${index}_type`)}`,
      `hex(CAST(${quote(name)} AS BLOB)) AS ${quote(`column_${index}_bytes`)}`,
    ])
    .join(",");
  const statement = database.prepare(
    `SELECT ${projection} FROM main.${quote(table)} ORDER BY ${order}`,
  );
  const digest = createHash("sha256");
  for (const row of statement.iterate()) {
    digest.update(`${JSON.stringify(row)}\n`);
  }
  return digest.digest("hex");
}

function indexShapes(database: DatabaseSync): string {
  const indexes = database
    .prepare(
      "SELECT name, [unique], origin, partial FROM pragma_index_list(?, 'main') ORDER BY name",
    )
    .all(parent);
  return JSON.stringify(
    indexes.map((index) => ({
      ...index,
      columns: database
        .prepare("SELECT * FROM pragma_index_xinfo(?, 'main') ORDER BY seqno")
        .all(String(index.name)),
    })),
  );
}

function inspect(database: DatabaseSync) {
  if (
    database
      .prepare("PRAGMA database_list")
      .all()
      .some((entry) => !["main", "temp"].includes(String(entry.name)))
  )
    throw new Error("Validation result rebuild does not permit attached databases.");
  const all = objects(database);
  const allowed = new Set<string>([
    ...[parent, ...children].map((name) =>
      objectKey({ schemaName: "main", type: "table", name, tableName: name }),
    ),
    ...restoredObjectKeys,
    ...[1, 2, 3].map((ordinal) =>
      objectKey({
        schemaName: "main",
        type: "index",
        name: `sqlite_autoindex_validation_job_results_${ordinal}`,
        tableName: parent,
      }),
    ),
  ]);
  for (const object of all) {
    if (/\bnew_validation_job_results\b/iu.test(`${object.name} ${object.sql ?? ""}`))
      throw new Error("A validation result replacement already exists.");
    if (
      (object.tableName === parent || /\bvalidation_job_results\b/iu.test(object.sql ?? "")) &&
      !allowed.has(objectKey(object))
    )
      throw new Error(`Unknown dependent validation result schema object: ${object.name}`);
  }
  for (const [type, name, tableName] of restoredObjects)
    if (
      !all.some(
        (object) =>
          object.schemaName === "main" &&
          object.type === type &&
          object.name === name &&
          object.tableName === tableName &&
          object.sql !== null,
      )
    )
      throw new Error(`Missing validation result schema object: ${name}`);
  const state = database
    .prepare(
      "SELECT wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ? AND type = 'table'",
    )
    .get(parent);
  if (state?.wr !== 0 || state.strict !== 1)
    throw new Error("Validation result rebuild requires its STRICT rowid table.");
  const inbound = database
    .prepare(`SELECT schema.name AS child, fk.[from] AS childColumn, fk.[to] AS parentColumn
    FROM main.sqlite_schema AS schema, pragma_foreign_key_list(schema.name, 'main') AS fk
    WHERE schema.type = 'table' AND lower(fk.[table]) = ? ORDER BY schema.name, fk.id, fk.seq`)
    .all(parent);
  if (
    JSON.stringify(inbound) !==
    JSON.stringify(
      children.map((child) => ({ child, childColumn: "result_id", parentColumn: "id" })),
    )
  )
    throw new Error("Unexpected validation result inbound foreign keys.");
  return {
    objects: all,
    rows: new Map([parent, ...children].map((table) => [table, tableRowsDigest(database, table)])),
    foreignKeys: new Map(
      [parent, ...children].map((table) => [table, tableForeignKeys(database, table)]),
    ),
    indexes: indexShapes(database),
    columns: JSON.stringify(
      database.prepare("SELECT * FROM pragma_table_xinfo(?, 'main') ORDER BY cid").all(parent),
    ),
  };
}

function checkAfter(database: DatabaseSync, before: ReturnType<typeof inspect>): void {
  const after = objects(database);
  for (const old of before.objects) {
    const current = after.find(
      (item) =>
        item.schemaName === old.schemaName &&
        item.type === old.type &&
        item.name === old.name &&
        item.tableName === old.tableName,
    );
    const parentObject =
      old.schemaName === "main" &&
      old.type === "table" &&
      old.name === parent &&
      old.tableName === parent;
    if (!current || (!parentObject && current.sql !== old.sql))
      throw new Error(`Validation result rebuild lost or changed a schema object: ${old.name}`);
  }
  if (
    after.length !== before.objects.length + 1 ||
    !after.some(
      (entry) =>
        entry.schemaName === "main" &&
        entry.name === addedTrigger &&
        entry.type === "trigger" &&
        entry.tableName === parent &&
        entry.sql !== null,
    ) ||
    after.some(
      (entry) =>
        entry.name === replacement || /\bnew_validation_job_results\b/iu.test(entry.sql ?? ""),
    )
  )
    throw new Error("Unexpected validation result schema after rebuild.");
  for (const [table, digest] of before.rows)
    if (
      tableRowsDigest(database, table) !== digest ||
      tableForeignKeys(database, table) !== before.foreignKeys.get(table)
    )
      throw new Error(
        `Validation result rebuild changed historical bytes, rowids or foreign keys: ${table}`,
      );
  if (
    indexShapes(database) !== before.indexes ||
    JSON.stringify(
      database.prepare("SELECT * FROM pragma_table_xinfo(?, 'main') ORDER BY cid").all(parent),
    ) !== before.columns
  )
    throw new Error("Validation result rebuild changed existing columns or indexes.");
  const table = database
    .prepare(
      "SELECT wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ? AND type = 'table'",
    )
    .get(parent);
  if (table?.wr !== 0 || table.strict !== 1)
    throw new Error("Validation result rebuild changed the STRICT rowid table mode.");
}

/** Only the exact pending result-version migration may use this startup-owned transaction. */
export function runValidationResultRebuild(database: DatabaseSync, actions: RebuildActions): void {
  const failures: RebuildFailure[] = [];
  let restoreRequired = false;
  let committed = false;
  let transactionStarted = false;
  try {
    if (database.isTransaction)
      throw new Error("Validation result rebuild requires no active transaction.");
    foreignKeys(database, 1);
    restoreRequired = true;
    database.exec("PRAGMA foreign_keys = OFF");
    foreignKeys(database, 0);
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    if (actions.isPending()) {
      const before = inspect(database);
      // Reuse the exact current definitions, including the Evaluation insertion fence. Do not restore
      // historical trigger text from the original V1 table migration.
      const retained = before.objects.filter((entry) => restoredObjectKeys.has(objectKey(entry)));
      for (const object of retained)
        database.exec(`DROP ${object.type.toUpperCase()} ${quote(object.name)}`);
      actions.apply();
      if (!database.isTransaction)
        throw new Error("Validation result SQL ended its migration transaction.");
      for (const object of retained) {
        if (object.sql === null) throw new Error("A retained schema object has no definition.");
        database.exec(object.sql);
      }
      if (database.prepare("PRAGMA foreign_key_check").get() !== undefined)
        throw new Error("Validation result rebuild failed foreign_key_check.");
      checkAfter(database, before);
    }
    foreignKeys(database, 0);
    database.exec("COMMIT");
    committed = true;
  } catch (error) {
    failures.push({ phase: "primary", error });
    try {
      if (transactionStarted && database.isTransaction) database.exec("ROLLBACK");
    } catch (error) {
      failures.push({ phase: "rollback", error });
    }
  } finally {
    if (restoreRequired) {
      try {
        database.exec("PRAGMA foreign_keys = ON");
        foreignKeys(database, 1);
        requireClosedTransaction(database);
      } catch (error) {
        failures.push({ phase: "restore", error });
      }
    }
  }
  if (failures.length > 0) throw new ValidationResultRebuildError(committed, failures);
}
