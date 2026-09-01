import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  CreateResultArtifactUploadResponseSchema,
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
  commitArtifactChunk,
  commitArtifactFinalize,
  createArtifactUpload,
  maximumDeclaredResultArtifactBytesPerAttempt,
  maximumResultArtifactUploadIdentitiesPerAttempt,
  prepareArtifactChunk,
  prepareArtifactFinalize,
  terminateArtifactUpload,
  toResultArtifactChunkResponse,
  toTerminateResultArtifactUploadResponse,
} from "../../dist/database/artifacts.js";
import { ArtifactUploadQuotaExceededError } from "../../dist/database/errors.js";
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
  readonly database: DatabaseSync;
  readonly directory: string;
}

const fixtures: Fixture[] = [];

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const openFixture = async (): Promise<Fixture> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-artifact-db-"));
  const database = new DatabaseSync(join(directory, "state.db"));
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
        started_at
      ) VALUES (?, ?, 1, ?, ?, ?, 'running', ?, 1, ?, ?, 600000, ?, ?, 'uploading', ?)
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
      now,
    );
  const fixture = { database, directory };
  fixtures.push(fixture);
  return fixture;
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

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("result artifact database state machine", () => {
  it("defaults completion to inline v1 and keeps the selected mode immutable", async () => {
    const { database } = await openFixture();
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
    const database = new DatabaseSync(join(directory, "state.db"));
    fixtures.push({ database, directory });
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
    createAndTerminateUpload(database, 0, 1);
    const terminalUpload = database
      .prepare("SELECT id FROM artifact_uploads WHERE client_artifact_id = ?")
      .get(artifactClientId(0)) as { readonly id: string };

    expect(runMigrations(database, migrationsDirectory)).toBe(9);
    expect(
      database
        .prepare("SELECT completion_mode FROM run_attempts WHERE id = ?")
        .get(identity.runAttemptId),
    ).toEqual({ completion_mode: "inline_result_v1" });
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
  });

  it(
    "blocks INSERT OR REPLACE on the live-result partial unique without changing quota accounting",
    async () => {
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
    },
  );

  it(
    "blocks UPDATE OR REPLACE from deleting another attempt's upload or quota charge",
    async () => {
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
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM artifact_upload_chunks").get(),
      ).toEqual({ count: 0 });

      expect(() =>
        database
          .prepare("UPDATE OR REPLACE artifact_uploads SET id = ? WHERE id = ?")
          .run(victim.uploadId, donor.uploadId),
      ).toThrow(/artifact upload primary keys are immutable/u);

      expect(readRows()).toEqual(originalRows);
      expect(readUsage()).toEqual(originalUsage);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM artifact_upload_chunks").get(),
      ).toEqual({ count: 0 });
    },
  );

  it(
    "charges terminal upload identities permanently and enforces the SQL identity ceiling",
    async () => {
      const { database } = await openFixture();
      expect(maximumResultArtifactUploadIdentitiesPerAttempt).toBe(8);
      for (
        let ordinal = 0;
        ordinal < maximumResultArtifactUploadIdentitiesPerAttempt;
        ordinal += 1
      ) {
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
    },
  );

  it("enforces the cumulative declared-byte ceiling in code and SQL", async () => {
    const { database } = await openFixture();
    expect(
      maximumResultArtifactBytes * maximumResultArtifactUploadIdentitiesPerAttempt,
    ).toBe(maximumDeclaredResultArtifactBytesPerAttempt);
    for (
      let ordinal = 0;
      ordinal < maximumResultArtifactUploadIdentitiesPerAttempt;
      ordinal += 1
    ) {
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
    expect(
      commitArtifactFinalize(database, {
        ...finalize,
        finalizationId: prepared.finalizationId,
        storageObjectKey: prepared.storageObjectKey,
      }),
    ).toEqual({ ...committed, replayed: true });
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
    }

    database
      .prepare("UPDATE workers SET superseded_at = ? WHERE id = ?")
      .run("2026-09-01T00:01:00.000Z", "worker-row");
    expect(() => createArtifactUpload(database, input)).toThrow(/lease is expired/u);
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
    expect(
      Value.Check(TerminateResultArtifactUploadResponseSchema, invalidDateTimeResponse),
    ).toBe(false);
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
});
