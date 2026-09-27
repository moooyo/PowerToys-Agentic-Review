import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookRelayTransport,
  type WebhookRelayDelivery,
  type WebhookRelayEnvelope,
  type WebhookRelayResponse,
  WebhookRelaySpool,
  type WebhookRelaySpoolOptions,
} from "../../dist/investigation/webhook-relay-spool.js";

const directories: string[] = [];
const spools: WebhookRelaySpool[] = [];
const servers: Server[] = [];
const secret = "Synthetic relay signing secret for fixture data";
const initialTime = Date.parse("2026-09-19T00:00:00.000Z");

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const spool of spools.splice(0)) spool.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function envelope(
  id = "delivery-1",
  rawBody = '{\r\n "action": "created", "title": "Résumé"\r\n}',
): WebhookRelayEnvelope {
  const body = Buffer.from(rawBody);
  return {
    body,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-github-delivery": id,
      "x-github-event": "issue_comment",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  };
}

function fixture(options: Partial<WebhookRelaySpoolOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "relay-spool-"));
  directories.push(directory);
  const databasePath = join(directory, "private-relay.sqlite");
  let time = initialTime;
  const open = (overrides: Partial<WebhookRelaySpoolOptions> = {}) => {
    const spool = new WebhookRelaySpool({
      databasePath,
      now: () => new Date(time),
      ...options,
      ...overrides,
    });
    spools.push(spool);
    return spool;
  };
  return {
    databasePath,
    open,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

function accepted(deliveryId = "delivery-1", status = "accepted"): WebhookRelayResponse {
  return { status: 202, body: { status, deliveryId } };
}

function relayStorageSnapshot(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      deliveries: database.prepare("SELECT * FROM relay_deliveries ORDER BY delivery_id").all(),
      attempts: database.prepare("SELECT * FROM relay_attempts ORDER BY delivery_id, number").all(),
      retries: database.prepare("SELECT * FROM relay_retries ORDER BY request_id").all(),
    };
  } finally {
    database.close();
  }
}

function initialReservation(input: WebhookRelayEnvelope, maximumAttempts: number): number {
  const headers = JSON.stringify(
    Object.fromEntries(
      Object.entries(input.headers).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  return input.body.byteLength + Buffer.byteLength(headers) + 4_096 + maximumAttempts * 2_048;
}

async function failDelivery(
  spool: WebhookRelaySpool,
  deliveryId = "delivery-1",
): Promise<WebhookRelayDelivery> {
  const result = await spool.runNext(
    async () => ({ status: 401, body: "Private receiver diagnostic" }),
    deliveryId,
  );
  expect(result).toMatchObject({ deliveryId, state: "failed", code: "receiver_rejected" });
  if (result === null) throw new Error("Expected a failed fixture delivery.");
  return result;
}

function createVersionOneDatabase(databasePath: string) {
  const failed = envelope("legacy-failed", '{\r\n "legacy": true, "title": "Résumé"\r\n}');
  const delivered = envelope("legacy-delivered", '{ "legacy": "delivered" }');
  const database = new DatabaseSync(databasePath);
  try {
    // This is the original schema, not a v2 database with a downgraded user_version.
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE relay_deliveries (
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
        next_attempt_at INTEGER,
        lease_expires_at INTEGER,
        active_attempt_id TEXT,
        code TEXT
      );
      CREATE TABLE relay_attempts (
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
      CREATE INDEX relay_due ON relay_deliveries(state, next_attempt_at);
      PRAGMA user_version = 1;
      COMMIT;
    `);
    for (const [input, state] of [
      [failed, "failed"],
      [delivered, "delivered"],
    ] as const) {
      const body = Buffer.from(input.body);
      const headers = JSON.stringify(
        Object.fromEntries(
          Object.entries(input.headers).sort(([left], [right]) => left.localeCompare(right)),
        ),
      );
      const digest = createHash("sha256").update(body).digest("hex");
      const identity = createHash("sha256").update(`${digest}\n${headers}`).digest("hex");
      const deliveryId = input.headers["x-github-delivery"] as string;
      database
        .prepare(`INSERT INTO relay_deliveries
        (delivery_id, event_name, body, headers_json, identity_hash, body_sha256, body_bytes,
          reserved_bytes, received_at, updated_at, state, attempt_count, maximum_attempts,
          next_attempt_at, lease_expires_at, active_attempt_id, code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, NULL, NULL, ?)`)
        .run(
          deliveryId,
          "issue_comment",
          body,
          headers,
          identity,
          digest,
          body.byteLength,
          initialReservation(input, 1),
          initialTime,
          initialTime + 1,
          state,
          state === "failed" ? "receiver_rejected" : null,
        );
      database
        .prepare(`INSERT INTO relay_attempts
        (delivery_id, number, attempt_id, started_at, finished_at, outcome, response_status,
          acceptance, code, retry_after_ms, next_attempt_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .run(
          deliveryId,
          `legacy-attempt-${deliveryId}`,
          initialTime,
          initialTime + 1,
          state,
          state === "failed" ? 401 : 202,
          state === "failed" ? null : "accepted",
          state === "failed" ? "receiver_rejected" : null,
        );
    }
    return {
      failed,
      delivered,
      deliveries: database.prepare("SELECT * FROM relay_deliveries ORDER BY delivery_id").all(),
      attempts: database.prepare("SELECT * FROM relay_attempts ORDER BY delivery_id, number").all(),
    };
  } finally {
    database.close();
  }
}

async function receiver(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port.");
  return `http://127.0.0.1:${address.port}/api/github/webhook`;
}

describe("durable webhook relay spool", () => {
  it("persists exact signed bytes before returning and recovers them after restart", async () => {
    const test = fixture();
    const first = test.open();
    const input = envelope();
    const expected = Buffer.from(input.body);
    expect(first.enqueue(input)).toMatchObject({
      status: "accepted",
      delivery: { state: "pending" },
    });
    input.body.fill(0);
    first.close();
    const reopened = test.open();
    const transport = vi.fn(async (request) => {
      expect(Buffer.from(request.body)).toEqual(expected);
      expect(request.headers).toEqual(input.headers);
      return accepted();
    });
    expect(await reopened.runNext(transport)).toMatchObject({
      state: "delivered",
      attempts: [{ number: 1, outcome: "delivered", acceptance: "accepted" }],
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("deduplicates at capacity and rejects changed bytes, event names, or signatures", () => {
    const spool = fixture({ maximumRecords: 1 }).open();
    spool.enqueue(envelope());
    expect(spool.enqueue(envelope()).status).toBe("duplicate");
    expect(() => spool.enqueue(envelope("delivery-2"))).toThrow("capacity_exceeded");
    expect(() => spool.enqueue(envelope("delivery-1", "{}"))).toThrow("identity_conflict");
    for (const headers of [
      { "x-github-event": "issues" },
      { "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    ]) {
      const original = envelope();
      expect(() =>
        spool.enqueue({ ...original, headers: { ...original.headers, ...headers } }),
      ).toThrow("identity_conflict");
    }
    expect(spool.list()).toHaveLength(1);
  });

  it("normalizes header names without changing their values or duplicate identity", () => {
    const spool = fixture().open();
    const input = envelope();
    spool.enqueue(input);
    expect(
      spool.enqueue({
        ...input,
        headers: Object.fromEntries(
          Object.entries(input.headers)
            .reverse()
            .map(([key, value]) => [key.toUpperCase(), value]),
        ),
      }).status,
    ).toBe("duplicate");
  });

  it.each(["accepted", "duplicate", "ignored"])(
    "requires the receiver's durable %s receipt",
    async (status) => {
      const spool = fixture().open();
      spool.enqueue(envelope());
      expect(await spool.runNext(async () => accepted("delivery-1", status))).toMatchObject({
        state: "delivered",
        attempts: [{ acceptance: status }],
      });
      expect(
        await spool.runNext(async () => {
          throw new Error("must not replay terminal receipt");
        }),
      ).toBeNull();
    },
  );

  it.each([
    { status: 202, body: { status: "accepted", deliveryId: "different-delivery" } },
    { status: 202, body: { status: "queued", deliveryId: "delivery-1" } },
    { status: 202, body: { status: ["accepted"], deliveryId: "delivery-1" } },
    { status: 202, body: { status: { value: "accepted" }, deliveryId: "delivery-1" } },
    { status: 202, body: null },
    { status: 200, body: { status: "accepted", deliveryId: "delivery-1" } },
    { status: 204, body: null },
    { status: 302, body: null },
  ])("rejects an unconfirmed successful-looking response: $status", async (response) => {
    const spool = fixture().open();
    spool.enqueue(envelope());
    expect(await spool.runNext(async () => response)).toMatchObject({
      state: "failed",
      code: "invalid_receiver_receipt",
    });
  });

  it.each([400, 401, 403, 404, 408, 409, 413, 422])(
    "retains permanent HTTP %s rejection without retry",
    async (status) => {
      const spool = fixture().open();
      spool.enqueue(envelope());
      expect(
        await spool.runNext(async () => ({ status, body: "private receiver detail" })),
      ).toMatchObject({
        state: "failed",
        code: "receiver_rejected",
        attempts: [{ responseStatus: status }],
      });
      expect(await spool.runNext(async () => accepted())).toBeNull();
    },
  );

  it("retries network, throttling, and server failures with preserved bounded history", async () => {
    const test = fixture({ maximumAttempts: 3 });
    let spool = test.open();
    spool.enqueue(envelope());
    expect(
      await spool.runNext(async () => {
        throw new Error("SECRET wss://private.socket/token");
      }),
    ).toMatchObject({
      state: "retry_wait",
      attempts: [{ code: "network_error", nextAttemptAt: "2026-09-19T00:00:01.000Z" }],
    });
    expect(await spool.runNext(async () => accepted())).toBeNull();
    spool.close();
    spool = test.open();
    test.advance(1_000);
    expect(
      await spool.runNext(async () => ({ status: 429, body: null, retryAfter: "60" })),
    ).toMatchObject({
      state: "retry_wait",
      nextAttemptAt: "2026-09-19T00:01:01.000Z",
    });
    test.advance(59_999);
    expect(await spool.runNext(async () => accepted())).toBeNull();
    test.advance(1);
    const result = await spool.runNext(async () => ({ status: 503, body: null }));
    expect(result).toMatchObject({ state: "failed", code: "attempts_exhausted" });
    expect(result?.attempts.map((attempt) => attempt.code)).toEqual([
      "network_error",
      "receiver_retryable",
      "receiver_retryable",
    ]);
    expect(await spool.runNext(async () => accepted())).toBeNull();
    expect(JSON.stringify(spool.list())).not.toMatch(
      /SECRET|private\.socket|signature|headers|Résumé/u,
    );
  });

  it("honors HTTP-date Retry-After without replacing it with the exponential cap", async () => {
    const test = fixture({ maximumRetryMs: 2_000 });
    const spool = test.open();
    spool.enqueue(envelope());
    expect(
      await spool.runNext(async () => ({
        status: 503,
        body: null,
        retryAfter: "Sat, 19 Sep 2026 00:05:00 GMT",
      })),
    ).toMatchObject({
      state: "retry_wait",
      nextAttemptAt: "2026-09-19T00:05:00.000Z",
      attempts: [{ retryAfterMs: 300_000 }],
    });
  });

  it.each(["-1", "bad", "1.5", "Sat, 19 Sep 2026 00:00:00 GMT"])(
    "safely handles unusable or elapsed Retry-After %s",
    async (retryAfter) => {
      const spool = fixture().open();
      spool.enqueue(envelope());
      expect(
        await spool.runNext(async () => ({ status: 429, body: null, retryAfter })),
      ).toMatchObject({
        nextAttemptAt: "2026-09-19T00:00:01.000Z",
      });
    },
  );

  it.each(["86401", "999999999999999999999999999999", "Tue, 01 Jan 2030 00:00:00 GMT"])(
    "fails visibly when Retry-After exceeds its waiting budget: %s",
    async (retryAfter) => {
      const spool = fixture().open();
      spool.enqueue(envelope());
      expect(
        await spool.runNext(async () => ({ status: 429, body: null, retryAfter })),
      ).toMatchObject({
        state: "failed",
        code: "retry_after_exceeds_limit",
        nextAttemptAt: null,
      });
    },
  );

  it("recovers an interrupted durable attempt after lease expiry and fences the late owner", async () => {
    const test = fixture();
    const first = test.open();
    const second = test.open();
    first.enqueue(envelope());
    let release: (value: WebhookRelayResponse) => void = () => {
      throw new Error("Missing request.");
    };
    const firstRun = first.runNext(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    expect(second.inspect("delivery-1")).toMatchObject({
      state: "inflight",
      attempts: [{ outcome: "running" }],
    });
    expect(await second.runNext(async () => accepted())).toBeNull();
    test.advance(30_000);
    expect(await second.runNext(async () => accepted("delivery-1", "duplicate"))).toMatchObject({
      state: "delivered",
      attempts: [
        { number: 1, outcome: "interrupted", code: "attempt_interrupted" },
        { number: 2, outcome: "delivered", acceptance: "duplicate" },
      ],
    });
    release({ status: 401, body: null });
    expect(await firstRun).toMatchObject({ state: "delivered" });
    expect(first.inspect("delivery-1")?.attempts).toHaveLength(2);
  });

  it("consumes interrupted claims without endlessly renewing the attempt budget", async () => {
    const test = fixture({ maximumAttempts: 1 });
    const spool = test.open();
    spool.enqueue(envelope());
    spool.close();
    const database = new DatabaseSync(test.databasePath);
    database.exec(`BEGIN IMMEDIATE;
      INSERT INTO relay_attempts (delivery_id, number, attempt_id, started_at, outcome)
        VALUES ('delivery-1', 1, 'interrupted-attempt', ${initialTime}, 'running');
      UPDATE relay_deliveries SET state = 'inflight', attempt_count = 1,
        active_attempt_id = 'interrupted-attempt', lease_expires_at = ${initialTime + 30_000};
      COMMIT;`);
    database.close();
    const reopened = test.open();
    test.advance(30_000);
    const transport = vi.fn(async () => accepted());
    expect(await reopened.runNext(transport)).toMatchObject({
      state: "failed",
      code: "attempts_exhausted",
      attempts: [{ outcome: "interrupted" }],
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not send when the attempt transaction cannot commit", async () => {
    const test = fixture();
    const spool = test.open();
    spool.enqueue(envelope());
    const database = new DatabaseSync(test.databasePath);
    database.exec(
      "CREATE TRIGGER reject_claim BEFORE INSERT ON relay_attempts BEGIN SELECT RAISE(ABORT, 'private storage diagnostic'); END;",
    );
    const transport = vi.fn(async () => accepted());
    await expect(spool.runNext(transport)).rejects.toThrow("storage_unavailable");
    expect(transport).not.toHaveBeenCalled();
    expect(spool.inspect("delivery-1")).toMatchObject({ state: "pending", attempts: [] });
    database.exec("DROP TRIGGER reject_claim;");
    database.close();
    expect(await spool.runNext(transport)).toMatchObject({ state: "delivered" });
  });

  it("replays with the same identity after receiver success but failed result persistence", async () => {
    const test = fixture();
    const spool = test.open();
    spool.enqueue(envelope());
    const database = new DatabaseSync(test.databasePath);
    database.exec(
      "CREATE TRIGGER reject_finish BEFORE UPDATE ON relay_attempts BEGIN SELECT RAISE(ABORT, 'private storage diagnostic'); END;",
    );
    await expect(spool.runNext(async () => accepted())).rejects.toThrow("storage_unavailable");
    expect(spool.inspect("delivery-1")).toMatchObject({
      state: "inflight",
      attempts: [{ outcome: "running" }],
    });
    database.exec("DROP TRIGGER reject_finish;");
    database.close();
    spool.close();
    test.advance(30_000);
    const reopened = test.open();
    const transport = vi.fn(async (request) => {
      expect(request.deliveryId).toBe("delivery-1");
      expect(Buffer.from(request.body)).toEqual(Buffer.from(envelope().body));
      return accepted("delivery-1", "duplicate");
    });
    expect(await reopened.runNext(transport)).toMatchObject({
      state: "delivered",
      attempts: [{ outcome: "interrupted" }, { acceptance: "duplicate" }],
    });
    reopened.close();
    expect(await test.open().runNext(transport)).toBeNull();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects unsafe envelopes and reserves history capacity without evicting terminal records", async () => {
    const spool = fixture({ maximumRecords: 1 }).open();
    const input = envelope();
    for (const headers of [
      { ...input.headers, authorization: "Bearer private" },
      { ...input.headers, "X-GitHub-Delivery": "delivery-1" },
      { ...input.headers, "user-agent": "injected\r\nheader" },
      { ...input.headers, "content-encoding": "gzip" },
    ])
      expect(() => spool.enqueue({ ...input, headers })).toThrow("invalid_envelope");
    spool.enqueue(input);
    await spool.runNext(async () => accepted());
    expect(() => spool.enqueue(envelope("delivery-2"))).toThrow("capacity_exceeded");
    expect(spool.enqueue(input).delivery.state).toBe("delivered");
    const full = fixture({ maximumStoredBytes: 1 }).open();
    expect(() => full.enqueue(input)).toThrow("capacity_exceeded");
  });

  it("rolls back an admission that exceeds database page capacity", () => {
    const spool = fixture({
      maximumDatabaseBytes: 1_048_576,
      maximumPayloadBytes: 4_194_304,
    }).open();
    expect(() =>
      spool.enqueue(envelope("delivery-large", JSON.stringify({ data: "x".repeat(2_097_152) }))),
    ).toThrow("storage_unavailable");
    expect(spool.list()).toEqual([]);
    expect(spool.enqueue(envelope()).status).toBe("accepted");
  });

  it("rejects reopening an existing database above a reduced capacity limit", () => {
    const test = fixture({ maximumPayloadBytes: 4_194_304 });
    const spool = test.open();
    spool.enqueue(envelope("delivery-large", JSON.stringify({ data: "x".repeat(2_097_152) })));
    spool.close();
    expect(
      () =>
        new WebhookRelaySpool({ databasePath: test.databasePath, maximumDatabaseBytes: 1_048_576 }),
    ).toThrow("capacity_exceeded");
    expect(test.open().inspect("delivery-large")).toMatchObject({ state: "pending" });
  });

  it("processes another due delivery while an older delivery waits for retry", async () => {
    const spool = fixture().open();
    spool.enqueue(envelope("delivery-1"));
    spool.enqueue(envelope("delivery-2"));
    await spool.runNext(async () => ({ status: 503, body: null }));
    expect(await spool.runNext(async (request) => accepted(request.deliveryId))).toMatchObject({
      deliveryId: "delivery-2",
      state: "delivered",
    });
  });
});

describe("explicit webhook relay recovery", () => {
  it("preserves signed bytes and appends attempts and recovery history across restart", async () => {
    const test = fixture({ maximumAttempts: 1, maximumTotalAttempts: 5 });
    let spool = test.open();
    const input = envelope();
    const originalBody = Buffer.from(input.body);
    const originalHeaders = { ...input.headers };
    expect(spool.enqueue(input).delivery).toMatchObject({ version: 1, retries: [] });
    input.body.fill(0);
    const failed = await spool.runNext(async () => {
      throw new Error("SECRET wss://private.socket/token");
    });
    expect(failed).toMatchObject({ state: "failed", code: "attempts_exhausted" });
    if (failed === null) throw new Error("Expected a failed fixture delivery.");
    const request = {
      deliveryId: "delivery-1",
      expectedVersion: failed.version,
      requestId: "manual-recovery.1",
      additionalAttempts: 2,
      reason: "receiver_available" as const,
    };
    const recovery = spool.retryFailed(request);
    expect(recovery.status).toBe("accepted");
    expect(recovery.delivery).toMatchObject({
      state: "pending",
      code: null,
      nextAttemptAt: "2026-09-19T00:00:00.000Z",
      attempts: failed.attempts,
      retries: [recovery.retry],
    });
    expect(recovery.retry).toEqual({
      requestId: request.requestId,
      expectedVersion: failed.version,
      version: recovery.delivery.version,
      requestedAt: "2026-09-19T00:00:00.000Z",
      additionalAttempts: 2,
      reason: "receiver_available",
      previousCode: "attempts_exhausted",
    });
    expect(recovery.delivery.version).toBeGreaterThan(failed.version);
    const transport = vi.fn(async (forwarded) => {
      expect(Buffer.from(forwarded.body)).toEqual(originalBody);
      expect(forwarded.headers).toEqual(originalHeaders);
      return { status: 503, body: null };
    });
    expect(await spool.runNext(transport)).toMatchObject({
      state: "retry_wait",
      attempts: [{ number: 1 }, { number: 2 }],
      retries: [recovery.retry],
    });
    spool.close();
    test.advance(30_000);
    spool = test.open();
    const delivered = await spool.runNext(async (forwarded) => {
      expect(Buffer.from(forwarded.body)).toEqual(originalBody);
      expect(forwarded.headers).toEqual(originalHeaders);
      return accepted();
    });
    expect(delivered).toMatchObject({
      state: "delivered",
      attempts: [
        { number: 1, outcome: "failed" },
        { number: 2, outcome: "retry_wait" },
        { number: 3, outcome: "delivered" },
      ],
      retries: [recovery.retry],
    });
    const snapshot = relayStorageSnapshot(test.databasePath);
    expect(spool.retryFailed(request)).toEqual({
      status: "duplicate",
      delivery: delivered,
      retry: recovery.retry,
    });
    expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    spool.close();
    spool = test.open();
    const mustNotSend = vi.fn(async () => accepted());
    expect(await spool.runNext(mustNotSend)).toBeNull();
    expect(mustNotSend).not.toHaveBeenCalled();
    expect(spool.retryFailed(request).status).toBe("duplicate");
    expect(JSON.stringify(spool.list())).not.toMatch(
      /SECRET|private\.socket|Private receiver diagnostic|signature|headers|Résumé/u,
    );
  });

  it("freezes a default recovery budget for idempotent replay after configuration changes", async () => {
    const test = fixture({ maximumAttempts: 2 });
    let spool = test.open();
    spool.enqueue(envelope());
    const failed = await failDelivery(spool);
    const request = {
      deliveryId: "delivery-1",
      expectedVersion: failed.version,
      requestId: "default-budget",
      reason: "configuration_corrected" as const,
    };
    const recovery = spool.retryFailed(request);
    expect(recovery.retry.additionalAttempts).toBe(2);
    spool.close();
    spool = test.open({ maximumAttempts: 3 });
    const snapshot = relayStorageSnapshot(test.databasePath);
    expect(spool.retryFailed(request)).toMatchObject({
      status: "duplicate",
      retry: recovery.retry,
    });
    expect(spool.retryFailed({ ...request, additionalAttempts: 2 })).toMatchObject({
      status: "duplicate",
      retry: recovery.retry,
    });
    expect(() => spool.retryFailed({ ...request, additionalAttempts: 3 })).toThrow(
      "idempotency_conflict",
    );
    expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    const failedAgain = await failDelivery(spool);
    expect(
      spool.retryFailed({
        ...request,
        requestId: "new-default-budget",
        expectedVersion: failedAgain.version,
      }).retry.additionalAttempts,
    ).toBe(3);
  });

  it.each([
    { expectedVersion: 0 },
    { expectedVersion: 1.5 },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { requestId: "" },
    { requestId: "x".repeat(129) },
    { requestId: "request\nprivate" },
    { requestId: "récupération" },
    { additionalAttempts: 0 },
    { additionalAttempts: 101 },
    { additionalAttempts: 1.5 },
    { reason: "SECRET https://private.example/token" },
    { reason: "configuration-corrected" },
  ])("rejects invalid recovery input without changing stored state: %j", async (changes) => {
    const test = fixture({ maximumAttempts: 1 });
    const spool = test.open();
    spool.enqueue(envelope());
    const failed = await failDelivery(spool);
    const snapshot = relayStorageSnapshot(test.databasePath);
    const input = {
      deliveryId: "delivery-1",
      expectedVersion: failed.version,
      requestId: "valid-request",
      additionalAttempts: 1,
      reason: "manual_recovery",
      ...changes,
    } as Parameters<WebhookRelaySpool["retryFailed"]>[0];
    expect(() => spool.retryFailed(input)).toThrow(/^invalid_retry$/u);
    expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
  });

  it.each(["pending", "retry_wait", "delivered"] as const)(
    "does not recover a %s delivery",
    async (state) => {
      const test = fixture();
      const spool = test.open();
      spool.enqueue(envelope());
      if (state === "retry_wait") await spool.runNext(async () => ({ status: 503, body: null }));
      if (state === "delivered") await spool.runNext(async () => accepted());
      const current = spool.inspect("delivery-1");
      expect(current?.state).toBe(state);
      const snapshot = relayStorageSnapshot(test.databasePath);
      expect(() =>
        spool.retryFailed({
          deliveryId: "delivery-1",
          expectedVersion: current?.version ?? 1,
          requestId: `invalid-state-${state}`,
          reason: "manual_recovery",
        }),
      ).toThrow("invalid_state");
      expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    },
  );

  it("does not interrupt an inflight owner when recovery is requested", async () => {
    const test = fixture();
    const spool = test.open();
    spool.enqueue(envelope());
    let release: (response: WebhookRelayResponse) => void = () => {
      throw new Error("Missing fixture request.");
    };
    const running = spool.runNext(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    try {
      const current = spool.inspect("delivery-1");
      expect(current?.state).toBe("inflight");
      const snapshot = relayStorageSnapshot(test.databasePath);
      expect(() =>
        spool.retryFailed({
          deliveryId: "delivery-1",
          expectedVersion: current?.version ?? 1,
          requestId: "inflight-recovery",
          reason: "manual_recovery",
        }),
      ).toThrow("invalid_state");
      expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    } finally {
      release(accepted());
      await running;
    }
    expect(spool.inspect("delivery-1")?.state).toBe("delivered");
  });

  it("reports a missing delivery without reserving an idempotency key", async () => {
    const spool = fixture({ maximumAttempts: 1 }).open();
    const request = {
      deliveryId: "delivery-1",
      expectedVersion: 1,
      requestId: "missing-delivery",
      reason: "manual_recovery" as const,
    };
    expect(() => spool.retryFailed(request)).toThrow("not_found");
    spool.enqueue(envelope());
    const failed = await failDelivery(spool);
    expect(spool.retryFailed({ ...request, expectedVersion: failed.version }).status).toBe(
      "accepted",
    );
  });

  it("serializes owners and checks global idempotency before stale versions or missing targets", async () => {
    const test = fixture({ maximumAttempts: 1 });
    const first = test.open();
    const second = test.open();
    first.enqueue(envelope());
    const failed = await failDelivery(first);
    const request = {
      deliveryId: "delivery-1",
      expectedVersion: failed.version,
      requestId: "shared-recovery",
      additionalAttempts: 2,
      reason: "receiver_available" as const,
    };
    const recovery = first.retryFailed(request);
    const snapshot = relayStorageSnapshot(test.databasePath);
    expect(second.retryFailed(request)).toEqual({ ...recovery, status: "duplicate" });
    expect(() => second.retryFailed({ ...request, requestId: "other-owner" })).toThrow(
      "version_conflict",
    );
    for (const changes of [
      { deliveryId: "missing-delivery" },
      { expectedVersion: recovery.delivery.version },
      { additionalAttempts: 1 },
      { reason: "manual_recovery" as const },
    ]) {
      expect(() => second.retryFailed({ ...request, ...changes })).toThrow("idempotency_conflict");
    }
    expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    expect(second.inspect("delivery-1")?.retries).toHaveLength(1);
  });

  it("returns an older accepted recovery after a later recovery without changing its budget", async () => {
    const test = fixture({ maximumAttempts: 1 });
    const spool = test.open();
    spool.enqueue(envelope());
    const failed = await failDelivery(spool);
    const firstRequest = {
      deliveryId: "delivery-1",
      expectedVersion: failed.version,
      requestId: "recovery-a",
      additionalAttempts: 2,
      reason: "receiver_available" as const,
    };
    const first = spool.retryFailed(firstRequest);
    const failedAgain = await failDelivery(spool);
    const second = spool.retryFailed({
      ...firstRequest,
      expectedVersion: failedAgain.version,
      requestId: "recovery-b",
      additionalAttempts: 1,
    });
    const snapshot = relayStorageSnapshot(test.databasePath);
    expect(spool.retryFailed(firstRequest)).toEqual({
      status: "duplicate",
      delivery: second.delivery,
      retry: first.retry,
    });
    expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    expect(second.delivery.retries).toEqual([first.retry, second.retry]);
    expect(second.delivery.attempts.map((attempt) => attempt.number)).toEqual([1, 2]);
  });

  it("fences a late owner after an interrupted final attempt is manually recovered", async () => {
    const test = fixture({ maximumAttempts: 1 });
    const first = test.open();
    const second = test.open();
    first.enqueue(envelope());
    let release: (response: WebhookRelayResponse) => void = () => {
      throw new Error("Missing fixture request.");
    };
    const running = first.runNext(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    try {
      test.advance(30_000);
      const mustNotSend = vi.fn(async () => accepted());
      const exhausted = await second.runNext(mustNotSend);
      expect(exhausted).toMatchObject({
        state: "failed",
        code: "attempts_exhausted",
        attempts: [{ outcome: "interrupted" }],
      });
      expect(mustNotSend).not.toHaveBeenCalled();
      const recovery = second.retryFailed({
        deliveryId: "delivery-1",
        expectedVersion: exhausted?.version ?? 1,
        requestId: "recover-interrupted-owner",
        additionalAttempts: 1,
        reason: "manual_recovery",
      });
      const snapshot = relayStorageSnapshot(test.databasePath);
      release(accepted());
      expect(await running).toEqual(recovery.delivery);
      expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
      expect(await second.runNext(async () => accepted("delivery-1", "duplicate"))).toMatchObject({
        state: "delivered",
        retries: [recovery.retry],
        attempts: [
          { number: 1, outcome: "interrupted" },
          { number: 2, outcome: "delivered" },
        ],
      });
    } finally {
      release(accepted());
      await running;
    }
  });

  it("enforces the lifetime ceiling without resetting previously consumed attempts", async () => {
    const test = fixture({ maximumAttempts: 1, maximumTotalAttempts: 3 });
    const spool = test.open();
    spool.enqueue(envelope());
    const initialFailure = await failDelivery(spool);
    spool.retryFailed({
      deliveryId: "delivery-1",
      expectedVersion: initialFailure.version,
      requestId: "remaining-two",
      additionalAttempts: 2,
      reason: "manual_recovery",
    });
    const secondFailure = await failDelivery(spool);
    const request = {
      deliveryId: "delivery-1",
      expectedVersion: secondFailure.version,
      requestId: "remaining-one",
      additionalAttempts: 2,
      reason: "manual_recovery" as const,
    };
    const snapshot = relayStorageSnapshot(test.databasePath);
    expect(() => spool.retryFailed(request)).toThrow("attempt_limit_exceeded");
    expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    expect(spool.retryFailed({ ...request, additionalAttempts: 1 }).status).toBe("accepted");
    const exhausted = await spool.runNext(async () => ({ status: 503, body: null }));
    expect(exhausted).toMatchObject({ state: "failed", code: "attempts_exhausted" });
    expect(exhausted?.attempts.map((attempt) => attempt.number)).toEqual([1, 2, 3]);
    expect(() =>
      spool.retryFailed({
        ...request,
        requestId: "beyond-lifetime",
        expectedVersion: exhausted?.version ?? 1,
        additionalAttempts: 1,
      }),
    ).toThrow("attempt_limit_exceeded");
    expect(spool.inspect("delivery-1")?.retries).toHaveLength(2);
  });

  it("uses a default lifetime ceiling of one hundred attempts", async () => {
    const spool = fixture({ maximumAttempts: 100 }).open();
    spool.enqueue(envelope());
    const failed = await failDelivery(spool);
    expect(() =>
      spool.retryFailed({
        deliveryId: "delivery-1",
        expectedVersion: failed.version,
        requestId: "default-lifetime-limit",
        additionalAttempts: 100,
        reason: "manual_recovery",
      }),
    ).toThrow("attempt_limit_exceeded");
    expect(
      spool.retryFailed({
        deliveryId: "delivery-1",
        expectedVersion: failed.version,
        requestId: "remaining-default-budget",
        additionalAttempts: 99,
        reason: "manual_recovery",
      }).status,
    ).toBe("accepted");
  });

  it.each([0, 1.5, 10_001])(
    "rejects an invalid lifetime attempt limit: %s",
    (maximumTotalAttempts) => {
      expect(() => fixture({ maximumAttempts: 1, maximumTotalAttempts }).open()).toThrow(
        "invalid_configuration",
      );
    },
  );

  it("allows the documented lifetime bounds and rejects an initial budget above its ceiling", () => {
    expect(fixture({ maximumAttempts: 1, maximumTotalAttempts: 1 }).open().list()).toEqual([]);
    expect(fixture({ maximumTotalAttempts: 10_000 }).open().list()).toEqual([]);
    expect(() => fixture({ maximumAttempts: 2, maximumTotalAttempts: 1 }).open()).toThrow(
      "invalid_configuration",
    );
  });

  it("keeps attempt reservation at its high-water mark across shorter recovery batches", async () => {
    const test = fixture({ maximumAttempts: 6, maximumTotalAttempts: 20 });
    const spool = test.open();
    spool.enqueue(envelope());
    const initial = relayStorageSnapshot(test.databasePath).deliveries[0];
    const failed = await failDelivery(spool);
    spool.retryFailed({
      deliveryId: "delivery-1",
      expectedVersion: failed.version,
      requestId: "short-batch",
      additionalAttempts: 1,
      reason: "manual_recovery",
    });
    const shorter = relayStorageSnapshot(test.databasePath).deliveries[0];
    expect(shorter).toMatchObject({ maximum_attempts: 2, reserved_attempts: 6 });
    expect(shorter?.reserved_bytes).toBe(Number(initial?.reserved_bytes) + 1_024);
    const failedAgain = await failDelivery(spool);
    spool.retryFailed({
      deliveryId: "delivery-1",
      expectedVersion: failedAgain.version,
      requestId: "longer-batch",
      additionalAttempts: 5,
      reason: "manual_recovery",
    });
    const longer = relayStorageSnapshot(test.databasePath).deliveries[0];
    expect(longer).toMatchObject({ maximum_attempts: 7, reserved_attempts: 7, attempt_count: 2 });
    expect(longer?.reserved_bytes).toBe(Number(shorter?.reserved_bytes) + 2_048 + 1_024);
    expect(spool.inspect("delivery-1")?.retries).toHaveLength(2);
  });

  it.each([3_071, 3_072])(
    "reserves new attempt and recovery history atomically at the %s-byte boundary",
    async (headroom) => {
      const input = envelope();
      const test = fixture({
        maximumAttempts: 1,
        maximumStoredBytes: initialReservation(input, 1) + headroom,
      });
      const spool = test.open();
      spool.enqueue(input);
      const failed = await failDelivery(spool);
      const request = {
        deliveryId: "delivery-1",
        expectedVersion: failed.version,
        requestId: "capacity-boundary",
        additionalAttempts: 1,
        reason: "manual_recovery" as const,
      };
      const snapshot = relayStorageSnapshot(test.databasePath);
      if (headroom === 3_071) {
        expect(() => spool.retryFailed(request)).toThrow("capacity_exceeded");
        expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
      } else {
        const recovery = spool.retryFailed(request);
        expect(recovery.status).toBe("accepted");
        expect(relayStorageSnapshot(test.databasePath).deliveries[0]?.reserved_bytes).toBe(
          initialReservation(input, 1) + 3_072,
        );
        expect(spool.retryFailed(request)).toEqual({ ...recovery, status: "duplicate" });
      }
    },
  );

  it("does not silently prune another terminal record to make room for recovery", async () => {
    const input = envelope();
    const other = envelope("delivery-2");
    const test = fixture({
      maximumAttempts: 1,
      maximumRecords: 2,
      maximumStoredBytes: initialReservation(input, 1) + initialReservation(other, 1) + 3_071,
    });
    const spool = test.open();
    spool.enqueue(input);
    spool.enqueue(other);
    const failed = await failDelivery(spool);
    await spool.runNext(async () => accepted("delivery-2"), "delivery-2");
    const snapshot = relayStorageSnapshot(test.databasePath);
    expect(() =>
      spool.retryFailed({
        deliveryId: "delivery-1",
        expectedVersion: failed.version,
        requestId: "must-not-prune",
        additionalAttempts: 1,
        reason: "manual_recovery",
      }),
    ).toThrow("capacity_exceeded");
    expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    expect(spool.list().map((delivery) => delivery.state)).toEqual(["failed", "delivered"]);
  });

  it.each([
    "BEFORE INSERT ON relay_retries",
    "BEFORE UPDATE ON relay_deliveries WHEN OLD.state = 'failed' AND NEW.state = 'pending'",
  ])("rolls back every recovery mutation when storage rejects %s", async (triggerEvent) => {
    const input = envelope();
    const test = fixture({
      maximumAttempts: 1,
      maximumStoredBytes: initialReservation(input, 1) + 3_072,
    });
    const spool = test.open();
    spool.enqueue(input);
    const failed = await failDelivery(spool);
    const request = {
      deliveryId: "delivery-1",
      expectedVersion: failed.version,
      requestId: "rollback-recovery",
      additionalAttempts: 1,
      reason: "configuration_corrected" as const,
    };
    const snapshot = relayStorageSnapshot(test.databasePath);
    const database = new DatabaseSync(test.databasePath);
    try {
      database.exec(
        `CREATE TRIGGER reject_recovery ${triggerEvent} BEGIN SELECT RAISE(ABORT, 'SECRET private storage diagnostic'); END;`,
      );
      expect(() => spool.retryFailed(request)).toThrow(/^storage_unavailable$/u);
      expect(relayStorageSnapshot(test.databasePath)).toEqual(snapshot);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_recovery;");
      database.close();
    }
    expect(spool.retryFailed(request).status).toBe("accepted");
    expect(spool.inspect("delivery-1")?.retries).toHaveLength(1);
    expect(relayStorageSnapshot(test.databasePath).deliveries[0]).toMatchObject({
      attempt_count: 1,
      maximum_attempts: 2,
      reserved_attempts: 2,
      reserved_bytes: initialReservation(input, 1) + 3_072,
    });
  });

  it("migrates the actual v1 schema without changing old payloads or attempt history", async () => {
    const test = fixture({ maximumAttempts: 1 });
    const legacy = createVersionOneDatabase(test.databasePath);
    const beforeMigration = new DatabaseSync(test.databasePath, { readOnly: true });
    try {
      expect(beforeMigration.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: 1,
      });
      const columns = beforeMigration.prepare("PRAGMA table_info(relay_deliveries)").all();
      expect(
        columns.some((column) => column.name === "version" || column.name === "reserved_attempts"),
      ).toBe(false);
    } finally {
      beforeMigration.close();
    }
    let spool = test.open();
    const migrated = relayStorageSnapshot(test.databasePath);
    expect(migrated.attempts).toEqual(legacy.attempts);
    expect(migrated.retries).toEqual([]);
    expect(
      migrated.deliveries.map(
        ({ version: _version, reserved_attempts: _reservedAttempts, ...row }) => row,
      ),
    ).toEqual(legacy.deliveries);
    expect(
      migrated.deliveries.every((row) => row.version === 1 && row.reserved_attempts === 1),
    ).toBe(true);
    const schema = new DatabaseSync(test.databasePath, { readOnly: true });
    try {
      expect(schema.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
    } finally {
      schema.close();
    }
    expect(spool.inspect("legacy-failed")).toMatchObject({
      state: "failed",
      version: 1,
      retries: [],
    });
    expect(spool.inspect("legacy-delivered")).toMatchObject({
      state: "delivered",
      version: 1,
      retries: [],
    });
    expect(() =>
      spool.retryFailed({
        deliveryId: "legacy-delivered",
        expectedVersion: 1,
        requestId: "legacy-already-delivered",
        reason: "manual_recovery",
      }),
    ).toThrow("invalid_state");
    const recovery = spool.retryFailed({
      deliveryId: "legacy-failed",
      expectedVersion: 1,
      requestId: "legacy-failure-recovery",
      reason: "receiver_available",
    });
    expect(recovery).toMatchObject({
      status: "accepted",
      retry: { previousCode: "receiver_rejected", additionalAttempts: 1 },
    });
    spool.close();
    spool = test.open();
    const transport = vi.fn(async (request) => {
      expect(request.deliveryId).toBe("legacy-failed");
      expect(Buffer.from(request.body)).toEqual(Buffer.from(legacy.failed.body));
      expect(request.headers).toEqual(legacy.failed.headers);
      return accepted("legacy-failed");
    });
    expect(await spool.runNext(transport)).toMatchObject({
      deliveryId: "legacy-failed",
      state: "delivered",
      attempts: [
        { number: 1, outcome: "failed" },
        { number: 2, outcome: "delivered" },
      ],
      retries: [recovery.retry],
    });
    expect(await spool.runNext(transport)).toBeNull();
    expect(transport).toHaveBeenCalledOnce();
    expect(spool.enqueue(legacy.delivered)).toMatchObject({
      status: "duplicate",
      delivery: { state: "delivered", version: 1 },
    });
  });

  it("rolls back schema and data together when migration cannot finish", () => {
    const test = fixture({ maximumAttempts: 1 });
    const legacy = createVersionOneDatabase(test.databasePath);
    const database = new DatabaseSync(test.databasePath);
    try {
      database.exec(
        "CREATE TRIGGER reject_migration BEFORE UPDATE ON relay_deliveries BEGIN SELECT RAISE(ABORT, 'SECRET private migration diagnostic'); END;",
      );
      expect(() => test.open()).toThrow(/^storage_unavailable$/u);
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      const columns = database.prepare("PRAGMA table_info(relay_deliveries)").all();
      expect(
        columns.some((column) => column.name === "version" || column.name === "reserved_attempts"),
      ).toBe(false);
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_retries'")
          .all(),
      ).toEqual([]);
      expect(database.prepare("SELECT * FROM relay_deliveries ORDER BY delivery_id").all()).toEqual(
        legacy.deliveries,
      );
      expect(
        database.prepare("SELECT * FROM relay_attempts ORDER BY delivery_id, number").all(),
      ).toEqual(legacy.attempts);
    } finally {
      database.exec("DROP TRIGGER IF EXISTS reject_migration;");
      database.close();
    }
    expect(test.open().inspect("legacy-failed")).toMatchObject({
      state: "failed",
      version: 1,
      retries: [],
    });
  });
});

describe("loopback webhook relay transport", () => {
  it.each([
    "https://example.com/api/github/webhook",
    "http://user:secret@127.0.0.1/api/github/webhook",
    "http://127.0.0.1/api/github/webhook?secret=value",
    "http://127.0.0.1/other",
  ])("rejects an untrusted target without exposing it", (target) => {
    expect(() => createWebhookRelayTransport(target)).toThrow("invalid_configuration");
  });

  it("sends exact signed bytes through native HTTP and validates the receiver acknowledgment", async () => {
    const original = envelope();
    const url = await receiver((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(original.body));
        expect(request.headers["x-hub-signature-256"]).toBe(
          original.headers["x-hub-signature-256"],
        );
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify(accepted().body));
      });
    });
    const spool = fixture().open();
    spool.enqueue(original);
    expect(await spool.runNext(createWebhookRelayTransport(url))).toMatchObject({
      state: "delivered",
    });
  });

  it("does not promote a native HTTP 401 with a duplicate-shaped body to delivered", async () => {
    let calls = 0;
    const url = await receiver((_request, response) => {
      calls += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify(accepted("delivery-1", "duplicate").body));
    });
    const spool = fixture().open();
    const original = envelope();
    spool.enqueue(original);
    const failed = await spool.runNext(createWebhookRelayTransport(url));
    expect(failed).toMatchObject({
      state: "failed",
      code: "receiver_rejected",
      attempts: [{ responseStatus: 401, acceptance: null, outcome: "failed" }],
    });
    expect(spool.enqueue(original).status).toBe("duplicate");
    expect(await spool.runNext(createWebhookRelayTransport(url))).toBeNull();
    expect(spool.inspect("delivery-1")).toEqual(failed);
    expect(calls).toBe(1);
  });

  it("does not follow redirects or accept oversized receipt bodies", async () => {
    let calls = 0;
    const url = await receiver((_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(302, { location: "/should-not-follow" });
        response.end();
      } else {
        response.writeHead(202);
        response.end("x".repeat(65_537));
      }
    });
    const spool = fixture().open();
    spool.enqueue(envelope("delivery-1"));
    expect(await spool.runNext(createWebhookRelayTransport(url))).toMatchObject({
      state: "failed",
      code: "invalid_receiver_receipt",
    });
    expect(calls).toBe(1);
    spool.enqueue(envelope("delivery-2"));
    expect(await spool.runNext(createWebhookRelayTransport(url))).toMatchObject({
      state: "failed",
      code: "invalid_receiver_receipt",
    });
    expect(calls).toBe(2);
  });

  it("bounds a stalled response body and aborts it before the lease can expire", async () => {
    const url = await receiver((_request, response) => {
      response.writeHead(202, { "content-type": "application/json" });
      response.write('{"status":');
    });
    const spool = fixture({ requestTimeoutMs: 25, leaseMs: 1_025 }).open();
    spool.enqueue(envelope());
    expect(await spool.runNext(createWebhookRelayTransport(url))).toMatchObject({
      state: "retry_wait",
      attempts: [{ code: "request_timeout" }],
    });
  });
});
