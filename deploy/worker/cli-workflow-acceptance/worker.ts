import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createCanonicalResult,
  getValidationJobResultV2Issues,
  redactExecutionText,
  ValidationJobResultV1Schema,
  ValidationJobResultV2Schema,
} from "@agentic-review/codex";
import type { JobExecutionEnvelope, JobExecutionEnvelopeV2 } from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { WorkerConfig } from "../../../apps/worker/src/config.js";
import type { JobExecutor } from "../../../apps/worker/src/execution/job-executor.js";
import {
  type JobWorkspaceProvider,
  type PreparedJobWorkspace,
  ProductionDisposableJobWorkspaceProvider,
} from "../../../apps/worker/src/execution/job-workspace.js";
import {
  type ManagedProcessRunner,
  ProductionManagedProcessRunner,
} from "../../../apps/worker/src/execution/managed-process-runner.js";
import {
  deriveWorkerProcessHostInstanceKey,
  StdioProcessHostClient,
} from "../../../apps/worker/src/execution/process-host-client.js";
import type { ProcessHostClient } from "../../../apps/worker/src/execution/process-host-protocol.js";
import { ProfileJobExecutor } from "../../../apps/worker/src/execution/profile-job-executor.js";
import { ReviewJobExecutor } from "../../../apps/worker/src/execution/review-executor.js";
import { createRuntimeCapabilities } from "../../../apps/worker/src/execution/runtime-capabilities.js";
import { HeadlessValidationCheckRunner } from "../../../apps/worker/src/execution/validation-check-runner.js";
import {
  ProductionWorkspaceDiskBudget,
  type WorkspaceDiskBudget,
} from "../../../apps/worker/src/execution/workspace-disk-budget.js";
import type { LogFields, Logger } from "../../../apps/worker/src/logging/logger.js";
import { HttpWorkerApi } from "../../../apps/worker/src/server-client/http-worker-api.js";
import type { WorkerApi } from "../../../apps/worker/src/server-client/worker-api.js";
import { WorkerService } from "../../../apps/worker/src/worker-service.js";

export interface WorkerAcceptanceInput {
  readonly schemaVersion: "CliWorkflowAcceptanceInputV1";
  readonly nonce: string;
  readonly engine: "codex" | "copilot";
  readonly repoFullName: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly workerNodeId: string;
  readonly workerToken: string;
  readonly controlToken: string;
  readonly workerDirectory: string;
  readonly bareDirectory: string;
  readonly nodeExecutablePath: string;
  readonly gitExecutablePath: string;
  readonly processHostPath: string;
  readonly cliExecutablePath: string;
  readonly cliVersion: string;
  readonly fixtureCheckScript: "check.mjs";
  readonly reviewPrompt: string;
  readonly maximumRunMs: number;
}
export interface WorkerAcceptanceReady {
  readonly serverUrl: string;
  readonly engine: "codex" | "copilot";
  readonly workerNodeId: string;
  readonly ordinaryRunId: string;
  readonly nonce?: string;
}
export interface WorkerAcceptanceProgress {
  readonly at: string;
  readonly kind: string;
  readonly engine: "codex" | "copilot";
  readonly details: unknown;
}
export interface WorkerAcceptanceOptions {
  readonly onProgress?: (progress: WorkerAcceptanceProgress) => void;
}
interface TaskObservation {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerInstanceId: string;
  readonly runId: string;
  readonly purpose: "ordinary" | "evaluation";
  readonly evaluationId: string | null;
  readonly arm: "baseline" | "candidate" | null;
  readonly promptSha256: string;
  readonly startedAt: string;
  finishedAt?: string;
  outcome?: string;
  resultDigest?: string;
  resultSchema?: string;
  modelState?: string;
  requiredChecksPassed?: boolean;
  qualityFindingObserved?: boolean;
}
interface ProcessObservation {
  readonly requestId: string;
  readonly processId: number;
  readonly executable: string;
  readonly startedAt: string;
  readonly cli: boolean;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  failure?: { readonly name: string; readonly code: string | null };
}
export interface WorkerAcceptanceReceipt {
  readonly schemaVersion: "CliWorkflowWorkerReceiptV1";
  readonly engine: "codex" | "copilot";
  readonly status: "passed" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly failure: unknown;
  readonly tasks: readonly TaskObservation[];
  readonly processes: readonly ProcessObservation[];
  readonly serverStatus: unknown;
  readonly workspaceEntries: readonly string[];
  readonly admittedReservations: number;
  readonly releasedReservations: number;
  readonly activeReservations: number;
  readonly abandonedReservations: number;
  readonly activeMonitors: number;
  readonly preparedWorkspaces: readonly unknown[];
  readonly cleanups: readonly unknown[];
  readonly sourceObservations: readonly unknown[];
  readonly gitFetchMappings: readonly unknown[];
  readonly terminalAcknowledgements: readonly unknown[];
  readonly activeProcessRequests: number;
  readonly completedProcessTrees: number;
  readonly hostClosed: unknown;
  readonly events: readonly WorkerAcceptanceProgress[];
}

/** Runs three Server-scheduled tasks through production Worker components on one Windows Host. */
export async function runWorker(
  suppliedInput: WorkerAcceptanceInput,
  suppliedReady: WorkerAcceptanceReady,
  options: WorkerAcceptanceOptions = {},
): Promise<WorkerAcceptanceReceipt> {
  const input = structuredClone(suppliedInput),
    ready = structuredClone(suppliedReady);
  assert.equal(process.platform, "win32");
  assert.equal(input.schemaVersion, "CliWorkflowAcceptanceInputV1");
  assert.match(input.repoFullName, /^agentic-review-fixture\/workflow-[a-f0-9]{16}$/u);
  assert.equal(input.fixtureCheckScript, "check.mjs");
  assert.match(input.baseSha, /^[a-f0-9]{40}$/u);
  assert.match(input.headSha, /^[a-f0-9]{40}$/u);
  assert.equal(ready.engine, input.engine);
  assert.equal(ready.workerNodeId, input.workerNodeId);
  if (ready.nonce !== undefined) assert.equal(ready.nonce, input.nonce);
  assert.ok(
    Number.isSafeInteger(input.maximumRunMs) &&
      input.maximumRunMs >= 60_000 &&
      input.maximumRunMs <= 3_600_000,
  );
  const serverUrl = new URL(ready.serverUrl);
  assert.ok(
    serverUrl.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(serverUrl.hostname),
  );
  assert.equal(serverUrl.username + serverUrl.password + serverUrl.search + serverUrl.hash, "");
  assert.equal(serverUrl.pathname, "/");
  for (const path of [
    input.workerDirectory,
    input.bareDirectory,
    input.nodeExecutablePath,
    input.gitExecutablePath,
    input.processHostPath,
    input.cliExecutablePath,
  ])
    assert.ok(/^[A-Za-z]:[\\/]/u.test(path));
  assert.notEqual(win32.normalize(input.workerDirectory), win32.parse(input.workerDirectory).root);
  assert.ok(!overlaps(input.workerDirectory, input.bareDirectory));
  const bareDirectory = await realpath(input.bareDirectory);
  assert.ok((await lstat(join(bareDirectory, "HEAD"))).isFile());
  assert.ok((await lstat(join(bareDirectory, "objects"))).isDirectory());
  await mkdir(input.workerDirectory);
  const directory = await realpath(input.workerDirectory);
  const paths = {
    workspaces: join(directory, "workspaces"),
    gitShared: join(directory, "git-cache"),
    gitRuntime: join(directory, "git-runtime"),
    temp: join(directory, "runtime-temp"),
  };
  for (const path of Object.values(paths)) await mkdir(path);
  const environment = snapshotAccountEnvironment(process.env, [
    input.workerToken,
    input.controlToken,
  ]);
  const systemRoot = required(environment, "SYSTEMROOT"),
    comSpec = required(environment, "COMSPEC");
  const cliPath = required(environment, "PATH"),
    pathExt = required(environment, "PATHEXT");
  // Git and Node use explicit executable paths. The workspace provider requires PATH
  // to remain separate from the Git installation and the disposable workspace root.
  const gitPath = join(systemRoot, "System32");
  const baseEnvironment = {
    SYSTEMROOT: systemRoot,
    COMSPEC: comSpec,
    PATH: gitPath,
    PATHEXT: pathExt,
  };
  const secrets = [
    input.workerToken,
    input.controlToken,
    ...Object.entries(environment)
      .filter(([name]) =>
        /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL/iu.test(name),
      )
      .map(([, value]) => value),
  ].filter(Boolean);
  const events: WorkerAcceptanceProgress[] = [];
  const emit = (kind: string, details: unknown): void => {
    const event = {
      at: new Date().toISOString(),
      engine: input.engine,
      kind,
      details: safeValue(details, secrets),
    };
    if (events.length < 4096) events.push(event);
    try {
      options.onProgress?.(event);
    } catch {
      /* Progress rendering does not own the run. */
    }
  };
  const logger = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (message: string, fields?: LogFields) => emit("worker_log", { level, message, fields }),
    ]),
  ) as unknown as Logger;
  const tasks: TaskObservation[] = [],
    processes: ProcessObservation[] = [];
  const preparedWorkspaces: { attemptId: string; purpose: string; directory: string }[] = [];
  const cleanups: { attemptId: string; purpose: string; directory: string; completedAt: string }[] =
    [];
  const sourceObservations: { attemptId: string; purpose: string; state: string }[] = [];
  const terminalAcknowledgements: { attemptId: string; operation: string; at: string }[] = [];
  const gitFetchMappings: { source: string; destination: string; refspecs: string[] }[] = [];
  const activeRequests = new Set<string>(),
    activeReservations = new Set<string>(),
    activeMonitors = new Set<symbol>();
  let admittedReservations = 0,
    releasedReservations = 0,
    abandonedReservations = 0;
  let host: StdioProcessHostClient | undefined,
    service: WorkerService | undefined,
    serviceRun: Promise<void> | undefined;
  let serviceFailure: unknown,
    fatalExecutionError: unknown,
    hostChild: ChildProcessWithoutNullStreams | undefined;
  let hostClosedPromise:
    | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
    | undefined;
  let hostClosed: unknown = null,
    failure: unknown = null,
    serverStatus: unknown = null;
  let workspaceEntries: string[] = [];
  let completedProcessTrees = 0;
  const startedAt = new Date().toISOString(),
    deadline = AbortSignal.timeout(input.maximumRunMs);
  try {
    host = await bounded(
      StdioProcessHostClient.create({
        processHostPath: input.processHostPath,
        instanceKey: deriveWorkerProcessHostInstanceKey({ dataDirectory: directory }),
        maximumConcurrentRequests: 1,
        hostEnvironment: { SYSTEMROOT: systemRoot, TEMP: paths.temp, TMP: paths.temp },
        requestTimeoutMs: 15_000,
        startTimeoutMs: 30_000,
        shutdownTimeoutMs: 15_000,
        spawnProcess: (executable, args, spawnOptions) => {
          const child = spawn(executable, [...args], {
            ...spawnOptions,
            stdio: ["pipe", "pipe", "pipe"],
          });
          hostChild = child;
          hostClosedPromise = new Promise((resolve) =>
            child.once("close", (code, signal) => resolve({ code, signal })),
          );
          return child;
        },
      }),
      45_000,
      "HOST_START_TIMEOUT",
    );
    const actualHost = host;
    const processHost: ProcessHostClient = {
      start: async (spec, signal) => {
        const cli = samePath(spec.executable, input.cliExecutablePath);
        if (cli && processes.filter((entry) => entry.cli).length >= 3) {
          fatalExecutionError = new Error(
            "The acceptance scope permits only three model processes per engine.",
          );
          throw fatalExecutionError;
        }
        assert.ok(
          [input.gitExecutablePath, input.nodeExecutablePath, input.cliExecutablePath].some(
            (path) => samePath(path, spec.executable),
          ),
        );
        const managed = await actualHost.start(spec, signal);
        const observation: ProcessObservation = {
          requestId: managed.requestId,
          processId: managed.processId,
          executable: spec.executable,
          startedAt: new Date().toISOString(),
          cli,
        };
        processes.push(observation);
        activeRequests.add(managed.requestId);
        void managed.completed.then(
          (exit) => {
            observation.completedAt = new Date().toISOString();
            observation.exitCode = exit.exitCode;
            observation.signal = exit.signal;
            activeRequests.delete(managed.requestId);
          },
          (error: unknown) => {
            observation.completedAt = new Date().toISOString();
            observation.failure = errorIdentity(error);
          },
        );
        if (cli)
          emit("cli_started", {
            requestId: managed.requestId,
            modelProcess: processes.filter((entry) => entry.cli).length,
          });
        return managed;
      },
      terminateAll: (reason) => actualHost.terminateAll(reason),
      close: () => actualHost.close(),
    };
    const actualDiskBudget = new ProductionWorkspaceDiskBudget({
      workspaceRootDirectory: paths.workspaces,
      perAttemptDiskBytes: 256n * 1024n ** 2n,
      totalWorkspaceDiskBytes: 1024n * 1024n ** 2n,
      minimumFreeDiskBytes: 256n * 1024n ** 2n,
      maximumAccountingEntries: 100_000,
      maximumScanDurationMilliseconds: 30_000,
      orphanScanLimit: 100,
    });
    await actualDiskBudget.recoverOrphans();
    const diskBudget: WorkspaceDiskBudget = {
      admit: async (path, signal) => {
        const reservation = await actualDiskBudget.admit(path, signal);
        activeReservations.add(path);
        admittedReservations++;
        return {
          attemptDirectory: reservation.attemptDirectory,
          startMonitoring: async (parentSignal) => {
            const monitor = await reservation.startMonitoring(parentSignal),
              id = Symbol();
            activeMonitors.add(id);
            return {
              signal: monitor.signal,
              get violation() {
                return monitor.violation;
              },
              close: async () => {
                await monitor.close();
                activeMonitors.delete(id);
              },
            };
          },
          removeCheckout: () => reservation.removeCheckout(),
          removeAttempt: () => reservation.removeAttempt(),
          release: async () => {
            await reservation.release();
            if (activeReservations.delete(path)) releasedReservations++;
          },
          abandon: () => {
            reservation.abandon();
            if (activeReservations.delete(path)) abandonedReservations++;
          },
        };
      },
    };
    const realProcessRunner = new ProductionManagedProcessRunner();
    const localGitRunner: ManagedProcessRunner = {
      run: async (original, context) => {
        assert.ok(samePath(original.executable, input.gitExecutablePath));
        let spec = original;
        const fetch = original.arguments.indexOf("fetch");
        if (fetch !== -1) {
          const argumentsList = [...original.arguments];
          const origin = argumentsList.indexOf("origin", fetch + 1),
            policy = argumentsList.indexOf("protocol.file.allow=never");
          assert.ok(origin > fetch && policy >= 0);
          const refspecs = argumentsList.slice(origin + 1);
          assert.equal(refspecs.length, 2);
          assert.equal(refspecs[0], `+${input.baseSha}:refs/agentic-review/latest-base`);
          assert.ok(
            [
              `+refs/pull/1/head:refs/agentic-review/latest-head`,
              `+${input.headSha}:refs/agentic-review/latest-head`,
            ].includes(refspecs[1] ?? ""),
          );
          argumentsList[origin] = bareDirectory;
          argumentsList[policy] = "protocol.file.allow=always";
          spec = { ...original, arguments: argumentsList };
          gitFetchMappings.push({ source: "origin", destination: bareDirectory, refspecs });
        }
        if (original.arguments.includes("remote.origin.url"))
          assert.equal(original.arguments.at(-1), `https://github.com/${input.repoFullName}.git`);
        return realProcessRunner.run(spec, context);
      },
    };
    const actualWorkspaces = new ProductionDisposableJobWorkspaceProvider({
      workspaceRootDirectory: paths.workspaces,
      gitSharedRootDirectory: paths.gitShared,
      gitExecutable: input.gitExecutablePath,
      gitWorkingDirectory: paths.gitRuntime,
      gitEnvironment: baseEnvironment,
      gitLimits: {
        hardTimeoutMs: 30_000,
        maximumProcessCount: 8,
        maximumMemoryBytes: 512 * 1024 ** 2,
        maximumOutputBytes: 1024 ** 2,
      },
      gitSharedCachePolicy: {
        maximumTotalBytes: 512n * 1024n ** 2n,
        minimumFreeBytes: 256n * 1024n ** 2n,
        maximumScanEntries: 100_000,
        maximumScanDurationMs: 30_000,
        gcMinimumIntervalMs: 60_000,
        gcPruneAgeHours: 24,
      },
      diskBudget,
      processRunner: localGitRunner,
      logger,
    });
    const workspaces: JobWorkspaceProvider = {
      prepare: async (envelope, context, purpose = "validation") => {
        validateFixtureEnvelope(envelope, input);
        const workspace = await actualWorkspaces.prepare(envelope, context, purpose);
        preparedWorkspaces.push({
          attemptId: envelope.lease.runAttemptId,
          purpose,
          directory: workspace.attemptDirectory,
        });
        const observation = { attemptId: envelope.lease.runAttemptId, purpose };
        let cleanup: Promise<void> | undefined;
        return {
          ...workspace,
          captureWorktreeState: async (signal) => {
            const state = (await workspace.captureWorktreeState?.(signal)) ?? "unknown";
            sourceObservations.push({ ...observation, state });
            return state;
          },
          cleanup: () => {
            cleanup ??= workspace.cleanup().then(() => {
              cleanups.push({
                ...observation,
                directory: workspace.attemptDirectory,
                completedAt: new Date().toISOString(),
              });
            });
            return cleanup;
          },
        } satisfies PreparedJobWorkspace;
      },
    };
    const reviewOptions = {
      engine: input.engine,
      cliExecutablePath: input.cliExecutablePath,
      cliVersion: input.cliVersion,
      cliEnvironment: environment,
      userProfileDirectory: required(environment, "USERPROFILE"),
      ...(environment.APPDATA === undefined ? {} : { appDataDirectory: environment.APPDATA }),
      ...(environment.LOCALAPPDATA === undefined
        ? {}
        : { localAppDataDirectory: environment.LOCALAPPDATA }),
      systemRoot,
      comSpec,
      path: cliPath,
      pathExt,
      maximumHardTimeoutMs: 300_000,
      maximumProcessCount: 32,
      maximumMemoryBytes: 8 * 1024 ** 3,
      maximumOutputBytes: 8 * 1024 ** 2,
      logger,
    };
    const profiles = new ProfileJobExecutor({
      workspaceProvider: workspaces,
      legacyExecutor: new ReviewJobExecutor({ ...reviewOptions, workspaceProvider: workspaces }),
      createModelExecutor: (provider) =>
        new ReviewJobExecutor({ ...reviewOptions, workspaceProvider: provider }),
      createHeadlessRunner: (_envelope, context, workspace) =>
        new HeadlessValidationCheckRunner({
          baseEnvironment: {
            ...baseEnvironment,
            TEMP: workspace.tempDirectory,
            TMP: workspace.tempDirectory,
            USERPROFILE: workspace.userProfileDirectory,
          },
          resolveExecutable: async (name, signal) => {
            signal.throwIfAborted();
            assert.equal(name, "node");
            return input.nodeExecutablePath;
          },
          limits: {
            hardTimeoutMs: Math.min(300_000, input.maximumRunMs),
            maximumProcessCount: 8,
            maximumMemoryBytes: 512 * 1024 ** 2,
            maximumOutputBytes: 1024 ** 2,
          },
          cleanupTimeoutMs: 15_000,
          onProcessProgress: (progress) =>
            context.reportProgress({ phase: "validation", processCount: progress.processCount }),
        }),
    });
    const executor: JobExecutor = {
      execute: async (envelope, context) => {
        try {
          if (fatalExecutionError !== undefined) throw fatalExecutionError;
          validateFixtureEnvelope(envelope, input);
          assert.equal(envelope.envelopeVersion, 2);
          const frozen = envelope as JobExecutionEnvelopeV2,
            evaluation =
              frozen.validation.schemaVersion === "ValidationJobContextV2"
                ? frozen.validation
                : undefined;
          assert.ok(tasks.length < 3 && !tasks.some((task) => task.jobId === envelope.job.jobId));
          const task: TaskObservation = {
            jobId: envelope.job.jobId,
            attemptId: envelope.lease.runAttemptId,
            workerInstanceId: envelope.lease.workerInstanceId,
            runId: frozen.validation.runId,
            purpose: evaluation === undefined ? "ordinary" : "evaluation",
            evaluationId: evaluation?.purpose.evaluationId ?? null,
            arm: evaluation?.purpose.arm ?? null,
            promptSha256: envelope.prompt.promptSha256,
            startedAt: new Date().toISOString(),
          };
          tasks.push(task);
          emit("task_started", task);
          const result = await profiles.execute(envelope, {
            ...context,
            reportProgress: (progress) => {
              context.reportProgress(progress);
              emit("task_progress", { attemptId: task.attemptId, ...progress });
            },
          });
          task.finishedAt = new Date().toISOString();
          task.outcome = result.outcome;
          if (result.outcome === "succeeded") {
            assert.equal(createCanonicalResult(result.result).sha256, result.resultDigest);
            const value = result.result;
            assert.ok(
              Value.Check(ValidationJobResultV1Schema, value) ||
                Value.Check(ValidationJobResultV2Schema, value),
            );
            if (value.schemaVersion === "ValidationJobResultV2")
              assert.deepEqual(getValidationJobResultV2Issues(value), []);
            task.resultDigest = result.resultDigest;
            task.resultSchema = value.schemaVersion;
            task.modelState = value.modelReview.state;
            task.requiredChecksPassed = value.report.checks
              .filter((check) => check.required)
              .every((check) => check.outcome === "passed");
            const model =
              value.modelReview.state === "completed" ? value.modelReview.result : undefined;
            task.qualityFindingObserved =
              model?.schemaVersion === "PrReviewPlanV2" &&
              model.findings.some(
                (finding) =>
                  finding.path === "src/discount.js" &&
                  finding.line <= 2 &&
                  (finding.endLine ?? finding.line) >= 2,
              );
            if (
              value.schemaVersion === "ValidationJobResultV2" &&
              value.modelReview.state === "completed"
            ) {
              assert.equal(value.modelReview.execution.jobId, task.jobId);
              assert.equal(value.modelReview.execution.runAttemptId, task.attemptId);
              assert.equal(value.modelReview.execution.cli.kind, input.engine);
              assert.equal(value.modelReview.execution.promptSha256, task.promptSha256);
            }
          }
          emit("task_finished", task);
          return result;
        } catch (error) {
          fatalExecutionError = error;
          throw error;
        }
      },
    };
    const config: WorkerConfig = {
      serverUrl,
      protocolVersion: "1.0",
      workerNodeId: input.workerNodeId,
      workerToken: input.workerToken,
      displayName: `Owned ${input.engine} acceptance Worker`,
      workerVersion: "m39-cli-workflow-acceptance",
      maxSlots: 1,
      dataDirectory: directory,
      executionEnabled: true,
      claimWaitSeconds: 1,
      registrationRetrySeconds: 1,
      idleDelayMilliseconds: 100,
      heartbeatIntervalSeconds: 1,
      heartbeatSafetyMarginSeconds: 10,
      shutdownGraceSeconds: 60,
      requestTimeoutSeconds: 10,
      logLevel: "error",
      allowInsecureHttp: true,
      capabilities: createRuntimeCapabilities(
        {
          operatingSystem: "windows",
          architecture: "x64",
          headless: true,
          interactiveDesktop: false,
          cliEngine: input.engine,
          cliVersion: input.cliVersion,
          recipeIds: [],
          labels: {},
        },
        {
          execution: true,
          envelopeV2: true,
          headless: true,
          web: false,
          windowsDesktop: false,
          evidenceDelivery: false,
          evaluationModelReview: true,
        },
      ),
    };
    const httpApi = new HttpWorkerApi(config, logger);
    const recordTerminalAcknowledgement = (attemptId: string, operation: "complete" | "fail") => {
      terminalAcknowledgements.push({ attemptId, operation, at: new Date().toISOString() });
      const task = tasks.find((entry) => entry.attemptId === attemptId);
      if (
        operation === "fail" ||
        task?.outcome !== "succeeded" ||
        task.modelState !== "completed" ||
        task.requiredChecksPassed !== true
      ) {
        fatalExecutionError ??= Object.assign(
          new Error("The acknowledged task did not complete its required checks and model step."),
          { code: "ACCEPTANCE_TASK_FAILED" },
        );
        // Drain synchronously after the real ACK so cleanup can finish without claiming another task.
        service?.requestDrain("acceptance_task_failed_after_acknowledgement");
        emit("task_failed_after_acknowledgement", {
          attemptId,
          operation,
          outcome: task?.outcome ?? null,
          modelState: task?.modelState ?? null,
          requiredChecksPassed: task?.requiredChecksPassed ?? null,
        });
      }
    };
    const api: WorkerApi = {
      register: (request, signal) => httpApi.register(request, signal),
      claimLease: (request, signal) => {
        if (fatalExecutionError !== undefined) return Promise.reject(fatalExecutionError);
        return httpApi.claimLease(request, signal);
      },
      heartbeat: (instance, request, signal) => httpApi.heartbeat(instance, request, signal),
      completeRun: async (attemptId, request, signal) => {
        const response = await httpApi.completeRun(attemptId, request, signal);
        recordTerminalAcknowledgement(attemptId, "complete");
        return response;
      },
      failRun: async (attemptId, request, signal) => {
        const response = await httpApi.failRun(attemptId, request, signal);
        recordTerminalAcknowledgement(attemptId, "fail");
        return response;
      },
    };
    service = new WorkerService(config, api, executor, processHost, logger, (signal) =>
      actualDiskBudget.hasCapacity(signal),
    );
    serviceRun = service.run();
    void serviceRun.catch((error: unknown) => {
      serviceFailure = error;
    });
    let lastPhase: string | undefined;
    while (true) {
      deadline.throwIfAborted();
      if (serviceFailure !== undefined) throw serviceFailure;
      if (fatalExecutionError !== undefined) throw fatalExecutionError;
      const response = await fetch(new URL("/__acceptance/status", serverUrl), {
        headers: { authorization: `Bearer ${input.controlToken}` },
        signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      });
      assert.ok(response.ok, "The acceptance status endpoint failed.");
      const status: unknown = await response.json();
      assert.ok(
        status !== null &&
          typeof status === "object" &&
          "phase" in status &&
          typeof status.phase === "string",
      );
      serverStatus = status;
      if (lastPhase !== status.phase) {
        lastPhase = status.phase;
        emit("server_phase", { phase: lastPhase });
      }
      if (status.phase === "failed")
        throw new Error("The acceptance Server reported a failed workflow.");
      if (status.phase === "complete") {
        assert.ok(
          "passed" in status && status.passed === true,
          "The Server completed with failed tasks.",
        );
        assert.equal(tasks.length, 3);
        assert.equal(tasks[0]?.purpose, "ordinary");
        assert.equal(tasks[0]?.runId, ready.ordinaryRunId);
        assert.equal(new Set(tasks.map((task) => task.workerInstanceId)).size, 1);
        assert.equal(new Set(tasks.map((task) => task.attemptId)).size, 3);
        assert.ok(
          tasks.every(
            (task) =>
              task.outcome === "succeeded" &&
              task.modelState === "completed" &&
              task.requiredChecksPassed,
          ),
        );
        const evaluations = tasks.filter((task) => task.purpose === "evaluation");
        assert.equal(evaluations.length, 2);
        assert.deepEqual(evaluations.map((task) => task.arm).sort(), ["baseline", "candidate"]);
        assert.equal(new Set(evaluations.map((task) => task.evaluationId)).size, 1);
        break;
      }
      await delay(500, undefined, { signal: deadline });
    }
  } catch (error) {
    failure = safeValue(error, secrets);
    emit("acceptance_failed", failure);
  } finally {
    if (service !== undefined) {
      const stopping = service.stop(
        failure === null ? "acceptance_three_tasks_complete" : "acceptance_failed",
      );
      void stopping.catch(() => undefined);
      if (failure !== null && host !== undefined)
        await bounded(host.terminateAll("worker_shutdown"), 15_000, "TERMINATION_TIMEOUT").catch(
          (error: unknown) => {
            failure ??= safeValue(error, secrets);
          },
        );
      await bounded(stopping, 75_000, "WORKER_STOP_TIMEOUT").catch((error: unknown) => {
        failure ??= safeValue(error, secrets);
      });
    }
    if (host !== undefined)
      await bounded(host.close(), 20_000, "HOST_CLOSE_TIMEOUT").catch((error: unknown) => {
        failure ??= safeValue(error, secrets);
        hostChild?.kill();
      });
    else hostChild?.kill();
    if (serviceRun !== undefined)
      await bounded(serviceRun, 5_000, "WORKER_RUN_SETTLEMENT_TIMEOUT").catch((error: unknown) => {
        failure ??= safeValue(error, secrets);
      });
    if (hostClosedPromise !== undefined)
      hostClosed = await bounded(hostClosedPromise, 10_000, "HOST_EXIT_TIMEOUT").catch(
        (error: unknown) => {
          failure ??= safeValue(error, secrets);
          return null;
        },
      );
    workspaceEntries = await readdir(paths.workspaces);
    // ProcessHost publishes completion after the entire Job Object has drained.
    // Windows can reuse an exited process's PID for an unrelated process during this run.
    completedProcessTrees = processes.filter(
      (entry) =>
        entry.completedAt !== undefined &&
        entry.failure === undefined &&
        entry.exitCode !== undefined &&
        entry.signal !== undefined,
    ).length;
    try {
      assert.equal(workspaceEntries.length, 0);
      assert.equal(activeReservations.size, 0);
      assert.equal(activeMonitors.size, 0);
      assert.equal(abandonedReservations, 0);
      assert.equal(admittedReservations, 6);
      assert.equal(releasedReservations, 6);
      assert.equal(preparedWorkspaces.length, 6);
      assert.equal(cleanups.length, 6);
      assert.equal(activeRequests.size, 0);
      assert.equal(completedProcessTrees, processes.length);
      assert.equal(processes.filter((entry) => entry.cli).length, 3);
      assert.ok(
        processes.every(
          (entry) => entry.failure === undefined && entry.exitCode === 0 && entry.signal === null,
        ),
      );
      assert.ok(sourceObservations.every((entry) => entry.state === "clean"));
      assert.ok(
        hostClosed !== null &&
          typeof hostClosed === "object" &&
          "code" in hostClosed &&
          hostClosed.code === 0,
      );
      for (const cleanup of cleanups) {
        const terminal = terminalAcknowledgements.find(
          (entry) => entry.attemptId === cleanup.attemptId && entry.operation === "complete",
        );
        assert.ok(terminal && Date.parse(terminal.at) <= Date.parse(cleanup.completedAt));
      }
    } catch (error) {
      failure ??= safeValue(error, secrets);
    }
  }
  emit("acceptance_finished", {
    status: failure === null ? "passed" : "failed",
    tasks: tasks.length,
    workspacesRemaining: workspaceEntries.length,
  });
  const receipt: WorkerAcceptanceReceipt = {
    schemaVersion: "CliWorkflowWorkerReceiptV1",
    engine: input.engine,
    status: failure === null ? "passed" : "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    failure,
    tasks,
    processes,
    serverStatus: safeValue(serverStatus, secrets),
    workspaceEntries,
    admittedReservations,
    releasedReservations,
    activeReservations: activeReservations.size,
    abandonedReservations,
    activeMonitors: activeMonitors.size,
    preparedWorkspaces,
    cleanups,
    sourceObservations,
    gitFetchMappings,
    terminalAcknowledgements,
    activeProcessRequests: activeRequests.size,
    completedProcessTrees,
    hostClosed,
    events: [...events],
  };
  await writeFile(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  return receipt;
}

function validateFixtureEnvelope(
  envelope: JobExecutionEnvelope,
  input: WorkerAcceptanceInput,
): void {
  assert.equal(envelope.repository.fullName, input.repoFullName);
  assert.equal(envelope.job.kind, "pull_request_review");
  assert.equal(envelope.resource.kind, "pull_request");
  if (envelope.resource.kind !== "pull_request") throw new Error("Unexpected fixture resource.");
  assert.equal(envelope.resource.number, 1);
  assert.equal(envelope.resource.baseSha, input.baseSha);
  assert.equal(envelope.resource.headSha, input.headSha);
  if (envelope.envelopeVersion === 2) {
    assert.equal(envelope.validation.workflowKind, "pr_static_build");
    assert.equal(envelope.validation.target, "headless");
    const config = envelope.validation.profileVersion.config;
    assert.equal(config.launch.length, 0);
    assert.equal(config.ui, undefined);
    for (const step of [...config.setup, ...config.build, ...config.test, ...config.cleanup]) {
      assert.equal(step.command.executable, "node");
      assert.equal(step.command.workingDirectory, ".");
      assert.equal(step.command.environment.length, 0);
      assert.ok(
        JSON.stringify(step.command.args) === JSON.stringify([input.fixtureCheckScript]) ||
          JSON.stringify(step.command.args) === JSON.stringify(["--check", "src/discount.js"]),
      );
    }
  }
}
function snapshotAccountEnvironment(
  source: NodeJS.ProcessEnv,
  controlValues: readonly string[],
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source)
        .filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            !/^(?:WORKER_|SERVER_|AGENTIC_REVIEW_)/u.test(entry[0].toUpperCase()) &&
            !controlValues.some((secret) => secret.length > 0 && entry[1]?.includes(secret)),
        )
        .map(([name, value]) => [name.toUpperCase(), value]),
    ),
  );
}
function required(environment: Readonly<Record<string, string>>, name: string): string {
  const value = environment[name];
  if (value === undefined || !value.trim())
    throw new Error(`Missing required account environment name: ${name}`);
  return value;
}
function samePath(first: string, second: string): boolean {
  return win32.normalize(first).toLowerCase() === win32.normalize(second).toLowerCase();
}
function overlaps(first: string, second: string): boolean {
  const left = win32.normalize(first).toLowerCase(),
    right = win32.normalize(second).toLowerCase();
  return left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`);
}
function errorIdentity(error: unknown): { name: string; code: string | null } {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    code:
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : null,
  };
}
function safeValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth >= 8) return "[diagnostic depth limit]";
  if (value instanceof Error)
    return {
      ...errorIdentity(value),
      message: redactExecutionText(value.message, secrets),
      ...(value.cause === undefined ? {} : { cause: safeValue(value.cause, secrets, depth + 1) }),
    };
  if (typeof value === "string") return redactExecutionText(value, secrets);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => safeValue(item, secrets, depth + 1));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, safeValue(item, secrets, depth + 1)]),
    );
  return value;
}
async function bounded<T>(operation: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
