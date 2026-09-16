import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  assert(name?.startsWith("--") && value && !args.has(name), "Use distinct --name value pairs.");
  args.set(name, value);
}
assert.equal(process.platform, "win32", "Run only on the authorized Windows worker.");
assert.equal(
  args.get("--previous-processes-stopped"),
  "true",
  "The operator must first confirm the previous Server and Worker have stopped. This companion never cancels an active prior run.",
);
assert.equal(
  args.get("--static-config-verified"),
  "true",
  "Retain the verified CLI static policy and unmanaged-tool restrictions.",
);
const repo = pathArgument("--repo-root");
const toolsRoot = pathArgument("--tools-root");
const previousRun = pathArgument("--previous-run");
const output = pathArgument("--output");
const passwordPath = pathArgument("--admin-password-path");
const resetReceiptPath = pathArgument("--admin-reset-receipt");
const modelEnvironmentPath = pathArgument("--model-environment");
const processHost = pathArgument("--process-host");
const git = pathArgument("--git");
const configuredCli = pathArgument("--cli");
const taskId = args.get("--task-id");
assert(typeof taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(taskId));
assert(
  !inside(previousRun, output) &&
    !inside(output, previousRun) &&
    !inside(repo, output) &&
    !inside(toolsRoot, output),
  "The new proof directory must be separate from prior evidence, source, and tools.",
);
assert(inside(toolsRoot, processHost) && inside(toolsRoot, git));
for (const path of [repo, toolsRoot, previousRun, dirname(output)]) await directory(path);
await mkdir(output);
const database = join(previousRun, "investigation.sqlite");
const authDatabase = join(previousRun, "accounts.sqlite");
const data = join(previousRun, "worker-data");
const invocationId = randomBytes(12).toString("hex");
const receipt = {
  schemaVersion: "RealCliTaskResumeAcceptanceV1",
  status: "running",
  invocationId,
  startedAt: new Date().toISOString(),
  previousRun,
  taskId,
  originalDatabasesReused: true,
  databasesCopied: false,
  priorReceiptsModified: false,
  offlineAdminResetPerformedByCompanion: false,
  previousProcessesDeclaredStopped: true,
  externalWrites: false,
  githubCredentialConfigured: false,
  realModel: false,
  scope: { taskKind: "issue-investigate", executionMode: "snapshot_only" },
  source: {},
  checks: [],
  processes: [],
};
const streams = [];
const children = [];
const workerToken = randomBytes(32).toString("base64url");
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
let password;
let origin;
let cookie = "";
let server;
let worker;

try {
  for (const path of [database, authDatabase, passwordPath, resetReceiptPath]) {
    const state = await lstat(path);
    assert(
      state.isFile() && !state.isSymbolicLink(),
      "Existing databases and explicit recovery inputs must be ordinary files.",
    );
  }
  const previousReceiptBytes = await readFile(join(previousRun, "receipt.json"));
  const previousReceipt = JSON.parse(previousReceiptBytes.toString("utf8"));
  assert.equal(previousReceipt.schemaVersion, "RealCliInvestigationAcceptanceV1");
  assert.equal(previousReceipt.taskId, taskId);
  assert(
    previousReceipt.finishedAt && ["failed", "passed"].includes(previousReceipt.status),
    "Wait for the original harness to finish writing its receipt.",
  );
  assert(
    previousReceipt.processes?.length >= 2 &&
      previousReceipt.processes.every((entry) => entry.exit?.code === 0),
    "The original receipt must confirm both owned entries closed successfully.",
  );
  receipt.source.previousReceiptSha256 = sha256(previousReceiptBytes);
  const resetBytes = await readFile(resetReceiptPath);
  const reset = JSON.parse(resetBytes.toString("utf8"));
  assert.equal(reset.event, "administrator_password_reset");
  assert.equal(reset.username, "acceptance-admin");
  const original = readOriginalState();
  assert.equal(original.account.id, reset.accountId);
  assert.equal(original.account.version, reset.version);
  assert.equal(original.account.enabled, 1);
  assert.equal(original.account.is_admin, 1);
  assert.equal(original.task.id, taskId);
  assert.equal(original.task.kind, "issue-investigate");
  assert.equal(original.task.executionPolicy.mode, "snapshot_only");
  assert(
    ["blocked", "failed", "cancelled", "interrupted"].includes(original.task.state),
    "Only the original incomplete terminal task can be resumed; queued/running work is never cancelled by this companion.",
  );
  assert(
    original.checkpoint &&
      original.attempts.length > 0 &&
      original.attempts.every((entry) => entry.attempt.state !== "running"),
  );
  assertReportHistory(original.task, original.reports);
  const deliveryOnly = original.checkpoint.stopReason === "complete";
  receipt.resumeMode = deliveryOnly ? "delivery_only" : "analysis_continuation";
  if (deliveryOnly)
    assert(
      !original.reports.some(
        (report) =>
          report.context.attempt.id === original.checkpoint.attemptId &&
          report.outcome === "completed",
      ),
      "An already sealed complete attempt does not require delivery recovery.",
    );
  assert.equal(original.actionIntentCount, 0);
  assert.equal(
    original.otherActiveTaskCount,
    0,
    "The reused fixture database must have no other queued or running task.",
  );
  const latestAttempt = original.attempts.at(-1);
  const workerId = latestAttempt.attempt.workerId;
  assert(typeof workerId === "string" && workerId.length > 0);
  assert.deepEqual(
    await readdir(join(data, "attempts")),
    [],
    "Prior workspace cleanup must be confirmed before a new attempt starts.",
  );
  const contracts = await import(
    pathToFileURL(join(repo, "packages", "contracts", "dist", "index.js")).href
  );
  const domain = await import(
    pathToFileURL(join(repo, "packages", "domain", "dist", "index.js")).href
  );
  const requireServer = createRequire(join(repo, "apps", "server", "package.json"));
  const { Value } = requireServer("@sinclair/typebox/value");
  const { FormatRegistry } = requireServer("@sinclair/typebox");
  FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  FormatRegistry.Set("uri", (value) => URL.canParse(value));
  password = await readFile(passwordPath, "utf8");
  assert(
    Value.Check(contracts.InvestigationNewPasswordSchema, password),
    "Use the same exact password bytes as the native offline reset.",
  );
  const environmentBytes = await readFile(modelEnvironmentPath);
  assert.equal(
    sha256(environmentBytes),
    previousReceipt.cli.accountEnvironmentSha256,
    "Resume must retain the original explicit CLI account environment file.",
  );
  const modelEnvironment = JSON.parse(environmentBytes.toString("utf8"));
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
  for (const [key, value] of Object.entries(modelEnvironment))
    assert(
      allowedNames.has(key) &&
        typeof value === "string" &&
        value.length > 0 &&
        value.trim() === value &&
        !/[\0\r\n]/u.test(value),
    );
  const engine = args.get("--cli-engine") ?? previousReceipt.cli.engine;
  const configuredModel = args.get("--cli-model") ?? previousReceipt.cli.configuredModel;
  const workerPath =
    args.get("--worker-path") ?? previousReceipt.cli.explicitWorkerPath ?? undefined;
  assert.equal(engine, previousReceipt.cli.engine);
  assert.equal(configuredModel, previousReceipt.cli.configuredModel);
  assert.equal(workerPath ?? null, previousReceipt.cli.explicitWorkerPath ?? null);
  assert(
    workerPath === undefined ||
      (workerPath.length > 0 && workerPath.trim() === workerPath && !/[\0\r\n]/u.test(workerPath)),
  );
  const disabledMcpServers = previousReceipt.cli.disabledMcpServers;
  assert(
    Array.isArray(disabledMcpServers) &&
      disabledMcpServers.every((value) => typeof value === "string"),
  );
  const cli = await realpath(configuredCli);
  const serverEntry = join(repo, "apps", "server", "dist", "main.js");
  const workerEntry = join(repo, "apps", "worker", "dist", "worker.mjs");
  for (const [name, path] of Object.entries({
    node: process.execPath,
    cli,
    processHost,
    git,
    serverEntry,
    workerEntry,
    harness: fileURLToPath(import.meta.url),
    signalBridge: join(here, "ipc-signals.mjs"),
  })) {
    receipt.source[name] = { path, sha256: sha256(await readFile(path)) };
  }
  assert.equal(
    receipt.source.cli.sha256,
    previousReceipt.source.cli.sha256,
    "Resume uses the same configured real CLI executable.",
  );
  receipt.source.snapshot = await recordSourceManifest({
    repo,
    output,
    git,
    declaredBaseRevision: args.get("--source-revision"),
  });
  receipt.account = {
    id: original.account.id,
    username: original.account.username,
    resetVersion: reset.version,
    resetReceiptSha256: sha256(resetBytes),
  };
  receipt.cli = {
    engine,
    configuredModel,
    explicitWorkerPath: workerPath ?? null,
    accountEnvironmentSha256: sha256(environmentBytes),
    disabledMcpServers,
    modelIdentityIndependentlyVerified: false,
  };
  const originalInputDigest = domain.investigationContentDigest(original.frozenInput);
  receipt.frozenInputDigest = originalInputDigest;
  const beforeFindingIds = original.checkpoint.analysis.findings.map((entry) => entry.id);
  const beforePlanIds = original.checkpoint.analysis.plans.map((entry) => entry.id);
  assert(
    beforeFindingIds.length > 0,
    "The existing useful finding ledger must be retained, not replaced with a fresh task.",
  );
  await json("before-offline-state.json", {
    task: original.task,
    checkpoint: original.checkpoint,
    attempts: original.attempts.map((entry) => entry.attempt),
    account: original.account,
    sourceInputDigest: originalInputDigest,
    findingIds: beforeFindingIds,
    planIds: beforePlanIds,
  });
  const budget = {
    maxRounds: integerArgument(
      "--max-rounds",
      deliveryOnly ? original.task.budget.maxRounds : 12,
      1,
      64,
    ),
    maxDurationMs: integerArgument(
      "--max-duration-ms",
      deliveryOnly ? original.task.budget.maxDurationMs : 3_600_000,
      60_000,
      3_600_000,
    ),
    maxTokens: integerArgument(
      "--max-tokens",
      deliveryOnly
        ? original.task.budget.maxTokens
        : Math.max(
            250_000,
            original.task.budget.maxTokens,
            original.checkpoint.consumed.tokens + 50_000,
          ),
      1,
      2_000_000,
    ),
    maxReportBytes: original.task.budget.maxReportBytes,
  };
  for (const [key, value] of Object.entries(original.task.budget))
    assert(
      budget[key] >= value,
      "A native resume must not decrease any existing cumulative budget.",
    );
  if (!deliveryOnly) {
    assert(budget.maxTokens >= 250_000);
    assert(
      budget.maxRounds > original.checkpoint.consumed.rounds &&
        budget.maxDurationMs > original.checkpoint.consumed.durationMs &&
        budget.maxTokens > original.checkpoint.consumed.tokens,
      "The proposed bounded budget must leave actual remaining capacity.",
    );
  }
  receipt.previousBudget = original.task.budget;
  receipt.resumedBudget = budget;
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  server = launch("server", serverEntry, {
    ...baseEnvironment,
    INVESTIGATION_HOST: "127.0.0.1",
    INVESTIGATION_PORT: String(port),
    INVESTIGATION_PUBLIC_ORIGIN: origin,
    INVESTIGATION_DATABASE_PATH: database,
    INVESTIGATION_AUTH_DATABASE_PATH: authDatabase,
    INVESTIGATION_DASHBOARD_DIRECTORY: join(repo, "apps", "dashboard", "dist"),
    INVESTIGATION_WORKERS_JSON: JSON.stringify([
      { id: workerId, token: workerToken, repositoryIds: [original.task.repository.id] },
    ]),
    INVESTIGATION_ENABLE_EXTERNAL_WRITES: "false",
  });
  await until(
    async () => {
      if (server.exit !== null) throw new Error("Server stopped before readiness.");
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
  assert.equal(account?.id, original.account.id);
  await request("POST", `/api/accounts/${account.id}/update`, {
    version: account.version,
    displayName: account.displayName,
    enabled: true,
    isAdmin: true,
    repositoryIds: [...new Set([...account.repositoryIds, original.task.repository.id])],
    permissions: [...new Set([...account.permissions, "task:create", "task:cancel"])],
    actionCapabilities: account.actionCapabilities,
    allowRepositoryExecution: account.allowRepositoryExecution,
  });
  await login();
  const before = await request("GET", `/api/tasks/${taskId}`);
  assert.deepEqual(before.task, original.task);
  assert.deepEqual(before.checkpoint, original.checkpoint);
  assert(before.attempts.every((entry) => entry.state !== "running"));
  const priorReports = [];
  const originalExportBytes = await readOptionalOrdinaryFile(join(previousRun, "report.json"));
  const originalExport =
    originalExportBytes === null ? null : JSON.parse(originalExportBytes.toString("utf8"));
  if (originalExport !== null) {
    assert.equal(originalExport.context.task.id, taskId);
    assert.equal(
      originalExport.report.id,
      before.task.latestReportRef?.id,
      "An existing prior export must match the latest sealed database report.",
    );
  }
  receipt.source.previousReportFileSha256 =
    originalExportBytes === null ? null : sha256(originalExportBytes);
  receipt.priorReportHistory = {
    sealedReportCount: original.reports.length,
    latestReportRef: before.task.latestReportRef,
    originalExportPresent: originalExportBytes !== null,
    fabricatedPriorReport: false,
  };
  for (const report of original.reports) {
    const exported = await request(
      "GET",
      `/api/reports/${report.report.id}/export`,
      undefined,
      true,
    );
    if (report.report.id === originalExport?.report.id)
      assert.equal(sha256(exported.bytes), receipt.source.previousReportFileSha256);
    priorReports.push({
      id: report.report.id,
      sha256: sha256(exported.bytes),
      byteLength: exported.bytes.length,
    });
  }
  await json("prior-report-byte-hashes.json", priorReports);
  const budgetUnchanged =
    domain.investigationContentDigest(budget) ===
    domain.investigationContentDigest(before.task.budget);
  const resumeRequest = {
    idempotencyKey: `real-cli-resume-${invocationId}`,
    ...(budgetUnchanged ? {} : { budget }),
  };
  await json("resume-request.json", resumeRequest);
  await request("POST", `/api/tasks/${taskId}/resume`, resumeRequest);
  const queued = await request("GET", `/api/tasks/${taskId}`);
  assert.equal(queued.task.state, "queued");
  assert.deepEqual(frozenTask(queued.task), frozenTask(before.task));
  assert.deepEqual(queued.checkpoint.analysis, before.checkpoint.analysis);
  assert.deepEqual(queued.checkpoint.runtime, before.checkpoint.runtime);
  assert.equal(queued.checkpoint.round, before.checkpoint.round);
  if (deliveryOnly) {
    assert.equal(queued.checkpoint.stopReason, "complete");
    if (budgetUnchanged) assert.deepEqual(queued.checkpoint, before.checkpoint);
  }
  await json("after-resume-before-worker.json", queued);
  passed("same-task-native-resume-preserves-source-references-complete-finding-ledger-and-runtime");
  worker = launch("worker", workerEntry, {
    ...baseEnvironment,
    INVESTIGATION_WORKER_SERVER_URL: origin,
    INVESTIGATION_WORKER_TOKEN: workerToken,
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
    ...(configuredModel === null ? {} : { INVESTIGATION_WORKER_CLI_MODEL: configuredModel }),
    ...(workerPath === undefined ? {} : { INVESTIGATION_WORKER_PATH: workerPath }),
    INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON: "[]",
    INVESTIGATION_WORKER_SUPPORTED_KINDS_JSON: '["issue-investigate"]',
    INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON: JSON.stringify(modelEnvironment),
    INVESTIGATION_WORKER_STATIC_CONFIG_VERIFIED: "true",
    INVESTIGATION_WORKER_DISABLED_MCP_SERVERS_JSON: JSON.stringify(disabledMcpServers),
    INVESTIGATION_WORKER_CLAIM_POLL_MS: "200",
    INVESTIGATION_WORKER_PROCESS_TIMEOUT_MS: String(budget.maxDurationMs),
    INVESTIGATION_WORKER_MAX_MEMORY_BYTES: String(2 * 1024 * 1024 * 1024),
    INVESTIGATION_WORKER_MAX_OUTPUT_BYTES: String(32 * 1024 * 1024),
    INVESTIGATION_WORKER_SHUTDOWN_TIMEOUT_MS: "60000",
  });
  let progress = "";
  const final = await until(
    async () => {
      const current = await request("GET", `/api/tasks/${taskId}`);
      const next = JSON.stringify({
        state: current.task.state,
        round: current.checkpoint?.round,
        findings: current.checkpoint?.analysis.findings.length,
      });
      if (next !== progress) {
        console.log(next);
        progress = next;
      }
      if (
        ["completed", "blocked", "failed", "cancelled", "interrupted"].includes(current.task.state)
      )
        return current;
      if (worker.exit !== null)
        throw new Error("The resumed Worker stopped before the task became terminal.");
      return false;
    },
    "resumed task outcome",
    deliveryOnly ? 120_000 : budget.maxDurationMs - before.checkpoint.consumed.durationMs + 120_000,
  );
  await json("after-task-detail.json", final);
  receipt.outcome = final.task.state;
  receipt.realModel = final.checkpoint.round > before.checkpoint.round;
  receipt.checkpointBefore = {
    id: before.checkpoint.id,
    version: before.checkpoint.version,
    digest: before.checkpoint.digest,
    round: before.checkpoint.round,
  };
  receipt.checkpointAfter = {
    id: final.checkpoint.id,
    version: final.checkpoint.version,
    digest: final.checkpoint.digest,
    round: final.checkpoint.round,
  };
  assert.deepEqual(frozenTask(final.task), frozenTask(before.task));
  if (deliveryOnly) {
    assert.equal(final.checkpoint.stopReason, "complete");
    assert.equal(final.checkpoint.round, before.checkpoint.round);
    assert.deepEqual(final.checkpoint.analysis, before.checkpoint.analysis);
    assert.deepEqual(final.checkpoint.runtime, before.checkpoint.runtime);
    assert.deepEqual(final.checkpoint.consumed, queued.checkpoint.consumed);
    assert.deepEqual(final.checkpoint.budget, queued.checkpoint.budget);
    assert.equal(final.checkpoint.lastPhase, before.checkpoint.lastPhase);
    assert.equal(final.checkpoint.taskBindingDigest, queued.checkpoint.taskBindingDigest);
    assert.equal(final.checkpoint.consumed.rounds, before.checkpoint.consumed.rounds);
    assert.equal(final.checkpoint.consumed.tokens, before.checkpoint.consumed.tokens);
    assert.equal(receipt.realModel, false);
    receipt.deliveryOnlyVerification = {
      passed: false,
      originalStopReason: before.checkpoint.stopReason,
      finalStopReason: final.checkpoint.stopReason,
      modelRoundsBefore: before.checkpoint.consumed.rounds,
      modelRoundsAfter: final.checkpoint.consumed.rounds,
      newModelRounds: 0,
      newModelTokens: 0,
      analysisUnchanged: true,
      runtimeUnchanged: true,
      observation:
        "The production complete-checkpoint delivery path retained its accepted analysis, runtime, model-round count, and token consumption.",
    };
  }
  for (const prior of priorReports) {
    const current = await request("GET", `/api/reports/${prior.id}/export`, undefined, true);
    assert.equal(
      sha256(current.bytes),
      prior.sha256,
      "A historical report must remain byte-identical after resume.",
    );
  }
  if (final.task.latestReportRef !== null) {
    const exported = await request(
      "GET",
      `/api/reports/${final.task.latestReportRef.id}/export`,
      undefined,
      true,
    );
    await writeFile(join(output, "resumed-report.json"), exported.bytes, { flag: "wx" });
    const result = JSON.parse(exported.bytes.toString("utf8"));
    assert(Value.Check(contracts.InvestigationResultV1Schema, result));
    assert(contracts.validateInvestigationResult(result).valid);
    receipt.report = {
      id: result.report.id,
      sha256: sha256(exported.bytes),
      byteLength: exported.bytes.length,
      completeness: result.report.completeness,
      findingIds: result.findings.map((entry) => entry.id),
      priorFindingIds: beforeFindingIds,
      priorPlanIds: beforePlanIds,
      adoptedAttemptIds: result.context.adoptedAttemptIds,
    };
    receipt.report.originalFindingDisposition = beforeFindingIds.map((id) => {
      if (receipt.report.findingIds.includes(id))
        return { id, disposition: "retained_in_final_findings" };
      const originalOwners = original.checkpoint.analysis.candidates.filter(
        (entry) => entry.findingId === id,
      );
      assert(
        originalOwners.length > 0,
        "An original finding cannot disappear without its retained candidate history.",
      );
      const retainedOwners = originalOwners.map((owner) =>
        result.report.loop.candidates.find((entry) => entry.id === owner.id),
      );
      assert(
        retainedOwners.every(
          (owner) =>
            owner &&
            ["withdrawn", "merged"].includes(owner.status) &&
            owner.rationale.length > 0 &&
            owner.evidenceRefs.length > 0,
        ),
        "A changed final finding set requires complete explicit withdrawal/merge records, never silent loss.",
      );
      return { id, disposition: "explicit_withdrawal_or_merge", candidates: retainedOwners };
    });
    for (const id of beforePlanIds)
      assert(
        result.plans.some((entry) => entry.id === id),
        "Resume must retain the existing saved plan identities.",
      );
    assert(
      !priorReports.some((prior) => prior.id === result.report.id),
      "Recovery must seal a new report without overwriting historical reports.",
    );
  }
  await until(
    async () => (await readdir(join(data, "attempts"))).length === 0,
    "resumed workspace cleanup",
    30_000,
  );
  const nativeTree = await processSnapshot(worker.child.pid);
  await json("owned-process-identities.json", nativeTree);
  await stop(worker);
  await stop(server);
  const after = readOriginalState();
  assertReportHistory(after.task, after.reports);
  const oldAttemptIds = new Set(original.attempts.map((entry) => entry.attempt.id));
  const newAttempts = after.attempts.filter((entry) => !oldAttemptIds.has(entry.attempt.id));
  assert.equal(
    newAttempts.length,
    1,
    "The companion must create exactly one new attempt of the original task.",
  );
  assert.equal(newAttempts[0].attempt.workerId, workerId);
  assert.deepEqual(after.checkpoint.adoptedAttemptIds, [
    ...original.checkpoint.adoptedAttemptIds,
    newAttempts[0].attempt.id,
  ]);
  if (receipt.report !== undefined) {
    const recovered = after.reports.find((report) => report.report.id === receipt.report.id);
    assert(recovered);
    assert.equal(recovered.report.id, newAttempts[0].reportId);
    assert.equal(recovered.context.attempt.id, newAttempts[0].attempt.id);
    assert.equal(recovered.context.attempt.number, newAttempts[0].attempt.number);
    assert.deepEqual(recovered.context.adoptedAttemptIds, after.checkpoint.adoptedAttemptIds);
    receipt.newAttempt = {
      id: newAttempts[0].attempt.id,
      number: newAttempts[0].attempt.number,
      workerId,
      reportId: recovered.report.id,
    };
  }
  assert.equal(domain.investigationContentDigest(after.frozenInput), originalInputDigest);
  assert.equal(after.actionIntentCount, 0);
  assert.equal(
    sha256(await readFile(join(previousRun, "receipt.json"))),
    receipt.source.previousReceiptSha256,
  );
  const retainedExportBytes = await readOptionalOrdinaryFile(join(previousRun, "report.json"));
  assert.equal(
    retainedExportBytes === null ? null : sha256(retainedExportBytes),
    receipt.source.previousReportFileSha256,
    "The original export must remain byte-identical, or remain absent if none was ever written.",
  );
  await assertGone();
  passed("report-history-consistency-source-input-and-original-worker-identity-preserved");
  assert.equal(
    final.task.state,
    "completed",
    "An incomplete resumed attempt remains failed acceptance with its original evidence.",
  );
  assert.equal(receipt.report?.completeness, "complete");
  assert.equal(after.reports.length, original.reports.length + 1);
  if (deliveryOnly) {
    receipt.deliveryOnlyVerification.passed = true;
    passed("complete-checkpoint-delivered-without-model-rerun-or-analysis-change");
  }
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.failure = safeError(error);
  process.exitCode = 1;
} finally {
  for (const child of [...children].reverse()) {
    if (child.exit !== null) continue;
    try {
      await stop(child);
    } catch (error) {
      receipt.status = "failed";
      receipt.cleanupFailure = safeError(error);
      process.exitCode = 1;
      child.child.kill("SIGKILL");
      await Promise.race([child.closed, pause(5_000)]);
    }
  }
  for (const stream of streams) {
    try {
      await withDeadline(finished(stream), 10_000);
    } catch (error) {
      receipt.status = "failed";
      receipt.logFailure = safeError(error);
      process.exitCode = 1;
    }
  }
  receipt.finishedAt = new Date().toISOString();
  await json("receipt.json", receipt);
  console.log(JSON.stringify({ status: receipt.status, receipt: join(output, "receipt.json") }));
}

function readOriginalState() {
  const db = new DatabaseSync(database, { readOnly: true });
  const accounts = new DatabaseSync(authDatabase, { readOnly: true });
  try {
    const decode = (row) => (row === undefined ? undefined : JSON.parse(row.value));
    const task = decode(db.prepare("SELECT value FROM tasks WHERE id = ?").get(taskId));
    const checkpoint = decode(db.prepare("SELECT value FROM checkpoints WHERE id = ?").get(taskId));
    const frozenInput = decode(
      db.prepare("SELECT value FROM idempotency WHERE id = ?").get(`input:${taskId}`),
    );
    const attempts = db
      .prepare("SELECT value FROM attempts")
      .all()
      .map(decode)
      .filter((entry) => entry.attempt.taskId === taskId)
      .sort((left, right) => left.attempt.number - right.attempt.number);
    const reports = db
      .prepare("SELECT value FROM reports")
      .all()
      .map(decode)
      .filter((entry) => entry.context.task.id === taskId);
    const account = accounts
      .prepare(
        "SELECT id, username, enabled, is_admin, version FROM investigation_password_accounts WHERE username = ?",
      )
      .get("acceptance-admin");
    const actionIntentCount = Number(
      db.prepare("SELECT count(*) AS count FROM actionIntents").get().count,
    );
    const otherActiveTaskCount = db
      .prepare("SELECT value FROM tasks")
      .all()
      .map(decode)
      .filter((entry) => entry.id !== taskId && ["queued", "running"].includes(entry.state)).length;
    assert(task && checkpoint && frozenInput && account);
    return {
      task,
      checkpoint,
      frozenInput,
      attempts,
      reports,
      account,
      actionIntentCount,
      otherActiveTaskCount,
    };
  } finally {
    accounts.close();
    db.close();
  }
}
function assertReportHistory(task, reports) {
  assert.equal(new Set(reports.map((report) => report.report.id)).size, reports.length);
  for (const report of reports) {
    assert.equal(report.context.task.id, task.id);
    assert.equal(report.context.repository.id, task.repository.id);
    assert.equal(report.context.workItem.id, task.workItem.id);
  }
  if (task.latestReportRef === null) {
    assert.equal(
      reports.length,
      0,
      "A null latestReportRef must not hide an existing sealed task report.",
    );
    return;
  }
  const latest = reports.find((report) => report.report.id === task.latestReportRef.id);
  assert(latest, "The latest report reference must identify a sealed report of this task.");
  assert.equal(latest.report.version, task.latestReportRef.version);
  assert.equal(latest.report.logicalContentDigest, task.latestReportRef.digest);
  assert(
    reports.every((report) => report.context.attempt.number <= latest.context.attempt.number),
    "The task must reference its latest sealed attempt report.",
  );
}
async function readOptionalOrdinaryFile(path) {
  let state;
  try {
    state = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  assert(
    state.isFile() && !state.isSymbolicLink(),
    "An existing prior report export must be an ordinary file.",
  );
  return readFile(path);
}
function frozenTask(task) {
  const {
    budget: _budget,
    state: _state,
    updatedAt: _updatedAt,
    latestReportRef: _latestReport,
    ...frozen
  } = task;
  return frozen;
}
function pathArgument(name) {
  const value = args.get(name);
  assert(value && isAbsolute(value), `${name} requires an absolute path.`);
  return resolve(value);
}
function integerArgument(name, fallback, minimum, maximum) {
  const value = args.has(name) ? Number(args.get(name)) : fallback;
  assert(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${name} is outside the bounded range.`,
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
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function json(name, value) {
  await writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
function passed(name) {
  receipt.checks.push(name);
  console.log(JSON.stringify({ check: name, status: "passed" }));
}
async function pause(ms) {
  await new Promise((done) => setTimeout(done, ms));
}
async function until(predicate, label, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await pause(500);
  }
  throw new Error(`Timed out awaiting ${label}.`);
}
async function withDeadline(operation, timeout) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_done, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned log closure exceeded its deadline.")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function unusedPort() {
  const socket = createServer();
  await new Promise((done, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", done);
  });
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}
function launch(label, entry, environment) {
  const stdout = createWriteStream(join(output, `${label}.stdout.log`), { flags: "wx" });
  const stderr = createWriteStream(join(output, `${label}.stderr.log`), { flags: "wx" });
  streams.push(stdout, stderr);
  for (const stream of [stdout, stderr])
    stream.on("error", () => {
      receipt.logFailure = "An owned log stream failed.";
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
  const running = { child, label, exit: null, closed: null };
  running.closed = new Promise((done) => {
    child.once("error", () => {
      running.exit = { error: "Entry startup failed." };
    });
    child.once("exit", (code, signal) => {
      running.exit = { code, signal };
    });
    child.once("close", done);
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  children.push(running);
  receipt.processes.push({ label, pid: child.pid, entry });
  return running;
}
async function stop(running) {
  if (running.exit === null) {
    running.child.send({ type: "synthetic-acceptance-shutdown" });
    await until(async () => running.exit, `${running.label} shutdown`, 90_000);
  }
  await running.closed;
  assert.equal(running.exit.code, 0);
  receipt.processes.find((entry) => entry.label === running.label).exit = running.exit;
}
async function login() {
  const result = await request(
    "POST",
    "/api/auth/login",
    { username: "acceptance-admin", password },
    true,
  );
  cookie = result.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert(cookie);
}
async function request(method, path, body, raw = false) {
  assert(
    path.startsWith("/api/") &&
      !path.includes("://") &&
      !/\/action-intents|\/confirm|\/import-work-item|\/cancel/u.test(path),
  );
  if (method === "POST" && path.startsWith("/api/tasks/"))
    assert.equal(path, `/api/tasks/${taskId}/resume`);
  assert(
    !(method === "POST" && path === "/api/tasks"),
    "Creating a replacement task is prohibited.",
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
  assert(response.ok, `Local resume request ${method} ${path} returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
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
async function assertGone() {
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
      join(output, "owned-process-identities.json"),
    ],
    { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  assert.deepEqual(JSON.parse(result.stdout.trim()), []);
}
function safeError(error) {
  const message = String(error?.message ?? error);
  return {
    name: error?.name ?? "Error",
    message: [password, workerToken]
      .filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), message)
      .slice(0, 2_000),
  };
}
