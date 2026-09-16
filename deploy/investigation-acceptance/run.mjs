import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { recordSourceManifest } from "./source-manifest.mjs";

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  assert(name?.startsWith("--") && value, "Arguments must be --name value pairs.");
  assert(!args.has(name), `Duplicate argument ${name}.`);
  args.set(name, value);
}
assert.equal(
  process.platform,
  "win32",
  "Run this native lifecycle acceptance only on the authorized Windows worker.",
);
const repo = resolve(required("--repo-root"));
const toolsRoot = resolve(required("--tools-root"));
const output = resolve(required("--output"));
const processHost = resolve(
  args.get("--process-host") ?? join(toolsRoot, "AgenticReview.ProcessHost.exe"),
);
const git = resolve(args.get("--git") ?? join(toolsRoot, "git", "cmd", "git.exe"));
const cli = resolve(
  args.get("--synthetic-cli") ?? join(toolsRoot, "synthetic-investigation-cli.exe"),
);
const node = process.execPath;
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
assert(
  !inside(repo, output) && !inside(toolsRoot, output) && !inside(output, toolsRoot),
  "Acceptance data must be outside the checkout and trusted tools.",
);
assert(
  inside(toolsRoot, processHost) && inside(toolsRoot, git),
  "ProcessHost and Git must be under the trusted tools root.",
);
await ordinaryDirectory(repo);
await ordinaryDirectory(toolsRoot);
await ordinaryDirectory(dirname(output));
await mkdir(output);

const receipt = {
  schemaVersion: "SyntheticInvestigationLifecycleAcceptanceV1",
  synthetic: true,
  realModel: false,
  realGitHubMutation: false,
  status: "running",
  startedAt: new Date().toISOString(),
  scope: {
    workerEntry: "apps/worker/dist/worker.mjs",
    serverEntry: "apps/server/dist/main.js",
    serverPlatform: "Windows synthetic deployment; not Linux production acceptance",
    modelTransport: "Synthetic native Codex-compatible CLI; no model or provider",
    input: "Isolated complete Issue snapshots; no Git source execution",
    shutdown: "Private IPC bridge delivers the existing product SIGTERM handler",
    exclusions: [
      "real models",
      "GitHub writes",
      "SCM/console signal delivery",
      "abrupt crash orphan cleanup",
      "UI execution",
      "runtime artifact upload",
      "capacity benchmark",
    ],
  },
  source: {},
  checks: [],
  processes: [],
  scenarios: [],
  limitations: [
    "Evidence is synthetic reporter analysis with no claim of observed repository behavior.",
  ],
};
const children = [];
const activeStreams = [];
const tasks = [];
let cookie = "";
let server;
let worker;
let origin;
let fixture;
let contracts;
let domain;
let Value;
const token = randomBytes(32).toString("base64url");
const password = `synthetic-${randomBytes(24).toString("base64url")}`;
const data = join(output, "worker-data");
const home = join(output, "synthetic-cli-home");
const profile = join(output, "synthetic-account");
const database = join(output, "investigation.sqlite");
const authDatabase = join(output, "accounts.sqlite");
const controls = { holdUnknownTasks: false, tasks: {} };
const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP)$/iu.test(name),
  ),
);
const serverEntry = join(repo, "apps", "server", "dist", "main.js");
const workerEntry = join(repo, "apps", "worker", "dist", "worker.mjs");
const dashboardDirectory = join(repo, "apps", "dashboard", "dist");
let serverEnvironment;
let workerEnvironment;

try {
  for (const directory of [data, home, profile, join(home, "observations")]) await mkdir(directory);
  const imports = await Promise.all([
    import(pathToFileURL(join(repo, "packages", "contracts", "dist", "index.js")).href),
    import(pathToFileURL(join(repo, "packages", "domain", "dist", "index.js")).href),
    import(
      pathToFileURL(join(repo, "packages", "contracts", "dist", "investigation-preview.js")).href
    ),
    import(pathToFileURL(join(repo, "apps", "server", "dist", "investigation", "store.js")).href),
  ]);
  [contracts, domain] = imports;
  const requireServer = createRequire(join(repo, "apps", "server", "package.json"));
  ({ Value } = requireServer("@sinclair/typebox/value"));
  const { FormatRegistry } = requireServer("@sinclair/typebox");
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
  fixture = imports[2].createInvestigationPreview("bug", { findingCount: 137, priority: "P2" });
  fixture.task.repository.fullName = "synthetic-lifecycle/fixture";
  fixture.result.findings.at(-1).priority = "P0";
  for (const finding of fixture.result.findings) {
    finding.feedbackDraft.body += `\n${"Synthetic retained detail; no real runtime evidence or model conclusion. ".repeat(350)}`;
  }
  await prepareFixture(imports[3].InvestigationStore);
  for (const [label, path] of Object.entries({
    node,
    processHost,
    git,
    cli,
    serverEntry,
    workerEntry,
    dashboardIndex: join(dashboardDirectory, "index.html"),
    harness: fileURLToPath(import.meta.url),
    syntheticCliSource: join(here, "synthetic-cli.go"),
    signalBridge: join(here, "ipc-signals.mjs"),
  })) {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be an ordinary prebuilt file.`);
    receipt.source[label] = { path, sha256: hash(await readFile(path)), byteLength: stat.size };
  }
  receipt.source.snapshot = await recordSourceManifest({
    repo,
    output,
    git,
    declaredBaseRevision: args.get("--source-revision"),
  });
  const accountIdentity = await execute(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 },
  );
  receipt.executionAccount = {
    observedWhoami: accountIdentity.stdout.trim(),
    impersonation: false,
  };
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  serverEnvironment = {
    ...baseEnvironment,
    INVESTIGATION_HOST: "127.0.0.1",
    INVESTIGATION_PORT: String(port),
    INVESTIGATION_PUBLIC_ORIGIN: origin,
    INVESTIGATION_DATABASE_PATH: database,
    INVESTIGATION_AUTH_DATABASE_PATH: authDatabase,
    INVESTIGATION_DASHBOARD_DIRECTORY: dashboardDirectory,
    INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "synthetic-admin",
    INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: password,
    INVESTIGATION_WORKERS_JSON: JSON.stringify([
      { id: "synthetic-worker", token, repositoryIds: [fixture.task.repository.id] },
    ]),
    INVESTIGATION_ENABLE_EXTERNAL_WRITES: "false",
  };
  workerEnvironment = {
    ...baseEnvironment,
    INVESTIGATION_WORKER_SERVER_URL: origin,
    INVESTIGATION_WORKER_TOKEN: token,
    INVESTIGATION_WORKER_ALLOW_INSECURE_HTTP: "true",
    INVESTIGATION_WORKER_DATA_DIRECTORY: data,
    INVESTIGATION_WORKER_TRUSTED_EXECUTABLE_ROOT: toolsRoot,
    INVESTIGATION_WORKER_PROCESS_HOST_PATH: processHost,
    INVESTIGATION_WORKER_PROCESS_HOST_SHA256: receipt.source.processHost.sha256,
    INVESTIGATION_WORKER_GIT_PATH: git,
    INVESTIGATION_WORKER_GIT_SHA256: receipt.source.git.sha256,
    INVESTIGATION_WORKER_CLI_PATH: cli,
    INVESTIGATION_WORKER_CLI_SHA256: receipt.source.cli.sha256,
    INVESTIGATION_WORKER_CLI_ENGINE: "codex",
    INVESTIGATION_WORKER_CLI_MODEL: "synthetic-no-model",
    INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON: "[]",
    INVESTIGATION_WORKER_SUPPORTED_KINDS_JSON: '["issue-investigate"]',
    INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON: JSON.stringify({
      USERPROFILE: profile,
      CODEX_HOME: home,
    }),
    INVESTIGATION_WORKER_STATIC_CONFIG_VERIFIED: "true",
    INVESTIGATION_WORKER_MAX_CONCURRENT_TASKS: "1",
    INVESTIGATION_WORKER_CLAIM_POLL_MS: "100",
    INVESTIGATION_WORKER_PROCESS_TIMEOUT_MS: "180000",
    INVESTIGATION_WORKER_MAX_MEMORY_BYTES: String(512 * 1024 * 1024),
    INVESTIGATION_WORKER_MAX_OUTPUT_BYTES: String(32 * 1024 * 1024),
    INVESTIGATION_WORKER_SHUTDOWN_TIMEOUT_MS: "30000",
    INVESTIGATION_WORKER_LOG_LEVEL: "info",
  };
  await json("configuration.json", {
    origin,
    externalWrites: false,
    githubConfigured: false,
    workerId: "synthetic-worker",
    allowedRepositories: [],
    taskKind: "issue-investigate",
    executionMode: "snapshot_only",
    syntheticCli: cli,
    dataDirectory: data,
  });
  server = await startServer("server-1");
  await login();
  const accounts = await request("GET", "/api/accounts");
  const account = accounts.items.find((entry) => entry.username === "synthetic-admin");
  assert(account, "The isolated bootstrap administrator must exist.");
  await request("POST", `/api/accounts/${account.id}/update`, {
    version: account.version,
    displayName: "Synthetic lifecycle administrator",
    enabled: true,
    isAdmin: true,
    repositoryIds: [fixture.task.repository.id],
    permissions: ["repository:manage", "task:create", "task:cancel"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  });
  await login();
  passed("production-password-account-and-explicit-task-permissions");
  const first = await createTask("consecutive-a");
  const second = await createTask("consecutive-b");
  worker = launch("worker-1", workerEntry, workerEnvironment);
  await waitTask(first, "completed");
  await verifyReport(first, "completed");
  await waitTask(second, "completed");
  await verifyReport(second, "completed");
  assert.equal(worker.exit, null, "The same Worker must remain alive across consecutive tasks.");
  await emptyAttempts();
  passed("two-consecutive-tasks-on-one-production-worker", { workerPid: worker.child.pid });

  const cancelled = await createTask("cancel-active", true);
  const cancelledTree = await waitHeld(cancelled, worker);
  await request("POST", `/api/tasks/${cancelled.id}/cancel`, {});
  await waitTask(cancelled, "cancelled");
  await verifyReport(cancelled, "cancelled");
  await emptyAttempts();
  await assertGone(
    cancelledTree.filter(
      (entry) =>
        entry.processId !== worker.child.pid &&
        entry.executablePath?.toLowerCase() !== processHost.toLowerCase(),
    ),
    "cancelled-cli-tree",
  );
  passed("active-cancellation-retains-partial-ledger-and-drains-cli-tree");

  const resumed = await createTask("restart-resume", true);
  const stoppedTree = await waitHeld(resumed, worker);
  await stop(worker);
  await waitTask(resumed, "interrupted");
  const beforeRestart = await request("GET", `/api/tasks/${resumed.id}`);
  const partial = await verifyReport(resumed, "interrupted");
  await emptyAttempts();
  await assertGone(stoppedTree, "stopped-worker-tree");
  await stop(server);
  passed("graceful-worker-server-stop-preserves-checkpoint-and-cleans-owned-processes");

  delete serverEnvironment.INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME;
  delete serverEnvironment.INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD;
  server = await startServer("server-2");
  await login();
  const restored = await request("GET", `/api/tasks/${resumed.id}`);
  assert.deepEqual(
    restored.checkpoint,
    beforeRestart.checkpoint,
    "Server restart must preserve the exact checkpoint.",
  );
  await request("POST", `/api/tasks/${resumed.id}/resume`, {
    idempotencyKey: "synthetic-resume-after-restart",
  });
  worker = launch("worker-2", workerEntry, workerEnvironment);
  await waitTask(resumed, "completed");
  const final = await verifyReport(resumed, "completed");
  assert.equal(
    final.result.context.adoptedAttemptIds.length,
    2,
    "Resume must retain both attempt identities.",
  );
  assert.notEqual(final.result.report.id, partial.result.report.id);
  const immutablePartial = await request(
    "GET",
    `/api/reports/${partial.result.report.id}/export`,
    undefined,
    true,
  );
  assert.equal(
    hash(immutablePartial.bytes),
    hash(partial.bytes),
    "The prior partial report must remain byte-identical.",
  );
  await emptyAttempts();
  passed("server-reopen-worker-restart-resume-with-immutable-partial-report");

  const finalTree = await snapshot(worker.child.pid);
  await stop(worker);
  await stop(server);
  await assertGone(finalTree, "final-worker-tree");
  await emptyAttempts();
  const observations = await readObservations();
  assert(observations.length >= 10, "Actual synthetic native CLI turns must be recorded.");
  assert.equal(observations.filter((entry) => entry.state === "held").length, 2);
  assert(observations.every((entry) => entry.synthetic === true && entry.realModel === false));
  await json("cli-observations.json", observations);
  await verifyStoredParts(imports[3].InvestigationStore);
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.failure = { name: error?.name ?? "Error", message: String(error?.message ?? error) };
  process.exitCode = 1;
} finally {
  for (const child of [...children].reverse()) {
    if (child.exit !== null) continue;
    try {
      await stop(child);
    } catch (error) {
      receipt.status = "failed";
      receipt.cleanupFailure = String(error?.message ?? error);
      process.exitCode = 1;
      // Never terminate by image name or touch an unrelated process. Preserve data on failure.
      child.child.kill("SIGKILL");
      await Promise.race([child.closed, pause(5_000)]);
    }
  }
  for (const stream of activeStreams) {
    try {
      await finished(stream);
    } catch (error) {
      receipt.status = "failed";
      receipt.logFailure = String(error?.message ?? error);
      process.exitCode = 1;
    }
  }
  receipt.finishedAt = new Date().toISOString();
  await json("receipt.json", receipt);
  await writeFile(join(output, "summary.md"), summary(), "utf8");
  console.log(
    JSON.stringify({
      status: receipt.status,
      receipt: join(output, "receipt.json"),
      checks: receipt.checks.length,
    }),
  );
}

function required(name) {
  const value = args.get(name);
  assert(value && isAbsolute(value), `${name} requires an absolute path.`);
  return value;
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function json(name, value) {
  await writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function pause(ms) {
  await new Promise((resolvePause) => setTimeout(resolvePause, ms));
}
async function ordinaryDirectory(path) {
  const state = await lstat(path);
  assert(
    state.isDirectory() &&
      !state.isSymbolicLink() &&
      (await realpath(path)).toLowerCase() === path.toLowerCase(),
    `Use an ordinary canonical directory: ${path}`,
  );
}
function passed(name, detail = {}) {
  receipt.checks.push({ name, status: "passed", ...detail });
  console.log(JSON.stringify({ check: name, status: "passed" }));
}
async function unusedPort() {
  const listener = createServer();
  await new Promise((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const port = listener.address().port;
  await new Promise((resolveClose) => listener.close(resolveClose));
  return port;
}

async function prepareFixture(Store) {
  const subject = fixture.task.subjects.find((entry) => entry.id === fixture.task.subjectRef);
  const item = {
    ...fixture.task.workItem,
    repositoryId: fixture.task.repository.id,
    subject,
    body: "Synthetic offline lifecycle acceptance with 137 retained reporter hypotheses. This input grants no upstream access or source execution.",
    state: "open",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
  const inputSnapshot = {
    schemaVersion: "InvestigationInputSnapshotV1",
    repositoryId: item.repositoryId,
    workItemId: item.id,
    subjectRef: subject.id,
    subjectRevisionKey: subject.revisionKey,
    title: item.title,
    body: item.body,
    comments: [],
    source: null,
  };
  assert(
    Value.Check(contracts.InvestigationInputSnapshotV1Schema, inputSnapshot),
    JSON.stringify([...Value.Errors(contracts.InvestigationInputSnapshotV1Schema, inputSnapshot)]),
  );
  const digest = domain.investigationContentDigest(inputSnapshot);
  const snapshotId = `snapshot:${digest}`;
  const pointerId = `current:${domain.investigationContentDigest({ repositoryId: item.repositoryId, workItemId: item.id, revisionKey: subject.revisionKey })}`;
  const store = new Store(database);
  try {
    store.transaction(() => {
      store.insert("repositories", fixture.task.repository.id, fixture.task.repository);
      store.insert("workItems", item.id, item);
      store.insert("sourceSnapshots", snapshotId, { id: snapshotId, digest, inputSnapshot });
      store.insert("sourceSnapshots", pointerId, { snapshotId });
    });
  } finally {
    store.close();
  }
  const result = fixture.result;
  const template = {
    summary:
      "All synthetic reporter hypotheses are retained; individual rechecks remain pending. No real model is running.",
    snapshotEvidenceId: result.verificationEvidence[0].id,
    assessment: result.assessment,
    findings: result.findings.map((finding) => ({
      ...finding,
      confirmation: { ...finding.confirmation, recheckRef: null },
    })),
    candidates: result.report.loop.candidates,
    evidence: result.verificationEvidence.map((entry) => ({
      id: entry.id,
      subjectRef: entry.subjectRef,
      source: "reporter_statement",
      summary: entry.summary,
      evidenceRefs: entry.evidenceRefs,
    })),
    plans: result.plans.map(
      ({ digest: _digest, state: _state, sourceReportRef: _source, ...plan }) => plan,
    ),
    nextActions: result.nextActions.map(
      ({ state: _state, sourceReportRef: _source, ...action }) => action,
    ),
    feedbackDrafts: result.feedbackDrafts,
    limitations: result.report.limitations,
  };
  await writeFile(join(home, "template.json"), JSON.stringify(template));
  await writeFile(join(home, "controls.json"), JSON.stringify(controls));
  await json("seed.json", {
    repository: fixture.task.repository,
    workItem: item,
    inputSnapshot,
    digest,
    synthetic: true,
  });
}

function launch(label, entry, environment) {
  const stdout = createWriteStream(join(output, `${label}.stdout.log`), { flags: "wx" });
  const stderr = createWriteStream(join(output, `${label}.stderr.log`), { flags: "wx" });
  activeStreams.push(stdout, stderr);
  for (const stream of [stdout, stderr])
    stream.on("error", (error) => {
      receipt.logFailure = error.message;
    });
  const child = fork(entry, [], {
    cwd: repo,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: [
      "--enable-source-maps",
      "--import",
      pathToFileURL(join(here, "ipc-signals.mjs")).href,
    ],
  });
  const state = { child, label, exit: null, closed: null };
  state.closed = new Promise((resolveClosed) => {
    child.once("error", (error) => {
      state.exit = { error: error.message };
    });
    child.once("exit", (code, signal) => {
      state.exit = { code, signal };
    });
    child.once("close", () => resolveClosed(state.exit));
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  receipt.processes.push({ label, pid: child.pid, entry });
  children.push(state);
  return state;
}
async function stop(state) {
  if (state.exit !== null) {
    await state.closed;
    assert.equal(state.exit.code, 0, `${state.label} exited unsuccessfully.`);
    return;
  }
  state.child.send({ type: "synthetic-acceptance-shutdown" });
  await until(async () => state.exit, `${state.label} graceful closure`, 45_000);
  await state.closed;
  assert.equal(state.exit.code, 0, `${state.label} must exit 0 after its actual shutdown handler.`);
  receipt.processes.find((entry) => entry.label === state.label).exit = state.exit;
}
async function startServer(label) {
  const state = launch(label, serverEntry, serverEnvironment);
  await until(
    async () => {
      if (state.exit !== null) throw new Error(`${label} exited before readiness.`);
      try {
        const response = await fetch(`${origin}/api/auth/session`, {
          signal: AbortSignal.timeout(1_000),
          redirect: "error",
        });
        return response.status === 200;
      } catch {
        return false;
      }
    },
    `${label} readiness`,
    30_000,
  );
  return state;
}
async function login() {
  const response = await request(
    "POST",
    "/api/auth/login",
    { username: "synthetic-admin", password },
    true,
  );
  cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert(cookie, "Real password login must issue the isolated session cookie.");
}
async function request(method, path, body, raw = false) {
  assert(path.startsWith("/api/") && !path.includes("://"));
  assert(
    !/\/action-intents|\/confirm|\/import-work-item/u.test(path),
    "This harness cannot invoke an upstream action or import.",
  );
  const response = await fetch(`${origin}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(
    response.ok,
    `${method} ${path} returned ${response.status}: ${bytes.toString("utf8").slice(0, 1_000)}`,
  );
  return raw
    ? { bytes, headers: response.headers, status: response.status }
    : JSON.parse(bytes.toString("utf8"));
}
async function createTask(label, hold = false) {
  // Install a fallback before dispatch so fast claiming cannot race the task-specific hold record.
  controls.holdUnknownTasks = hold;
  await writeControls();
  const task = await request("POST", "/api/tasks", {
    idempotencyKey: `synthetic-${label}`,
    workItemId: fixture.task.workItem.id,
    kind: "issue-investigate",
    executionMode: "snapshot_only",
    budget: {
      maxRounds: 64,
      maxDurationMs: 300_000,
      maxTokens: 1_000_000,
      maxReportBytes: 64 * 1024 * 1024,
    },
  });
  task.label = label;
  controls.tasks[task.id] = { holdAtRound: hold ? 2 : 0, attemptNumber: 1 };
  controls.holdUnknownTasks = false;
  await writeControls();
  tasks.push(task);
  return task;
}
async function writeControls() {
  const next = join(home, "controls.next.json");
  await writeFile(next, JSON.stringify(controls));
  await rename(next, join(home, "controls.json"));
}
async function until(predicate, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await pause(150);
  }
  throw new Error(`Timed out awaiting ${label}.`);
}
async function waitTask(task, expected) {
  return until(async () => {
    const detail = await request("GET", `/api/tasks/${task.id}`);
    if (detail.task.state === expected) return detail;
    if (
      ["completed", "failed", "cancelled", "interrupted", "blocked"].includes(detail.task.state)
    ) {
      await json(`${task.label}-unexpected-detail.json`, detail);
      throw new Error(`${task.label} became ${detail.task.state}, expected ${expected}.`);
    }
    if (worker?.exit !== null && worker?.exit !== undefined)
      throw new Error(`${worker.label} stopped before ${task.label} completed.`);
    return false;
  }, `${task.label} ${expected}`);
}
async function readObservations() {
  const entries = [];
  for (const file of await readdir(join(home, "observations"))) {
    if (!file.endsWith(".json")) continue;
    try {
      entries.push(JSON.parse(await readFile(join(home, "observations", file), "utf8")));
    } catch {
      /* Retry incomplete concurrent fixture markers on the next poll. */
    }
  }
  return entries;
}
async function waitHeld(task, runningWorker) {
  const observation = await until(
    async () =>
      (await readObservations()).find(
        (entry) => entry.taskId === task.id && entry.state === "held",
      ),
    `${task.label} held native CLI`,
  );
  const detail = await request("GET", `/api/tasks/${task.id}`);
  assert.equal(detail.checkpoint.round, 1);
  assert.equal(detail.checkpoint.analysis.findings.length, 137);
  const tree = await snapshot(runningWorker.child.pid);
  assert(
    tree.some((entry) => entry.processId === observation.pid),
    "The held CLI must be an owned native descendant.",
  );
  assert(
    tree.some((entry) => entry.processId === observation.childPid),
    "The synthetic nested child must be in the owned process tree.",
  );
  await json(`${task.label}-held-processes.json`, tree);
  return tree;
}
async function snapshot(rootPid) {
  const result = await execute(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(here, "process-snapshot.ps1"),
      "-RootProcessId",
      String(rootPid),
    ],
    { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(result.stdout.trim());
}
async function assertGone(identities, label) {
  const path = join(output, `${label}-identities.json`);
  await writeFile(path, JSON.stringify(identities));
  await until(
    async () => {
      const result = await execute(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(here, "process-snapshot.ps1"),
          "-IdentityPath",
          path,
        ],
        { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(result.stdout.trim()).length === 0;
    },
    `${label} exact process identities to exit`,
    30_000,
  );
}
async function emptyAttempts() {
  await until(
    async () => (await readdir(join(data, "attempts"))).length === 0,
    "owned attempt directory cleanup",
    30_000,
  );
}
async function verifyReport(task, outcome) {
  const detail = await request("GET", `/api/tasks/${task.id}`);
  const reportId = detail.task.latestReportRef?.id;
  assert(reportId, "Every completed or interrupted fixture attempt must retain a report.");
  const exported = await request("GET", `/api/reports/${reportId}/export`, undefined, true);
  const result = JSON.parse(exported.bytes.toString("utf8"));
  assert(
    Value.Check(contracts.InvestigationResultV1Schema, result),
    "The complete exported report must match its authoritative schema.",
  );
  assert.equal(result.outcome, outcome);
  assert.equal(result.report.completeness, outcome === "completed" ? "complete" : "partial");
  assert.equal(result.findings.length, 137);
  assert(exported.bytes.length > 2 * 1024 * 1024, "The complete report must exceed 2 MiB.");
  assert.deepEqual(
    result.findings.map((entry) => entry.id),
    fixture.result.findings.map((entry) => entry.id),
  );
  assert.equal(
    result.findings.at(-1).feedbackDraft.body,
    fixture.result.findings.at(-1).feedbackDraft.body,
  );
  assert.equal(result.findings.at(-1).priority, "P0");
  assert(result.findings.every((entry) => entry.confirmation.status === "hypothesis"));
  assert(
    result.verificationEvidence.every(
      (entry) =>
        entry.authority === "model" &&
        entry.source === "reporter_statement" &&
        entry.artifactRefs.length === 0,
    ),
  );
  assert.equal(result.verificationEvidence.length, 138);
  const evidenceIds = new Set(result.verificationEvidence.map((entry) => entry.id));
  for (const evidence of result.verificationEvidence)
    assert(evidence.evidenceRefs.every((id) => evidenceIds.has(id)));
  for (const finding of result.findings)
    assert(finding.evidenceRefs.every((id) => evidenceIds.has(id)));
  assert(result.validation.checks.every((entry) => entry.status === "not_run"));
  assert.equal(
    result.report.recheck.validFinalVersionRecheckCount,
    outcome === "completed" ? 137 : 0,
  );
  assert.equal(result.report.recheck.pendingFindingIds.length, outcome === "completed" ? 0 : 137);
  const pages = [];
  const pageIds = [];
  let cursor = null;
  do {
    const page = await request(
      "GET",
      `/api/reports/${reportId}/findings?limit=50${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    assert.equal(page.total, 137);
    assert.equal(page.offset, pageIds.length);
    pages.push(page.items.length);
    pageIds.push(...page.items.map((entry) => entry.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(pages, [50, 50, 37]);
  assert.deepEqual(
    pageIds,
    result.findings.map((entry) => entry.id),
  );
  await writeFile(join(output, `${task.label}-${outcome}-report.json`), exported.bytes);
  receipt.scenarios.push({
    label: task.label,
    taskId: task.id,
    reportId,
    outcome,
    findingCount: result.findings.length,
    evidenceCount: result.verificationEvidence.length,
    recheckedCount: result.report.recheck.validFinalVersionRecheckCount,
    reportBytes: exported.bytes.length,
    reportSha256: hash(exported.bytes),
    findingPages: pages,
    adoptedAttemptIds: result.context.adoptedAttemptIds,
  });
  return { result, bytes: exported.bytes };
}
async function verifyStoredParts(Store) {
  const store = new Store(database);
  try {
    const parts = store.list("reportParts");
    await json(
      "stored-report-parts.json",
      parts.map((entry) => ({
        id: entry.id,
        reportId: entry.reportId,
        collection: entry.collection,
        sequence: entry.sequence,
        itemCount: entry.items?.length,
        byteLength: Buffer.byteLength(JSON.stringify(entry)),
      })),
    );
    assert(parts.length > 0, "Production Worker report part submissions must be persisted.");
    for (const scenario of receipt.scenarios) {
      const reportParts = parts.filter((part) => part.reportId === scenario.reportId);
      const findingParts = reportParts.filter((part) => part.collection === "findings");
      assert(findingParts.length > 1, "The production report must use multiple finding parts.");
      assert.equal(
        findingParts.reduce((count, part) => count + part.items.length, 0),
        137,
      );
      for (const part of reportParts) {
        const { digest, ...content } = part;
        assert.equal(digest, domain.investigationContentDigest(content));
        assert.equal(part.itemCount, part.items.length);
        assert(Buffer.byteLength(JSON.stringify(part)) <= 256 * 1024);
      }
    }
    const intents = store.list("actionIntents");
    assert.equal(
      intents.length,
      0,
      "No action intent or external publication is part of this acceptance.",
    );
    passed("persisted-report-parts-and-zero-action-intents", { reportPartCount: parts.length });
  } finally {
    store.close();
  }
}
function summary() {
  return `# Synthetic Windows investigation lifecycle acceptance\n\nStatus: **${receipt.status}**.\n\nThe harness targets the prebuilt production Server and Worker entry points on Windows. The native CLI is an explicit offline synthetic fixture, with no model invocation, Git checkout, upstream import, or repository mutation. External writes are disabled, GitHub credentials absent, repository execution unauthorized, and the Worker checkout allowlist empty.\n\nOnly checks listed below have passed:\n\n${receipt.checks.map((entry) => `- Passed: ${entry.name}`).join("\n")}\n\nThe planned report checks cover 137 hypotheses, a report larger than 2 MiB, all three findings pages, reporter-evidence reference integrity, cancellation, retained partial results, an exact checkpoint across Server restart, and resume under a new Worker. Refer to receipt.json for the scenarios actually reached. Native process identities include creation time to avoid mistaking a reused PID for an owned survivor.\n\nGraceful stop uses the private acceptance IPC bridge to invoke the product's existing SIGTERM handlers. SCM/console signal delivery, hard crashes, real models, runtime artifact upload, real Git operations, UI scenarios, Linux production deployment, and capacity are outside this receipt.\n\n${receipt.failure ? `Failure: ${receipt.failure.message}\n\n` : ""}Isolated databases, logs, source/binary identities, process observations, reports, and receipt.json are retained in this new output directory. No automatic recursive deletion is performed.\n`;
}
