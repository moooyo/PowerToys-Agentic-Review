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
export class EvaluationReproductionRebuildError extends AggregateError {
  readonly committed: boolean;
  constructor(
    committed: boolean,
    readonly failures: readonly RebuildFailure[],
  ) {
    super(
      failures.map((failure) => failure.error),
      "Evaluation reproduction migration could not confirm its transaction and restored foreign keys.",
      { cause: failures[0]?.error },
    );
    this.name = "EvaluationReproductionRebuildError";
    this.committed = committed;
  }
}

const parent = "evaluations";
const replacement = "new_evaluations";
const children = [
  "evaluation_assessments",
  "evaluation_authorizations",
  "evaluation_cells",
  "evaluation_seals",
  "model_summary_inputs",
] as const;
const restoredObjects = [
  ["index", "ix_evaluations_repository_history", parent],
  ["trigger", "tr_evaluation_assessment_insert", "evaluation_assessments"],
  ["trigger", "tr_evaluation_authorization_insert", "evaluation_authorizations"],
  ["trigger", "tr_evaluation_cell_insert", "evaluation_cells"],
  ["trigger", "tr_evaluation_insert", parent],
  ["trigger", "tr_evaluation_review_run_insert", "review_runs"],
  ["trigger", "tr_evaluation_runtime_registration_insert", parent],
  ["trigger", "tr_evaluation_seal_insert", "evaluation_seals"],
  ["trigger", "tr_evaluations_no_replace", parent],
  ["trigger", "tr_evaluations_immutable_delete", parent],
  ["trigger", "tr_evaluations_immutable_update", parent],
  ["trigger", "tr_job_success_review_result_consistency", "jobs"],
  ["trigger", "tr_model_invocation_opening_consistency", "model_invocation_openings"],
  ["trigger", "tr_model_invocation_seal_consistency", "model_invocation_seals"],
  ["trigger", "tr_model_invocation_submission_consistency", "model_invocation_submissions"],
  ["trigger", "tr_model_summary_input_consistency", "model_summary_inputs"],
  ["trigger", "tr_review_run_job_links_consistency", "review_run_job_links"],
  ["trigger", "tr_validation_job_result_insert_consistency", "validation_job_results"],
] as const;
const sidecars = [
  "evaluation_reproduction_sources",
  "evaluation_reproduction_cells",
  "evaluation_reproduction_manifests",
] as const;
const addedObjects = [
  ...sidecars.map((name) => ["table", name, name] as const),
  ...sidecars.flatMap((table) =>
    ["no_replace", "no_update", "no_delete", "consistency"].map(
      (suffix) => ["trigger", `tr_${table}_${suffix}`, table] as const,
    ),
  ),
  ...sidecars.flatMap((table) =>
    [1, 2].map((ordinal) => ["index", `sqlite_autoindex_${table}_${ordinal}`, table] as const),
  ),
  ["trigger", "tr_evaluation_reproduction_manifest_version", parent],
  ["trigger", "tr_evaluation_reproduction_run", "review_runs"],
  ["trigger", "tr_evaluation_reproduction_seal", "evaluation_seals"],
] as const;
const objectKey = (
  object: Pick<SchemaObject, "schemaName" | "type" | "name" | "tableName">,
): string => JSON.stringify([object.schemaName, object.type, object.name, object.tableName]);
const evaluationRunTrigger = "tr_evaluation_review_run_insert";
const runTriggerVersionChanges = [
  [
    "json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV1'",
    "json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IN ('EvaluationCellManifestV1', 'EvaluationCellManifestV2')",
  ],
  [
    "(SELECT COUNT(*) FROM json_each(manifest_cell.value)) = 14",
    "(SELECT COUNT(*) FROM json_each(manifest_cell.value)) = 14 + (json_extract(evaluation.cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV2')",
  ],
  [
    "'renderedPromptDigest', 'outputSchemaDigest', 'modelRequirements')",
    "'renderedPromptDigest', 'outputSchemaDigest', 'modelRequirements', 'reproduction')",
  ],
] as const;
function retainedSql(object: SchemaObject): string {
  if (object.sql === null) throw new Error("A retained schema object has no definition.");
  if (object.name !== evaluationRunTrigger) return object.sql;
  let sql = object.sql;
  // Every old predicate remains intact except the three version/shape extensions required
  // for the separately guarded V2 cell. Refuse unexpected deployed trigger definitions.
  for (const [previous, current] of runTriggerVersionChanges) {
    if (sql.split(previous).length !== 2)
      throw new Error(
        "Unexpected evaluation Run trigger definition before reproduction migration.",
      );
    sql = sql.replace(previous, current);
  }
  return sql;
}
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
    throw new Error("Evaluation reproduction rebuild left an active transaction.");
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
    throw new Error("Evaluation reproduction rebuild does not permit attached databases.");
  const all = objects(database);
  const allowed = new Set<string>([
    ...[parent, ...children].map((name) =>
      objectKey({ schemaName: "main", type: "table", name, tableName: name }),
    ),
    ...restoredObjectKeys,
    ...[1, 2].map((ordinal) =>
      objectKey({
        schemaName: "main",
        type: "index",
        name: `sqlite_autoindex_evaluations_${ordinal}`,
        tableName: parent,
      }),
    ),
  ]);
  for (const object of all) {
    if (/\bnew_evaluations\b/iu.test(`${object.name} ${object.sql ?? ""}`))
      throw new Error("An evaluation reproduction replacement already exists.");
    if (
      (object.tableName === parent || /\bevaluations\b/iu.test(object.sql ?? "")) &&
      !allowed.has(objectKey(object))
    )
      throw new Error(`Unknown dependent evaluation reproduction schema object: ${object.name}`);
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
      throw new Error(`Missing evaluation reproduction schema object: ${name}`);
  for (const object of all) if (restoredObjectKeys.has(objectKey(object))) retainedSql(object);
  const state = database
    .prepare(
      "SELECT wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ? AND type = 'table'",
    )
    .get(parent);
  if (state?.wr !== 0 || state.strict !== 1)
    throw new Error("Evaluation reproduction rebuild requires its STRICT rowid table.");
  const inbound = database
    .prepare(`SELECT schema.name AS child, fk.[from] AS childColumn, fk.[to] AS parentColumn
    FROM main.sqlite_schema AS schema, pragma_foreign_key_list(schema.name, 'main') AS fk
    WHERE schema.type = 'table' AND lower(fk.[table]) = ? ORDER BY schema.name, fk.id, fk.seq`)
    .all(parent);
  const expectedInbound = children.flatMap((child) => [
    { child, childColumn: "evaluation_id", parentColumn: "id" },
    ...(["evaluation_assessments", "evaluation_authorizations", "evaluation_cells"].includes(child)
      ? [{ child, childColumn: "repository_id", parentColumn: "repository_id" }]
      : []),
  ]);
  if (JSON.stringify(inbound) !== JSON.stringify(expectedInbound))
    throw new Error("Unexpected evaluation reproduction inbound foreign keys.");
  const existingTables = all
    .filter(
      (object) =>
        object.schemaName === "main" &&
        object.type === "table" &&
        object.name !== "schema_migrations",
    )
    .map((object) => object.name);
  return {
    objects: all,
    rows: new Map(existingTables.map((table) => [table, tableRowsDigest(database, table)])),
    foreignKeys: new Map(existingTables.map((table) => [table, tableForeignKeys(database, table)])),
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
    const expectedSql = restoredObjectKeys.has(objectKey(old)) ? retainedSql(old) : old.sql;
    if (!current || (!parentObject && current.sql !== expectedSql))
      throw new Error(
        `Evaluation reproduction rebuild lost or changed a schema object: ${old.name}`,
      );
  }
  const expectedNew = new Set(
    addedObjects.map(([type, name, tableName]) =>
      objectKey({ schemaName: "main", type, name, tableName }),
    ),
  );
  const oldKeys = new Set(before.objects.map(objectKey));
  const actualNew = after.filter((object) => !oldKeys.has(objectKey(object)));
  if (
    actualNew.length !== expectedNew.size ||
    actualNew.some((object) => !expectedNew.has(objectKey(object))) ||
    after.some(
      (entry) => entry.name === replacement || /\bnew_evaluations\b/iu.test(entry.sql ?? ""),
    )
  )
    throw new Error("Unexpected evaluation reproduction schema after rebuild.");
  for (const table of sidecars)
    if (database.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get() !== undefined)
      throw new Error("Evaluation reproduction migration cannot synthesize historical sidecars.");
  const previousTable = before.objects.find(
    (object) => object.schemaName === "main" && object.type === "table" && object.name === parent,
  )?.sql;
  const currentTable = after.find(
    (object) => object.schemaName === "main" && object.type === "table" && object.name === parent,
  )?.sql;
  const oldVersionCheck =
    "json_extract(cell_manifest_json, '$.schemaVersion') IS 'EvaluationCellManifestV1'";
  if (
    previousTable === null ||
    previousTable === undefined ||
    currentTable === null ||
    currentTable === undefined ||
    previousTable.split(oldVersionCheck).length !== 2 ||
    previousTable
      .slice(previousTable.indexOf("("))
      .replaceAll("\r\n", "\n")
      .replace(
        oldVersionCheck,
        "json_extract(cell_manifest_json, '$.schemaVersion') IN ('EvaluationCellManifestV1', 'EvaluationCellManifestV2')",
      ) !== currentTable.slice(currentTable.indexOf("(")).replaceAll("\r\n", "\n")
  )
    throw new Error("Evaluation reproduction rebuild changed an unrelated parent constraint.");
  for (const [table, digest] of before.rows)
    if (
      tableRowsDigest(database, table) !== digest ||
      tableForeignKeys(database, table) !== before.foreignKeys.get(table)
    )
      throw new Error(
        `Evaluation reproduction rebuild changed historical bytes, rowids or foreign keys: ${table}`,
      );
  if (
    indexShapes(database) !== before.indexes ||
    JSON.stringify(
      database.prepare("SELECT * FROM pragma_table_xinfo(?, 'main') ORDER BY cid").all(parent),
    ) !== before.columns
  )
    throw new Error("Evaluation reproduction rebuild changed existing columns or indexes.");
  const table = database
    .prepare(
      "SELECT wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ? AND type = 'table'",
    )
    .get(parent);
  if (table?.wr !== 0 || table.strict !== 1)
    throw new Error("Evaluation reproduction rebuild changed the STRICT rowid table mode.");
}

/** Only the exact pending reproduction migration may use this startup-owned transaction. */
export function runEvaluationReproductionRebuild(
  database: DatabaseSync,
  actions: RebuildActions,
): void {
  const failures: RebuildFailure[] = [];
  let restoreRequired = false;
  let committed = false;
  let transactionStarted = false;
  try {
    if (database.isTransaction)
      throw new Error("Evaluation reproduction rebuild requires no active transaction.");
    foreignKeys(database, 1);
    restoreRequired = true;
    database.exec("PRAGMA foreign_keys = OFF");
    foreignKeys(database, 0);
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    if (actions.isPending()) {
      const before = inspect(database);
      // Retain current guards, including runtime and completion fences. Only the exact
      // Run manifest version, entry count, and key allowlist receive the V2 extension.
      const retained = before.objects.filter((entry) => restoredObjectKeys.has(objectKey(entry)));
      for (const object of retained)
        database.exec(`DROP ${object.type.toUpperCase()} ${quote(object.name)}`);
      actions.apply();
      if (!database.isTransaction)
        throw new Error("Evaluation reproduction SQL ended its migration transaction.");
      for (const object of retained) {
        database.exec(retainedSql(object));
      }
      if (database.prepare("PRAGMA foreign_key_check").get() !== undefined)
        throw new Error("Evaluation reproduction rebuild failed foreign_key_check.");
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
  if (failures.length > 0) throw new EvaluationReproductionRebuildError(committed, failures);
}
