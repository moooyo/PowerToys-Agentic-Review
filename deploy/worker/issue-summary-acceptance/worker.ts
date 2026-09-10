import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { pipeline, type Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createCanonicalResult, redactExecutionText } from "@agentic-review/codex";
import type { JobExecutionEnvelopeV2 } from "@agentic-review/contracts";
import { loadWorkerConfig } from "../../../apps/worker/src/config.js";
import type { JobExecutor } from "../../../apps/worker/src/execution/job-executor.js";
import { ConsoleJsonLogger, type LogFields } from "../../../apps/worker/src/logging/logger.js";
import type { createExecutionRuntime } from "../../../apps/worker/src/main.js";
import { HttpWorkerApi } from "../../../apps/worker/src/server-client/http-worker-api.js";
import { WorkerService } from "../../../apps/worker/src/worker-service.js";
import {
  assertMeasurement,
  fixedRevision,
  type IssueSummaryInput,
  type IssueSummaryReady,
  repositoryFullName,
} from "./case.js";

interface TaskObservation {
  readonly jobId: string;
  readonly runAttemptId: string;
  readonly workerInstanceId: string;
  readonly runId: string;
  readonly purpose: "ordinary" | "evaluation";
  readonly evaluationId: string | null;
  readonly arm: "baseline" | "candidate" | null;
  readonly startedAt: string;
  finishedAt?: string;
  outcome?: string;
  resultDigest?: string;
  measurement?: ReturnType<typeof assertMeasurement>;
}

async function bounded<T>(work: Promise<T>, label: string, maximumMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle within ${maximumMs} ms.`)),
          maximumMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Preserves consumer bytes and backpressure while retaining a bounded diagnostic sample. */
export function captureCliDiagnostic(source: Readable, sensitiveValues: readonly string[]) {
  const secrets = expandSensitiveValues(sensitiveValues);
  const maximumBytes = 8 * 1024;
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let byteLength = 0;
  let retainedBytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      byteLength += bytes.length;
      const remaining = maximumBytes - retainedBytes;
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        chunks.push(Buffer.from(retained));
        retainedBytes += retained.length;
      }
      callback(null, chunk);
    },
  });
  const completed = finished(stream, { cleanup: true })
    .then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    )
    .then((error) => {
      const capturedText = Buffer.concat(chunks).toString("utf8");
      // Drop the last token if capture ends mid-stream, so a split credential prefix is not kept.
      const diagnosticInput =
        byteLength > retainedBytes
          ? capturedText.replace(/\S+$/u, "[truncated token]")
          : capturedText;
      return {
        byteLength,
        sha256: hash.digest("hex"),
        retainedBytes,
        captureTruncated: byteLength > retainedBytes,
        diagnostic: redactExecutionText(diagnosticInput, secrets),
        diagnosticCharacterLimit: 2048,
        diagnosticTruncated: capturedText.length > 2048 || byteLength > retainedBytes,
        error:
          error === null ? null : redactExecutionText(`${error.name}: ${error.message}`, secrets),
        rawBytesRetained: false,
      };
    });
  pipeline(source, stream, (error) => {
    if (error && !stream.destroyed) stream.destroy(error);
  });
  return { stream, completed };
}

function expandSensitiveValues(values: Iterable<string>): string[] {
  return [
    ...new Set(
      [...values]
        .filter((value) => value.length > 0)
        .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ];
}

/** Starts one real Windows runtime; the caller supplies a separately imported production bundle. */
export async function runWorker(
  input: IssueSummaryInput,
  ready: IssueSummaryReady,
  options: {
    readonly createRuntime: typeof createExecutionRuntime;
    readonly onProgress?: (entry: unknown) => void;
  },
) {
  assert.equal(process.platform, "win32");
  assert.equal(input.schemaVersion, "IssueSummaryAcceptanceInputV1");
  assert.equal(input.nonce, ready.nonce);
  assert.equal(input.engine, ready.engine);
  assert.equal(input.workerNodeId, ready.workerNodeId);
  assert.equal(
    win32.normalize(process.execPath).toLowerCase(),
    win32.normalize(input.nodeExecutablePath).toLowerCase(),
  );
  const url = new URL(ready.serverUrl);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/");
  assert.ok(
    Number.isSafeInteger(input.maximumRunMs) &&
      input.maximumRunMs >= 120_000 &&
      input.maximumRunMs <= 3_600_000,
  );
  await mkdir(input.workerDirectory);
  const resultsDirectory = join(input.workerDirectory, "results");
  await mkdir(resultsDirectory);
  const startedAt = new Date().toISOString();
  const tasks: TaskObservation[] = [];
  const events: unknown[] = [];
  const nativeProcesses: {
    requestId: string;
    processId: number;
    executable: string;
    kind: "cli" | "probe" | "git" | "other";
    argumentsSha256: string;
    startedAt: string;
    completedAt?: string;
    completion?: unknown;
    failure?: unknown;
  }[] = [];
  const terminalAcknowledgements: unknown[] = [];
  const frozenInputs: unknown[] = [];
  const cleanupCallbacks: unknown[] = [];
  const settledProcesses: Promise<unknown>[] = [];
  let activeProcesses = 0;
  let fatal: unknown;
  let failure: unknown = null;
  let serverStatus: { phase?: string; passed?: boolean } | undefined;
  let hostClosed = false;
  let workspaceEntries: string[] = [];
  let instanceId: string | undefined;
  let runtime: Awaited<ReturnType<typeof createExecutionRuntime>> | undefined;
  let service: WorkerService | undefined;
  let serviceRun: Promise<void> | undefined;
  const retainedEnvironment = new Map<string, string>();
  const sensitiveValues = new Set([input.workerToken, input.controlToken]);
  const environmentKeys = /^(?:WORKER_|SERVER_|AGENTIC_REVIEW_)/iu;
  const scrub = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        item instanceof Error
          ? { name: item.name, message: item.message }
          : typeof item === "string"
            ? expandSensitiveValues(sensitiveValues).reduce(
                (text, secret) => text.replaceAll(secret, "[REDACTED]"),
                item,
              )
            : item,
      ),
    );
  const emit = (kind: string, details: unknown): void => {
    const event = scrub({ at: new Date().toISOString(), engine: input.engine, kind, details });
    events.push(event);
    options.onProgress?.(event);
  };
  class ReceiptLogger extends ConsoleJsonLogger {
    override debug(message: string, fields?: LogFields) {
      emit("debug", { message, ...fields });
    }
    override info(message: string, fields?: LogFields) {
      emit("info", { message, ...fields });
    }
    override warn(message: string, fields?: LogFields) {
      emit("warn", { message, ...fields });
    }
    override error(message: string, fields?: LogFields) {
      emit("error", { message, ...fields });
    }
  }
  const logger = new ReceiptLogger("info");
  const timer = setTimeout(() => {
    fatal = new Error("The complete Issue summary Worker acceptance exceeded its deadline.");
    void service?.stop("acceptance_deadline").catch((error: unknown) => {
      fatal = error;
    });
  }, input.maximumRunMs);
  const shutdown = (): void => {
    fatal = new Error("Issue summary acceptance was interrupted.");
    void service?.stop("acceptance_signal").catch((error: unknown) => {
      fatal = error;
    });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.once(signal, shutdown);
  try {
    // Preserve the configured CLI account while replacing only this run's Worker settings.
    for (const [name, value] of Object.entries(process.env))
      if (environmentKeys.test(name) && value !== undefined) {
        retainedEnvironment.set(name, value);
        delete process.env[name];
      }
    const digest = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    const settings = {
      WORKER_SERVER_URL: ready.serverUrl,
      WORKER_ALLOW_INSECURE_HTTP: "true",
      WORKER_DATA_DIR: input.workerDirectory,
      WORKER_EXECUTION_ENABLED: "true",
      WORKER_MODEL_EXECUTION_ENABLED: "true",
      WORKER_CLI_ENGINE: input.engine,
      WORKER_CLI_EXECUTABLE_PATH: input.cliExecutablePath,
      WORKER_CLI_SHA256: await digest(input.cliExecutablePath),
      WORKER_TRUSTED_EXECUTABLE_ROOT: input.trustedExecutableRoot,
      WORKER_PROCESS_HOST_PATH: input.processHostPath,
      WORKER_PROCESS_HOST_SHA256: await digest(input.processHostPath),
      WORKER_GIT_EXECUTABLE_PATH: input.gitExecutablePath,
      WORKER_GIT_SHA256: await digest(input.gitExecutablePath),
      WORKER_WORKSPACE_ROOT_DIRECTORY: join(input.workerDirectory, "Workspaces"),
      WORKER_GIT_SHARED_ROOT_DIRECTORY: join(input.workerDirectory, "Repositories"),
      WORKER_EXECUTION_TEMP_DIRECTORY: join(input.workerDirectory, "Temp"),
      WORKER_VALIDATION_HEADLESS_ENABLED: "true",
      WORKER_VALIDATION_WEB_ENABLED: "false",
      WORKER_VALIDATION_WINDOWS_ENABLED: "false",
      WORKER_VALIDATION_SUMMARY_ENABLED: "true",
      WORKER_VALIDATION_SUMMARY_TIMEOUT_MS: "300000",
      WORKER_MODEL_MAXIMUM_HARD_TIMEOUT_MS: "600000",
      WORKER_GIT_HARD_TIMEOUT_MS: "180000",
      WORKER_CLAIM_WAIT_SECONDS: "1",
      WORKER_IDLE_DELAY_MILLISECONDS: "100",
      WORKER_HEARTBEAT_SECONDS: "5",
      WORKER_HEARTBEAT_SAFETY_MARGIN_SECONDS: "5",
      WORKER_SHUTDOWN_GRACE_SECONDS: "20",
      WORKER_EXECUTION_MINIMUM_FREE_DISK_BYTES: String(1024 ** 3),
      WORKER_GIT_SHARED_MINIMUM_FREE_DISK_BYTES: String(1024 ** 3),
      WORKER_DISPLAY_NAME: `Issue summary ${input.engine} ${input.nonce.slice(0, 8)}`,
    };
    Object.assign(process.env, settings);
    const config = loadWorkerConfig(
      { ...process.env, NODE_ENV: "test" },
      {
        workerAuthFileReader: () =>
          Buffer.from(
            JSON.stringify({
              profileId: "agentic-review-worker-auth-v1",
              token: input.workerToken,
              workerNodeId: input.workerNodeId,
            }),
          ),
      },
    );
    const api = new HttpWorkerApi(config, logger);
    const register = api.register.bind(api);
    api.register = async (request, signal) => {
      assert.equal(request.workerNodeId, input.workerNodeId);
      if (instanceId !== undefined) assert.equal(request.workerInstanceId, instanceId);
      instanceId = request.workerInstanceId;
      return register(request, signal);
    };
    const complete = api.completeRun.bind(api);
    api.completeRun = async (attemptId, submission, signal) => {
      const response = await complete(attemptId, submission, signal);
      terminalAcknowledgements.push({ attemptId, response });
      return response;
    };
    const fail = api.failRun.bind(api);
    api.failRun = async (attemptId, submission, signal) => {
      const response = await fail(attemptId, submission, signal);
      terminalAcknowledgements.push({ attemptId, failure: true, response });
      return response;
    };
    const freeze = api.freezeValidationSummaryInput.bind(api);
    api.freezeValidationSummaryInput = async (request, signal) => {
      const response = await freeze(request, signal);
      frozenInputs.push({ request: structuredClone(request), response: structuredClone(response) });
      return response;
    };
    runtime = await options.createRuntime(config, logger, api);
    assert.equal(runtime.capabilities.cliEngine, input.engine);
    assert.equal(runtime.capabilities.cliVersion, input.cliVersion);
    const actualHost = runtime.processHost;
    const start = actualHost.start.bind(actualHost);
    actualHost.start = async (spec, signal) => {
      const isCli =
        win32.normalize(spec.executable).toLowerCase() ===
        win32.normalize(input.cliExecutablePath).toLowerCase();
      let launch: unknown;
      if (isCli) {
        for (const [name, value] of Object.entries(spec.environment)) {
          if (
            /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|AUTHORIZATION)/iu.test(name) &&
            value.length > 0
          )
            sensitiveValues.add(value);
        }
        const index = spec.arguments.indexOf("--output-schema");
        let outputSchema: unknown = null;
        if (index >= 0) {
          const schemaPath = spec.arguments[index + 1];
          assert.ok(schemaPath);
          const relative = win32.relative(input.workerDirectory, schemaPath);
          assert.ok(relative && !relative.startsWith("..") && !win32.isAbsolute(relative));
          outputSchema = JSON.parse(await readFile(schemaPath, "utf8"));
        }
        launch = {
          arguments: [...spec.arguments],
          workingDirectory: spec.workingDirectory,
          standardInputSha256: createHash("sha256")
            .update(spec.standardInput ?? "")
            .digest("hex"),
          outputSchema,
          limits: spec.limits,
          runAttemptId: tasks.at(-1)?.runAttemptId,
        };
      }
      const child = await start(spec, signal);
      const samePath = (path: string) =>
        win32.normalize(spec.executable).toLowerCase() === win32.normalize(path).toLowerCase();
      const observation: (typeof nativeProcesses)[number] = {
        requestId: child.requestId,
        processId: child.processId,
        executable: spec.executable,
        kind: samePath(input.cliExecutablePath)
          ? "cli"
          : samePath(input.gitExecutablePath)
            ? "git"
            : samePath(input.nodeExecutablePath) && spec.arguments.includes(input.probeScriptPath)
              ? "probe"
              : "other",
        argumentsSha256: createCanonicalResult(spec.arguments).sha256,
        startedAt: new Date().toISOString(),
      };
      nativeProcesses.push(observation);
      activeProcesses++;
      settledProcesses.push(
        child.completed
          .then(
            (completion) => {
              observation.completedAt = new Date().toISOString();
              observation.completion = completion;
            },
            (error: unknown) => {
              observation.failure = scrub(error);
              fatal = error;
            },
          )
          .finally(() => {
            activeProcesses--;
          }),
      );
      if (isCli) {
        const stdout = captureCliDiagnostic(child.stdout, [...sensitiveValues]);
        const stderr = captureCliDiagnostic(child.stderr, [...sensitiveValues]);
        const diagnostics = Promise.all([stdout.completed, stderr.completed]).then(
          async ([stdout, stderr]) => {
            await writeFile(
              join(resultsDirectory, `cli-${child.processId}-diagnostics.json`),
              JSON.stringify(
                scrub({
                  schemaVersion: "IssueSummaryCliDiagnosticV1",
                  requestId: child.requestId,
                  processId: child.processId,
                  launch,
                  stdout,
                  stderr,
                }),
                null,
                2,
              ),
              { flag: "wx" },
            );
          },
        );
        settledProcesses.push(
          diagnostics.catch((error: unknown) => {
            fatal = error;
          }),
        );
        return {
          requestId: child.requestId,
          processId: child.processId,
          completed: child.completed,
          ...(child.processCreationTimeFileTime === undefined
            ? {}
            : { processCreationTimeFileTime: child.processCreationTimeFileTime }),
          ...(child.stdin === undefined ? {} : { stdin: child.stdin }),
          stdout: stdout.stream,
          stderr: stderr.stream,
          terminate: (reason) => child.terminate(reason),
        };
      }
      return child;
    };
    const close = actualHost.close.bind(actualHost);
    actualHost.close = async () => {
      await close();
      hostClosed = true;
    };
    const actualExecutor = runtime.executor;
    const executor: JobExecutor = {
      execute: async (envelope, context) => {
        assert.equal(envelope.envelopeVersion, 2);
        const frozen = envelope as JobExecutionEnvelopeV2;
        sensitiveValues.add(frozen.lease.leaseToken);
        assert.equal(frozen.repository.fullName, repositoryFullName);
        assert.equal(frozen.resource.kind, "issue");
        assert.equal(frozen.validation.workflowKind, "issue_validation");
        assert.equal(frozen.validation.target, "headless");
        assert.equal(frozen.validation.reproduction?.binding.testedSourceCommit, fixedRevision);
        assert.equal(frozen.lease.workerInstanceId, instanceId);
        assert.ok(tasks.length < 3 && !tasks.some((task) => task.jobId === frozen.job.jobId));
        const purpose =
          frozen.validation.schemaVersion === "ValidationJobContextV2"
            ? frozen.validation.purpose
            : undefined;
        const task: TaskObservation = {
          jobId: frozen.job.jobId,
          runAttemptId: frozen.lease.runAttemptId,
          workerInstanceId: frozen.lease.workerInstanceId,
          runId: frozen.validation.runId,
          purpose: purpose ? "evaluation" : "ordinary",
          evaluationId: purpose?.evaluationId ?? null,
          arm: purpose?.arm ?? null,
          startedAt: new Date().toISOString(),
        };
        tasks.push(task);
        emit("task_started", task);
        await writeFile(
          join(resultsDirectory, `${task.runAttemptId}-envelope.json`),
          JSON.stringify(frozen, null, 2),
          { flag: "wx" },
        );
        const result = await actualExecutor.execute(frozen, {
          ...context,
          reportProgress: (progress) => {
            context.reportProgress(progress);
            emit("task_progress", { attemptId: task.runAttemptId, ...progress });
          },
          ...(context.deferCleanup === undefined
            ? {}
            : {
                deferCleanup: (cleanup: () => Promise<void>) =>
                  context.deferCleanup?.(async () => {
                    await cleanup();
                    cleanupCallbacks.push({
                      attemptId: task.runAttemptId,
                      completedAt: new Date().toISOString(),
                    });
                  }),
              }),
        });
        task.finishedAt = new Date().toISOString();
        task.outcome = result.outcome;
        await writeFile(
          join(resultsDirectory, `${task.runAttemptId}-result.json`),
          JSON.stringify(result, null, 2),
          { flag: "wx" },
        );
        try {
          assert.equal(result.outcome, "succeeded");
          assert.ok(result.outcome === "succeeded");
          assert.equal(createCanonicalResult(result.result).sha256, result.resultDigest);
          task.resultDigest = result.resultDigest;
          task.measurement = assertMeasurement(result.result, frozen);
          if (purpose) {
            assert.equal(task.measurement.cliExecution?.cli.kind, input.engine);
            assert.equal(task.measurement.cliExecution?.cli.version, input.cliVersion);
          }
        } catch (error) {
          fatal = error;
        }
        emit("task_finished", task);
        return result;
      },
    };
    service = new WorkerService(
      { ...config, capabilities: runtime.capabilities },
      api,
      executor,
      actualHost,
      logger,
      runtime.canAcceptWork,
    );
    serviceRun = service.run();
    let serviceFinished = false;
    void serviceRun.then(
      () => {
        serviceFinished = true;
      },
      (error: unknown) => {
        serviceFinished = true;
        fatal = error;
      },
    );
    while (!serviceFinished) {
      if (fatal !== undefined) throw fatal;
      const response = await fetch(new URL("/__acceptance/status", url), {
        headers: { authorization: `Bearer ${input.controlToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.ok, true);
      serverStatus = (await response.json()) as typeof serverStatus;
      if (serverStatus?.phase === "complete" || serverStatus?.phase === "failed") break;
      await delay(500);
    }
    assert.equal(serverStatus?.phase, "complete");
    assert.equal(serverStatus.passed, true);
    await bounded(service.stop("acceptance_complete"), "Worker drain", 60_000);
    await bounded(serviceRun, "Worker execution settlement", 10_000);
    if (fatal !== undefined) throw fatal;
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0]?.runId, ready.ordinaryRunId);
    assert.equal(tasks[0]?.purpose, "ordinary");
    assert.deepEqual(
      tasks
        .slice(1)
        .map((task) => task.arm)
        .sort(),
      ["baseline", "candidate"],
    );
    assert.equal(new Set(tasks.slice(1).map((task) => task.evaluationId)).size, 1);
    assert.equal(new Set(tasks.map((task) => task.workerInstanceId)).size, 1);
    assert.ok(tasks.every((task) => task.outcome === "succeeded" && task.measurement));
    assert.equal(terminalAcknowledgements.length, 3);
    assert.ok(frozenInputs.length >= 2);
    assert.equal(
      new Set(
        frozenInputs.map((entry) => (entry as { request: { inputId: string } }).request.inputId),
      ).size,
      2,
    );
    assert.equal(nativeProcesses.filter((entry) => entry.kind === "cli").length, 3);
    assert.equal(nativeProcesses.filter((entry) => entry.kind === "probe").length, 3);
    assert.ok(nativeProcesses.some((entry) => entry.kind === "git"));
  } catch (error) {
    failure = scrub(error);
  } finally {
    try {
      if (service) await bounded(service.stop("acceptance_finally"), "Worker final drain", 60_000);
      else if (runtime)
        await bounded(runtime.processHost.close(), "Host startup-failure closure", 20_000);
      if (serviceRun) await bounded(serviceRun, "Worker final settlement", 10_000);
      await bounded(Promise.all(settledProcesses), "Managed process settlement", 10_000);
      if (runtime) {
        workspaceEntries = await readdir(join(input.workerDirectory, "Workspaces"));
        assert.deepEqual(workspaceEntries, []);
        assert.equal(activeProcesses, 0);
        assert.equal(hostClosed, true);
        assert.ok(cleanupCallbacks.length >= tasks.length);
      }
    } catch (error) {
      failure ??= scrub(error);
      if (runtime && !hostClosed) {
        try {
          await bounded(
            runtime.processHost.terminateAll("worker_shutdown"),
            "Last owned-process termination",
            10_000,
          );
        } catch (terminationError) {
          emit("cleanup_failed", terminationError);
        }
        try {
          await bounded(runtime.processHost.close(), "Last Host closure", 20_000);
        } catch (closeError) {
          emit("cleanup_failed", closeError);
        }
      }
    }
    if (fatal !== undefined) failure ??= scrub(fatal);
    clearTimeout(timer);
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const)
      process.removeListener(signal, shutdown);
    for (const name of Object.keys(process.env))
      if (environmentKeys.test(name)) delete process.env[name];
    for (const [name, value] of retainedEnvironment) process.env[name] = value;
  }
  const receipt = scrub({
    schemaVersion: "IssueSummaryWorkerReceiptV1",
    status: failure === null ? "passed" : "failed",
    engine: input.engine,
    nonce: input.nonce,
    startedAt,
    finishedAt: new Date().toISOString(),
    failure,
    tasks,
    nativeProcesses,
    activeProcesses,
    terminalAcknowledgements,
    frozenInputs,
    cleanupCallbacks,
    workspaceEntries,
    hostClosed,
    serverStatus,
    events,
  }) as { status: "passed" | "failed" } & Record<string, unknown>;
  await writeFile(
    join(input.workerDirectory, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  return receipt;
}
