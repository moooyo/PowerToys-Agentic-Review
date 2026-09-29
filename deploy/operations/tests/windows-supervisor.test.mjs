import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  replaceStatusFile,
  restartDelayMilliseconds,
  validateConfiguration,
} from "../windows-supervisor.mjs";

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

function statusFiles(t) {
  const directory = mkdtempSync(join(tmpdir(), "operations-status-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statusPath = join(directory, "status.json");
  const temporary = join(directory, "status.json.instance.tmp");
  writeFileSync(statusPath, '{"state":"stopping"}\n');
  writeFileSync(temporary, '{"state":"stopped"}\n');
  return { statusPath, temporary };
}

test("status replacement preserves the previous receipt until transient sharing failures clear", (t) => {
  const { statusPath, temporary } = statusFiles(t);
  const failures = ["EACCES", "EPERM"];
  const retryCodes = replaceStatusFile(temporary, statusPath, {
    rename(from, to) {
      const code = failures.shift();
      if (code !== undefined) {
        assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).state, "stopping");
        throw Object.assign(new Error("Synthetic Windows sharing conflict."), { code });
      }
      renameSync(from, to);
    },
    wait() {},
  });
  assert.deepEqual(retryCodes, ["EACCES", "EPERM"]);
  assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).state, "stopped");
});

test("persistent sharing failures exhaust a bounded retry window without losing either receipt", (t) => {
  const { statusPath, temporary } = statusFiles(t);
  const original = Object.assign(new Error("Persistent sharing conflict."), { code: "EPERM" });
  let attempts = 0;
  let waitingMs = 0;
  assert.throws(
    () =>
      replaceStatusFile(temporary, statusPath, {
        rename() {
          attempts++;
          throw original;
        },
        wait(ms) {
          waitingMs += ms;
        },
      }),
    (error) => error === original,
  );
  assert.ok(attempts > 1 && attempts <= 10);
  assert.ok(waitingMs > 0 && waitingMs <= 2_000);
  assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).state, "stopping");
  assert.equal(JSON.parse(readFileSync(temporary, "utf8")).state, "stopped");
});

test("status replacement does not retry unrelated filesystem failures", (t) => {
  const { statusPath, temporary } = statusFiles(t);
  for (const code of ["EIO", "ENOENT", "EISDIR", "ENOSPC", "EBUSY"]) {
    const original = Object.assign(new Error("Synthetic non-sharing failure."), { code });
    let attempts = 0;
    assert.throws(
      () =>
        replaceStatusFile(temporary, statusPath, {
          rename() {
            attempts++;
            throw original;
          },
          wait() {
            assert.fail("Only EACCES and EPERM may wait before retrying a status rename.");
          },
        }),
      (error) => error === original,
    );
    assert.equal(attempts, 1);
  }
});

test("Windows status replacement recovers after a real reader closes its non-delete-sharing handle", {
  skip: process.platform !== "win32",
  timeout: 15_000,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "operations-status-reader-"));
  const statusPath = join(directory, "status.json");
  const temporary = join(directory, "status.json.instance.tmp");
  writeFileSync(statusPath, '{"state":"stopping"}\n');
  writeFileSync(temporary, '{"state":"stopped"}\n');
  const script = `
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($env:SUPERVISOR_STATUS_TEST_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
    [Console]::Out.WriteLine('READER_READY')
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds 500
} finally { $stream.Dispose() }
`;
  const reader = spawn(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, env: { ...process.env, SUPERVISOR_STATUS_TEST_PATH: statusPath } },
  );
  const completed = once(reader, "close");
  t.after(async () => {
    if (reader.exitCode === null && reader.signalCode === null) reader.kill();
    await completed;
    rmSync(directory, { recursive: true, force: true });
  });
  let stderr = "";
  reader.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    reader.once("error", reject);
    reader.once("exit", () =>
      reject(new Error(`The sharing reader exited before readiness: ${stderr}`)),
    );
    reader.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("READER_READY")) resolve();
    });
  });
  assert.throws(
    () => renameSync(temporary, statusPath),
    (error) => ["EACCES", "EPERM"].includes(error.code),
  );
  const retryCodes = replaceStatusFile(temporary, statusPath);
  assert.ok(retryCodes.length > 0);
  assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).state, "stopped");
  const [exitCode] = await completed;
  assert.equal(exitCode, 0, stderr);
});
