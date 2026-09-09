import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCanonicalResult,
  type PrReviewPlanV2,
  type ValidationJobResultV2,
} from "@agentic-review/codex";
import type * as C from "@agentic-review/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobWorkspaceProvider } from "../../../worker/src/execution/job-workspace.js";
import {
  type PreparedCliOutputInput,
  type PreparedCliOutputResult,
  PreparedCliOutputRunner,
} from "../../../worker/src/execution/prepared-cli-output-runner.js";
import type {
  ProcessExitedEvent,
  ProcessHostClient,
} from "../../../worker/src/execution/process-host-protocol.js";
import { ProfileJobExecutor } from "../../../worker/src/execution/profile-job-executor.js";
import { ReviewJobExecutor } from "../../../worker/src/execution/review-executor.js";
import { HttpWorkerApi } from "../../../worker/src/server-client/http-worker-api.js";
import { WorkerService } from "../../../worker/src/worker-service.js";
import { present } from "../database/evidence-control-plane.testing.js";
import {
  createEvaluationWorkerDatabase,
  createWorkerEvaluation,
  createWorkerHttpRuntime,
  hash,
  logger,
  syntheticCliConfiguration,
} from "./evaluation-worker.testing.js";

// This suite exercises the actual service, HTTP authentication, database owner, result projection
// and scoring. Windows checkout/build and CLI processes are explicit synthetic boundaries. The
// owned child uses only stdin/stdout and does not contact a model service or repository host.
const syntheticClient = `
let text = "";
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
if (input.failed) {
  process.stderr.write("Synthetic CLI failure.");
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(input.result));
}
`;

function modelResult(prompt: string): Omit<PrReviewPlanV2, "executionEvidence"> {
  return {
    schemaVersion: "PrReviewPlanV2",
    summary: `Synthetic review for prompt ${hash(prompt)}.`,
    assessment: "approve",
    findings: [],
    requestedRecipeIds: [],
    verification: { status: "not_run", summary: "Runner owns the build checks.", commands: [] },
  };
}

async function consume(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 128 * 1024) throw new Error("Synthetic child output exceeded its limit.");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function until(check: () => Promise<boolean>, detail: () => unknown): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`The Worker did not settle its two tasks: ${JSON.stringify(detail())}`);
}

interface OwnedRuntime {
  passed: boolean;
  readonly root: string;
  database?: Awaited<ReturnType<typeof createEvaluationWorkerDatabase>>;
  http?: Awaited<ReturnType<typeof createWorkerHttpRuntime>>;
  service?: WorkerService;
  run?: Promise<void>;
  readonly children: Set<ChildProcessWithoutNullStreams>;
}
const owned: OwnedRuntime[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const item of owned.splice(0)) {
    const cleanupFailures: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    const stopping = item.service?.stop("synthetic_evaluation_complete");
    const childClosures = [...item.children].map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.off("close", close);
            reject(new Error("The owned synthetic child did not confirm closure."));
          }, 5_000);
          function close() {
            clearTimeout(timer);
            resolve();
          }
          child.once("close", close);
          child.kill("SIGKILL");
        }),
    );
    const settledChildren = Promise.allSettled(childClosures);
    await attempt(async () => stopping);
    await attempt(async () => item.run);
    for (const result of await settledChildren)
      if (result.status === "rejected") cleanupFailures.push(result.reason);
    item.http?.shutdown.abort();
    await attempt(async () => item.http?.app.close());
    await attempt(async () => item.database?.closeOwner());
    if (item.passed && cleanupFailures.length === 0) {
      await attempt(async () => item.database?.dispose());
      if (cleanupFailures.length === 0)
        await attempt(() => rm(item.root, { recursive: true, force: true }));
    } else {
      await attempt(() =>
        writeFile(
          join(item.root, "retained-fixture.json"),
          JSON.stringify(
            {
              reason: "The integration test or cleanup failed; retain the owned synthetic files.",
              evidenceDirectory: item.database?.evidenceDirectory ?? null,
              cleanupFailureCount: cleanupFailures.length,
            },
            null,
            2,
          ),
        ),
      );
    }
    failures.push(...cleanupFailures);
  }
  vi.restoreAllMocks();
  if (failures.length > 0) throw new AggregateError(failures, "Evaluation Worker cleanup failed.");
});

describe.skipIf(process.platform !== "linux")(
  "Evaluation through a consecutive-task Worker",
  () => {
    it.each([
      { engine: "codex", failFirstCall: false },
      { engine: "codex", failFirstCall: true },
      { engine: "copilot", failFirstCall: false },
      { engine: "copilot", failFirstCall: true },
    ] as const)(
      "persists both frozen arms with $engine and first-call failure=$failFirstCall",
      async ({ engine, failFirstCall }) => {
        const root = await mkdtemp(join(tmpdir(), "evaluation-worker-runtime-"));
        const runtime: OwnedRuntime = {
          root,
          passed: false,
          children: new Set(),
        };
        owned.push(runtime);
        const database = await createEvaluationWorkerDatabase();
        runtime.database = database;
        const evaluation = await createWorkerEvaluation(database);
        const cli: C.CliModelConfiguration = { ...syntheticCliConfiguration, kind: engine };
        runtime.http = await createWorkerHttpRuntime(database, cli);
        const http = runtime.http;
        const api = new HttpWorkerApi(http.workerConfig, logger);
        const envelopes: C.JobExecutionEnvelopeV2[] = [];
        const prepared = new Map<
          string,
          { physical: string; envelope: C.JobExecutionEnvelopeV2 }
        >();
        const active = new Set<string>();
        const cleanups: { attemptId: string; purpose: string }[] = [];
        const modelCalls: { attemptId: string; prompt: string; failed: boolean }[] = [];
        const healthFaults: unknown[] = [];
        const processHost: ProcessHostClient = {
          start: async () => {
            throw new Error("The synthetic test does not start Windows commands.");
          },
          terminateAll: async () => undefined,
          close: async () => undefined,
        };
        const workspaces: JobWorkspaceProvider = {
          prepare: async (input, context, purpose = "model") => {
            context.signal.throwIfAborted();
            if (input.envelopeVersion !== 2) throw new Error("An Evaluation envelope is required.");
            const envelope = structuredClone(input);
            const attemptId = envelope.lease.runAttemptId;
            if (purpose === "validation") {
              expect(active.size).toBe(0);
              expect(await readdir(root)).toEqual([]);
              envelopes.push(envelope);
            }
            const logical = `C:\\SyntheticWorker\\${attemptId}-${purpose}`;
            const physical = join(root, `${attemptId}-${purpose}`);
            await mkdir(physical, { mode: 0o700 });
            expect(await readdir(physical)).toEqual([]);
            await writeFile(
              join(physical, "frozen-task.json"),
              JSON.stringify({
                attemptId,
                purpose,
                promptSha256: envelope.prompt.promptSha256,
                profileSha256: envelope.validation.profileVersion.configSha256,
              }),
            );
            prepared.set(logical, { physical, envelope });
            active.add(logical);
            return {
              attemptDirectory: logical,
              checkoutDirectory: `${logical}\\checkout`,
              controlDirectory: `${logical}\\control`,
              codexHomeDirectory: `${logical}\\codex`,
              tempDirectory: `${logical}\\temp`,
              userProfileDirectory: `${logical}\\user`,
              captureWorktreeState: async () => "clean",
              startDiskMonitoring: async (signal) => ({
                signal,
                violation: undefined,
                close: async () => undefined,
              }),
              cleanup: async () => {
                // Deferred cleanup must run after the real completion transaction is committed.
                expect(
                  database.read((reader) =>
                    reader.prepare("SELECT status FROM run_attempts WHERE id = ?").get(attemptId),
                  ),
                ).toEqual({ status: "succeeded" });
                expect(
                  database.read((reader) =>
                    reader
                      .prepare(
                        "SELECT COUNT(*) AS count FROM validation_job_results WHERE run_attempt_id = ?",
                      )
                      .get(attemptId),
                  ),
                ).toEqual({ count: 1 });
                expect(active.delete(logical)).toBe(true);
                await rm(physical, { recursive: true });
                cleanups.push({ attemptId, purpose });
              },
            };
          },
        };

        async function runSynthetic<T extends TSchema>(
          input: PreparedCliOutputInput<T>,
        ): Promise<PreparedCliOutputResult<Static<T>>> {
          input.context.signal.throwIfAborted();
          const workspace = present(prepared.get(input.workspace.attemptDirectory));
          const attemptId = workspace.envelope.lease.runAttemptId;
          const requestId = `synthetic-${attemptId}`;
          expect(input.prompt).toBe(workspace.envelope.prompt.renderedPrompt);
          expect(hash(input.prompt)).toBe(workspace.envelope.prompt.promptSha256);
          expect(
            JSON.parse(await readFile(join(workspace.physical, "frozen-task.json"), "utf8")),
          ).toMatchObject({ attemptId, purpose: "model" });
          const failed = failFirstCall && modelCalls.length === 0;
          modelCalls.push({ attemptId, prompt: input.prompt, failed });
          const startedAt = new Date().toISOString();
          const child = spawn(process.execPath, ["--input-type=module", "-e", syntheticClient], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {},
            cwd: workspace.physical,
          });
          runtime.children.add(child);
          const terminate = () => {
            child.kill("SIGKILL");
          };
          input.context.signal.addEventListener("abort", terminate, { once: true });
          const completed = new Promise<ProcessExitedEvent>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (exitCode, signal) => {
              input.context.signal.removeEventListener("abort", terminate);
              runtime.children.delete(child);
              resolve({
                protocolVersion: "1.0",
                type: "exited",
                requestId,
                exitCode,
                signal,
                outputTruncated: false,
              });
            });
          });
          const output = Promise.all([consume(child.stdout), consume(child.stderr)]);
          child.stdin.end(
            JSON.stringify({
              failed,
              result: modelResult(input.prompt),
            }),
          );
          const [exit, [stdout, stderr]] = await Promise.all([completed, output]);
          expect(exit.exitCode).toBe(failed ? 1 : 0);
          const completedAt = new Date().toISOString();
          if (failed) {
            expect(stdout).toBe("");
            expect(stderr).toBe("Synthetic CLI failure.");
            return {
              outcome: "failed",
              code: "SYNTHETIC_CLI_FAILED",
              message: "The synthetic CLI failed once.",
              retryable: false,
            };
          }
          expect(stderr).toBe("");
          const result: unknown = JSON.parse(stdout);
          if (!Value.Check(input.authoritativeSchema.resultSchema, result))
            throw new Error("The synthetic CLI output did not satisfy the actual schema.");
          const canonical = createCanonicalResult(result);
          return {
            outcome: "succeeded",
            result: result as Static<T>,
            resultDigest: canonical.sha256,
            canonicalResultJson: canonical.json,
            commandEvidence: { commands: [], commandCapture: "complete" },
            observedFileChange: false,
            cliExecution: {
              engine,
              cliVersion: cli.version,
              requestedModel: cli.requestedModel,
              processRequestId: requestId,
              startedAt,
              completedAt,
              promptSha256: hash(input.prompt),
              actualPromptSha256: hash(input.prompt),
              outputSchemaSha256: input.authoritativeSchema.digest,
              modelOutputSha256: canonical.sha256,
            },
          };
        }
        vi.spyOn(PreparedCliOutputRunner.prototype, "run").mockImplementation(runSynthetic);
        const executor = new ProfileJobExecutor({
          legacyExecutor: {
            execute: async () => {
              throw new Error("No legacy Evaluation path.");
            },
          },
          workspaceProvider: workspaces,
          createHeadlessRunner: (envelope) => ({
            run: async ({ profile }) => {
              const step = present(profile.config.build[0]);
              const checkId = `${profile.id}:${step.id}`;
              expect(profile).toEqual(envelope.validation.profileVersion);
              return {
                report: {
                  schemaVersion: "ValidationReportV1",
                  workItemKind: "pull_request",
                  source: "worker",
                  sourceState: "original",
                  summary: "Synthetic build passed.",
                  checks: [
                    {
                      id: checkId,
                      name: step.name,
                      kind: "build",
                      required: true,
                      source: "runner",
                      outcome: "passed",
                      summary: "Synthetic build passed.",
                      expected: "Exit code 0",
                      actual: "Exit code 0",
                      evidenceIds: [],
                    },
                  ],
                },
                blockers: [],
                cleanupState: "not_needed",
                diagnostics: [
                  {
                    stepId: checkId,
                    phase: "build",
                    outcome: "passed",
                    exitCode: 0,
                    summary: "Synthetic build passed.",
                  },
                ],
              };
            },
          }),
          createModelExecutor: (workspaceProvider) =>
            new ReviewJobExecutor({
              workspaceProvider,
              engine,
              cliExecutablePath: `C:\\Synthetic\\${engine}.exe`,
              cliVersion: cli.version,
              userProfileDirectory: "C:\\Synthetic\\user",
              systemRoot: "C:\\Windows",
              comSpec: "C:\\Windows\\System32\\cmd.exe",
              path: "C:\\Windows\\System32",
              pathExt: ".COM;.EXE;.BAT;.CMD",
              maximumHardTimeoutMs: 120_000,
              maximumProcessCount: 16,
              maximumMemoryBytes: 1024 * 1024 * 1024,
              maximumOutputBytes: 1024 * 1024,
            }),
        });
        const service = new WorkerService(http.workerConfig, api, executor, processHost, {
          ...logger,
          warn: (message, fields) => {
            healthFaults.push({ message, fields });
          },
          error: (message, fields) => {
            healthFaults.push({ message, fields });
          },
        });
        runtime.service = service;
        runtime.run = service.run();
        // Attach a rejection handler immediately so a fatal service failure is retained rather than
        // becoming an unhandled rejection while the completion poll is outstanding.
        let runError: unknown;
        void runtime.run.catch((error: unknown) => {
          runError = error;
        });
        await until(
          async () => {
            if (runError !== undefined) throw runError;
            return cleanups.length === 4;
          },
          () => ({ modelCalls, healthFaults, requests: http.requests }),
        );
        await service.stop("two_synthetic_evaluation_tasks_completed");
        await runtime.run;
        expect(healthFaults).toEqual([]);
        expect(active.size).toBe(0);
        expect(await readdir(root)).toEqual([]);
        expect(runtime.children.size).toBe(0);
        expect(envelopes).toHaveLength(2);
        expect(modelCalls).toHaveLength(2);
        expect(new Set(envelopes.map((value) => value.lease.workerInstanceId)).size).toBe(1);
        expect(new Set(envelopes.map((value) => value.lease.runAttemptId)).size).toBe(2);
        expect(new Set(envelopes.map((value) => value.prompt.promptSha256)).size).toBe(2);
        expect(
          new Set(envelopes.map((value) => value.validation.profileVersion.configSha256)).size,
        ).toBe(2);
        expect(modelCalls.map((call) => call.failed)).toEqual([failFirstCall, false]);

        const matrix = await evaluation.operator.request(
          "getEvaluationBatchMatrix",
          evaluation.query,
        );
        const preview = await evaluation.operator.request(
          "getEvaluationScorePreview",
          evaluation.query,
        );
        for (const arm of ["baseline", "candidate"] as const) {
          const cell = present(matrix.cases[0])[arm];
          const envelope = present(
            envelopes.find(
              (value) =>
                value.validation.schemaVersion === "ValidationJobContextV2" &&
                value.validation.purpose.cellId === cell.cellId,
            ),
          );
          const call = present(
            modelCalls.find((value) => value.attemptId === envelope.lease.runAttemptId),
          );
          expect(envelope.validation.profileVersion.id).toBe(evaluation[arm].profile.id);
          expect(call.prompt).toBe(envelope.prompt.renderedPrompt);
          const result = await evaluation.operator.request("getEvaluationCellResult", {
            ...evaluation.query,
            cellId: cell.cellId,
            resultId: present(cell.result).resultId,
          });
          expect(result.report.checks[0]).toMatchObject({
            id: `${evaluation[arm].profile.id}:compile-${arm}`,
            outcome: "passed",
          });
          expect(result.modelReview.state).toBe(call.failed ? "failed" : "completed");
          expect(preview.summary[arm].coverage.availableModels).toBe(call.failed ? 0 : 1);
          const stored = database.read((reader) =>
            reader
              .prepare("SELECT result_json FROM validation_job_results WHERE run_attempt_id = ?")
              .get(envelope.lease.runAttemptId),
          ) as { result_json: string };
          const persisted = JSON.parse(stored.result_json) as ValidationJobResultV2;
          expect(persisted.schemaVersion).toBe("ValidationJobResultV2");
          if (call.failed) {
            expect(persisted.modelReview).toMatchObject({
              state: "failed",
              code: "SYNTHETIC_CLI_FAILED",
            });
            expect(persisted.execution.blockers).toContainEqual(
              expect.objectContaining({
                phase: "model_review",
                code: "MODEL_REVIEW_REQUIRED",
              }),
            );
          } else {
            const raw = modelResult(envelope.prompt.renderedPrompt);
            expect(persisted.modelReview).toMatchObject({
              state: "completed",
              result: raw,
              execution: {
                schemaVersion: "CliModelExecutionV1",
                jobId: envelope.job.jobId,
                runAttemptId: envelope.lease.runAttemptId,
                cli,
                promptSha256: envelope.prompt.promptSha256,
                outputSchemaSha256: envelope.prompt.outputSchemaSha256,
                outputSha256: createCanonicalResult(raw).sha256,
                exitCode: 0,
              },
            });
          }
        }
        const assessment = await evaluation.operator.request("publishEvaluationAssessment", {
          ...evaluation.query,
          request: {
            changeId: "worker-e2e-assessment",
            expectedVersion: 0,
            expectedInputDigest: preview.inputDigest,
          },
        });
        expect(
          await evaluation.operator.request("getEvaluationAssessment", {
            ...evaluation.query,
            assessmentId: assessment.assessmentId,
          }),
        ).toEqual(assessment);
        expect(http.requests.filter((entry) => entry.path.endsWith("/complete"))).toHaveLength(2);
        expect(http.requests.every((entry) => entry.status < 400)).toBe(true);
        runtime.passed = true;
      },
      40_000,
    );
  },
);
