import assert from "node:assert/strict";
import test from "node:test";
import { restartDelayMilliseconds, validateConfiguration } from "../windows-supervisor.mjs";

function configuration(role = "server") {
  return {
    schemaVersion: 1,
    role,
    taskName: "Review-Test",
    identity: "HOST\\review",
    releaseDirectory: "D:\\Review\\Release",
    dataDirectory: "D:\\Review\\Data",
    stateDirectory: "D:\\Review\\Operations",
    nodeExecutable: "C:\\Node\\node.exe",
    restartLimit: 3,
    restartDelaySeconds: 5,
    restartMaximumDelaySeconds: 12,
    shutdownTimeoutSeconds: 240,
    artifact: {
      sourceRevision: "a".repeat(40),
      entrySha256: "b".repeat(64),
      dashboardIndexSha256: "c".repeat(64),
    },
    environment: {},
  };
}

test("runtime loader configuration rejects arbitrary roles, entries, and inherited Node hooks", () => {
  assert.throws(() => validateConfiguration({ ...configuration(), role: "custom" }));
  assert.throws(() => validateConfiguration({ ...configuration(), entryPath: "D:\\other.mjs" }));
  assert.throws(() =>
    validateConfiguration({
      ...configuration(),
      environment: { NODE_OPTIONS: "--import evil.mjs" },
    }),
  );
  assert.throws(() =>
    validateConfiguration({ ...configuration(), environment: { NODE_PATH: "D:\\Other" } }),
  );
});

test("release bytes and private data cannot overlap, including normalized traversal", () => {
  assert.throws(() =>
    validateConfiguration({ ...configuration(), dataDirectory: "D:\\Review\\Release\\data" }),
  );
  assert.throws(() =>
    validateConfiguration({ ...configuration(), stateDirectory: "D:\\Review\\Release\\..\\Data" }),
  );
  assert.throws(() =>
    validateConfiguration({ ...configuration(), releaseDirectory: "\\\\host\\share" }),
  );
  assert.throws(() => validateConfiguration({ ...configuration(), dataDirectory: "D:\\" }));
});

test("the supervisor owns durable paths and does not accept a runtime override", () => {
  assert.throws(() =>
    validateConfiguration({
      ...configuration(),
      environment: { INVESTIGATION_DATABASE_PATH: "D:\\other.sqlite" },
    }),
  );
  assert.throws(() =>
    validateConfiguration({
      ...configuration("worker"),
      environment: { INVESTIGATION_WORKER_DATA_DIRECTORY: "D:\\other" },
    }),
  );
  assert.throws(() =>
    validateConfiguration({
      ...configuration("worker"),
      environment: { WORKER_DATA_DIR: "D:\\legacy" },
    }),
  );
});

test("cooperative deadlines include both Worker shutdown phases, ProcessHost closure, and headroom", () => {
  assert.throws(() =>
    validateConfiguration({ ...configuration("worker"), shutdownTimeoutSeconds: 90 }),
  );
  assert.throws(() =>
    validateConfiguration({
      ...configuration("worker"),
      environment: { INVESTIGATION_WORKER_SHUTDOWN_TIMEOUT_MS: "300000" },
    }),
  );
  assert.equal(validateConfiguration(configuration("worker")).shutdownTimeoutSeconds, 240);
});

test("the retry budget is finite and exponential delays saturate at their configured cap", () => {
  const config = validateConfiguration(configuration());
  assert.deepEqual(
    [1, 2, 3, 4].map((retry) => restartDelayMilliseconds(config, retry)),
    [5000, 10000, 12000, 12000],
  );
  assert.throws(() => validateConfiguration({ ...configuration(), restartLimit: 11 }));
  assert.throws(() => validateConfiguration({ ...configuration(), restartMaximumDelaySeconds: 1 }));
});

test("artifact declarations require both Server and Dashboard entry digests", () => {
  assert.throws(() =>
    validateConfiguration({
      ...configuration(),
      artifact: { sourceRevision: "a".repeat(40), entrySha256: "b".repeat(64) },
    }),
  );
  assert.throws(() =>
    validateConfiguration({
      ...configuration(),
      artifact: { ...configuration().artifact, sourceRevision: "main" },
    }),
  );
});
