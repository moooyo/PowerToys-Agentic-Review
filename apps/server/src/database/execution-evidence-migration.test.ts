import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../dist/database/migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const temporaryDirectories: string[] = [];
const openDatabases: DatabaseSync[] = [];
const timestamp = "2026-09-06T00:00:00.000Z";
const digest = "a".repeat(64);
const resultTables = [
  "review_results",
  "pr_review_results",
  "pr_review_findings",
  "issue_triage_results",
] as const;
type SqlRow = Record<string, string | number | null>;
type ReviewKind = "issue_triage" | "pull_request_review";

interface ReviewFixture {
  readonly jobId: string;
  readonly attemptId: string;
  readonly revisionId: string;
  readonly resultId: string;
  readonly resultRow: SqlRow;
  readonly kind: ReviewKind;
}

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("execution evidence migration", () => {
  it("preserves completed V1 results, projections, foreign keys, and immutable identities", async () => {
    const { database, pr, issue } = await createVersionEightFixture();
    const beforeRows = readResultTables(database);
    const beforeForeignKeys = readResultForeignKeys(database);
    const beforeTriggers = readResultTriggers(database);
    const beforeIndexes = readResultIndexes(database);

    expect(runMigrations(database, migrationsDirectory)).toBe(31);
    expect(readResultTables(database)).toEqual(beforeRows);
    expect(readResultForeignKeys(database)).toEqual(beforeForeignKeys);
    expectUpgradedResultTriggers(database, beforeTriggers);
    expect(readResultIndexes(database)).toEqual(beforeIndexes);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .prepare("SELECT status, failure_diagnostics_json FROM run_attempts ORDER BY id")
        .all(),
    ).toEqual([
      { status: "succeeded", failure_diagnostics_json: null },
      { status: "succeeded", failure_diagnostics_json: null },
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (?, ?) ORDER BY name",
        )
        .all("ix_review_results_work_item_created", "ix_pr_review_findings_priority"),
    ).toEqual([
      { name: "ix_pr_review_findings_priority" },
      { name: "ix_review_results_work_item_created" },
    ]);

    for (const table of resultTables) {
      const column = table === "review_results" ? "id" : "review_result_id";
      expect(() => database.exec(`UPDATE ${table} SET ${column} = ${column}`)).toThrow(
        /immutable/u,
      );
      expect(() => database.exec(`DELETE FROM ${table}`)).toThrow(/immutable/u);
    }
    expect(() =>
      database.prepare("UPDATE run_attempts SET result_json = '{}' WHERE id = ?").run(pr.attemptId),
    ).toThrow("completed review attempt result is immutable");
    expect(() =>
      database
        .prepare("UPDATE run_attempts SET status = 'failed' WHERE id = ?")
        .run(issue.attemptId),
    ).toThrow("completed review attempt result is immutable");
    expect(() =>
      database
        .prepare("UPDATE jobs SET execution_digest = ? WHERE id = ?")
        .run("b".repeat(64), pr.jobId),
    ).toThrow("GitHub review scheduling identity is immutable");
    expect(() =>
      database
        .prepare("UPDATE work_item_revisions SET revision_json = '{\"changed\":true}' WHERE id = ?")
        .run(pr.revisionId),
    ).toThrow("completed review revision identity is immutable");
    for (const [table, id] of [
      ["run_attempts", pr.attemptId],
      ["jobs", pr.jobId],
      ["work_item_revisions", pr.revisionId],
    ] as const) {
      expect(() => database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)).toThrow(
        /FOREIGN KEY/u,
      );
    }

    expect(runMigrations(database, migrationsDirectory)).toBe(31);
    expect(readResultTables(database)).toEqual(beforeRows);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back the entire table rebuild when the migration fails", async () => {
    const { database, directory } = await createVersionEightFixture();
    const beforeRows = readResultTables(database);
    const beforeForeignKeys = readResultForeignKeys(database);
    const beforeTriggers = readResultTriggers(database);
    const brokenDirectory = await createMigrationPrefixDirectory(directory, 10);
    await appendFile(
      join(brokenDirectory, "0010_execution_evidence_v2.sql"),
      "\nSELECT * FROM deliberately_missing_execution_evidence_migration_table;\n",
    );

    expect(() => runMigrations(database, brokenDirectory)).toThrow(
      /deliberately_missing_execution_evidence_migration_table/u,
    );
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual(
      {
        version: 9,
      },
    );
    expect(readResultTables(database)).toEqual(beforeRows);
    expect(readResultForeignKeys(database)).toEqual(beforeForeignKeys);
    expect(readResultTriggers(database)).toEqual(beforeTriggers);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('run_attempts') WHERE name = 'failure_diagnostics_json'",
        )
        .all(),
    ).toEqual([]);
    expect(
      database
        .prepare(`
          SELECT name FROM sqlite_schema
          WHERE name LIKE '%execution_evidence_v2%' OR name = 'review_results_v2'
          UNION ALL
          SELECT name FROM sqlite_temp_schema WHERE name LIKE '%execution_evidence_v2%'
        `)
        .all(),
    ).toEqual([]);

    await copyFile(
      join(migrationsDirectory, "0010_execution_evidence_v2.sql"),
      join(brokenDirectory, "0010_execution_evidence_v2.sql"),
    );
    expect(runMigrations(database, brokenDirectory)).toBe(10);
    expect(readResultTables(database)).toEqual(beforeRows);
    expect(readResultTriggers(database)).toEqual(beforeTriggers);
  });

  it.each([1, 2] as const)(
    "accepts complete PR and issue results using schema version %i",
    async (version) => {
      const { database, directory } = await createVersionEightFixture();
      const evidenceDirectory = await createMigrationPrefixDirectory(directory, 10);
      expect(runMigrations(database, evidenceDirectory)).toBe(10);

      for (const kind of ["pull_request_review", "issue_triage"] as const) {
        const review = seedReviewDependencies(database, `new-${kind}-${version}`, kind, version);
        insertRow(database, "review_results", review.resultRow);
        insertProjections(database, review);
        finishJob(database, review);

        expect(
          database
            .prepare(
              "SELECT schema_id, result_json, result_digest FROM review_results WHERE id = ?",
            )
            .get(review.resultId),
        ).toEqual({
          schema_id: review.resultRow.schema_id,
          result_json: review.resultRow.result_json,
          result_digest: review.resultRow.result_digest,
        });
        expect(database.prepare("SELECT status FROM jobs WHERE id = ?").get(review.jobId)).toEqual({
          status: "succeeded",
        });
      }
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it("rejects wrong schema identities and mismatched immutable result dependencies", async () => {
    const { database, directory } = await createVersionEightFixture();
    const evidenceDirectory = await createMigrationPrefixDirectory(directory, 10);
    expect(runMigrations(database, evidenceDirectory)).toBe(10);
    const review = seedReviewDependencies(database, "invalid-result", "pull_request_review", 2);
    const mismatches: SqlRow[] = [
      { schema_id: "IssueTriageV2" },
      { schema_id: "PrReviewPlanV1" },
      { schema_id: "PrReviewPlanV3" },
      { job_kind: "issue_triage" },
      { result_digest: "b".repeat(64) },
      { summary: "A different summary" },
      { requested_recipe_ids_json: '["unrequested-recipe"]' },
      { execution_template_json: "{}" },
      { allowed_recipe_ids_json: '["unapproved-recipe"]' },
      { revision_id: "missing-revision" },
    ];
    for (const mismatch of mismatches) {
      expect(() =>
        insertRow(database, "review_results", { ...review.resultRow, ...mismatch }),
      ).toThrow();
    }
    insertRow(database, "review_results", review.resultRow);
    expect(() => finishJob(database, review)).toThrow(
      "succeeded job requires a complete immutable review result",
    );
    insertProjections(database, review);
    finishJob(database, review);
  });

  it("enforces V2 projection contents, kinds, and finding completeness", async () => {
    const { database, directory } = await createVersionEightFixture();
    const evidenceDirectory = await createMigrationPrefixDirectory(directory, 10);
    expect(runMigrations(database, evidenceDirectory)).toBe(10);
    const pr = seedReviewDependencies(database, "projection-pr", "pull_request_review", 2);
    const issue = seedReviewDependencies(database, "projection-issue", "issue_triage", 2);
    insertRow(database, "review_results", pr.resultRow);
    insertRow(database, "review_results", issue.resultRow);

    expect(() =>
      insertRow(database, "pr_review_results", {
        review_result_id: issue.resultId,
        assessment: "comment",
      }),
    ).toThrow("PR review projection/result mismatch");
    expect(() =>
      insertRow(database, "pr_review_results", {
        review_result_id: pr.resultId,
        assessment: "approve",
      }),
    ).toThrow("PR review projection/result mismatch");
    expect(() => insertIssueProjection(database, pr.resultId)).toThrow(
      "issue triage projection/result mismatch",
    );
    expect(() =>
      database
        .prepare(`
        INSERT INTO issue_triage_results (
          review_result_id, category, priority, confidence, suggested_labels_json,
          missing_information_json, duplicate_candidates_json
        ) VALUES (?, 'bug', 1, 0.8, '["wrong-label"]', '["Provide a trace"]', '[]')
      `)
        .run(issue.resultId),
    ).toThrow("issue triage projection/result mismatch");

    insertPrProjection(database, pr.resultId);
    expect(() => finishJob(database, pr)).toThrow(
      "succeeded job requires a complete immutable review result",
    );
    expect(() =>
      database
        .prepare(`
        INSERT INTO pr_review_findings (
          review_result_id, ordinal, finding_id, priority, title, body, path,
          line, end_line, confidence
        ) VALUES (?, 0, 'finding-1', 1, 'Preserve task isolation', 'Different body',
          'src/worker.ts', 12, 14, 0.9)
      `)
        .run(pr.resultId),
    ).toThrow("PR finding/result mismatch");
    insertPrFindings(database, pr.resultId);
    insertIssueProjection(database, issue.resultId);
    finishJob(database, pr);
    finishJob(database, issue);

    expect(() => insertPrFindings(database, pr.resultId)).toThrow("PR finding/result mismatch");
    expect(() => insertIssueProjection(database, issue.resultId)).toThrow(
      "issue triage projection/result mismatch",
    );
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("stores bounded diagnostics including nullable and Windows process exit codes", async () => {
    const { database, pr } = await createVersionEightFixture();
    runMigrations(database, migrationsDirectory);
    const update = database.prepare(
      "UPDATE run_attempts SET failure_diagnostics_json = ? WHERE id = ?",
    );
    const values = [
      ...["workspace", "launch", "process", "event_stream", "result", "internal"].map(
        (category) => ({
          category,
          exitCode: null,
          summary: "The operation failed before completion.",
          correlationId: "failure-1",
        }),
      ),
      ...[-2_147_483_648, 0, 4_294_967_295].map((exitCode) => ({
        category: "process",
        exitCode,
        summary: "A process exited.",
        correlationId: "failure-exit-code",
      })),
      {
        category: "internal",
        exitCode: null,
        summary: "\u754c".repeat(2_048),
        correlationId: "c".repeat(128),
      },
      {
        category: "event_stream",
        exitCode: null,
        summary: "\u0001".repeat(2_048),
        correlationId: "c".repeat(128),
      },
      {
        category: "internal",
        exitCode: null,
        summary: "\u0000".repeat(2_048),
        correlationId: "\u0000".repeat(128),
      },
      {
        category: "internal",
        exitCode: null,
        summary: `${"\\u0000".repeat(341)}xx`,
        correlationId: `${"\\u0000".repeat(21)}xx`,
      },
    ];
    for (const value of values) {
      const json = JSON.stringify(value);
      update.run(json, pr.attemptId);
      expect(
        database
          .prepare("SELECT failure_diagnostics_json FROM run_attempts WHERE id = ?")
          .get(pr.attemptId),
      ).toEqual({ failure_diagnostics_json: json });
    }
    update.run(null, pr.attemptId);
    expect(
      database
        .prepare("SELECT failure_diagnostics_json FROM run_attempts WHERE id = ?")
        .get(pr.attemptId),
    ).toEqual({ failure_diagnostics_json: null });
  });

  it("rejects invalid, incomplete, extra, and oversized diagnostics on insert and update", async () => {
    const { database, pr } = await createVersionEightFixture();
    runMigrations(database, migrationsDirectory);
    const valid = {
      category: "process",
      exitCode: 1,
      summary: "The process failed.",
      correlationId: "failure-1",
    };
    const invalid = [
      "not-json",
      "null",
      "[]",
      "42",
      '"message"',
      "{}",
      ...Object.keys(valid).map((key) =>
        JSON.stringify(
          Object.fromEntries(Object.entries(valid).filter(([field]) => field !== key)),
        ),
      ),
      ...[
        { category: "unsupported" },
        { category: null },
        { exitCode: 1.5 },
        { exitCode: "1" },
        { exitCode: true },
        { exitCode: -2_147_483_649 },
        { exitCode: 4_294_967_296 },
        { summary: "" },
        { summary: null },
        { summary: 1 },
        { summary: "s".repeat(2_049) },
        { summary: `x\u0000${"s".repeat(2_047)}` },
        { summary: `${"\\u0000".repeat(341)}xxx` },
        { correlationId: "" },
        { correlationId: null },
        { correlationId: 1 },
        { correlationId: "c".repeat(129) },
        { correlationId: `c\u0000${"c".repeat(127)}` },
        { correlationId: `${"\\u0000".repeat(21)}xxx` },
        { additional: "not allowed" },
      ].map((override) => JSON.stringify({ ...valid, ...override })),
      `${" ".repeat(16_384)}${JSON.stringify(valid)}`,
    ];
    const attemptRow = database
      .prepare("SELECT * FROM run_attempts WHERE id = ?")
      .get(pr.attemptId) as SqlRow;
    const update = database.prepare(
      "UPDATE run_attempts SET failure_diagnostics_json = ? WHERE id = ?",
    );
    for (const json of invalid) {
      expect(() => update.run(json, pr.attemptId)).toThrow();
      expect(() =>
        insertRow(database, "run_attempts", {
          ...attemptRow,
          id: "invalid-diagnostics-attempt",
          attempt_number: 2,
          failure_diagnostics_json: json,
        }),
      ).toThrow();
    }
    insertRow(database, "run_attempts", {
      ...attemptRow,
      id: "valid-diagnostics-attempt",
      attempt_number: 2,
      failure_diagnostics_json: JSON.stringify(valid),
    });
    expect(
      database
        .prepare("SELECT failure_diagnostics_json FROM run_attempts WHERE id = ?")
        .get(pr.attemptId),
    ).toEqual({ failure_diagnostics_json: null });
  });
});

const createVersionEightFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-evidence-migration-"));
  temporaryDirectories.push(directory);
  const prefixDirectory = await createMigrationPrefixDirectory(directory, 8);
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA recursive_triggers = ON");
  expect(runMigrations(database, prefixDirectory)).toBe(8);
  seedInfrastructure(database);
  const pr = seedReviewDependencies(database, "original-pr", "pull_request_review", 1);
  const issue = seedReviewDependencies(database, "original-issue", "issue_triage", 1);
  for (const review of [pr, issue]) {
    insertRow(database, "review_results", review.resultRow);
    insertProjections(database, review);
    finishJob(database, review);
  }
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return { database, directory, pr, issue };
};

const createMigrationPrefixDirectory = async (
  parentDirectory: string,
  targetVersion: number,
): Promise<string> => {
  const directory = join(parentDirectory, `migrations-v${targetVersion}`);
  await mkdir(directory);
  const files = (await readdir(migrationsDirectory)).filter((filename) => {
    const version = /^(\d+)_.*\.sql$/u.exec(filename)?.[1];
    return version !== undefined && Number.parseInt(version, 10) <= targetVersion;
  });
  await Promise.all(
    files.map((filename) =>
      copyFile(join(migrationsDirectory, filename), join(directory, filename)),
    ),
  );
  return directory;
};

const insertRow = (database: DatabaseSync, table: string, row: SqlRow): void => {
  const columns = Object.keys(row);
  database
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(row));
};

const seedInfrastructure = (database: DatabaseSync): void => {
  insertRow(database, "repositories", {
    id: "repository-1",
    github_repository_id: 1,
    github_node_id: "repository-node-1",
    owner_login: "owner",
    name: "repository",
    full_name: "owner/repository",
    html_url: "https://github.com/owner/repository",
    default_branch: "main",
    is_private: 0,
    snapshot_json: "{}",
    observed_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
  insertRow(database, "workers", {
    id: "worker-1",
    node_id: "node-1",
    instance_id: "instance-1",
    display_name: "Test worker",
    version: "1",
    protocol_version: "1",
    max_slots: 2,
    capabilities_json: "[]",
    capabilities_digest: digest,
    status: "online",
    registered_at: timestamp,
    last_seen_at: timestamp,
    updated_at: timestamp,
  });
};

const seedReviewDependencies = (
  database: DatabaseSync,
  suffix: string,
  kind: ReviewKind,
  version: 1 | 2,
): ReviewFixture => {
  const resourceKind = kind === "pull_request_review" ? "pull_request" : "issue";
  const requestKind = kind === "pull_request_review" ? "review_request" : "assignment";
  const schemaId =
    kind === "pull_request_review" ? `PrReviewPlanV${version}` : `IssueTriageV${version}`;
  const itemId = `item-${suffix}`;
  const revisionId = `revision-${suffix}`;
  const revisionKey = `revision-key-${suffix}`;
  const eventId = `event-${suffix}`;
  const decisionId = `decision-${suffix}`;
  const epochId = `epoch-${suffix}`;
  const jobId = `job-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const resultId = `result-${suffix}`;
  const count = database.prepare("SELECT COUNT(*) + 1 AS number FROM work_items").get() as {
    number: number;
  };
  insertRow(database, "work_items", {
    id: itemId,
    repository_id: "repository-1",
    resource_kind: resourceKind,
    github_work_item_id: count.number,
    github_node_id: `item-node-${suffix}`,
    github_number: count.number,
    state: "open",
    title: "Review fixture",
    body: "Please review this change.",
    html_url: `https://github.com/owner/repository/issues/${count.number}`,
    author_github_user_id: 1,
    author_login: "author",
    author_account_type: "user",
    current_revision_key: revisionKey,
    is_draft: kind === "pull_request_review" ? 0 : null,
    source_created_at: timestamp,
    source_updated_at: timestamp,
    snapshot_json: "{}",
    projection_source: "poll",
    observed_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
  insertRow(database, "work_item_revisions", {
    id: revisionId,
    work_item_id: itemId,
    revision_key: revisionKey,
    resource_kind: resourceKind,
    base_sha: kind === "pull_request_review" ? "b".repeat(40) : null,
    head_sha: kind === "pull_request_review" ? "c".repeat(40) : null,
    content_digest: kind === "issue_triage" ? digest : null,
    source_updated_at: timestamp,
    observed_at: timestamp,
    revision_json: "{}",
    created_at: timestamp,
  });
  insertRow(database, "github_events", {
    id: eventId,
    event_key: eventId,
    source: "poll",
    source_event_id: eventId,
    repository_id: "repository-1",
    work_item_id: itemId,
    revision_id: revisionId,
    action: "request_opened",
    request_kind: requestKind,
    actor_github_user_id: 1,
    actor_login: "author",
    target_github_user_id: 2,
    target_login: "reviewer",
    occurred_at: timestamp,
    observed_at: timestamp,
    normalized_sha256: digest,
    normalized_json: "{}",
    created_at: timestamp,
  });
  insertRow(database, "authorization_decisions", {
    id: decisionId,
    decision_key: decisionId,
    github_event_id: eventId,
    work_item_id: itemId,
    outcome: "authorized",
    basis: "allowlist",
    reason: "authorized_allowlisted",
    policy_kind: "self_or_allowlist",
    policy_version: 1,
    actor_github_user_id: 1,
    target_github_user_id: 2,
    evaluated_at: timestamp,
    policy_json: "{}",
    policy_sha256: digest,
    decision_json: "{}",
    created_at: timestamp,
  });
  insertRow(database, "request_epochs", {
    id: epochId,
    work_item_id: itemId,
    ordinal: 1,
    request_kind: requestKind,
    target_github_user_id: 2,
    opening_event_id: eventId,
    authorization_decision_id: decisionId,
    current_revision_id: revisionId,
    status: "active",
    opened_at: timestamp,
    epoch_json: "{}",
    created_at: timestamp,
    updated_at: timestamp,
  });
  const executionJson = JSON.stringify({
    prompt: { promptSha256: digest, outputSchemaSha256: digest },
    executionPolicy: { allowedRecipeIds: ["unit-tests"] },
  });
  const executionDigest = sha256(executionJson);
  insertRow(database, "jobs", {
    id: jobId,
    work_item_id: itemId,
    job_kind: kind,
    semantic_key: jobId,
    concurrency_key: jobId,
    status: "running",
    execution_json: executionJson,
    execution_digest: executionDigest,
    required_capabilities_json: "[]",
    required_capabilities_digest: digest,
    resource_revision: revisionKey,
    attempt_count: 1,
    lease_generation: 1,
    current_run_attempt_id: attemptId,
    request_epoch_id: epochId,
    source_event_id: eventId,
    next_attempt_at: timestamp,
    started_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });
  const summary =
    kind === "pull_request_review"
      ? "A task isolation issue remains."
      : "A reproducible bug report.";
  const resultJson = JSON.stringify({
    schemaVersion: schemaId,
    summary,
    requestedRecipeIds: ["unit-tests"],
    ...(kind === "pull_request_review"
      ? {
          assessment: "request_changes",
          findings: [
            {
              findingId: "finding-1",
              priority: 1,
              title: "Preserve task isolation",
              body: "Cancelling this task must preserve sibling tasks.",
              path: "src/worker.ts",
              line: 12,
              endLine: 14,
              confidence: 0.9,
            },
          ],
        }
      : {
          category: "bug",
          priority: 1,
          confidence: 0.8,
          suggestedLabels: ["bug"],
          missingInformation: ["Provide a trace"],
          duplicateCandidates: [{ number: 42, reason: "The same failure signature." }],
        }),
    ...(version === 2
      ? {
          verification: {
            status: "passed",
            summary: "The targeted unit tests passed.",
            commands: [{ command: "pnpm test", status: "passed" }],
          },
          executionEvidence: {
            schemaVersion: "ReviewExecutionEvidenceV1",
            source: "worker",
            commandCapture: "complete",
            commands: [
              { itemId: "command-1", command: "pnpm test", status: "completed", exitCode: 0 },
            ],
            worktree: { status: "clean", source: "git_status" },
          },
        }
      : {}),
  });
  const resultDigest = sha256(resultJson);
  insertRow(database, "run_attempts", {
    id: attemptId,
    job_id: jobId,
    attempt_number: 1,
    worker_id: "worker-1",
    worker_node_id: "node-1",
    worker_instance_id: "instance-1",
    status: "succeeded",
    lease_token_hash: digest,
    lease_generation: 1,
    lease_expires_at: timestamp,
    execution_deadline_at: timestamp,
    no_progress_timeout_ms: 30_000,
    no_progress_deadline_at: timestamp,
    last_heartbeat_at: timestamp,
    phase: "completed",
    result_digest: resultDigest,
    result_json: resultJson,
    started_at: timestamp,
    ended_at: timestamp,
  });
  return {
    jobId,
    attemptId,
    revisionId,
    resultId,
    kind,
    resultRow: {
      id: resultId,
      run_attempt_id: attemptId,
      job_id: jobId,
      work_item_id: itemId,
      revision_id: revisionId,
      job_kind: kind,
      resource_revision: revisionKey,
      schema_id: schemaId,
      result_digest: resultDigest,
      result_json: resultJson,
      summary,
      requested_recipe_ids_json: '["unit-tests"]',
      output_schema_sha256: digest,
      prompt_sha256: digest,
      allowed_recipe_ids_json: '["unit-tests"]',
      execution_template_sha256: executionDigest,
      execution_template_json: executionJson,
      created_at: timestamp,
    },
  };
};

const insertPrProjection = (database: DatabaseSync, resultId: string): void => {
  database
    .prepare(`
    INSERT INTO pr_review_results (review_result_id, assessment)
    SELECT id, json_extract(result_json, '$.assessment') FROM review_results WHERE id = ?
  `)
    .run(resultId);
};

const insertPrFindings = (database: DatabaseSync, resultId: string): void => {
  database
    .prepare(`
    INSERT INTO pr_review_findings (
      review_result_id, ordinal, finding_id, priority, title, body, path, line, end_line, confidence
    )
    SELECT result.id, CAST(finding.key AS INTEGER),
      json_extract(finding.value, '$.findingId'), json_extract(finding.value, '$.priority'),
      json_extract(finding.value, '$.title'), json_extract(finding.value, '$.body'),
      json_extract(finding.value, '$.path'), json_extract(finding.value, '$.line'),
      json_extract(finding.value, '$.endLine'), json_extract(finding.value, '$.confidence')
    FROM review_results AS result, json_each(result.result_json, '$.findings') AS finding
    WHERE result.id = ?
  `)
    .run(resultId);
};

const insertIssueProjection = (database: DatabaseSync, resultId: string): void => {
  database
    .prepare(`
    INSERT INTO issue_triage_results (
      review_result_id, category, priority, confidence, suggested_labels_json,
      missing_information_json, duplicate_candidates_json
    )
    SELECT id, json_extract(result_json, '$.category'), json_extract(result_json, '$.priority'),
      json_extract(result_json, '$.confidence'), json_extract(result_json, '$.suggestedLabels'),
      json_extract(result_json, '$.missingInformation'), json_extract(result_json, '$.duplicateCandidates')
    FROM review_results WHERE id = ?
  `)
    .run(resultId);
};

const insertProjections = (database: DatabaseSync, review: ReviewFixture): void => {
  if (review.kind === "pull_request_review") {
    insertPrProjection(database, review.resultId);
    insertPrFindings(database, review.resultId);
  } else {
    insertIssueProjection(database, review.resultId);
  }
};

const finishJob = (database: DatabaseSync, review: ReviewFixture): void => {
  database
    .prepare("UPDATE jobs SET status = 'succeeded', completed_at = ? WHERE id = ?")
    .run(timestamp, review.jobId);
};

const readResultTables = (database: DatabaseSync) =>
  resultTables.map((table) => ({
    table,
    rows: database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
  }));

const readResultForeignKeys = (database: DatabaseSync) =>
  resultTables.map((table) => ({
    table,
    keys: database.prepare(`PRAGMA foreign_key_list(${table})`).all(),
  }));

const readResultIndexes = (database: DatabaseSync) =>
  resultTables.map((table) => ({
    table,
    indexes: database
      .prepare(`
    SELECT definition.origin, definition.[unique], definition.partial,
      entry.seqno, entry.cid, entry.name, entry.[desc], entry.coll, entry.[key]
    FROM pragma_index_list(?) AS definition, pragma_index_xinfo(definition.name) AS entry
    ORDER BY definition.origin, definition.[unique], definition.partial, definition.seq, entry.seqno
  `)
      .all(table),
  }));

function expectUpgradedResultTriggers(database: DatabaseSync, previous: unknown[]): void {
  const current = readResultTriggers(database);
  expect(current).toEqual(expect.arrayContaining(previous));
  expect(current).toHaveLength(previous.length + 1);
  expect(current).toContainEqual({
    name: "tr_review_result_reject_validation_job",
    tbl_name: "review_results",
  });
}

const readResultTriggers = (database: DatabaseSync) =>
  database
    .prepare(`
  SELECT name, tbl_name FROM sqlite_schema
  WHERE type = 'trigger'
    AND (
      tbl_name IN ('review_results', 'pr_review_results', 'pr_review_findings', 'issue_triage_results')
      OR name IN (
        'tr_job_success_review_result_consistency',
        'tr_run_attempt_completed_review_identity_immutable',
        'tr_work_item_revision_completed_review_identity_immutable'
      )
    )
  ORDER BY name
`)
    .all();

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
