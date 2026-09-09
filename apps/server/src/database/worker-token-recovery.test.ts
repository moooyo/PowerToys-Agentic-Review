import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../dist/database/database-client.js";
import { runMigrations } from "../../dist/database/migrations.js";
import {
  databaseInitializationMarkerContent,
  databaseInitializationMarkerPath,
} from "../../dist/database/storage-security.js";

const migrationsDirectory = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const operatorIssuer = "https://issuer.example.test";
const workerCapabilities = {
  operatingSystem: "windows",
  architecture: "x64",
  headless: true,
  interactiveDesktop: false,
  cliEngine: "codex",
  cliVersion: "recovery-test",
  recipeIds: ["pull-request-review"],
  labels: { pool: "recovery-test" },
} as const;

interface RecoveryFixture {
  client: DatabaseClient | null;
  readonly databasePath: string;
  readonly directory: string;
}

const fixtures: RecoveryFixture[] = [];
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const createFixture = async (): Promise<RecoveryFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-token-recovery-"));
  const dataDirectory = join(directory, "data");
  await mkdir(dataDirectory, { mode: 0o700 });
  const databasePath = join(dataDirectory, "server.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    runMigrations(database, migrationsDirectory);
  } finally {
    database.close();
  }
  if (process.platform !== "win32") {
    await chmod(databasePath, 0o600);
  }
  await writeFile(
    databaseInitializationMarkerPath(databasePath),
    databaseInitializationMarkerContent,
    { mode: 0o600 },
  );
  const fixture: RecoveryFixture = {
    client: await DatabaseClient.create({ databasePath, migrationsDirectory }),
    databasePath,
    directory,
  };
  fixtures.push(fixture);
  return fixture;
};

const currentClient = (fixture: RecoveryFixture): DatabaseClient => {
  if (fixture.client === null) {
    throw new Error("The recovery fixture database is closed.");
  }
  return fixture.client;
};

const closeFixtureClient = async (fixture: RecoveryFixture): Promise<void> => {
  const client = fixture.client;
  fixture.client = null;
  await client?.close();
};

const reopenFixtureClient = async (fixture: RecoveryFixture): Promise<void> => {
  if (fixture.client !== null) {
    throw new Error("The recovery fixture database is already open.");
  }
  fixture.client = await DatabaseClient.create({
    databasePath: fixture.databasePath,
    migrationsDirectory,
  });
};

const removeDatabaseSidecars = async (databasePath: string): Promise<void> => {
  for (const suffix of ["-journal", "-wal", "-shm"] as const) {
    await rm(`${databasePath}${suffix}`, { force: true });
  }
};

const createCredential = (
  client: DatabaseClient,
  workerNodeId: string,
  workerTokenSha256: string,
) =>
  client.request("createWorkerNodeCredential", {
    workerNodeId,
    displayName: workerNodeId,
    workerTokenSha256,
    createdByIssuer: operatorIssuer,
    createdBySubject: "recovery-creator",
  });

const credentialRecord = async (client: DatabaseClient, workerNodeId: string) => {
  const result = await client.request("listWorkerNodeCredentials", {
    offset: 0,
    limit: 200,
    sort: "identity",
  });
  const record = result.items.find((item) => item.workerNodeId === workerNodeId);
  if (record === undefined) {
    throw new Error(`Worker credential ${workerNodeId} is absent from the recovery roster.`);
  }
  return record;
};

const rotateCredential = (
  client: DatabaseClient,
  workerNodeId: string,
  workerTokenSha256: string,
  expectedUpdatedAt: string,
  rotatedBySubject: string,
) =>
  client.request("rotateWorkerToken", {
    workerNodeId,
    workerTokenSha256,
    expectedUpdatedAt,
    rotatedByIssuer: operatorIssuer,
    rotatedBySubject,
  });

const revokeCredential = (client: DatabaseClient, workerNodeId: string, revokedBySubject: string) =>
  client.request("revokeWorkerToken", {
    workerNodeId,
    revokedByIssuer: operatorIssuer,
    revokedBySubject,
  });

const authenticate = (client: DatabaseClient, workerTokenSha256: string) =>
  client.request("authenticateWorkerToken", { workerTokenSha256 });

const registerWorker = (
  client: DatabaseClient,
  workerNodeId: string,
  workerTokenSha256: string,
  workerInstanceId: string,
) =>
  client.request("registerWorker", {
    protocolVersion: "1.0",
    workerNodeId,
    workerTokenSha256,
    workerInstanceId,
    displayName: workerInstanceId,
    workerVersion: "recovery-test",
    maxSlots: 1,
    capabilities: workerCapabilities,
  });

afterEach(async () => {
  const errors: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await closeFixtureClient(fixture);
    } catch (error) {
      errors.push(error);
    }
    try {
      await rm(fixture.directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Worker Token recovery fixture cleanup failed.");
  }
});

describe.skipIf(process.platform === "win32")("Worker Token operational recovery", () => {
  it("recovers a committed create whose plaintext response was lost by rotating the roster record", async () => {
    const fixture = await createFixture();
    const client = currentClient(fixture);
    const workerNodeId = "worker:token-recovery-create";
    const lostTokenSha256 = sha256("create-response-token-that-was-not-retained");
    const replacementTokenSha256 = sha256("create-response-recovery-token");

    await createCredential(client, workerNodeId, lostTokenSha256);
    const committedRecord = await credentialRecord(client, workerNodeId);
    expect(committedRecord).toMatchObject({ workerNodeId, authState: "pending" });
    expect(JSON.stringify(committedRecord)).not.toContain(lostTokenSha256);
    await expect(authenticate(client, lostTokenSha256)).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId,
      authState: "pending",
    });

    await expect(
      rotateCredential(
        client,
        workerNodeId,
        replacementTokenSha256,
        committedRecord.updatedAt,
        "create-response-recovery",
      ),
    ).resolves.toEqual({ workerNodeId, authState: "pending" });
    await expect(authenticate(client, lostTokenSha256)).resolves.toEqual({ outcome: "invalid" });
    await expect(authenticate(client, replacementTokenSha256)).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId,
      authState: "pending",
    });
  });

  it("recovers a committed rotation whose plaintext response was lost by refreshing and rotating again", async () => {
    const fixture = await createFixture();
    const client = currentClient(fixture);
    const workerNodeId = "worker:token-recovery-rotate";
    const originalTokenSha256 = sha256("rotate-response-original-token");
    const lostRotationTokenSha256 = sha256("rotate-response-token-that-was-not-retained");
    const finalTokenSha256 = sha256("rotate-response-recovery-token");

    await createCredential(client, workerNodeId, originalTokenSha256);
    await registerWorker(
      client,
      workerNodeId,
      originalTokenSha256,
      "token-recovery-rotate-instance",
    );
    const beforeLostRotation = await credentialRecord(client, workerNodeId);
    await rotateCredential(
      client,
      workerNodeId,
      lostRotationTokenSha256,
      beforeLostRotation.updatedAt,
      "lost-rotation-response",
    );
    await expect(authenticate(client, originalTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(authenticate(client, lostRotationTokenSha256)).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId,
      authState: "active",
    });

    await expect(
      rotateCredential(
        client,
        workerNodeId,
        finalTokenSha256,
        beforeLostRotation.updatedAt,
        "stale-recovery-attempt",
      ),
    ).rejects.toMatchObject({ code: "WORKER_NODE_CREDENTIAL_CONFLICT" });

    const refreshedRecord = await credentialRecord(client, workerNodeId);
    expect(refreshedRecord.updatedAt).not.toBe(beforeLostRotation.updatedAt);
    await expect(
      rotateCredential(
        client,
        workerNodeId,
        finalTokenSha256,
        refreshedRecord.updatedAt,
        "rotation-response-recovery",
      ),
    ).resolves.toEqual({ workerNodeId, authState: "active" });

    await expect(authenticate(client, originalTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(authenticate(client, lostRotationTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(authenticate(client, finalTokenSha256)).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId,
      authState: "active",
    });
  });

  it("retries revocation safely and keeps the credential terminal", async () => {
    const fixture = await createFixture();
    const client = currentClient(fixture);
    const workerNodeId = "worker:token-recovery-revoke";
    const workerTokenSha256 = sha256("revocation-recovery-token");

    await createCredential(client, workerNodeId, workerTokenSha256);
    await registerWorker(client, workerNodeId, workerTokenSha256, "token-recovery-revoke-instance");
    await revokeCredential(client, workerNodeId, "first-revocation");
    const firstResult = await credentialRecord(client, workerNodeId);
    expect(firstResult).toMatchObject({ workerNodeId, authState: "revoked" });

    await closeFixtureClient(fixture);
    await reopenFixtureClient(fixture);
    expect(await credentialRecord(currentClient(fixture), workerNodeId)).toEqual(firstResult);
    await expect(authenticate(currentClient(fixture), workerTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(
      revokeCredential(currentClient(fixture), workerNodeId, "revocation-response-retry"),
    ).resolves.toEqual({ workerNodeId, authState: "revoked" });
    expect(await credentialRecord(currentClient(fixture), workerNodeId)).toEqual(firstResult);
    await expect(authenticate(currentClient(fixture), workerTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(
      rotateCredential(
        currentClient(fixture),
        workerNodeId,
        sha256("revoked-token-replacement"),
        firstResult.updatedAt,
        "revoked-rotation-attempt",
      ),
    ).rejects.toMatchObject({ code: "WORKER_NODE_CREDENTIAL_REVOKED" });
  });

  it("restores the exact credential snapshot from a database backup", async () => {
    const fixture = await createFixture();
    const workerNodeId = "worker:token-recovery-backup";
    const knownRevocationWorkerNodeId = "worker:token-recovery-known-revocation";
    const pendingWorkerNodeId = "worker:token-recovery-pending-snapshot";
    const backedUpTokenSha256 = sha256("backup-snapshot-token");
    const knownRevocationTokenSha256 = sha256("backup-known-revocation-token");
    const pendingTokenSha256 = sha256("backup-pending-token");
    const laterTokenSha256 = sha256("post-backup-rotation-token");
    const reconciledTokenSha256 = sha256("post-restore-reconciliation-token");
    const reconciledPendingTokenSha256 = sha256("post-restore-pending-token");

    await createCredential(currentClient(fixture), workerNodeId, backedUpTokenSha256);
    await registerWorker(
      currentClient(fixture),
      workerNodeId,
      backedUpTokenSha256,
      "token-recovery-backup-instance",
    );
    await createCredential(
      currentClient(fixture),
      knownRevocationWorkerNodeId,
      knownRevocationTokenSha256,
    );
    await registerWorker(
      currentClient(fixture),
      knownRevocationWorkerNodeId,
      knownRevocationTokenSha256,
      "token-recovery-known-revocation-instance",
    );
    await createCredential(currentClient(fixture), pendingWorkerNodeId, pendingTokenSha256);
    const backedUpRecord = await credentialRecord(currentClient(fixture), workerNodeId);
    const knownRevocationBackedUpRecord = await credentialRecord(
      currentClient(fixture),
      knownRevocationWorkerNodeId,
    );
    const pendingBackedUpRecord = await credentialRecord(
      currentClient(fixture),
      pendingWorkerNodeId,
    );
    expect(backedUpRecord.authState).toBe("active");
    expect(knownRevocationBackedUpRecord.authState).toBe("active");
    expect(pendingBackedUpRecord.authState).toBe("pending");

    await closeFixtureClient(fixture);
    const retainedDirectory = join(fixture.directory, "retained");
    await mkdir(retainedDirectory, { mode: 0o700 });
    const backupPath = join(retainedDirectory, "server.sqlite");
    await copyFile(fixture.databasePath, backupPath);
    if (process.platform !== "win32") {
      await chmod(backupPath, 0o600);
    }
    await reopenFixtureClient(fixture);

    await rotateCredential(
      currentClient(fixture),
      workerNodeId,
      laterTokenSha256,
      backedUpRecord.updatedAt,
      "post-backup-rotation",
    );
    await revokeCredential(currentClient(fixture), workerNodeId, "post-backup-revocation");
    await revokeCredential(
      currentClient(fixture),
      knownRevocationWorkerNodeId,
      "known-post-backup-revocation",
    );
    expect(await credentialRecord(currentClient(fixture), workerNodeId)).toMatchObject({
      authState: "revoked",
      revokedAt: expect.any(String),
    });
    await expect(authenticate(currentClient(fixture), backedUpTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(authenticate(currentClient(fixture), laterTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });

    await closeFixtureClient(fixture);
    await removeDatabaseSidecars(fixture.databasePath);
    await copyFile(backupPath, fixture.databasePath);
    if (process.platform !== "win32") {
      await chmod(fixture.databasePath, 0o600);
    }
    await reopenFixtureClient(fixture);

    await expect(authenticate(currentClient(fixture), backedUpTokenSha256)).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId,
      authState: "active",
    });
    await expect(authenticate(currentClient(fixture), laterTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    expect(await credentialRecord(currentClient(fixture), workerNodeId)).toEqual(backedUpRecord);
    expect(await credentialRecord(currentClient(fixture), knownRevocationWorkerNodeId)).toEqual(
      knownRevocationBackedUpRecord,
    );
    expect(await credentialRecord(currentClient(fixture), pendingWorkerNodeId)).toEqual(
      pendingBackedUpRecord,
    );
    await expect(authenticate(currentClient(fixture), knownRevocationTokenSha256)).resolves.toEqual(
      {
        outcome: "authenticated",
        workerNodeId: knownRevocationWorkerNodeId,
        authState: "active",
      },
    );
    await expect(authenticate(currentClient(fixture), pendingTokenSha256)).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId: pendingWorkerNodeId,
      authState: "pending",
    });

    await rotateCredential(
      currentClient(fixture),
      workerNodeId,
      reconciledTokenSha256,
      backedUpRecord.updatedAt,
      "post-restore-reconciliation",
    );
    await rotateCredential(
      currentClient(fixture),
      pendingWorkerNodeId,
      reconciledPendingTokenSha256,
      pendingBackedUpRecord.updatedAt,
      "post-restore-pending-reconciliation",
    );
    await revokeCredential(
      currentClient(fixture),
      knownRevocationWorkerNodeId,
      "known-revocation-replay",
    );
    await expect(authenticate(currentClient(fixture), backedUpTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(authenticate(currentClient(fixture), reconciledTokenSha256)).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId,
      authState: "active",
    });
    await expect(authenticate(currentClient(fixture), pendingTokenSha256)).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(
      authenticate(currentClient(fixture), reconciledPendingTokenSha256),
    ).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId: pendingWorkerNodeId,
      authState: "pending",
    });
    await expect(authenticate(currentClient(fixture), knownRevocationTokenSha256)).resolves.toEqual(
      {
        outcome: "invalid",
      },
    );
    expect(
      await credentialRecord(currentClient(fixture), knownRevocationWorkerNodeId),
    ).toMatchObject({
      authState: "revoked",
      revokedAt: expect.any(String),
    });
  });

  it("removes a Worker credential created after the restored backup snapshot", async () => {
    const fixture = await createFixture();
    const postBackupWorkerNodeId = "worker:token-created-after-backup";
    const postBackupWorkerTokenSha256 = sha256("post-backup-created-worker-token");

    await closeFixtureClient(fixture);
    const retainedDirectory = join(fixture.directory, "retained-before-create");
    await mkdir(retainedDirectory, { mode: 0o700 });
    const backupPath = join(retainedDirectory, "server.sqlite");
    await copyFile(fixture.databasePath, backupPath);
    if (process.platform !== "win32") {
      await chmod(backupPath, 0o600);
    }
    await reopenFixtureClient(fixture);

    await createCredential(
      currentClient(fixture),
      postBackupWorkerNodeId,
      postBackupWorkerTokenSha256,
    );
    expect(await credentialRecord(currentClient(fixture), postBackupWorkerNodeId)).toMatchObject({
      workerNodeId: postBackupWorkerNodeId,
      authState: "pending",
    });
    await expect(
      authenticate(currentClient(fixture), postBackupWorkerTokenSha256),
    ).resolves.toEqual({
      outcome: "authenticated",
      workerNodeId: postBackupWorkerNodeId,
      authState: "pending",
    });

    await closeFixtureClient(fixture);
    await removeDatabaseSidecars(fixture.databasePath);
    await copyFile(backupPath, fixture.databasePath);
    if (process.platform !== "win32") {
      await chmod(fixture.databasePath, 0o600);
    }
    await reopenFixtureClient(fixture);

    await expect(
      authenticate(currentClient(fixture), postBackupWorkerTokenSha256),
    ).resolves.toEqual({ outcome: "invalid" });
    await expect(
      currentClient(fixture).request("listWorkerNodeCredentials", {
        offset: 0,
        limit: 200,
        sort: "identity",
      }),
    ).resolves.toEqual({ items: [], total: 0 });
  });
});
