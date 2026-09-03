import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  CreateResultArtifactUploadResponseSchema,
  FinalizeResultArtifactUploadResponseSchema,
  isCanonicalResultArtifactChunkData,
  maximumResultArtifactBytes,
  ResultArtifactChunkResponseSchema,
  TerminateResultArtifactUploadRequestSchema,
  TerminateResultArtifactUploadResponseSchema,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactCleanupLiabilityPageSql,
  artifactDueCleanupPageSql,
  artifactReconciliationCursorName,
  calculateArtifactNamespaceObservationSha256,
  classifyArtifactNamespacePageAndAdvanceCursor,
  commitArtifactChunk,
  commitArtifactFinalize,
  completeArtifactCleanup,
  completeArtifactNamespaceCleanup,
  createArtifactUpload,
  listDueArtifactCleanups,
  listDueArtifactNamespaceCleanups,
  maximumArtifactCreateAccountingRows,
  maximumArtifactNamespaceHealthRows,
  maximumArtifactNamespacePageSize,
  maximumArtifactReconciliationBatchSize,
  maximumDeclaredResultArtifactBytesPerAttempt,
  maximumResultArtifactUploadIdentitiesPerAttempt,
  prepareArtifactChunk,
  prepareArtifactFinalize,
  probeArtifactUploadCreate,
  readArtifactHealthAccounting,
  readArtifactReconciliationCursor,
  recordArtifactCleanupFailure,
  recordArtifactNamespaceCleanupFailure,
  terminalizeInactiveArtifactUploads,
  terminateArtifactUpload,
  toFinalizeResultArtifactUploadResponse,
  toResultArtifactChunkResponse,
  toTerminateResultArtifactUploadResponse,
} from "../../dist/database/artifacts.js";
import {
  ArtifactCompletionModeMismatchError,
  ArtifactReconciliationConflictError,
  ArtifactReconciliationInvalidRequestError,
  ArtifactReconciliationStateError,
  ArtifactUploadQuotaExceededError,
  LeaseLostError,
} from "../../dist/database/errors.js";
import { runMigrations } from "../../dist/database/migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const versionEightMigrationFilenames = [
  "0001_initial.sql",
  "0002_github_ingestion.sql",
  "0003_operator_auth.sql",
  "0004_github_polling_state.sql",
  "0005_operator_browser_flows.sql",
  "0006_immutable_review_results.sql",
  "0007_operator_login_claim.sql",
  "0008_result_artifacts.sql",
] as const;
const versionTenMigrationFilenames = [
  ...versionEightMigrationFilenames,
  "0009_artifact_completion_foundation.sql",
  "0010_artifact_reconciliation.sql",
] as const;
const leaseToken = "artifact-test-lease-token".padEnd(32, "x");
const clientArtifactId = "12345678-1234-4123-8123-123456789abc";
const artifactClientId = (ordinal: number): string =>
  `00000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set(
    "date-time",
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value)),
  );
}

interface Fixture {
  database: DatabaseSync;
  readonly databasePath: string;
  readonly directory: string;
}

const fixtures: Fixture[] = [];

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const openFixture = async (
  completionMode: "inline_result_v1" | "result_artifact_v1" = "result_artifact_v1",
): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-artifact-db-"));
  const databasePath = join(directory, "state.db");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
  runMigrations(database, migrationsDirectory);
  const now = "2026-09-01T00:00:00.000Z";
  const future = "2099-09-01T00:00:00.000Z";
  database
    .prepare(`
      INSERT INTO workers (
        id,
        node_id,
        instance_id,
        display_name,
        version,
        protocol_version,
        max_slots,
        capabilities_json,
        capabilities_digest,
        status,
        registered_at,
        last_seen_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?)
    `)
    .run(
      "worker-row",
      "worker-node",
      "worker-instance",
      "Artifact test worker",
      "test",
      "1.0",
      1,
      "{}",
      sha256("{}"),
      now,
      now,
      now,
    );
  database
    .prepare(`
      INSERT INTO jobs (
        id,
        job_kind,
        semantic_key,
        concurrency_key,
        status,
        execution_json,
        required_capabilities_json,
        resource_revision,
        attempt_count,
        max_attempts,
        lease_generation,
        current_run_attempt_id,
        next_attempt_at,
        started_at,
        created_at,
        updated_at
      ) VALUES (?, 'issue_triage', ?, ?, 'running', '{}', '[]', ?, 1, 3, 1, ?, ?, ?, ?, ?)
    `)
    .run(
      "job-artifact",
      "artifact-semantic-key",
      "artifact-concurrency-key",
      sha256("revision"),
      "run-artifact",
      now,
      now,
      now,
      now,
    );
  database
    .prepare(`
      INSERT INTO run_attempts (
        id,
        job_id,
        attempt_number,
        worker_id,
        worker_node_id,
        worker_instance_id,
        status,
        lease_token_hash,
        lease_generation,
        lease_expires_at,
        execution_deadline_at,
        no_progress_timeout_ms,
        no_progress_deadline_at,
        last_heartbeat_at,
        phase,
        completion_mode,
        started_at
      ) VALUES (?, ?, 1, ?, ?, ?, 'running', ?, 1, ?, ?, 600000, ?, ?, 'uploading', ?, ?)
    `)
    .run(
      "run-artifact",
      "job-artifact",
      "worker-row",
      "worker-node",
      "worker-instance",
      sha256(leaseToken),
      future,
      future,
      future,
      now,
      completionMode,
      now,
    );
  const fixture = { database, databasePath, directory };
  fixtures.push(fixture);
  return fixture;
};

const reopenFixtureDatabase = (fixture: Fixture): DatabaseSync => {
  fixture.database.close();
  const database = new DatabaseSync(fixture.databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
  fixture.database = database;
  return database;
};

const identity = {
  jobId: "job-artifact",
  runAttemptId: "run-artifact",
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  leaseToken,
  leaseGeneration: 1,
} as const;

const artifactModeIdentity = {
  jobId: "job-artifact-mode",
  runAttemptId: "run-artifact-mode",
  workerNodeId: "worker-node",
  workerInstanceId: "worker-instance",
  leaseToken,
  leaseGeneration: 1,
} as const;

const addArtifactModeAttempt = (database: DatabaseSync): void => {
  const now = "2026-09-01T00:00:00.000Z";
  const future = "2099-09-01T00:00:00.000Z";
  database
    .prepare(`
      INSERT INTO jobs (
        id,
        job_kind,
        semantic_key,
        concurrency_key,
        status,
        execution_json,
        required_capabilities_json,
        resource_revision,
        attempt_count,
        max_attempts,
        lease_generation,
        current_run_attempt_id,
        next_attempt_at,
        started_at,
        created_at,
        updated_at
      ) VALUES (?, 'issue_triage', ?, ?, 'running', '{}', '[]', ?, 1, 3, 1, ?, ?, ?, ?, ?)
    `)
    .run(
      artifactModeIdentity.jobId,
      "artifact-mode-semantic-key",
      "artifact-mode-concurrency-key",
      sha256("artifact-mode-revision"),
      artifactModeIdentity.runAttemptId,
      now,
      now,
      now,
      now,
    );
  database
    .prepare(`
      INSERT INTO run_attempts (
        id,
        job_id,
        attempt_number,
        worker_id,
        worker_node_id,
        worker_instance_id,
        status,
        lease_token_hash,
        lease_generation,
        lease_expires_at,
        execution_deadline_at,
        no_progress_timeout_ms,
        no_progress_deadline_at,
        last_heartbeat_at,
        phase,
        completion_mode,
        started_at
      ) VALUES (?, ?, 1, ?, ?, ?, 'running', ?, 1, ?, ?, 600000, ?, ?, 'uploading', ?, ?)
    `)
    .run(
      artifactModeIdentity.runAttemptId,
      artifactModeIdentity.jobId,
      "worker-row",
      artifactModeIdentity.workerNodeId,
      artifactModeIdentity.workerInstanceId,
      sha256(leaseToken),
      future,
      future,
      future,
      now,
      "result_artifact_v1",
      now,
    );
};

const createAndTerminateUpload = (
  database: DatabaseSync,
  ordinal: number,
  totalBytes: number,
): void => {
  const upload = createArtifactUpload(database, {
    ...identity,
    clientArtifactId: artifactClientId(ordinal),
    purpose: "result",
    name: `result-${ordinal}.json`,
    mediaType: "application/json",
    totalBytes,
    sha256: sha256(`artifact-${ordinal}-${totalBytes}`),
  });
  terminateArtifactUpload(database, {
    ...identity,
    uploadId: upload.uploadId,
    state: "abandoned",
    reason: "client_abandoned",
  });
};

const createLiveUpload = (database: DatabaseSync, ordinal = 0) =>
  createArtifactUpload(database, {
    ...identity,
    clientArtifactId: artifactClientId(ordinal),
    purpose: "result",
    name: `reconciliation-${ordinal}.json`,
    mediaType: "application/json",
    totalBytes: 2,
    sha256: sha256(`reconciliation-${ordinal}`),
  });

const namespaceStagingObservation = (
  uploadId: string,
  _sweepGeneration: number,
  observedBytes = 1,
  fileInode = "2",
) => {
  const identity = {
    entryKey: `staging/${uploadId}.upload`,
    kind: "staging" as const,
    uploadId,
    finalizationId: null,
    linkedObjectSha256: null,
    observedBytes,
    expectedLinkCount: 1 as const,
    fileDevice: "1",
    fileInode,
    fileCtimeNs: "3",
    fileMode: "384",
    fileUid: "1000",
    parentDevice: "1",
    parentInode: "4",
    parentMode: "448",
    parentUid: "1000",
    linkedObjectDevice: null,
    linkedObjectInode: null,
    linkedObjectCtimeNs: null,
  };
  return {
    ...identity,
    observationSha256: calculateArtifactNamespaceObservationSha256(identity),
  };
};

const namespaceTemporaryObservation = (
  uploadId: string,
  finalizationId: string,
  objectSha256: string,
  _sweepGeneration: number,
  observedBytes = 1,
) => {
  const identity = {
    entryKey:
      `objects/sha256/${objectSha256.slice(0, 2)}/.publish-` + `${uploadId}-${finalizationId}.tmp`,
    kind: "publication-temporary" as const,
    uploadId,
    finalizationId,
    linkedObjectSha256: null,
    observedBytes,
    expectedLinkCount: 1 as const,
    fileDevice: "1",
    fileInode: "12",
    fileCtimeNs: "13",
    fileMode: "384",
    fileUid: "1000",
    parentDevice: "1",
    parentInode: "14",
    parentMode: "448",
    parentUid: "1000",
    linkedObjectDevice: null,
    linkedObjectInode: null,
    linkedObjectCtimeNs: null,
  };
  return {
    ...identity,
    observationSha256: calculateArtifactNamespaceObservationSha256(identity),
  };
};

const insertNamespaceCollisionUpload = (
  database: DatabaseSync,
  uploadId: string,
  ordinal: number,
  totalBytes: number,
  digest: string,
): void => {
  const now = "2026-09-01T00:00:00.000Z";
  database
    .prepare(`
      INSERT INTO artifact_uploads (
        id, job_id, run_attempt_id, worker_node_id, worker_instance_id,
        lease_generation, client_artifact_id, purpose, name, media_type,
        expected_total_bytes, expected_sha256, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, 'result', ?, 'application/json', ?, ?, 'receiving', ?, ?)
    `)
    .run(
      uploadId,
      identity.jobId,
      identity.runAttemptId,
      identity.workerNodeId,
      identity.workerInstanceId,
      artifactClientId(ordinal),
      `namespace-${ordinal}.json`,
      totalBytes,
      digest,
      now,
      now,
    );
};

const insertRawUpload = (database: DatabaseSync, ordinal: number, totalBytes: number): void => {
  const now = "2026-09-01T00:00:00.000Z";
  database
    .prepare(`
      INSERT INTO artifact_uploads (
        id,
        job_id,
        run_attempt_id,
        worker_node_id,
        worker_instance_id,
        lease_generation,
        client_artifact_id,
        purpose,
        name,
        media_type,
        expected_total_bytes,
        expected_sha256,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'result', ?, 'application/json', ?, ?, 'receiving', ?, ?)
    `)
    .run(
      `raw-upload-${ordinal}`,
      identity.jobId,
      identity.runAttemptId,
      identity.workerNodeId,
      identity.workerInstanceId,
      identity.leaseGeneration,
      artifactClientId(ordinal),
      `raw-${ordinal}.json`,
      totalBytes,
      sha256(`raw-${ordinal}-${totalBytes}`),
      now,
      now,
    );
};

const insertSyntheticArtifactHistory = (
  database: DatabaseSync,
  count: number,
  status: "receiving" | "abandoned",
  cleanupStatus?: "pending" | "completed",
): void => {
  database.exec("PRAGMA foreign_keys = OFF; DROP TRIGGER tr_artifact_upload_insert_consistency;");
  database
    .prepare(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ),
      sequence(value) AS (
        SELECT ones.value + 10 * tens.value + 100 * hundreds.value + 1000 * thousands.value + 1
        FROM digits AS ones
        CROSS JOIN digits AS tens
        CROSS JOIN digits AS hundreds
        CROSS JOIN digits AS thousands
      )
      INSERT INTO artifact_uploads (
        id,
        job_id,
        run_attempt_id,
        worker_node_id,
        worker_instance_id,
        lease_generation,
        client_artifact_id,
        purpose,
        name,
        media_type,
        expected_total_bytes,
        expected_sha256,
        status,
        terminated_at,
        termination_reason,
        created_at,
        updated_at
      )
      SELECT
        'synthetic-upload-' || value,
        'synthetic-job-' || value,
        'synthetic-run-' || value,
        'synthetic-worker',
        'synthetic-instance',
        1,
        printf('00000000-0000-4000-8000-%012d', value),
        'result',
        'synthetic-' || value || '.json',
        'application/json',
        value % 2 + 1,
        printf('%064x', value),
        ?,
        CASE WHEN ? = 'abandoned' THEN '2026-09-01T00:01:00.000Z' ELSE NULL END,
        CASE WHEN ? = 'abandoned' THEN 'synthetic_abandoned' ELSE NULL END,
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:01:00.000Z'
      FROM sequence
      WHERE value <= ?
    `)
    .run(status, status, status, count);

  if (cleanupStatus !== undefined) {
    if (cleanupStatus === "completed") {
      database.exec("DROP TRIGGER tr_artifact_upload_cleanup_insert_consistency");
    }
    database
      .prepare(`
        INSERT INTO artifact_upload_cleanup_journal (
          upload_id,
          terminal_status,
          cleanup_scope,
          status,
          attempt_count,
          created_at,
          updated_at,
          completed_at
        )
        SELECT
          id,
          'abandoned',
          'staging_only_v1',
          ?,
          0,
          '2026-09-01T00:01:00.000Z',
          '2026-09-01T00:01:00.000Z',
          CASE WHEN ? = 'completed' THEN '2026-09-01T00:01:00.000Z' ELSE NULL END
        FROM artifact_uploads
        WHERE id LIKE 'synthetic-upload-%'
      `)
      .run(cleanupStatus, cleanupStatus);
  }
  database.exec("PRAGMA foreign_keys = ON");
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("result artifact database state machine", () => {
  it("keeps the selected completion mode immutable", async () => {
    const { database } = await openFixture("inline_result_v1");
    expect(
      database
        .prepare("SELECT completion_mode FROM run_attempts WHERE id = ?")
        .get(identity.runAttemptId),
    ).toEqual({ completion_mode: "inline_result_v1" });
    expect(() =>
      database
        .prepare("UPDATE run_attempts SET completion_mode = 'result_artifact_v1' WHERE id = ?")
        .run(identity.runAttemptId),
    ).toThrow(/completion mode is immutable/u);

    const artifactFixture = await openFixture();
    expect(() =>
      artifactFixture.database
        .prepare("UPDATE run_attempts SET completion_mode = 'inline_result_v1' WHERE id = ?")
        .run(identity.runAttemptId),
    ).toThrow(/completion mode is immutable/u);
  });

  it("requires artifact mode for every upload operation before state or replay access", async () => {
    const { database } = await openFixture("inline_result_v1");
    addArtifactModeAttempt(database);
    const result = Buffer.from("{}", "utf8");
    const terminatedCreateInput = {
      ...artifactModeIdentity,
      clientArtifactId: artifactClientId(0),
      purpose: "result" as const,
      name: "terminated.json",
      mediaType: "application/json" as const,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };
    const terminatedUpload = createArtifactUpload(database, terminatedCreateInput);
    const terminationInput = {
      ...artifactModeIdentity,
      uploadId: terminatedUpload.uploadId,
      state: "abandoned" as const,
      reason: "client_abandoned",
    };
    const terminated = terminateArtifactUpload(database, terminationInput);
    expect(terminateArtifactUpload(database, terminationInput)).toEqual({
      ...terminated,
      replayed: true,
    });

    const createInput = {
      ...artifactModeIdentity,
      clientArtifactId: artifactClientId(1),
      purpose: "result" as const,
      name: "result.json",
      mediaType: "application/json" as const,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };
    const upload = createArtifactUpload(database, createInput);
    expect(createArtifactUpload(database, createInput)).toEqual({ ...upload, replayed: true });
    expect(probeArtifactUploadCreate(database, createInput)).toEqual({
      disposition: "exact-replay",
      result: { ...upload, replayed: true },
    });
    const chunkInput = {
      ...artifactModeIdentity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: result.byteLength,
      chunkSha256: createInput.sha256,
    };
    const preparedChunk = prepareArtifactChunk(database, chunkInput);
    const committedChunk = commitArtifactChunk(database, {
      ...chunkInput,
      prepareId: preparedChunk.prepareId,
    });
    expect(prepareArtifactChunk(database, chunkInput)).toMatchObject({ replayed: true });
    expect(
      commitArtifactChunk(database, { ...chunkInput, prepareId: preparedChunk.prepareId }),
    ).toEqual({ ...committedChunk, outcome: "replayed" });
    const finalizeInput = {
      ...artifactModeIdentity,
      uploadId: chunkInput.uploadId,
      chunkCount: 1,
      totalBytes: result.byteLength,
      sha256: createInput.sha256,
    };
    const preparedFinalize = prepareArtifactFinalize(database, finalizeInput);
    const committedFinalize = commitArtifactFinalize(database, {
      ...finalizeInput,
      finalizationId: preparedFinalize.finalizationId,
      storageObjectKey: preparedFinalize.storageObjectKey,
    });
    expect(prepareArtifactFinalize(database, finalizeInput)).toEqual({
      ...preparedFinalize,
      state: "committed",
      replayed: true,
    });
    expect(
      commitArtifactFinalize(database, {
        ...finalizeInput,
        finalizationId: preparedFinalize.finalizationId,
        storageObjectKey: preparedFinalize.storageObjectKey,
      }),
    ).toEqual({ ...committedFinalize, replayed: true });

    const asInlineLease = <T extends object>(input: T) => ({
      ...input,
      ...identity,
    });
    const artifactReplayOperations = [
      ["probe create replay", () => probeArtifactUploadCreate(database, createInput)],
      ["create replay", () => createArtifactUpload(database, createInput)],
      ["prepare chunk replay", () => prepareArtifactChunk(database, chunkInput)],
      [
        "commit chunk replay",
        () =>
          commitArtifactChunk(database, {
            ...chunkInput,
            prepareId: preparedChunk.prepareId,
          }),
      ],
      ["prepare finalize replay", () => prepareArtifactFinalize(database, finalizeInput)],
      [
        "commit finalize replay",
        () =>
          commitArtifactFinalize(database, {
            ...finalizeInput,
            finalizationId: preparedFinalize.finalizationId,
            storageObjectKey: preparedFinalize.storageObjectKey,
          }),
      ],
      ["terminate replay", () => terminateArtifactUpload(database, terminationInput)],
    ] as const;
    const operations = [
      [
        "probe create replay",
        () => probeArtifactUploadCreate(database, asInlineLease(createInput)),
      ],
      ["create replay", () => createArtifactUpload(database, asInlineLease(createInput))],
      ["prepare chunk replay", () => prepareArtifactChunk(database, asInlineLease(chunkInput))],
      [
        "commit chunk replay",
        () =>
          commitArtifactChunk(database, {
            ...asInlineLease(chunkInput),
            prepareId: preparedChunk.prepareId,
          }),
      ],
      [
        "prepare finalize replay",
        () => prepareArtifactFinalize(database, asInlineLease(finalizeInput)),
      ],
      [
        "commit finalize replay",
        () =>
          commitArtifactFinalize(database, {
            ...asInlineLease(finalizeInput),
            finalizationId: preparedFinalize.finalizationId,
            storageObjectKey: preparedFinalize.storageObjectKey,
          }),
      ],
      [
        "terminate replay",
        () => terminateArtifactUpload(database, asInlineLease(terminationInput)),
      ],
    ] as const;

    const uploadCount = database.prepare("SELECT COUNT(*) AS count FROM artifact_uploads").get();
    const chunkCount = database
      .prepare("SELECT COUNT(*) AS count FROM artifact_upload_chunks")
      .get();
    const artifactCount = database.prepare("SELECT COUNT(*) AS count FROM run_artifacts").get();

    for (const [operation, invoke] of operations) {
      let thrown: unknown;
      try {
        invoke();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, operation).toBeInstanceOf(ArtifactCompletionModeMismatchError);
      expect(thrown, operation).toMatchObject({
        code: "ARTIFACT_COMPLETION_MODE_MISMATCH",
      });
      expect((thrown as Error).message, operation).not.toMatch(
        /inline_result_v1|result_artifact_v1/u,
      );
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM artifact_uploads").get()).toEqual(
      uploadCount,
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM artifact_upload_chunks").get()).toEqual(
      chunkCount,
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM run_artifacts").get()).toEqual(
      artifactCount,
    );

    database
      .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", identity.runAttemptId);
    for (const [operation, invoke] of operations) {
      expect(invoke, operation).toThrow(LeaseLostError);
      try {
        invoke();
      } catch (error) {
        expect(error, operation).toMatchObject({ code: "LEASE_LOST" });
      }
    }

    database
      .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", artifactModeIdentity.runAttemptId);
    for (const [operation, invoke] of artifactReplayOperations) {
      expect(invoke, operation).toThrow(LeaseLostError);
    }
  });

  it("upgrades v8 attempts as inline and backfills terminal cleanup intent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentic-review-artifact-v8-"));
    const versionEightDirectory = join(directory, "migrations-v8");
    await mkdir(versionEightDirectory);
    await Promise.all(
      versionEightMigrationFilenames.map((filename) =>
        copyFile(join(migrationsDirectory, filename), join(versionEightDirectory, filename)),
      ),
    );
    const databasePath = join(directory, "state.db");
    const database = new DatabaseSync(databasePath);
    fixtures.push({ database, databasePath, directory });
    database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
    expect(runMigrations(database, versionEightDirectory)).toBe(8);

    const now = "2026-09-01T00:00:00.000Z";
    const future = "2099-09-01T00:00:00.000Z";
    database
      .prepare(`
        INSERT INTO workers (
          id,
          node_id,
          instance_id,
          display_name,
          version,
          protocol_version,
          max_slots,
          capabilities_json,
          capabilities_digest,
          status,
          registered_at,
          last_seen_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?)
      `)
      .run(
        "worker-row",
        identity.workerNodeId,
        identity.workerInstanceId,
        "Artifact migration test worker",
        "test",
        "1.0",
        1,
        "{}",
        sha256("{}"),
        now,
        now,
        now,
      );
    database
      .prepare(`
        INSERT INTO jobs (
          id,
          job_kind,
          semantic_key,
          concurrency_key,
          status,
          execution_json,
          required_capabilities_json,
          resource_revision,
          attempt_count,
          max_attempts,
          lease_generation,
          current_run_attempt_id,
          next_attempt_at,
          started_at,
          created_at,
          updated_at
        ) VALUES (?, 'issue_triage', ?, ?, 'running', '{}', '[]', ?, 1, 3, 1, ?, ?, ?, ?, ?)
      `)
      .run(
        identity.jobId,
        "artifact-migration-semantic-key",
        "artifact-migration-concurrency-key",
        sha256("artifact-migration-revision"),
        identity.runAttemptId,
        now,
        now,
        now,
        now,
      );
    database
      .prepare(`
        INSERT INTO run_attempts (
          id,
          job_id,
          attempt_number,
          worker_id,
          worker_node_id,
          worker_instance_id,
          status,
          lease_token_hash,
          lease_generation,
          lease_expires_at,
          execution_deadline_at,
          no_progress_timeout_ms,
          no_progress_deadline_at,
          last_heartbeat_at,
          phase,
          started_at
        ) VALUES (?, ?, 1, ?, ?, ?, 'running', ?, 1, ?, ?, 600000, ?, ?, 'uploading', ?)
      `)
      .run(
        identity.runAttemptId,
        identity.jobId,
        "worker-row",
        identity.workerNodeId,
        identity.workerInstanceId,
        sha256(leaseToken),
        future,
        future,
        future,
        now,
        now,
      );
    insertRawUpload(database, 0, 1);
    database
      .prepare(`
        UPDATE artifact_uploads
        SET
          status = 'abandoned',
          terminated_at = ?,
          termination_reason = 'client_abandoned',
          updated_at = ?
        WHERE client_artifact_id = ?
      `)
      .run(now, now, artifactClientId(0));
    const terminalUpload = database
      .prepare("SELECT id FROM artifact_uploads WHERE client_artifact_id = ?")
      .get(artifactClientId(0)) as { readonly id: string };

    expect(runMigrations(database, migrationsDirectory)).toBe(13);
    expect(
      database
        .prepare(`
          SELECT name, sweep_generation, after_key, last_completed_at
          FROM artifact_reconciliation_cursors
        `)
        .all(),
    ).toEqual([
      {
        name: "managed_namespace_v1",
        sweep_generation: 0,
        after_key: null,
        last_completed_at: null,
      },
    ]);
    expect(
      database
        .prepare(`
          SELECT name, sweep_generation, after_key, last_completed_at
          FROM artifact_namespace_reconciliation_cursors
        `)
        .all(),
    ).toEqual([
      {
        name: artifactReconciliationCursorName,
        sweep_generation: 0,
        after_key: null,
        last_completed_at: null,
      },
    ]);
    expect(
      database
        .prepare("SELECT completion_mode FROM run_attempts WHERE id = ?")
        .get(identity.runAttemptId),
    ).toEqual({ completion_mode: "inline_result_v1" });
    const legacyReplayInput = {
      ...identity,
      clientArtifactId: artifactClientId(0),
      purpose: "result" as const,
      name: "raw-0.json",
      mediaType: "application/json" as const,
      totalBytes: 1,
      sha256: sha256("raw-0-1"),
    };
    expect(() => createArtifactUpload(database, legacyReplayInput)).toThrow(
      ArtifactCompletionModeMismatchError,
    );
    expect(() => probeArtifactUploadCreate(database, legacyReplayInput)).toThrow(
      ArtifactCompletionModeMismatchError,
    );
    expect(
      database
        .prepare(`
          SELECT terminal_status, cleanup_scope, status, attempt_count
          FROM artifact_upload_cleanup_journal
          WHERE upload_id = ?
        `)
        .get(terminalUpload.id),
    ).toEqual({
      terminal_status: "abandoned",
      cleanup_scope: "staging_only_v1",
      status: "pending",
      attempt_count: 0,
    });
  });

  for (const legacyCursor of [
    {
      label: "a completed v1 sweep",
      sweepGeneration: 7,
      afterKey: null,
      lastCompletedAt: "2026-09-01T00:00:00.000Z",
    },
    {
      label: "a mid-sweep v1 cursor outside the v2 entry grammar",
      sweepGeneration: 9,
      afterKey: "legacy/cursor",
      lastCompletedAt: null,
    },
  ] as const) {
    it(`starts an independent v2 namespace proof after ${legacyCursor.label}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "agentic-review-artifact-v10-cursor-"));
      const versionTenDirectory = join(directory, "migrations-v10");
      await mkdir(versionTenDirectory);
      await Promise.all(
        versionTenMigrationFilenames.map((filename) =>
          copyFile(join(migrationsDirectory, filename), join(versionTenDirectory, filename)),
        ),
      );
      const databasePath = join(directory, "state.db");
      const database = new DatabaseSync(databasePath);
      fixtures.push({ database, databasePath, directory });
      database.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
      expect(runMigrations(database, versionTenDirectory)).toBe(10);

      const updatedAt = "2026-09-01T00:00:01.000Z";
      database
        .prepare(`
          UPDATE artifact_reconciliation_cursors
          SET sweep_generation = ?, after_key = ?, updated_at = ?, last_completed_at = ?
          WHERE name = 'managed_namespace_v1'
        `)
        .run(
          legacyCursor.sweepGeneration,
          legacyCursor.afterKey,
          updatedAt,
          legacyCursor.lastCompletedAt,
        );

      expect(runMigrations(database, migrationsDirectory)).toBe(13);
      expect(
        database
          .prepare(`
            SELECT sweep_generation, after_key, updated_at, last_completed_at
            FROM artifact_reconciliation_cursors
            WHERE name = 'managed_namespace_v1'
          `)
          .get(),
      ).toEqual({
        sweep_generation: legacyCursor.sweepGeneration,
        after_key: legacyCursor.afterKey,
        updated_at: updatedAt,
        last_completed_at: legacyCursor.lastCompletedAt,
      });
      expect(readArtifactReconciliationCursor(database, {})).toMatchObject({
        name: artifactReconciliationCursorName,
        sweepGeneration: 0,
        afterKey: null,
        lastCompletedAt: null,
      });
      expect(readArtifactHealthAccounting(database, {}).capacity.accountingCertain).toBe(false);

      const completed = classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: null,
        observations: [],
        completedSweep: true,
      });
      expect(completed.cursor).toMatchObject({
        sweepGeneration: 1,
        afterKey: null,
        lastCompletedAt: expect.any(String),
      });
    });
  }

  it("distinguishes canonical base64url chunks from non-zero trailing pad bits", () => {
    expect(isCanonicalResultArtifactChunkData("Zg")).toBe(true);
    expect(isCanonicalResultArtifactChunkData("Zm8")).toBe(true);
    expect(isCanonicalResultArtifactChunkData("Zh")).toBe(false);
    expect(isCanonicalResultArtifactChunkData("Zm9")).toBe(false);
    expect(isCanonicalResultArtifactChunkData("Zg==")).toBe(false);
  });

  it("limits public artifact states and termination authority", () => {
    const chunkResponse = {
      uploadId: "upload-id",
      state: "finalizing",
      chunkIndex: 0,
      outcome: "replayed",
      nextChunkIndex: 1,
      nextOffsetBytes: 2,
    };
    expect(Value.Check(ResultArtifactChunkResponseSchema, chunkResponse)).toBe(true);
    expect(
      Value.Check(ResultArtifactChunkResponseSchema, { ...chunkResponse, state: "committed" }),
    ).toBe(true);
    expect(
      Value.Check(ResultArtifactChunkResponseSchema, {
        ...chunkResponse,
        state: "receiving",
        outcome: "accepted",
      }),
    ).toBe(true);
    expect(
      Value.Check(ResultArtifactChunkResponseSchema, {
        ...chunkResponse,
        state: "committed",
        outcome: "accepted",
      }),
    ).toBe(false);
    expect(
      Value.Check(ResultArtifactChunkResponseSchema, { ...chunkResponse, state: "corrupt" }),
    ).toBe(false);

    const termination = {
      ...identity,
      state: "abandoned",
      reason: "client_abandoned",
    };
    expect(Value.Check(TerminateResultArtifactUploadRequestSchema, termination)).toBe(true);
    expect(
      Value.Check(TerminateResultArtifactUploadRequestSchema, {
        ...termination,
        state: "corrupt",
        reason: "staging_digest_mismatch",
      }),
    ).toBe(false);
  });

  it("replays one create identity and rejects changed immutable metadata", async () => {
    const { database } = await openFixture();
    const result = Buffer.from('{"summary":"ok"}', "utf8");
    const input = {
      ...identity,
      clientArtifactId,
      purpose: "result" as const,
      name: "result.json",
      mediaType: "application/json" as const,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };

    const created = createArtifactUpload(database, input);
    const replay = createArtifactUpload(database, input);

    expect(created.replayed).toBe(false);
    expect(replay).toEqual({ ...created, replayed: true });
    expect(Value.Check(CreateResultArtifactUploadResponseSchema, created)).toBe(true);
    expect(Value.Check(CreateResultArtifactUploadResponseSchema, replay)).toBe(true);
    expect(
      Value.Check(CreateResultArtifactUploadResponseSchema, {
        ...created,
        nextChunkIndex: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(CreateResultArtifactUploadResponseSchema, {
        ...created,
        state: "finalizing",
      }),
    ).toBe(false);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM artifact_uploads").get() as { count: number },
    ).toEqual({ count: 1 });
    expect(() => createArtifactUpload(database, { ...input, name: "changed.json" })).toThrow(
      /different immutable state/u,
    );
    expect(() => probeArtifactUploadCreate(database, { ...input, name: "changed.json" })).toThrow(
      /different immutable state/u,
    );
  });

  it("probes DB-authoritative create accounting without mutating upload identity", async () => {
    const { database } = await openFixture();
    const existing = createArtifactUpload(database, {
      ...identity,
      clientArtifactId: artifactClientId(0),
      purpose: "result",
      name: "existing.json",
      mediaType: "application/json",
      totalBytes: 5,
      sha256: sha256("existing"),
    });
    addArtifactModeAttempt(database);
    const input = {
      ...artifactModeIdentity,
      clientArtifactId: artifactClientId(1),
      purpose: "result" as const,
      name: "probed.json",
      mediaType: "application/json" as const,
      totalBytes: 11,
      sha256: sha256("probed"),
    };
    const before = database.prepare("SELECT COUNT(*) AS count FROM artifact_uploads").get();

    expect(probeArtifactUploadCreate(database, input)).toEqual({
      disposition: "new",
      accounting: {
        accountingCertain: false,
        liveUploadCount: 1,
        liveUploadExpectedByteSizeBuckets: [{ expectedTotalBytes: 5, uploadCount: 1 }],
        cleanupBacklogEntries: 0,
      },
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM artifact_uploads").get()).toEqual(
      before,
    );

    terminateArtifactUpload(database, {
      ...identity,
      uploadId: existing.uploadId,
      state: "abandoned",
      reason: "client_abandoned",
    });
    expect(probeArtifactUploadCreate(database, input)).toEqual({
      disposition: "new",
      accounting: {
        accountingCertain: false,
        liveUploadCount: 1,
        liveUploadExpectedByteSizeBuckets: [{ expectedTotalBytes: 5, uploadCount: 1 }],
        cleanupBacklogEntries: 1,
      },
    });

    const created = createArtifactUpload(database, input);
    expect(probeArtifactUploadCreate(database, input)).toEqual({
      disposition: "exact-replay",
      result: { ...created, replayed: true },
    });
  });

  it("keeps create accounting bounded independently of large completed history", async () => {
    const { database } = await openFixture();
    insertSyntheticArtifactHistory(database, 5_000, "abandoned", "completed");
    const input = {
      ...identity,
      clientArtifactId,
      purpose: "result" as const,
      name: "result.json",
      mediaType: "application/json" as const,
      totalBytes: 2,
      sha256: sha256("{}"),
    };

    expect(probeArtifactUploadCreate(database, input)).toEqual({
      disposition: "new",
      accounting: {
        accountingCertain: false,
        liveUploadCount: 0,
        liveUploadExpectedByteSizeBuckets: [],
        cleanupBacklogEntries: 0,
      },
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM artifact_uploads WHERE id LIKE 'synthetic-%'")
        .get(),
    ).toEqual({ count: 5_000 });
  });

  it("materializes the bounded cleanup page before artifact primary-key lookups", async () => {
    const { database } = await openFixture();
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${artifactCleanupLiabilityPageSql}`)
      .all(17) as unknown as readonly { readonly detail: string }[];
    const details = plan.map((row) => row.detail);

    expect(details.some((detail) => /MATERIALIZE due_cleanup/u.test(detail))).toBe(true);
    expect(
      details.some((detail) => detail.includes("ix_artifact_upload_cleanup_journal_due")),
    ).toBe(true);
    expect(details.some((detail) => /SEARCH upload USING INDEX/u.test(detail))).toBe(true);
    expect(details.some((detail) => /SCAN upload/u.test(detail))).toBe(false);
  });

  it("uses the fair due-cleanup expression index", async () => {
    const { database } = await openFixture();
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${artifactDueCleanupPageSql}`)
      .all("2099-01-01T00:00:00.000Z", 17) as unknown as readonly {
      readonly detail: string;
    }[];
    expect(
      plan.some((row) => row.detail.includes("ix_artifact_upload_cleanup_journal_due_v2")),
    ).toBe(true);
  });

  it("saturates create accounting after a fixed active-liability row budget", async () => {
    const { database } = await openFixture();
    insertSyntheticArtifactHistory(database, maximumArtifactCreateAccountingRows + 1, "receiving");
    const probe = probeArtifactUploadCreate(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: 2,
      sha256: sha256("{}"),
    });
    if (probe.disposition !== "new") {
      throw new Error("Expected a new create probe disposition.");
    }
    expect(probe.accounting).toMatchObject({
      accountingCertain: false,
      liveUploadCount: maximumArtifactCreateAccountingRows,
      cleanupBacklogEntries: 0,
    });
    expect(probe.accounting.liveUploadExpectedByteSizeBuckets).toHaveLength(2);
    expect(
      probe.accounting.liveUploadExpectedByteSizeBuckets.reduce(
        (total, bucket) => total + bucket.uploadCount,
        0,
      ),
    ).toBe(maximumArtifactCreateAccountingRows);
  });

  it("saturates cleanup-backed liabilities within the remaining fixed row budget", async () => {
    const { database } = await openFixture();
    insertSyntheticArtifactHistory(
      database,
      maximumArtifactCreateAccountingRows + 1,
      "abandoned",
      "pending",
    );
    const probe = probeArtifactUploadCreate(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: 2,
      sha256: sha256("{}"),
    });
    if (probe.disposition !== "new") {
      throw new Error("Expected a new create probe disposition.");
    }
    expect(probe.accounting).toMatchObject({
      accountingCertain: false,
      liveUploadCount: maximumArtifactCreateAccountingRows,
      cleanupBacklogEntries: maximumArtifactCreateAccountingRows + 1,
    });
    expect(probe.accounting.liveUploadExpectedByteSizeBuckets).toHaveLength(2);
    expect(
      probe.accounting.liveUploadExpectedByteSizeBuckets.reduce(
        (total, bucket) => total + bucket.uploadCount,
        0,
      ),
    ).toBe(maximumArtifactCreateAccountingRows);
  });

  it("rechecks create authority after a probe observes concurrently changing state", async () => {
    const { database } = await openFixture();
    const probedInput = {
      ...identity,
      clientArtifactId: artifactClientId(0),
      purpose: "result" as const,
      name: "probed.json",
      mediaType: "application/json" as const,
      totalBytes: 3,
      sha256: sha256("probed"),
    };
    expect(probeArtifactUploadCreate(database, probedInput)).toMatchObject({
      disposition: "new",
    });

    const competing = createArtifactUpload(database, {
      ...identity,
      clientArtifactId: artifactClientId(1),
      purpose: "result",
      name: "competing.json",
      mediaType: "application/json",
      totalBytes: 7,
      sha256: sha256("competing"),
    });
    expect(() => createArtifactUpload(database, probedInput)).toThrow(
      /already has a live result artifact upload/u,
    );
    expect(
      database
        .prepare("SELECT id, client_artifact_id FROM artifact_uploads WHERE run_attempt_id = ?")
        .all(identity.runAttemptId),
    ).toEqual([{ id: competing.uploadId, client_artifact_id: artifactClientId(1) }]);
  });

  it("returns an exact create replay before applying new-identity admission limits", async () => {
    const { database } = await openFixture();
    for (let ordinal = 0; ordinal < maximumResultArtifactUploadIdentitiesPerAttempt; ordinal += 1) {
      createAndTerminateUpload(database, ordinal, 1);
    }
    const replayInput = {
      ...identity,
      clientArtifactId: artifactClientId(7),
      purpose: "result" as const,
      name: "result-7.json",
      mediaType: "application/json" as const,
      totalBytes: 1,
      sha256: sha256("artifact-7-1"),
    };
    const replay = probeArtifactUploadCreate(database, replayInput);
    expect(replay).toMatchObject({ disposition: "exact-replay" });
    expect(replay).not.toHaveProperty("accounting");
    expect(() =>
      probeArtifactUploadCreate(database, {
        ...replayInput,
        clientArtifactId: artifactClientId(8),
        name: "result-8.json",
        sha256: sha256("artifact-8-1"),
      }),
    ).toThrow(/upload identity quota/u);
  });

  it("blocks INSERT OR REPLACE on the live-result partial unique without changing quota accounting", async () => {
    const { database } = await openFixture();
    const result = Buffer.from("{}", "utf8");
    const original = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const readRows = () =>
      database
        .prepare(`
            SELECT id, client_artifact_id, expected_total_bytes
            FROM artifact_uploads
            WHERE run_attempt_id = ?
            ORDER BY id
          `)
        .all(identity.runAttemptId);
    const readUsage = () =>
      database
        .prepare(`
            SELECT COUNT(*) AS upload_count, SUM(expected_total_bytes) AS declared_bytes
            FROM artifact_uploads
            WHERE run_attempt_id = ?
          `)
        .get(identity.runAttemptId);
    const originalRows = readRows();
    const originalUsage = readUsage();
    expect(originalRows).toEqual([
      {
        id: original.uploadId,
        client_artifact_id: clientArtifactId,
        expected_total_bytes: result.byteLength,
      },
    ]);
    expect(originalUsage).toEqual({
      upload_count: 1,
      declared_bytes: result.byteLength,
    });

    const replacementBytes = result.byteLength + 17;
    expect(() =>
      database
        .prepare(`
            INSERT OR REPLACE INTO artifact_uploads (
              id,
              job_id,
              run_attempt_id,
              worker_node_id,
              worker_instance_id,
              lease_generation,
              client_artifact_id,
              purpose,
              name,
              media_type,
              expected_total_bytes,
              expected_sha256,
              status,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'result', ?, 'application/json', ?, ?, 'receiving', ?, ?)
          `)
        .run(
          "replacement-upload",
          identity.jobId,
          identity.runAttemptId,
          identity.workerNodeId,
          identity.workerInstanceId,
          identity.leaseGeneration,
          artifactClientId(1),
          "replacement.json",
          replacementBytes,
          sha256("replacement"),
          "2026-09-01T00:01:00.000Z",
          "2026-09-01T00:01:00.000Z",
        ),
    ).toThrow(/identities and live results cannot be replaced/u);

    expect(readRows()).toEqual(originalRows);
    expect(readUsage()).toEqual(originalUsage);
    expect(
      database.prepare("SELECT id FROM artifact_uploads WHERE id = ?").get("replacement-upload"),
    ).toBeUndefined();
  });

  it("blocks UPDATE OR REPLACE from deleting another attempt's upload or quota charge", async () => {
    const { database } = await openFixture();
    addArtifactModeAttempt(database);
    const victim = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "victim.json",
      mediaType: "application/json",
      totalBytes: 2,
      sha256: sha256("victim"),
    });
    const donor = createArtifactUpload(database, {
      ...artifactModeIdentity,
      clientArtifactId: artifactClientId(2),
      purpose: "result",
      name: "donor.json",
      mediaType: "application/json",
      totalBytes: 7,
      sha256: sha256("donor"),
    });
    const readRows = () =>
      database
        .prepare(`
            SELECT id, run_attempt_id, client_artifact_id, expected_total_bytes, status
            FROM artifact_uploads
            WHERE id IN (?, ?)
            ORDER BY run_attempt_id
          `)
        .all(victim.uploadId, donor.uploadId);
    const readUsage = () =>
      database
        .prepare(`
            SELECT
              run_attempt_id,
              COUNT(*) AS upload_count,
              SUM(expected_total_bytes) AS declared_bytes
            FROM artifact_uploads
            WHERE run_attempt_id IN (?, ?)
            GROUP BY run_attempt_id
            ORDER BY run_attempt_id
          `)
        .all(identity.runAttemptId, artifactModeIdentity.runAttemptId);
    const originalRows = readRows();
    const originalUsage = readUsage();
    expect(originalRows).toEqual([
      {
        id: victim.uploadId,
        run_attempt_id: identity.runAttemptId,
        client_artifact_id: clientArtifactId,
        expected_total_bytes: 2,
        status: "receiving",
      },
      {
        id: donor.uploadId,
        run_attempt_id: artifactModeIdentity.runAttemptId,
        client_artifact_id: artifactClientId(2),
        expected_total_bytes: 7,
        status: "receiving",
      },
    ]);
    expect(originalUsage).toEqual([
      {
        run_attempt_id: identity.runAttemptId,
        upload_count: 1,
        declared_bytes: 2,
      },
      {
        run_attempt_id: artifactModeIdentity.runAttemptId,
        upload_count: 1,
        declared_bytes: 7,
      },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM artifact_upload_chunks").get()).toEqual({
      count: 0,
    });

    expect(() =>
      database
        .prepare("UPDATE OR REPLACE artifact_uploads SET id = ? WHERE id = ?")
        .run(victim.uploadId, donor.uploadId),
    ).toThrow(/artifact upload primary keys are immutable/u);

    expect(readRows()).toEqual(originalRows);
    expect(readUsage()).toEqual(originalUsage);
    expect(database.prepare("SELECT COUNT(*) AS count FROM artifact_upload_chunks").get()).toEqual({
      count: 0,
    });
  });

  it("charges terminal upload identities permanently and enforces the SQL identity ceiling", async () => {
    const { database } = await openFixture();
    expect(maximumResultArtifactUploadIdentitiesPerAttempt).toBe(8);
    for (let ordinal = 0; ordinal < maximumResultArtifactUploadIdentitiesPerAttempt; ordinal += 1) {
      createAndTerminateUpload(database, ordinal, 1);
    }

    const replay = createArtifactUpload(database, {
      ...identity,
      clientArtifactId: artifactClientId(7),
      purpose: "result",
      name: "result-7.json",
      mediaType: "application/json",
      totalBytes: 1,
      sha256: sha256("artifact-7-1"),
    });
    expect(replay).toMatchObject({ state: "abandoned", replayed: true });

    const createNinth = () =>
      createArtifactUpload(database, {
        ...identity,
        clientArtifactId: artifactClientId(8),
        purpose: "result",
        name: "result-8.json",
        mediaType: "application/json",
        totalBytes: 1,
        sha256: sha256("artifact-8-1"),
      });
    expect(createNinth).toThrow(ArtifactUploadQuotaExceededError);
    expect(createNinth).toThrow(/upload identity quota/u);
    expect(() => insertRawUpload(database, 8, 1)).toThrow(/identity quota exceeded/u);
  });

  it("enforces the cumulative declared-byte ceiling in code and SQL", async () => {
    const { database } = await openFixture();
    expect(maximumResultArtifactBytes * maximumResultArtifactUploadIdentitiesPerAttempt).toBe(
      maximumDeclaredResultArtifactBytesPerAttempt,
    );
    for (let ordinal = 0; ordinal < maximumResultArtifactUploadIdentitiesPerAttempt; ordinal += 1) {
      createAndTerminateUpload(database, ordinal, maximumResultArtifactBytes);
    }

    const createOverBudget = () =>
      createArtifactUpload(database, {
        ...identity,
        clientArtifactId: artifactClientId(8),
        purpose: "result",
        name: "result-8.json",
        mediaType: "application/json",
        totalBytes: 1,
        sha256: sha256("artifact-8-1"),
      });
    expect(createOverBudget).toThrow(ArtifactUploadQuotaExceededError);
    expect(createOverBudget).toThrow(/declared result artifact byte quota/u);
    expect(() => insertRawUpload(database, 8, 1)).toThrow(/declared-byte quota exceeded/u);
  });

  it("uses stable prepared receipts and advances only after an exact commit", async () => {
    const { database } = await openFixture();
    const result = Buffer.from('{"summary":"ok"}', "utf8");
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const firstBytes = result.subarray(0, 5);
    const chunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: firstBytes.byteLength,
      chunkSha256: sha256(firstBytes),
    };

    const prepared = prepareArtifactChunk(database, chunk);
    const replay = prepareArtifactChunk(database, chunk);

    expect(prepared.replayed).toBe(false);
    expect(prepared.receiptState).toBe("prepared");
    expect(prepared).toMatchObject({ uploadState: "receiving", committedArtifact: null });
    expect(prepared.committedPrefix).toEqual([]);
    expect(replay).toEqual({ ...prepared, replayed: true });
    expect(() =>
      commitArtifactChunk(database, {
        ...chunk,
        prepareId: prepared.prepareId,
        chunkBytes: prepared.chunkBytes + 1,
      }),
    ).toThrow(/does not match its prepared receipt/u);

    const committed = commitArtifactChunk(database, { ...chunk, prepareId: prepared.prepareId });
    const committedReplay = commitArtifactChunk(database, {
      ...chunk,
      prepareId: prepared.prepareId,
    });
    expect(committed).toMatchObject({
      state: "receiving",
      outcome: "accepted",
      nextChunkIndex: 1,
      nextOffsetBytes: firstBytes.byteLength,
    });
    expect(Value.Check(ResultArtifactChunkResponseSchema, committed)).toBe(false);
    const publicResponse = toResultArtifactChunkResponse(committed);
    expect(Value.Check(ResultArtifactChunkResponseSchema, publicResponse)).toBe(true);
    expect(publicResponse).not.toHaveProperty("prepareId");
    expect(committedReplay).toEqual({ ...committed, outcome: "replayed" });
  });

  it("returns the global upload cursor when an older committed chunk is replayed", async () => {
    const { database } = await openFixture();
    const result = Buffer.from('{"summary":"two chunks"}', "utf8");
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const firstBytes = result.subarray(0, 5);
    const firstChunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: firstBytes.byteLength,
      chunkSha256: sha256(firstBytes),
    };
    const firstReceipt = prepareArtifactChunk(database, firstChunk);
    commitArtifactChunk(database, { ...firstChunk, prepareId: firstReceipt.prepareId });

    const secondBytes = result.subarray(firstBytes.byteLength);
    const secondChunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 1,
      offsetBytes: firstBytes.byteLength,
      chunkBytes: secondBytes.byteLength,
      chunkSha256: sha256(secondBytes),
    };
    const secondReceipt = prepareArtifactChunk(database, secondChunk);
    commitArtifactChunk(database, { ...secondChunk, prepareId: secondReceipt.prepareId });

    expect(
      commitArtifactChunk(database, { ...firstChunk, prepareId: firstReceipt.prepareId }),
    ).toMatchObject({
      state: "receiving",
      outcome: "replayed",
      chunkIndex: 0,
      nextChunkIndex: 2,
      nextOffsetBytes: result.byteLength,
    });
  });

  it("returns the full committed prefix for multi-chunk prepare and restart replay", async () => {
    const fixture = await openFixture();
    let database = fixture.database;
    const result = Buffer.from("abcdefghijklmnop", "utf8");
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const firstBytes = result.subarray(0, 4);
    const firstChunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: firstBytes.byteLength,
      chunkSha256: sha256(firstBytes),
    };
    const firstPrepare = prepareArtifactChunk(database, firstChunk);
    expect(firstPrepare.committedPrefix).toEqual([]);
    commitArtifactChunk(database, { ...firstChunk, prepareId: firstPrepare.prepareId });

    const secondBytes = result.subarray(4, 9);
    const secondChunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 1,
      offsetBytes: firstBytes.byteLength,
      chunkBytes: secondBytes.byteLength,
      chunkSha256: sha256(secondBytes),
    };
    const firstCommittedReceipt = {
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: firstBytes.byteLength,
      chunkSha256: sha256(firstBytes),
    };
    const secondPrepare = prepareArtifactChunk(database, secondChunk);
    expect(secondPrepare.committedPrefix).toEqual([firstCommittedReceipt]);
    commitArtifactChunk(database, { ...secondChunk, prepareId: secondPrepare.prepareId });

    database = reopenFixtureDatabase(fixture);
    const secondReplay = prepareArtifactChunk(database, secondChunk);
    const committedPrefix = [
      firstCommittedReceipt,
      {
        chunkIndex: 1,
        offsetBytes: firstBytes.byteLength,
        chunkBytes: secondBytes.byteLength,
        chunkSha256: sha256(secondBytes),
      },
    ];
    expect(secondReplay).toMatchObject({
      receiptState: "committed",
      replayed: true,
      committedNextChunkIndex: 2,
      committedOffsetBytes: firstBytes.byteLength + secondBytes.byteLength,
      committedPrefix,
    });

    const thirdBytes = result.subarray(9);
    const thirdPrepare = prepareArtifactChunk(database, {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 2,
      offsetBytes: firstBytes.byteLength + secondBytes.byteLength,
      chunkBytes: thirdBytes.byteLength,
      chunkSha256: sha256(thirdBytes),
    });
    expect(thirdPrepare).toMatchObject({
      receiptState: "prepared",
      replayed: false,
      committedPrefix,
    });
  });

  it("fails closed when direct SQL damage makes the committed prefix discontinuous", async () => {
    const { database } = await openFixture();
    const result = Buffer.from("abcdefghijklmnop", "utf8");
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const firstBytes = result.subarray(0, 4);
    const firstChunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: firstBytes.byteLength,
      chunkSha256: sha256(firstBytes),
    };
    const firstPrepare = prepareArtifactChunk(database, firstChunk);
    commitArtifactChunk(database, { ...firstChunk, prepareId: firstPrepare.prepareId });
    const secondBytes = result.subarray(4, 9);
    const secondChunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 1,
      offsetBytes: firstBytes.byteLength,
      chunkBytes: secondBytes.byteLength,
      chunkSha256: sha256(secondBytes),
    };
    const secondPrepare = prepareArtifactChunk(database, secondChunk);
    commitArtifactChunk(database, { ...secondChunk, prepareId: secondPrepare.prepareId });

    database.exec("DROP TRIGGER tr_artifact_chunk_receipt_update");
    database
      .prepare(`
        UPDATE artifact_upload_chunks
        SET offset_bytes = offset_bytes + 1
        WHERE upload_id = ? AND chunk_index = 1
      `)
      .run(upload.uploadId);

    const thirdBytes = result.subarray(9);
    expect(() =>
      prepareArtifactChunk(database, {
        ...identity,
        uploadId: upload.uploadId,
        chunkIndex: 2,
        offsetBytes: firstBytes.byteLength + secondBytes.byteLength,
        chunkBytes: thirdBytes.byteLength,
        chunkSha256: sha256(thirdBytes),
      }),
    ).toThrow(/committed artifact prefix is not contiguous/u);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM artifact_upload_chunks WHERE upload_id = ?")
        .get(upload.uploadId),
    ).toEqual({ count: 2 });
  });

  it("prepares and commits finalization only after all chunk receipts are committed", async () => {
    const { database } = await openFixture();
    const result = Buffer.from('{"summary":"ok"}', "utf8");
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const finalize = {
      ...identity,
      uploadId: upload.uploadId,
      chunkCount: 1,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };
    expect(() => prepareArtifactFinalize(database, finalize)).toThrow(/completed upload cursor/u);

    const chunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: result.byteLength,
      chunkSha256: sha256(result),
    };
    const preparedChunk = prepareArtifactChunk(database, chunk);
    commitArtifactChunk(database, { ...chunk, prepareId: preparedChunk.prepareId });

    const prepared = prepareArtifactFinalize(database, finalize);
    expect(prepareArtifactFinalize(database, finalize)).toEqual({ ...prepared, replayed: true });
    const finalizingPrepareReplay = prepareArtifactChunk(database, chunk);
    expect(finalizingPrepareReplay).toMatchObject({
      receiptState: "committed",
      replayed: true,
      uploadState: "finalizing",
      committedArtifact: null,
      committedPrefix: [
        {
          chunkIndex: 0,
          offsetBytes: 0,
          chunkBytes: result.byteLength,
          chunkSha256: sha256(result),
        },
      ],
    });
    const finalizingChunkReplay = commitArtifactChunk(database, {
      ...chunk,
      prepareId: preparedChunk.prepareId,
    });
    expect(finalizingChunkReplay).toMatchObject({ state: "finalizing", outcome: "replayed" });
    const finalizingChunkResponse = toResultArtifactChunkResponse(finalizingChunkReplay);
    expect(Value.Check(ResultArtifactChunkResponseSchema, finalizingChunkResponse)).toBe(true);
    expect(finalizingChunkResponse).not.toHaveProperty("prepareId");
    const committed = commitArtifactFinalize(database, {
      ...finalize,
      finalizationId: prepared.finalizationId,
      storageObjectKey: prepared.storageObjectKey,
    });
    expect(committed).toMatchObject({
      state: "committed",
      replayed: false,
      artifact: {
        artifactId: prepared.artifactId,
        uploadId: upload.uploadId,
        sha256: sha256(result),
        totalBytes: result.byteLength,
      },
    });
    expect(Value.Check(FinalizeResultArtifactUploadResponseSchema, committed)).toBe(false);
    const publicFinalizeResponse = toFinalizeResultArtifactUploadResponse(committed);
    expect(Value.Check(FinalizeResultArtifactUploadResponseSchema, publicFinalizeResponse)).toBe(
      true,
    );
    expect(publicFinalizeResponse.artifact).not.toHaveProperty("storageObjectKey");
    expect(
      commitArtifactFinalize(database, {
        ...finalize,
        finalizationId: prepared.finalizationId,
        storageObjectKey: prepared.storageObjectKey,
      }),
    ).toEqual({ ...committed, replayed: true });
    expect(
      completeArtifactCleanup(database, {
        uploadId: upload.uploadId,
        expectedAttemptCount: 0,
      }),
    ).toMatchObject({ status: "completed" });
    const committedPrepareReplay = prepareArtifactChunk(database, chunk);
    expect(committedPrepareReplay).toMatchObject({
      receiptState: "committed",
      replayed: true,
      uploadState: "committed",
      committedPrefix: finalizingPrepareReplay.committedPrefix,
    });
    expect(committedPrepareReplay.committedArtifact).toEqual({
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const committedChunkReplay = commitArtifactChunk(database, {
      ...chunk,
      prepareId: preparedChunk.prepareId,
    });
    expect(committedChunkReplay).toMatchObject({ state: "committed", outcome: "replayed" });
    const committedChunkResponse = toResultArtifactChunkResponse(committedChunkReplay);
    expect(Value.Check(ResultArtifactChunkResponseSchema, committedChunkResponse)).toBe(true);
    expect(committedChunkResponse).not.toHaveProperty("prepareId");
    expect(() => database.prepare("UPDATE run_artifacts SET name = 'changed.json'").run()).toThrow(
      /run artifacts are immutable/u,
    );
  });

  it("rejects damaged committed artifact verification metadata during prepare replay", async () => {
    const { database } = await openFixture();
    const result = Buffer.from('{"summary":"tamper"}', "utf8");
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const chunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: result.byteLength,
      chunkSha256: sha256(result),
    };
    const preparedChunk = prepareArtifactChunk(database, chunk);
    commitArtifactChunk(database, { ...chunk, prepareId: preparedChunk.prepareId });
    const finalize = {
      ...identity,
      uploadId: upload.uploadId,
      chunkCount: 1,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };
    const preparedFinalize = prepareArtifactFinalize(database, finalize);
    commitArtifactFinalize(database, {
      ...finalize,
      finalizationId: preparedFinalize.finalizationId,
      storageObjectKey: preparedFinalize.storageObjectKey,
    });

    database.exec("DROP TRIGGER tr_run_artifacts_immutable_update");
    database
      .prepare("UPDATE run_artifacts SET total_bytes = total_bytes + 1 WHERE upload_id = ?")
      .run(upload.uploadId);

    expect(() => prepareArtifactChunk(database, chunk)).toThrow(
      /immutable run artifact does not match its finalized upload/u,
    );
    expect(() => prepareArtifactFinalize(database, finalize)).toThrow(
      /immutable run artifact does not match its finalized upload/u,
    );
  });

  it("rejects exact replays after the authoritative lease expires", async () => {
    const { database } = await openFixture();
    const result = Buffer.from("{}", "utf8");
    const input = {
      ...identity,
      clientArtifactId,
      purpose: "result" as const,
      name: "result.json",
      mediaType: "application/json" as const,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };
    createArtifactUpload(database, input);
    database
      .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", identity.runAttemptId);

    expect(() => createArtifactUpload(database, input)).toThrow(/lease is expired/u);
    expect(() => probeArtifactUploadCreate(database, input)).toThrow(/lease is expired/u);
  });

  it("fences every worker and lease identity component", async () => {
    const { database } = await openFixture();
    const result = Buffer.from("{}", "utf8");
    const input = {
      ...identity,
      clientArtifactId,
      purpose: "result" as const,
      name: "result.json",
      mediaType: "application/json" as const,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };

    for (const changed of [
      { ...input, jobId: "job-other" },
      { ...input, runAttemptId: "run-other" },
      { ...input, workerNodeId: "worker-other" },
      { ...input, workerInstanceId: "instance-other" },
      { ...input, leaseGeneration: 2 },
      { ...input, leaseToken: "different-artifact-token".padEnd(32, "x") },
    ]) {
      expect(() => createArtifactUpload(database, changed)).toThrow(/lease is expired/u);
      expect(() => probeArtifactUploadCreate(database, changed)).toThrow(/lease is expired/u);
    }

    database
      .prepare("UPDATE workers SET superseded_at = ? WHERE id = ?")
      .run("2026-09-01T00:01:00.000Z", "worker-row");
    expect(() => createArtifactUpload(database, input)).toThrow(/lease is expired/u);
    expect(() => probeArtifactUploadCreate(database, input)).toThrow(/lease is expired/u);
  });

  it("keeps termination from creating or erasing finalization evidence", async () => {
    const { database } = await openFixture();
    const result = Buffer.from("{}", "utf8");
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
    const terminatedAt = "2026-09-01T00:01:00.000Z";

    expect(() =>
      database
        .prepare(`
          UPDATE artifact_uploads
          SET
            status = 'abandoned',
            finalization_id = ?,
            final_chunk_count = 1,
            final_total_bytes = ?,
            final_sha256 = ?,
            finalizing_at = ?,
            terminated_at = ?,
            termination_reason = 'lease_expired'
          WHERE id = ?
        `)
        .run(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          result.byteLength,
          sha256(result),
          terminatedAt,
          terminatedAt,
          upload.uploadId,
        ),
    ).toThrow(/finalization identity is immutable/u);

    database
      .prepare(`
        UPDATE artifact_uploads
        SET
          status = 'abandoned',
          terminated_at = ?,
          termination_reason = 'lease_expired',
          updated_at = ?
        WHERE id = ?
      `)
      .run(terminatedAt, terminatedAt, upload.uploadId);
    expect(() =>
      database
        .prepare("UPDATE artifact_uploads SET termination_reason = 'changed' WHERE id = ?")
        .run(upload.uploadId),
    ).toThrow(/terminal artifact uploads are immutable/u);
    expect(() =>
      database.prepare("DELETE FROM artifact_uploads WHERE id = ?").run(upload.uploadId),
    ).toThrow(/artifact uploads are immutable/u);
  });

  it("terminates an active upload idempotently and rejects a changed disposition", async () => {
    const { database } = await openFixture();
    const result = Buffer.from("{}", "utf8");
    const createInput = {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    } as const;
    const upload = createArtifactUpload(database, createInput);
    const chunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: result.byteLength,
      chunkSha256: sha256(result),
    };
    const chunkReceipt = prepareArtifactChunk(database, chunk);
    commitArtifactChunk(database, { ...chunk, prepareId: chunkReceipt.prepareId });
    const termination = {
      ...identity,
      uploadId: upload.uploadId,
      state: "abandoned" as const,
      reason: "client_abandoned",
    };

    const first = terminateArtifactUpload(database, termination);
    expect(first).toMatchObject({
      uploadId: upload.uploadId,
      state: "abandoned",
      reason: "client_abandoned",
      replayed: false,
    });
    const firstWithInternalField = { ...first, internalOnly: true };
    expect(Value.Check(TerminateResultArtifactUploadResponseSchema, firstWithInternalField)).toBe(
      false,
    );
    const firstResponse = toTerminateResultArtifactUploadResponse(firstWithInternalField);
    expect(Value.Check(TerminateResultArtifactUploadResponseSchema, firstResponse)).toBe(true);
    expect(firstResponse).not.toHaveProperty("internalOnly");
    const terminationReplay = terminateArtifactUpload(database, termination);
    expect(terminationReplay).toEqual({ ...first, replayed: true });
    const replayResponse = toTerminateResultArtifactUploadResponse(terminationReplay);
    expect(Value.Check(TerminateResultArtifactUploadResponseSchema, replayResponse)).toBe(true);
    const createReplay = createArtifactUpload(database, createInput);
    expect(createReplay).toMatchObject({
      uploadId: upload.uploadId,
      state: "abandoned",
      replayed: true,
      reason: first.reason,
      terminatedAt: first.terminatedAt,
    });
    expect(Value.Check(CreateResultArtifactUploadResponseSchema, createReplay)).toBe(true);
    expect(
      Value.Check(CreateResultArtifactUploadResponseSchema, {
        uploadId: createReplay.uploadId,
        state: "abandoned",
        replayed: true,
        nextChunkIndex: createReplay.nextChunkIndex,
        nextOffsetBytes: createReplay.nextOffsetBytes,
        maximumChunkBytes: createReplay.maximumChunkBytes,
        maximumChunkCount: createReplay.maximumChunkCount,
      }),
    ).toBe(false);
    const invalidDateTimeResponse = toTerminateResultArtifactUploadResponse({
      ...first,
      terminatedAt: "not-a-date-time",
    });
    expect(Value.Check(TerminateResultArtifactUploadResponseSchema, invalidDateTimeResponse)).toBe(
      false,
    );
    expect(() =>
      toTerminateResultArtifactUploadResponse({ ...first, reason: "lease_expired" }),
    ).toThrow(/client-abandoned/u);
    expect(() => prepareArtifactChunk(database, chunk)).toThrow(/terminated upload/u);
    expect(() =>
      commitArtifactChunk(database, { ...chunk, prepareId: chunkReceipt.prepareId }),
    ).toThrow(/terminated upload/u);
    expect(() =>
      terminateArtifactUpload(database, {
        ...termination,
        state: "corrupt",
        reason: "staging_digest_mismatch",
      }),
    ).toThrow(/different terminal disposition/u);
  });

  it("terminates a prepared finalization but never a committed artifact", async () => {
    const { database } = await openFixture();
    const result = Buffer.from("{}", "utf8");
    const createInput = {
      ...identity,
      clientArtifactId,
      purpose: "result" as const,
      name: "result.json",
      mediaType: "application/json" as const,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };
    const upload = createArtifactUpload(database, createInput);
    const chunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: result.byteLength,
      chunkSha256: sha256(result),
    };
    const preparedChunk = prepareArtifactChunk(database, chunk);
    commitArtifactChunk(database, { ...chunk, prepareId: preparedChunk.prepareId });
    const finalize = {
      ...identity,
      uploadId: upload.uploadId,
      chunkCount: 1,
      totalBytes: result.byteLength,
      sha256: sha256(result),
    };
    const preparedFinalize = prepareArtifactFinalize(database, finalize);
    const corruptTermination = terminateArtifactUpload(database, {
      ...identity,
      uploadId: upload.uploadId,
      state: "corrupt",
      reason: "published_object_missing",
    });
    expect(corruptTermination).toMatchObject({ state: "corrupt", replayed: false });
    expect(
      database
        .prepare(`
          SELECT terminal_status, cleanup_scope, status
          FROM artifact_upload_cleanup_journal
          WHERE upload_id = ?
        `)
        .get(upload.uploadId),
    ).toEqual({
      terminal_status: "corrupt",
      cleanup_scope: "staging_only_v1",
      status: "pending",
    });
    expect(() => toTerminateResultArtifactUploadResponse(corruptTermination)).toThrow(
      /client-abandoned/u,
    );
    expect(() => prepareArtifactChunk(database, chunk)).toThrow(/terminated upload/u);
    expect(() =>
      commitArtifactChunk(database, { ...chunk, prepareId: preparedChunk.prepareId }),
    ).toThrow(/terminated upload/u);
    const corruptCreateReplay = createArtifactUpload(database, createInput);
    expect(corruptCreateReplay).toMatchObject({
      state: "corrupt",
      replayed: true,
      reason: corruptTermination.reason,
      terminatedAt: corruptTermination.terminatedAt,
    });
    expect(Value.Check(CreateResultArtifactUploadResponseSchema, corruptCreateReplay)).toBe(true);

    const committedUpload = createArtifactUpload(database, {
      ...createInput,
      clientArtifactId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
    });
    const committedChunk = { ...chunk, uploadId: committedUpload.uploadId };
    const committedChunkReceipt = prepareArtifactChunk(database, committedChunk);
    commitArtifactChunk(database, {
      ...committedChunk,
      prepareId: committedChunkReceipt.prepareId,
    });
    const committedFinalize = { ...finalize, uploadId: committedUpload.uploadId };
    const committedPreparation = prepareArtifactFinalize(database, committedFinalize);
    commitArtifactFinalize(database, {
      ...committedFinalize,
      finalizationId: committedPreparation.finalizationId,
      storageObjectKey: committedPreparation.storageObjectKey,
    });
    expect(() =>
      terminateArtifactUpload(database, {
        ...identity,
        uploadId: committedUpload.uploadId,
        state: "abandoned",
        reason: "client_abandoned",
      }),
    ).toThrow(/committed artifact upload cannot be terminated/u);
    expect(preparedFinalize.finalizationId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("binds artifact completion identity for exact terminal replay", async () => {
    const { database } = await openFixture();
    addArtifactModeAttempt(database);
    const rawResult = Buffer.from('{ "summary": "ok" }', "utf8");
    const rawDigest = sha256(rawResult);
    const canonicalResultJson = '{"summary":"ok"}';
    const canonicalResultDigest = sha256(canonicalResultJson);
    expect(rawDigest).not.toBe(canonicalResultDigest);

    const upload = createArtifactUpload(database, {
      ...artifactModeIdentity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: rawResult.byteLength,
      sha256: rawDigest,
    });
    const chunk = {
      ...artifactModeIdentity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: rawResult.byteLength,
      chunkSha256: rawDigest,
    };
    const preparedChunk = prepareArtifactChunk(database, chunk);
    commitArtifactChunk(database, { ...chunk, prepareId: preparedChunk.prepareId });
    const finalize = {
      ...artifactModeIdentity,
      uploadId: upload.uploadId,
      chunkCount: 1,
      totalBytes: rawResult.byteLength,
      sha256: rawDigest,
    };
    const preparedFinalize = prepareArtifactFinalize(database, finalize);
    const committed = commitArtifactFinalize(database, {
      ...finalize,
      finalizationId: preparedFinalize.finalizationId,
      storageObjectKey: preparedFinalize.storageObjectKey,
    });

    const completedAt = "2026-09-01T00:01:00.000Z";
    expect(() =>
      database
        .prepare(`
          UPDATE run_attempts
          SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ?
          WHERE id = ?
        `)
        .run(
          canonicalResultDigest,
          canonicalResultJson,
          completedAt,
          artifactModeIdentity.runAttemptId,
        ),
    ).toThrow(/lacks its immutable terminal binding/u);

    const terminalResponseJson = JSON.stringify({
      jobId: artifactModeIdentity.jobId,
      runAttemptId: artifactModeIdentity.runAttemptId,
      jobState: "succeeded",
      runState: "succeeded",
    });
    const insertBinding = database.prepare(`
      INSERT INTO artifact_completion_bindings (
        run_attempt_id,
        job_id,
        artifact_id,
        artifact_sha256,
        result_digest,
        canonicalization_version,
        terminal_response_json,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    expect(() =>
      insertBinding.run(
        artifactModeIdentity.runAttemptId,
        artifactModeIdentity.jobId,
        committed.artifact.artifactId,
        "f".repeat(64),
        canonicalResultDigest,
        terminalResponseJson,
        completedAt,
      ),
    ).toThrow(/foreign key constraint failed/iu);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertBinding.run(
        artifactModeIdentity.runAttemptId,
        artifactModeIdentity.jobId,
        committed.artifact.artifactId,
        rawDigest,
        canonicalResultDigest,
        terminalResponseJson,
        completedAt,
      );
      database
        .prepare(`
          UPDATE run_attempts
          SET status = 'succeeded', result_digest = ?, result_json = ?, ended_at = ?
          WHERE id = ?
        `)
        .run(
          canonicalResultDigest,
          canonicalResultJson,
          completedAt,
          artifactModeIdentity.runAttemptId,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    expect(
      database
        .prepare(`
          SELECT
            artifact_id,
            artifact_sha256,
            result_digest,
            canonicalization_version,
            terminal_response_json
          FROM artifact_completion_bindings
          WHERE run_attempt_id = ?
        `)
        .get(artifactModeIdentity.runAttemptId),
    ).toEqual({
      artifact_id: committed.artifact.artifactId,
      artifact_sha256: rawDigest,
      result_digest: canonicalResultDigest,
      canonicalization_version: 1,
      terminal_response_json: terminalResponseJson,
    });
    expect(() =>
      database
        .prepare(`
          UPDATE artifact_completion_bindings
          SET result_digest = ?
          WHERE run_attempt_id = ?
        `)
        .run("e".repeat(64), artifactModeIdentity.runAttemptId),
    ).toThrow(/completion bindings are immutable/u);
    expect(() =>
      database
        .prepare("UPDATE run_attempts SET result_digest = ? WHERE id = ?")
        .run("e".repeat(64), artifactModeIdentity.runAttemptId),
    ).toThrow(/completed artifact attempt identity is immutable/u);
    expect(
      database
        .prepare(`
          SELECT terminal_status, cleanup_scope, status
          FROM artifact_upload_cleanup_journal
          WHERE upload_id = ?
        `)
        .get(upload.uploadId),
    ).toEqual({
      terminal_status: "committed",
      cleanup_scope: "staging_only_v1",
      status: "pending",
    });
  });

  it("journals every terminal upload for bounded staging-only cleanup", async () => {
    const { database } = await openFixture();
    createAndTerminateUpload(database, 0, 1);
    const firstUpload = database
      .prepare("SELECT id FROM artifact_uploads WHERE client_artifact_id = ?")
      .get(artifactClientId(0)) as { readonly id: string };
    expect(
      database
        .prepare(`
          SELECT terminal_status, cleanup_scope, status, attempt_count
          FROM artifact_upload_cleanup_journal
          WHERE upload_id = ?
        `)
        .get(firstUpload.id),
    ).toEqual({
      terminal_status: "abandoned",
      cleanup_scope: "staging_only_v1",
      status: "pending",
      attempt_count: 0,
    });

    const retryAt = "2026-09-01T00:01:00.000Z";
    expect(() =>
      database
        .prepare(`
          UPDATE artifact_upload_cleanup_journal
          SET
            status = 'retry_waiting',
            attempt_count = 1,
            next_attempt_at = ?,
            last_error_code = 'staging_busy',
            last_error_message = 'The staging object is still busy.',
            updated_at = ?
          WHERE upload_id = ?
        `)
        .run(retryAt, retryAt, firstUpload.id),
    ).toThrow(/retry delay identity is inconsistent/u);
    database
      .prepare(`
        UPDATE artifact_upload_cleanup_journal
        SET
          status = 'retry_waiting',
          attempt_count = 1,
          next_attempt_at = ?,
          last_error_code = 'staging_busy',
          last_error_message = 'The staging object is still busy.',
          last_retry_delay_seconds = 30,
          updated_at = ?
        WHERE upload_id = ?
      `)
      .run(retryAt, retryAt, firstUpload.id);
    expect(() =>
      database
        .prepare(`
          UPDATE artifact_upload_cleanup_journal
          SET status = 'failed', attempt_count = 8, next_attempt_at = NULL, updated_at = ?
          WHERE upload_id = ?
        `)
        .run(retryAt, firstUpload.id),
    ).toThrow(/invalid artifact upload cleanup transition/u);
    database
      .prepare(`
        UPDATE artifact_upload_cleanup_journal
        SET status = 'completed', next_attempt_at = NULL, completed_at = ?, updated_at = ?
        WHERE upload_id = ?
      `)
      .run(retryAt, retryAt, firstUpload.id);
    expect(
      database
        .prepare(`
          SELECT status, attempt_count
          FROM artifact_upload_cleanup_journal
          WHERE upload_id = ?
        `)
        .get(firstUpload.id),
    ).toEqual({ status: "completed", attempt_count: 1 });

    createAndTerminateUpload(database, 1, 1);
    const secondUpload = database
      .prepare("SELECT id FROM artifact_uploads WHERE client_artifact_id = ?")
      .get(artifactClientId(1)) as { readonly id: string };
    for (let attemptCount = 1; attemptCount < 8; attemptCount += 1) {
      database
        .prepare(`
          UPDATE artifact_upload_cleanup_journal
          SET
            status = 'retry_waiting',
            attempt_count = ?,
            next_attempt_at = ?,
            last_error_code = 'staging_busy',
            last_error_message = 'The staging object is still busy.',
            last_retry_delay_seconds = 30,
            updated_at = ?
          WHERE upload_id = ?
        `)
        .run(attemptCount, retryAt, retryAt, secondUpload.id);
    }
    database
      .prepare(`
        UPDATE artifact_upload_cleanup_journal
        SET
          status = 'failed',
          attempt_count = 8,
          next_attempt_at = NULL,
          last_error_code = 'retry_exhausted',
          last_error_message = 'The bounded cleanup retry budget is exhausted.',
          updated_at = ?
        WHERE upload_id = ?
      `)
      .run(retryAt, secondUpload.id);
    expect(() =>
      database
        .prepare("DELETE FROM artifact_upload_cleanup_journal WHERE upload_id = ?")
        .run(secondUpload.id),
    ).toThrow(/cleanup records are immutable/u);
  });

  it.each([
    {
      name: "inactive attempt",
      reason: "attempt_inactive",
      mutate: (database: DatabaseSync) =>
        database
          .prepare("UPDATE run_attempts SET status = 'expired' WHERE id = ?")
          .run(identity.runAttemptId),
    },
    {
      name: "inactive job",
      reason: "job_inactive",
      mutate: (database: DatabaseSync) =>
        database
          .prepare("UPDATE jobs SET status = 'cancel_requested' WHERE id = ?")
          .run(identity.jobId),
    },
    {
      name: "non-current attempt",
      reason: "attempt_not_current",
      mutate: (database: DatabaseSync) =>
        database
          .prepare("UPDATE jobs SET current_run_attempt_id = NULL WHERE id = ?")
          .run(identity.jobId),
    },
    {
      name: "inactive artifact completion mode",
      reason: "completion_mode_inactive",
      mutate: (database: DatabaseSync) => {
        database.exec("DROP TRIGGER tr_run_attempt_completion_mode_immutable");
        return database
          .prepare("UPDATE run_attempts SET completion_mode = 'inline_result_v1' WHERE id = ?")
          .run(identity.runAttemptId);
      },
    },
    {
      name: "expired lease",
      reason: "lease_expired",
      mutate: (database: DatabaseSync) =>
        database
          .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
          .run("2000-01-01T00:00:00.000Z", identity.runAttemptId),
    },
    {
      name: "expired execution deadline",
      reason: "execution_deadline_expired",
      mutate: (database: DatabaseSync) =>
        database
          .prepare("UPDATE run_attempts SET execution_deadline_at = ? WHERE id = ?")
          .run("2000-01-01T00:00:00.000Z", identity.runAttemptId),
    },
    {
      name: "expired progress deadline",
      reason: "no_progress_deadline_expired",
      mutate: (database: DatabaseSync) =>
        database
          .prepare("UPDATE run_attempts SET no_progress_deadline_at = ? WHERE id = ?")
          .run("2000-01-01T00:00:00.000Z", identity.runAttemptId),
    },
    {
      name: "superseded worker",
      reason: "worker_superseded",
      mutate: (database: DatabaseSync) =>
        database
          .prepare("UPDATE workers SET superseded_at = ? WHERE id = 'worker-row'")
          .run("2026-09-01T00:01:00.000Z"),
    },
  ])("terminalizes a live upload after $name without Worker lease authority", async (testCase) => {
    const { database } = await openFixture();
    const upload = createLiveUpload(database);
    testCase.mutate(database);

    const result = terminalizeInactiveArtifactUploads(database, { batchSize: 1 });
    expect(result).toMatchObject({
      hasMore: false,
      terminalized: [
        {
          uploadId: upload.uploadId,
          state: "abandoned",
          reason: testCase.reason,
        },
      ],
    });
    expect(terminalizeInactiveArtifactUploads(database, { batchSize: 1 })).toEqual({
      terminalized: [],
      hasMore: false,
    });
    expect(
      database
        .prepare(`
          SELECT terminal_status, status, attempt_count
          FROM artifact_upload_cleanup_journal
          WHERE upload_id = ?
        `)
        .get(upload.uploadId),
    ).toEqual({ terminal_status: "abandoned", status: "pending", attempt_count: 0 });
  });

  it("leaves active authority untouched and marks damaged upload fencing corrupt", async () => {
    const activeFixture = await openFixture();
    const activeUpload = createLiveUpload(activeFixture.database);
    expect(terminalizeInactiveArtifactUploads(activeFixture.database, { batchSize: 1 })).toEqual({
      terminalized: [],
      hasMore: false,
    });
    expect(
      activeFixture.database
        .prepare("SELECT status FROM artifact_uploads WHERE id = ?")
        .get(activeUpload.uploadId),
    ).toEqual({ status: "receiving" });

    const damagedFixture = await openFixture();
    const damagedUpload = createLiveUpload(damagedFixture.database);
    damagedFixture.database.exec("DROP TRIGGER tr_artifact_upload_identity_immutable");
    damagedFixture.database
      .prepare("UPDATE artifact_uploads SET worker_instance_id = 'damaged-instance' WHERE id = ?")
      .run(damagedUpload.uploadId);
    expect(
      terminalizeInactiveArtifactUploads(damagedFixture.database, { batchSize: 1 }),
    ).toMatchObject({
      terminalized: [
        {
          uploadId: damagedUpload.uploadId,
          state: "corrupt",
          reason: "metadata_fence_mismatch",
        },
      ],
    });
  });

  it("bounds authority recovery and reports a continuation without skipping rows", async () => {
    const { database } = await openFixture();
    addArtifactModeAttempt(database);
    const first = createLiveUpload(database, 0);
    const second = createArtifactUpload(database, {
      ...artifactModeIdentity,
      clientArtifactId: artifactClientId(1),
      purpose: "result",
      name: "reconciliation-1.json",
      mediaType: "application/json",
      totalBytes: 2,
      sha256: sha256("reconciliation-1"),
    });
    database.prepare("UPDATE run_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z'").run();

    const firstBatch = terminalizeInactiveArtifactUploads(database, { batchSize: 1 });
    expect(firstBatch).toMatchObject({
      hasMore: true,
      terminalized: [{ reason: "lease_expired" }],
    });
    const secondBatch = terminalizeInactiveArtifactUploads(database, { batchSize: 1 });
    expect(secondBatch).toMatchObject({
      hasMore: false,
      terminalized: [{ reason: "lease_expired" }],
    });
    expect(
      new Set(
        [...firstBatch.terminalized, ...secondBatch.terminalized].map((item) => item.uploadId),
      ),
    ).toEqual(new Set([first.uploadId, second.uploadId]));
  });

  it("rejects accessor and oversized reconciliation batch inputs before reading values", async () => {
    const { database } = await openFixture();
    let getterCalls = 0;
    const accessorInput = Object.create(null) as { batchSize: number };
    Object.defineProperty(accessorInput, "batchSize", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });

    expect(() => terminalizeInactiveArtifactUploads(database, accessorInput)).toThrow(
      ArtifactReconciliationInvalidRequestError,
    );
    expect(getterCalls).toBe(0);
    expect(() =>
      listDueArtifactCleanups(database, {
        batchSize: maximumArtifactReconciliationBatchSize + 1,
      }),
    ).toThrow(ArtifactReconciliationInvalidRequestError);
  });

  it("lists due cleanup fairly and commits success with an exact CAS", async () => {
    const { database } = await openFixture();
    createAndTerminateUpload(database, 0, 1);
    createAndTerminateUpload(database, 1, 1);
    const uploads = database
      .prepare(`
        SELECT id, client_artifact_id
        FROM artifact_uploads
        ORDER BY client_artifact_id
      `)
      .all() as unknown as readonly {
      readonly id: string;
      readonly client_artifact_id: string;
    }[];
    const first = uploads[0];
    const second = uploads[1];
    if (first === undefined || second === undefined) {
      throw new Error("Expected two artifact cleanup fixtures.");
    }
    database
      .prepare(`
        UPDATE artifact_upload_cleanup_journal
        SET
          status = 'retry_waiting',
          attempt_count = 1,
          next_attempt_at = '2000-01-01T00:00:00.000Z',
          last_error_code = 'storage_busy',
          last_error_message = 'Artifact staging cleanup is temporarily busy.',
          last_retry_delay_seconds = 30,
          updated_at = '2000-01-01T00:00:00.000Z'
        WHERE upload_id = ?
      `)
      .run(second.id);

    const due = listDueArtifactCleanups(database, { batchSize: 2 });
    expect(due.items.map((item) => item.uploadId)).toEqual([second.id, first.id]);
    expect(due.items[0]).toMatchObject({
      expectedAttemptCount: 1,
      lastRetryDelaySeconds: 30,
      publications: [],
    });
    const completed = completeArtifactCleanup(database, {
      uploadId: second.id,
      expectedAttemptCount: 1,
    });
    expect(completed).toMatchObject({ status: "completed", attemptCount: 1, replayed: false });
    expect(
      completeArtifactCleanup(database, {
        uploadId: second.id,
        expectedAttemptCount: 1,
      }),
    ).toEqual({ ...completed, replayed: true });
    expect(() =>
      completeArtifactCleanup(database, {
        uploadId: first.id,
        expectedAttemptCount: 1,
      }),
    ).toThrow(ArtifactReconciliationConflictError);
  });

  it("preserves finalization evidence in Server-authoritative cleanup work", async () => {
    const { database } = await openFixture();
    const bytes = Buffer.from("{}", "utf8");
    const digest = sha256(bytes);
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: bytes.byteLength,
      sha256: digest,
    });
    const chunk = {
      ...identity,
      uploadId: upload.uploadId,
      chunkIndex: 0,
      offsetBytes: 0,
      chunkBytes: bytes.byteLength,
      chunkSha256: digest,
    };
    const preparedChunk = prepareArtifactChunk(database, chunk);
    commitArtifactChunk(database, { ...chunk, prepareId: preparedChunk.prepareId });
    const preparedFinalize = prepareArtifactFinalize(database, {
      ...identity,
      uploadId: upload.uploadId,
      chunkCount: 1,
      totalBytes: bytes.byteLength,
      sha256: digest,
    });
    database
      .prepare("UPDATE run_attempts SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", identity.runAttemptId);

    terminalizeInactiveArtifactUploads(database, { batchSize: 1 });
    expect(listDueArtifactCleanups(database, { batchSize: 1 }).items).toEqual([
      {
        uploadId: upload.uploadId,
        terminalStatus: "abandoned",
        cleanupScope: "staging_only_v1",
        expectedAttemptCount: 0,
        lastRetryDelaySeconds: null,
        publications: [
          {
            finalizationId: preparedFinalize.finalizationId,
            totalBytes: bytes.byteLength,
            sha256: digest,
          },
        ],
      },
    ]);
  });

  it("records bounded cleanup failures and makes the eighth failure terminal", async () => {
    const { database } = await openFixture();
    createAndTerminateUpload(database, 0, 2);
    const upload = database
      .prepare("SELECT id FROM artifact_uploads WHERE client_artifact_id = ?")
      .get(artifactClientId(0)) as { readonly id: string };

    for (let expectedAttemptCount = 0; expectedAttemptCount < 8; expectedAttemptCount += 1) {
      const failure = recordArtifactCleanupFailure(database, {
        uploadId: upload.id,
        expectedAttemptCount,
        errorCode: "storage_io_failure",
        retryDelaySeconds: 30,
      });
      expect(failure).toMatchObject({
        attemptCount: expectedAttemptCount + 1,
        status: expectedAttemptCount === 7 ? "failed" : "retry_waiting",
        errorCode: "storage_io_failure",
        retryDelaySeconds: 30,
        replayed: false,
      });
      expect(
        recordArtifactCleanupFailure(database, {
          uploadId: upload.id,
          expectedAttemptCount,
          errorCode: "storage_io_failure",
          retryDelaySeconds: 30,
        }),
      ).toEqual({ ...failure, replayed: true });
      if (expectedAttemptCount === 0) {
        expect(() =>
          recordArtifactCleanupFailure(database, {
            uploadId: upload.id,
            expectedAttemptCount,
            errorCode: "storage_timeout",
            retryDelaySeconds: 30,
          }),
        ).toThrow(ArtifactReconciliationConflictError);
      }
      if (expectedAttemptCount === 0 || expectedAttemptCount === 7) {
        expect(() =>
          recordArtifactCleanupFailure(database, {
            uploadId: upload.id,
            expectedAttemptCount,
            errorCode: "storage_io_failure",
            retryDelaySeconds: 31,
          }),
        ).toThrow(ArtifactReconciliationConflictError);
      }
    }

    expect(listDueArtifactCleanups(database, { batchSize: 8 }).items).toEqual([]);
    const health = readArtifactHealthAccounting(database, {});
    expect(health).toMatchObject({
      activeUploads: { receiving: 0, finalizing: 0 },
      cleanup: {
        pending: 0,
        retryWaiting: 0,
        completed: 0,
        failed: 1,
        invalidRetryIdentity: 0,
      },
      capacity: { accountingCertain: false, liveUploadCount: 1, cleanupBacklogEntries: 1 },
    });
  });
});

describe("artifact namespace cleanup foundation", () => {
  it("keeps capacity accounting uncertain until the first namespace sweep completes", async () => {
    const { database } = await openFixture();
    const input = {
      ...identity,
      clientArtifactId: artifactClientId(7),
      purpose: "result" as const,
      name: "namespace-gate.json",
      mediaType: "application/json" as const,
      totalBytes: 1,
      sha256: sha256("namespace-gate"),
    };
    expect(probeArtifactUploadCreate(database, input)).toMatchObject({
      disposition: "new",
      accounting: { accountingCertain: false },
    });
    classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 0,
      expectedAfterKey: null,
      observations: [],
      completedSweep: true,
    });
    expect(probeArtifactUploadCreate(database, input)).toMatchObject({
      disposition: "new",
      accounting: { accountingCertain: true },
    });
  });

  it("classifies an orphan page and advances the cursor in the same transaction", async () => {
    const { database } = await openFixture();
    const observation = namespaceStagingObservation("70000000-0000-4000-8000-000000000001", 0);

    const result = classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 0,
      expectedAfterKey: null,
      observations: [observation],
      completedSweep: false,
    });

    expect(result).toMatchObject({
      classifications: [
        {
          entryKey: observation.entryKey,
          disposition: "cleanup_intent_created",
          reason: "orphan",
          supersededPriorIntent: false,
        },
      ],
      cursor: { sweepGeneration: 0, afterKey: observation.entryKey },
    });
    expect(listDueArtifactNamespaceCleanups(database, { batchSize: 8 }).items).toEqual([
      expect.objectContaining({
        entryKey: observation.entryKey,
        observationSha256: observation.observationSha256,
        fileInode: "2",
        parentInode: "4",
        reason: "orphan",
        expectedAttemptCount: 0,
      }),
    ]);

    expect(() =>
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: null,
        observations: [observation],
        completedSweep: true,
      }),
    ).toThrow(ArtifactReconciliationConflictError);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM artifact_namespace_cleanup_journal").get(),
    ).toEqual({ count: 1 });
    expect(() =>
      database
        .prepare(`
          UPDATE artifact_namespace_cleanup_journal
          SET status = 'completed',
              attempt_count = 0,
              next_attempt_at = NULL,
              completed_at = '9999-12-31T23:59:59.999Z',
              updated_at = '9999-12-31T23:59:59.999Z',
              file_inode = '999',
              reason = 'completed_residual'
          WHERE entry_key = ? AND observation_sha256 = ?
        `)
        .run(observation.entryKey, observation.observationSha256),
    ).toThrow(/identity is immutable/u);
    expect(
      database
        .prepare(`
          SELECT status, attempt_count, file_inode, reason
          FROM artifact_namespace_cleanup_journal
          WHERE entry_key = ? AND observation_sha256 = ?
        `)
        .get(observation.entryKey, observation.observationSha256),
    ).toEqual({
      status: "pending",
      attempt_count: 0,
      file_inode: "2",
      reason: "orphan",
    });
    expect(() =>
      database
        .prepare(`
          DELETE FROM artifact_namespace_cleanup_journal
          WHERE entry_key = ? AND observation_sha256 = ?
        `)
        .run(observation.entryKey, observation.observationSha256),
    ).toThrow(/records are immutable/u);
  });

  it("distinguishes active, upload-covered, and completed-residual observations", async () => {
    const { database } = await openFixture();
    const upload = createLiveUpload(database);
    const active = namespaceStagingObservation(upload.uploadId, 0, 1);
    expect(
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: null,
        observations: [active],
        completedSweep: true,
      }).classifications,
    ).toEqual([expect.objectContaining({ disposition: "active_reference", reason: null })]);

    terminateArtifactUpload(database, {
      ...identity,
      uploadId: upload.uploadId,
      state: "abandoned",
      reason: "client_abandoned",
    });
    const covered = namespaceStagingObservation(upload.uploadId, 1, 1);
    expect(
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 1,
        expectedAfterKey: null,
        observations: [covered],
        completedSweep: true,
      }).classifications,
    ).toEqual([expect.objectContaining({ disposition: "upload_cleanup_covered", reason: null })]);
    completeArtifactCleanup(database, { uploadId: upload.uploadId, expectedAttemptCount: 0 });

    const residual = namespaceStagingObservation(upload.uploadId, 2, 1);
    expect(
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 2,
        expectedAfterKey: null,
        observations: [residual],
        completedSweep: true,
      }).classifications,
    ).toEqual([
      expect.objectContaining({
        disposition: "cleanup_intent_created",
        reason: "completed_residual",
      }),
    ]);
  });

  it("rolls back the page instead of minting cleanup authority for an active mismatch", async () => {
    const { database } = await openFixture();
    const upload = createLiveUpload(database);
    const mismatched = namespaceStagingObservation(upload.uploadId, 0, 3);

    expect(() =>
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: null,
        observations: [mismatched],
        completedSweep: true,
      }),
    ).toThrow(ArtifactReconciliationStateError);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM artifact_namespace_cleanup_journal").get(),
    ).toEqual({ count: 0 });
    expect(readArtifactReconciliationCursor(database, {})).toMatchObject({
      sweepGeneration: 0,
      afterKey: null,
      lastCompletedAt: null,
    });
  });

  it("rolls back earlier page classifications when a later observation is contradictory", async () => {
    const { database } = await openFixture();
    const activeUpload = createLiveUpload(database);
    const orphanTemporary = namespaceTemporaryObservation(
      "70000000-0000-4000-8000-000000000010",
      "70000000-0000-4000-8000-000000000011",
      sha256("orphan-temporary"),
      0,
    );
    const activeMismatch = namespaceStagingObservation(activeUpload.uploadId, 0, 3);

    expect(() =>
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: null,
        observations: [orphanTemporary, activeMismatch],
        completedSweep: true,
      }),
    ).toThrow(ArtifactReconciliationStateError);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM artifact_namespace_cleanup_journal").get(),
    ).toEqual({ count: 0 });
    expect(readArtifactReconciliationCursor(database, {})).toMatchObject({
      sweepGeneration: 0,
      afterKey: null,
    });
  });

  it("supersedes changed inode identity without binding parent directory ctime", async () => {
    const { database } = await openFixture();
    const uploadId = "70000000-0000-4000-8000-000000000002";
    const first = namespaceStagingObservation(uploadId, 0, 1, "20");
    classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 0,
      expectedAfterKey: null,
      observations: [first],
      completedSweep: true,
    });
    const replacement = namespaceStagingObservation(uploadId, 1, 1, "21");
    const second = classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 1,
      expectedAfterKey: null,
      observations: [replacement],
      completedSweep: true,
    });

    expect(second.classifications).toEqual([
      expect.objectContaining({
        disposition: "cleanup_intent_created",
        supersededPriorIntent: true,
      }),
    ]);
    expect(
      database
        .prepare(`
          SELECT observation_sha256, status
          FROM artifact_namespace_cleanup_journal
          WHERE entry_key = ?
          ORDER BY observed_sweep_generation
        `)
        .all(first.entryKey),
    ).toEqual([
      { observation_sha256: first.observationSha256, status: "superseded" },
      { observation_sha256: replacement.observationSha256, status: "pending" },
    ]);
    const { observationSha256: _observationSha256, ...replacementIdentity } = replacement;
    expect(
      calculateArtifactNamespaceObservationSha256({
        ...replacementIdentity,
        parentMode: "493",
      }),
    ).not.toBe(replacement.observationSha256);
  });

  it("replays stable physical identity across sweeps without resetting retry state", async () => {
    const { database } = await openFixture();
    const observation = namespaceStagingObservation("70000000-0000-4000-8000-000000000012", 0);
    classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 0,
      expectedAfterKey: null,
      observations: [observation],
      completedSweep: true,
    });
    recordArtifactNamespaceCleanupFailure(database, {
      entryKey: observation.entryKey,
      observationSha256: observation.observationSha256,
      expectedAttemptCount: 0,
      errorCode: "storage_busy",
      retryDelaySeconds: 30,
    });

    const replay = classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 1,
      expectedAfterKey: null,
      observations: [observation],
      completedSweep: true,
    });
    expect(replay.classifications).toEqual([
      expect.objectContaining({
        disposition: "cleanup_intent_replayed",
        supersededPriorIntent: false,
      }),
    ]);
    expect(
      database
        .prepare(`
          SELECT status, attempt_count, last_retry_delay_seconds, observed_sweep_generation
          FROM artifact_namespace_cleanup_journal
          WHERE entry_key = ? AND observation_sha256 = ?
        `)
        .get(observation.entryKey, observation.observationSha256),
    ).toEqual({
      status: "retry_waiting",
      attempt_count: 1,
      last_retry_delay_seconds: 30,
      observed_sweep_generation: 0,
    });
  });

  it("fail-stops instead of superseding an intent that contradicts an active reference", async () => {
    const { database } = await openFixture();
    const uploadId = "70000000-0000-4000-8000-000000000013";
    const observation = namespaceStagingObservation(uploadId, 0, 1);
    classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 0,
      expectedAfterKey: null,
      observations: [observation],
      completedSweep: true,
    });
    database.exec("DROP TRIGGER tr_artifact_upload_namespace_staging_collision");
    insertNamespaceCollisionUpload(database, uploadId, 7, 1, sha256("active-contradiction"));

    expect(() =>
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 1,
        expectedAfterKey: null,
        observations: [observation],
        completedSweep: true,
      }),
    ).toThrow(ArtifactReconciliationStateError);
    expect(
      database
        .prepare(`
          SELECT status, attempt_count
          FROM artifact_namespace_cleanup_journal
          WHERE entry_key = ? AND observation_sha256 = ?
        `)
        .get(observation.entryKey, observation.observationSha256),
    ).toEqual({ status: "pending", attempt_count: 0 });
    expect(readArtifactReconciliationCursor(database, {})).toMatchObject({
      sweepGeneration: 1,
      afterKey: null,
    });
  });

  it("completes exact cleanup replays and makes the eighth failure terminal", async () => {
    const { database } = await openFixture();
    const completedObservation = namespaceStagingObservation(
      "70000000-0000-4000-8000-000000000003",
      0,
    );
    classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 0,
      expectedAfterKey: null,
      observations: [completedObservation],
      completedSweep: true,
    });
    const completed = completeArtifactNamespaceCleanup(database, {
      entryKey: completedObservation.entryKey,
      observationSha256: completedObservation.observationSha256,
      expectedAttemptCount: 0,
    });
    expect(completed).toMatchObject({ status: "completed", replayed: false });
    expect(
      completeArtifactNamespaceCleanup(database, {
        entryKey: completedObservation.entryKey,
        observationSha256: completedObservation.observationSha256,
        expectedAttemptCount: 0,
      }),
    ).toEqual({ ...completed, replayed: true });

    const failedObservation = namespaceStagingObservation(
      "70000000-0000-4000-8000-000000000004",
      1,
    );
    classifyArtifactNamespacePageAndAdvanceCursor(database, {
      expectedSweepGeneration: 1,
      expectedAfterKey: null,
      observations: [failedObservation],
      completedSweep: true,
    });
    for (let expectedAttemptCount = 0; expectedAttemptCount < 8; expectedAttemptCount += 1) {
      const input = {
        entryKey: failedObservation.entryKey,
        observationSha256: failedObservation.observationSha256,
        expectedAttemptCount,
        errorCode: "storage_io_failure" as const,
        retryDelaySeconds: 30,
      };
      const failure = recordArtifactNamespaceCleanupFailure(database, input);
      expect(failure).toMatchObject({
        status: expectedAttemptCount === 7 ? "failed" : "retry_waiting",
        attemptCount: expectedAttemptCount + 1,
        replayed: false,
      });
      expect(recordArtifactNamespaceCleanupFailure(database, input)).toEqual({
        ...failure,
        replayed: true,
      });
    }
    expect(listDueArtifactNamespaceCleanups(database, { batchSize: 8 }).items).toEqual([]);
    expect(readArtifactHealthAccounting(database, {})).toMatchObject({
      namespaceCleanup: {
        pending: 0,
        retryWaiting: 0,
        completed: 1,
        failed: 1,
        superseded: 0,
        operationalSaturated: false,
        historicalSaturated: false,
      },
      capacity: {
        accountingCertain: false,
        liveUploadCount: 0,
        liveUploadExpectedByteSizeBuckets: [],
        cleanupBacklogEntries: 1,
      },
    });
  });

  it("blocks staging and publication-temporary identities with unresolved intents", async () => {
    const stagingFixture = await openFixture();
    const stagingUploadId = "70000000-0000-4000-8000-000000000005";
    const staging = namespaceStagingObservation(stagingUploadId, 0);
    classifyArtifactNamespacePageAndAdvanceCursor(stagingFixture.database, {
      expectedSweepGeneration: 0,
      expectedAfterKey: null,
      observations: [staging],
      completedSweep: true,
    });
    expect(() =>
      insertNamespaceCollisionUpload(
        stagingFixture.database,
        stagingUploadId,
        5,
        1,
        sha256("staging-collision"),
      ),
    ).toThrow(/staging identity has unresolved namespace cleanup/u);

    const temporaryFixture = await openFixture();
    const temporaryUploadId = "70000000-0000-4000-8000-000000000006";
    const finalizationId = "70000000-0000-4000-8000-000000000007";
    const digest = sha256("x");
    const temporary = namespaceTemporaryObservation(temporaryUploadId, finalizationId, digest, 0);
    classifyArtifactNamespacePageAndAdvanceCursor(temporaryFixture.database, {
      expectedSweepGeneration: 0,
      expectedAfterKey: null,
      observations: [temporary],
      completedSweep: true,
    });
    insertNamespaceCollisionUpload(temporaryFixture.database, temporaryUploadId, 6, 1, digest);
    const now = "2026-09-01T00:00:00.000Z";
    temporaryFixture.database
      .prepare(`
        INSERT INTO artifact_upload_chunks (
          upload_id, chunk_index, prepare_id, offset_bytes, chunk_bytes,
          chunk_sha256, status, prepared_at
        ) VALUES (?, 0, ?, 0, 1, ?, 'prepared', ?)
      `)
      .run(temporaryUploadId, "70000000-0000-4000-8000-000000000008", digest, now);
    temporaryFixture.database
      .prepare(`
        UPDATE artifact_upload_chunks
        SET status = 'committed', committed_at = ?
        WHERE upload_id = ? AND chunk_index = 0
      `)
      .run(now, temporaryUploadId);
    temporaryFixture.database
      .prepare(`
        UPDATE artifact_uploads
        SET next_chunk_index = 1, received_bytes = 1, updated_at = ?
        WHERE id = ?
      `)
      .run(now, temporaryUploadId);
    expect(() =>
      temporaryFixture.database
        .prepare(`
          UPDATE artifact_uploads
          SET status = 'finalizing', finalization_id = ?, final_chunk_count = 1,
              final_total_bytes = 1, final_sha256 = ?, finalizing_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(finalizationId, digest, now, now, temporaryUploadId),
    ).toThrow(/finalization identity has unresolved namespace cleanup/u);
  });

  it("bounds operational and historical namespace health independently", async () => {
    const { database } = await openFixture();
    const observations = Array.from(
      { length: maximumArtifactNamespaceHealthRows + 1 },
      (_, ordinal) =>
        namespaceStagingObservation(
          `71000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`,
          0,
        ),
    );
    let afterKey: string | null = null;
    for (let offset = 0; offset < observations.length; offset += maximumArtifactNamespacePageSize) {
      const page = observations.slice(offset, offset + maximumArtifactNamespacePageSize);
      const completedSweep = offset + page.length === observations.length;
      const result = classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: afterKey,
        observations: page,
        completedSweep,
      });
      afterKey = result.cursor.afterKey;
    }

    expect(readArtifactHealthAccounting(database, {})).toMatchObject({
      namespaceCleanup: {
        pending: maximumArtifactNamespaceHealthRows,
        due: maximumArtifactNamespaceHealthRows,
        completed: 0,
        operationalSaturated: true,
        historicalSaturated: false,
      },
      capacity: {
        accountingCertain: false,
        cleanupBacklogEntries: maximumArtifactNamespaceHealthRows,
      },
    });

    const completedAt = "9999-12-31T23:59:59.999Z";
    const completion = database
      .prepare(`
        UPDATE artifact_namespace_cleanup_journal
        SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE status = 'pending'
      `)
      .run(completedAt, completedAt);
    expect(Number(completion.changes)).toBe(maximumArtifactNamespaceHealthRows + 1);
    expect(readArtifactHealthAccounting(database, {})).toMatchObject({
      namespaceCleanup: {
        pending: 0,
        due: 0,
        completed: maximumArtifactNamespaceHealthRows,
        operationalSaturated: false,
        historicalSaturated: true,
      },
      capacity: {
        accountingCertain: true,
        cleanupBacklogEntries: 0,
      },
    });
  });

  it("rejects accessor observations and immutable-object pages before cursor mutation", async () => {
    const { database } = await openFixture();
    let getterCalls = 0;
    const observations: unknown[] = [];
    Object.defineProperty(observations, 0, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return namespaceStagingObservation("70000000-0000-4000-8000-000000000009", 0);
      },
    });
    expect(() =>
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: null,
        observations: observations as never,
        completedSweep: true,
      }),
    ).toThrow(ArtifactReconciliationInvalidRequestError);
    expect(getterCalls).toBe(0);
    expect(() =>
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: null,
        observations: [
          namespaceStagingObservation("70000000-0000-4000-8000-000000000020", 0),
          namespaceStagingObservation("70000000-0000-4000-8000-000000000019", 0),
        ],
        completedSweep: true,
      }),
    ).toThrow(ArtifactReconciliationInvalidRequestError);
    expect(() =>
      classifyArtifactNamespacePageAndAdvanceCursor(database, {
        expectedSweepGeneration: 0,
        expectedAfterKey: null,
        observations: [
          {
            ...namespaceStagingObservation("70000000-0000-4000-8000-000000000009", 0),
            entryKey: `objects/sha256/${"a".repeat(64).slice(0, 2)}/${"a".repeat(64)}`,
            kind: "immutable-object" as never,
          },
        ],
        completedSweep: true,
      }),
    ).toThrow(ArtifactReconciliationInvalidRequestError);
    expect(readArtifactReconciliationCursor(database, {})).toMatchObject({
      sweepGeneration: 0,
      afterKey: null,
    });
  });
});
