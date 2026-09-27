import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectCapacity,
  evaluateCapacity,
  validateCapacityPolicy,
  writeReceipt,
} from "./capacity.mjs";

const policy = {
  minimumDurationSeconds: 60,
  minimumCompletedTasks: 2,
  minimumCompletionsPerHour: 60,
  maximumFailedTasks: 0,
  maximumBlockedTasks: 0,
  maximumCancelledTasks: 0,
  minimumAvailableBytes: "1000",
  maximumDatabaseGrowthBytes: "100",
  maximumWalBytes: "50",
};

function snapshot(second, completed, overrides = {}) {
  const storage = () => ({
    files: {
      database: { status: "present", byteLength: "100" },
      wal: { status: "missing", byteLength: null },
    },
    fileSystem: { status: "available", availableBytes: "10000" },
  });
  return {
    schemaVersion: "InvestigationOperationsStatusV1",
    sampledAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    runtime: { processUptimeSeconds: second + 100, processStartedAt: "2025-12-31T23:58:20.000Z" },
    tasks: {
      total: completed,
      byState: {
        queued: 0,
        running: 0,
        completed,
        blocked: 0,
        failed: 0,
        cancelled: 0,
        interrupted: 0,
        unknown: 0,
      },
    },
    storage: { investigation: storage(), authentication: storage() },
    ...overrides,
  };
}

test("capacity acceptance requires declared thresholds and a completed workload", () => {
  assert.equal(evaluateCapacity([snapshot(0, 10), snapshot(60, 12)], policy).status, "passed");
  assert(
    evaluateCapacity([snapshot(0, 10), snapshot(60, 10)], policy).violations.includes(
      "insufficient_completed_workload",
    ),
  );
  assert.throws(() => validateCapacityPolicy({ ...policy, minimumCompletedTasks: 0 }));
  const missing = { ...policy };
  delete missing.maximumWalBytes;
  assert.throws(() => validateCapacityPolicy(missing));
});

test("a restart cannot be hidden by a new process with greater uptime", () => {
  const next = snapshot(60, 12);
  next.runtime.processStartedAt = "2026-01-01T00:00:01.000Z";
  assert(evaluateCapacity([snapshot(0, 10), next], policy).violations.includes("server_restarted"));
});

test("cached timestamps and reset task counters cannot produce throughput", () => {
  assert.throws(() => evaluateCapacity([snapshot(0, 10), snapshot(0, 12)], policy));
  assert(
    evaluateCapacity(
      [snapshot(0, 10), snapshot(30, 1), snapshot(60, 12)],
      policy,
    ).violations.includes("task_counters_regressed"),
  );
});

test("missing measurements cannot silently become zero disk usage", () => {
  for (const status of ["unavailable", "in_memory", "missing"]) {
    const next = snapshot(60, 12);
    next.storage.authentication.files.database.status = status;
    assert.throws(() => evaluateCapacity([snapshot(0, 10), next], policy));
  }
  const next = snapshot(60, 12);
  next.storage.investigation.fileSystem.status = "unavailable";
  assert.throws(() => evaluateCapacity([snapshot(0, 10), next], policy));
});

test("storage thresholds retain precision beyond the JavaScript integer limit", () => {
  const first = snapshot(0, 10);
  const next = snapshot(60, 12);
  first.storage.investigation.files.database.byteLength = "9007199254740993";
  next.storage.investigation.files.database.byteLength = "9007199254741094";
  next.storage.authentication.files.wal = { status: "present", byteLength: "51" };
  next.storage.investigation.fileSystem.availableBytes = "999";
  const result = evaluateCapacity([first, next], policy);
  assert.equal(result.metrics.peakDatabaseGrowthBytes, "101");
  assert(result.violations.includes("database_growth_exceeds_limit"));
  assert(result.violations.includes("wal_exceeds_limit"));
  assert(result.violations.includes("available_space_below_target"));
});

test("unknown and malformed task states fail closed", () => {
  const next = snapshot(60, 12);
  next.tasks.byState.unknown = 1;
  next.tasks.total += 1;
  assert(
    evaluateCapacity([snapshot(0, 10), next], policy).violations.includes("unknown_task_states"),
  );
  delete next.tasks.byState.unknown;
  assert.throws(() => evaluateCapacity([snapshot(0, 10), next], policy));
  for (const state of ["completed", "unknown"]) {
    const first = snapshot(0, 0);
    first.tasks.byState[state] = null;
    assert.throws(() => evaluateCapacity([first, snapshot(60, 2)], policy));
  }
});

test("collector retains an observation failure and logs out its own session", async () => {
  let closed = 0;
  const receipt = await collectCapacity(
    { policy, durationSeconds: 60, intervalSeconds: 30 },
    {
      openSession: async () => ({
        deployment: async () => ({ health: "ok" }),
        status: async () => {
          throw new Error("Synthetic unavailable snapshot");
        },
        close: async () => {
          closed += 1;
        },
      }),
    },
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.sessionClosed, true);
  assert.equal(closed, 1);
});

test("login failure produces a terminal failed receipt without a nonexistent session logout", async () => {
  const receipt = await collectCapacity(
    { policy, durationSeconds: 60, intervalSeconds: 30 },
    {
      openSession: async () => {
        throw new Error("Synthetic login failure");
      },
    },
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.sessionClosed, null);
  assert.equal(receipt.samples.length, 0);
  assert(Number.isFinite(Date.parse(receipt.finishedAt)));
});

test("an unconfirmed logout prevents a passed receipt", async () => {
  let elapsed = 0;
  let index = 0;
  const samples = [snapshot(0, 10), snapshot(30, 11), snapshot(60, 12)];
  const receipt = await collectCapacity(
    { policy, durationSeconds: 60, intervalSeconds: 30 },
    {
      now: () => elapsed,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
      openSession: async () => ({
        deployment: async () => ({ health: "ok" }),
        status: async () => samples[index++],
        close: async () => {
          throw new Error("Synthetic logout failure");
        },
      }),
    },
  );
  assert.equal(receipt.evaluation.status, "passed");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.sessionClosed, false);
});

test("a forward wall-clock adjustment cannot invent a sufficient capacity window", () => {
  const next = snapshot(60, 12);
  next.runtime.processUptimeSeconds = 110;
  const result = evaluateCapacity([snapshot(0, 10), next], policy);
  assert.equal(result.metrics.durationSeconds, 10);
  assert(result.violations.includes("wall_clock_changed"));
  assert(result.violations.includes("observation_window_too_short"));
});

test("an observed interruption remains a failure after the task recovers", () => {
  const middle = snapshot(30, 11);
  middle.tasks.byState.interrupted = 1;
  middle.tasks.total += 1;
  const result = evaluateCapacity([snapshot(0, 10), middle, snapshot(60, 12)], policy);
  assert(result.violations.includes("interrupted_tasks"));
});

test("initial request latency does not shorten the sampled server window", async () => {
  let elapsed = 0;
  let index = 0;
  const receipt = await collectCapacity(
    { policy, durationSeconds: 60, intervalSeconds: 30 },
    {
      now: () => elapsed,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
      openSession: async () => ({
        origin: "https://synthetic.example",
        deployment: async () => ({ health: "ok" }),
        status: async () => {
          if (index === 0) elapsed += 15_000;
          return snapshot(index * 30, 10 + index++);
        },
        close: async () => undefined,
      }),
    },
  );
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.evaluation.metrics.durationSeconds, 60);
  assert.equal(receipt.origin, "https://synthetic.example");
  assert.equal(receipt.requestedDurationSeconds, 60);
});

test("a permanently cached snapshot reaches the bounded deadline and stays failed", async () => {
  let elapsed = 0;
  const receipt = await collectCapacity(
    { policy, durationSeconds: 60, intervalSeconds: 30 },
    {
      now: () => elapsed,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
      openSession: async () => ({
        deployment: async () => ({ health: "ok" }),
        status: async () => snapshot(0, 10),
        close: async () => undefined,
      }),
    },
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.samples.length, 1);
  assert.equal(elapsed, 180_000);
});

test("receipt writes handle short writes and reject zero progress", async () => {
  const chunks = [];
  let synced = false;
  await writeReceipt(
    {
      truncate: async () => undefined,
      write: async (buffer, offset, length, position) => {
        assert.equal(offset, position);
        const count = Math.min(length, 3);
        chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
        return { bytesWritten: count };
      },
      sync: async () => {
        synced = true;
      },
    },
    { status: "passed" },
  );
  assert.equal(JSON.parse(Buffer.concat(chunks).toString("utf8")).status, "passed");
  assert.equal(synced, true);
  await assert.rejects(() =>
    writeReceipt(
      {
        truncate: async () => undefined,
        write: async () => ({ bytesWritten: 0 }),
        sync: async () => undefined,
      },
      { status: "passed" },
    ),
  );
});
