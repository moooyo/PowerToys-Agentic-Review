import { DatabaseSync } from "node:sqlite";

export const investigationSchemaVersion = "investigation-v2";

export const investigationCollections = [
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
  ): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new InvestigationStoreError("invalid_value", "Page size must be between 1 and 1,000.");
    return this.database
      .prepare(
        `SELECT "value" FROM ${collectionName(collection)} WHERE "id" >= ? AND "id" < ? ORDER BY "id" ${descending ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(prefix, `${prefix}\uffff`, limit)
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
      return;
    }

    const expectedDefinitions = new Map<string, string>([
      [metadataTable, metadataDefinition],
      ...investigationCollections.map((collection): [string, string] => [
        collection,
        collectionDefinition(collection),
      ]),
    ]);
    const compatible =
      objects.length === expectedDefinitions.size &&
      objects.every((object) => {
        const definition = expectedDefinitions.get(object.name as string);
        return (
          object.type === "table" &&
          typeof object.sql === "string" &&
          definition !== undefined &&
          normalizeDefinition(object.sql) === normalizeDefinition(definition)
        );
      });
    if (!compatible) {
      throw new InvestigationStoreError(
        "incompatible_schema",
        `This database does not use the ${investigationSchemaVersion} schema. Configure a new database; existing databases are not migrated.`,
      );
    }
    const version = this.database
      .prepare(`SELECT "value" FROM "${metadataTable}" WHERE "key" = ?`)
      .get("schema_version");
    if (version?.value !== investigationSchemaVersion) {
      throw new InvestigationStoreError(
        "incompatible_schema",
        "The investigation database schema version is unsupported.",
      );
    }
  }
}
