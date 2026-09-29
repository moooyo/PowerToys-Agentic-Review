import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entries = Object.freeze({
  server: "apps/server/dist/main.js",
  worker: "apps/worker/dist/worker.mjs",
});
const activeStates = new Set([
  "starting",
  "running",
  "backoff",
  "stopping",
  "shutdown-timeout",
  "recovery-required",
]);
const inheritedNames = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
]);

function fail(message) {
  throw new Error(message);
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(parent, child) {
  const suffix = win32.relative(parent, child);
  return (
    suffix !== "" && suffix !== ".." && !suffix.startsWith("..\\") && !win32.isAbsolute(suffix)
  );
}

function localPath(value, label) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows deployment paths must reject control characters.
  const invalidCharacters = /[\x00-\x1f"<>|?*]/u;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z]:\\/u.test(value) ||
    invalidCharacters.test(value) ||
    value.slice(2).includes(":")
  )
    fail(`${label} must be an absolute local Windows path.`);
  const normalized = win32.normalize(value);
  if (normalized === win32.parse(normalized).root)
    fail(`${label} cannot be an entire volume root.`);
  return normalized;
}

export function validateConfiguration(value) {
  const names = [
    "schemaVersion",
    "role",
    "taskName",
    "identity",
    "releaseDirectory",
    "dataDirectory",
    "stateDirectory",
    "nodeExecutable",
    "restartLimit",
    "restartDelaySeconds",
    "restartMaximumDelaySeconds",
    "shutdownTimeoutSeconds",
    "artifact",
    "environment",
  ];
  if (
    !object(value) ||
    Object.keys(value).some((key) => !names.includes(key)) ||
    value.schemaVersion !== 1
  )
    fail("The operations configuration schema is invalid.");
  if (value.role !== "server" && value.role !== "worker") fail("The operations role is invalid.");
  if (
    typeof value.taskName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value.taskName)
  )
    fail("The task name is invalid.");
  if (
    typeof value.identity !== "string" ||
    value.identity.trim() !== value.identity ||
    value.identity.length === 0
  )
    fail("A Windows task identity is required.");
  const config = { ...value };
  for (const key of ["releaseDirectory", "dataDirectory", "stateDirectory", "nodeExecutable"])
    config[key] = localPath(value[key], key);
  for (const left of ["releaseDirectory", "dataDirectory", "stateDirectory"]) {
    for (const right of ["releaseDirectory", "dataDirectory", "stateDirectory"]) {
      if (
        left !== right &&
        (config[left].toLowerCase() === config[right].toLowerCase() ||
          inside(config[left], config[right]))
      )
        fail("Release, application data, and operations state directories must be disjoint.");
    }
  }
  for (const [key, min, max] of [
    ["restartLimit", 0, 10],
    ["restartDelaySeconds", 1, 300],
    ["restartMaximumDelaySeconds", 1, 3600],
    ["shutdownTimeoutSeconds", 60, 1800],
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max)
      fail(`The ${key} setting is invalid.`);
  }
  if (value.restartMaximumDelaySeconds < value.restartDelaySeconds)
    fail("The maximum restart delay is too short.");
  if (
    !object(value.artifact) ||
    Object.keys(value.artifact).some(
      (key) => !["sourceRevision", "entrySha256", "dashboardIndexSha256"].includes(key),
    ) ||
    !/^[a-f0-9]{40}$/u.test(value.artifact.sourceRevision ?? "") ||
    !/^[a-f0-9]{64}$/u.test(value.artifact.entrySha256 ?? "")
  )
    fail("An artifact revision declaration and entry digest are required.");
  if (value.role === "server" && !/^[a-f0-9]{64}$/u.test(value.artifact.dashboardIndexSha256 ?? ""))
    fail("The Server dashboard index digest is required.");
  if (!object(value.environment)) fail("The runtime environment must be an object.");
  const derived = [
    "INVESTIGATION_DATABASE_PATH",
    "INVESTIGATION_AUTH_DATABASE_PATH",
    "INVESTIGATION_DASHBOARD_DIRECTORY",
    "INVESTIGATION_WORKER_DATA_DIRECTORY",
  ];
  for (const [key, entry] of Object.entries(value.environment)) {
    if (
      !/^INVESTIGATION_[A-Z0-9_]+$/u.test(key) ||
      (value.role === "worker") !== key.startsWith("INVESTIGATION_WORKER_") ||
      derived.includes(key) ||
      typeof entry !== "string" ||
      entry.includes("\0")
    )
      fail("The runtime environment contains an unsupported setting.");
  }
  const runtimeShutdown =
    value.role === "worker"
      ? Number(value.environment.INVESTIGATION_WORKER_SHUTDOWN_TIMEOUT_MS ?? 60000)
      : 30000;
  // Worker stop may consume two service deadlines and a ProcessHost closure deadline.
  if (
    !Number.isSafeInteger(runtimeShutdown) ||
    runtimeShutdown < 1 ||
    value.shutdownTimeoutSeconds * 1000 <
      runtimeShutdown * (value.role === "worker" ? 3 : 1) + 60000
  )
    fail("The supervisor shutdown deadline is shorter than the runtime cleanup budget.");
  return config;
}

function existingPath(path, directory) {
  let cursor = path;
  while (true) {
    if (lstatSync(cursor).isSymbolicLink())
      fail("Operations paths cannot contain links or reparse points.");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const info = statSync(path);
  if (directory ? !info.isDirectory() : !info.isFile())
    fail("An operations path has the wrong type.");
  if (realpathSync(path).toLowerCase() !== resolve(path).toLowerCase())
    fail("An operations path changed identity.");
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function restartDelayMilliseconds(config, restartNumber) {
  return (
    Math.min(
      config.restartMaximumDelaySeconds,
      config.restartDelaySeconds * 2 ** (restartNumber - 1),
    ) * 1000
  );
}

const statusRenameRetryDelaysMs = [10, 25, 50, 100, 200, 400, 800];
const statusRenameWait = new Int32Array(new SharedArrayBuffer(4));

/** Readers without Windows delete sharing can briefly block an otherwise atomic replacement. */
export function replaceStatusFile(
  temporary,
  statusPath,
  { rename = renameSync, wait = (ms) => Atomics.wait(statusRenameWait, 0, 0, ms) } = {},
) {
  const retryCodes = [];
  for (;;) {
    try {
      rename(temporary, statusPath);
      return retryCodes;
    } catch (error) {
      if (
        !["EACCES", "EPERM"].includes(error?.code) ||
        retryCodes.length >= statusRenameRetryDelaysMs.length
      )
        throw error;
      const delay = statusRenameRetryDelaysMs[retryCodes.length];
      retryCodes.push(error.code);
      wait(delay);
    }
  }
}

function readJson(path) {
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) fail("An operations control file exceeds its limit.");
  try {
    return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    fail("An operations control file is invalid JSON.");
  }
}

function secrets(environment) {
  const values = new Set();
  const collect = (entry) => {
    if (!object(entry) && !Array.isArray(entry)) return;
    for (const [key, item] of Object.entries(entry)) {
      if (
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_KEY|COOKIE|AUTHORIZATION|CREDENTIAL)/iu.test(
          key,
        ) &&
        typeof item === "string" &&
        item.length >= 6
      )
        values.add(item);
      collect(item);
    }
  };
  collect(environment);
  for (const [key, entry] of Object.entries(environment)) {
    if (key.endsWith("_JSON")) {
      try {
        collect(JSON.parse(entry));
      } catch {
        /* Runtime configuration will reject malformed JSON. */
      }
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function boundedLog(directory, protectedValues) {
  mkdirSync(directory, { recursive: true });
  existingPath(directory, true);
  const path = resolve(directory, "runtime.log");
  const maximum = 8 * 1024 * 1024;
  let descriptor;
  let bytes = 0;
  const open = () => {
    if (existsSync(path)) existingPath(path, false);
    descriptor = openSync(path, "a", 0o600);
    bytes = statSync(path).size;
  };
  const close = () => {
    if (descriptor !== undefined) closeSync(descriptor);
    descriptor = undefined;
  };
  open();
  return {
    close,
    write(line) {
      for (const value of protectedValues) line = line.replaceAll(value, "[REDACTED]");
      const data = Buffer.from(`${line}\n`);
      if (bytes + data.length > maximum) {
        close();
        // Only these supervisor-owned log files are rotated; application data is never pruned.
        for (let index = 3; index >= 0; index--) {
          const source = index === 0 ? path : `${path}.${index}`;
          const destination = `${path}.${index + 1}`;
          if (!existsSync(source)) continue;
          existingPath(source, false);
          if (existsSync(destination)) {
            existingPath(destination, false);
            unlinkSync(destination);
          }
          renameSync(source, destination);
        }
        open();
      }
      writeSync(descriptor, data);
      bytes += data.length;
    },
  };
}

export async function runSupervisor(configurationPath) {
  if (process.platform !== "win32") fail("The production supervisor requires Windows.");
  const config = validateConfiguration(readJson(configurationPath));
  const bootId = process.env.AGENTIC_REVIEW_OPERATIONS_BOOT_ID;
  if (!/^[0-9]{18}$/u.test(bootId ?? ""))
    fail("Use the Scheduled Task launcher to supply the Windows boot identity.");
  for (const key of ["releaseDirectory", "dataDirectory", "stateDirectory"])
    existingPath(config[key], true);
  existingPath(config.nodeExecutable, false);
  if (
    realpathSync(process.execPath).toLowerCase() !==
    realpathSync(config.nodeExecutable).toLowerCase()
  )
    fail("The supervisor must use its configured Node executable.");
  const entryPath = resolve(config.releaseDirectory, entries[config.role]);
  const bridgePath = resolve(
    config.releaseDirectory,
    "deploy/operations/windows-shutdown-bridge.mjs",
  );
  existingPath(entryPath, false);
  existingPath(bridgePath, false);
  if (digest(entryPath) !== config.artifact.entrySha256)
    fail("The runtime entry digest does not match the deployment declaration.");
  const dashboardPath = resolve(config.releaseDirectory, "apps/dashboard/dist");
  if (config.role === "server") {
    existingPath(resolve(dashboardPath, "index.html"), false);
    if (digest(resolve(dashboardPath, "index.html")) !== config.artifact.dashboardIndexSha256)
      fail("The dashboard entry digest does not match the deployment declaration.");
  }
  const statusPath = resolve(config.stateDirectory, "status.json");
  if (existsSync(statusPath)) {
    existingPath(statusPath, false);
    const previous = readJson(statusPath);
    if (
      previous.schemaVersion !== 1 ||
      !/^[0-9a-f-]{36}$/u.test(previous.instanceId ?? "") ||
      previous.role !== config.role ||
      previous.taskName !== config.taskName
    )
      fail("The retained operations status does not belong to this task.");
    // A crash can happen before childPid is saved. Within the same boot, an active
    // receipt therefore requires explicit recovery even when both recorded PIDs are gone.
    if (
      activeStates.has(previous.state) &&
      (previous.bootId === undefined || previous.bootId === bootId)
    )
      fail(
        "A prior generation did not stop cleanly in this boot; inspect its owned processes and retain its status before recovery.",
      );
    const historyDirectory = resolve(config.stateDirectory, "history");
    mkdirSync(historyDirectory, { recursive: true });
    existingPath(historyDirectory, true);
    const historyPath = resolve(historyDirectory, `${previous.instanceId}.json`);
    const historyBytes = Buffer.from(`${JSON.stringify(previous, null, 2)}\n`);
    if (existsSync(historyPath)) {
      existingPath(historyPath, false);
      if (!readFileSync(historyPath).equals(historyBytes))
        fail("A retained generation receipt differs from the existing archive.");
    } else {
      writeFileSync(historyPath, historyBytes, { flag: "wx", mode: 0o600, flush: true });
    }
  }
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => inheritedNames.has(key.toUpperCase()) && value !== undefined,
    ),
  );
  Object.assign(
    childEnvironment,
    config.environment,
    config.role === "server"
      ? {
          INVESTIGATION_DATABASE_PATH: resolve(config.dataDirectory, "investigation.sqlite"),
          INVESTIGATION_AUTH_DATABASE_PATH: resolve(
            config.dataDirectory,
            "investigation-accounts.sqlite",
          ),
          INVESTIGATION_DASHBOARD_DIRECTORY: dashboardPath,
        }
      : { INVESTIGATION_WORKER_DATA_DIRECTORY: config.dataDirectory },
  );
  const instanceId = randomUUID();
  const stopPath = resolve(config.stateDirectory, `stop-${instanceId}.json`);
  const log = boundedLog(resolve(config.stateDirectory, "logs"), secrets(config.environment));
  const state = {
    schemaVersion: 1,
    instanceId,
    taskName: config.taskName,
    role: config.role,
    supervisorPid: process.pid,
    bootId,
    childPid: null,
    state: "starting",
    restartCount: 0,
    startedAt: new Date().toISOString(),
    artifact: config.artifact,
    artifactEvidence: "Observed entry bytes only; source revision is an operator declaration.",
  };
  let persistenceFailed = false;
  let onPersistenceFailure = () => {};
  const statusDiagnostic = (message, failure = false) => {
    try {
      log.write(message);
    } catch {
      // Diagnostics must not replace the original status persistence failure.
    }
    if (failure) console.error(message);
    else console.log(message);
  };
  const save = (next) => {
    Object.assign(state, next, { updatedAt: new Date().toISOString() });
    const temporary = `${statusPath}.${instanceId}.tmp`;
    let phase = "write";
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flush: true });
      phase = "rename";
      const retryCodes = replaceStatusFile(temporary, statusPath);
      if (retryCodes.length > 0)
        statusDiagnostic(
          `Supervisor status persistence recovered: phase=rename codes=${retryCodes.join(",")} retries=${retryCodes.length}.`,
        );
      return true;
    } catch (error) {
      const code =
        typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code)
          ? error.code
          : "UNKNOWN";
      statusDiagnostic(`Supervisor status persistence failed: phase=${phase} code=${code}.`, true);
      if (!persistenceFailed) {
        persistenceFailed = true;
        onPersistenceFailure();
      }
      return false;
    }
  };
  let child;
  let stopping = false;
  let timedOut = false;
  let failed = false;
  let restartTimer;
  let shutdownTimer;
  let complete;
  const finished = new Promise((resolveFinished) => {
    complete = resolveFinished;
  });
  const recordFailure = () => {
    failed = true;
    process.exitCode = 1;
  };
  const finish = (exitCode, reason) => {
    clearTimeout(shutdownTimer);
    if (exitCode !== 0 || timedOut || failed) recordFailure();
    const recoveryRequired = config.role === "worker" && failed;
    save({
      state: recoveryRequired ? "recovery-required" : failed ? "failed" : "stopped",
      lastChildPid: state.childPid,
      childPid: null,
      exitCode,
      reason,
      stoppedAt: new Date().toISOString(),
    });
    complete();
  };
  const requestStop = (reason) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(restartTimer);
    save({ state: "stopping", reason });
    if (child === undefined) {
      finish(0, reason);
      return;
    }
    try {
      if (child.connected)
        child.send({ type: "agentic-review-operations-shutdown-v1" }, (error) => {
          if (error) recordFailure();
        });
    } catch {
      recordFailure();
    }
    shutdownTimer = setTimeout(() => {
      timedOut = true;
      recordFailure();
      save({
        state: "shutdown-timeout",
        reason:
          "Cooperative shutdown deadline exceeded; the owned child is retained and automatic restart is disabled.",
      });
      // Keep the supervisor, its mutex owner, and the child alive for explicit recovery.
    }, config.shutdownTimeoutSeconds * 1000);
  };
  onPersistenceFailure = () => {
    recordFailure();
    requestStop("Supervisor status persistence failed; automatic restart is disabled.");
  };
  const attachOutput = (stream, name) => {
    let pending = "";
    let discarding = false;
    stream.setEncoding("utf8");
    stream.on("error", () => {
      recordFailure();
      requestStop("Runtime output supervision failed.");
    });
    stream.on("data", (chunk) => {
      pending += chunk;
      while (pending.includes("\n")) {
        const boundary = pending.indexOf("\n");
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (!discarding && line.length <= 65536) {
          try {
            log.write(`${name}: ${line.replace(/\r$/u, "")}`);
          } catch {
            recordFailure();
            requestStop("Runtime log persistence failed.");
          }
        }
        discarding = false;
      }
      if (pending.length > 65536) {
        pending = "";
        discarding = true;
      }
    });
    stream.on("end", () => {
      if (!discarding && pending.length > 0) {
        try {
          log.write(`${name}: ${pending}`);
        } catch {
          recordFailure();
          requestStop("Runtime log persistence failed.");
        }
      }
    });
  };
  const launch = () => {
    if (stopping) return;
    if (!save({ state: "starting", childPid: null })) return;
    try {
      child = fork(entryPath, [], {
        cwd: config.dataDirectory,
        env: childEnvironment,
        execPath: config.nodeExecutable,
        execArgv: ["--enable-source-maps", "--import", pathToFileURL(bridgePath).href],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });
    } catch {
      recordFailure();
      finish(1, "The configured runtime could not be started.");
      return;
    }
    attachOutput(child.stdout, "stdout");
    attachOutput(child.stderr, "stderr");
    child.on("spawn", () =>
      save({
        state: stopping ? "stopping" : "running",
        childPid: child.pid,
        childStartedAt: new Date().toISOString(),
      }),
    );
    child.on("error", () => {
      recordFailure();
    });
    child.on("close", (code, signal) => {
      child = undefined;
      if (stopping) {
        finish(
          code ?? 1,
          timedOut
            ? "Shutdown completed after its deadline; recovery must be reviewed."
            : "Cooperative shutdown completed.",
        );
        return;
      }
      if (config.role === "worker" && (code !== 0 || signal !== null)) {
        finish(
          code === 0 ? 1 : (code ?? 1),
          "The Worker exited without confirmed cleanup. Review its retained journals and owned processes before recovery.",
        );
        return;
      }
      if (state.restartCount >= config.restartLimit || failed) {
        finish(
          code === 0 ? 1 : (code ?? 1),
          "The bounded restart policy is exhausted or process supervision failed.",
        );
        return;
      }
      state.restartCount++;
      const delay = restartDelayMilliseconds(config, state.restartCount);
      if (
        !save({
          state: "backoff",
          childPid: null,
          exitCode: code,
          exitSignal: signal,
          restartAt: new Date(Date.now() + delay).toISOString(),
        })
      )
        return;
      restartTimer = setTimeout(launch, delay);
    });
  };
  const poll = setInterval(() => {
    if (!existsSync(stopPath)) return;
    try {
      existingPath(stopPath, false);
      const request = readJson(stopPath);
      if (
        request.schemaVersion === 1 &&
        request.instanceId === instanceId &&
        request.action === "stop"
      )
        requestStop("An operator requested cooperative shutdown.");
    } catch {
      recordFailure();
      requestStop("The private stop request could not be read safely.");
    }
  }, 500);
  const onSignal = () => requestStop("The supervisor received an operating system signal.");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    launch();
    await finished;
  } finally {
    clearInterval(poll);
    clearTimeout(restartTimer);
    clearTimeout(shutdownTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    log.close();
    if (existsSync(stopPath)) unlinkSync(stopPath);
  }
}

const ownPath = fileURLToPath(import.meta.url);
if (
  process.argv[1] !== undefined &&
  isAbsolute(process.argv[1]) &&
  relative(ownPath, resolve(process.argv[1])) === ""
) {
  if (process.argv.length !== 3) fail("Supply exactly one private configuration path.");
  await runSupervisor(localPath(process.argv[2], "Configuration path")).catch(() => {
    // Runtime configuration can contain credentials: never print thrown values or the config.
    console.error("Production supervision failed. Inspect the private status and runtime logs.");
    process.exitCode = 1;
  });
}
