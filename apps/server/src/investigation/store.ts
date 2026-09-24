import { DatabaseSync } from "node:sqlite";
import { legacySupersededCommentDeliveryReason } from "./comment-delivery-state.js";

export const investigationSchemaVersion = "investigation-v5";

const investigationV2Collections = [
  "repositories",
  "workItems",
  "tasks",
  "attempts",
  "checkpoints",
  "reportParts",
  "reports",
  "findings",
  "plans",
  "actionIntents",
  "idempotency",
  "evidenceAssets",
  "evidenceMetadata",
  "evidencePins",
  "evidenceUsage",
  "findingEvents",
  "sourceSnapshots",
] as const;

const investigationV3Collections = [...investigationV2Collections, "commentDeliveries"] as const;

const investigationV4Collections = [
  ...investigationV3Collections,
  "resourceLeases",
  "schedulerSettings",
] as const;

export const investigationCollections = [
  ...investigationV4Collections,
  "outputEvents",
  "outputStreams",
  "outputBatches",
  "reportDirectory",
] as const;

export type InvestigationCollection = (typeof investigationCollections)[number];

export type InvestigationStoreErrorCode =
  | "conflict"
  | "incompatible_schema"
  | "invalid_collection"
  | "invalid_value"
  | "transaction_state";

export class InvestigationStoreError extends Error {
  constructor(
    readonly code: InvestigationStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InvestigationStoreError";
  }
}

const collections = new Set<string>(investigationCollections);
const metadataTable = "investigation_metadata";
const metadataDefinition = `CREATE TABLE "${metadataTable}" (
  "key" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL
) STRICT`;

const deliveryIndexes = new Map([
  [
    "comment_deliveries_time",
    `CREATE INDEX "comment_deliveries_time" ON "commentDeliveries" (json_extract("value", '$.startedAt') DESC, "id" DESC)`,
  ],
  ...["repositoryId", "taskId", "commentId"].map((field): [string, string] => [
    `comment_deliveries_${field}`,
    `CREATE INDEX "comment_deliveries_${field}" ON "commentDeliveries" (json_extract("value", '$.${field}'), json_extract("value", '$.startedAt') DESC, "id" DESC)`,
  ]),
]);

const workspaceIndexes = new Map<string, string>([
  [
    "output_events_attempt_sequence",
    `CREATE UNIQUE INDEX "output_events_attempt_sequence" ON "outputEvents" (json_extract("value", '$.attemptId'), json_extract("value", '$.producerSequence'))`,
  ],
  [
    "output_events_retention",
    `CREATE INDEX "output_events_retention" ON "outputEvents" (json_extract("value", '$.receivedAt'), "id")`,
  ],
  [
    "evidence_metadata_task",
    `CREATE INDEX "evidence_metadata_task" ON "evidenceMetadata" (json_extract("value", '$.artifact.taskId'), "id")`,
  ],
  [
    "report_directory_repository",
    `CREATE INDEX "report_directory_repository" ON "reportDirectory" (json_extract("value", '$.context.repository.id'), "id")`,
  ],
  [
    "work_items_repository",
    `CREATE INDEX "work_items_repository" ON "workItems" (json_extract("value", '$.repositoryId'), "id")`,
  ],
  [
    "tasks_repository",
    `CREATE INDEX "tasks_repository" ON "tasks" (json_extract("value", '$.repository.id'), "id")`,
  ],
  [
    "publications_repository",
    `CREATE INDEX "publications_repository" ON "idempotency" (json_extract("value", '$.repository.id'), "id") WHERE ("id" GLOB 'auto-reply:report:*' OR "id" GLOB 'progress-reply:assignment:*' OR "id" GLOB 'progress-reply:task:*')`,
  ],
]);

export interface InvestigationWorkspacePage {
  readonly repositoryIds: readonly string[];
  readonly afterId?: string;
  readonly limit: number;
  readonly workItemId?: string;
  readonly workItemKind?: "pull_request" | "issue";
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly kind?: string;
  readonly search?: string;
  readonly delivery?: string;
  readonly completeness?: string;
}

export interface InvestigationCommentDeliveryPage {
  readonly repositoryIds?: readonly string[];
  readonly taskId?: string;
  readonly commentId?: string;
  readonly workItemNumber?: number;
  readonly state?: string;
  readonly mode?: string;
  readonly before?: { readonly startedAt: string; readonly id: string };
  readonly limit: number;
}

function collectionName(collection: InvestigationCollection): string {
  if (!collections.has(collection)) {
    throw new InvestigationStoreError("invalid_collection", "Unknown investigation collection.");
  }
  return `"${collection}"`;
}

function collectionDefinition(collection: InvestigationCollection): string {
  return `CREATE TABLE ${collectionName(collection)} (
    "id" TEXT PRIMARY KEY NOT NULL,
    "value" TEXT NOT NULL CHECK (json_valid("value"))
  ) STRICT`;
}

function normalizeDefinition(definition: string): string {
  return definition.replace(/\s+/gu, " ").trim().toLowerCase();
}

function serialize(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch (cause) {
    throw new InvestigationStoreError("invalid_value", "Value must be JSON serializable.", {
      cause,
    });
  }
  throw new InvestigationStoreError("invalid_value", "Value must be JSON serializable.");
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) {
    return false;
  }
  // SQLite extended result codes for primary-key and unique-index conflicts.
  return error.errcode === 1555 || error.errcode === 2067;
}

function isPromiseLike(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Stores JSON entities; services own relationships, authorization, and report immutability. */
export class InvestigationStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path = ":memory:") {
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    try {
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.transaction(() => this.initializeSchema());
      this.database.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    if (this.database.isTransaction) {
      throw new InvestigationStoreError(
        "transaction_state",
        "Cannot close the investigation store inside a transaction.",
      );
    }
    this.database.close();
    this.closed = true;
  }

  get inTransaction(): boolean {
    return this.database.isTransaction;
  }

  /** The callback must finish synchronously; nested transactions are rejected. */
  transaction<T>(fn: () => T): T {
    if (this.database.isTransaction) {
      throw new InvestigationStoreError(
        "transaction_state",
        "Nested investigation transactions are not supported.",
      );
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (isPromiseLike(result)) {
        throw new InvestigationStoreError(
          "transaction_state",
          "Investigation transaction callbacks must be synchronous.",
        );
      }
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  get<T>(collection: InvestigationCollection, id: string): T | undefined {
    const row = this.database
      .prepare(`SELECT "value" FROM ${collectionName(collection)} WHERE "id" = ?`)
      .get(id);
    return row === undefined ? undefined : (JSON.parse(row.value as string) as T);
  }

  has(collection: InvestigationCollection, id: string): boolean {
    return (
      this.database
        .prepare(`SELECT 1 FROM ${collectionName(collection)} WHERE "id" = ?`)
        .get(id) !== undefined
    );
  }

  list<T>(collection: InvestigationCollection, predicate?: (value: T) => boolean): T[] {
    const values = this.database
      .prepare(`SELECT "value" FROM ${collectionName(collection)} ORDER BY "id"`)
      .all()
      .map((row) => JSON.parse(row.value as string) as T);
    return predicate === undefined ? values : values.filter(predicate);
  }

  /** Keyset paging uses the primary key and never reads a collection's unrelated values. */
  page<T>(collection: InvestigationCollection, afterId: string, limit: number): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new InvestigationStoreError("invalid_value", "Page size must be between 1 and 1,000.");
    return this.database
      .prepare(
        `SELECT "value" FROM ${collectionName(collection)} WHERE "id" > ? ORDER BY "id" LIMIT ?`,
      )
      .all(afterId, limit)
      .map((row) => JSON.parse(row.value as string) as T);
  }

  /** Pin IDs use an ASCII-encoded prefix, so this lookup is an indexed bounded range. */
  hasPrefix(collection: InvestigationCollection, prefix: string): boolean {
    return (
      this.database
        .prepare(`SELECT 1 FROM ${collectionName(collection)} WHERE "id" >= ? AND "id" < ? LIMIT 1`)
        .get(prefix, `${prefix}\uffff`) !== undefined
    );
  }

  /** Reads a bounded namespace without deserializing unrelated idempotency records. */
  pagePrefix<T>(
    collection: InvestigationCollection,
    prefix: string,
    limit: number,
    descending = false,
    afterId?: string,
  ): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new InvestigationStoreError("invalid_value", "Page size must be between 1 and 1,000.");
    if (afterId !== undefined && (afterId < prefix || afterId >= `${prefix}\uffff`))
      throw new InvestigationStoreError(
        "invalid_value",
        "The page cursor must stay inside its key prefix.",
      );
    return this.database
      .prepare(
        `SELECT "value" FROM ${collectionName(collection)} WHERE "id" >= ? AND "id" < ?${afterId === undefined ? "" : ` AND "id" ${descending ? "<" : ">"} ?`} ORDER BY "id" ${descending ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(prefix, `${prefix}\uffff`, ...(afterId === undefined ? [] : [afterId]), limit)
      .map((row) => JSON.parse(row.value as string) as T);
  }

  countPrefix(collection: InvestigationCollection, prefix: string): number {
    return Number(
      this.database
        .prepare(
          `SELECT count(*) AS total FROM ${collectionName(collection)} WHERE "id" >= ? AND "id" < ?`,
        )
        .get(prefix, `${prefix}\uffff`)!.total,
    );
  }

  /** Directory projections filter in SQLite and return only a bounded authorized page. */
  pageWorkspace<T>(
    collection:
      | "reportDirectory"
      | "evidenceMetadata"
      | "workItems"
      | "tasks"
      | "repositories"
      | "idempotency",
    query: InvestigationWorkspacePage,
  ): T[] {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1_000)
      throw new InvestigationStoreError("invalid_value", "Page size must be between 1 and 1,000.");
    if (query.repositoryIds.length === 0) return [];
    const path =
      collection === "reportDirectory"
        ? "context.repository.id"
        : collection === "workItems"
          ? "repositoryId"
          : collection === "repositories"
            ? "id"
            : "repository.id";
    const predicates = [
      collection === "evidenceMetadata"
        ? `json_extract("value", '$.artifact.taskId') = ?`
        : `json_extract("value", '$.${path}') IN (${query.repositoryIds.map(() => "?").join(", ")})`,
    ];
    const values: (string | number)[] =
      collection === "evidenceMetadata" ? [query.taskId ?? ""] : [...query.repositoryIds];
    if (collection === "idempotency")
      predicates.push(
        `("id" GLOB 'auto-reply:report:*' OR "id" GLOB 'progress-reply:assignment:*' OR "id" GLOB 'progress-reply:task:*')`,
      );
    if (collection === "idempotency" && query.workItemKind !== undefined) {
      // Result, current progress, and legacy progress records retain the source kind separately.
      predicates.push(
        `coalesce(json_extract("value", '$.workItemKind'), json_extract("value", '$.target.kind'), json_extract("value", '$.workItem.kind')) = ?`,
      );
      values.push(query.workItemKind);
    }
    const fields =
      collection === "reportDirectory"
        ? {
            taskId: "context.task.id",
            workItemId: "context.workItem.id",
            kind: "context.task.kind",
            delivery: "report.delivery",
            completeness: "report.completeness",
          }
        : collection === "evidenceMetadata"
          ? { attemptId: "artifact.attemptId" }
          : collection === "tasks"
            ? { workItemId: "workItem.id", kind: "kind" }
            : collection === "idempotency"
              ? { taskId: "taskId", workItemId: "workItemId" }
              : { kind: "kind" };
    for (const [field, jsonPath] of Object.entries(fields)) {
      const value = query[field as keyof InvestigationWorkspacePage];
      if (typeof value === "string") {
        predicates.push(`json_extract("value", '$.${jsonPath}') = ?`);
        values.push(value);
      }
    }
    if (query.afterId !== undefined) {
      predicates.push('"id" > ?');
      values.push(query.afterId);
    }
    if (query.search !== undefined) {
      const searchFields =
        collection === "reportDirectory"
          ? ["context.workItem.title", "context.workItem.number", "report.summary", "id"]
          : collection === "tasks"
            ? ["workItem.title", "workItem.number", "id"]
            : collection === "repositories"
              ? ["fullName", "id"]
              : ["title", "number", "id"];
      predicates.push(
        `(${searchFields.map((field) => `instr(lower(CAST(json_extract("value", '$.${field}') AS TEXT)), lower(?)) > 0`).join(" OR ")})`,
      );
      values.push(...searchFields.map(() => query.search!));
    }
    values.push(query.limit);
    return this.database
      .prepare(
        `SELECT "value" FROM ${collectionName(collection)} WHERE ${predicates.join(" AND ")} ORDER BY "id" LIMIT ?`,
      )
      .all(...values)
      .map((row) => JSON.parse(row.value as string) as T);
  }

  pageOutput<T>(attemptId: string, afterSequence: number, limit: number): T[] {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    )
      throw new InvestigationStoreError(
        "invalid_value",
        "Output pagination requires bounded safe integers.",
      );
    return this.database
      .prepare(
        `SELECT "value" FROM "outputEvents" WHERE json_extract("value", '$.attemptId') = ? AND json_extract("value", '$.producerSequence') > ? ORDER BY json_extract("value", '$.producerSequence') LIMIT ?`,
      )
      .all(attemptId, afterSequence, limit)
      .map((row) => JSON.parse(row.value as string) as T);
  }

  /** Eviction only removes the first retained event of a stream, preserving contiguous replay. */
  oldestOutput<T>(): T | undefined {
    const row = this.database
      .prepare(
        `SELECT e."value" FROM "outputEvents" e JOIN "outputStreams" s ON s."id" = 'attempt:' || json_extract(e."value", '$.attemptId') WHERE json_extract(e."value", '$.producerSequence') = json_extract(s."value", '$.earliestSequence') ORDER BY json_extract(e."value", '$.receivedAt'), e."id" LIMIT 1`,
      )
      .get();
    return row === undefined ? undefined : (JSON.parse(row.value as string) as T);
  }

  /** Filters inside SQLite and keyset-pages actual delivery attempts without loading other rows. */
  pageCommentDeliveries<T>(query: InvestigationCommentDeliveryPage): T[] {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1_000)
      throw new InvestigationStoreError("invalid_value", "Page size must be between 1 and 1,000.");
    if (query.repositoryIds?.length === 0) return [];
    const predicates: string[] = [];
    const values: (string | number)[] = [];
    if (query.repositoryIds !== undefined) {
      predicates.push(
        `json_extract("value", '$.repositoryId') IN (${query.repositoryIds.map(() => "?").join(", ")})`,
      );
      values.push(...query.repositoryIds);
    }
    for (const field of ["taskId", "commentId", "workItemNumber", "mode"] as const) {
      const value = query[field];
      if (value !== undefined) {
        predicates.push(`json_extract("value", '$.${field}') = ?`);
        values.push(value);
      }
    }
    if (query.state !== undefined) {
      // Match the read-only DTO projection without rewriting historical delivery receipts.
      predicates.push(`(CASE WHEN json_extract("value", '$.state') = 'failed'
        AND json_extract("value", '$.effect') = 'not_sent'
        AND json_extract("value", '$.reason') = ?
        THEN 'cancelled' ELSE json_extract("value", '$.state') END) = ?`);
      values.push(legacySupersededCommentDeliveryReason, query.state);
    }
    if (query.before !== undefined) {
      predicates.push(
        `(json_extract("value", '$.startedAt') < ? OR (json_extract("value", '$.startedAt') = ? AND "id" < ?))`,
      );
      values.push(query.before.startedAt, query.before.startedAt, query.before.id);
    }
    values.push(query.limit);
    return this.database
      .prepare(
        `SELECT "value" FROM "commentDeliveries"${predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`} ORDER BY json_extract("value", '$.startedAt') DESC, "id" DESC LIMIT ?`,
      )
      .all(...values)
      .map((row) => JSON.parse(row.value as string) as T);
  }

  /** Uses the comment-scoped index; timestamps and random delivery IDs do not allocate attempts. */
  maximumCommentDeliveryAttemptNumber(commentId: string): number {
    const row = this.database
      .prepare(
        `SELECT coalesce(max(json_extract("value", '$.attemptNumber')), 0) AS "maximum" FROM "commentDeliveries" INDEXED BY "comment_deliveries_commentId" WHERE json_extract("value", '$.commentId') = ?`,
      )
      .get(commentId);
    const maximum = Number(row?.maximum ?? 0);
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new InvestigationStoreError(
        "invalid_value",
        "The retained delivery attempt number is invalid.",
      );
    return maximum;
  }

  insert<T>(collection: InvestigationCollection, id: string, value: T): void {
    const table = collectionName(collection);
    const serialized = serialize(value);
    try {
      this.database
        .prepare(`INSERT INTO ${table} ("id", "value") VALUES (?, ?)`)
        .run(id, serialized);
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new InvestigationStoreError(
          "conflict",
          `An entity with this ID already exists in ${collection}.`,
          { cause },
        );
      }
      throw cause;
    }
  }

  put<T>(collection: InvestigationCollection, id: string, value: T): void {
    const table = collectionName(collection);
    this.database
      .prepare(`INSERT INTO ${table} ("id", "value") VALUES (?, ?)
        ON CONFLICT ("id") DO UPDATE SET "value" = excluded."value"`)
      .run(id, serialize(value));
  }

  delete(collection: InvestigationCollection, id: string): void {
    this.database.prepare(`DELETE FROM ${collectionName(collection)} WHERE "id" = ?`).run(id);
  }

  private initializeSchema(): void {
    const objects = this.database
      .prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
      .all();
    if (objects.length === 0) {
      this.database.exec(metadataDefinition);
      this.database
        .prepare(`INSERT INTO "${metadataTable}" ("key", "value") VALUES (?, ?)`)
        .run("schema_version", investigationSchemaVersion);
      for (const collection of investigationCollections) {
        this.database.exec(collectionDefinition(collection));
      }
      for (const definition of deliveryIndexes.values()) this.database.exec(definition);
      for (const definition of workspaceIndexes.values()) this.database.exec(definition);
      return;
    }

    const definitions = (
      names: readonly InvestigationCollection[],
      indexes = false,
      workspace = false,
    ) =>
      new Map<string, { type: string; sql: string }>([
        [metadataTable, { type: "table", sql: metadataDefinition }],
        ...names.map((collection): [string, { type: string; sql: string }] => [
          collection,
          { type: "table", sql: collectionDefinition(collection) },
        ]),
        ...(indexes
          ? [...deliveryIndexes].map(([name, sql]): [string, { type: string; sql: string }] => [
              name,
              { type: "index", sql },
            ])
          : []),
        ...(workspace
          ? [...workspaceIndexes].map(([name, sql]): [string, { type: string; sql: string }] => [
              name,
              { type: "index", sql },
            ])
          : []),
      ]);
    const matches = (expected: ReturnType<typeof definitions>) =>
      objects.length === expected.size &&
      objects.every((object) => {
        const definition = expected.get(object.name as string);
        return (
          definition !== undefined &&
          object.type === definition.type &&
          typeof object.sql === "string" &&
          (definition.type === "index"
            ? object.sql.replace(/\s+/gu, " ").trim() ===
              definition.sql.replace(/\s+/gu, " ").trim()
            : normalizeDefinition(object.sql) === normalizeDefinition(definition.sql))
        );
      });
    const current = matches(definitions(investigationCollections, true, true));
    const previousV4 = matches(definitions(investigationV4Collections, true));
    const previousV3 = matches(definitions(investigationV3Collections, true));
    const previousV2 = matches(definitions(investigationV2Collections));
    if (!current && !previousV4 && !previousV3 && !previousV2) {
      throw new InvestigationStoreError(
        "incompatible_schema",
        "The investigation database has an unrecognized schema; no migration was applied.",
      );
    }
    const version = this.database
      .prepare(`SELECT "value" FROM "${metadataTable}" WHERE "key" = ?`)
      .get("schema_version");
    if (
      (previousV2 && version?.value === "investigation-v2") ||
      (previousV3 && version?.value === "investigation-v3") ||
      (previousV4 && version?.value === "investigation-v4")
    ) {
      if (previousV2) {
        this.database.exec(collectionDefinition("commentDeliveries"));
        for (const definition of deliveryIndexes.values()) this.database.exec(definition);
      }
      if (!previousV4) {
        this.database.exec(collectionDefinition("resourceLeases"));
        this.database.exec(collectionDefinition("schedulerSettings"));
      }
      for (const collection of [
        "outputEvents",
        "outputStreams",
        "outputBatches",
        "reportDirectory",
      ] as const)
        this.database.exec(collectionDefinition(collection));
      for (const definition of workspaceIndexes.values()) this.database.exec(definition);
      this.database
        .prepare(`UPDATE "${metadataTable}" SET "value" = ? WHERE "key" = ?`)
        .run(investigationSchemaVersion, "schema_version");
      return;
    }
    if (!current || version?.value !== investigationSchemaVersion) {
      throw new InvestigationStoreError(
        "incompatible_schema",
        "The investigation database schema version is unsupported.",
      );
    }
  }
}
