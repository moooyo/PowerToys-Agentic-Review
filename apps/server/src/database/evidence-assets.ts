import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  type Dir,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AppendEvidenceChunkRequest,
  AppendEvidenceChunkRequestSchema,
  type BeginEvidenceUploadRequest,
  BeginEvidenceUploadRequestSchema,
  EntityIdSchema,
  type EvidenceAssetManifest,
  type EvidenceAssetMetadata,
  EvidenceAssetMetadataSchema,
  type EvidenceUploadResponse,
  type FinalizeEvidenceUploadRequest,
  FinalizeEvidenceUploadRequestSchema,
  getEvidenceChunkDecodedBytes,
  JobExecutionTemplateV2Schema,
  type LeaseIdentity,
  maximumAttemptEvidenceAssets,
  maximumAttemptEvidenceBytes,
  maximumEvidenceChunkBytes,
  maximumValidationCheckEvidenceReferences,
  type ValidationJobContext,
  ValidationJobContextSchema,
  type ValidationJobContextV2,
} from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson } from "../scheduling/canonical-json.js";
import { readEvaluationJobBindingInTransaction } from "./evaluation-execution.js";
import { evidenceFileIdentity } from "./evidence-files.js";
import {
  type AssetAttestation,
  AssetAttestationSchema,
  type AssetVerificationSnapshot,
  checkAssetSnapshot,
  checkVerificationSchema,
  type EvidenceVerificationAsset,
  type EvidenceVerificationChunk,
  evidenceSnapshotDigest,
  sameEvidenceIdentity,
} from "./evidence-verification-protocol.js";

export interface EvidenceStorageOptions {
  readonly evidenceDirectory: string;
  readonly globalQuotaBytes: number;
  readonly globalAssetLimit: number;
  readonly retentionMs: number;
  readonly incompleteUploadTtlMs: number;
}
export interface EvidenceAssetScope {
  readonly repositoryId: string;
  readonly runId: string;
  readonly jobId: string;
  readonly runAttemptId: string;
}
export interface EvidenceAssetOperationMap {
  readonly beginEvidenceUpload: {
    readonly input: BeginEvidenceUploadRequest;
    readonly output: EvidenceUploadResponse;
  };
  readonly appendEvidenceChunk: {
    readonly input: AppendEvidenceChunkRequest;
    readonly output: EvidenceUploadResponse;
  };
  readonly finalizeEvidenceUpload: {
    readonly input: FinalizeEvidenceUploadRequest;
    readonly output: EvidenceAssetManifest;
  };
  readonly getEvidenceAsset: {
    readonly input: EvidenceAssetScope & { readonly assetId: string };
    readonly output: EvidenceAssetManifest | null;
  };
  readonly listEvidenceAssets: {
    readonly input: EvidenceAssetScope;
    readonly output: { readonly items: EvidenceAssetManifest[] };
  };
  readonly readEvidenceAssetChunk: {
    readonly input: EvidenceAssetScope & {
      readonly assetId: string;
      readonly offset: number;
      readonly maximumBytes?: number;
    };
    readonly output: {
      readonly manifest: EvidenceAssetManifest;
      readonly offset: number;
      readonly base64: string;
      readonly eof: boolean;
    };
  };
  readonly cleanupEvidenceAssets: {
    readonly input: { readonly limit?: number };
    readonly output: { readonly retired: number; readonly orphanFilesRemoved: number };
  };
}
export type EvidenceAssetOperation = keyof EvidenceAssetOperationMap;
export type EvidenceAssetRequest = {
  [K in EvidenceAssetOperation]: {
    readonly operation: K;
    readonly input: EvidenceAssetOperationMap[K]["input"];
  };
}[EvidenceAssetOperation];
export const isEvidenceAssetOperation = (value: string): value is EvidenceAssetOperation =>
  [
    "beginEvidenceUpload",
    "appendEvidenceChunk",
    "finalizeEvidenceUpload",
    "getEvidenceAsset",
    "listEvidenceAssets",
    "readEvidenceAssetChunk",
    "cleanupEvidenceAssets",
  ].includes(value);

export class EvidenceStorageError extends Error {
  constructor(
    readonly code:
      | "EVIDENCE_INVALID"
      | "EVIDENCE_LEASE_REJECTED"
      | "EVIDENCE_CONFLICT"
      | "EVIDENCE_QUOTA"
      | "EVIDENCE_UNAVAILABLE"
      | "EVIDENCE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "EvidenceStorageError";
  }
}
function invalid(message: string): never {
  throw new EvidenceStorageError("EVIDENCE_INVALID", message);
}
function unavailable(): never {
  throw new EvidenceStorageError(
    "EVIDENCE_UNAVAILABLE",
    "Evidence bytes are unavailable or failed integrity checks.",
  );
}
function conflict(message: string): never {
  throw new EvidenceStorageError("EVIDENCE_CONFLICT", message);
}
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function validate<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) invalid("The evidence request is invalid.");
  return value;
}
function canonicalTime(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    invalid("Evidence timestamps must use canonical UTC ISO format.");
}
function validScope(scope: EvidenceAssetScope): void {
  for (const value of [scope.repositoryId, scope.runId, scope.jobId, scope.runAttemptId])
    validate(EntityIdSchema, value);
}
interface AssetRow {
  id: string;
  repository_id: string;
  review_run_id: string;
  request_id: string;
  job_id: string;
  run_attempt_id: string;
  profile_version_id: string;
  revision_key: string;
  plan_digest: string;
  client_asset_id: string;
  metadata_json: string;
  kind: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  check_id: string | null;
  file_device: string;
  file_inode: string;
  committed_bytes: number;
  state: "uploading" | "finalized" | "retired";
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  retired_at: string | null;
}
interface LeaseRow {
  job_id: string;
  worker_node_id: string;
  worker_instance_id: string;
  lease_generation: number;
  lease_token_hash: string;
  status: string;
  lease_expires_at: string;
  execution_deadline_at: string;
  no_progress_deadline_at: string;
  worker_node: string;
  worker_instance: string;
  worker_status: string;
  superseded_at: string | null;
  job_status: string;
  cancellation_requested_at: string | null;
  current_run_attempt_id: string;
  current_generation: number;
  execution_json: string;
  execution_digest: string;
  repository_id: string;
  review_run_id: string;
  request_id: string;
  activation_number: number;
  profile_version_id: string;
  revision_key: string;
  plan_digest: string;
  activation_id: string;
  request_epoch_id: string | null;
  job_request_epoch_id: string | null;
  work_item_id: string;
  workflow_kind: string;
  target: string;
  request_json: string;
  prompt_version_id: string;
}
type ActiveValidationContext = ValidationJobContext | ValidationJobContextV2;

function leaseContext(
  db: DatabaseSync,
  lease: LeaseIdentity,
  now: string,
): ActiveValidationContext {
  const row = db
    .prepare(`SELECT attempt.*, worker.node_id AS worker_node, worker.instance_id AS worker_instance,
    worker.status AS worker_status, worker.superseded_at, job.status AS job_status, job.cancellation_requested_at,
    job.current_run_attempt_id, job.lease_generation AS current_generation, job.execution_json, job.execution_digest,
    job.request_epoch_id AS job_request_epoch_id,
    run.repository_id, run.id AS review_run_id, link.request_id, link.activation_number, request.profile_version_id,
    run.revision_key, run.plan_digest, run.activation_id, run.request_epoch_id, run.work_item_id,
    request.workflow_kind, request.target, request.request_json, request.prompt_version_id
    FROM run_attempts AS attempt JOIN jobs AS job ON job.id = attempt.job_id
    JOIN workers AS worker ON worker.id = attempt.worker_id
    JOIN review_run_job_links AS link ON link.job_id = job.id
    JOIN review_runs AS run ON run.id = link.review_run_id
    JOIN review_run_requests AS request ON request.review_run_id = run.id AND request.request_id = link.request_id
    WHERE attempt.id = ?`)
    .get(lease.runAttemptId) as unknown as LeaseRow | undefined;
  function reject(): never {
    throw new EvidenceStorageError(
      "EVIDENCE_LEASE_REJECTED",
      "The active validation lease does not authorize this upload.",
    );
  }
  if (
    row === undefined ||
    row.job_id !== lease.jobId ||
    row.worker_node_id !== lease.workerNodeId ||
    row.worker_instance_id !== lease.workerInstanceId ||
    row.worker_node !== lease.workerNodeId ||
    row.worker_instance !== lease.workerInstanceId ||
    row.lease_generation !== lease.leaseGeneration ||
    row.current_generation !== lease.leaseGeneration ||
    row.current_run_attempt_id !== lease.runAttemptId ||
    row.superseded_at !== null ||
    !["online", "draining"].includes(row.worker_status) ||
    !["leased", "running"].includes(row.status) ||
    !["leased", "running"].includes(row.job_status) ||
    row.cancellation_requested_at !== null ||
    row.lease_expires_at <= now ||
    row.execution_deadline_at <= now ||
    row.no_progress_deadline_at <= now ||
    !/^[a-f0-9]{64}$/u.test(row.lease_token_hash) ||
    !timingSafeEqual(
      Buffer.from(row.lease_token_hash, "hex"),
      Buffer.from(hash(lease.leaseToken), "hex"),
    )
  )
    reject();
  try {
    const execution = JSON.parse(row.execution_json) as { validation?: unknown };
    if (
      canonicalJson(execution) !== row.execution_json ||
      hash(row.execution_json) !== row.execution_digest
    )
      reject();
    let context: ActiveValidationContext;
    if (
      Value.Check(JobExecutionTemplateV2Schema, execution) &&
      execution.validation.schemaVersion === "ValidationJobContextV2"
    ) {
      context = execution.validation;
      // Every caller currently owns a synchronous upload/finalization transaction. Keep the
      // sealed read bounded and transactional if another synchronous caller is added later.
      const read = () => readEvaluationJobBindingInTransaction(db, lease.jobId, execution, now);
      let cell: ReturnType<typeof read>;
      if (db.isTransaction) cell = read();
      else {
        db.exec("BEGIN");
        try {
          cell = read();
          db.exec("COMMIT");
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      }
      if (
        row.request_epoch_id !== null ||
        row.job_request_epoch_id !== null ||
        cell.controlStatus !== "active" ||
        !cell.repositoryEnabled ||
        !cell.applicable ||
        cell.reproductionReadiness.state === "blocked" ||
        cell.runId !== row.review_run_id ||
        cell.repositoryId !== row.repository_id ||
        cell.requestId !== row.request_id
      )
        reject();
    } else {
      if (!Value.Check(ValidationJobContextSchema, execution.validation)) reject();
      context = execution.validation;
    }
    if (
      context.runId !== row.review_run_id ||
      context.repositoryId !== row.repository_id ||
      context.requestId !== row.request_id ||
      context.jobActivation !== row.activation_number ||
      context.profileVersion.id !== row.profile_version_id ||
      context.revisionKey !== row.revision_key ||
      context.planDigest !== row.plan_digest ||
      context.activationId !== row.activation_id ||
      context.requestEpochId !== row.request_epoch_id ||
      context.workItemId !== row.work_item_id ||
      context.workflowKind !== row.workflow_kind ||
      context.target !== row.target ||
      context.promptVersion.id !== row.prompt_version_id ||
      canonicalJson(context.profileVersion) !==
        canonicalJson(JSON.parse(row.request_json).profileVersion)
    )
      reject();
    return context;
  } catch {
    return reject();
  }
}
function checkScope(row: AssetRow, scope: EvidenceAssetScope): boolean {
  return (
    row.repository_id === scope.repositoryId &&
    row.review_run_id === scope.runId &&
    row.job_id === scope.jobId &&
    row.run_attempt_id === scope.runAttemptId
  );
}
function getRow(db: DatabaseSync, id: string): AssetRow | undefined {
  validate(EntityIdSchema, id);
  return db.prepare("SELECT * FROM evidence_assets WHERE id = ?").get(id) as unknown as
    | AssetRow
    | undefined;
}
function manifest(row: AssetRow): EvidenceAssetManifest {
  if (row.state === "uploading" || row.finalized_at === null) unavailable();
  return {
    id: row.id,
    repositoryId: row.repository_id,
    runId: row.review_run_id,
    jobId: row.job_id,
    runAttemptId: row.run_attempt_id,
    requestId: row.request_id,
    profileVersionId: row.profile_version_id,
    revisionKey: row.revision_key,
    planDigest: row.plan_digest,
    metadata: validate(EvidenceAssetMetadataSchema, JSON.parse(row.metadata_json)),
    state: row.state,
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
    retiredAt: row.retired_at,
  };
}
function audit(db: DatabaseSync, id: string, action: string, now: string): void {
  db.prepare(
    "INSERT INTO evidence_asset_audit(id, asset_id, action, created_at) VALUES (?, ?, ?, ?)",
  ).run(randomUUID(), id, action, now);
}

function createDurableDirectory(directory: string): void {
  const missing: string[] = [];
  let existing = directory;
  for (;;) {
    try {
      const info = lstatSync(existing);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(existing) !== existing)
        unavailable();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(existing);
      existing = dirname(existing);
    }
  }
  for (const next of missing.reverse()) {
    mkdirSync(next, { mode: 0o700 });
    const parent = openSync(
      dirname(next),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  // A previous process may have exited between mkdir and its parent directory barrier.
  for (let current = directory; current !== dirname(current); current = dirname(current)) {
    const parent = openSync(
      dirname(current),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
}

const initializedStorageRoots = new WeakMap<
  DatabaseSync,
  { directory: string; storageKey: string; device: string; inode: string }
>();

/** Initialize or recover the private storage root once for this SQLite owner's lifetime. */
export function initializeEvidenceStorage(db: DatabaseSync, options: EvidenceStorageOptions): void {
  try {
    const directory = new PrivateDirectory(db, options);
    directory.close();
  } catch (error) {
    if (error instanceof EvidenceStorageError) throw error;
    unavailable();
  }
}

// The directory descriptor anchors operations even if an ancestor is renamed.
class PrivateDirectory {
  readonly descriptor: number;
  constructor(
    db: DatabaseSync,
    readonly options: EvidenceStorageOptions,
    mode: "read" | "write" = "write",
  ) {
    if (process.platform !== "linux") invalid("Evidence storage requires the Linux SQLite owner.");
    if (!isAbsolute(options.evidenceDirectory) || resolve(options.evidenceDirectory) === "/")
      invalid("A dedicated absolute evidence directory is required.");
    for (const limit of [
      options.globalQuotaBytes,
      options.globalAssetLimit,
      options.retentionMs,
      options.incompleteUploadTtlMs,
    ]) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        invalid("Evidence quotas and retention must be explicitly bounded.");
    }
    const directory = resolve(options.evidenceDirectory);
    const key = readEvidenceStorageKey(db);
    const initialized = initializedStorageRoots.get(db);
    const knownRoot = initialized?.directory === directory && initialized.storageKey === key;
    const initialize = mode === "write" && !knownRoot;
    if (initialize) createDurableDirectory(directory);
    const before = lstatSync(directory, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      before.uid !== BigInt(process.geteuid?.() ?? -1) ||
      (before.mode & 0o777n) !== 0o700n ||
      (knownRoot &&
        (initialized.device !== String(before.dev) || initialized.inode !== String(before.ino)))
    )
      unavailable();
    this.descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const actual = fstatSync(this.descriptor, { bigint: true });
      if (actual.dev !== before.dev || actual.ino !== before.ino) unavailable();
      const marker = `.owner-${key}`;
      let fd: number;
      try {
        fd = openSync(this.path(marker), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (!initialize) unavailable();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A foreign or damaged storage directory must never be adopted by a new database.
        const entries = opendirSync(`/proc/self/fd/${this.descriptor}`);
        try {
          if (entries.readSync() !== null) unavailable();
        } finally {
          entries.closeSync();
        }
        // An empty identity file has no partially written payload after a process crash.
        fd = openSync(
          this.path(marker),
          constants.O_RDONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      }
      try {
        const info = fstatSync(fd);
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.uid !== process.geteuid?.() ||
          (info.mode & 0o777) !== 0o600 ||
          info.size !== 0
        )
          unavailable();
        if (initialize) {
          fsyncSync(fd);
          fsyncSync(this.descriptor);
        }
      } finally {
        closeSync(fd);
      }
      if (initialize)
        initializedStorageRoots.set(db, {
          directory,
          storageKey: key,
          device: String(actual.dev),
          inode: String(actual.ino),
        });
    } catch (error) {
      closeSync(this.descriptor);
      throw error;
    }
  }
  path(name: string): string {
    if (!/^\.owner-[a-f0-9]{32}$/u.test(name) && !/^[a-f0-9-]{36}\.(upload|asset)$/u.test(name))
      unavailable();
    return `/proc/self/fd/${this.descriptor}/${name}`;
  }
  close(): void {
    closeSync(this.descriptor);
  }
  open(row: AssetRow, final: boolean, writable = false): number {
    try {
      const fd = openSync(
        this.path(`${row.id}.${final ? "asset" : "upload"}`),
        (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW,
      );
      try {
        const info = fstatSync(fd, { bigint: true });
        if (
          !info.isFile() ||
          info.nlink !== 1n ||
          info.uid !== BigInt(process.geteuid?.() ?? -1) ||
          (info.mode & 0o777n) !== 0o600n ||
          String(info.dev) !== row.file_device ||
          String(info.ino) !== row.file_inode ||
          (final
            ? info.size !== BigInt(row.size_bytes)
            : info.size < BigInt(row.committed_bytes) || info.size > BigInt(row.size_bytes))
        )
          unavailable();
        return fd;
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    } catch {
      return unavailable();
    }
  }
}
function transaction<T>(db: DatabaseSync, callback: () => T): T {
  if (db.isTransaction) invalid("Evidence upload operations require their own owner transaction.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function uploadRow(db: DatabaseSync, lease: LeaseIdentity, assetId: string, now: string): AssetRow {
  const context = leaseContext(db, lease, now);
  const row = getRow(db, assetId);
  if (
    row === undefined ||
    !checkScope(row, {
      repositoryId: context.repositoryId,
      runId: context.runId,
      jobId: lease.jobId,
      runAttemptId: lease.runAttemptId,
    }) ||
    row.profile_version_id !== context.profileVersion.id ||
    row.plan_digest !== context.planDigest ||
    row.state === "retired"
  ) {
    throw new EvidenceStorageError(
      "EVIDENCE_NOT_FOUND",
      "Evidence asset is not available in this attempt.",
    );
  }
  return row;
}
function response(row: AssetRow): EvidenceUploadResponse {
  if (row.state === "retired") unavailable();
  return { assetId: row.id, offset: row.committed_bytes, state: row.state };
}
function checkMetadata(
  context: ActiveValidationContext,
  metadata: EvidenceAssetMetadata,
  now: string,
): void {
  canonicalTime(metadata.capturedAt);
  if (metadata.capturedAt > now) invalid("Evidence cannot be captured in the future.");
  if (metadata.checkId !== undefined) {
    const config = context.profileVersion.config;
    const ids = new Set(
      [...config.setup, ...config.build, ...config.test, ...config.launch, ...config.cleanup].map(
        (step) => `${context.profileVersion.id}:${step.id}`,
      ),
    );
    for (const scenario of config.ui?.scenarios ?? [])
      ids.add(`${context.profileVersion.id}:${scenario.id}`);
    if (!ids.has(metadata.checkId)) invalid("Evidence check must belong to the frozen profile.");
  }
}
function begin(
  db: DatabaseSync,
  directory: PrivateDirectory,
  input: BeginEvidenceUploadRequest,
  now: string,
): EvidenceUploadResponse {
  validate(BeginEvidenceUploadRequestSchema, input);
  return transaction(db, () => {
    const context = leaseContext(db, input.lease, now);
    checkMetadata(context, input.metadata, now);
    const serialized = canonicalJson(input.metadata);
    const existing = db
      .prepare("SELECT * FROM evidence_assets WHERE run_attempt_id = ? AND client_asset_id = ?")
      .get(input.lease.runAttemptId, input.clientAssetId) as unknown as AssetRow | undefined;
    if (existing !== undefined) {
      if (existing.metadata_json !== serialized)
        conflict("The client asset ID already identifies different evidence.");
      const row = uploadRow(db, input.lease, existing.id, now);
      if (row.state === "finalized") closeSync(directory.open(row, true));
      return response(row);
    }
    const totals = db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM evidence_assets WHERE run_attempt_id = ?",
      )
      .get(input.lease.runAttemptId) as { count: number; bytes: number };
    const global = db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM evidence_assets WHERE state <> 'retired'",
      )
      .get() as { count: number; bytes: number };
    if (
      totals.count >= maximumAttemptEvidenceAssets ||
      totals.bytes + input.metadata.sizeBytes > maximumAttemptEvidenceBytes ||
      global.bytes + input.metadata.sizeBytes > directory.options.globalQuotaBytes ||
      global.count >= directory.options.globalAssetLimit
    ) {
      throw new EvidenceStorageError(
        "EVIDENCE_QUOTA",
        "The configured evidence storage quota is exhausted.",
      );
    }
    const id = randomUUID();
    const fd = openSync(
      directory.path(`${id}.upload`),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let info: ReturnType<typeof fstatSync>;
    try {
      fsyncSync(fd);
      info = fstatSync(fd, { bigint: true });
    } finally {
      closeSync(fd);
    }
    fsyncSync(directory.descriptor);
    // A failed commit leaves a bounded orphan; cleanup removes it after the upload TTL.
    db.prepare(`INSERT INTO evidence_assets(id, repository_id, review_run_id, request_id, job_id, run_attempt_id,
      profile_version_id, revision_key, plan_digest, client_asset_id, metadata_json, kind, media_type, size_bytes,
      sha256, check_id, file_device, file_inode, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`).run(
      id,
      context.repositoryId,
      context.runId,
      context.requestId,
      input.lease.jobId,
      input.lease.runAttemptId,
      context.profileVersion.id,
      context.revisionKey,
      context.planDigest,
      input.clientAssetId,
      serialized,
      input.metadata.kind,
      input.metadata.mediaType,
      input.metadata.sizeBytes,
      input.metadata.sha256,
      input.metadata.checkId ?? null,
      String(info.dev),
      String(info.ino),
      now,
      now,
    );
    audit(db, id, "begun", now);
    return { assetId: id, offset: 0, state: "uploading" };
  });
}
function append(
  db: DatabaseSync,
  directory: PrivateDirectory,
  input: AppendEvidenceChunkRequest,
  now: string,
): EvidenceUploadResponse {
  validate(AppendEvidenceChunkRequestSchema, input);
  const length = getEvidenceChunkDecodedBytes(input.base64);
  if (length === null || length < 1 || length > maximumEvidenceChunkBytes)
    invalid("Evidence chunk encoding or size is invalid.");
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.toString("base64") !== input.base64 || hash(bytes) !== input.chunkSha256)
    invalid("Evidence chunk digest does not match its bytes.");
  return transaction(db, () => {
    const row = uploadRow(db, input.lease, input.assetId, now);
    if (input.offset < row.committed_bytes) {
      const chunk = db
        .prepare(
          "SELECT size_bytes, sha256 FROM evidence_asset_chunks WHERE asset_id = ? AND byte_offset = ?",
        )
        .get(row.id, input.offset) as { size_bytes: number; sha256: string } | undefined;
      if (
        chunk === undefined ||
        chunk.size_bytes !== bytes.length ||
        chunk.sha256 !== input.chunkSha256
      )
        conflict("Replayed chunk does not match committed bytes.");
      const fd = directory.open(row, row.state === "finalized");
      try {
        const stored = Buffer.alloc(bytes.length);
        if (
          readSync(fd, stored, 0, stored.length, input.offset) !== stored.length ||
          !stored.equals(bytes)
        )
          unavailable();
      } finally {
        closeSync(fd);
      }
      return response(row);
    }
    if (
      row.state !== "uploading" ||
      input.offset !== row.committed_bytes ||
      input.offset + bytes.length > row.size_bytes
    )
      conflict("Evidence chunks must append at the committed offset.");
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM evidence_asset_chunks WHERE asset_id = ?")
      .get(row.id) as { count: number };
    if (count.count >= 4096) invalid("An evidence asset cannot contain more than 4096 chunks.");
    const fd = directory.open(row, false, true);
    try {
      // Discard bytes written by an earlier transaction that did not commit.
      ftruncateSync(fd, row.committed_bytes);
      let written = 0;
      while (written < bytes.length)
        written += writeSync(fd, bytes, written, bytes.length - written, input.offset + written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    db.prepare(
      "INSERT INTO evidence_asset_chunks(asset_id, byte_offset, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(row.id, input.offset, bytes.length, input.chunkSha256, now);
    db.prepare("UPDATE evidence_assets SET committed_bytes = ?, updated_at = ? WHERE id = ?").run(
      input.offset + bytes.length,
      now,
      row.id,
    );
    return { assetId: row.id, offset: input.offset + bytes.length, state: "uploading" };
  });
}
function verifyContents(
  db: DatabaseSync,
  directory: PrivateDirectory,
  row: AssetRow,
  final: boolean,
): void {
  const fd = directory.open(row, final);
  try {
    if (fstatSync(fd).size !== row.size_bytes) unavailable();
    const digest = createHash("sha256");
    const chunks = db
      .prepare(
        "SELECT byte_offset, size_bytes, sha256 FROM evidence_asset_chunks WHERE asset_id = ? ORDER BY byte_offset",
      )
      .all(row.id) as unknown as { byte_offset: number; size_bytes: number; sha256: string }[];
    let offset = 0;
    for (const chunk of chunks) {
      if (
        chunk.byte_offset !== offset ||
        chunk.size_bytes > maximumEvidenceChunkBytes ||
        chunk.size_bytes < 1
      )
        unavailable();
      const bytes = Buffer.alloc(chunk.size_bytes);
      if (
        readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length ||
        hash(bytes) !== chunk.sha256
      )
        unavailable();
      digest.update(bytes);
      offset += bytes.length;
    }
    if (offset !== row.size_bytes || digest.digest("hex") !== row.sha256) unavailable();
  } finally {
    closeSync(fd);
  }
}
function finalize(
  db: DatabaseSync,
  directory: PrivateDirectory,
  input: FinalizeEvidenceUploadRequest,
  now: string,
): EvidenceAssetManifest {
  validate(FinalizeEvidenceUploadRequestSchema, input);
  return transaction(db, () => {
    const row = uploadRow(db, input.lease, input.assetId, now);
    if (row.committed_bytes !== row.size_bytes) conflict("Evidence upload is incomplete.");
    let renamed = row.state === "finalized";
    if (!renamed) {
      try {
        lstatSync(directory.path(`${row.id}.asset`));
        renamed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    verifyContents(db, directory, row, renamed);
    if (row.state === "finalized") return manifest(row);
    if (!renamed) {
      renameSync(directory.path(`${row.id}.upload`), directory.path(`${row.id}.asset`));
    }
    // Recovery must repeat this barrier if the previous process exited just after rename.
    fsyncSync(directory.descriptor);
    // A crash after rename is recovered by validating the same inode on the next finalize.
    db.prepare(
      "UPDATE evidence_assets SET state = 'finalized', finalized_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, row.id);
    audit(db, row.id, "finalized", now);
    return manifest({ ...row, state: "finalized", finalized_at: now, updated_at: now });
  });
}

/** Use inside the terminal result transaction; incomplete or cross-check references fail closed. */
export function finalizedEvidenceReferences(
  db: DatabaseSync,
  input: EvidenceAssetScope & {
    readonly requestId: string;
    readonly profileVersionId: string;
    readonly evidenceIds: readonly string[];
    readonly checkId: string;
  },
  options?: EvidenceStorageOptions,
): boolean {
  validScope(input);
  if (
    input.evidenceIds.length === 0 ||
    input.evidenceIds.length > maximumValidationCheckEvidenceReferences ||
    new Set(input.evidenceIds).size !== input.evidenceIds.length
  )
    return false;
  let directory: PrivateDirectory | undefined;
  try {
    if (options !== undefined) directory = new PrivateDirectory(db, options, "read");
    for (const id of input.evidenceIds) {
      const row = getRow(db, id);
      if (
        row === undefined ||
        !checkScope(row, input) ||
        row.request_id !== input.requestId ||
        row.profile_version_id !== input.profileVersionId ||
        row.state !== "finalized" ||
        row.check_id !== input.checkId
      )
        return false;
      if (directory !== undefined) verifyContents(db, directory, row, true);
    }
    return true;
  } catch {
    return false;
  } finally {
    directory?.close();
  }
}
const orphanScans = new WeakMap<DatabaseSync, { identity: string; entries: Dir }>();

export interface EvidenceVerificationCandidate {
  readonly storageKey: string;
  readonly asset: EvidenceVerificationAsset;
  readonly manifestDigest: string;
  readonly fileBinding: {
    readonly device: string;
    readonly inode: string;
    readonly sizeBytes: number;
  };
  readonly chunks: EvidenceVerificationChunk[];
  readonly metadataToken: {
    readonly state: "uploading" | "finalized";
    readonly committedBytes: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly finalizedAt: string | null;
    readonly retentionReferenceAt: string;
    readonly fingerprint: string;
  };
}

export function readEvidenceStorageKey(db: DatabaseSync): string {
  const row = db
    .prepare("SELECT storage_key FROM evidence_storage_identity WHERE singleton = 1")
    .get() as { storage_key: string } | undefined;
  if (row === undefined || !/^[a-f0-9]{32}$/u.test(row.storage_key)) unavailable();
  return row.storage_key;
}

function verificationCandidate(db: DatabaseSync, row: AssetRow): EvidenceVerificationCandidate {
  if (row.state === "retired" || row.committed_bytes !== row.size_bytes)
    conflict("Evidence is not ready for verification.");
  const metadata = validate(EvidenceAssetMetadataSchema, JSON.parse(row.metadata_json));
  const asset: EvidenceVerificationAsset = {
    id: row.id,
    state: row.state,
    scope: {
      repositoryId: row.repository_id,
      runId: row.review_run_id,
      requestId: row.request_id,
      jobId: row.job_id,
      runAttemptId: row.run_attempt_id,
      profileVersionId: row.profile_version_id,
      revisionKey: row.revision_key,
      planDigest: row.plan_digest,
      checkId: row.check_id,
    },
    metadata,
  };
  const chunks = db
    .prepare(
      "SELECT byte_offset AS offset, size_bytes AS sizeBytes, sha256 FROM evidence_asset_chunks WHERE asset_id = ? ORDER BY byte_offset LIMIT 4097",
    )
    .all(row.id) as unknown as EvidenceVerificationChunk[];
  if (chunks.length > 4096) unavailable();
  const storageKey = readEvidenceStorageKey(db);
  const fileBinding = { device: row.file_device, inode: row.file_inode, sizeBytes: row.size_bytes };
  const tokenMetadata = {
    state: row.state,
    committedBytes: row.committed_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
    retentionReferenceAt: row.finalized_at ?? row.updated_at,
  };
  return {
    storageKey,
    asset,
    manifestDigest: evidenceSnapshotDigest(asset),
    fileBinding,
    chunks,
    metadataToken: {
      ...tokenMetadata,
      fingerprint: evidenceSnapshotDigest({
        storageKey,
        asset,
        fileBinding,
        chunks,
        ...tokenMetadata,
      }),
    },
  };
}

/** Returns only owner-derived metadata. No file is opened or hashed by this operation. */
export function readEvidenceVerificationCandidate(
  db: DatabaseSync,
  input: EvidenceAssetScope & {
    readonly assetId: string;
    readonly requestId: string;
    readonly profileVersionId: string;
    readonly checkId: string | null;
  },
): EvidenceVerificationCandidate | null {
  validScope(input);
  const row = getRow(db, input.assetId);
  if (
    row === undefined ||
    row.state !== "finalized" ||
    !checkScope(row, input) ||
    row.request_id !== input.requestId ||
    row.profile_version_id !== input.profileVersionId ||
    row.check_id !== input.checkId
  )
    return null;
  return verificationCandidate(db, row);
}

export function prepareEvidenceFinalizationCandidate(
  db: DatabaseSync,
  input: FinalizeEvidenceUploadRequest,
  now: string,
): EvidenceVerificationCandidate {
  canonicalTime(now);
  validate(FinalizeEvidenceUploadRequestSchema, input);
  return transaction(db, () =>
    verificationCandidate(db, uploadRow(db, input.lease, input.assetId, now)),
  );
}

/** Owner-only commit after a private verifier attestation; never expose this input over HTTP. */
export function commitVerifiedEvidenceFinalization(
  db: DatabaseSync,
  input: FinalizeEvidenceUploadRequest,
  snapshot: AssetVerificationSnapshot,
  attestation: AssetAttestation,
  now: string,
  options: EvidenceStorageOptions,
): EvidenceAssetManifest {
  canonicalTime(now);
  validate(FinalizeEvidenceUploadRequestSchema, input);
  checkAssetSnapshot(snapshot);
  checkVerificationSchema(AssetAttestationSchema, attestation);
  if (
    attestation.snapshotDigest !== evidenceSnapshotDigest(snapshot) ||
    attestation.manifestDigest !== snapshot.manifestDigest ||
    attestation.assetId !== snapshot.asset.id ||
    attestation.sha256 !== snapshot.asset.metadata.sha256 ||
    attestation.sizeBytes !== snapshot.asset.metadata.sizeBytes ||
    canonicalJson(attestation.storage) !== canonicalJson(snapshot.storage) ||
    !sameEvidenceIdentity(attestation.before, snapshot.expectedFile) ||
    !sameEvidenceIdentity(attestation.after, attestation.before)
  )
    conflict("Evidence attestation does not match the prepared upload.");
  const directory = new PrivateDirectory(db, options);
  try {
    return transaction(db, () => {
      const row = uploadRow(db, input.lease, input.assetId, now);
      const current = verificationCandidate(db, row);
      const root = fstatSync(directory.descriptor, { bigint: true });
      const key = (
        db
          .prepare("SELECT storage_key FROM evidence_storage_identity WHERE singleton = 1")
          .get() as { storage_key: string }
      ).storage_key;
      if (
        current.manifestDigest !== snapshot.manifestDigest ||
        evidenceSnapshotDigest(current.chunks) !== evidenceSnapshotDigest(snapshot.chunks) ||
        root.dev.toString() !== snapshot.storage.device ||
        root.ino.toString() !== snapshot.storage.inode ||
        key !== snapshot.storage.storageKey ||
        current.fileBinding.device !== snapshot.expectedFile.device ||
        current.fileBinding.inode !== snapshot.expectedFile.inode
      )
        conflict("The prepared evidence snapshot changed before finalization.");
      let renamed = row.state === "finalized";
      if (!renamed) {
        try {
          lstatSync(directory.path(`${row.id}.asset`));
          renamed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const descriptor = directory.open(row, renamed);
      try {
        if (
          !sameEvidenceIdentity(
            evidenceFileIdentity(fstatSync(descriptor, { bigint: true })),
            attestation.after,
          )
        )
          conflict("Evidence changed after verification.");
      } finally {
        closeSync(descriptor);
      }
      if (row.state === "finalized") return manifest(row);
      if (!renamed)
        renameSync(directory.path(`${row.id}.upload`), directory.path(`${row.id}.asset`));
      fsyncSync(directory.descriptor);
      db.prepare(
        "UPDATE evidence_assets SET state = 'finalized', finalized_at = ?, updated_at = ? WHERE id = ?",
      ).run(now, now, row.id);
      audit(db, row.id, "finalized", now);
      return manifest({ ...row, state: "finalized", finalized_at: now, updated_at: now });
    });
  } catch (error) {
    if (error instanceof EvidenceStorageError) throw error;
    return unavailable();
  } finally {
    directory.close();
  }
}

/** Close the bounded directory scan cursor before shutting down the SQLite owner. */
export function closeEvidenceAssetStorage(db: DatabaseSync): void {
  closeOrphanScan(db);
  initializedStorageRoots.delete(db);
}

function closeOrphanScan(db: DatabaseSync): void {
  const scan = orphanScans.get(db);
  if (scan !== undefined) {
    orphanScans.delete(db);
    scan.entries.closeSync();
  }
}

function cleanup(
  db: DatabaseSync,
  directory: PrivateDirectory,
  now: string,
  limit = 32,
): { retired: number; orphanFilesRemoved: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    invalid("Cleanup limit must be between 1 and 256.");
  return transaction(db, () => {
    const uploadBefore = new Date(
      Date.parse(now) - directory.options.incompleteUploadTtlMs,
    ).toISOString();
    const finalizedBefore = new Date(Date.parse(now) - directory.options.retentionMs).toISOString();
    const rows = db
      .prepare(`SELECT * FROM evidence_assets AS asset WHERE (state = 'uploading' AND updated_at <= ?)
      OR (state = 'finalized' AND finalized_at <= ? AND NOT EXISTS (
        SELECT 1 FROM jobs WHERE id = asset.job_id AND current_run_attempt_id = asset.run_attempt_id
          AND status IN ('leased', 'running') AND cancellation_requested_at IS NULL
      )) ORDER BY updated_at, id LIMIT ?`)
      .all(uploadBefore, finalizedBefore, limit) as unknown as AssetRow[];
    let retired = 0;
    for (const row of rows) {
      for (const suffix of ["upload", "asset"]) {
        const path = directory.path(`${row.id}.${suffix}`);
        try {
          const info = lstatSync(path, { bigint: true });
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.nlink !== 1n ||
            String(info.dev) !== row.file_device ||
            String(info.ino) !== row.file_inode
          )
            unavailable();
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      fsyncSync(directory.descriptor);
      db.prepare(
        "UPDATE evidence_assets SET state = 'retired', retired_at = ?, updated_at = ? WHERE id = ?",
      ).run(now, now, row.id);
      audit(db, row.id, "retired", now);
      retired++;
    }
    let orphanFilesRemoved = 0;
    const info = fstatSync(directory.descriptor, { bigint: true });
    const identity = `${info.dev}:${info.ino}`;
    if (orphanScans.get(db)?.identity !== identity) closeOrphanScan(db);
    let scan = orphanScans.get(db);
    if (scan === undefined) {
      scan = { identity, entries: opendirSync(`/proc/self/fd/${directory.descriptor}`) };
      orphanScans.set(db, scan);
    }
    try {
      for (let count = 0; count < limit; count++) {
        const entry = scan.entries.readSync();
        if (entry === null) {
          closeOrphanScan(db);
          break;
        }
        if (!/^[a-f0-9-]{36}\.(upload|asset)$/u.test(entry.name)) continue;
        const id = entry.name.slice(0, 36);
        if (getRow(db, id) !== undefined) continue;
        const path = directory.path(entry.name);
        let info: ReturnType<typeof lstatSync>;
        try {
          info = lstatSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          info.uid !== process.geteuid?.() ||
          (info.mode & 0o777) !== 0o600
        )
          unavailable();
        if (info.mtimeMs > Date.parse(uploadBefore)) continue;
        unlinkSync(path);
        orphanFilesRemoved++;
      }
    } catch (error) {
      closeOrphanScan(db);
      throw error;
    }
    if (orphanFilesRemoved > 0) fsyncSync(directory.descriptor);
    return { retired, orphanFilesRemoved };
  });
}
export function handleEvidenceAssetRequest(
  db: DatabaseSync,
  request: EvidenceAssetRequest,
  now: string,
  options: EvidenceStorageOptions,
): EvidenceAssetOperationMap[EvidenceAssetOperation]["output"] {
  canonicalTime(now);
  let directory: PrivateDirectory | undefined;
  try {
    directory = new PrivateDirectory(
      db,
      options,
      ["getEvidenceAsset", "listEvidenceAssets", "readEvidenceAssetChunk"].includes(
        request.operation,
      )
        ? "read"
        : "write",
    );
    switch (request.operation) {
      case "beginEvidenceUpload":
        return begin(db, directory, request.input, now);
      case "appendEvidenceChunk":
        return append(db, directory, request.input, now);
      case "finalizeEvidenceUpload":
        return finalize(db, directory, request.input, now);
      case "cleanupEvidenceAssets":
        return cleanup(db, directory, now, request.input.limit);
      case "listEvidenceAssets": {
        validScope(request.input);
        const rows = db
          .prepare(`SELECT * FROM evidence_assets WHERE repository_id = ? AND review_run_id = ? AND job_id = ? AND run_attempt_id = ?
          AND finalized_at IS NOT NULL AND state IN ('finalized', 'retired') ORDER BY created_at, id LIMIT ?`)
          .all(
            request.input.repositoryId,
            request.input.runId,
            request.input.jobId,
            request.input.runAttemptId,
            maximumAttemptEvidenceAssets,
          ) as unknown as AssetRow[];
        return { items: rows.map(manifest) };
      }
      case "getEvidenceAsset":
      case "readEvidenceAssetChunk": {
        validScope(request.input);
        const row = getRow(db, request.input.assetId);
        if (
          row === undefined ||
          !checkScope(row, request.input) ||
          row.state === "uploading" ||
          row.finalized_at === null
        ) {
          if (request.operation === "getEvidenceAsset") return null;
          throw new EvidenceStorageError(
            "EVIDENCE_NOT_FOUND",
            "Evidence asset was not found in this scope.",
          );
        }
        if (request.operation === "getEvidenceAsset") return manifest(row);
        if (row.state !== "finalized") unavailable();
        const { offset, maximumBytes = maximumEvidenceChunkBytes } = request.input;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > row.size_bytes ||
          !Number.isSafeInteger(maximumBytes) ||
          maximumBytes < 1 ||
          maximumBytes > maximumEvidenceChunkBytes
        )
          invalid("Evidence download range is invalid.");
        const fd = directory.open(row, true);
        try {
          // Every touched committed chunk is rehashed, detecting same-size content changes.
          const chunks = db
            .prepare(
              "SELECT byte_offset, size_bytes, sha256 FROM evidence_asset_chunks WHERE asset_id = ? AND byte_offset < ? AND byte_offset + size_bytes > ? ORDER BY byte_offset",
            )
            .all(row.id, Math.min(row.size_bytes, offset + maximumBytes), offset) as unknown as {
            byte_offset: number;
            size_bytes: number;
            sha256: string;
          }[];
          const bytes = Buffer.alloc(Math.min(maximumBytes, row.size_bytes - offset));
          let covered = 0;
          for (const chunk of chunks) {
            if (chunk.size_bytes < 1 || chunk.size_bytes > maximumEvidenceChunkBytes) unavailable();
            const verified = Buffer.alloc(chunk.size_bytes);
            if (
              readSync(fd, verified, 0, verified.length, chunk.byte_offset) !== verified.length ||
              hash(verified) !== chunk.sha256
            )
              unavailable();
            const start = Math.max(offset, chunk.byte_offset);
            const end = Math.min(offset + bytes.length, chunk.byte_offset + chunk.size_bytes);
            if (start !== offset + covered) unavailable();
            verified.copy(bytes, covered, start - chunk.byte_offset, end - chunk.byte_offset);
            covered += end - start;
          }
          if (covered !== bytes.length) unavailable();
          return {
            manifest: manifest(row),
            offset,
            base64: bytes.toString("base64"),
            eof: offset + bytes.length === row.size_bytes,
          };
        } finally {
          closeSync(fd);
        }
      }
    }
    return invalid("The evidence operation is unsupported.");
  } catch (error) {
    if (error instanceof EvidenceStorageError) throw error;
    // Never expose the private directory or OS error paths to a protocol caller.
    throw new EvidenceStorageError(
      "EVIDENCE_UNAVAILABLE",
      "Evidence storage could not complete the operation.",
    );
  } finally {
    directory?.close();
  }
}
