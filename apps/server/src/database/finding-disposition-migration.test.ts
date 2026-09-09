import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { runMigrations } from "./migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const filename = "0021_finding_dispositions.sql";
const originalSql = readFileSync(
  join(migrationsDirectory, "0020_review_run_decisions.sql"),
  "utf8",
);
const migrationSql = readFileSync(join(migrationsDirectory, filename), "utf8");
const databases: DatabaseSync[] = [];
const directories: string[] = [];
const digest = "a".repeat(64);
const dispositionDigest = "b".repeat(64);
const now = "2026-09-07T00:00:00.000Z";
const later = "2026-09-07T00:01:00.000Z";
type Row = Record<string, SQLInputValue>;

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function open(): DatabaseSync {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  databases.push(database);
  database.exec(
    "PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF",
  );
  return database;
}

function insert(database: DatabaseSync, table: string, row: Row, modifier = ""): void {
  database
    .prepare(`INSERT ${modifier} INTO ${table} (${Object.keys(row).join(", ")})
      VALUES (${Object.keys(row)
        .map(() => "?")
        .join(", ")})`)
    .run(...Object.values(row));
}

function migrate(database: DatabaseSync, sql = migrationSql): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function rows(database: DatabaseSync, table: string, order = "id") {
  return database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
}

function decision(version: number, v2 = false): Row {
  const snapshot = {
    schemaVersion: v2 ? "ReviewRunDecisionSnapshotV2" : "ReviewRunDecisionSnapshotV1",
    repositoryId: "repo-1",
    reviewRunId: "run-1",
    workItemId: "item-1",
    workItemKind: "pull_request",
    revisionKey: digest,
    planDigest: digest,
    activationId: "activation-1",
    requestEpochId: "epoch-1",
    currentRevisionKey: digest,
    currentSourceSequence: 1,
    currentSourceRevisionKey: digest,
    automaticSourceSequence: null,
    itemState: "open",
    epochStatus: "active",
    repositoryEnabled: true,
    repositoryVersion: 1,
    authorizationPolicyCurrent: true,
    requests: [
      {
        requestId: "request-1",
        workflowKind: "pr_static_build",
        target: "headless",
        required: true,
        profileVersionId: "profile-1",
        promptVersionId: "prompt-1",
        latestJob: null,
      },
    ],
    ...(v2 ? { findingDispositionDigest: dispositionDigest } : {}),
  };
  const policy = {
    policyVersion: v2 ? "required-checks-and-unresolved-p0-p1-v2" : "required-checks-and-p0-p1-v1",
    applicable: true,
    eligible: true,
    blockingFindingCount: v2 ? 2 : 0,
    reasonCount: 0,
    reasons: [],
    reasonsTruncated: false,
    ...(v2
      ? { unresolvedBlockingFindingCount: 0, findingDispositionDigest: dispositionDigest }
      : {}),
  };
  const { reasons: _reasons, reasonsTruncated: _truncated, ...policySummary } = policy;
  return {
    id: `decision-${version}`,
    repository_id: "repo-1",
    review_run_id: "run-1",
    work_item_id: "item-1",
    work_item_kind: "pull_request",
    change_id: `decision-change-${version}`,
    actor_issuer: "https://identity.example.test",
    actor_subject: "reviewer-1",
    action: "comment",
    reason: "Preserve the original decision.\nThe second line is intentional.",
    previous_version: version - 1,
    version,
    revision_key: digest,
    plan_digest: digest,
    result_set_digest: sha256(canonicalJson(snapshot)),
    policy_digest: sha256(canonicalJson(policy)),
    target_decision_id: null,
    supersedes_decision_id: null,
    snapshot_json: canonicalJson(snapshot),
    policy_json: canonicalJson(policy),
    policy_snapshot_json: canonicalJson({
      ...policySummary,
      reasonCodes: [],
      reasonCodesTruncated: false,
    }),
    intent_digest: digest,
    receipt_digest: digest,
    created_at: now,
  };
}

// These minimal parent tables isolate actual M20/M21 SQL constraints. They do not model result
// admission or claim to validate model payloads. A separate test runs every production migration.
function fixture(upgrade = true): DatabaseSync {
  const database = open();
  database.exec(`
    CREATE TABLE managed_repositories(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE work_items(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES managed_repositories(id),
      resource_kind TEXT NOT NULL) STRICT;
    CREATE TABLE review_runs(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES managed_repositories(id),
      work_item_id TEXT NOT NULL REFERENCES work_items(id), revision_key TEXT NOT NULL, plan_digest TEXT NOT NULL) STRICT;
    CREATE TABLE review_run_requests(review_run_id TEXT NOT NULL REFERENCES review_runs(id), request_id TEXT NOT NULL,
      PRIMARY KEY(review_run_id, request_id)) STRICT;
    CREATE TABLE jobs(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE validation_job_results(id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES managed_repositories(id),
      review_run_id TEXT NOT NULL REFERENCES review_runs(id), request_id TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id), work_item_id TEXT NOT NULL REFERENCES work_items(id),
      resource_revision TEXT NOT NULL, plan_digest TEXT NOT NULL, result_digest TEXT NOT NULL,
      FOREIGN KEY(review_run_id, request_id) REFERENCES review_run_requests(review_run_id, request_id)) STRICT;
  `);
  for (const number of [1, 2]) {
    insert(database, "managed_repositories", { id: `repo-${number}` });
    insert(database, "work_items", {
      id: `item-${number}`,
      repository_id: `repo-${number}`,
      resource_kind: "pull_request",
    });
    insert(database, "review_runs", {
      id: `run-${number}`,
      repository_id: `repo-${number}`,
      work_item_id: `item-${number}`,
      revision_key: digest,
      plan_digest: digest,
    });
    insert(database, "review_run_requests", {
      review_run_id: `run-${number}`,
      request_id: "request-1",
    });
    insert(database, "jobs", { id: `job-${number}` });
    insert(database, "validation_job_results", {
      id: `result-${number}`,
      repository_id: `repo-${number}`,
      review_run_id: `run-${number}`,
      request_id: "request-1",
      job_id: `job-${number}`,
      work_item_id: `item-${number}`,
      resource_revision: digest,
      plan_digest: digest,
      result_digest: digest,
    });
  }
  database.exec(originalSql);
  insert(database, "review_run_decision_events", { ...decision(1), action: "approve" });
  insert(database, "review_run_decision_events", decision(2));
  insert(database, "review_run_decision_events", {
    ...decision(3),
    action: "request_changes",
    supersedes_decision_id: "decision-1",
  });
  insert(database, "review_run_decision_events", {
    ...decision(4),
    action: "withdraw",
    target_decision_id: "decision-3",
    supersedes_decision_id: "decision-3",
  });
  if (upgrade) migrate(database);
  return database;
}

function event(version = 1): Row {
  const states = ["open", "accepted", "dismissed", "resolved", "open"];
  const actions = ["", "accept", "dismiss", "resolve", "reopen"];
  return {
    id: `event-${version}`,
    repository_id: "repo-1",
    review_run_id: "run-1",
    request_id: "request-1",
    job_id: "job-1",
    result_id: "result-1",
    result_digest: digest,
    kind: "pr_finding",
    ordinal: 0,
    occurrence_key: dispositionDigest,
    work_item_id: "item-1",
    work_item_kind: "pull_request",
    revision_key: digest,
    plan_digest: digest,
    result_set_digest_at_change: digest,
    context_digest_at_change: digest,
    source_current_at_change: 1,
    latest_for_request_at_change: 1,
    change_id: `finding-change-${version}`,
    actor_issuer: "https://identity.example.test",
    actor_subject: "reviewer-1",
    action: actions[version] ?? "reopen",
    previous_state: states[version - 1] ?? "resolved",
    state: states[version] ?? "open",
    previous_version: version - 1,
    version,
    reason: "A recorded reason.\nThe observation is retained.",
    created_at: version === 1 ? now : later,
    intent_digest: digest,
    receipt_digest: digest,
  };
}

function jsonChange(
  row: Row,
  column: string,
  update: (value: Record<string, unknown>) => void,
): Row {
  const value = JSON.parse(String(row[column])) as Record<string, unknown>;
  update(value);
  return { ...row, [column]: JSON.stringify(value) };
}

describe("finding disposition migration", () => {
  it("runs the complete production sequence and preserves the original migration checksum", () => {
    const database = open();
    expect(runMigrations(database, migrationsDirectory)).toBe(33);
    const before = rows(database, "schema_migrations", "version");
    expect(
      database.prepare("SELECT checksum FROM schema_migrations WHERE version = 20").get(),
    ).toEqual({ checksum: sha256(originalSql) });
    expect(runMigrations(database, migrationsDirectory)).toBe(33);
    expect(rows(database, "schema_migrations", "version")).toEqual(before);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves every M20 column and both self-reference chains while enabling V2", () => {
    const database = fixture(false);
    const before = JSON.stringify(rows(database, "review_run_decision_events", "version"));
    const foreignKeys = database
      .prepare("PRAGMA foreign_key_list(review_run_decision_events)")
      .all();
    const objects = database
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'review_run_decision_events' AND type IN ('trigger','index') AND sql IS NOT NULL ORDER BY name",
      )
      .all();
    migrate(database);
    expect(JSON.stringify(rows(database, "review_run_decision_events", "version"))).toBe(before);
    expect(database.prepare("PRAGMA foreign_key_list(review_run_decision_events)").all()).toEqual(
      foreignKeys,
    );
    expect(
      database
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'review_run_decision_events' AND type IN ('trigger','index') AND sql IS NOT NULL ORDER BY name",
        )
        .all(),
    ).toEqual(objects);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    insert(database, "review_run_decision_events", decision(5, true));
    expect(rows(database, "review_run_decision_events", "version")).toHaveLength(5);
  });

  it("rolls back the complete old event table and schema after failure immediately following DROP", () => {
    const database = fixture(false);
    const before = JSON.stringify(rows(database, "review_run_decision_events", "version"));
    const schema = database
      .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name")
      .all();
    const broken = migrationSql.replace(
      "DROP TABLE review_run_decision_events;",
      "DROP TABLE review_run_decision_events; SELECT * FROM deliberately_missing_m21_table;",
    );
    expect(() => migrate(database, broken)).toThrow(/deliberately_missing_m21_table/);
    expect(JSON.stringify(rows(database, "review_run_decision_events", "version"))).toBe(before);
    expect(
      database.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all(),
    ).toEqual(schema);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => database.exec("DELETE FROM review_run_decision_events")).toThrow(/immutable/);
    migrate(database);
  });

  it("leaves the production migration ledger at M20 on failure and then completes M21", () => {
    const directory = mkdtempSync(join(tmpdir(), "finding-migration-"));
    directories.push(directory);
    for (const entry of readdirSync(migrationsDirectory)) {
      if (/^00(?:0[1-9]|1[0-9]|20)_.*\.sql$/u.test(entry))
        copyFileSync(join(migrationsDirectory, entry), join(directory, entry));
    }
    const database = open();
    expect(runMigrations(database, directory)).toBe(20);
    const ledger = rows(database, "schema_migrations", "version");
    writeFileSync(
      join(directory, filename),
      migrationSql.replace(
        "DROP TABLE review_run_decision_events;",
        "DROP TABLE review_run_decision_events; SELECT * FROM deliberately_missing_m21_table;",
      ),
    );
    expect(() => runMigrations(database, directory)).toThrow(/deliberately_missing_m21_table/);
    expect(rows(database, "schema_migrations", "version")).toEqual(ledger);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    copyFileSync(join(migrationsDirectory, filename), join(directory, filename));
    expect(runMigrations(database, directory)).toBe(21);
  });

  it.each([
    [
      "V1 snapshot with V2 policy",
      (row: Row) =>
        jsonChange(row, "snapshot_json", (x) => {
          x.schemaVersion = "ReviewRunDecisionSnapshotV1";
        }),
    ],
    [
      "V2 snapshot with V1 policy",
      (row: Row) =>
        jsonChange(row, "policy_json", (x) => {
          x.policyVersion = "required-checks-and-p0-p1-v1";
        }),
    ],
    [
      "missing snapshot digest",
      (row: Row) =>
        jsonChange(row, "snapshot_json", (x) => {
          delete x.findingDispositionDigest;
        }),
    ],
    [
      "invalid digest characters",
      (row: Row) =>
        jsonChange(row, "snapshot_json", (x) => {
          x.findingDispositionDigest = "z".repeat(64);
        }),
    ],
    [
      "NUL digest suffix",
      (row: Row) =>
        jsonChange(row, "snapshot_json", (x) => {
          x.findingDispositionDigest = `${dispositionDigest}\0`;
        }),
    ],
    [
      "different policy digest",
      (row: Row) =>
        jsonChange(row, "policy_json", (x) => {
          x.findingDispositionDigest = digest;
        }),
    ],
    [
      "different compact digest",
      (row: Row) =>
        jsonChange(row, "policy_snapshot_json", (x) => {
          x.findingDispositionDigest = digest;
        }),
    ],
    [
      "missing unresolved count",
      (row: Row) =>
        jsonChange(row, "policy_json", (x) => {
          delete x.unresolvedBlockingFindingCount;
        }),
    ],
    [
      "negative unresolved count",
      (row: Row) =>
        jsonChange(row, "policy_json", (x) => {
          x.unresolvedBlockingFindingCount = -1;
        }),
    ],
    [
      "unresolved count above total",
      (row: Row) =>
        jsonChange(row, "policy_json", (x) => {
          x.unresolvedBlockingFindingCount = 3;
        }),
    ],
    [
      "fractional unresolved count",
      (row: Row) =>
        jsonChange(row, "policy_json", (x) => {
          x.unresolvedBlockingFindingCount = 0.5;
        }),
    ],
    [
      "different compact count",
      (row: Row) =>
        jsonChange(row, "policy_snapshot_json", (x) => {
          x.unresolvedBlockingFindingCount = 1;
        }),
    ],
    [
      "different compact raw count",
      (row: Row) =>
        jsonChange(row, "policy_snapshot_json", (x) => {
          x.blockingFindingCount = 0;
        }),
    ],
  ] as const)("rejects incompatible V2 audit data: %s", (_name, mutate) => {
    const database = fixture();
    expect(() => insert(database, "review_run_decision_events", mutate(decision(5, true)))).toThrow(
      /CHECK/,
    );
    expect(rows(database, "review_run_decision_events", "version")).toHaveLength(4);
  });

  it("appends disposition events and atomically retains a compact current projection", () => {
    const database = fixture();
    for (const version of [1, 2, 3, 4]) {
      insert(
        database,
        "finding_disposition_events",
        event(version),
        version === 2 ? "OR IGNORE" : version === 3 ? "OR REPLACE" : "",
      );
      expect(rows(database, "finding_dispositions", "version")).toEqual([
        {
          result_id: "result-1",
          kind: "pr_finding",
          ordinal: 0,
          repository_id: "repo-1",
          review_run_id: "run-1",
          request_id: "request-1",
          job_id: "job-1",
          result_digest: digest,
          occurrence_key: dispositionDigest,
          state: event(version).state,
          version,
          last_event_id: `event-${version}`,
          created_at: now,
          updated_at: version === 1 ? now : later,
          updated_by_issuer: event(version).actor_issuer,
          updated_by_subject: "reviewer-1",
        },
      ]);
    }
    expect(rows(database, "finding_disposition_events")).toHaveLength(4);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    ["repository_id", "repo-2"],
    ["review_run_id", "run-2"],
    ["request_id", "missing"],
    ["job_id", "job-2"],
    ["result_id", "result-2"],
    ["result_digest", "c".repeat(64)],
    ["work_item_id", "item-2"],
    ["work_item_kind", "issue"],
    ["revision_key", "c".repeat(64)],
    ["plan_digest", "c".repeat(64)],
    ["ordinal", -1],
    ["ordinal", 100],
    ["kind", "unknown"],
    ["previous_version", 1],
    ["previous_state", "accepted"],
    ["state", "open"],
    ["state", "dismissed"],
    ["reason", " leading"],
    ["reason", "x".repeat(2049)],
    ["reason", "nul\0reason"],
    ["source_current_at_change", 2],
    ["latest_for_request_at_change", -1],
    ["occurrence_key", `${dispositionDigest}\0`],
    ["result_set_digest_at_change", "bad"],
    ["context_digest_at_change", "bad"],
  ] as const)("rejects invalid disposition field %s=%s", (field, value) => {
    const database = fixture();
    expect(() =>
      insert(database, "finding_disposition_events", { ...event(), [field]: value }),
    ).toThrow();
    expect(rows(database, "finding_disposition_events")).toEqual([]);
    expect(rows(database, "finding_dispositions", "version")).toEqual([]);
  });

  it.each([
    ["previous_state", "open"],
    ["previous_version", 0],
    ["version", 3],
    ["occurrence_key", "c".repeat(64)],
    ["created_at", "2026-09-06T00:00:00.000Z"],
    ["state", "accepted"],
  ] as const)("rejects an event that does not follow its projection: %s", (field, value) => {
    const database = fixture();
    insert(database, "finding_disposition_events", event());
    expect(() =>
      insert(database, "finding_disposition_events", { ...event(2), [field]: value }),
    ).toThrow();
    expect(rows(database, "finding_disposition_events")).toHaveLength(1);
    expect(rows(database, "finding_dispositions", "version")[0]?.version).toBe(1);
  });

  it("rejects replacement through every declared event key even with recursive triggers off", () => {
    const database = fixture();
    insert(database, "finding_disposition_events", event());
    const before = rows(database, "finding_disposition_events");
    for (const replacement of [
      event(),
      { ...event(2), id: "event-1" },
      { ...event(2), change_id: "finding-change-1" },
      { ...event(2), version: 1 },
    ]) {
      expect(() =>
        insert(database, "finding_disposition_events", replacement, "OR REPLACE"),
      ).toThrow(/cannot be replaced/);
    }
    expect(rows(database, "finding_disposition_events")).toEqual(before);
  });

  it("rejects projection inserts, every direct column update, replacements, and deletion", () => {
    const database = fixture();
    insert(database, "finding_disposition_events", event());
    const projection = rows(database, "finding_dispositions", "version")[0] as Row;
    for (const modifier of ["", "OR IGNORE", "OR REPLACE"])
      expect(() => insert(database, "finding_dispositions", projection, modifier)).toThrow(
        /immutable event/,
      );
    for (const column of Object.keys(projection))
      expect(() => database.exec(`UPDATE finding_dispositions SET ${column} = ${column}`)).toThrow(
        /next immutable event/,
      );
    expect(() => database.exec("UPDATE finding_dispositions SET version = 2")).toThrow(
      /next immutable event/,
    );
    expect(() => database.exec("DELETE FROM finding_dispositions")).toThrow(/retain their history/);
    expect(() => database.exec("UPDATE finding_disposition_events SET reason = reason")).toThrow(
      /immutable/,
    );
    expect(() => database.exec("DELETE FROM finding_disposition_events")).toThrow(/immutable/);
    expect(rows(database, "finding_dispositions", "version")).toEqual([projection]);
  });

  it("refuses an event when its atomic projection is suppressed", () => {
    const database = fixture();
    database.exec(
      "CREATE TRIGGER suppress_projection BEFORE INSERT ON finding_dispositions BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() => insert(database, "finding_disposition_events", event(), "OR IGNORE")).toThrow(
      /did not update its projection/,
    );
    expect(rows(database, "finding_disposition_events")).toEqual([]);
    expect(rows(database, "finding_dispositions", "version")).toEqual([]);
  });

  it("retains immutable decision events and excludes hidden rowid replacement paths", () => {
    const database = fixture();
    expect(() => database.exec("UPDATE review_run_decision_events SET reason = reason")).toThrow(
      /immutable/,
    );
    expect(() => database.exec("DELETE FROM review_run_decision_events")).toThrow(/immutable/);
    expect(() => insert(database, "review_run_decision_events", decision(1), "OR REPLACE")).toThrow(
      /cannot be replaced/,
    );
    for (const table of [
      "review_run_decision_events",
      "finding_disposition_events",
      "finding_dispositions",
    ]) {
      expect(
        database.prepare("SELECT wr FROM pragma_table_list WHERE name = ?").get(table),
      ).toEqual({ wr: 1 });
      expect(() => database.exec(`INSERT OR REPLACE INTO ${table} (rowid) VALUES (1)`)).toThrow(
        /rowid/,
      );
    }
  });
});
