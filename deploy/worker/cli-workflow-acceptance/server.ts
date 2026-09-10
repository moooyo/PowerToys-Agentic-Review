import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { ServerConfig } from "../../../apps/server/dist/config.js";
import { DatabaseClient } from "../../../apps/server/dist/database/database-client.js";
import { bindOperatorDatabase } from "../../../apps/server/dist/database/operator-database.js";
import { registerWorkerEvidenceRoutes } from "../../../apps/server/dist/routes/evidence-assets.js";
import { registerValidationSummaryInputRoutes } from "../../../apps/server/dist/routes/validation-summary-inputs.js";
import { registerWorkerRoutes } from "../../../apps/server/dist/routes/workers.js";
import { canonicalJson } from "../../../apps/server/dist/scheduling/canonical-json.js";

// This opt-in harness creates only owned synthetic repository records. It imports production
// Server modules without bundling DatabaseClient, whose sibling Worker entry must stay intact.
interface Input {
  schemaVersion: "CliWorkflowAcceptanceInputV1";
  nonce: string;
  engine: "codex" | "copilot";
  nodeExecutablePath: string;
  baseSha: string;
  headSha: string;
  repoFullName: string;
  serverDirectory: string;
  migrationsDirectory: string;
  readyFilePath: string;
  workerNodeId: string;
  workerToken: string;
  controlToken: string;
  fixtureCheckScript: string;
  reviewPrompt: string;
  maximumRunMs: number;
}
type Phase = "ordinary" | "evaluation" | "complete" | "failed";
type Stage = "ordinary" | "baseline" | "candidate";
interface JobSelection {
  stage: Stage;
  jobId: string;
  runId: string;
  requestId: string;
  cellId?: string;
}
interface StoredAttempt {
  jobId: string;
  jobState: string;
  failureCode: string | null;
  failureMessage: string | null;
  attemptId: string | null;
  workerNodeId: string | null;
  workerInstanceId: string | null;
  attemptState: string | null;
  phase: string | null;
  startedAt: string | null;
  endedAt: string | null;
  resultId: string | null;
  resultDigest: string | null;
  resultJson: string | null;
  executionJson: string;
}
interface AttemptSummary {
  stage: Stage;
  jobId: string;
  runId: string;
  requestId: string;
  attemptId: string | null;
  workerInstanceId: string | null;
  jobState: string;
  attemptState: string | null;
  modelState: string | null;
  resultId: string | null;
  resultDigest: string | null;
  success: boolean;
  terminal: boolean;
  quality: {
    sourceState: string | null;
    assessment: string | null;
    findingCount: number;
    findings: unknown[];
    checks: unknown[];
    cli: unknown;
    commandCapture: string | null;
    modelError: unknown;
  };
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const terminalStates = new Set(["succeeded", "failed", "dead_letter", "cancelled", "stale"]);
const actor: C.OperatorPrincipal = {
  issuer: "https://m39.acceptance.invalid",
  subject: "owned-cli-workflow-acceptance",
};
const reviewer = { githubUserId: 39001, login: "fixture-reviewer", accountType: "user" } as const;
const policy: C.SelfOrAllowlistPolicy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: reviewer.githubUserId,
  allowlistedActorGithubUserIds: [],
  unknownActorPolicy: "deny",
  newRevisionPolicy: "require_new_authorization",
};

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 4096): string {
  assert.equal(typeof value, "string", `${label} must be a string.`);
  const result = value as string;
  assert.ok(result.length > 0 && result.length <= maximum && !result.includes("\0"), label);
  return result;
}
async function readInput(path: string): Promise<Input> {
  const bytes = await readFile(path);
  assert.ok(bytes.length <= 512 * 1024, "The private harness input is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The private harness input must contain valid JSON.");
  }
  const value = object(parsed);
  assert.equal(value.schemaVersion, "CliWorkflowAcceptanceInputV1");
  assert.ok(value.engine === "codex" || value.engine === "copilot");
  const input: Input = {
    schemaVersion: "CliWorkflowAcceptanceInputV1",
    engine: value.engine,
    nonce: text(value.nonce, "nonce", 64),
    nodeExecutablePath: text(value.nodeExecutablePath, "nodeExecutablePath"),
    baseSha: text(value.baseSha, "baseSha", 40),
    headSha: text(value.headSha, "headSha", 40),
    repoFullName: text(value.repoFullName, "repoFullName", 256),
    serverDirectory: text(value.serverDirectory, "serverDirectory"),
    migrationsDirectory: text(value.migrationsDirectory, "migrationsDirectory"),
    readyFilePath: text(value.readyFilePath, "readyFilePath"),
    workerNodeId: text(value.workerNodeId, "workerNodeId", 128),
    workerToken: text(value.workerToken, "workerToken", 128),
    controlToken: text(value.controlToken, "controlToken", 256),
    fixtureCheckScript: text(value.fixtureCheckScript, "fixtureCheckScript", 256),
    reviewPrompt: text(value.reviewPrompt, "reviewPrompt", 128 * 1024),
    maximumRunMs: value.maximumRunMs === undefined ? 900_000 : Number(value.maximumRunMs),
  };
  assert.match(input.nonce, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  assert.match(input.workerNodeId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.ok(
    /^arw1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(input.workerToken),
    "The Worker credential is invalid.",
  );
  assert.ok(
    /^[A-Za-z0-9_-]{32,256}$/u.test(input.controlToken),
    "The control credential is invalid.",
  );
  assert.match(input.baseSha, /^[a-f0-9]{40}$/u);
  assert.match(input.headSha, /^[a-f0-9]{40}$/u);
  assert.notEqual(input.baseSha, input.headSha);
  assert.match(input.repoFullName, /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u);
  assert.match(input.nodeExecutablePath, /^[A-Za-z]:\\.+\.exe$/iu);
  assert.match(input.fixtureCheckScript, /^[A-Za-z0-9][A-Za-z0-9._/-]*\.mjs$/u);
  assert.ok(!input.fixtureCheckScript.split("/").includes(".."));
  for (const path of [input.serverDirectory, input.migrationsDirectory, input.readyFilePath]) {
    assert.ok(isAbsolute(path) && !path.includes("\\") && !path.split("/").includes(".."));
  }
  assert.ok(
    !input.serverDirectory.startsWith("/mnt/"),
    "SQLite must stay on the WSL Linux filesystem.",
  );
  assert.ok(
    Number.isSafeInteger(input.maximumRunMs) &&
      input.maximumRunMs >= 60_000 &&
      input.maximumRunMs <= 3_600_000,
  );
  return input;
}
function errorRecord(error: unknown, input: Input) {
  const original = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const message = original
    .replaceAll(input.workerToken, "[REDACTED]")
    .replaceAll(input.controlToken, "[REDACTED]");
  return { message: message.slice(0, 4096), at: new Date().toISOString() };
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function parsedResult(value: string | null): Record<string, unknown> | null {
  return value === null ? null : object(JSON.parse(value));
}

class AcceptanceServer {
  readonly shutdown = new AbortController();
  readonly jobs: JobSelection[] = [];
  readonly recordedResults = new Set<string>();
  readonly databasePath: string;
  readonly startedAt = new Date().toISOString();
  database?: DatabaseClient;
  operator?: Pick<DatabaseClient, "request">;
  app?: FastifyInstance;
  phase: Phase = "ordinary";
  failure: ReturnType<typeof errorRecord> | null = null;
  repositoryId = "";
  workItemId = "";
  ordinaryRunId = "";
  evaluationId: string | null = null;
  summaries: AttemptSummary[] = [];
  assessment: unknown = null;
  preview: unknown = null;
  stopping = false;
  tickTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
  pendingTick: Promise<void> = Promise.resolve();
  closePromise?: Promise<void>;
  ownsDirectory = false;
  constructor(readonly input: Input) {
    this.databasePath = join(input.serverDirectory, "database", "server.sqlite");
  }
  private owner(): DatabaseClient {
    assert.ok(this.database, "The database owner has not started.");
    return this.database;
  }
  private admin(): Pick<DatabaseClient, "request"> {
    assert.ok(this.operator, "The operator transport has not started.");
    return this.operator;
  }
  private async event(value: unknown): Promise<void> {
    const serialized = JSON.stringify(value)
      .replaceAll(this.input.workerToken, "[REDACTED]")
      .replaceAll(this.input.controlToken, "[REDACTED]");
    await appendFile(join(this.input.serverDirectory, "events.jsonl"), `${serialized}\n`);
  }
  async start(): Promise<void> {
    await mkdir(this.input.serverDirectory, { mode: 0o700 });
    this.ownsDirectory = true;
    assert.equal(await realpath(this.input.serverDirectory), this.input.serverDirectory);
    assert.equal((await lstat(this.input.serverDirectory)).mode & 0o777, 0o700);
    for (const name of ["home", "tmp", "database", "evidence", "results"])
      await mkdir(join(this.input.serverDirectory, name), { mode: 0o700 });
    await writeFile(join(this.input.serverDirectory, "events.jsonl"), "", {
      flag: "wx",
      mode: 0o600,
    });
    this.deadlineTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.fail(
            new Error("The acceptance session exceeded maximumRunMs before Server closure."),
          );
        } catch (error) {
          this.stopFailed(error);
        }
        await this.stop("maximum_run_deadline");
      })().catch((error: unknown) => this.stopFailed(error));
    }, this.input.maximumRunMs);
    await writeJson(join(this.input.serverDirectory, "scope.json"), {
      schemaVersion: "M39CliWorkflowScopeV1",
      nonce: this.input.nonce,
      engine: this.input.engine,
      baseSha: this.input.baseSha,
      headSha: this.input.headSha,
      repoFullName: this.input.repoFullName,
      nodeExecutablePath: this.input.nodeExecutablePath,
      startedAt: this.startedAt,
      externalRepositoryWrites: false,
      modelServiceAccess: "Owned by the configured CLI on the Windows Worker.",
    });
    this.database = await DatabaseClient.create({
      databasePath: this.databasePath,
      migrationsDirectory: this.input.migrationsDirectory,
      startupTimeoutMilliseconds: 30_000,
      operatorAccess: { administrators: [actor] },
      evidenceStorage: {
        evidenceDirectory: join(this.input.serverDirectory, "evidence"),
        globalQuotaBytes: 256 * 1024 * 1024,
        globalAssetLimit: 1024,
        retentionMs: 24 * 60 * 60 * 1000,
        incompleteUploadTtlMs: 60 * 60 * 1000,
      },
    });
    if (this.stopping) {
      await this.database.close();
      throw new Error("The acceptance Server was stopped during database startup.");
    }
    await chmod(this.databasePath, 0o600);
    this.operator = bindOperatorDatabase(this.database, actor);
    await this.bootstrap();
    assert.ok(!this.stopping, "The acceptance Server was stopped during configuration.");
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      recoveryMaintenance: false,
      databasePath: this.databasePath,
      migrationsDirectory: this.input.migrationsDirectory,
      protocolVersion: "1.0",
      heartbeatIntervalSeconds: 1,
      leaseTtlSeconds: 120,
      leaseReaperIntervalSeconds: 15,
      operatorAuthCleanupIntervalSeconds: 300,
      operatorAuthCleanupBatchSize: 100,
      retryDelaySeconds: 1,
      workerOfflineAfterSeconds: 120,
      maxLongPollSeconds: 1,
      allowInsecureHttp: true,
      tls: undefined,
      github: undefined,
      operatorAuth: undefined,
      dashboardDirectory: undefined,
    };
    const app = Fastify({ logger: false, forceCloseConnections: true });
    this.app = app;
    app.addHook("onResponse", async (request, reply) => {
      await this.event({
        at: new Date().toISOString(),
        method: request.method,
        path: request.url,
        status: reply.statusCode,
      });
    });
    registerWorkerRoutes(app, {
      database: this.database,
      config,
      shutdownSignal: this.shutdown.signal,
    });
    registerWorkerEvidenceRoutes(app, {
      database: this.database,
      config,
      shutdownSignal: this.shutdown.signal,
    });
    registerValidationSummaryInputRoutes(app, {
      database: this.database,
      config,
      shutdownSignal: this.shutdown.signal,
    });
    app.register(async (control) => {
      control.addHook("onRequest", async (request, reply) => {
        const provided = Buffer.from(request.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${this.input.controlToken}`);
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip);
        if (!local || provided.length !== expected.length || !timingSafeEqual(provided, expected))
          return reply.code(401).send({ error: "Acceptance control authentication is required." });
        reply.header("cache-control", "no-store");
      });
      control.get("/__acceptance/status", async () => this.status());
      control.post("/__acceptance/stop", async (_request, reply) => {
        reply.send({ stopping: true });
        setImmediate(() => {
          void this.stop("control_stop").catch((error: unknown) => this.stopFailed(error));
        });
      });
    });
    const serverUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    assert.ok(!this.stopping, "The acceptance Server was stopped before readiness.");
    const ready = {
      schemaVersion: "CliWorkflowAcceptanceReadyV1",
      nonce: this.input.nonce,
      engine: this.input.engine,
      workerNodeId: this.input.workerNodeId,
      serverUrl,
      processId: process.pid,
      repositoryId: this.repositoryId,
      workItemId: this.workItemId,
      ordinaryRunId: this.ordinaryRunId,
    };
    await writeJson(this.input.readyFilePath, ready);
    await writeJson(join(this.input.serverDirectory, "ready.json"), ready);
    this.scheduleTick();
  }
  private prompt(stage: Stage): string {
    return [
      this.input.reviewPrompt,
      `This is the ${stage} configuration of the owned local CLI workflow fixture.`,
      "Review only this prepared fixture. Do not modify files, contact repository services, run git push, or create or edit any PR or issue.",
      "Keep model conclusions separate from the deterministic Worker check results.",
    ].join("\n\n");
  }
  private async publishConfiguration(stage: Stage) {
    const config: C.ValidationProfileConfig = {
      schemaVersion: "ValidationProfileV1",
      setup: [],
      test: [],
      launch: [],
      cleanup: [],
      build: [
        {
          id: `check-${stage}`,
          name: `Fixture check ${stage}`,
          required: true,
          timeoutMs: 30_000,
          command: {
            executable: "node",
            args: [this.input.fixtureCheckScript],
            workingDirectory: ".",
            environment: [],
          },
        },
      ],
      requiredCapabilities: [],
      hardTimeoutMs: 300_000,
      noProgressTimeoutMs: 120_000,
    };
    const profile = await this.admin().request("publishValidationProfile", {
      repositoryId: this.repositoryId,
      actor,
      request: {
        name: `M39 ${stage} ${this.input.nonce}`,
        workflowKind: "pr_static_build",
        target: "headless",
        required: true,
        config,
        outputSchemaVersion: "PrReviewPlanV2",
      },
    });
    const template = await this.admin().request("createPromptTemplate", {
      actor,
      request: {
        name: `M39 ${stage} ${this.input.nonce}`,
        workflowKind: "pr_static_build",
        content: this.prompt(stage),
        outputSchemaVersion: "PrReviewPlanV2",
      },
    });
    const prompt = await this.admin().request("publishPromptDraft", {
      actor,
      templateId: template.id,
      request: { expectedVersion: template.version },
    });
    return {
      profile,
      prompt,
      selection: { profileVersionId: profile.id, promptVersionId: prompt.id },
    };
  }
  private async bootstrap(): Promise<void> {
    const githubRepositoryId = 39001;
    await this.owner().request("bootstrapManagedRepositories", {
      repositories: [{ githubRepositoryId, fullName: this.input.repoFullName }],
      reviewer,
      authorizationPolicy: policy,
    });
    const repository = await this.owner().request("getManagedRepositoryByGitHubId", {
      githubRepositoryId,
    });
    assert.ok(repository);
    this.repositoryId = repository.id;
    const ordinary = await this.publishConfiguration("ordinary");
    await this.admin().request("savePromptBinding", {
      repositoryId: repository.id,
      workflowKind: "pr_static_build",
      actor,
      request: { expectedVersion: 0, promptVersionId: ordinary.prompt.id },
    });
    await this.admin().request("saveValidationProfileBinding", {
      repositoryId: repository.id,
      profileId: ordinary.profile.profileId,
      actor,
      request: { expectedVersion: 0, profileVersionId: ordinary.profile.id, enabled: true },
    });
    const at = new Date().toISOString();
    const [ownerLogin, name] = this.input.repoFullName.split("/");
    assert.ok(ownerLogin && name);
    const event: C.SchedulingRequestOpenedEvent = {
      contractVersion: 1,
      eventId: `m39-open-${this.input.nonce}`,
      source: "webhook",
      sourceEventId: `m39-delivery-${this.input.nonce}`,
      occurredAt: at,
      observedAt: at,
      repository: {
        githubRepositoryId,
        githubNodeId: "M39-owned-repository",
        ownerLogin,
        name,
        fullName: this.input.repoFullName,
        htmlUrl: `https://github.com/${this.input.repoFullName}`,
        defaultBranch: "main",
        isPrivate: false,
      },
      author: reviewer,
      actor: reviewer,
      target: reviewer,
      action: "request_opened",
      requestKind: "review_request",
      workItem: {
        kind: "pull_request",
        githubRepositoryId,
        githubWorkItemId: 39001001,
        githubNodeId: "M39-owned-pull-request",
        number: 1,
        title: "Review the owned discount fixture",
        body: "Synthetic PR metadata for an owned local Git fixture; no GitHub PR exists or is modified.",
        state: "open",
        author: reviewer,
        htmlUrl: `https://github.com/${this.input.repoFullName}/pull/1`,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        isDraft: false,
      },
      revision: {
        kind: "pull_request",
        githubRepositoryId,
        githubWorkItemId: 39001001,
        baseSha: this.input.baseSha,
        headSha: this.input.headSha,
        revisionKey: sha256(`${this.input.baseSha}\0${this.input.headSha}`),
        observedAt: at,
        sourceUpdatedAt: at,
      },
    };
    const ingested = await this.owner().request("ingestSchedulingEvent", {
      event,
      policy,
      allowScheduling: true,
      schedule: null,
      delivery: {
        deliveryId: event.sourceEventId,
        eventName: "pull_request",
        payloadSha256: sha256(canonicalJson(event)),
        receivedAt: at,
      },
    });
    assert.ok(
      ingested.authorized && ingested.jobCreated && ingested.jobId,
      "Normal Profile dispatch must create the ordinary task.",
    );
    this.workItemId = ingested.workItemId;
    const runs = await this.admin().request("listDashboardReviewRuns", {
      repositoryId: repository.id,
      workItemId: this.workItemId,
      page: 1,
      pageSize: 20,
    });
    assert.equal(runs.items.length, 1, "Exactly one ordinary Profile run must exist.");
    this.ordinaryRunId = runs.items[0]!.id;
    const detail = await this.admin().request("getDashboardReviewRun", {
      repositoryId: repository.id,
      reviewRunId: this.ordinaryRunId,
    });
    assert.ok(detail && detail.requests.length === 1 && detail.requests[0]?.latestJob);
    assert.equal(detail.requests[0].latestJob.jobId, ingested.jobId);
    this.jobs.push({
      stage: "ordinary",
      jobId: ingested.jobId,
      runId: this.ordinaryRunId,
      requestId: detail.requests[0].requestId,
    });
    await this.owner().request("createWorkerNodeCredential", {
      workerNodeId: this.input.workerNodeId,
      displayName: `M39 ${this.input.engine} ${this.input.nonce}`,
      workerTokenSha256: sha256(this.input.workerToken),
      createdByIssuer: actor.issuer,
      createdBySubject: actor.subject,
    });
    await writeJson(join(this.input.serverDirectory, "ordinary-configuration.json"), {
      event,
      ingested,
      ordinary,
      detail,
    });
  }
  private async createEvaluation(): Promise<void> {
    const scope = { repositoryId: this.repositoryId, actor };
    const captured = await this.admin().request("captureEvaluationSource", {
      ...scope,
      request: {
        changeId: `m39-source-${this.input.nonce}`,
        source: {
          kind: "current_work_item",
          workItemId: this.workItemId,
          expectedRevisionKey: sha256(`${this.input.baseSha}\0${this.input.headSha}`),
          testedIssueCommit: null,
        },
      },
    });
    const suite = await this.admin().request("createEvaluationSuite", {
      ...scope,
      request: {
        changeId: `m39-suite-${this.input.nonce}`,
        name: `M39 ${this.input.engine} fixture`,
        description:
          "Real configured CLI results on an owned source; model findings are retained without automatic correctness claims.",
        workflowKind: "pr_static_build",
        target: "headless",
      },
    });
    const saved = await this.admin().request("saveEvaluationSuiteDraft", {
      ...scope,
      suiteId: suite.id,
      request: {
        changeId: `m39-draft-${this.input.nonce}`,
        expectedRevision: suite.draftRevision,
        draft: {
          name: suite.name,
          description: suite.description,
          cases: [
            {
              caseId: "owned-discount",
              title: "The frozen discount source receives an independent model review",
              sourceId: captured.id,
              applicability: { state: "applicable" },
              criteria: [
                {
                  criterionId: "fixture-check",
                  description: "The deterministic fixture check passes.",
                  applicability: { state: "applicable" },
                  expectedOutcome: "passed",
                },
              ],
              findings: { annotation: "unlabeled", expected: [] },
            },
          ],
        },
      },
    });
    const version = await this.admin().request("publishEvaluationSuite", {
      ...scope,
      suiteId: suite.id,
      request: {
        changeId: `m39-publish-${this.input.nonce}`,
        expectedRevision: saved.draftRevision,
      },
    });
    const baseline = await this.publishConfiguration("baseline");
    const candidate = await this.publishConfiguration("candidate");
    const batch = await this.admin().request("createEvaluationBatch", {
      ...scope,
      request: {
        changeId: `m39-batch-${this.input.nonce}`,
        suiteId: suite.id,
        suiteVersionId: version.id,
        mode: "prompt_and_profile",
        baseline: baseline.selection,
        candidate: candidate.selection,
        checkMappings: [
          {
            caseId: "owned-discount",
            criterionId: "fixture-check",
            baselineCheckId: `${baseline.profile.id}:check-baseline`,
            candidateCheckId: `${candidate.profile.id}:check-candidate`,
          },
        ],
      },
    });
    this.evaluationId = batch.id;
    await this.owner().request("dispatchPendingReviewRuns", { limit: 20 });
    const matrix = await this.admin().request("getEvaluationBatchMatrix", {
      ...scope,
      evaluationId: batch.id,
    });
    assert.equal(matrix.progress.totalCells, 2);
    assert.equal(matrix.cases.length, 1);
    for (const stage of ["baseline", "candidate"] as const) {
      const cell = matrix.cases[0]![stage];
      assert.ok(cell.job, "Evaluation must create a real queued Job.");
      this.jobs.push({
        stage,
        jobId: cell.job.jobId,
        runId: cell.runId,
        requestId: cell.requestId,
        cellId: cell.cellId,
      });
    }
    await writeJson(join(this.input.serverDirectory, "evaluation-configuration.json"), {
      captured,
      suite,
      version,
      baseline,
      candidate,
      batch,
      matrix,
    });
    this.phase = "evaluation";
    await this.event({ at: new Date().toISOString(), phase: this.phase, evaluationId: batch.id });
  }
  private readAttempts(): StoredAttempt[] {
    const reader = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      const placeholders = this.jobs.map(() => "?").join(",");
      return reader
        .prepare(`SELECT job.id AS jobId, job.status AS jobState,
        job.failure_code AS failureCode, job.failure_message AS failureMessage,
        attempt.id AS attemptId, attempt.worker_node_id AS workerNodeId, attempt.worker_instance_id AS workerInstanceId,
        attempt.status AS attemptState, attempt.phase, attempt.started_at AS startedAt, attempt.ended_at AS endedAt,
        result.id AS resultId, result.result_digest AS resultDigest, result.result_json AS resultJson,
        job.execution_json AS executionJson
        FROM jobs AS job LEFT JOIN run_attempts AS attempt ON attempt.job_id = job.id
        LEFT JOIN validation_job_results AS result ON result.run_attempt_id = attempt.id
        WHERE job.id IN (${placeholders}) ORDER BY job.id, attempt.attempt_number`)
        .all(...this.jobs.map((job) => job.jobId)) as unknown as StoredAttempt[];
    } finally {
      reader.close();
    }
  }
  private summarize(selection: JobSelection, stored: StoredAttempt): AttemptSummary {
    const result = parsedResult(stored.resultJson);
    const review = result === null ? null : object(result.modelReview);
    const report = result === null ? null : object(result.report);
    const model = review?.state === "completed" ? object(review.result) : null;
    const evidence = review?.executionEvidence ?? model?.executionEvidence;
    const capture = evidence === undefined ? null : object(evidence).commandCapture;
    const checks = report?.checks;
    const findings = model?.findings;
    const allChecksPassed =
      Array.isArray(checks) &&
      checks.length > 0 &&
      checks.every((check) => object(check).outcome === "passed");
    return {
      ...selection,
      attemptId: stored.attemptId,
      workerInstanceId: stored.workerInstanceId,
      jobState: stored.jobState,
      attemptState: stored.attemptState,
      modelState: typeof review?.state === "string" ? review.state : null,
      resultId: stored.resultId,
      resultDigest: stored.resultDigest,
      success:
        stored.jobState === "succeeded" &&
        review?.state === "completed" &&
        report?.sourceState === "original" &&
        allChecksPassed,
      terminal: terminalStates.has(stored.jobState),
      quality: {
        sourceState: typeof report?.sourceState === "string" ? report.sourceState : null,
        assessment: typeof model?.assessment === "string" ? model.assessment : null,
        findingCount: Array.isArray(findings) ? findings.length : 0,
        findings: Array.isArray(findings) ? findings : [],
        checks: Array.isArray(checks) ? checks : [],
        cli: review?.execution === undefined ? null : object(review.execution).cli,
        commandCapture: typeof capture === "string" ? capture : null,
        modelError:
          review?.state === "failed"
            ? { code: review.code, message: review.message }
            : stored.failureCode === null
              ? null
              : { code: stored.failureCode, message: stored.failureMessage },
      },
    };
  }
  private async recordResult(selection: JobSelection, stored: StoredAttempt): Promise<void> {
    if (
      stored.attemptId === null ||
      !terminalStates.has(stored.jobState) ||
      this.recordedResults.has(stored.attemptId)
    )
      return;
    let projection: unknown = null;
    if (stored.resultId !== null) {
      projection =
        selection.stage === "ordinary"
          ? await this.admin().request("getDashboardReviewRunJobResult", {
              repositoryId: this.repositoryId,
              reviewRunId: selection.runId,
              requestId: selection.requestId,
              jobId: selection.jobId,
            })
          : await this.admin().request("getEvaluationCellResult", {
              actor,
              repositoryId: this.repositoryId,
              evaluationId: this.evaluationId!,
              cellId: selection.cellId!,
              resultId: stored.resultId,
            });
      assert.ok(projection, "The persisted result must pass its production read projection.");
      const visible = object(projection);
      assert.equal(visible.resultDigest, stored.resultDigest);
    }
    assert.match(stored.attemptId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    await writeJson(join(this.input.serverDirectory, "results", `${stored.attemptId}.json`), {
      selection,
      ...stored,
      execution: JSON.parse(stored.executionJson),
      rawResult: parsedResult(stored.resultJson),
      projection,
    });
    this.recordedResults.add(stored.attemptId);
  }
  private scheduleTick(): void {
    if (this.stopping || this.phase === "complete" || this.phase === "failed") return;
    this.tickTimer = setTimeout(() => {
      this.pendingTick = this.tick().catch(async (error: unknown) => {
        if (!this.stopping) {
          try {
            await this.fail(error);
          } catch (failure) {
            this.stopFailed(failure);
          }
        }
        setImmediate(() => {
          void this.stop("workflow_failed").catch((failure: unknown) => this.stopFailed(failure));
        });
      });
      void this.pendingTick.then(() => this.scheduleTick());
    }, 500);
  }
  private async tick(): Promise<void> {
    if (Date.now() - Date.parse(this.startedAt) > this.input.maximumRunMs)
      throw new Error("The acceptance workflow exceeded its configured run deadline.");
    await this.owner().request("admitPendingJobs", { limit: 32 });
    await this.owner().request("reapExpiredLeases", {
      retryDelaySeconds: 1,
      workerOfflineAfterSeconds: 120,
    });
    if (this.stopping) return;
    const rows = this.readAttempts();
    this.summaries = [];
    for (const selected of this.jobs) {
      const attempts = rows.filter((row) => row.jobId === selected.jobId);
      assert.ok(attempts.length > 0, "Every selected Job must remain present.");
      for (const attempt of attempts) await this.recordResult(selected, attempt);
      this.summaries.push(this.summarize(selected, attempts.at(-1)!));
    }
    if (this.stopping) return;
    if (this.phase === "ordinary" && this.summaries[0]?.terminal) await this.createEvaluation();
    else if (
      this.phase === "evaluation" &&
      this.summaries.length === 3 &&
      this.summaries.every((entry) => entry.terminal)
    ) {
      assert.ok(this.evaluationId);
      const scope = { actor, repositoryId: this.repositoryId, evaluationId: this.evaluationId };
      const matrix = await this.admin().request("getEvaluationBatchMatrix", scope);
      this.preview = await this.admin().request("getEvaluationScorePreview", scope);
      const preview = this.preview as C.EvaluationScorePreviewV1;
      this.assessment = await this.admin().request("publishEvaluationAssessment", {
        ...scope,
        request: {
          changeId: `m39-assessment-${this.input.nonce}`,
          expectedVersion: 0,
          expectedInputDigest: preview.inputDigest,
        },
      });
      this.phase = "complete";
      await writeJson(join(this.input.serverDirectory, "report.json"), {
        ...this.status(),
        schemaVersion: "M39CliWorkflowServerReportV1",
        startedAt: this.startedAt,
        completedAt: new Date().toISOString(),
        source: {
          baseSha: this.input.baseSha,
          headSha: this.input.headSha,
          repoFullName: this.input.repoFullName,
        },
        matrix,
        preview: this.preview,
        assessment: this.assessment,
        qualityInterpretation:
          "Finding content is retained for human assessment; unlabeled findings do not establish precision or recall. CLI default does not identify the underlying model.",
      });
      await this.event({
        at: new Date().toISOString(),
        phase: this.phase,
        successCount: this.summaries.filter((entry) => entry.success).length,
      });
    }
  }
  status() {
    const instanceIds = [
      ...new Set(
        this.summaries.map((entry) => entry.workerInstanceId).filter((value) => value !== null),
      ),
    ];
    const sameWorkerInstance =
      this.summaries.length === 3 &&
      instanceIds.length === 1 &&
      this.summaries.every((entry) => entry.workerInstanceId !== null);
    return {
      schemaVersion: "M39CliWorkflowStatusV1",
      nonce: this.input.nonce,
      engine: this.input.engine,
      phase: this.phase,
      repositoryId: this.repositoryId,
      ordinaryRunId: this.ordinaryRunId,
      passed:
        this.phase === "complete" &&
        this.failure === null &&
        sameWorkerInstance &&
        this.summaries.every((entry) => entry.success),
      evaluationId: this.evaluationId,
      expectedTaskCount: 3,
      attempts: this.summaries,
      successfulAttempts: this.summaries.filter((entry) => entry.success),
      failedAttempts: this.summaries.filter((entry) => entry.terminal && !entry.success),
      sameWorkerInstance,
      failure: this.failure,
      stopping: this.stopping,
    };
  }
  async fail(error: unknown): Promise<void> {
    if (this.phase === "failed") return;
    this.failure = errorRecord(error, this.input);
    this.phase = "failed";
    if (!this.ownsDirectory) {
      process.stderr.write(`${JSON.stringify(this.failure)}\n`);
      return;
    }
    await writeJson(join(this.input.serverDirectory, "failure.json"), {
      ...this.status(),
      failure: this.failure,
    });
    await writeJson(join(this.input.serverDirectory, "failed-report.json"), {
      ...this.status(),
      startedAt: this.startedAt,
      failure: this.failure,
    });
  }
  async stop(reason: string): Promise<void> {
    this.closePromise ??= this.close(reason);
    return this.closePromise;
  }
  private async close(reason: string): Promise<void> {
    this.stopping = true;
    clearTimeout(this.tickTimer);
    if (!this.ownsDirectory) return;
    const failures: ReturnType<typeof errorRecord>[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(errorRecord(error, this.input));
      }
    };
    this.shutdown.abort(new Error("The acceptance Server is stopping."));
    if (this.database)
      await attempt(async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.owner().request("revokeWorkerToken", {
              workerNodeId: this.input.workerNodeId,
              revokedByIssuer: actor.issuer,
              revokedBySubject: actor.subject,
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Acceptance credential revocation timed out.")),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
    if (this.app) await attempt(() => this.app!.close());
    if (this.database) await attempt(() => this.owner().close());
    clearTimeout(this.deadlineTimer);
    await attempt(() => this.pendingTick);
    await writeJson(join(this.input.serverDirectory, "closure.json"), {
      reason,
      closedAt: new Date().toISOString(),
      failure: this.failure,
      cleanupFailures: failures,
      filesRetained: true,
    });
    if (failures.length > 0) process.exitCode = 1;
  }
  stopFailed(error: unknown): void {
    process.stderr.write(`${JSON.stringify(errorRecord(error, this.input))}\n`);
    process.exitCode = 1;
  }
}

assert.equal(process.platform, "linux", "Run this acceptance Server on Linux or WSL.");
assert.equal(process.argv.length, 3, "Usage: node server.mjs private-input.json");
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
const input = await readInput(process.argv[2]!);
const server = new AcceptanceServer(input);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void server.stop(signal).catch((error: unknown) => server.stopFailed(error));
  });
try {
  await server.start();
} catch (error) {
  try {
    await server.fail(error);
  } catch (failure) {
    server.stopFailed(failure);
  }
  try {
    await server.stop("startup_failed");
  } catch (failure) {
    server.stopFailed(failure);
  }
  process.exitCode = 1;
}
