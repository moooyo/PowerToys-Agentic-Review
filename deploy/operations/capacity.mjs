import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { openObservationSession, readJsonFile } from "./observation-client.mjs";

const policyKeys = [
  "minimumDurationSeconds",
  "minimumCompletedTasks",
  "minimumCompletionsPerHour",
  "maximumFailedTasks",
  "maximumBlockedTasks",
  "maximumCancelledTasks",
  "minimumAvailableBytes",
  "maximumDatabaseGrowthBytes",
  "maximumWalBytes",
];

function bytes(value, label) {
  assert(
    typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value),
    `${label} must be decimal bytes.`,
  );
  return BigInt(value);
}

export function validateCapacityPolicy(policy) {
  assert(
    policy !== null && typeof policy === "object" && !Array.isArray(policy),
    "A capacity policy is required.",
  );
  assert.deepEqual(
    Object.keys(policy).sort(),
    [...policyKeys].sort(),
    "Specify every capacity threshold explicitly.",
  );
  for (const key of policyKeys) {
    if (key.endsWith("Bytes")) bytes(policy[key], key);
    else assert(Number.isFinite(policy[key]) && policy[key] >= 0, `${key} must be non-negative.`);
  }
  for (const key of [
    "minimumDurationSeconds",
    "minimumCompletedTasks",
    "maximumFailedTasks",
    "maximumBlockedTasks",
    "maximumCancelledTasks",
  ]) {
    assert(Number.isSafeInteger(policy[key]), `${key} must be an integer.`);
  }
  assert(policy.minimumDurationSeconds >= 60, "A capacity window must cover at least 60 seconds.");
  assert(policy.minimumCompletedTasks >= 1, "Acceptance requires an actual completed workload.");
  assert(policy.minimumCompletionsPerHour > 0, "Set an explicit non-zero throughput target.");
  return policy;
}

function taskCount(sample, state) {
  const value = sample.tasks?.byState?.[state];
  assert(Number.isSafeInteger(value) && value >= 0, "Invalid task aggregate.");
  return value;
}

function fileBytes(file, optional) {
  if (optional && file?.status === "missing") return 0n;
  assert(file?.status === "present", "A capacity file measurement is unavailable.");
  return bytes(file.byteLength, "File length");
}

/** Assesses observed global instance counters. It never generates work or infers a UI pass. */
export function evaluateCapacity(samples, policy) {
  validateCapacityPolicy(policy);
  assert(
    Array.isArray(samples) && samples.length >= 2,
    "At least two distinct samples are required.",
  );
  const violations = [];
  const times = samples.map((sample) => {
    assert(
      sample.schemaVersion === "InvestigationOperationsStatusV1",
      "Unsupported operations snapshot.",
    );
    const timestamp = Date.parse(sample.sampledAt);
    assert(Number.isFinite(timestamp), "Invalid sample timestamp.");
    assert(
      Number.isFinite(sample.runtime?.processUptimeSeconds) &&
        sample.runtime.processUptimeSeconds >= 0,
      "Missing process uptime.",
    );
    assert(
      Number.isFinite(Date.parse(sample.runtime.processStartedAt)),
      "Missing process start identity.",
    );
    assert(
      sample.tasks?.byState && typeof sample.tasks.byState === "object",
      "Missing task aggregates.",
    );
    const taskStates = [
      "queued",
      "running",
      "completed",
      "blocked",
      "failed",
      "cancelled",
      "interrupted",
      "unknown",
    ];
    assert.deepEqual(
      Object.keys(sample.tasks.byState).sort(),
      [...taskStates].sort(),
      "Unexpected task aggregate fields.",
    );
    assert(
      Number.isSafeInteger(sample.tasks.total) && sample.tasks.total >= 0,
      "Invalid total task count.",
    );
    for (const state of taskStates) {
      assert(Object.hasOwn(sample.tasks.byState, state), "Incomplete task aggregates.");
      taskCount(sample, state);
    }
    assert(
      Object.values(sample.tasks.byState).reduce((sum, value) => sum + value, 0) ===
        sample.tasks.total,
      "Task aggregate totals do not match.",
    );
    if (taskCount(sample, "unknown") > 0) violations.push("unknown_task_states");
    return timestamp;
  });
  let peakWalBytes = 0n;
  let minimumAvailableBytes = null;
  const databaseLengths = [];
  for (const [index, sample] of samples.entries()) {
    if (taskCount(sample, "interrupted") > taskCount(samples[0], "interrupted"))
      violations.push("interrupted_tasks");
    if (index > 0) {
      assert(
        times[index] > times[index - 1],
        "Cached or out-of-order samples cannot extend the observation window.",
      );
      if (
        sample.runtime.processStartedAt !== samples[index - 1].runtime.processStartedAt ||
        sample.runtime.processUptimeSeconds < samples[index - 1].runtime.processUptimeSeconds
      )
        violations.push("server_restarted");
      if (
        Math.abs(
          (times[index] - times[0]) / 1000 -
            (sample.runtime.processUptimeSeconds - samples[0].runtime.processUptimeSeconds),
        ) > 5
      )
        violations.push("wall_clock_changed");
      for (const state of ["completed", "failed", "blocked", "cancelled"]) {
        if (taskCount(sample, state) < taskCount(samples[index - 1], state))
          violations.push("task_counters_regressed");
      }
    }
    let databaseLength = 0n;
    let walLength = 0n;
    for (const key of ["investigation", "authentication"]) {
      const storage = sample.storage?.[key];
      assert(
        storage?.fileSystem?.status === "available",
        "Filesystem availability is required for capacity acceptance.",
      );
      const available = bytes(storage.fileSystem.availableBytes, "Filesystem availability");
      if (minimumAvailableBytes === null || available < minimumAvailableBytes)
        minimumAvailableBytes = available;
      databaseLength += fileBytes(storage.files?.database, false);
      walLength += fileBytes(storage.files?.wal, true);
    }
    databaseLengths.push(databaseLength);
    if (walLength > peakWalBytes) peakWalBytes = walLength;
  }
  const first = samples[0];
  const last = samples.at(-1);
  const durationSeconds = last.runtime.processUptimeSeconds - first.runtime.processUptimeSeconds;
  assert(durationSeconds > 0, "A positive monotonic observation window is required.");
  const completedTasks = taskCount(last, "completed") - taskCount(first, "completed");
  const completionsPerHour = (completedTasks * 3600) / durationSeconds;
  const peakDatabaseGrowthBytes =
    databaseLengths.reduce(
      (maximum, length) => (length > maximum ? length : maximum),
      databaseLengths[0],
    ) - databaseLengths[0];
  if (durationSeconds < policy.minimumDurationSeconds)
    violations.push("observation_window_too_short");
  if (completedTasks < policy.minimumCompletedTasks)
    violations.push("insufficient_completed_workload");
  if (completionsPerHour < policy.minimumCompletionsPerHour)
    violations.push("throughput_below_target");
  for (const [state, limit] of [
    ["failed", "maximumFailedTasks"],
    ["blocked", "maximumBlockedTasks"],
    ["cancelled", "maximumCancelledTasks"],
  ]) {
    if (taskCount(last, state) - taskCount(first, state) > policy[limit])
      violations.push(`${state}_tasks_exceed_limit`);
  }
  if (minimumAvailableBytes < bytes(policy.minimumAvailableBytes, "Minimum available bytes"))
    violations.push("available_space_below_target");
  if (peakDatabaseGrowthBytes > bytes(policy.maximumDatabaseGrowthBytes, "Database growth limit"))
    violations.push("database_growth_exceeds_limit");
  if (peakWalBytes > bytes(policy.maximumWalBytes, "WAL limit"))
    violations.push("wal_exceeds_limit");
  return {
    status: violations.length === 0 ? "passed" : "failed",
    scope:
      "Observed global task throughput and sampled file lengths/free space; not target-specific correctness, allocated blocks, inter-sample peaks, or a physical power-loss test.",
    violations: [...new Set(violations)],
    metrics: {
      durationSeconds,
      completedTasks,
      completionsPerHour,
      peakDatabaseGrowthBytes: peakDatabaseGrowthBytes.toString(),
      peakWalBytes: peakWalBytes.toString(),
      minimumAvailableBytes: minimumAvailableBytes.toString(),
    },
  };
}

export async function collectCapacity(
  { origin, credentials, policy, durationSeconds, intervalSeconds, dashboardIndexSha256 },
  dependencies = {},
) {
  validateCapacityPolicy(policy);
  assert(
    Number.isSafeInteger(durationSeconds) &&
      durationSeconds >= policy.minimumDurationSeconds &&
      durationSeconds <= 86400,
    "Choose a bounded observation window of at most one day.",
  );
  assert(
    Number.isSafeInteger(intervalSeconds) && intervalSeconds >= 6 && intervalSeconds <= 60,
    "Sampling interval must be 6 to 60 seconds.",
  );
  const wait = dependencies.wait ?? delay;
  const now = dependencies.now ?? (() => performance.now());
  let session;
  const receipt = {
    schemaVersion: "InvestigationCapacityAcceptanceV1",
    runId: randomUUID(),
    status: "running",
    startedAt: new Date().toISOString(),
    origin: null,
    requestedDurationSeconds: durationSeconds,
    intervalSeconds,
    policy,
    samples: [],
    deployment: null,
    evaluation: null,
    sessionClosed: null,
  };
  try {
    session = await (dependencies.openSession ?? openObservationSession)(origin, credentials);
    receipt.origin = session.origin;
    receipt.deployment = await session.deployment(dashboardIndexSha256);
    const first = await session.status();
    receipt.samples.push(first);
    const started = now();
    const deadline = durationSeconds * 1000 + 120_000;
    for (;;) {
      await wait(intervalSeconds * 1000);
      const sample = await session.status();
      if (receipt.samples.at(-1)?.sampledAt !== sample.sampledAt) receipt.samples.push(sample);
      if (sample.runtime?.processStartedAt !== first.runtime?.processStartedAt) break;
      if (
        sample.runtime.processUptimeSeconds - first.runtime.processUptimeSeconds >=
        durationSeconds
      )
        break;
      assert(
        now() - started < deadline,
        "The server observation window did not advance before the bounded deadline.",
      );
    }
    receipt.evaluation = evaluateCapacity(receipt.samples, policy);
    receipt.status = receipt.evaluation.status;
  } catch {
    receipt.status = "failed";
    receipt.failure =
      "Observation or evaluation failed; no successful capacity acceptance is claimed.";
  } finally {
    if (session !== undefined) {
      try {
        await session.close();
        receipt.sessionClosed = true;
      } catch {
        receipt.sessionClosed = false;
        receipt.status = "failed";
        receipt.failure = "Observation session logout was not confirmed.";
      }
    }
    receipt.finishedAt = new Date().toISOString();
  }
  return receipt;
}

export async function writeReceipt(handle, receipt) {
  const content = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await handle.truncate(0);
  let position = 0;
  while (position < content.length) {
    const { bytesWritten } = await handle.write(
      content,
      position,
      content.length - position,
      position,
    );
    assert(Number.isInteger(bytesWritten) && bytesWritten > 0, "Receipt write made no progress.");
    position += bytesWritten;
  }
  await handle.sync();
}

async function main() {
  assert(
    process.argv.length === 6 && process.argv[2] === "--config" && process.argv[4] === "--output",
    "Usage: node capacity.mjs --config <private-json> --output <new-receipt-json>",
  );
  const config = await readJsonFile(resolve(process.argv[3]));
  const policy = validateCapacityPolicy(config.policy);
  const credentials = await readJsonFile(resolve(config.credentialsPath), 16_384);
  // Reserve the receipt before any network request. Existing evidence is never overwritten.
  const output = await open(resolve(process.argv[5]), "wx", 0o600);
  try {
    await writeReceipt(output, {
      schemaVersion: "InvestigationCapacityAcceptanceV1",
      status: "running",
      policy,
    });
    const receipt = await collectCapacity({ ...config, credentials });
    await writeReceipt(output, receipt);
    if (receipt.status !== "passed") process.exitCode = 1;
    console.log(JSON.stringify({ status: receipt.status, samples: receipt.samples.length }));
  } finally {
    await output.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Capacity observation failed. Inspect the retained receipt and configuration.");
    process.exitCode = 1;
  });
}
