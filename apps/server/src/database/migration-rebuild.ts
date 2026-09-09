import type { DatabaseSync } from "node:sqlite";

interface SchemaObject {
  readonly schemaName: string;
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

interface ForeignKey {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
}

interface IndexDefinition {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

interface RebuildSnapshot {
  readonly objects: readonly SchemaObject[];
  readonly rowCounts: ReadonlyMap<string, bigint>;
  readonly childForeignKeys: ReadonlyMap<string, string>;
  readonly parentForeignKeys: readonly string[];
  readonly parentIndexes: ReadonlyMap<string, string>;
}

interface RebuildActions {
  // This rechecks and validates the migration ledger under BEGIN IMMEDIATE.
  readonly isPending: () => boolean;
  // The migration SQL and its ledger insert belong to this same transaction.
  readonly apply: () => void;
}

type FailurePhase = "primary" | "rollback" | "restore";
interface RebuildFailure {
  readonly phase: FailurePhase;
  readonly error: unknown;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class MigrationRebuildError extends AggregateError {
  public readonly committed: boolean;
  public readonly primaryError: unknown;
  public readonly rollbackError: unknown;
  public readonly restoreError: unknown;

  public constructor(committed: boolean, failures: readonly RebuildFailure[]) {
    super(
      failures.map((failure) => failure.error),
      `Prompt/profile evaluation migration ${committed ? "committed but startup failed" : "failed before commit"}: ${failures
        .map((failure) => `${failure.phase}: ${errorText(failure.error)}`)
        .join("; ")}`,
      { cause: failures[0]?.error },
    );
    this.name = "MigrationRebuildError";
    this.committed = committed;
    this.primaryError = failures.find((failure) => failure.phase === "primary")?.error;
    this.rollbackError = failures.find((failure) => failure.phase === "rollback")?.error;
    this.restoreError = failures.find((failure) => failure.phase === "restore")?.error;
  }
}

const parentTable = "review_runs";
const childTables = [
  "review_run_requests",
  "review_run_audit",
  "validation_job_results",
  "evidence_assets",
  "validation_control_audit",
  "github_review_run_activations",
  "review_run_decision_events",
  "finding_disposition_events",
  "finding_dispositions",
  "publication_intents",
  "notification_events",
] as const;

const expectedObjects = [
  ["index", "ix_review_runs_repository_history", parentTable],
  ["index", "ix_review_runs_work_item_history", parentTable],
  ["trigger", "tr_review_runs_immutable_update", parentTable],
  ["trigger", "tr_review_runs_immutable_delete", parentTable],
  ["trigger", "tr_review_run_request_consistency", "review_run_requests"],
  ["trigger", "tr_review_run_job_links_consistency", "review_run_job_links"],
  ["trigger", "tr_validation_job_result_insert_consistency", "validation_job_results"],
  ["trigger", "tr_job_success_review_result_consistency", "jobs"],
  ["trigger", "tr_evidence_asset_insert", "evidence_assets"],
  ["trigger", "tr_validation_control_audit_consistency", "validation_control_audit"],
  ["trigger", "tr_validation_dispatch_check_scope", "validation_dispatch_checks"],
  ["trigger", "tr_validation_dispatch_request_pending", "review_run_requests"],
  ["trigger", "tr_github_review_run_activation_insert", "github_review_run_activations"],
  ["trigger", "tr_review_run_decision_insert", "review_run_decision_events"],
  ["trigger", "tr_finding_disposition_event_insert", "finding_disposition_events"],
  ["trigger", "tr_publication_intent_insert", "publication_intents"],
  ["trigger", "tr_notification_event_insert", "notification_events"],
  ["trigger", "tr_notification_validation_terminal", "jobs"],
] as const;

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
const objectKey = (
  object: Pick<SchemaObject, "schemaName" | "type" | "name" | "tableName">,
): string => JSON.stringify([object.schemaName, object.type, object.name, object.tableName]);
// Conservative token matching also rejects unexpected references in SQL comments or literals.
const referencesParent = (sql: string | null): boolean => /\breview_runs\b/iu.test(sql ?? "");
const referencesReplacement = (value: string | null): boolean =>
  /\bnew_review_runs\b/iu.test(value ?? "");

const readObjects = (database: DatabaseSync): readonly SchemaObject[] =>
  database
    .prepare(`
    SELECT 'main' AS schemaName, type, name, tbl_name AS tableName, sql FROM main.sqlite_schema
    UNION ALL
    SELECT 'temp' AS schemaName, type, name, tbl_name AS tableName, sql FROM temp.sqlite_schema
    ORDER BY schemaName, type, name
  `)
    .all() as unknown as SchemaObject[];

const readForeignKeys = (database: DatabaseSync, table: string): readonly ForeignKey[] =>
  database
    .prepare("SELECT * FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq")
    .all(table) as unknown as ForeignKey[];

const foreignKeySignatures = (keys: readonly ForeignKey[]): readonly string[] => {
  const groups = new Map<number, Omit<ForeignKey, "id">[]>();
  for (const { id, ...key } of keys) {
    const group = groups.get(id) ?? [];
    group.push(key);
    groups.set(id, group);
  }
  return [...groups.values()].map((group) => JSON.stringify(group)).sort();
};

const readRowCount = (database: DatabaseSync, table: string): bigint => {
  const statement = database.prepare(
    `SELECT COUNT(*) AS count FROM main.${quoteIdentifier(table)}`,
  );
  statement.setReadBigInts(true);
  return (statement.get() as { readonly count: bigint }).count;
};

const readParentIndexes = (database: DatabaseSync): ReadonlyMap<string, string> => {
  const indexes = database
    .prepare(
      "SELECT name, [unique], origin, partial FROM pragma_index_list(?, 'main') ORDER BY name",
    )
    .all(parentTable) as unknown as IndexDefinition[];
  return new Map(
    indexes.map((index) => [
      index.name,
      JSON.stringify({
        ...index,
        columns: database
          .prepare(
            "SELECT seqno, cid, name, [desc], coll, [key] FROM pragma_index_xinfo(?, 'main') ORDER BY seqno",
          )
          .all(index.name),
      }),
    ]),
  );
};

const requireExpectedObjects = (objects: readonly SchemaObject[]): void => {
  for (const [type, name, tableName] of expectedObjects) {
    if (
      !objects.some(
        (object) =>
          object.schemaName === "main" &&
          object.type === type &&
          object.name === name &&
          object.tableName === tableName &&
          object.sql !== null,
      )
    ) {
      throw new Error(`Review run rebuild is missing expected ${type} ${name} on ${tableName}.`);
    }
  }
};

const requireNoReplacementReferences = (objects: readonly SchemaObject[]): void => {
  for (const object of objects) {
    if (
      referencesReplacement(object.name) ||
      referencesReplacement(object.tableName) ||
      referencesReplacement(object.sql)
    ) {
      throw new Error(
        `Review run rebuild contains a remaining new_review_runs reference: ${object.schemaName}.${object.name}.`,
      );
    }
  }
};

const requireParentTable = (database: DatabaseSync): void => {
  const table = database
    .prepare(
      "SELECT wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ? AND type = 'table'",
    )
    .get(parentTable) as { readonly wr: number; readonly strict: number } | undefined;
  if (table?.wr !== 0 || table.strict !== 1) {
    throw new Error("Review run rebuild requires the STRICT review_runs rowid table.");
  }
};

const inspectBeforeRebuild = (database: DatabaseSync): RebuildSnapshot => {
  const databases = database.prepare("PRAGMA database_list").all() as unknown as {
    readonly name: string;
  }[];
  if (databases.some((entry) => entry.name !== "main" && entry.name !== "temp")) {
    throw new Error("Review run rebuild does not permit attached databases.");
  }
  const objects = readObjects(database);
  requireNoReplacementReferences(objects);
  requireExpectedObjects(objects);
  requireParentTable(database);
  const allowedObjects = new Set<string>([
    ...[parentTable, ...childTables].map((name) =>
      objectKey({ schemaName: "main", type: "table", name, tableName: name }),
    ),
    ...expectedObjects.map(([type, name, tableName]) =>
      objectKey({ schemaName: "main", type, name, tableName }),
    ),
    ...[1, 2].map((ordinal) =>
      objectKey({
        schemaName: "main",
        type: "index",
        name: `sqlite_autoindex_review_runs_${ordinal}`,
        tableName: parentTable,
      }),
    ),
  ]);
  for (const object of objects) {
    if (
      (object.tableName === parentTable || referencesParent(object.sql)) &&
      !allowedObjects.has(objectKey(object))
    ) {
      throw new Error(
        `Review run rebuild found an unknown dependent schema object: ${object.schemaName}.${object.name}.`,
      );
    }
  }

  const expectedChildren = new Set<string>(childTables);
  const inbound = database
    .prepare(`
    SELECT schema.name AS childTable, fk.[from] AS childColumn, fk.[to] AS parentColumn
    FROM main.sqlite_schema AS schema, pragma_foreign_key_list(schema.name, 'main') AS fk
    WHERE schema.type = 'table' AND lower(fk.[table]) = ?
    ORDER BY schema.name, fk.id, fk.seq
  `)
    .all(parentTable) as unknown as {
    readonly childTable: string;
    readonly childColumn: string;
    readonly parentColumn: string;
  }[];
  if (
    inbound.length !== childTables.length ||
    inbound.some(
      (key) =>
        !expectedChildren.delete(key.childTable) ||
        key.childColumn !== "review_run_id" ||
        key.parentColumn !== "id",
    ) ||
    expectedChildren.size !== 0
  ) {
    throw new Error("Review run rebuild found an unexpected inbound foreign-key inventory.");
  }

  return {
    objects,
    rowCounts: new Map(
      [parentTable, ...childTables].map((table) => [table, readRowCount(database, table)]),
    ),
    childForeignKeys: new Map(
      childTables.map((table) => [table, JSON.stringify(readForeignKeys(database, table))]),
    ),
    parentForeignKeys: foreignKeySignatures(readForeignKeys(database, parentTable)),
    parentIndexes: readParentIndexes(database),
  };
};

const inspectAfterRebuild = (database: DatabaseSync, before: RebuildSnapshot): void => {
  const objects = readObjects(database);
  requireNoReplacementReferences(objects);
  requireExpectedObjects(objects);
  requireParentTable(database);
  const replacedObjects = new Set<string>([
    objectKey({ schemaName: "main", type: "table", name: parentTable, tableName: parentTable }),
    ...expectedObjects.map(([type, name, tableName]) =>
      objectKey({ schemaName: "main", type, name, tableName }),
    ),
  ]);
  for (const previous of before.objects) {
    const current = objects.find(
      (object) =>
        object.schemaName === previous.schemaName &&
        object.type === previous.type &&
        object.name === previous.name &&
        object.tableName === previous.tableName,
    );
    if (
      current === undefined ||
      (!replacedObjects.has(objectKey(previous)) && current.sql !== previous.sql)
    ) {
      throw new Error(
        `Review run rebuild lost or changed an unrelated schema object: ${previous.schemaName}.${previous.name}.`,
      );
    }
  }
  for (const table of childTables) {
    const previous = before.objects.find(
      (object) => object.schemaName === "main" && object.type === "table" && object.name === table,
    );
    const current = objects.find(
      (object) => object.schemaName === "main" && object.type === "table" && object.name === table,
    );
    if (
      previous === undefined ||
      current?.sql !== previous.sql ||
      JSON.stringify(readForeignKeys(database, table)) !== before.childForeignKeys.get(table)
    ) {
      throw new Error(
        `Review run rebuild changed the existing child table or foreign keys: ${table}.`,
      );
    }
  }
  for (const [table, count] of before.rowCounts) {
    if (readRowCount(database, table) !== count) {
      throw new Error(`Review run rebuild changed the existing row count: ${table}.`);
    }
  }
  const parentKeys = new Set(foreignKeySignatures(readForeignKeys(database, parentTable)));
  if (before.parentForeignKeys.some((key) => !parentKeys.has(key))) {
    throw new Error("Review run rebuild lost an existing parent foreign key.");
  }
  const indexes = readParentIndexes(database);
  for (const [name, definition] of before.parentIndexes) {
    if (indexes.get(name) !== definition) {
      throw new Error(
        `Review run rebuild changed an existing index or unique constraint: ${name}.`,
      );
    }
  }
};

const requireForeignKeys = (database: DatabaseSync, expected: 0 | 1): void => {
  const row = database.prepare("PRAGMA foreign_keys").get() as
    | { readonly foreign_keys: number }
    | undefined;
  if (row?.foreign_keys !== expected) {
    throw new Error(
      `Review run rebuild requires PRAGMA foreign_keys = ${expected}; read back ${String(row?.foreign_keys)}.`,
    );
  }
};

const requireRestoredTransactionState = (database: DatabaseSync): void => {
  if (database.isTransaction) {
    throw new Error("Review run rebuild left an active transaction after foreign-key restoration.");
  }
};

// Only the exact pending M28 migration is routed here by runMigrations. This helper
// owns its transaction and is called before the database owner announces readiness.
export const runPromptProfileEvaluationRebuild = (
  database: DatabaseSync,
  actions: RebuildActions,
): void => {
  const failures: RebuildFailure[] = [];
  let restoreRequired = false;
  let transactionStarted = false;
  let committed = false;
  try {
    if (database.isTransaction) {
      throw new Error(
        "Review run rebuild requires no active transaction before disabling foreign keys.",
      );
    }
    requireForeignKeys(database, 1);
    restoreRequired = true;
    database.exec("PRAGMA foreign_keys = OFF");
    requireForeignKeys(database, 0);
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    if (actions.isPending()) {
      const before = inspectBeforeRebuild(database);
      actions.apply();
      if (!database.isTransaction)
        throw new Error("Review run rebuild unexpectedly ended its transaction.");
      // get() stops at the first violation instead of materializing all invalid rows.
      const violation = database.prepare("PRAGMA foreign_key_check").get();
      if (violation !== undefined) {
        throw new Error(
          `Review run rebuild failed foreign_key_check: ${JSON.stringify(violation)}.`,
        );
      }
      inspectAfterRebuild(database, before);
    }
    requireForeignKeys(database, 0);
    database.exec("COMMIT");
    committed = true;
  } catch (error) {
    failures.push({ phase: "primary", error });
    if (transactionStarted) {
      try {
        if (database.isTransaction) database.exec("ROLLBACK");
      } catch (rollbackError) {
        failures.push({ phase: "rollback", error: rollbackError });
      }
    }
  } finally {
    if (restoreRequired) {
      try {
        database.exec("PRAGMA foreign_keys = ON");
        requireForeignKeys(database, 1);
        requireRestoredTransactionState(database);
      } catch (restoreError) {
        failures.push({ phase: "restore", error: restoreError });
      }
    }
  }
  if (failures.length !== 0) throw new MigrationRebuildError(committed, failures);
};
