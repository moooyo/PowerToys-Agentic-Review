import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
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
  assert(
    name?.startsWith("--") && value && !args.has(name),
    "Use distinct --name value argument pairs.",
  );
  args.set(name, value);
}
assert.equal(process.platform, "win32", "Run only on the authorized remote Windows worker.");
assert.equal(
  args.get("--static-config-verified"),
  "true",
  "The operator must verify the real CLI's static policy and disabled unmanaged tools before execution.",
);
const repo = pathArgument("--repo-root");
const toolsRoot = pathArgument("--tools-root");
const output = pathArgument("--output");
const fixturePath = pathArgument("--fixture");
const modelEnvironmentPath = pathArgument("--model-environment");
const processHost = pathArgument("--process-host");
const git = pathArgument("--git");
const configuredCli = pathArgument("--cli");
let cli = configuredCli;
const engine = args.get("--cli-engine") ?? "codex";
const workerPath = args.get("--worker-path");
assert(
  workerPath === undefined ||
    (workerPath.length > 0 && workerPath.trim() === workerPath && !/[\0\r\n]/u.test(workerPath)),
  "--worker-path must be a non-empty single-line trusted executable search path.",
);
assert(["codex", "copilot"].includes(engine));
assert(
  !inside(repo, output) && !inside(toolsRoot, output) && !inside(output, toolsRoot),
  "Place new acceptance output outside source and trusted tools.",
);
assert(inside(toolsRoot, processHost) && inside(toolsRoot, git));
await directory(repo);
await directory(toolsRoot);
await directory(dirname(output));
await mkdir(output);

const receipt = {
  schemaVersion: "RealCliInvestigationAcceptanceV1",
  status: "running",
  realModelRequested: true,
  realModel: false,
  realGitHubMutation: false,
  startedAt: new Date().toISOString(),
  scope: {
    taskKind: "issue-investigate",
    executionMode: "snapshot_only",
    workerEntry: "apps/worker/dist/worker.mjs",
    serverEntry: "apps/server/dist/main.js",
    serverPlatform: "Windows isolated acceptance; not Linux production acceptance",
    externalWrites: false,
    githubCredentialConfigured: false,
    checkoutAllowlist: [],
    exclusions: [
      "model quality scoring",
      "source execution",
      "runtime artifacts",
      "GitHub publication",
      "UI",
      "hard-crash recovery",
      "SCM signal delivery",
    ],
  },
  source: {},
  checks: [],
  processes: [],
};
const children = [];
const streams = [];
const token = randomBytes(32).toString("base64url");
const password = `acceptance-${randomBytes(24).toString("base64url")}`;
const baseEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP)$/iu.test(key),
  ),
);
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const data = join(output, "worker-data");
const database = join(output, "investigation.sqlite");
let origin;
let cookie = "";
let worker;
let server;

try {
  const contracts = await import(
    pathToFileURL(join(repo, "packages", "contracts", "dist", "index.js")).href
  );
  const domain = await import(
    pathToFileURL(join(repo, "packages", "domain", "dist", "index.js")).href
  );
  const { InvestigationStore } = await import(
    pathToFileURL(join(repo, "apps", "server", "dist", "investigation", "store.js")).href
  );
  const requireServer = createRequire(join(repo, "apps", "server", "package.json"));
  const { Value } = requireServer("@sinclair/typebox/value");
  const { FormatRegistry } = requireServer("@sinclair/typebox");
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
  const fixtureBytes = await readFile(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  assert.equal(fixture.schemaVersion, "FrozenPublicIssueAcceptanceV1");
  const { repository, workItem, inputSnapshot, capture } = fixture;
  assert.equal(capture.repositoryVisibility, "public");
  assert.equal(capture.readOnly, true);
  assert(Number.isFinite(Date.parse(capture.capturedAt)));
  assert.equal(capture.url, `https://github.com/${repository.fullName}/issues/${workItem.number}`);
  assert(Value.Check(contracts.InvestigationInputSnapshotV1Schema, inputSnapshot));
  assert.equal(
    inputSnapshot.source,
    null,
    "This real-model acceptance permits a frozen Issue snapshot only.",
  );
  assert.equal(workItem.kind, "issue");
  assert.equal(workItem.subject.kind, "issue_snapshot");
  assert.equal(workItem.repositoryId, repository.id);
  assert.equal(inputSnapshot.repositoryId, repository.id);
  assert.equal(inputSnapshot.workItemId, workItem.id);
  assert.equal(inputSnapshot.subjectRef, workItem.subject.id);
  assert.equal(inputSnapshot.subjectRevisionKey, workItem.subject.revisionKey);
  assert.equal(inputSnapshot.title, workItem.title);
  assert.equal(inputSnapshot.body, workItem.body);
  assert.equal(
    workItem.subject.snapshotDigest,
    domain.investigationContentDigest({
      title: inputSnapshot.title,
      body: inputSnapshot.body,
      comments: inputSnapshot.comments,
    }),
  );
  await writeFile(join(output, "frozen-public-issue.json"), fixtureBytes);
  receipt.source.issue = {
    url: capture.url,
    capturedAt: capture.capturedAt,
    fixtureSha256: hash(fixtureBytes),
    commentCount: inputSnapshot.comments.length,
  };

  const environmentBytes = await readFile(modelEnvironmentPath);
  const modelEnvironment = JSON.parse(environmentBytes.toString("utf8"));
  assert(
    modelEnvironment && !Array.isArray(modelEnvironment) && typeof modelEnvironment === "object",
  );
  const allowedNames = new Set([
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "CODEX_HOME",
    "COPILOT_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
  ]);
  for (const [key, value] of Object.entries(modelEnvironment)) {
    assert(
      allowedNames.has(key) &&
        typeof value === "string" &&
        value.trim() === value &&
        value.length > 0 &&
        !/[\0\r\n]/u.test(value),
      "The explicit CLI environment may contain only documented non-secret account paths and locale values.",
    );
  }
  assert(
    modelEnvironment.USERPROFILE &&
      modelEnvironment[engine === "codex" ? "CODEX_HOME" : "COPILOT_HOME"],
  );
  let disabledMcpServers = [];
  if (args.has("--disabled-mcp-servers")) {
    disabledMcpServers = JSON.parse(await readFile(pathArgument("--disabled-mcp-servers"), "utf8"));
    assert(
      Array.isArray(disabledMcpServers) &&
        disabledMcpServers.every((name) => typeof name === "string" && name.length > 0),
    );
  }
  const serverEntry = join(repo, "apps", "server", "dist", "main.js");
  const workerEntry = join(repo, "apps", "worker", "dist", "worker.mjs");
  // Match the production verifier: resolve an installed CLI alias and execute its measured target.
  cli = await realpath(configuredCli);
  for (const [name, path] of Object.entries({
    node: process.execPath,
    processHost,
    git,
    cli,
    serverEntry,
    workerEntry,
    harness: fileURLToPath(import.meta.url),
    signalBridge: join(here, "ipc-signals.mjs"),
    dashboardIndex: join(repo, "apps", "dashboard", "dist", "index.html"),
  })) {
    const state = await lstat(path);
    assert(state.isFile() && !state.isSymbolicLink());
    receipt.source[name] = { path, sha256: hash(await readFile(path)), byteLength: state.size };
  }
  receipt.source.cli.configuredPath = configuredCli;
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
    environmentPathsDoNotChangeWindowsToken: true,
  };
  const version = await execute(cli, ["--version"], {
    cwd: repo,
    env: { ...baseEnvironment, ...modelEnvironment },
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 64 * 1024,
  });
  receipt.cli = {
    engine,
    configuredModel: args.get("--cli-model") ?? null,
    explicitWorkerPath: workerPath ?? null,
    version: version.stdout.trim().split(/\r?\n/u)[0],
    modelIdentityIndependentlyVerified: false,
    accountEnvironmentSha256: hash(environmentBytes),
    accountConfigurationReadOrCopied: false,
    staticConfigurationDeclaredVerified: true,
    disabledMcpServers,
  };
  assert(
    receipt.cli.version && receipt.cli.version.length <= 128,
    "The configured real CLI must expose a bounded version.",
  );
  assert(
    !/synthetic/iu.test(receipt.cli.version),
    "A synthetic CLI cannot satisfy this real-model companion.",
  );

  const snapshotDigest = domain.investigationContentDigest(inputSnapshot);
  const snapshotId = `snapshot:${snapshotDigest}`;
  const store = new InvestigationStore(database);
  try {
    store.transaction(() => {
      store.insert("repositories", repository.id, repository);
      store.insert("workItems", workItem.id, workItem);
      store.insert("sourceSnapshots", snapshotId, {
        id: snapshotId,
        digest: snapshotDigest,
        inputSnapshot,
      });
      store.insert(
        "sourceSnapshots",
        `current:${domain.investigationContentDigest({ repositoryId: repository.id, workItemId: workItem.id, revisionKey: workItem.subject.revisionKey })}`,
        { snapshotId },
      );
    });
  } finally {
    store.close();
  }
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  const maxDurationMs = positiveArgument("--max-duration-ms", 600_000, 60_000, 3_600_000);
  const maxRounds = positiveArgument("--max-rounds", 16, 2, 64);
  const maxTokens = positiveArgument("--max-tokens", 200_000, 1_000, 2_000_000);
  const budget = { maxRounds, maxDurationMs, maxTokens, maxReportBytes: 32 * 1024 * 1024 };
  receipt.budget = budget;
  server = launch("server", serverEntry, {
    ...baseEnvironment,
    INVESTIGATION_HOST: "127.0.0.1",
    INVESTIGATION_PORT: String(port),
    INVESTIGATION_PUBLIC_ORIGIN: origin,
    INVESTIGATION_DATABASE_PATH: database,
    INVESTIGATION_AUTH_DATABASE_PATH: join(output, "accounts.sqlite"),
    INVESTIGATION_DASHBOARD_DIRECTORY: join(repo, "apps", "dashboard", "dist"),
    INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "acceptance-admin",
    INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: password,
    INVESTIGATION_WORKERS_JSON: JSON.stringify([
      { id: "real-cli-acceptance-worker", token, repositoryIds: [repository.id] },
    ]),
    INVESTIGATION_ENABLE_EXTERNAL_WRITES: "false",
  });
  await until(
    async () => {
      if (server.exit !== null) throw new Error("The production Server failed before readiness.");
      try {
        return (
          await fetch(`${origin}/api/auth/session`, {
            redirect: "error",
            signal: AbortSignal.timeout(1_000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    "Server readiness",
    30_000,
  );
  await login();
  const accounts = await request("GET", "/api/accounts");
  const account = accounts.items.find((entry) => entry.username === "acceptance-admin");
  assert(account);
  await request("POST", `/api/accounts/${account.id}/update`, {
    version: account.version,
    displayName: "Real CLI acceptance administrator",
    enabled: true,
    isAdmin: true,
    repositoryIds: [repository.id],
    permissions: ["repository:manage", "task:create", "task:cancel"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  });
  await login();
  passed("production-password-login-and-explicit-snapshot-task-permission");
  const task = await request("POST", "/api/tasks", {
    idempotencyKey: "frozen-public-issue-real-cli",
    workItemId: workItem.id,
    kind: "issue-investigate",
    executionMode: "snapshot_only",
    budget,
  });
  receipt.taskId = task.id;
  worker = launch("worker", workerEntry, {
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
    INVESTIGATION_WORKER_CLI_ENGINE: engine,
    ...(workerPath === undefined ? {} : { INVESTIGATION_WORKER_PATH: workerPath }),
    ...(args.has("--cli-model") ? { INVESTIGATION_WORKER_CLI_MODEL: args.get("--cli-model") } : {}),
    INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON: "[]",
    INVESTIGATION_WORKER_SUPPORTED_KINDS_JSON: '["issue-investigate"]',
    INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON: JSON.stringify(modelEnvironment),
    INVESTIGATION_WORKER_STATIC_CONFIG_VERIFIED: "true",
    INVESTIGATION_WORKER_DISABLED_MCP_SERVERS_JSON: JSON.stringify(disabledMcpServers),
    INVESTIGATION_WORKER_CLAIM_POLL_MS: "200",
    INVESTIGATION_WORKER_PROCESS_TIMEOUT_MS: String(maxDurationMs),
    INVESTIGATION_WORKER_MAX_MEMORY_BYTES: String(2 * 1024 * 1024 * 1024),
    INVESTIGATION_WORKER_MAX_OUTPUT_BYTES: String(32 * 1024 * 1024),
    INVESTIGATION_WORKER_SHUTDOWN_TIMEOUT_MS: "60000",
  });
  let lastProgress = "";
  const detail = await until(
    async () => {
      const current = await request("GET", `/api/tasks/${task.id}`);
      const progress = JSON.stringify({
        state: current.task.state,
        round: current.checkpoint?.round ?? 0,
        findings: current.checkpoint?.analysis.findings.length ?? 0,
      });
      if (progress !== lastProgress) {
        console.log(progress);
        lastProgress = progress;
      }
      if (
        ["completed", "failed", "blocked", "cancelled", "interrupted"].includes(current.task.state)
      )
        return current;
      if (worker.exit !== null)
        throw new Error("The real Worker exited before a terminal task outcome.");
      return false;
    },
    "real CLI investigation terminal result",
    maxDurationMs + 120_000,
  );
  await json("task-detail.json", detail);
  receipt.outcome = detail.task.state;
  receipt.consumed = detail.checkpoint?.consumed ?? null;
  receipt.realModel = (detail.checkpoint?.consumed.rounds ?? 0) > 0;
  receipt.realModelEvidence = receipt.realModel
    ? "The configured real CLI returned accepted analysis rounds; remote model identity is not independently verified."
    : "No analysis round from the configured real CLI was accepted; invocation success is not established.";
  if (detail.task.latestReportRef !== null) {
    const exportResponse = await request(
      "GET",
      `/api/reports/${detail.task.latestReportRef.id}/export`,
      undefined,
      true,
    );
    await writeFile(join(output, "report.json"), exportResponse.bytes);
    const result = JSON.parse(exportResponse.bytes.toString("utf8"));
    assert(
      Value.Check(contracts.InvestigationResultV1Schema, result),
      "The real model report must match the shared contract.",
    );
    const validation = contracts.validateInvestigationResult(result);
    assert(validation.valid, JSON.stringify(validation));
    assert.equal(result.outcome, detail.task.state);
    const ids = [];
    let cursor = null;
    do {
      const page = await request(
        "GET",
        `/api/reports/${result.report.id}/findings?limit=50${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      assert.equal(page.total, result.findings.length);
      assert.equal(page.offset, ids.length);
      ids.push(...page.items.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(
      ids,
      result.findings.map((entry) => entry.id),
    );
    receipt.report = {
      id: result.report.id,
      sha256: hash(exportResponse.bytes),
      byteLength: exportResponse.bytes.length,
      findings: result.findings.length,
      evidence: result.verificationEvidence.length,
      completeness: result.report.completeness,
      modelQualityEvaluated: false,
    };
    passed("real-cli-output-contract-complete-export-and-pagination");
  }
  assert.equal(
    detail.task.state,
    "completed",
    "A partial or failed actual-model outcome remains failed acceptance with its original evidence.",
  );
  assert.equal(receipt.report?.completeness, "complete");
  assert(
    detail.checkpoint.consumed.rounds >= 2,
    "The production discovery/finalization loop must actually execute.",
  );
  const nativeTree = await processSnapshot(worker.child.pid);
  await json("worker-process-identities.json", nativeTree);
  await until(
    async () => (await readdir(join(data, "attempts"))).length === 0,
    "owned attempt cleanup",
    30_000,
  );
  await stop(worker);
  await stop(server);
  const survivors = await execute(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(here, "process-snapshot.ps1"),
      "-IdentityPath",
      join(output, "worker-process-identities.json"),
    ],
    { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(JSON.parse(survivors.stdout.trim()).length, 0);
  const closed = new InvestigationStore(database);
  try {
    assert.equal(closed.list("actionIntents").length, 0);
  } finally {
    closed.close();
  }
  passed("owned-cleanup-graceful-stop-and-zero-action-intents");
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
      child.child.kill("SIGKILL");
      await Promise.race([child.closed, pause(5_000)]);
    }
  }
  for (const stream of streams) {
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
  await writeFile(
    join(output, "summary.md"),
    `# Real CLI frozen Issue acceptance\n\nStatus: **${receipt.status}**.\n\nOnly the following checks passed:\n\n${receipt.checks.map((name) => `- ${name}`).join("\n")}\n\nThis isolated Windows exercise uses the real configured CLI and the production Task/Report entries. The input is a previously frozen public Issue snapshot. The Server has no GitHub credential, external writes are disabled, and the account/Worker cannot execute repository source or create upstream actions. Model provider traffic remains owned by the installed CLI.\n\n${receipt.failure ? `Failure: ${receipt.failure.message}\n\n` : ""}Report contract/execution correctness does not establish model quality or independently verified remote model identity. No UI, source execution, runtime artifact upload, publication, Linux production deployment, or hard-crash acceptance is claimed. The private IPC signal bridge is described in the harness README.\n`,
    "utf8",
  );
  console.log(JSON.stringify({ status: receipt.status, receipt: join(output, "receipt.json") }));
}

function pathArgument(name) {
  const value = args.get(name);
  assert(value && isAbsolute(value), `${name} requires an absolute path.`);
  return resolve(value);
}
function positiveArgument(name, fallback, minimum, maximum) {
  const value = args.has(name) ? Number(args.get(name)) : fallback;
  assert(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${name} is outside its bounds.`,
  );
  return value;
}
function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
async function directory(path) {
  const state = await lstat(path);
  assert(
    state.isDirectory() &&
      !state.isSymbolicLink() &&
      (await realpath(path)).toLowerCase() === path.toLowerCase(),
  );
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function json(name, value) {
  await writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function passed(name) {
  receipt.checks.push(name);
  console.log(JSON.stringify({ check: name, status: "passed" }));
}
async function pause(ms) {
  await new Promise((resolvePause) => setTimeout(resolvePause, ms));
}
async function until(predicate, label, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await pause(500);
  }
  throw new Error(`Timed out awaiting ${label}.`);
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
function launch(label, entry, environment) {
  const stdout = createWriteStream(join(output, `${label}.stdout.log`), { flags: "wx" });
  const stderr = createWriteStream(join(output, `${label}.stderr.log`), { flags: "wx" });
  streams.push(stdout, stderr);
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
    child.once("close", () => resolveClosed());
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  receipt.processes.push({ label, pid: child.pid, entry });
  children.push(state);
  return state;
}
async function stop(state) {
  if (state.exit === null) {
    state.child.send({ type: "synthetic-acceptance-shutdown" });
    await until(async () => state.exit, `${state.label} shutdown`, 90_000);
  }
  await state.closed;
  assert.equal(state.exit.code, 0);
  receipt.processes.find((entry) => entry.label === state.label).exit = state.exit;
}
async function login() {
  const response = await request(
    "POST",
    "/api/auth/login",
    { username: "acceptance-admin", password },
    true,
  );
  cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert(cookie);
}
async function request(method, path, body, raw = false) {
  assert(
    path.startsWith("/api/") &&
      !path.includes("://") &&
      !/\/action-intents|\/confirm|\/import-work-item/u.test(path),
    "Upstream actions/import are outside this companion.",
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
    `${method} ${path}: HTTP ${response.status}, ${bytes.toString("utf8").slice(0, 1_000)}`,
  );
  return raw ? { bytes, headers: response.headers } : JSON.parse(bytes.toString("utf8"));
}
async function processSnapshot(rootPid) {
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
