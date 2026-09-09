import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { FormatRegistry } from "@sinclair/typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "../scheduling/canonical-json.js";
import { createEvaluationExecutionTemplate } from "../scheduling/validation-job-factory.js";
import {
  beginAttempt,
  completedAt,
  context,
  createEvaluationCompletionFixture,
  type EvaluationCompletionFixture,
  resultFor,
  selected,
  settle,
  transaction,
  validate,
} from "./evaluation-completion.testing.js";
import * as migrations from "./migrations.js";
import { createModelCliFixture } from "./model-cli.testing.js";
import {
  runValidationResultRebuild,
  ValidationResultRebuildError,
} from "./validation-result-rebuild.js";
import {
  persistValidatedValidationResult,
  type ValidatedValidationResult,
  validateValidationCompletion,
} from "./validation-results.js";

const migrationDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const migrationName = "0029_validation_model_outputs.sql";
const directories: string[] = [];
const fixtures: Pick<EvaluationCompletionFixture, "database" | "close">[] = [];
const formats = new Map(["date-time", "uri"].map((key) => [key, FormatRegistry.Get(key)]));
const runMigrations = migrations.runMigrations;
type SchemaRow = {
  schema_name: string;
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

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

function readSchema(database: DatabaseSync): SchemaRow[] {
  return database
    .prepare(`SELECT 'main' AS schema_name, type, name, tbl_name, sql FROM main.sqlite_schema
    UNION ALL SELECT 'temp' AS schema_name, type, name, tbl_name, sql FROM temp.sqlite_schema
    ORDER BY schema_name, type, name`)
    .all()
    .map((row) => ({ ...row })) as unknown as SchemaRow[];
}
function snapshot(database: DatabaseSync) {
  const rows = (table: string, rowid = false) =>
    database
      .prepare(`SELECT ${rowid ? 'rowid AS "physical_rowid",' : ""} * FROM ${table}`)
      .all()
      .map((row) => ({ ...row }))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), "en"));
  const indexes = database
    .prepare("SELECT * FROM pragma_index_list('validation_job_results') ORDER BY name")
    .all()
    // SQLite may renumber index_list enumeration after recreation; xinfo column order is semantic.
    .map(({ seq: _enumerationSequence, ...index }) => ({
      ...index,
      columns: database
        .prepare("SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno")
        .all(String(index.name))
        .map((column) => ({ ...column })),
    }));
  const foreignKeys = Object.fromEntries(
    [
      "validation_job_results",
      "evaluation_adjudication_events",
      "finding_disposition_events",
      "finding_dispositions",
    ].map((table) => [
      table,
      database
        .prepare("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id,seq")
        .all(table)
        .map((row) => ({ ...row })),
    ]),
  );
  return {
    schema: readSchema(database),
    rows: rows("validation_job_results", true),
    indexes,
    foreignKeys,
    children: Object.fromEntries(
      ["evaluation_adjudication_events", "finding_disposition_events", "finding_dispositions"].map(
        (table) => [table, rows(table)],
      ),
    ),
    ledger: rows("schema_migrations"),
    attempts: rows("run_attempts"),
    jobs: rows("jobs"),
  };
}
function foreignKeys(database: DatabaseSync): number {
  return Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys);
}
function errorFrom(action: () => unknown): ValidationResultRebuildError {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(ValidationResultRebuildError);
  return captured as ValidationResultRebuildError;
}
function expectRollback(database: DatabaseSync, before: ReturnType<typeof snapshot>): void {
  expect(database.isTransaction).toBe(false);
  expect(foreignKeys(database)).toBe(1);
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(snapshot(database)).toEqual(before);
  expect(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'new_validation_job_results'")
      .get(),
  ).toBeUndefined();
}
async function install(directory: string, sql?: string): Promise<void> {
  await writeFile(
    join(directory, migrationName),
    sql ?? (await readFile(join(migrationDirectory, migrationName), "utf8")),
  );
}

async function historicalDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "validation-result-rebuild-m28-"));
  directories.push(directory);
  const historical = (await readdir(migrationDirectory)).filter(
    (name) => /^\d{4}_.*\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 28,
  );
  expect(historical).toHaveLength(28);
  await Promise.all(
    historical.map((name) => copyFile(join(migrationDirectory, name), join(directory, name))),
  );
  return directory;
}

async function fixture(arms: readonly ("baseline" | "candidate")[] = ["baseline", "candidate"]) {
  const directory = await historicalDirectory();
  const redirected = vi
    .spyOn(migrations, "runMigrations")
    .mockImplementation((database) => runMigrations(database, directory));
  let value: EvaluationCompletionFixture;
  try {
    value = createEvaluationCompletionFixture();
  } finally {
    redirected.mockRestore();
  }
  fixtures.push(value);
  expect(migrations.inspectMigrationState(value.database, directory).currentVersion).toBe(28);
  for (const [index, arm] of arms.entries()) {
    const cell = selected(value, arm),
      completion = beginAttempt(value, cell);
    const validated = validate(value, completion, resultFor(cell));
    const prepare = value.database.prepare.bind(value.database);
    // Unusual physical rowids make an accidental implicit-rowid copy observable. All result
    // validation, settlement, identity binding and actual persistence still use production code.
    const inserted = vi
      .spyOn(value.database, "prepare")
      .mockImplementation((sql) =>
        prepare(
          /^INSERT INTO validation_job_results\s*\(/u.test(sql)
            ? sql
                .replace(
                  "INSERT INTO validation_job_results (",
                  "INSERT INTO validation_job_results (rowid,",
                )
                .replace(") VALUES (", `) VALUES (${41 + index * 46},`)
            : sql,
        ),
      );
    try {
      transaction(value.database, () => {
        settle(value.database, completion, validated);
        persistValidatedValidationResult(value.database, completion, validated, completedAt);
        value.database
          .prepare(
            "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
          )
          .run(completedAt, cell.jobId);
      });
    } finally {
      inserted.mockRestore();
    }
  }
  return { ...value, directory };
}

function rawRow(validated: ValidatedValidationResult, json: string): Record<string, SQLInputValue> {
  return {
    id: "synthetic-v2-result",
    run_attempt_id: validated.runAttemptId,
    job_id: validated.jobId,
    repository_id: validated.repositoryId,
    work_item_id: validated.workItemId,
    revision_id: validated.revisionId,
    job_kind: validated.jobKind,
    resource_revision: validated.resourceRevision,
    review_run_id: validated.reviewRunId,
    request_id: validated.requestId,
    activation_id: validated.activationId,
    job_activation: validated.jobActivation,
    workflow_kind: validated.workflowKind,
    target: validated.target,
    plan_digest: validated.planDigest,
    prompt_version_id: validated.promptVersionId,
    profile_version_id: validated.profileVersionId,
    schema_id: "ValidationJobResultV2",
    result_digest: sha256(json),
    result_json: json,
    execution_template_sha256: validated.executionTemplateSha256,
    evidence_complete: Number(validated.evidenceComplete),
    created_at: completedAt,
  };
}

describe.skipIf(process.platform !== "linux")("M29 validation result storage rebuild", () => {
  it("preserves authentic M28 V1 bytes, explicit rowids, indexes, foreign keys and current trigger definitions", async () => {
    const value = await fixture(),
      before = snapshot(value.database);
    expect(before.rows.map((row) => row.physical_rowid).sort()).toEqual([41, 87]);
    expect(
      before.rows.every(
        (row) =>
          row.schema_id === "ValidationJobResultV1" &&
          sha256(String(row.result_json)) === row.result_digest,
      ),
    ).toBe(true);
    const currentTrigger = before.schema.find(
      (row) => row.type === "trigger" && row.name === "tr_validation_job_result_insert_consistency",
    );
    expect(currentTrigger?.sql).toContain("evaluation");
    await install(value.directory);
    expect(runMigrations(value.database, value.directory)).toBe(29);
    const after = snapshot(value.database);
    expect(after.rows).toEqual(before.rows);
    expect(after.children).toEqual(before.children);
    expect(after.indexes).toEqual(before.indexes);
    expect(after.foreignKeys).toEqual(before.foreignKeys);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.jobs).toEqual(before.jobs);
    for (const old of before.schema.filter(
      (row) => !(row.type === "table" && row.name === "validation_job_results"),
    ))
      expect(
        after.schema.find(
          (row) =>
            row.schema_name === old.schema_name &&
            row.type === old.type &&
            row.name === old.name &&
            row.tbl_name === old.tbl_name,
        ),
      ).toEqual(old);
    expect(after.schema).toHaveLength(before.schema.length + 1);
    expect(
      after.schema.find(
        (row) => row.name === "tr_validation_job_result_v2_binding" && row.type === "trigger",
      )?.tbl_name,
    ).toBe("validation_job_results");
    expect(value.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(foreignKeys(value.database)).toBe(1);
    expect(value.database.isTransaction).toBe(false);
    expect(() =>
      value.database.exec("UPDATE validation_job_results SET result_json = result_json"),
    ).toThrow(/immutable/u);
    expect(() => value.database.exec("DELETE FROM validation_job_results")).toThrow(/immutable/u);
    const exec = vi.spyOn(value.database, "exec");
    expect(runMigrations(value.database, value.directory)).toBe(29);
    expect(exec.mock.calls.some(([sql]) => sql.includes("PRAGMA foreign_keys = OFF"))).toBe(false);
    expect(snapshot(value.database)).toEqual(after);
  });

  it("turns foreign keys off only around the startup-owned rebuild transaction and restores them", async () => {
    const value = await fixture();
    const windows: { transaction: boolean; foreignKeys: number }[] = [];
    value.database.function("observe_validation_rebuild_window", () => {
      windows.push({
        transaction: value.database.isTransaction,
        foreignKeys: foreignKeys(value.database),
      });
      return 1;
    });
    await install(
      value.directory,
      `SELECT observe_validation_rebuild_window();\n${await readFile(join(migrationDirectory, migrationName), "utf8")}`,
    );
    const exec = vi.spyOn(value.database, "exec");
    expect(runMigrations(value.database, value.directory)).toBe(29);
    expect(windows).toEqual([{ transaction: true, foreignKeys: 0 }]);
    const calls = exec.mock.calls.map(([sql]) => sql),
      off = calls.indexOf("PRAGMA foreign_keys = OFF");
    expect(off).toBeGreaterThanOrEqual(0);
    expect(calls[off + 1]).toBe("BEGIN IMMEDIATE");
    expect(calls.slice(-2)).toEqual(["COMMIT", "PRAGMA foreign_keys = ON"]);
    expect(foreignKeys(value.database)).toBe(1);
    expect(value.database.isTransaction).toBe(false);
  });

  it("accepts an actual validated V2 runner-only result after preserving the V1 history", async () => {
    const value = await fixture(["baseline"]);
    const history = snapshot(value.database).rows;
    await install(value.directory);
    expect(runMigrations(value.database, value.directory)).toBe(29);
    const cell = selected(value, "candidate"),
      completion = beginAttempt(value, cell);
    const result = { ...resultFor(cell), schemaVersion: "ValidationJobResultV2" as const };
    const validated = validateValidationCompletion(
      value.database,
      completion,
      sha256(canonicalJson(result)),
      result,
    );
    const id = transaction(value.database, () => {
      settle(value.database, completion, validated);
      const resultId = persistValidatedValidationResult(
        value.database,
        completion,
        validated,
        completedAt,
      );
      value.database
        .prepare(
          "UPDATE jobs SET status = 'succeeded', current_run_attempt_id = NULL, completed_at = ? WHERE id = ?",
        )
        .run(completedAt, cell.jobId);
      return resultId;
    });
    const row = value.database
      .prepare("SELECT schema_id, result_json FROM validation_job_results WHERE id = ?")
      .get(id);
    expect({ ...row }).toEqual({
      schema_id: "ValidationJobResultV2",
      result_json: canonicalJson(result),
    });
    expect(
      snapshot(value.database).rows.filter((entry) => entry.schema_id === "ValidationJobResultV1"),
    ).toEqual(history);
    expect(value.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    ["copy", "FROM validation_job_results;"],
    ["drop", "DROP TABLE validation_job_results;"],
    ["rename", "ALTER TABLE new_validation_job_results RENAME TO validation_job_results;"],
  ])(
    "rolls back all schema, history, rowids and the migration ledger after %s failure",
    async (_stage, marker) => {
      const value = await fixture(),
        before = snapshot(value.database);
      const sql = await readFile(join(migrationDirectory, migrationName), "utf8");
      expect(sql.split(marker)).toHaveLength(2);
      await install(
        value.directory,
        sql.replace(marker, `${marker}\nSELECT * FROM missing_validation_rebuild_fault;`),
      );
      const error = errorFrom(() => runMigrations(value.database, value.directory));
      expect(error.committed).toBe(false);
      expect(error.failures.map((failure) => failure.phase)).toEqual(["primary"]);
      expect(String(error.failures[0]?.error)).toContain("missing_validation_rebuild_fault");
      expectRollback(value.database, before);
    },
  );

  it.each([
    [
      "index",
      "CREATE INDEX unknown_validation_result_index ON validation_job_results (created_at)",
    ],
    ["view", "CREATE VIEW unknown_validation_result_view AS SELECT id FROM validation_job_results"],
    [
      "trigger",
      "CREATE TRIGGER unknown_validation_result_trigger AFTER INSERT ON jobs BEGIN SELECT id FROM validation_job_results; END",
    ],
    [
      "foreign key",
      "CREATE TABLE unknown_validation_result_child (result_id TEXT REFERENCES validation_job_results(id))",
    ],
    [
      "temporary view",
      "CREATE TEMP VIEW unknown_validation_result_temp AS SELECT id FROM validation_job_results",
    ],
    [
      "view shadowing an allowed trigger",
      "CREATE VIEW tr_validation_job_result_insert_consistency AS SELECT id FROM validation_job_results",
    ],
  ])("rejects an unknown dependent %s before dropping any retained object", async (_kind, sql) => {
    const value = await fixture();
    value.database.exec(sql);
    const before = snapshot(value.database);
    await install(value.directory);
    const exec = vi.spyOn(value.database, "exec");
    const error = errorFrom(() => runMigrations(value.database, value.directory));
    expect(String(error.failures[0]?.error)).toMatch(
      /Unknown dependent|Unexpected .*foreign keys/u,
    );
    expect(exec.mock.calls.some(([statement]) => /^DROP /u.test(statement))).toBe(false);
    expectRollback(value.database, before);
  });

  it.each(["helper", "migration entry"] as const)(
    "does not roll back a caller-owned transaction through %s",
    async (entry) => {
      const value = await fixture();
      await install(value.directory);
      value.database.exec(
        "CREATE TEMP TABLE caller_owned_marker(value TEXT); BEGIN IMMEDIATE; INSERT INTO caller_owned_marker VALUES ('retained')",
      );
      const apply = vi.fn();
      expect(() =>
        entry === "helper"
          ? runValidationResultRebuild(value.database, { isPending: () => true, apply })
          : runMigrations(value.database, value.directory),
      ).toThrow();
      expect(apply).not.toHaveBeenCalled();
      expect(value.database.isTransaction).toBe(true);
      expect(
        value.database
          .prepare("SELECT value FROM caller_owned_marker")
          .all()
          .map((row) => ({ ...row })),
      ).toEqual([{ value: "retained" }]);
      expect(foreignKeys(value.database)).toBe(1);
      value.database.exec("ROLLBACK");
      expect(value.database.prepare("SELECT value FROM caller_owned_marker").all()).toEqual([]);
    },
  );

  it("rejects foreign keys already disabled without changing that caller state", async () => {
    const value = await fixture();
    value.database.exec("PRAGMA foreign_keys = OFF");
    const apply = vi.fn();
    const error = errorFrom(() =>
      runValidationResultRebuild(value.database, { isPending: () => true, apply }),
    );
    expect(error.committed).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(foreignKeys(value.database)).toBe(0);
    expect(value.database.isTransaction).toBe(false);
    value.database.exec("PRAGMA foreign_keys = ON");
  });

  it("reports a committed migration as unconfirmed when foreign-key restoration fails", async () => {
    const value = await fixture(),
      beforeRows = snapshot(value.database).rows;
    await install(value.directory);
    const originalExec = value.database.exec.bind(value.database);
    const injected = vi.spyOn(value.database, "exec").mockImplementation((sql) => {
      if (sql === "PRAGMA foreign_keys = ON")
        throw new Error("synthetic foreign-key restoration failure");
      return originalExec(sql);
    });
    const error = errorFrom(() => runMigrations(value.database, value.directory));
    expect(error.committed).toBe(true);
    expect(error.failures.map((failure) => failure.phase)).toEqual(["restore"]);
    expect(value.database.isTransaction).toBe(false);
    expect(foreignKeys(value.database)).toBe(0);
    injected.mockRestore();
    value.database.exec("PRAGMA foreign_keys = ON");
    expect(runMigrations(value.database, value.directory)).toBe(29);
    expect(snapshot(value.database).rows).toEqual(beforeRows);
    expect(value.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each([
    "valid CLI execution",
    "duplicate model summary",
    "model-sourced check",
    "enriched raw model",
    "missing execution",
    "wrong execution job",
    "wrong execution attempt",
    "wrong execution prompt",
    "wrong execution output schema",
  ] as const)("enforces V2 %s at the rebuilt storage boundary", async (caseKind) => {
    const directory = await historicalDirectory();
    const value = createModelCliFixture({ kind: "pull_request", migrationsDirectory: directory });
    fixtures.push(value);
    await install(directory);
    expect(runMigrations(value.database, directory)).toBe(29);
    const selectedCell = value.cells.find((entry) => entry.arm === "baseline");
    if (!selectedCell)
      throw new Error("The required-model storage fixture needs its baseline cell.");
    const cell = {
      ...selectedCell,
      template: createEvaluationExecutionTemplate({
        runId: selectedCell.run_id,
        plan: selectedCell.plan,
        planDigest: selectedCell.plan_digest,
        frozenPrompt: selectedCell.prompt,
      }),
    };
    expect(cell.plan.modelRequirements.required).toBe(true);
    const completion = context(value.database, cell);
    const original = resultFor(cell),
      validated = transaction(value.database, () =>
        validateValidationCompletion(
          value.database,
          completion,
          sha256(canonicalJson(original)),
          original,
        ),
      );
    const report = structuredClone(original.report) as Record<string, unknown>;
    const summary = {
      schemaVersion: "ValidationSummaryV1",
      workItemKind: "pull_request",
      summary: "Synthetic advice.",
      observations: [],
      recommendation: "approve",
    };
    const model = {
      schemaVersion: "PrReviewPlanV2",
      summary: "Synthetic CLI review.",
      assessment: "approve",
      findings: [],
      requestedRecipeIds: [],
      verification: { status: "not_run", summary: "Runner checks are separate.", commands: [] },
    };
    const executionEvidence = {
      schemaVersion: "ReviewExecutionEvidenceV1",
      source: "worker",
      commandCapture: "complete",
      commands: [],
      worktree: { status: "clean", source: "git_status" },
    };
    const modelExecution = {
      schemaVersion: "CliModelExecutionV1",
      jobId: completion.jobId,
      runAttemptId: completion.runAttemptId,
      cli: { kind: "codex", version: "1.0.0", requestedModel: null },
      promptSha256: cell.prompt.promptSha256,
      outputSchemaSha256: cell.prompt.outputSchemaSha256,
      outputSha256: sha256(canonicalJson(model)),
      exitCode: 0,
    };
    let modelReview: Record<string, unknown> = { state: "not_requested" };
    if (caseKind === "duplicate model summary") report.modelSummary = summary;
    else if (caseKind === "model-sourced check") {
      const checks = report.checks as { source: string }[];
      const check = checks[0];
      if (!check) throw new Error("The synthetic check is absent.");
      check.source = "model";
    } else {
      modelReview = {
        state: "completed",
        result: caseKind === "enriched raw model" ? { ...model, executionEvidence } : model,
        executionEvidence,
        execution: modelExecution,
      };
      if (caseKind === "missing execution") delete modelReview.execution;
      else if (caseKind === "wrong execution job") modelExecution.jobId = "another-job";
      else if (caseKind === "wrong execution attempt")
        modelExecution.runAttemptId = "another-attempt";
      else if (caseKind === "wrong execution prompt")
        modelExecution.promptSha256 = sha256("another-prompt");
      else if (caseKind === "wrong execution output schema")
        modelExecution.outputSchemaSha256 = sha256("another-output-schema");
    }
    const json = canonicalJson({
      schemaVersion: "ValidationJobResultV2",
      report,
      execution: original.execution,
      modelReview,
    });
    const row = rawRow(validated, json);
    value.database.exec("BEGIN IMMEDIATE");
    try {
      // Storage probes align a synthetic settled attempt and exercise the rebuilt row format.
      // The accepted control establishes valid CLI metadata without running the owner or a model.
      value.database
        .prepare(
          "UPDATE run_attempts SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ? WHERE id = ?",
        )
        .run(sha256(json), json, completedAt, completion.runAttemptId);
      const columns = Object.keys(row);
      const insert = () =>
        value.database
          .prepare(
            `INSERT INTO validation_job_results (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          )
          .run(...Object.values(row));
      const accepted = caseKind === "valid CLI execution";
      if (accepted) expect(insert).not.toThrow();
      else expect(insert).toThrow();
      expect(
        value.database.prepare("SELECT COUNT(*) AS count FROM validation_job_results").get()?.count,
      ).toBe(accepted ? 1 : 0);
    } finally {
      value.database.exec("ROLLBACK");
    }
    expect(value.database.isTransaction).toBe(false);
    expect(foreignKeys(value.database)).toBe(1);
    expect(value.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
