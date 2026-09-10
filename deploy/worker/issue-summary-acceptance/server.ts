import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { composeSummaryPrompt } from "@agentic-review/codex";
import * as C from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { ServerConfig } from "../../../apps/server/dist/config.js";
import { DatabaseClient } from "../../../apps/server/dist/database/database-client.js";
import { bindOperatorDatabase } from "../../../apps/server/dist/database/operator-database.js";
import type { ReviewRunDetail } from "../../../apps/server/dist/database/review-runs.js";
import { registerWorkerEvidenceRoutes } from "../../../apps/server/dist/routes/evidence-assets.js";
import { registerValidationSummaryInputRoutes } from "../../../apps/server/dist/routes/validation-summary-inputs.js";
import { registerWorkerRoutes } from "../../../apps/server/dist/routes/workers.js";
import { canonicalJson } from "../../../apps/server/dist/scheduling/canonical-json.js";
import {
  assertMeasurement,
  caseId,
  fixedRevision,
  type IssueSummaryInput,
  type IssueSummaryReady,
  loadPublicAssets,
  makeProfile,
  makeReproduction,
  makeSourceEvent,
  measurementStepId,
  repositoryFullName,
  summaryPrompt,
} from "./case.js";

// Only this opt-in harness owns its synthetic database records and control endpoints. All jobs,
// attempts, summary inputs and results are created through production owner operations/routes.
type Phase = "ordinary" | "evaluation" | "complete" | "failed";
type Stage = "ordinary" | "baseline" | "candidate";
type Measurement = ReturnType<typeof assertMeasurement>;
interface Selection {
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
interface SummaryRow {
  inputId: string;
  runAttemptId: string;
  jobId: string;
  workerNodeId: string;
  workerInstanceId: string;
  leaseGeneration: number;
  inputJson: string;
  inputSha256: string;
  intentSha256: string;
  frozenAt: string;
}
interface AttemptSummary extends Selection {
  attemptId: string | null;
  workerInstanceId: string | null;
  jobState: string;
  attemptState: string | null;
  resultId: string | null;
  resultDigest: string | null;
  terminal: boolean;
  success: boolean;
  measurement: Measurement | null;
  failure: { code: string | null; message: string | null } | null;
}
const actor: C.OperatorPrincipal = {
  issuer: "https://m40.acceptance.invalid",
  subject: "owned-issue-summary-acceptance",
};
const terminalStates = new Set(["succeeded", "failed", "dead_letter", "cancelled", "stale"]);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 4096): string {
  assert.equal(typeof value, "string", `${label} must be a string.`);
  const result = value as string;
  assert.ok(
    result.length > 0 &&
      result.length <= maximum &&
      result.isWellFormed() &&
      !result.includes("\0"),
    label,
  );
  return result;
}
async function readInput(path: string): Promise<IssueSummaryInput> {
  const bytes = await readFile(path);
  assert.ok(bytes.length <= 128 * 1024, "The current harness input is too large.");
  const value = object(JSON.parse(bytes.toString("utf8")));
  assert.equal(value.schemaVersion, "IssueSummaryAcceptanceInputV1");
  assert.ok(value.engine === "codex" || value.engine === "copilot");
  for (const key of [
    "nonce",
    "serverDirectory",
    "migrationsDirectory",
    "readyFilePath",
    "ownerFilePath",
    "workerNodeId",
    "workerToken",
    "controlToken",
    "workerDirectory",
    "nodeExecutablePath",
    "gitExecutablePath",
    "processHostPath",
    "trustedExecutableRoot",
    "cliExecutablePath",
    "cliVersion",
    "probeScriptPath",
  ])
    text(value[key], key);
  const input = value as unknown as IssueSummaryInput;
  assert.match(input.nonce, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  assert.match(input.workerNodeId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.match(input.workerToken, /^arw1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
  assert.match(input.controlToken, /^[A-Za-z0-9_-]{32,256}$/u);
  for (const path of [
    input.serverDirectory,
    input.migrationsDirectory,
    input.readyFilePath,
    input.ownerFilePath,
  ]) {
    assert.ok(isAbsolute(path) && !path.includes("\\") && !path.split("/").includes(".."));
  }
  assert.ok(
    !input.serverDirectory.startsWith("/mnt/"),
    "SQLite must stay on the Linux filesystem.",
  );
  assert.ok(
    Number.isSafeInteger(input.maximumRunMs) &&
      input.maximumRunMs >= 60_000 &&
      input.maximumRunMs <= 3_600_000,
  );
  return structuredClone(input);
}
function errorRecord(error: unknown, input: IssueSummaryInput) {
  const original = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    message: original
      .replaceAll(input.workerToken, "[REDACTED]")
      .replaceAll(input.controlToken, "[REDACTED]")
      .slice(0, 4096),
    at: new Date().toISOString(),
  };
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
async function bounded<T>(work: Promise<T>, label: string, maximumMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), maximumMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class IssueSummaryServer {
  readonly shutdown = new AbortController();
  readonly startedAt = new Date().toISOString();
  readonly databasePath: string;
  readonly jobs: Selection[] = [];
  readonly recordedResults = new Set<string>();
  readonly measurements = new Map<string, Measurement>();
  readonly summaryInputs = new Map<string, C.FrozenValidationSummaryInputV1>();
  database?: DatabaseClient;
  operator?: Pick<DatabaseClient, "request">;
  app?: FastifyInstance;
  assets?: Awaited<ReturnType<typeof loadPublicAssets>>;
  ordinaryRun?: ReviewRunDetail;
  repositoryId = "";
  workItemId = "";
  ordinaryRunId = "";
  evaluationId: string | null = null;
  phase: Phase = "ordinary";
  failure: ReturnType<typeof errorRecord> | null = null;
  summaries: AttemptSummary[] = [];
  ownsDirectory = false;
  stopping = false;
  tickTimer?: NodeJS.Timeout;
  deadlineTimer?: NodeJS.Timeout;
  pendingTick: Promise<void> = Promise.resolve();
  closePromise?: Promise<void>;
  constructor(readonly input: IssueSummaryInput) {
    this.databasePath = join(input.serverDirectory, "database", "server.sqlite");
  }
  private owner(): DatabaseClient {
    assert.ok(this.database);
    return this.database;
  }
  private admin(): Pick<DatabaseClient, "request"> {
    assert.ok(this.operator);
    return this.operator;
  }
  private async event(value: unknown): Promise<void> {
    const json = JSON.stringify(value)
      .replaceAll(this.input.workerToken, "[REDACTED]")
      .replaceAll(this.input.controlToken, "[REDACTED]");
    await appendFile(join(this.input.serverDirectory, "events.jsonl"), `${json}\n`);
  }
  async start(): Promise<void> {
    assert.ok(!this.stopping, "Stopped before directory creation.");
    await mkdir(this.input.serverDirectory, { mode: 0o700 });
    this.ownsDirectory = true;
    assert.ok(!this.stopping, "Stopped during directory creation.");
    const processStat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const startTicks = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
    assert.ok(startTicks && /^[0-9]+$/u.test(startTicks));
    await writeJson(this.input.ownerFilePath, {
      nonce: this.input.nonce,
      processId: process.pid,
      startTicks,
      executable: await realpath(process.execPath),
      inputPath: process.argv[2],
    });
    assert.ok(!this.stopping, "Stopped while recording process ownership.");
    assert.equal(await realpath(this.input.serverDirectory), this.input.serverDirectory);
    assert.equal((await lstat(this.input.serverDirectory)).mode & 0o777, 0o700);
    for (const name of ["home", "tmp", "database", "evidence", "results", "summary-inputs"])
      await mkdir(join(this.input.serverDirectory, name), { mode: 0o700 });
    await writeFile(join(this.input.serverDirectory, "events.jsonl"), "", {
      flag: "wx",
      mode: 0o600,
    });
    assert.ok(!this.stopping, "Stopped before the session deadline was armed.");
    this.deadlineTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.fail(
            new Error("The acceptance session exceeded its maximum lifetime before closure."),
          );
        } finally {
          await this.stop("maximum_run_deadline");
        }
      })().catch((error: unknown) => this.stopFailed(error));
    }, this.input.maximumRunMs);
    await writeJson(join(this.input.serverDirectory, "scope.json"), {
      schemaVersion: "M40IssueSummaryScopeV1",
      nonce: this.input.nonce,
      engine: this.input.engine,
      repositoryFullName,
      sourceRevision: fixedRevision,
      expectedTasks: 3,
      startedAt: this.startedAt,
      externalRepositoryWrites: false,
      priorAcceptanceReused: false,
      sourceScope:
        "Public Issue #1064 and unchanged fixed upstream source; synthetic internal assignment and new owned database.",
      modelScope:
        "Current configured CLI on the Windows Worker; the CLI owns its model connection.",
    });
    this.assets = await loadPublicAssets();
    assert.ok(!this.stopping, "Stopped during public asset loading.");
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
      throw new Error("Stopped during database startup.");
    }
    await chmod(this.databasePath, 0o600);
    this.operator = bindOperatorDatabase(this.database, actor);
    await this.bootstrap();
    assert.ok(!this.stopping, "Stopped during configuration.");
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
    const routes = { database: this.database, config, shutdownSignal: this.shutdown.signal };
    registerWorkerRoutes(app, routes);
    registerWorkerEvidenceRoutes(app, routes);
    registerValidationSummaryInputRoutes(app, routes);
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
    assert.ok(!this.stopping, "Stopped before readiness.");
    const ready: IssueSummaryReady = {
      nonce: this.input.nonce,
      engine: this.input.engine,
      workerNodeId: this.input.workerNodeId,
      ordinaryRunId: this.ordinaryRunId,
      serverUrl,
      processId: process.pid,
    };
    await writeJson(this.input.readyFilePath, ready);
    await writeJson(join(this.input.serverDirectory, "ready.json"), ready);
    this.scheduleTick();
  }
  private async publishConfiguration(stage: Stage) {
    assert.ok(this.assets);
    const config = makeProfile(this.input.probeScriptPath, this.assets.declaration);
    assert.equal(config.schemaVersion, "ValidationProfileV1");
    const profile = await this.admin().request("publishValidationProfile", {
      repositoryId: this.repositoryId,
      actor,
      request: {
        name: `M40 Issue summary ${stage} ${this.input.nonce}`,
        workflowKind: "issue_validation",
        target: "headless",
        required: true,
        config,
        outputSchemaVersion: "ValidationReportV1",
      },
    });
    const template = await this.admin().request("createPromptTemplate", {
      actor,
      request: {
        name: `M40 Issue summary ${stage} ${this.input.nonce}`,
        workflowKind: "issue_validation",
        content: `${summaryPrompt}\nAcceptance arm: ${stage}. Base every factual statement on the current attached runner measurements.`,
        outputSchemaVersion: "ValidationSummaryV1",
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
    assert.ok(this.assets);
    const event = makeSourceEvent(this.input.nonce, this.assets.repository, this.assets.issue);
    assert.ok(event.target);
    const reviewer = event.target;
    const policy: C.SelfOrAllowlistPolicy = {
      kind: "self_or_allowlist",
      policyVersion: 1,
      schedulingTargetGithubUserId: reviewer.githubUserId,
      allowlistedActorGithubUserIds: [],
      unknownActorPolicy: "deny",
      newRevisionPolicy: "require_new_authorization",
    };
    await this.owner().request("bootstrapManagedRepositories", {
      repositories: [
        {
          githubRepositoryId: this.assets.repository.githubRepositoryId,
          fullName: repositoryFullName,
        },
      ],
      reviewer,
      authorizationPolicy: policy,
    });
    const repository = await this.owner().request("getManagedRepositoryByGitHubId", {
      githubRepositoryId: this.assets.repository.githubRepositoryId,
    });
    assert.ok(repository);
    this.repositoryId = repository.id;
    const ordinary = await this.publishConfiguration("ordinary");
    await this.admin().request("savePromptBinding", {
      repositoryId: this.repositoryId,
      workflowKind: "issue_validation",
      actor,
      request: { expectedVersion: 0, promptVersionId: ordinary.prompt.id },
    });
    await this.admin().request("saveValidationProfileBinding", {
      repositoryId: this.repositoryId,
      profileId: ordinary.profile.profileId,
      actor,
      request: { expectedVersion: 0, profileVersionId: ordinary.profile.id, enabled: true },
    });
    // The synthetic assignment creates normal authorization. The automatic Issue run lacks
    // an explicit tested commit and remains unscheduled; the operator run below supplies it.
    const ingested = await this.owner().request("ingestSchedulingEvent", {
      event,
      policy,
      allowScheduling: true,
      schedule: null,
      delivery: null,
    });
    assert.ok(ingested.authorized && ingested.workItemProjected && !ingested.jobCreated);
    assert.equal(ingested.activeRequestEpochIds.length, 1);
    this.workItemId = ingested.workItemId;
    const run = await this.admin().request("createOperatorReviewRun", {
      repositoryId: this.repositoryId,
      workItemId: this.workItemId,
      actor,
      request: {
        activationId: `m40-ordinary-${this.input.nonce}`,
        expectedRevisionKey: event.revision.revisionKey,
        testedSourceCommit: fixedRevision,
        profileIds: [ordinary.profile.profileId],
        reproduction: makeReproduction(ordinary.profile),
      },
    });
    this.ordinaryRun = run;
    this.ordinaryRunId = run.id;
    assert.ok(run.plan.reproduction, "The ordinary run must freeze its real measurement contract.");
    await this.owner().request("dispatchPendingReviewRuns", { limit: 20 });
    const detail = await this.admin().request("getDashboardReviewRun", {
      repositoryId: this.repositoryId,
      reviewRunId: run.id,
    });
    assert.ok(detail && detail.requests.length === 1 && detail.requests[0]?.latestJob);
    this.jobs.push({
      stage: "ordinary",
      runId: run.id,
      requestId: detail.requests[0].requestId,
      jobId: detail.requests[0].latestJob.jobId,
    });
    await this.owner().request("createWorkerNodeCredential", {
      workerNodeId: this.input.workerNodeId,
      displayName: `M40 ${this.input.engine} ${this.input.nonce}`,
      workerTokenSha256: sha256(this.input.workerToken),
      createdByIssuer: actor.issuer,
      createdBySubject: actor.subject,
    });
    await writeJson(join(this.input.serverDirectory, "ordinary-configuration.json"), {
      event,
      ingested,
      ordinary,
      run,
      detail,
    });
  }
  private async createEvaluation(): Promise<void> {
    const run = this.ordinaryRun;
    assert.ok(run?.plan.reproduction);
    assert.equal(this.summaries.length, 1);
    assert.ok(
      this.summaries[0]?.success,
      "The ordinary measurement and current CLI summary must succeed before capture.",
    );
    const scope = { actor, repositoryId: this.repositoryId };
    const captured = await this.admin().request("captureEvaluationSource", {
      ...scope,
      request: {
        changeId: `m40-capture-${this.input.nonce}`,
        source: { kind: "review_run", reviewRunId: run.id, expectedPlanDigest: run.planDigest },
      },
    });
    const definition = await this.admin().request("getEvaluationSourceReproduction", {
      ...scope,
      sourceId: captured.id,
    });
    assert.ok(definition.sourceDefinition);
    assert.equal(definition.sourceDefinition.bindingDigest, run.plan.reproduction.bindingDigest);
    const suite = await this.admin().request("createEvaluationSuite", {
      ...scope,
      request: {
        changeId: `m40-suite-${this.input.nonce}`,
        name: `M40 Issue summary ${this.input.engine}`,
        description:
          "Current CLI summaries of fresh fixed-source Issue timing measurements; runner facts and model advice remain separate.",
        workflowKind: "issue_validation",
        target: "headless",
      },
    });
    const saved = await this.admin().request("saveEvaluationSuiteDraft", {
      ...scope,
      suiteId: suite.id,
      request: {
        changeId: `m40-draft-${this.input.nonce}`,
        expectedRevision: suite.draftRevision,
        draft: {
          name: suite.name,
          description: suite.description,
          cases: [
            {
              caseId,
              title: "Disclosed coarse subtitle timing measurement",
              sourceId: captured.id,
              applicability: { state: "applicable" },
              criteria: [
                {
                  criterionId: "measurement-collected",
                  description: "The real upstream probe collects its declared timing observations.",
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
        changeId: `m40-publish-${this.input.nonce}`,
        expectedRevision: saved.draftRevision,
      },
    });
    const baseline = await this.publishConfiguration("baseline");
    const candidate = await this.publishConfiguration("candidate");
    const references = new Map<string, C.ReproductionObservationRef>();
    const checks = new Set<string>();
    const originalCases = run.plan.reproduction.binding.cases;
    for (const entry of originalCases) {
      for (const condition of entry.preconditions) {
        if (condition.kind === "check_passed") checks.add(condition.checkId);
        else
          references.set(
            canonicalJson(condition.predicate.observation),
            condition.predicate.observation,
          );
      }
      for (const predicate of [...entry.presentWhen.allOf, ...(entry.absentWhen?.allOf ?? [])])
        references.set(canonicalJson(predicate.observation), predicate.observation);
    }
    const armMapping = (
      profile: C.ValidationProfileVersion,
    ): C.EvaluationReproductionArmMappingsV1 => ({
      observationMappings: [...references.values()].map((from) => ({
        from,
        to: structuredClone(from),
      })),
      checkMappings: [...checks].map((fromCheckId) => ({
        fromCheckId,
        toCheckId: `${profile.id}:${measurementStepId}`,
      })),
    });
    const reproductionMapping: C.EvaluationReproductionMappingSelectionV1 = {
      caseId,
      selectedCaseIds: originalCases.map((entry) => entry.id),
      expectedSource: {
        reviewRunId: run.id,
        planDigest: run.planDigest,
        bindingDigest: run.plan.reproduction.bindingDigest,
      },
      baseline: armMapping(baseline.profile),
      candidate: armMapping(candidate.profile),
    };
    const batch = await this.admin().request("createEvaluationBatch", {
      ...scope,
      request: {
        changeId: `m40-batch-${this.input.nonce}`,
        suiteId: suite.id,
        suiteVersionId: version.id,
        mode: "prompt_and_profile",
        baseline: baseline.selection,
        candidate: candidate.selection,
        checkMappings: [
          {
            caseId,
            criterionId: "measurement-collected",
            baselineCheckId: `${baseline.profile.id}:${measurementStepId}`,
            candidateCheckId: `${candidate.profile.id}:${measurementStepId}`,
          },
        ],
        reproductionMappings: [reproductionMapping],
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
    const entry = matrix.cases[0];
    assert.ok(entry && entry.caseId === caseId);
    for (const stage of ["baseline", "candidate"] as const) {
      const cell = entry[stage];
      assert.ok(cell.job, "Evaluation dispatch must create a real job.");
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
      definition,
      suite,
      version,
      baseline,
      candidate,
      reproductionMapping,
      batch,
      matrix,
    });
    this.phase = "evaluation";
    await this.event({ at: new Date().toISOString(), phase: this.phase, evaluationId: batch.id });
  }
  private readAttempts(): StoredAttempt[] {
    const reader = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      return reader
        .prepare(`SELECT job.id AS jobId, job.status AS jobState,
        job.failure_code AS failureCode, job.failure_message AS failureMessage,
        attempt.id AS attemptId, attempt.worker_node_id AS workerNodeId,
        attempt.worker_instance_id AS workerInstanceId, attempt.status AS attemptState,
        attempt.phase, attempt.started_at AS startedAt, attempt.ended_at AS endedAt,
        result.id AS resultId, result.result_digest AS resultDigest, result.result_json AS resultJson,
        job.execution_json AS executionJson FROM jobs AS job
        LEFT JOIN run_attempts AS attempt ON attempt.job_id = job.id
        LEFT JOIN validation_job_results AS result ON result.run_attempt_id = attempt.id
        WHERE job.id IN (${this.jobs.map(() => "?").join(",")}) ORDER BY job.id, attempt.attempt_number`)
        .all(...this.jobs.map((job) => job.jobId)) as unknown as StoredAttempt[];
    } finally {
      reader.close();
    }
  }
  private readSummaryRows(): SummaryRow[] {
    const reader = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      return reader
        .prepare(`SELECT input_id AS inputId, run_attempt_id AS runAttemptId,
        job_id AS jobId, worker_node_id AS workerNodeId, worker_instance_id AS workerInstanceId,
        lease_generation AS leaseGeneration, input_json AS inputJson, input_sha256 AS inputSha256,
        intent_sha256 AS intentSha256, frozen_at AS frozenAt FROM model_summary_inputs ORDER BY frozen_at, input_id`)
        .all() as unknown as SummaryRow[];
    } finally {
      reader.close();
    }
  }
  private async captureSummaryInput(
    selection: Selection,
    row: StoredAttempt,
    measurement: Measurement,
  ): Promise<void> {
    const execution = measurement.cliExecution;
    assert.ok(execution?.summaryInputRef);
    const reference = execution.summaryInputRef;
    const matches = this.readSummaryRows().filter((entry) => entry.inputId === reference.inputId);
    assert.equal(
      matches.length,
      1,
      "Each evaluated summary must have one actual frozen input row.",
    );
    const stored = matches[0];
    assert.ok(stored);
    assert.equal(stored.jobId, row.jobId);
    assert.equal(stored.runAttemptId, row.attemptId);
    assert.equal(stored.workerNodeId, this.input.workerNodeId);
    assert.equal(stored.workerInstanceId, row.workerInstanceId);
    assert.equal(sha256(stored.inputJson), stored.inputSha256);
    assert.equal(stored.inputSha256, reference.inputSha256);
    const document = JSON.parse(stored.inputJson) as C.FrozenValidationSummaryInputV1;
    assert.deepEqual(C.getFrozenValidationSummaryInputIssues(document), []);
    assert.equal(canonicalJson(document), stored.inputJson);
    assert.equal(document.inputId, reference.inputId);
    assert.equal(document.repositoryId, this.repositoryId);
    assert.equal(document.evaluationId, this.evaluationId);
    assert.equal(document.cellId, selection.cellId);
    assert.equal(document.context.jobId, selection.jobId);
    assert.equal(document.context.runAttemptId, row.attemptId);
    assert.equal(document.context.runId, selection.runId);
    assert.equal(document.context.requestId, selection.requestId);
    assert.equal(document.workerNodeId, stored.workerNodeId);
    assert.equal(document.workerInstanceId, stored.workerInstanceId);
    assert.equal(document.leaseGeneration, stored.leaseGeneration);
    assert.equal(document.frozenAt, stored.frozenAt);
    const template = JSON.parse(row.executionJson) as C.JobExecutionTemplateV2;
    const contextJson = canonicalJson(document.context);
    assert.equal(document.sourcePromptSha256, template.prompt.promptSha256);
    assert.equal(document.contextSha256, sha256(contextJson));
    assert.equal(
      document.actualPromptSha256,
      sha256(composeSummaryPrompt(template.prompt.renderedPrompt, contextJson)),
    );
    for (const key of [
      "sourcePromptSha256",
      "outputSchemaSha256",
      "contextSha256",
      "actualPromptSha256",
    ] as const)
      assert.equal(document[key], reference[key]);
    assert.equal(execution.promptSha256, reference.actualPromptSha256);
    assert.equal(execution.outputSchemaSha256, reference.outputSchemaSha256);
    assert.ok(
      !this.summaryInputs.has(reference.inputId),
      "Separate tasks must not reuse a summary input.",
    );
    await writeJson(join(this.input.serverDirectory, "summary-inputs", `${selection.stage}.json`), {
      selection,
      stored,
      document,
      reference,
    });
    this.summaryInputs.set(reference.inputId, document);
  }
  private async recordResult(selection: Selection, row: StoredAttempt): Promise<void> {
    if (
      row.attemptId === null ||
      !terminalStates.has(row.jobState) ||
      this.recordedResults.has(row.attemptId)
    )
      return;
    assert.match(row.attemptId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    const rawResult: unknown = row.resultJson === null ? null : JSON.parse(row.resultJson);
    await writeJson(join(this.input.serverDirectory, "results", `${row.attemptId}.json`), {
      selection,
      ...row,
      rawResult,
    });
    this.recordedResults.add(row.attemptId);
    if (rawResult === null || row.jobState !== "succeeded") return;
    assert.equal(row.attemptState, "succeeded");
    assert.equal(row.workerNodeId, this.input.workerNodeId);
    assert.ok(row.workerInstanceId && row.resultId && row.resultDigest);
    assert.equal(sha256(canonicalJson(rawResult)), row.resultDigest);
    const template = JSON.parse(row.executionJson) as C.JobExecutionTemplateV2;
    const measurement = assertMeasurement(rawResult, template);
    assert.equal(measurement.jobId, row.jobId);
    assert.equal(measurement.runAttemptId, row.attemptId);
    assert.equal(measurement.requestId, selection.requestId);
    if (selection.stage === "ordinary") {
      assert.equal(object(rawResult).schemaVersion, "ValidationJobResultV1");
      assert.equal(measurement.cliExecution, null);
      assert.equal(
        this.readSummaryRows().length,
        0,
        "Ordinary V1 summaries do not create evaluation input rows.",
      );
    } else {
      assert.equal(object(rawResult).schemaVersion, "ValidationJobResultV2");
      const execution = measurement.cliExecution;
      assert.ok(execution);
      assert.deepEqual(C.getCliModelExecutionIssues(execution), []);
      assert.equal(execution.cli.kind, this.input.engine);
      assert.equal(execution.cli.version, this.input.cliVersion);
      assert.equal(execution.jobId, row.jobId);
      assert.equal(execution.runAttemptId, row.attemptId);
      assert.equal(execution.exitCode, 0);
      assert.equal(execution.outputSha256, sha256(canonicalJson(measurement.modelAdvice)));
      await this.captureSummaryInput(selection, row, measurement);
    }
    if (selection.stage !== "ordinary") assert.ok(this.evaluationId && selection.cellId);
    const projection =
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
            evaluationId: text(this.evaluationId, "evaluationId"),
            cellId: text(selection.cellId, "cellId"),
            resultId: row.resultId,
          });
    assert.ok(projection);
    assert.equal(object(projection).resultDigest, row.resultDigest);
    await writeJson(join(this.input.serverDirectory, "results", `${row.attemptId}.verified.json`), {
      selection,
      measurement,
      projection,
    });
    this.measurements.set(row.attemptId, measurement);
  }
  private summarize(selection: Selection, row: StoredAttempt): AttemptSummary {
    const measurement =
      row.attemptId === null ? null : (this.measurements.get(row.attemptId) ?? null);
    return {
      ...selection,
      attemptId: row.attemptId,
      workerInstanceId: row.workerInstanceId,
      jobState: row.jobState,
      attemptState: row.attemptState,
      resultId: row.resultId,
      resultDigest: row.resultDigest,
      terminal: terminalStates.has(row.jobState),
      success:
        row.jobState === "succeeded" && row.attemptState === "succeeded" && measurement !== null,
      measurement,
      failure:
        row.failureCode === null ? null : { code: row.failureCode, message: row.failureMessage },
    };
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
    assert.ok(
      Date.now() - Date.parse(this.startedAt) <= this.input.maximumRunMs,
      "The workflow exceeded its deadline.",
    );
    await this.owner().request("admitPendingJobs", { limit: 8 });
    await this.owner().request("reapExpiredLeases", {
      retryDelaySeconds: 1,
      workerOfflineAfterSeconds: 120,
    });
    if (this.stopping) return;
    const rows = this.readAttempts();
    this.summaries = [];
    for (const selection of this.jobs) {
      const attempts = rows.filter((row) => row.jobId === selection.jobId);
      assert.ok(attempts.length > 0);
      for (const attempt of attempts) await this.recordResult(selection, attempt);
      const latest = attempts.at(-1);
      assert.ok(latest);
      this.summaries.push(this.summarize(selection, latest));
    }
    if (this.stopping) return;
    if (this.phase === "ordinary" && this.summaries[0]?.terminal) await this.createEvaluation();
    else if (
      this.phase === "evaluation" &&
      this.summaries.length === 3 &&
      this.summaries.every((entry) => entry.terminal)
    )
      await this.finalize();
  }
  private async finalize(): Promise<void> {
    assert.ok(this.evaluationId);
    const scope = { actor, repositoryId: this.repositoryId, evaluationId: this.evaluationId };
    const matrix = await this.admin().request("getEvaluationBatchMatrix", scope);
    const reproduction = await this.admin().request("getEvaluationReproductionPlan", scope);
    const preview = await this.admin().request("getEvaluationScorePreview", scope);
    const assessment = await this.admin().request("publishEvaluationAssessment", {
      ...scope,
      request: {
        changeId: `m40-assessment-${this.input.nonce}`,
        expectedVersion: preview.assessmentVersion,
        expectedInputDigest: preview.inputDigest,
      },
    });
    const rows = this.readSummaryRows();
    await writeJson(join(this.input.serverDirectory, "summary-inputs", "all-rows.json"), rows);
    const allSucceeded = this.summaries.every((entry) => entry.success);
    if (allSucceeded) {
      assert.equal(rows.length, 2);
      assert.equal(this.summaryInputs.size, 2);
      assert.equal(new Set(rows.map((row) => row.jobId)).size, 2);
      assert.equal(new Set(rows.map((row) => row.runAttemptId)).size, 2);
      assert.ok(
        rows.every((row) =>
          this.jobs.some((job) => job.stage !== "ordinary" && job.jobId === row.jobId),
        ),
      );
    }
    this.phase = "complete";
    await writeJson(join(this.input.serverDirectory, "report.json"), {
      ...this.status(),
      schemaVersion: "M40IssueSummaryServerReportV1",
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      source: { repositoryFullName, revision: fixedRevision, issueNumber: 1064 },
      matrix,
      reproduction,
      preview,
      assessment,
      frozenSummaryInputCount: rows.length,
      interpretation:
        "Runner conclusions come from nineteen fresh probe observations. CLI summary advice is retained independently; different advice does not rewrite the observed reproduction. Ordinary V1 retains report.modelSummary; both evaluated V2 summaries retain exact CLI metadata and separate frozen input rows. No previous acceptance result is reused.",
    });
    await this.event({
      at: new Date().toISOString(),
      phase: this.phase,
      passed: this.status().passed,
    });
  }
  status() {
    const instances = new Set(
      this.summaries.map((entry) => entry.workerInstanceId).filter((entry) => entry !== null),
    );
    const sameWorkerInstance =
      this.summaries.length === 3 &&
      instances.size === 1 &&
      this.summaries.every((entry) => entry.workerInstanceId !== null);
    return {
      schemaVersion: "M40IssueSummaryStatusV1",
      nonce: this.input.nonce,
      engine: this.input.engine,
      phase: this.phase,
      repositoryId: this.repositoryId,
      workItemId: this.workItemId,
      ordinaryRunId: this.ordinaryRunId,
      evaluationId: this.evaluationId,
      expectedTaskCount: 3,
      passed:
        this.phase === "complete" &&
        this.failure === null &&
        sameWorkerInstance &&
        this.summaryInputs.size === 2 &&
        this.summaries.every((entry) => entry.success),
      attempts: this.summaries,
      successfulAttempts: this.summaries.filter((entry) => entry.success),
      failedAttempts: this.summaries.filter((entry) => entry.terminal && !entry.success),
      frozenSummaryInputCount: this.summaryInputs.size,
      sameWorkerInstance,
      failure: this.failure,
      stopping: this.stopping,
    };
  }
  async fail(error: unknown): Promise<void> {
    if (this.phase === "failed") return;
    this.failure = errorRecord(error, this.input);
    this.phase = "failed";
    process.exitCode = 1;
    if (!this.ownsDirectory) {
      process.stderr.write(`${JSON.stringify(this.failure)}\n`);
      return;
    }
    await writeJson(join(this.input.serverDirectory, "failure.json"), {
      ...this.status(),
      startedAt: this.startedAt,
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
    const watchdog = setTimeout(() => {
      process.stderr.write(
        "The owned acceptance Server could not settle its shutdown within 45 seconds.\n",
      );
      process.exit(1);
    }, 45_000);
    watchdog.unref();
    const failures: ReturnType<typeof errorRecord>[] = [];
    const attempt = async (label: string, action: () => Promise<unknown>) => {
      try {
        await bounded(action(), label);
      } catch (error) {
        failures.push(errorRecord(error, this.input));
      }
    };
    this.shutdown.abort(new Error("The acceptance Server is stopping."));
    if (this.database)
      await attempt("Worker credential revocation", () =>
        this.owner().request("revokeWorkerToken", {
          workerNodeId: this.input.workerNodeId,
          revokedByIssuer: actor.issuer,
          revokedBySubject: actor.subject,
        }),
      );
    const app = this.app;
    if (app) await attempt("HTTP closure", () => app.close());
    await attempt("Pending workflow settlement", () => this.pendingTick);
    if (this.database) await attempt("Database owner closure", () => this.owner().close());
    clearTimeout(this.deadlineTimer);
    await writeJson(join(this.input.serverDirectory, "closure.json"), {
      reason,
      closedAt: new Date().toISOString(),
      failure: this.failure,
      cleanupFailures: failures,
      filesRetained: true,
      passedBeforeClosure: this.status().passed,
    });
    if (failures.length > 0) process.exitCode = 1;
    else clearTimeout(watchdog);
  }
  stopFailed(error: unknown): void {
    process.stderr.write(`${JSON.stringify(errorRecord(error, this.input))}\n`);
    process.exitCode = 1;
  }
}

assert.equal(process.platform, "linux", "Run the acceptance Server on Linux or WSL.");
assert.equal(process.argv.length, 3, "Usage: node server.mjs current-input.json");
FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
FormatRegistry.Set("uri", (value) => URL.canParse(value));
const input = await readInput(text(process.argv[2], "input path"));
const server = new IssueSummaryServer(input);
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
