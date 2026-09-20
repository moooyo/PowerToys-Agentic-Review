import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  InvestigationArtifactV1,
  InvestigationAttemptV1,
  InvestigationEvidenceV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import {
  ManagedProcessRunError,
  ProductionManagedProcessRunner,
} from "../execution/managed-process-runner.js";
import {
  type ManagedProcess,
  type ProcessExitedEvent,
  type ProcessHostClient,
  type ProcessLaunchSpec,
  type ProcessResourceLimits,
} from "../execution/process-host-protocol.js";
import {
  E2eBuildError,
  type E2eBuildRecord,
  type E2eBuildRequest,
  type E2eMsbuildToolchain,
  getE2eBuildCapturedOutput,
  performE2eBuild,
  validateE2eBuildArtifact,
  validateE2eBuildFile,
} from "./e2e-build.js";
import {
  buildE2eDesktopLaunch,
  buildE2eVideoLaunch,
  type E2eTargetWindow,
  getE2eTargetWindow,
  parseE2eDesktopRequest,
  parseE2eDesktopResult,
} from "./e2e-desktop-driver.js";
import { type E2eFeaturePlan, parseE2eFeaturePlan } from "./e2e-feature-plan.js";
import type { ModelActivityObservation } from "./model-progress.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

export interface E2eToolReceipt {
  readonly id: string;
  readonly operation: string;
  readonly status: "passed" | "failed" | "blocked";
  readonly assertion: boolean;
  readonly summary: string;
  readonly observed: unknown;
  readonly artifactRefs: readonly string[];
  readonly featureId?: string;
  readonly assertionId?: string;
  readonly processRef?: string;
  readonly buildRef?: string;
  readonly interactionVersion?: number;
  readonly relatedAssertionIds?: readonly string[];
  readonly targetPid?: number;
  readonly windowHandle?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface E2eToolServerOptions {
  readonly task: InvestigationTaskV1;
  readonly attempt: InvestigationAttemptV1;
  readonly workspace: PreparedInvestigationWorkspace;
  readonly processHost: ProcessHostClient;
  readonly signal: AbortSignal;
  readonly environment: Readonly<Record<string, string>>;
  readonly processLimits: ProcessResourceLimits;
  readonly powershellExecutablePath: string;
  readonly gitExecutablePath: string;
  readonly ffmpegExecutablePath?: string;
  readonly desktopDriverPath?: string;
  readonly changedPaths: readonly string[];
  readonly buildTools?: Readonly<Partial<Record<"msbuild" | "dotnet", string>>>;
  readonly buildToolDigests?: Readonly<Partial<Record<"msbuild" | "dotnet", string>>>;
  readonly msbuildToolchain?: E2eMsbuildToolchain;
  readonly onActivity?: (activity: ModelActivityObservation) => void;
  readonly onRuntimeObservation?: (observation: {
    readonly evidence: readonly InvestigationEvidenceV1[];
    readonly artifacts: readonly InvestigationArtifactV1[];
  }) => Promise<void>;
}

interface OwnedProcess {
  readonly managed: ManagedProcess;
  readonly drained: Promise<unknown>;
  readonly kind: "application" | "video";
  readonly artifactPath?: string;
  buildRef?: string;
  outputPath?: string;
  recording?: {
    featureId: string;
    appRef: string;
    startedAt: string;
    interactionVersion: number;
    sessionId: number;
    windowHandle: string;
    targetPid: number;
    bounds: { x: number; y: number; width: number; height: number };
  };
  exit?: ProcessExitedEvent;
  completionSucceeded?: boolean;
  startedAt: string;
  exitedAt?: string;
  firstFrame?: Promise<void>;
  interactionVersion: number;
  settled: boolean;
}

/** A per-attempt, loopback-only capability. Credentials and publication are never exposed here. */
export class E2eToolServer {
  readonly #token = randomBytes(32).toString("hex");
  readonly #receipts = new Map<string, E2eToolReceipt>();
  readonly #recordedAt = new Map<string, string>();
  readonly #descendants = new Map<
    number,
    { pid: number; creationTimeFileTime: string; parentPid: number }
  >();
  readonly #features = new Map<string, E2eFeaturePlan>();
  readonly #builds = new Map<string, E2eBuildRecord>();
  readonly #artifacts: InvestigationArtifactV1[] = [];
  readonly #processes = new Map<string, OwnedProcess>();
  readonly #runner = new ProductionManagedProcessRunner();
  readonly #buildRunner = new ProductionManagedProcessRunner({ retainFailureOutput: true });
  readonly #commandExits: Promise<void>[] = [];
  readonly #toolLifetime = new AbortController();
  readonly #directory: string;
  readonly #driverPath: string;
  #server: Server | undefined;
  #endpoint: string | undefined;
  #active = Promise.resolve();
  #closing = false;
  #cleanupUncertain = false;
  #observationFailure: Error | undefined;

  public constructor(private readonly options: E2eToolServerOptions) {
    this.#directory = win32.join(options.workspace.controlDirectory, `e2e-${randomUUID()}`);
    this.#driverPath =
      options.desktopDriverPath ??
      fileURLToPath(new URL("./e2e-desktop-driver.ps1", import.meta.url));
  }

  public get receipts(): readonly E2eToolReceipt[] {
    return [...this.#receipts.values()];
  }
  public get artifacts(): readonly InvestigationArtifactV1[] {
    return this.#artifacts;
  }
  public get features(): readonly E2eFeaturePlan[] {
    return [...this.#features.values()].map((feature) => structuredClone(feature));
  }
  public get builds(): readonly E2eBuildRecord[] {
    return [...this.#builds.values()];
  }
  public get executionSignal(): AbortSignal {
    return this.#toolLifetime.signal;
  }
  public assertObservationsPersisted(): void {
    if (this.#observationFailure !== undefined) throw this.#observationFailure;
  }
  public get evidence(): InvestigationEvidenceV1[] {
    return this.receipts.map((receipt) => ({
      id: receipt.id,
      subjectRef: this.options.task.subjectRef,
      source:
        receipt.operation === "screenshot" || receipt.operation === "video-stop"
          ? "visual_observation"
          : "executor_observation",
      authority: "worker",
      summary: receipt.summary,
      artifactRefs: [...receipt.artifactRefs],
      evidenceRefs: [],
      provenance: {
        taskId: this.options.task.id,
        attemptId: this.options.attempt.id,
        producer: "e2e-tool-server",
        recordedAt: this.#recordedAt.get(receipt.id)!,
      },
    }));
  }

  public async start(): Promise<{ endpoint: string; capability: string; directory: string }> {
    await mkdir(this.#directory, { recursive: false });
    this.#server = createServer((request, response) => {
      void (async () => {
        const supplied = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
        const actual = Buffer.from(supplied);
        const expected = Buffer.from(this.#token);
        if (
          request.method !== "POST" ||
          request.url !== "/tool" ||
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        ) {
          response.writeHead(403).end();
          return;
        }
        if (this.#closing || this.options.signal.aborted) {
          response.writeHead(409).end();
          return;
        }
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > 256 * 1024) throw new Error("The tool request is too large.");
          chunks.push(bytes);
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const next = this.#active.then(() => this.execute(input));
        this.#active = next.then(
          () => undefined,
          () => undefined,
        );
        const receipt = await next;
        response
          .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end(JSON.stringify(receipt));
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end(JSON.stringify({ error: "The E2E operation was rejected or unavailable." }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string")
      throw new Error("E2E loopback binding failed.");
    this.#endpoint = `http://127.0.0.1:${address.port}/tool`;
    return { endpoint: this.#endpoint, capability: this.#token, directory: this.#directory };
  }

  public async execute(value: unknown): Promise<E2eToolReceipt> {
    if (this.#closing) throw new Error("The E2E tool session is closing.");
    this.assertObservationsPersisted();
    this.options.signal.throwIfAborted();
    const input = record(value);
    const operation = string(input.operation, "operation");
    this.#activity(`e2e.${operation}.started`);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const binding: {
      featureId?: string;
      assertionId?: string;
      processRef?: string;
      buildRef?: string;
      interactionVersion?: number;
      relatedAssertionIds?: readonly string[];
      targetPid?: number;
      windowHandle?: string;
    } = {};
    let observed: unknown = null;
    let status: E2eToolReceipt["status"] = "passed";
    let assertion = false;
    const artifacts: InvestigationArtifactV1[] = [];
    try {
      if (operation === "register-feature") {
        const feature = parseE2eFeaturePlan(input.feature, this.options.changedPaths);
        const previous = this.#features.get(feature.id);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(feature))
          throw new Error(
            "An accepted feature plan cannot change its assertions after registration.",
          );
        this.#features.set(feature.id, feature);
        observed = feature;
        binding.featureId = feature.id;
      } else if (operation === "build") {
        const built = await performE2eBuild({
          id,
          request: input.request as E2eBuildRequest,
          workspace: this.options.workspace,
          buildRootDirectory: this.#directory,
          gitExecutablePath: this.options.gitExecutablePath,
          tools: this.options.buildTools ?? {},
          ...(this.options.buildToolDigests === undefined
            ? {}
            : { toolDigests: this.options.buildToolDigests }),
          ...(this.options.msbuildToolchain === undefined
            ? {}
            : { msbuildToolchain: this.options.msbuildToolchain }),
          environment: this.#environment(),
          limits: this.options.processLimits,
          signal: AbortSignal.any([this.options.signal, this.#toolLifetime.signal]),
          run: (spec, signal) => this.#run(spec, signal, true),
        });
        this.#builds.set(id, built);
        binding.buildRef = id;
        observed = built;
      } else if (operation === "command") {
        const script = string(input.script, "script", 128 * 1024);
        const spec = this.#powershellSpec(script, input.timeoutMs);
        let output: { exitCode: number; stdout: string; stderr: string };
        try {
          output = await this.#run(
            spec,
            AbortSignal.any([this.options.signal, this.#toolLifetime.signal]),
          );
        } catch (error) {
          if (!(error instanceof ManagedProcessRunError) || error.exitCode === null) throw error;
          output = { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        }
        observed = output;
        const expectedExit = input.expectedExitCode;
        const expectedOutput = input.expectedOutputContains;
        // Exploratory shell commands are never build provenance or feature acceptance.
        assertion = false;
        status =
          (expectedExit === undefined ? output.exitCode === 0 : output.exitCode === expectedExit) &&
          (expectedOutput === undefined ||
            output.stdout.includes(string(expectedOutput, "expectedOutputContains")))
            ? "passed"
            : "failed";
      } else if (operation === "launch") {
        if (
          [...this.#processes.values()].filter(
            (entry) => entry.kind === "application" && !entry.settled,
          ).length >= 3
        )
          throw new Error(
            "Stop an owned application before launching another; this E2E session supports three active application roots.",
          );
        const built = this.#build(input.buildRef);
        const output = await validateE2eBuildArtifact(
          built,
          string(input.outputPath, "outputPath"),
        );
        if (
          !Array.isArray(input.arguments) ||
          !input.arguments.every((arg) => typeof arg === "string")
        )
          throw new Error("Application arguments must be strings.");
        const owned = await this.#startProcess(
          {
            ...this.#builtLaunch(output.path, input.arguments),
            ...this.#baseSpec(),
            workingDirectory: win32.dirname(output.path),
            captureProcessIdentity: true,
          },
          "application",
        );
        owned.buildRef = built.id;
        owned.outputPath = output.path;
        this.#processes.set(id, owned);
        binding.buildRef = built.id;
        binding.processRef = id;
        observed = {
          processRef: id,
          buildRef: built.id,
          output,
          pid: owned.managed.processId,
          creationTimeFileTime: owned.managed.processCreationTimeFileTime,
        };
      } else if (operation === "run-check") {
        const feature = this.#feature(input.featureId);
        const specification = feature.assertions.find((entry) => entry.id === input.assertionId);
        if (feature.userVisible || specification?.kind !== "process")
          throw new Error("Only a registered non-visual process assertion may use run-check.");
        const built = this.#build(input.buildRef);
        const output = await validateE2eBuildArtifact(built, specification.outputPath);
        Object.assign(binding, {
          featureId: feature.id,
          assertionId: specification.id,
          buildRef: built.id,
        });
        assertion = true;
        let result: { exitCode: number; stdout: string; stderr: string };
        const launch =
          specification.host === "dotnet-vstest"
            ? this.#vstestLaunch(output.path, specification.arguments)
            : this.#builtLaunch(output.path, specification.arguments);
        try {
          result = await this.#run(
            { ...launch, ...this.#baseSpec(), workingDirectory: win32.dirname(output.path) },
            AbortSignal.any([this.options.signal, this.#toolLifetime.signal]),
          );
        } catch (error) {
          if (
            !(error instanceof ManagedProcessRunError) ||
            error.code !== "NON_ZERO_EXIT" ||
            error.exitCode === null
          )
            throw error;
          result = { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        }
        await validateE2eBuildArtifact(built, output.path);
        observed = { specification, output, result };
        status =
          result.exitCode === specification.expectedExitCode &&
          result.stdout.includes(specification.expectedOutputContains)
            ? "passed"
            : "failed";
      } else if (operation === "stop") {
        const owned = this.#owned(input.processRef, "application");
        await this.#stop(owned);
        observed = { stopped: true };
      } else if (operation === "video-start") {
        if (this.options.ffmpegExecutablePath === undefined)
          throw new Error("FFmpeg must be installed and configured to capture video.");
        if ([...this.#processes.values()].some((entry) => entry.kind === "video" && !entry.settled))
          throw new Error("A video capture is already active.");
        const feature = this.#feature(input.featureId);
        const appRef = string(input.processRef, "processRef");
        const app = this.#owned(appRef, "application");
        await this.#verifyApplication(app);
        const observedWindow = await this.#activeWindow(app, input.target);
        const artifactPath = win32.join(this.#directory, `${id}.mp4`);
        const owned = await this.#startProcess(
          buildE2eVideoLaunch({
            ffmpegExecutablePath: this.options.ffmpegExecutablePath,
            artifactPath,
            workingDirectory: this.options.workspace.sourceDirectory!,
            environment: this.#environment(),
            processLimits: this.options.processLimits,
            durationSeconds: integer(input.durationSeconds ?? 30, 1, 120),
            windowBounds: observedWindow.bounds,
          }),
          "video",
          artifactPath,
        );
        this.#processes.set(id, owned);
        try {
          await deadline(owned.firstFrame!, 10_000);
        } catch {
          await this.#stop(owned);
          throw new Error("The recorder did not confirm capturing its first frame.");
        }
        owned.buildRef = app.buildRef!;
        owned.recording = {
          featureId: feature.id,
          appRef,
          startedAt: new Date().toISOString(),
          interactionVersion: app.interactionVersion,
          ...observedWindow,
        };
        Object.assign(binding, {
          featureId: feature.id,
          processRef: appRef,
          buildRef: app.buildRef,
        });
        observed = { processRef: id, applicationRef: appRef, window: observedWindow };
      } else if (operation === "video-stop") {
        const owned = this.#owned(input.processRef, "video");
        const recording = owned.recording;
        if (recording === undefined)
          throw new Error("The recording lacks its registered feature and application binding.");
        const app = this.#owned(recording.appRef, "application");
        if (!owned.settled && owned.exitedAt === undefined && owned.managed.stdin !== undefined) {
          try {
            await owned.managed.stdin.write(Buffer.from("q\n"));
          } catch {
            /* A recorder that naturally exited at its duration limit is verified below. */
          }
        }
        await deadline(owned.drained, 15_000);
        requireSuccessfulE2eRecording(owned.completionSucceeded === true, owned.exit);
        await this.#verifyApplication(app);
        const end = await this.#activeWindow(app, {
          pid: recording.targetPid,
          windowHandle: recording.windowHandle,
        });
        if (
          end.sessionId !== recording.sessionId ||
          end.windowHandle !== recording.windowHandle ||
          JSON.stringify(end.bounds) !== JSON.stringify(recording.bounds) ||
          app.interactionVersion <= recording.interactionVersion
        )
          throw new Error(
            "The owned application, capture window, or interaction changed incompatibly during recording.",
          );
        const recordedUntil = owned.exitedAt;
        if (recordedUntil === undefined)
          throw new Error("The recorder did not provide a confirmed capture interval.");
        const related = selectE2eRecordingEvidence(this.receipts, {
          featureId: recording.featureId,
          processRef: recording.appRef,
          buildRef: app.buildRef!,
          startedAt: recording.startedAt,
          endedAt: recordedUntil,
          targetPid: recording.targetPid,
          windowHandle: recording.windowHandle,
        });
        if (related.length === 0)
          throw new Error(
            "The recording contains no matching successful registered assertion and application interaction.",
          );
        artifacts.push(await this.#capture(owned.artifactPath!, "video", "video/mp4"));
        Object.assign(binding, {
          featureId: recording.featureId,
          processRef: recording.appRef,
          buildRef: app.buildRef,
          interactionVersion: app.interactionVersion,
          relatedAssertionIds: related.map((receipt) => receipt.id),
          targetPid: recording.targetPid,
          windowHandle: recording.windowHandle,
        });
        observed = {
          processRef: input.processRef,
          path: owned.artifactPath,
          startedAt: recording.startedAt,
          endedAt: recordedUntil,
          window: end,
        };
      } else if (
        [
          "enumerate",
          "inspect",
          "click",
          "type",
          "keys",
          "assert",
          "screenshot",
          "desktop-status",
        ].includes(operation)
      ) {
        const owned =
          input.processRef === undefined ? undefined : this.#owned(input.processRef, "application");
        if (!["enumerate", "desktop-status"].includes(operation) && owned === undefined)
          throw new Error("Desktop operations require an owned application process.");
        const artifactPath =
          operation === "screenshot" ? win32.join(this.#directory, `${id}.png`) : undefined;
        const feature = ["click", "type", "keys", "assert", "screenshot"].includes(operation)
          ? this.#feature(input.featureId)
          : undefined;
        if (owned !== undefined) await this.#verifyApplication(owned);
        let target = record(input.target ?? {});
        const specification = feature?.assertions.find((entry) => entry.id === input.assertionId);
        if (operation === "assert") {
          if (specification?.kind !== "ui")
            throw new Error("UI acceptance requires a previously registered UI assertion ID.");
          target = { ...target, selector: specification.selector };
          Object.assign(binding, { assertionId: specification.id });
        }
        const targetPid = target.pid ?? owned?.managed.processId;
        if (
          targetPid !== undefined &&
          (owned === undefined || !this.#belongsToApplication(targetPid, owned))
        )
          throw new Error("The target PID is not registered to this application tree.");
        let related =
          operation === "screenshot"
            ? this.#successfulAssertions(
                feature!.id,
                string(input.processRef, "processRef"),
                owned!,
              )
            : [];
        if (operation === "screenshot" && related.length === 0)
          throw new Error(
            "A screenshot must capture the current successful state of a registered assertion for this feature and build.",
          );
        const request: Record<string, unknown> = {
          schemaVersion: "E2eDesktopRequestV1",
          requestId: id,
          action: operation,
          ownedProcesses: this.#identities(),
          ...(owned === undefined ? {} : { target: { ...target, pid: targetPid } }),
          ...(artifactPath === undefined ? {} : { artifactPath }),
          ...(operation === "assert"
            ? { assertion: specification!.kind === "ui" ? specification!.assertion : undefined }
            : {}),
          ...Object.fromEntries(
            ["maxDepth", "maxNodes", "coordinates", "text", "keys"]
              .filter((key) => input[key] !== undefined)
              .map((key) => [key, input[key]]),
          ),
        };
        const result = await this.#desktop(
          request,
          AbortSignal.any([this.options.signal, this.#toolLifetime.signal]),
        );
        const targetWindow = getE2eTargetWindow(result);
        if (owned !== undefined && targetWindow !== null) {
          await this.#verifyTargetWindow(owned, targetWindow);
          Object.assign(binding, {
            targetPid: targetWindow.pid,
            windowHandle: targetWindow.windowHandle,
          });
        }
        if (operation === "screenshot") {
          related = related.filter(
            (receipt) =>
              receipt.operation === "run-check" ||
              (targetWindow !== null &&
                receipt.targetPid === targetWindow.pid &&
                receipt.windowHandle === targetWindow.windowHandle),
          );
          if (related.length === 0)
            throw new Error(
              "The captured window does not match this feature's successful assertion window.",
            );
        }
        if ((operation === "enumerate" || operation === "inspect") && result.success) {
          const data = record(result.data);
          if (Array.isArray(data.ownedDescendants))
            for (const child of data.ownedDescendants) {
              const identity = record(child);
              if (
                typeof identity.pid !== "number" ||
                !Number.isSafeInteger(identity.pid) ||
                identity.pid < 1 ||
                typeof identity.creationTimeFileTime !== "string" ||
                !/^[1-9][0-9]{0,19}$/u.test(identity.creationTimeFileTime)
              )
                throw new Error("The desktop driver returned an invalid descendant identity.");
              if (typeof identity.parentPid !== "number")
                throw new Error("A descendant requires its observed parent identity.");
              this.#descendants.set(identity.pid, {
                pid: identity.pid,
                creationTimeFileTime: identity.creationTimeFileTime,
                parentPid: identity.parentPid,
              });
            }
        }
        observed = result;
        assertion = operation === "assert";
        status = result.success
          ? "passed"
          : assertion && result.code === "assertion_failed"
            ? "failed"
            : "blocked";
        if (operation === "desktop-status" && !result.interactive) status = "blocked";
        if (owned !== undefined && result.success && ["click", "type", "keys"].includes(operation))
          owned.interactionVersion++;
        if (feature !== undefined && owned !== undefined)
          Object.assign(binding, {
            featureId: feature.id,
            processRef: string(input.processRef, "processRef"),
            buildRef: owned.buildRef,
            interactionVersion: owned.interactionVersion,
            ...(operation === "screenshot"
              ? { relatedAssertionIds: related.map((receipt) => receipt.id) }
              : {}),
          });
        if (artifactPath !== undefined && result.success)
          artifacts.push(await this.#capture(artifactPath, "image", "image/png"));
      } else throw new Error("Unknown E2E tool operation.");
    } catch (error) {
      this.options.signal.throwIfAborted();
      status = "blocked";
      let buildDiagnostics = error instanceof E2eBuildError ? error.diagnostics : undefined;
      if (error instanceof E2eBuildError) {
        const output = getE2eBuildCapturedOutput(error);
        if (output !== null) {
          const captured = await this.options.workspace.writeArtifact({
            subjectRef: this.options.task.subjectRef,
            kind: "log",
            name: `e2e-build-output-${id}.json`,
            mediaType: "application/json",
            bytes: Buffer.from(
              JSON.stringify({
                schemaVersion: "E2eBuildCapturedOutputV1",
                invocation: buildDiagnostics?.invocation ?? null,
                exitCode: buildDiagnostics?.exitCode ?? null,
                ...output,
                retention: output.outputTruncated
                  ? "partial_or_truncated"
                  : "complete_within_capture_limit",
              })
                .split(this.#token)
                .join("[REDACTED]"),
              "utf8",
            ),
          });
          artifacts.push(captured);
          if (buildDiagnostics !== undefined)
            buildDiagnostics = {
              ...buildDiagnostics,
              capture: {
                artifactRef: captured.id,
                captureLimitBytes: output.captureLimitBytes,
                retainedBytes: output.retainedBytes,
                outputTruncated: output.outputTruncated,
              },
            };
        }
      }
      observed = {
        error: error instanceof Error ? error.message : "The E2E operation could not complete.",
        ...(error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
          ? { errorCode: error.code }
          : {}),
        ...(buildDiagnostics !== undefined ? { buildDiagnostics } : {}),
      };
    }
    observed = JSON.parse(JSON.stringify(observed).split(this.#token).join("[REDACTED]"));
    const log = await this.options.workspace.writeArtifact({
      subjectRef: this.options.task.subjectRef,
      kind: "log",
      name: `e2e-${operation}-${id}.json`,
      mediaType: "application/json",
      bytes: Buffer.from(
        JSON.stringify({
          taskId: this.options.task.id,
          attemptId: this.options.attempt.id,
          headSha: this.options.workspace.sourceBinding?.sourceSha,
          operation,
          status,
          ...binding,
          startedAt,
          finishedAt: new Date().toISOString(),
          observed,
        }),
      ),
    });
    artifacts.push(log);
    this.#artifacts.push(...artifacts);
    const receipt: E2eToolReceipt = {
      id,
      operation,
      status,
      assertion,
      ...binding,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: `${operation}: ${status}. ${JSON.stringify(observed).slice(0, 8_000)}`,
      observed,
      artifactRefs: artifacts.map((artifact) => artifact.id),
    };
    this.#receipts.set(id, receipt);
    this.#recordedAt.set(id, new Date().toISOString());
    this.#activity(`e2e.${operation}.completed`);
    try {
      await this.options.onRuntimeObservation?.({
        evidence: this.evidence.filter((entry) => entry.id === id),
        artifacts,
      });
    } catch {
      this.#observationFailure = new Error(
        "An E2E observation could not be saved durably; execution must stop.",
      );
      this.#toolLifetime.abort(this.#observationFailure);
      throw this.#observationFailure;
    }
    return receipt;
  }

  public async cleanup(): Promise<void> {
    this.#closing = true;
    this.#toolLifetime.abort(
      new Error("The E2E session finished and its active commands must stop."),
    );
    if (this.#server !== undefined) {
      this.#server.closeIdleConnections();
      this.#server.closeAllConnections();
      await deadline(new Promise<void>((resolve) => this.#server!.close(() => resolve())), 5_000);
    }
    await deadline(this.#active, 20_000);
    const stopped = await Promise.allSettled(
      [...this.#processes.values()].map((entry) => this.#stop(entry)),
    );
    if (stopped.some((result) => result.status === "rejected") || this.#cleanupUncertain)
      throw cleanupError();
    await deadline(Promise.all(this.#commandExits), 15_000);
    const result = await this.#desktop(
      {
        schemaVersion: "E2eDesktopRequestV1",
        requestId: randomUUID(),
        action: "desktop-status",
        ownedProcesses: this.#identities(),
      },
      new AbortController().signal,
    );
    await deadline(Promise.all(this.#commandExits), 15_000);
    if (
      !result.success ||
      !result.interactive ||
      result.ownedPidsPresent.length !== 0 ||
      result.ownedProcessStates.some((owner) => owner.state !== "exited")
    )
      throw cleanupError();
  }

  async #desktop(request: Record<string, unknown>, signal: AbortSignal) {
    const validatedRequest = parseE2eDesktopRequest(request);
    const id = randomUUID();
    const requestPath = win32.join(this.#directory, `${id}.request.json`);
    const resultPath = win32.join(this.#directory, `${id}.result.json`);
    await writeFile(requestPath, JSON.stringify(validatedRequest), { flag: "wx" });
    try {
      await this.#run(
        buildE2eDesktopLaunch({
          powershellExecutablePath: this.options.powershellExecutablePath,
          driverPath: this.#driverPath,
          requestPath,
          resultPath,
          workingDirectory: this.#directory,
          environment: this.#environment(),
          processLimits: { ...this.options.processLimits, hardTimeoutMs: 15_000 },
        }),
        signal,
      );
    } catch (error) {
      if (!(error instanceof ManagedProcessRunError) || error.exitCode === null) throw error;
    }
    return parseE2eDesktopResult(await readFile(resultPath, "utf8"), validatedRequest);
  }

  #owned(ref: unknown, kind: OwnedProcess["kind"]): OwnedProcess {
    const value = this.#processes.get(string(ref, "processRef"));
    if (value === undefined || value.kind !== kind)
      throw new Error("The process does not belong to this attempt.");
    return value;
  }
  #feature(ref: unknown): E2eFeaturePlan {
    const feature = this.#features.get(string(ref, "featureId"));
    if (feature === undefined)
      throw new Error("Register the feature and its assertion specifications before execution.");
    return feature;
  }
  #build(ref: unknown): E2eBuildRecord {
    const build = this.#builds.get(string(ref, "buildRef"));
    if (build === undefined)
      throw new Error("The build receipt was not produced by this Worker session.");
    return build;
  }
  #builtLaunch(
    path: string,
    args: readonly string[],
  ): Pick<ProcessLaunchSpec, "executable" | "arguments"> {
    if (win32.extname(path).toLowerCase() === ".dll") {
      const dotnet = this.options.buildTools?.dotnet;
      if (dotnet === undefined)
        throw new Error("A pinned dotnet host is required for the built managed application.");
      return { executable: dotnet, arguments: [path, ...args] };
    }
    return { executable: path, arguments: args };
  }
  #vstestLaunch(
    path: string,
    args: readonly string[],
  ): Pick<ProcessLaunchSpec, "executable" | "arguments"> {
    const dotnet = this.options.buildTools?.dotnet;
    if (dotnet === undefined || win32.extname(path).toLowerCase() !== ".dll")
      throw new Error("A built test assembly and pinned dotnet host are required for VSTest.");
    return { executable: dotnet, arguments: ["vstest", path, ...args] };
  }
  async #verifyApplication(app: OwnedProcess): Promise<void> {
    if (app.settled || app.buildRef === undefined || app.outputPath === undefined)
      throw new Error("The application no longer has a live verified build binding.");
    await validateE2eBuildArtifact(this.#build(app.buildRef), app.outputPath);
  }
  async #verifyTargetWindow(app: OwnedProcess, target: E2eTargetWindow): Promise<void> {
    if (!this.#belongsToApplication(target.pid, app))
      throw new Error("The observed window is outside the verified application tree.");
    if (
      target.pid === app.managed.processId &&
      app.outputPath !== undefined &&
      win32.extname(app.outputPath).toLowerCase() === ".dll" &&
      this.options.buildTools?.dotnet !== undefined &&
      win32.resolve(target.imagePath).toLowerCase() ===
        win32.resolve(this.options.buildTools.dotnet).toLowerCase()
    ) {
      await validateE2eBuildArtifact(this.#build(app.buildRef), app.outputPath);
      return;
    }
    await validateE2eBuildFile(this.#build(app.buildRef), target.imagePath);
  }
  #belongsToApplication(pid: unknown, app: OwnedProcess): boolean {
    if (typeof pid !== "number") return false;
    const seen = new Set<number>();
    let current = pid;
    while (!seen.has(current)) {
      if (current === app.managed.processId) return true;
      seen.add(current);
      const entry = this.#descendants.get(current);
      if (entry === undefined) return false;
      current = entry.parentPid;
    }
    return false;
  }
  #successfulAssertions(
    featureId: string,
    appRef: string,
    app: OwnedProcess,
    since?: string,
  ): E2eToolReceipt[] {
    return this.receipts.filter(
      (receipt) =>
        receipt.featureId === featureId &&
        receipt.buildRef === app.buildRef &&
        receipt.assertion &&
        receipt.status === "passed" &&
        (receipt.operation === "run-check" ||
          (receipt.processRef === appRef &&
            (since !== undefined || receipt.interactionVersion === app.interactionVersion))) &&
        (since === undefined ||
          (receipt.startedAt !== undefined && Date.parse(receipt.startedAt) >= Date.parse(since))),
    );
  }
  async #activeWindow(app: OwnedProcess, target: unknown) {
    const supplied = record(target ?? {});
    const pid = supplied.pid ?? app.managed.processId;
    if (!this.#belongsToApplication(pid, app))
      throw new Error("The capture window does not belong to the verified application tree.");
    const result = await this.#desktop(
      {
        schemaVersion: "E2eDesktopRequestV1",
        requestId: randomUUID(),
        action: "inspect",
        ownedProcesses: this.#identities(),
        target: { ...supplied, pid },
        maxDepth: 0,
        maxNodes: 1,
      },
      AbortSignal.any([this.options.signal, this.#toolLifetime.signal]),
    );
    const targetWindow = getE2eTargetWindow(result);
    if (targetWindow === null)
      throw new Error("The driver did not bind the actual capture window.");
    await this.#verifyTargetWindow(app, targetWindow);
    const window = record(result.data.window);
    const bounds = record(window.bounds);
    if (
      !result.success ||
      !result.interactive ||
      result.foreground?.windowHandle !== window.windowHandle ||
      result.foreground?.owned !== true ||
      window.visible !== true ||
      window.minimized !== false
    )
      throw new Error(
        "Capture requires the active visible owned application window in an unlocked session.",
      );
    return {
      sessionId: result.sessionId,
      windowHandle: string(window.windowHandle, "windowHandle"),
      targetPid: integer(window.pid, 1, 4_294_967_295),
      bounds: {
        x: integer(bounds.x, -65_536, 65_536),
        y: integer(bounds.y, -65_536, 65_536),
        width: integer(bounds.width, 1, 32_768),
        height: integer(bounds.height, 1, 32_768),
      },
    };
  }
  #identities() {
    return [
      ...new Map(
        [...this.#processes.values()]
          .filter((entry) => entry.kind === "application")
          .map(
            ({ managed }) =>
              [
                managed.processId,
                {
                  pid: managed.processId,
                  creationTimeFileTime: managed.processCreationTimeFileTime!,
                },
              ] as const,
          )
          .concat(
            [...this.#descendants].map(
              ([pid, identity]) =>
                [pid, { pid, creationTimeFileTime: identity.creationTimeFileTime }] as const,
            ),
          ),
      ).values(),
    ];
  }
  #environment() {
    return {
      ...this.options.environment,
      GIT_OPTIONAL_LOCKS: "0",
      TEMP: this.options.workspace.tempDirectory,
      TMP: this.options.workspace.tempDirectory,
    };
  }
  #baseSpec() {
    return {
      workingDirectory: this.options.workspace.sourceDirectory!,
      environmentMode: "replace" as const,
      environment: this.#environment(),
      limits: this.options.processLimits,
    };
  }
  #powershellSpec(script: string, timeoutMs: unknown): ProcessLaunchSpec {
    const wrapped = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n$OutputEncoding = [Console]::OutputEncoding\n$ErrorActionPreference = 'Stop'\n& {\n${script}\n}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
    return {
      executable: this.options.powershellExecutablePath,
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(wrapped, "utf16le").toString("base64"),
      ],
      ...this.#baseSpec(),
      limits: {
        ...this.options.processLimits,
        hardTimeoutMs: integer(
          timeoutMs ?? this.options.processLimits.hardTimeoutMs,
          1_000,
          this.options.processLimits.hardTimeoutMs,
        ),
      },
    };
  }
  async #run(spec: ProcessLaunchSpec, signal: AbortSignal, retainBuildOutput = false) {
    const host = this.options.processHost;
    const tracked: ProcessHostClient = {
      start: async (launch, cancellation, onDispatch) => {
        let managed: ManagedProcess;
        let dispatched = false;
        try {
          managed = await host.start(launch, cancellation, () => {
            dispatched = true;
            onDispatch?.();
          });
        } catch (error) {
          if (dispatched) {
            this.#cleanupUncertain = true;
            this.#toolLifetime.abort(cleanupError());
          }
          throw error;
        }
        const exited = (managed.exited ?? managed.completed).then(
          () => undefined,
          () => {
            this.#cleanupUncertain = true;
            throw cleanupError();
          },
        );
        void exited.catch(() => undefined);
        this.#commandExits.push(exited);
        return managed;
      },
      terminateAll: (reason) => host.terminateAll(reason),
      close: () => host.close(),
    };
    return (retainBuildOutput ? this.#buildRunner : this.#runner).run(spec, {
      processHost: tracked,
      signal,
      onProgress: () => this.#activity("e2e.process.output"),
    });
  }
  #activity(event: string): void {
    try {
      this.options.onActivity?.({ kind: "tool", event });
    } catch {
      /* Progress reporting cannot change execution or cleanup. */
    }
  }
  async #startProcess(
    spec: ProcessLaunchSpec,
    kind: OwnedProcess["kind"],
    artifactPath?: string,
  ): Promise<OwnedProcess> {
    let managed: ManagedProcess;
    let dispatched = false;
    try {
      managed = await this.options.processHost.start(spec, this.options.signal, () => {
        dispatched = true;
      });
    } catch (error) {
      if (dispatched) {
        this.#cleanupUncertain = true;
        this.#toolLifetime.abort(cleanupError());
      }
      throw error;
    }
    const state: OwnedProcess = {
      managed,
      kind,
      ...(artifactPath === undefined ? {} : { artifactPath }),
      settled: false,
      interactionVersion: 0,
      startedAt: new Date().toISOString(),
      drained: Promise.resolve(),
    };
    void (managed.exited ?? managed.completed).then(
      () => {
        state.exitedAt = new Date().toISOString();
      },
      () => undefined,
    );
    let firstFrame: (() => void) | undefined;
    if (kind === "video")
      state.firstFrame = new Promise<void>((resolve) => {
        firstFrame = resolve;
      });
    const drain = async (stream: NodeJS.ReadableStream, progress = false) => {
      let pending = "";
      for await (const chunk of stream) {
        if (!progress || firstFrame === undefined) continue;
        pending += Buffer.from(chunk).toString("utf8");
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        if (lines.some((line) => /^frame=\s*[1-9][0-9]*\s*$/u.test(line))) {
          firstFrame();
          firstFrame = undefined;
        }
        if (pending.length > 4096) pending = "";
      }
    };
    const drained = Promise.allSettled([
      managed.completed,
      managed.exited ?? managed.completed,
      drain(managed.stdout, kind === "video"),
      drain(managed.stderr),
    ] as const).then((results) => {
      if (
        results[1]!.status !== "fulfilled" ||
        results.slice(2).some((result) => result.status === "rejected")
      ) {
        this.#cleanupUncertain = true;
        throw cleanupError();
      }
      if (results[1]!.status === "fulfilled") state.exit = results[1]!.value;
      state.completionSucceeded = results[0]!.status === "fulfilled";
      state.settled = true;
    });
    void drained.catch(() => undefined);
    Object.assign(state, { drained });
    if (kind === "application" && managed.processCreationTimeFileTime === undefined) {
      await managed.terminate("cancelled");
      await drained;
      throw new Error("The application lacks a verified process identity.");
    }
    return state;
  }
  async #stop(owned: OwnedProcess): Promise<void> {
    if (!owned.settled) await owned.managed.terminate("cancelled");
    await deadline(owned.drained, 15_000);
  }
  async #capture(
    path: string,
    kind: "image" | "video",
    mediaType: string,
  ): Promise<InvestigationArtifactV1> {
    const bytes = await readE2eMedia(path, this.#directory, kind);
    return this.options.workspace.writeArtifact({
      subjectRef: this.options.task.subjectRef,
      kind,
      name: win32.basename(path),
      mediaType,
      bytes,
    });
  }
}

export function selectE2eRecordingEvidence(
  receipts: readonly E2eToolReceipt[],
  binding: {
    featureId: string;
    processRef: string;
    buildRef: string;
    startedAt: string;
    endedAt: string;
    targetPid: number;
    windowHandle: string;
  },
): E2eToolReceipt[] {
  const started = Date.parse(binding.startedAt);
  const ended = Date.parse(binding.endedAt);
  const inCapture = receipts.filter(
    (receipt) =>
      receipt.status === "passed" &&
      receipt.featureId === binding.featureId &&
      receipt.processRef === binding.processRef &&
      receipt.buildRef === binding.buildRef &&
      receipt.targetPid === binding.targetPid &&
      receipt.windowHandle === binding.windowHandle &&
      receipt.startedAt !== undefined &&
      receipt.finishedAt !== undefined &&
      Date.parse(receipt.startedAt) >= started &&
      Date.parse(receipt.finishedAt) <= ended,
  );
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(ended) ||
    ended <= started ||
    !inCapture.some((receipt) => ["click", "type", "keys"].includes(receipt.operation))
  )
    return [];
  return inCapture.filter((receipt) => receipt.assertion && receipt.operation === "assert");
}

export function requireSuccessfulE2eRecording(
  completionSucceeded: boolean,
  exit: ProcessExitedEvent | undefined,
): void {
  if (!completionSucceeded || exit?.exitCode !== 0 || exit.signal !== null || exit.outputTruncated)
    throw new Error("The video recorder did not finish successfully and completely.");
}

/** Stable regular files only; real media signatures are checked before becoming report evidence. */
export async function readE2eMedia(
  path: string,
  directory: string,
  kind: "image" | "video",
): Promise<Buffer> {
  const relative = win32.relative(directory, path);
  if (!relative || relative.startsWith("..") || win32.isAbsolute(relative))
    throw new Error("Media escaped its attempt directory.");
  const stat = await lstat(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size <= 0n ||
    stat.size > 10n * 1024n * 1024n
  )
    throw new Error("Media is not a bounded regular file.");
  if ((await realpath(path)).toLowerCase() !== win32.resolve(path).toLowerCase())
    throw new Error("Media resolved through a link.");
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.ino !== stat.ino ||
      before.dev !== stat.dev ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      bytes.length !== Number(stat.size)
    )
      throw new Error("Media changed while being imported.");
    if (
      kind === "image" &&
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("Screenshot is not PNG.");
    if (
      kind === "video" &&
      (bytes.length < 24 ||
        bytes.subarray(4, 8).toString("ascii") !== "ftyp" ||
        !bytes.includes(Buffer.from("moov")) ||
        !bytes.includes(Buffer.from("mdat")))
    )
      throw new Error("Recording is not a finalized MP4.");
    return bytes;
  } finally {
    await handle.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("An object is required.");
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, maximum = 32_767): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new Error(`${name} is invalid.`);
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error("A bounded integer is required.");
  return value;
}
function cleanupError() {
  return Object.assign(
    new Error("Owned E2E processes or desktop cleanup could not be confirmed."),
    { code: "E2E_CLEANUP_UNCONFIRMED" },
  );
}
async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(cleanupError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
