import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isCanonicalResultArtifactChunkData } from "@agentic-review/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitArtifactChunk,
  commitArtifactFinalize,
  createArtifactUpload,
  prepareArtifactChunk,
  prepareArtifactFinalize,
  terminateArtifactUpload,
} from "../../dist/database/artifacts.js";
import { runMigrations } from "../../dist/database/migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const leaseToken = "artifact-test-lease-token".padEnd(32, "x");
const clientArtifactId = "12345678-1234-4123-8123-123456789abc";

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

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

describe("result artifact database state machine", () => {
  it("distinguishes canonical base64url chunks from non-zero trailing pad bits", () => {
    expect(isCanonicalResultArtifactChunkData("Zg")).toBe(true);
    expect(isCanonicalResultArtifactChunkData("Zm8")).toBe(true);
    expect(isCanonicalResultArtifactChunkData("Zh")).toBe(false);
    expect(isCanonicalResultArtifactChunkData("Zm9")).toBe(false);
    expect(isCanonicalResultArtifactChunkData("Zg==")).toBe(false);
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
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM artifact_uploads").get() as { count: number },
    ).toEqual({ count: 1 });
    expect(() => createArtifactUpload(database, { ...input, name: "changed.json" })).toThrow(
      /different immutable state/u,
    );
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
      outcome: "accepted",
      nextChunkIndex: 1,
      nextOffsetBytes: firstBytes.byteLength,
    });
    expect(committedReplay).toEqual({ ...committed, outcome: "replayed" });
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
    const upload = createArtifactUpload(database, {
      ...identity,
      clientArtifactId,
      purpose: "result",
      name: "result.json",
      mediaType: "application/json",
      totalBytes: result.byteLength,
      sha256: sha256(result),
    });
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
    expect(terminateArtifactUpload(database, termination)).toEqual({ ...first, replayed: true });
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
    expect(
      terminateArtifactUpload(database, {
        ...identity,
        uploadId: upload.uploadId,
        state: "corrupt",
        reason: "published_object_missing",
      }),
    ).toMatchObject({ state: "corrupt", replayed: false });

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
});
