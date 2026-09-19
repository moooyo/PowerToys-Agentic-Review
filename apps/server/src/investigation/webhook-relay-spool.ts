import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WebhookRelayState = "pending" | "inflight" | "retry_wait" | "delivered" | "failed";
export type WebhookRelayAcceptance = "accepted" | "duplicate" | "ignored";
export type WebhookRelayRetryReason =
  | "receiver_available"
  | "configuration_corrected"
  | "manual_recovery";
export type WebhookRelayCode =
  | "network_error"
  | "request_timeout"
  | "receiver_retryable"
  | "receiver_rejected"
  | "retry_after_exceeds_limit"
  | "invalid_receiver_receipt"
  | "attempt_interrupted"
  | "attempts_exhausted";

export interface WebhookRelayEnvelope {
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

export interface WebhookRelayRequest extends WebhookRelayEnvelope {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly signal: AbortSignal;
}

export interface WebhookRelayResponse {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter?: string;
}

export type WebhookRelayTransport = (request: WebhookRelayRequest) => Promise<WebhookRelayResponse>;

/** A loopback-only HTTP transport. Redirects are returned without following them. */
export function createWebhookRelayTransport(receiverUrl: string): WebhookRelayTransport {
  let target: URL;
  try {
    target = new URL(receiverUrl);
  } catch {
    throw new WebhookRelaySpoolError("invalid_configuration");
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname) ||
    target.username !== "" ||
    target.password !== "" ||
    target.pathname !== "/api/github/webhook" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new WebhookRelaySpoolError("invalid_configuration");
  }
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  if (target.hostname === "localhost") target.hostname = "127.0.0.1";
  return (envelope) =>
    new Promise((resolve, reject) => {
      const outgoing = request(
        target,
        {
          method: "POST",
          signal: envelope.signal,
          headers: { ...envelope.headers, "content-length": String(envelope.body.byteLength) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          const result = (body: unknown): WebhookRelayResponse => ({
            status: response.statusCode ?? 0,
            body,
            ...(response.headers["retry-after"] === undefined
              ? {}
              : { retryAfter: response.headers["retry-after"] }),
          });
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 65_536) {
              resolve(result(null));
              response.destroy();
            } else {
              chunks.push(chunk);
            }
          });
          response.on("end", () => {
            let body: unknown = null;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            } catch {
              // A malformed receipt is handled as a terminal protocol failure by the spool.
            }
            resolve(result(body));
          });
          response.on("error", () => reject(new Error("receiver_unavailable")));
          response.on("aborted", () => reject(new Error("receiver_unavailable")));
        },
      );
      outgoing.on("error", () => reject(new Error("receiver_unavailable")));
      outgoing.end(envelope.body);
    });
}

export interface WebhookRelayAttempt {
  readonly number: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: "running" | "delivered" | "retry_wait" | "failed" | "interrupted";
  readonly responseStatus: number | null;
  readonly acceptance: WebhookRelayAcceptance | null;
  readonly code: WebhookRelayCode | null;
  readonly retryAfterMs: number | null;
  readonly nextAttemptAt: string | null;
}

export interface WebhookRelayDelivery {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly bodySha256: string;
  readonly bodyBytes: number;
  readonly receivedAt: string;
  readonly updatedAt: string;
  readonly state: WebhookRelayState;
  readonly nextAttemptAt: string | null;
  readonly code: WebhookRelayCode | null;
  readonly version: number;
  readonly attempts: readonly WebhookRelayAttempt[];
  readonly retries: readonly WebhookRelayRetry[];
}

export interface WebhookRelayRetryInput {
  readonly deliveryId: string;
  readonly expectedVersion: number;
  readonly requestId: string;
  readonly additionalAttempts?: number;
  readonly reason: WebhookRelayRetryReason;
}

export interface WebhookRelayRetry {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly version: number;
  readonly requestedAt: string;
  readonly additionalAttempts: number;
  readonly reason: WebhookRelayRetryReason;
  readonly previousCode: WebhookRelayCode | null;
}

export interface WebhookRelaySpoolOptions {
  /** Use a private directory: the database contains signed payloads and signature headers. */
  readonly databasePath: string;
  readonly maximumRecords?: number;
  readonly maximumPayloadBytes?: number;
  /** Logical admission budget, including space reserved for each record's attempt history. */
  readonly maximumStoredBytes?: number;
  /** Caps database pages, not temporary SQLite rollback journal or filesystem overhead. */
  readonly maximumDatabaseBytes?: number;
  readonly maximumAttempts?: number;
  /** The lifetime ceiling includes initial attempts and explicitly requested retry batches. */
  readonly maximumTotalAttempts?: number;
  readonly baseRetryMs?: number;
  readonly maximumRetryMs?: number;
  /** Longer receiver waits fail visibly instead of retrying early or waiting indefinitely. */
  readonly maximumRetryAfterMs?: number;
  readonly requestTimeoutMs?: number;
  readonly leaseMs?: number;
  readonly now?: () => Date;
}

export class WebhookRelaySpoolError extends Error {
  constructor(
    readonly code:
      | "invalid_configuration"
      | "invalid_envelope"
      | "identity_conflict"
      | "idempotency_conflict"
      | "version_conflict"
      | "invalid_retry"
      | "invalid_state"
      | "not_found"
      | "attempt_limit_exceeded"
      | "capacity_exceeded"
      | "storage_unavailable"
      | "unsupported_schema"
      | "spool_closed"
      | "spool_busy",
  ) {
    // Callers may safely log the code; never attach raw storage or transport errors.
    super(code);
    this.name = "WebhookRelaySpoolError";
  }
}

interface DeliveryRow {
  delivery_id: string;
  event_name: string;
  body: Uint8Array;
  headers_json: string;
  identity_hash: string;
  body_sha256: string;
  body_bytes: number;
  received_at: number;
  updated_at: number;
  state: WebhookRelayState;
  attempt_count: number;
  maximum_attempts: number;
  reserved_attempts: number;
  next_attempt_at: number | null;
  lease_expires_at: number | null;
  active_attempt_id: string | null;
  code: WebhookRelayCode | null;
  version: number;
}

interface RetryRow {
  request_id: string;
  delivery_id: string;
  request_hash: string;
  expected_version: number;
  version: number;
  requested_at: number;
  additional_attempts: number;
  reason: WebhookRelayRetryReason;
  previous_code: WebhookRelayCode | null;
}

interface AttemptRow {
  number: number;
  started_at: number;
  finished_at: number | null;
  outcome: WebhookRelayAttempt["outcome"];
  response_status: number | null;
  acceptance: WebhookRelayAcceptance | null;
  code: WebhookRelayCode | null;
  retry_after_ms: number | null;
  next_attempt_at: number | null;
}

interface ClaimedDelivery {
  row: DeliveryRow;
  attemptId: string;
  number: number;
}

const allowedHeaders = new Set([
  "content-type",
  "content-encoding",
  "x-github-delivery",
  "x-github-event",
  "x-hub-signature-256",
  "x-hub-signature",
  "x-github-hook-id",
  "x-github-hook-installation-target-id",
  "x-github-hook-installation-target-type",
  "user-agent",
]);
const deliveryPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const eventPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const contentTypePattern = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/iu;
const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const date = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WebhookRelaySpoolError("invalid_configuration");
  }
  return value;
}

/** Return a delay, not the untrusted header. HTTP dates and delta seconds are supported. */
function retryAfterMs(
  value: string | undefined,
  now: number,
  limit: number,
): number | "exceeds_limit" | null {
  if (value === undefined) return null;
  if (value.length > 128) return /^[0-9]+$/u.test(value.trim()) ? "exceeds_limit" : null;
  const normalized = value.trim();
  if (/^[0-9]+$/u.test(normalized)) {
    const milliseconds = Number(normalized) * 1_000;
    return Number.isSafeInteger(milliseconds) && milliseconds <= limit
      ? milliseconds
      : "exceeds_limit";
  }
  // Date.parse also accepts numeric strings; accept only the HTTP-date grammar here.
  if (
    !/^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u.test(
      normalized,
    )
  ) {
    return null;
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  const delay = Math.max(0, parsed - now);
  return delay <= limit ? delay : "exceeds_limit";
}

/**
 * Durable, at-least-once delivery to a receiver that deduplicates x-github-delivery.
 * No upstream redelivery API, logging, background timers, or credential loading is included.
 * FULL synchronous rollback transactions commit the raw envelope before enqueue returns.
 * The caller authenticates the source before enqueue; the receiver also verifies the signature.
 */
export class WebhookRelaySpool {
  private readonly database: DatabaseSync;
  private readonly maximumRecords: number;
  private readonly maximumPayloadBytes: number;
  private readonly maximumStoredBytes: number;
  private readonly maximumAttempts: number;
  private readonly maximumTotalAttempts: number;
  private readonly baseRetryMs: number;
  private readonly maximumRetryMs: number;
  private readonly maximumRetryAfterMs: number;
  private readonly requestTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private closed = false;
  private activeRequests = 0;

  constructor(options: WebhookRelaySpoolOptions) {
    if (!isAbsolute(options.databasePath)) {
      throw new WebhookRelaySpoolError("invalid_configuration");
    }
    this.maximumRecords = integer(options.maximumRecords ?? 1_000, 1, 100_000);
    this.maximumPayloadBytes = integer(options.maximumPayloadBytes ?? 2_097_152, 1, 33_554_432);
    this.maximumStoredBytes = integer(options.maximumStoredBytes ?? 67_108_864, 1, 4_294_967_296);
    const maximumDatabaseBytes = integer(
      options.maximumDatabaseBytes ?? 134_217_728,
      1_048_576,
      8_589_934_592,
    );
    this.maximumAttempts = integer(options.maximumAttempts ?? 6, 1, 100);
    this.maximumTotalAttempts = integer(
      options.maximumTotalAttempts ?? 100,
      this.maximumAttempts,
      10_000,
    );
    this.baseRetryMs = integer(options.baseRetryMs ?? 1_000, 1, 86_400_000);
    this.maximumRetryMs = integer(options.maximumRetryMs ?? 30_000, this.baseRetryMs, 86_400_000);
    this.maximumRetryAfterMs = integer(options.maximumRetryAfterMs ?? 86_400_000, 1, 604_800_000);
    this.requestTimeoutMs = integer(options.requestTimeoutMs ?? 20_000, 1, 300_000);
    this.leaseMs = integer(options.leaseMs ?? 30_000, this.requestTimeoutMs + 1_000, 600_000);
    this.now = options.now ?? (() => new Date());
    let database: DatabaseSync | undefined;
    try {
      mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
      const descriptor = openSync(options.databasePath, "a", 0o600);
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      database = new DatabaseSync(options.databasePath, {
        enableForeignKeyConstraints: true,
        timeout: 5_000,
      });
      database.exec(
        "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;",
      );
      const pageSize = database.prepare("PRAGMA page_size").get() as { page_size: number };
      const pageLimit = Math.floor(maximumDatabaseBytes / pageSize.page_size);
      const actualLimit = database.prepare(`PRAGMA max_page_count = ${pageLimit}`).get() as {
        max_page_count: number;
      };
      if (actualLimit.max_page_count > pageLimit) {
        throw new WebhookRelaySpoolError("capacity_exceeded");
      }
      database.exec("BEGIN IMMEDIATE;");
      const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
      if (![0, 1, 2].includes(version.user_version)) {
        throw new WebhookRelaySpoolError("unsupported_schema");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS relay_deliveries (
          delivery_id TEXT PRIMARY KEY,
          event_name TEXT NOT NULL,
          body BLOB NOT NULL,
          headers_json TEXT NOT NULL,
          identity_hash TEXT NOT NULL,
          body_sha256 TEXT NOT NULL,
          body_bytes INTEGER NOT NULL,
          reserved_bytes INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'retry_wait', 'delivered', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          maximum_attempts INTEGER NOT NULL,
          reserved_attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER,
          lease_expires_at INTEGER,
          active_attempt_id TEXT,
          code TEXT,
          version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS relay_attempts (
          delivery_id TEXT NOT NULL REFERENCES relay_deliveries(delivery_id),
          number INTEGER NOT NULL,
          attempt_id TEXT NOT NULL UNIQUE,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          outcome TEXT NOT NULL CHECK (outcome IN ('running', 'delivered', 'retry_wait', 'failed', 'interrupted')),
          response_status INTEGER,
          acceptance TEXT,
          code TEXT,
          retry_after_ms INTEGER,
          next_attempt_at INTEGER,
          PRIMARY KEY (delivery_id, number)
        );
        CREATE INDEX IF NOT EXISTS relay_due ON relay_deliveries(state, next_attempt_at);
      `);
      if (version.user_version === 1) {
        database.exec(`
          ALTER TABLE relay_deliveries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE relay_deliveries ADD COLUMN reserved_attempts INTEGER NOT NULL DEFAULT 0;
          UPDATE relay_deliveries SET reserved_attempts = maximum_attempts;
        `);
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS relay_retries (
          request_id TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL REFERENCES relay_deliveries(delivery_id),
          request_hash TEXT NOT NULL,
          expected_version INTEGER NOT NULL,
          version INTEGER NOT NULL,
          requested_at INTEGER NOT NULL,
          additional_attempts INTEGER NOT NULL,
          reason TEXT NOT NULL,
          previous_code TEXT
        );
        CREATE INDEX IF NOT EXISTS relay_retry_history ON relay_retries(delivery_id, version);
        PRAGMA user_version = 2;
        COMMIT;
      `);
      this.database = database;
    } catch (error) {
      try {
        if (database?.isTransaction) database.exec("ROLLBACK;");
      } catch {
        // Preserve the sanitized cause even if rollback also fails.
      }
      try {
        database?.close();
      } catch {
        // Closing a damaged store must not expose a native storage error.
      }
      if (error instanceof WebhookRelaySpoolError) throw error;
      throw new WebhookRelaySpoolError("storage_unavailable");
    }
  }

  private timestamp(): number {
    const value = this.now().getTime();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WebhookRelaySpoolError("invalid_configuration");
    }
    return value;
  }

  private transaction<T>(action: () => T): T {
    if (this.closed) throw new WebhookRelaySpoolError("spool_closed");
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      const result = action();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        if (this.database.isTransaction) this.database.exec("ROLLBACK;");
      } catch {
        // Do not expose native storage errors from rollback.
      }
      if (error instanceof WebhookRelaySpoolError) throw error;
      throw new WebhookRelaySpoolError("storage_unavailable");
    }
  }

  enqueue(input: WebhookRelayEnvelope): {
    readonly status: "accepted" | "duplicate";
    readonly delivery: WebhookRelayDelivery;
  } {
    if (
      !(input.body instanceof Uint8Array) ||
      input.body.length < 1 ||
      input.body.length > this.maximumPayloadBytes
    ) {
      throw new WebhookRelaySpoolError("invalid_envelope");
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const name = key.toLowerCase();
      if (
        !allowedHeaders.has(name) ||
        Object.hasOwn(headers, name) ||
        typeof value !== "string" ||
        value.length > 8_192 ||
        /[\r\n\0]/u.test(value)
      ) {
        throw new WebhookRelaySpoolError("invalid_envelope");
      }
      headers[name] = value;
    }
    const deliveryId = headers["x-github-delivery"];
    const eventName = headers["x-github-event"];
    if (
      deliveryId === undefined ||
      !deliveryPattern.test(deliveryId) ||
      eventName === undefined ||
      !eventPattern.test(eventName) ||
      !contentTypePattern.test(headers["content-type"] ?? "") ||
      !/^sha256=[a-f0-9]{64}$/u.test(headers["x-hub-signature-256"] ?? "") ||
      (headers["content-encoding"] !== undefined &&
        headers["content-encoding"].toLowerCase() !== "identity")
    ) {
      throw new WebhookRelaySpoolError("invalid_envelope");
    }
    const body = Buffer.from(input.body);
    const headersJson = JSON.stringify(
      Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))),
    );
    const bodySha256 = sha256(body);
    const identityHash = sha256(`${bodySha256}\n${headersJson}`);
    const reservedBytes =
      body.length + Buffer.byteLength(headersJson) + 4_096 + this.maximumAttempts * 2_048;
    const receivedAt = this.timestamp();
    return this.transaction(() => {
      const existing = this.row(deliveryId);
      if (existing !== undefined) {
        if (existing.identity_hash !== identityHash) {
          throw new WebhookRelaySpoolError("identity_conflict");
        }
        return { status: "duplicate", delivery: this.projection(existing) };
      }
      const usage = this.database
        .prepare(
          "SELECT COUNT(*) AS records, COALESCE(SUM(reserved_bytes), 0) AS bytes FROM relay_deliveries",
        )
        .get() as { records: number; bytes: number };
      if (
        usage.records >= this.maximumRecords ||
        usage.bytes + reservedBytes > this.maximumStoredBytes
      ) {
        throw new WebhookRelaySpoolError("capacity_exceeded");
      }
      this.database
        .prepare(`INSERT INTO relay_deliveries
        (delivery_id, event_name, body, headers_json, identity_hash, body_sha256, body_bytes,
          reserved_bytes, received_at, updated_at, state, maximum_attempts, reserved_attempts, next_attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(
          deliveryId,
          eventName,
          body,
          headersJson,
          identityHash,
          bodySha256,
          body.length,
          reservedBytes,
          receivedAt,
          receivedAt,
          this.maximumAttempts,
          this.maximumAttempts,
          receivedAt,
        );
      return { status: "accepted", delivery: this.projection(this.row(deliveryId) as DeliveryRow) };
    });
  }

  private row(deliveryId: string): DeliveryRow | undefined {
    return this.database
      .prepare("SELECT * FROM relay_deliveries WHERE delivery_id = ?")
      .get(deliveryId) as DeliveryRow | undefined;
  }

  private projection(row: DeliveryRow): WebhookRelayDelivery {
    const attempts = this.database
      .prepare("SELECT * FROM relay_attempts WHERE delivery_id = ? ORDER BY number")
      .all(row.delivery_id) as unknown as AttemptRow[];
    const retries = this.database
      .prepare("SELECT * FROM relay_retries WHERE delivery_id = ? ORDER BY version")
      .all(row.delivery_id) as unknown as RetryRow[];
    return {
      deliveryId: row.delivery_id,
      eventName: row.event_name,
      bodySha256: row.body_sha256,
      bodyBytes: row.body_bytes,
      receivedAt: date(row.received_at) as string,
      updatedAt: date(row.updated_at) as string,
      state: row.state,
      nextAttemptAt: date(row.next_attempt_at),
      code: row.code,
      version: row.version,
      retries: retries.map((retry) => this.retryProjection(retry)),
      attempts: attempts.map((attempt) => ({
        number: attempt.number,
        startedAt: date(attempt.started_at) as string,
        finishedAt: date(attempt.finished_at),
        outcome: attempt.outcome,
        responseStatus: attempt.response_status,
        acceptance: attempt.acceptance,
        code: attempt.code,
        retryAfterMs: attempt.retry_after_ms,
        nextAttemptAt: date(attempt.next_attempt_at),
      })),
    };
  }

  private retryProjection(row: RetryRow): WebhookRelayRetry {
    return {
      requestId: row.request_id,
      expectedVersion: row.expected_version,
      version: row.version,
      requestedAt: date(row.requested_at) as string,
      additionalAttempts: row.additional_attempts,
      reason: row.reason,
      previousCode: row.previous_code,
    };
  }

  /** Explicitly queue a failed delivery. This method never sends an HTTP request. */
  retryFailed(input: WebhookRelayRetryInput): {
    readonly status: "accepted" | "duplicate";
    readonly delivery: WebhookRelayDelivery;
    readonly retry: WebhookRelayRetry;
  } {
    const additionalAttempts = input.additionalAttempts ?? this.maximumAttempts;
    if (
      typeof input.deliveryId !== "string" ||
      !deliveryPattern.test(input.deliveryId) ||
      typeof input.requestId !== "string" ||
      !deliveryPattern.test(input.requestId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      !Number.isSafeInteger(additionalAttempts) ||
      additionalAttempts < 1 ||
      additionalAttempts > 100 ||
      !["receiver_available", "configuration_corrected", "manual_recovery"].includes(input.reason)
    ) {
      throw new WebhookRelaySpoolError("invalid_retry");
    }
    const now = this.timestamp();
    return this.transaction(() => {
      const existing = this.database
        .prepare("SELECT * FROM relay_retries WHERE request_id = ?")
        .get(input.requestId) as RetryRow | undefined;
      // An accepted request owns its original default even after operator configuration changes.
      const requestHash = sha256(
        JSON.stringify({
          deliveryId: input.deliveryId,
          expectedVersion: input.expectedVersion,
          additionalAttempts:
            input.additionalAttempts ?? existing?.additional_attempts ?? additionalAttempts,
          reason: input.reason,
        }),
      );
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) {
          throw new WebhookRelaySpoolError("idempotency_conflict");
        }
        return {
          status: "duplicate",
          delivery: this.projection(this.row(existing.delivery_id) as DeliveryRow),
          retry: this.retryProjection(existing),
        };
      }
      const current = this.row(input.deliveryId);
      if (current === undefined) throw new WebhookRelaySpoolError("not_found");
      if (current.version !== input.expectedVersion) {
        throw new WebhookRelaySpoolError("version_conflict");
      }
      if (current.state !== "failed") throw new WebhookRelaySpoolError("invalid_state");
      const maximumAttempts = current.attempt_count + additionalAttempts;
      if (maximumAttempts > this.maximumTotalAttempts) {
        throw new WebhookRelaySpoolError("attempt_limit_exceeded");
      }
      // Never reclaim earlier reservations or erase historical attempts/retry requests.
      const additionalBytes =
        Math.max(0, maximumAttempts - current.reserved_attempts) * 2_048 + 1_024;
      const usage = this.database
        .prepare("SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM relay_deliveries")
        .get() as { bytes: number };
      if (usage.bytes + additionalBytes > this.maximumStoredBytes) {
        throw new WebhookRelaySpoolError("capacity_exceeded");
      }
      const version = current.version + 1;
      this.database
        .prepare(`INSERT INTO relay_retries
        (request_id, delivery_id, request_hash, expected_version, version, requested_at,
          additional_attempts, reason, previous_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.requestId,
          input.deliveryId,
          requestHash,
          input.expectedVersion,
          version,
          now,
          additionalAttempts,
          input.reason,
          current.code,
        );
      this.database
        .prepare(`UPDATE relay_deliveries SET state = 'pending', updated_at = ?,
        next_attempt_at = ?, active_attempt_id = NULL, lease_expires_at = NULL, code = NULL,
        maximum_attempts = ?, reserved_attempts = ?, reserved_bytes = reserved_bytes + ?,
        version = ? WHERE delivery_id = ?`)
        .run(
          now,
          now,
          maximumAttempts,
          Math.max(current.reserved_attempts, maximumAttempts),
          additionalBytes,
          version,
          input.deliveryId,
        );
      const retry = this.database
        .prepare("SELECT * FROM relay_retries WHERE request_id = ?")
        .get(input.requestId) as unknown as RetryRow;
      return {
        status: "accepted",
        delivery: this.projection(this.row(input.deliveryId) as DeliveryRow),
        retry: this.retryProjection(retry),
      };
    });
  }

  inspect(deliveryId: string): WebhookRelayDelivery | null {
    return this.transaction(() => {
      const row = this.row(deliveryId);
      return row === undefined ? null : this.projection(row);
    });
  }

  list(
    options: {
      readonly state?: WebhookRelayState;
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): readonly WebhookRelayDelivery[] {
    const limit = integer(options.limit ?? 100, 1, 1_000);
    const offset = integer(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    return this.transaction(() => {
      const rows =
        options.state === undefined
          ? this.database
              .prepare(
                "SELECT * FROM relay_deliveries ORDER BY received_at, delivery_id LIMIT ? OFFSET ?",
              )
              .all(limit, offset)
          : this.database
              .prepare(
                "SELECT * FROM relay_deliveries WHERE state = ? ORDER BY received_at, delivery_id LIMIT ? OFFSET ?",
              )
              .all(options.state, limit, offset);
      return (rows as unknown as DeliveryRow[]).map((row) => this.projection(row));
    });
  }

  private claim(deliveryId?: string): ClaimedDelivery | WebhookRelayDelivery | null {
    const now = this.timestamp();
    return this.transaction(() => {
      const whereId = deliveryId === undefined ? "" : " AND delivery_id = ?";
      const row = this.database
        .prepare(`SELECT * FROM relay_deliveries WHERE
        ((state IN ('pending', 'retry_wait') AND next_attempt_at <= ?)
          OR (state = 'inflight' AND lease_expires_at <= ?))${whereId}
        ORDER BY received_at, delivery_id LIMIT 1`)
        .get(now, now, ...(deliveryId === undefined ? [] : [deliveryId])) as
        | DeliveryRow
        | undefined;
      if (row === undefined) return null;
      if (row.state === "inflight") {
        this.database
          .prepare(
            "UPDATE relay_attempts SET outcome = 'interrupted', finished_at = ?, code = 'attempt_interrupted' WHERE attempt_id = ? AND outcome = 'running'",
          )
          .run(now, row.active_attempt_id);
      }
      if (row.attempt_count >= row.maximum_attempts) {
        this.database
          .prepare(
            "UPDATE relay_deliveries SET state = 'failed', code = 'attempts_exhausted', updated_at = ?, next_attempt_at = NULL, active_attempt_id = NULL, lease_expires_at = NULL, version = version + 1 WHERE delivery_id = ?",
          )
          .run(now, row.delivery_id);
        return this.projection(this.row(row.delivery_id) as DeliveryRow);
      }
      const attemptId = randomUUID();
      const number = row.attempt_count + 1;
      this.database
        .prepare(
          "INSERT INTO relay_attempts (delivery_id, number, attempt_id, started_at, outcome) VALUES (?, ?, ?, ?, 'running')",
        )
        .run(row.delivery_id, number, attemptId, now);
      this.database
        .prepare(
          "UPDATE relay_deliveries SET state = 'inflight', updated_at = ?, attempt_count = ?, next_attempt_at = NULL, active_attempt_id = ?, lease_expires_at = ?, version = version + 1 WHERE delivery_id = ?",
        )
        .run(now, number, attemptId, now + this.leaseMs, row.delivery_id);
      return { row, attemptId, number };
    });
  }

  /** Process at most one due envelope. A crash after claim consumes one bounded attempt. */
  async runNext(
    transport: WebhookRelayTransport,
    deliveryId?: string,
  ): Promise<WebhookRelayDelivery | null> {
    const claimed = this.claim(deliveryId);
    if (claimed === null || !("attemptId" in claimed)) return claimed;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    this.activeRequests += 1;
    let response: WebhookRelayResponse | undefined;
    try {
      response = await Promise.race([
        Promise.resolve().then(() =>
          transport({
            deliveryId: claimed.row.delivery_id,
            eventName: claimed.row.event_name,
            body: Buffer.from(claimed.row.body),
            headers: JSON.parse(claimed.row.headers_json) as Record<string, string>,
            signal: controller.signal,
          }),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("request_timeout"));
          }, this.requestTimeoutMs);
        }),
      ]);
    } catch {
      // Transport errors may contain credentials, signed URLs, or response bodies.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.activeRequests -= 1;
    }
    const now = this.timestamp();
    const status =
      response !== undefined &&
      Number.isInteger(response.status) &&
      response.status >= 100 &&
      response.status <= 599
        ? response.status
        : null;
    const body = response?.body;
    const receipt =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const acceptance =
      status === 202 &&
      receipt?.deliveryId === claimed.row.delivery_id &&
      typeof receipt?.status === "string" &&
      ["accepted", "duplicate", "ignored"].includes(receipt.status)
        ? (receipt.status as WebhookRelayAcceptance)
        : null;
    const retryable =
      response === undefined || status === 429 || (status !== null && status >= 500);
    const receiverDelay = retryable
      ? retryAfterMs(response?.retryAfter, now, this.maximumRetryAfterMs)
      : null;
    const delayExceeded = receiverDelay === "exceeds_limit";
    const code: WebhookRelayCode | null =
      acceptance !== null
        ? null
        : delayExceeded
          ? "retry_after_exceeds_limit"
          : response === undefined
            ? timedOut
              ? "request_timeout"
              : "network_error"
            : retryable
              ? "receiver_retryable"
              : status !== null && status >= 400 && status < 500
                ? "receiver_rejected"
                : "invalid_receiver_receipt";
    const retryAfter = typeof receiverDelay === "number" ? receiverDelay : null;
    const retry =
      acceptance === null &&
      retryable &&
      !delayExceeded &&
      claimed.number < claimed.row.maximum_attempts;
    // The exponential cap never overrides the receiver's minimum Retry-After delay.
    const delay = Math.max(
      Math.min(this.maximumRetryMs, this.baseRetryMs * 2 ** (claimed.number - 1)),
      retryAfter ?? 0,
    );
    const nextAttemptAt = retry ? now + delay : null;
    const state = acceptance !== null ? "delivered" : retry ? "retry_wait" : "failed";
    return this.transaction(() => {
      const current = this.row(claimed.row.delivery_id) as DeliveryRow;
      if (current.active_attempt_id !== claimed.attemptId) return this.projection(current);
      this.database
        .prepare(
          "UPDATE relay_attempts SET finished_at = ?, outcome = ?, response_status = ?, acceptance = ?, code = ?, retry_after_ms = ?, next_attempt_at = ? WHERE attempt_id = ?",
        )
        .run(now, state, status, acceptance, code, retryAfter, nextAttemptAt, claimed.attemptId);
      this.database
        .prepare(
          "UPDATE relay_deliveries SET state = ?, updated_at = ?, next_attempt_at = ?, active_attempt_id = NULL, lease_expires_at = NULL, code = ?, version = version + 1 WHERE delivery_id = ?",
        )
        .run(
          state,
          now,
          nextAttemptAt,
          acceptance === null && retryable && !retry && !delayExceeded
            ? "attempts_exhausted"
            : code,
          claimed.row.delivery_id,
        );
      return this.projection(this.row(claimed.row.delivery_id) as DeliveryRow);
    });
  }

  close(): void {
    if (this.closed) return;
    if (this.activeRequests > 0) throw new WebhookRelaySpoolError("spool_busy");
    try {
      this.database.close();
      this.closed = true;
    } catch {
      throw new WebhookRelaySpoolError("storage_unavailable");
    }
  }
}
