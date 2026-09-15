import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { win32 } from "node:path";
import {
  EntityIdSchema,
  resolveManagedWebUiUrl,
  Sha256Schema,
  UiScenarioConfigurationSchema,
} from "@agentic-review/contracts";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type ManagedProcessRunner,
  ProductionManagedProcessRunner,
} from "../execution/managed-process-runner.js";
import {
  assertValidProcessLaunchSpec,
  assertWindowsLocalAbsolutePath,
  type ManagedProcess,
  type ProcessExitedEvent,
  type ProcessLaunchSpec,
  type ProcessResourceLimits,
  ProcessResourceLimitsSchema,
} from "../execution/process-host-protocol.js";
import { acquireDesktopLease, type DesktopLease } from "../ui/desktop-lease.js";
import {
  parseWebDriverRequest,
  parseWebDriverResult,
  type WebDriverResult,
} from "../ui/web-driver.js";
import {
  parseWindowsDriverRequest,
  parseWindowsDriverResult,
  parseWindowsSessionProbeResult,
  parseWindowsTcpOwnerProbeResult,
  type WindowsDriverRequest,
  type WindowsDriverResult,
} from "../ui/windows-driver.js";
import type { InvestigationUiArtifact, InvestigationUiPlanAdapter } from "./plan-executor.js";

const boundedText = Type.String({ minLength: 1, maxLength: 32_767, pattern: "^[^\\u0000]*$" });
const pinnedFileSchema = Type.Object(
  { path: boundedText, sha256: Sha256Schema },
  { additionalProperties: false },
);
const launchFields = {
  arguments: Type.Array(Type.String({ maxLength: 32_767, pattern: "^[^\\u0000]*$" }), {
    maxItems: 128,
  }),
  workingDirectory: boundedText,
};

/** Deployment configuration; model output can only select a registered scenario identifier. */
export const InvestigationUiPlanAdapterConfigurationSchema = Type.Object(
  {
    schemaVersion: Type.Literal("InvestigationUiPlanAdapterConfigurationV1"),
    profile: UiScenarioConfigurationSchema,
    application: Type.Union([
      Type.Object(
        { ...launchFields, kind: Type.Literal("registered"), executableId: EntityIdSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        { ...launchFields, kind: Type.Literal("source"), path: boundedText },
        { additionalProperties: false },
      ),
    ]),
    windowsDriver: Type.Object(
      { executable: pinnedFileSchema, entry: pinnedFileSchema },
      { additionalProperties: false },
    ),
    webDriver: Type.Optional(
      Type.Object(
        {
          executable: pinnedFileSchema,
          entry: pinnedFileSchema,
          browser: pinnedFileSchema,
        },
        { additionalProperties: false },
      ),
    ),
    desktopLockDirectory: Type.Optional(boundedText),
  },
  { additionalProperties: false },
);
export type InvestigationUiPlanAdapterConfiguration = Static<
  typeof InvestigationUiPlanAdapterConfigurationSchema
>;
type PinnedFile = InvestigationUiPlanAdapterConfiguration["windowsDriver"]["entry"];
type AdapterInput = Parameters<InvestigationUiPlanAdapter["execute"]>[0];
type AdapterContext = Parameters<InvestigationUiPlanAdapter["execute"]>[1];
type AdapterResult = Awaited<ReturnType<InvestigationUiPlanAdapter["execute"]>>;
type DriverResult = WebDriverResult | WindowsDriverResult;

export type InvestigationUiPlanAdapterFailureCode =
  | "UI_CONFIGURATION_INVALID"
  | "UI_EXECUTION_UNAUTHORIZED"
  | "UI_SCENARIO_UNREGISTERED"
  | "UI_TRUSTED_FILE_INVALID"
  | "UI_EVIDENCE_INVALID"
  | "UI_DRIVER_RESULT_INVALID"
  | "UI_APPLICATION_IDENTITY_UNAVAILABLE"
  | "UI_APPLICATION_EXITED"
  | "UI_APPLICATION_OUTPUT_INVALID"
  | "UI_DESKTOP_UNAVAILABLE"
  | "UI_READINESS_FAILED"
  | "UI_PROCESS_CLEANUP_UNCONFIRMED";

export class InvestigationUiPlanAdapterError extends Error {
  public constructor(
    public readonly code: InvestigationUiPlanAdapterFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "InvestigationUiPlanAdapterError";
  }
}

export interface InvestigationUiPlanAdapterFileSystem {
  verifyPinnedFile(file: PinnedFile): Promise<void>;
  createEvidenceDirectory(path: string): Promise<void>;
  readEvidenceFile(
    directory: string,
    relativePath: string,
    maximumBytes: number,
  ): Promise<Uint8Array>;
}

export interface ProductionInvestigationUiPlanAdapterOptions {
  readonly configuration: InvestigationUiPlanAdapterConfiguration;
  readonly environment: Readonly<Record<string, string>>;
  readonly processLimits: ProcessResourceLimits;
  readonly executables?: Readonly<Record<string, string>>;
  readonly processRunner?: ManagedProcessRunner;
  readonly fileSystem?: InvestigationUiPlanAdapterFileSystem;
  readonly acquireDesktop?: typeof acquireDesktopLease;
  readonly allocatePort?: (signal: AbortSignal) => Promise<number>;
  readonly httpReadiness?: (
    url: string,
    expectedStatus: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly createId?: () => string;
  readonly cleanupTimeoutMs?: number;
}

export function parseInvestigationUiPlanAdapterConfiguration(
  value: unknown,
): InvestigationUiPlanAdapterConfiguration {
  if (!Value.Check(InvestigationUiPlanAdapterConfigurationSchema, value)) configurationError();
  try {
    for (const file of pinnedFiles(value))
      assertWindowsLocalAbsolutePath(file.path, "Pinned UI driver file", false);
    assertWindowsLocalAbsolutePath(
      value.windowsDriver.executable.path,
      "Windows UI driver executable",
      true,
    );
    if (value.webDriver !== undefined) {
      assertWindowsLocalAbsolutePath(
        value.webDriver.executable.path,
        "Web UI driver executable",
        true,
      );
      assertWindowsLocalAbsolutePath(value.webDriver.browser.path, "UI browser executable", true);
    }
    if (value.desktopLockDirectory !== undefined)
      assertWindowsLocalAbsolutePath(
        value.desktopLockDirectory,
        "Shared desktop lock directory",
        false,
      );
  } catch {
    configurationError();
  }
  if (
    value.profile.reset.strategy !== "restart_process" ||
    !safeRelativePath(value.application.workingDirectory, true) ||
    (value.application.kind === "source" && !safeRelativePath(value.application.path, false)) ||
    (value.profile.target === "web" && value.webDriver === undefined) ||
    (value.profile.target === "windows_desktop" && value.desktopLockDirectory === undefined) ||
    new Set(value.profile.scenarios.map((scenario) => scenario.id)).size !==
      value.profile.scenarios.length ||
    value.profile.scenarios.some(
      (scenario) => new Set(scenario.steps.map((step) => step.id)).size !== scenario.steps.length,
    )
  )
    configurationError();
  return structuredClone(value);
}

/** Executes the standalone UI protocols entirely inside owned ProcessHost process trees. */
export class ProductionInvestigationUiPlanAdapter implements InvestigationUiPlanAdapter {
  readonly #configuration: InvestigationUiPlanAdapterConfiguration;
  readonly #runner: ManagedProcessRunner;
  readonly #files: InvestigationUiPlanAdapterFileSystem;
  readonly #cleanupTimeoutMs: number;

  public constructor(private readonly options: ProductionInvestigationUiPlanAdapterOptions) {
    this.#configuration = parseInvestigationUiPlanAdapterConfiguration(options.configuration);
    this.#runner = options.processRunner ?? new ProductionManagedProcessRunner();
    this.#files = options.fileSystem ?? productionFiles;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30_000;
    if (
      !Value.Check(ProcessResourceLimitsSchema, options.processLimits) ||
      !Number.isSafeInteger(this.#cleanupTimeoutMs) ||
      this.#cleanupTimeoutMs < 1_000 ||
      this.#cleanupTimeoutMs > 60_000
    )
      configurationError();
    if (this.#configuration.application.kind === "registered") {
      const executable = options.executables?.[this.#configuration.application.executableId];
      if (executable === undefined) configurationError();
      try {
        assertWindowsLocalAbsolutePath(executable, "Registered UI application executable", true);
      } catch {
        configurationError();
      }
    }
  }

  public async execute(input: AdapterInput, context: AdapterContext): Promise<AdapterResult> {
    context.signal.throwIfAborted();
    const profile = this.#configuration.profile;
    const scenario = profile.scenarios.find((candidate) => candidate.id === input.scenarioId);
    if (scenario === undefined)
      throw new InvestigationUiPlanAdapterError(
        "UI_SCENARIO_UNREGISTERED",
        "The requested UI scenario is not registered in trusted worker configuration.",
      );
    const policy = input.task.executionPolicy;
    if (
      input.attempt.taskId !== input.task.id ||
      policy.mode !== "execute" ||
      !policy.allowRepositoryExecution ||
      policy.authorizationRef === null ||
      !policy.allowedSubjectRefs.includes(input.task.subjectRef) ||
      input.workspace.sourceDirectory === null ||
      input.workspace.sourceBinding?.subjectRef !== input.task.subjectRef
    ) {
      throw new InvestigationUiPlanAdapterError(
        "UI_EXECUTION_UNAUTHORIZED",
        "UI execution requires a frozen authorized task source and matching worker attempt.",
      );
    }
    await input.workspace.assertIntegrity();
    await input.workspace.assertSourceBinding();
    const measured = await Promise.allSettled(
      pinnedFiles(this.#configuration).map(async (file) => {
        if (isWithin(input.workspace.attemptDirectory, file.path))
          throw new InvestigationUiPlanAdapterError(
            "UI_TRUSTED_FILE_INVALID",
            "A UI driver or browser cannot be loaded from the task workspace.",
          );
        await this.#files.verifyPinnedFile(file);
      }),
    );
    if (measured.some((result) => result.status === "rejected"))
      throw new InvestigationUiPlanAdapterError(
        "UI_TRUSTED_FILE_INVALID",
        "A configured UI driver or browser failed its pinned file verification.",
      );
    const id = (this.options.createId ?? randomUUID)();
    if (!/^[a-f0-9-]{1,80}$/u.test(id)) configurationError();
    const evidenceDirectory = win32.join(input.workspace.controlDirectory, `ui-${id}`);
    if (isWithin(input.workspace.sourceDirectory, evidenceDirectory)) configurationError();
    try {
      await this.#files.createEvidenceDirectory(evidenceDirectory);
    } catch {
      throw new InvestigationUiPlanAdapterError(
        "UI_EVIDENCE_INVALID",
        "The private UI evidence directory could not be created safely.",
      );
    }
    const lifetime = new AbortController();
    const timeout = setTimeout(
      () =>
        lifetime.abort(
          new InvestigationUiPlanAdapterError(
            "UI_READINESS_FAILED",
            "The UI scenario exceeded its managed execution deadline.",
          ),
        ),
      Math.min(
        this.options.processLimits.hardTimeoutMs,
        scenario.timeoutMs + profile.launch.readiness.timeoutMs + 15_000,
      ),
    );
    timeout.unref();
    const signal = AbortSignal.any([context.signal, lifetime.signal]);
    const executionContext = { ...context, signal };
    let desktop: DesktopLease | undefined;
    let application: TrackedApplication | undefined;
    let driverResult: DriverResult | undefined;
    let artifacts: InvestigationUiArtifact[] = [];
    let failure: unknown;
    let cleanupFailure: InvestigationUiPlanAdapterError | undefined;
    try {
      if (profile.target === "windows_desktop") {
        const probe = parseWindowsSessionProbeResult(
          await this.#runWindowsProbe(input, executionContext, {
            schemaVersion: "WindowsSessionProbeRequestV1",
          }),
        );
        if (!probe.available)
          throw new InvestigationUiPlanAdapterError(
            "UI_DESKTOP_UNAVAILABLE",
            "An exclusive interactive Windows session is unavailable.",
          );
        desktop = await (this.options.acquireDesktop ?? acquireDesktopLease)({
          lockDirectory: this.#configuration.desktopLockDirectory!,
          sessionId: probe.sessionId,
          ownerId: `${input.task.id}:${input.attempt.id}:${id}`,
        });
      }
      const port =
        profile.target === "web"
          ? await (this.options.allocatePort ?? allocateLoopbackPort)(signal)
          : undefined;
      if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535))
        configurationError();
      const spec = await this.#applicationSpec(input, port);
      const managed = await context.processHost.start(spec, signal);
      application = trackApplication(managed, lifetime);
      const root = processIdentity(managed);
      if (profile.target === "web")
        await this.#waitForWeb(input, executionContext, root, port!, profile);
      const driver = this.#driverSpec(input, evidenceDirectory, root, port, scenario);
      const output = await this.#runner.run(driver.spec, executionContext);
      signal.throwIfAborted();
      if (output.exitCode !== 0)
        throw new InvestigationUiPlanAdapterError(
          "UI_DRIVER_RESULT_INVALID",
          "The UI driver did not exit successfully.",
        );
      try {
        driverResult = driver.parse(output.stdout);
      } catch {
        throw new InvestigationUiPlanAdapterError(
          "UI_DRIVER_RESULT_INVALID",
          "The UI driver result does not match the assigned typed scenario.",
        );
      }
      artifacts = await this.#readEvidence(evidenceDirectory, driverResult);
      await input.workspace.assertIntegrity();
      await input.workspace.assertSourceBinding();
      signal.throwIfAborted();
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
      try {
        if (application !== undefined) await stopApplication(application, this.#cleanupTimeoutMs);
      } catch {
        cleanupFailure = new InvestigationUiPlanAdapterError(
          "UI_PROCESS_CLEANUP_UNCONFIRMED",
          "The owned UI application did not confirm complete process and output cleanup.",
        );
        try {
          await desktop?.quarantine("UI_PROCESS_CLEANUP_UNCONFIRMED");
        } catch {
          /* Preserve the cleanup fault even if recording quarantine also fails. */
        }
      }
      if (desktop !== undefined && cleanupFailure === undefined) {
        try {
          await desktop.releaseRestored();
        } catch {
          cleanupFailure = new InvestigationUiPlanAdapterError(
            "UI_PROCESS_CLEANUP_UNCONFIRMED",
            "The exclusive desktop could not confirm safe release.",
          );
          try {
            await desktop.quarantine("UI_DESKTOP_RELEASE_UNCONFIRMED");
          } catch {
            /* Preserve the cleanup fault even if recording quarantine also fails. */
          }
        }
      }
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (failure !== undefined) throw failure;
    context.signal.throwIfAborted();
    if (driverResult === undefined)
      throw new InvestigationUiPlanAdapterError(
        "UI_DRIVER_RESULT_INVALID",
        "The UI driver did not produce a result.",
      );
    const status =
      driverResult.evidenceComplete &&
      (driverResult.outcome === "passed" || driverResult.outcome === "failed")
        ? driverResult.outcome
        : "blocked";
    return {
      status,
      summary:
        status === "blocked" && !driverResult.evidenceComplete
          ? "The UI scenario did not retain complete worker evidence."
          : driverResult.summary,
      observation: {
        schemaVersion: "InvestigationUiObservationV1",
        scenarioId: scenario.id,
        driver: driverResult,
      },
      artifacts,
    };
  }

  async #applicationSpec(
    input: AdapterInput,
    port: number | undefined,
  ): Promise<ProcessLaunchSpec> {
    const application = this.#configuration.application;
    const executable =
      application.kind === "source"
        ? await input.workspace.resolveSourcePath(application.path)
        : this.options.executables![application.executableId]!;
    const workingDirectory =
      application.workingDirectory === "."
        ? input.workspace.sourceDirectory!
        : await input.workspace.resolveSourcePath(application.workingDirectory);
    const environment: Record<string, string> = {
      ...this.options.environment,
      TEMP: input.workspace.tempDirectory,
      TMP: input.workspace.tempDirectory,
    };
    if (this.#configuration.profile.target === "web")
      environment[this.#configuration.profile.service.portEnvironmentVariable] = String(port);
    const spec: ProcessLaunchSpec = {
      executable,
      arguments: [...application.arguments],
      workingDirectory,
      environmentMode: "replace",
      environment,
      captureProcessIdentity: true,
      limits: { ...this.options.processLimits },
    };
    assertValidProcessLaunchSpec(spec);
    return spec;
  }

  #windowsSpec(input: AdapterInput, request: unknown): ProcessLaunchSpec {
    const driver = this.#configuration.windowsDriver;
    return this.#spec(
      input,
      driver.executable.path,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driver.entry.path],
      request,
    );
  }

  #spec(
    input: AdapterInput,
    executable: string,
    args: readonly string[],
    request: unknown,
  ): ProcessLaunchSpec {
    const spec: ProcessLaunchSpec = {
      executable,
      arguments: args,
      workingDirectory: input.workspace.controlDirectory,
      environmentMode: "replace",
      environment: {
        ...this.options.environment,
        TEMP: input.workspace.tempDirectory,
        TMP: input.workspace.tempDirectory,
      },
      standardInput: JSON.stringify(request),
      limits: {
        ...this.options.processLimits,
        maximumOutputBytes: Math.min(this.options.processLimits.maximumOutputBytes, 1_048_576),
      },
    };
    assertValidProcessLaunchSpec(spec);
    return spec;
  }

  async #runWindowsProbe(
    input: AdapterInput,
    context: AdapterContext,
    request: unknown,
  ): Promise<string> {
    const result = await this.#runner.run(this.#windowsSpec(input, request), context);
    if (result.exitCode !== 0)
      throw new InvestigationUiPlanAdapterError(
        "UI_DRIVER_RESULT_INVALID",
        "The UI ownership probe did not exit successfully.",
      );
    return result.stdout;
  }

  async #waitForWeb(
    input: AdapterInput,
    context: AdapterContext,
    root: WindowsDriverRequest["rootProcess"],
    port: number,
    profile: Extract<InvestigationUiPlanAdapterConfiguration["profile"], { target: "web" }>,
  ): Promise<void> {
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(profile.launch.readiness.timeoutMs),
    ]);
    const owner = async (): Promise<boolean> =>
      parseWindowsTcpOwnerProbeResult(
        await this.#runWindowsProbe(
          input,
          { ...context, signal },
          {
            schemaVersion: "WindowsTcpOwnerProbeRequestV1",
            rootProcess: root,
            port,
          },
        ),
        root,
        port,
      ).owned;
    for (;;) {
      signal.throwIfAborted();
      if (
        (await owner()) &&
        (await (this.options.httpReadiness ?? httpReadiness)(
          resolveManagedWebUiUrl(port, profile.launch.readiness.path),
          profile.launch.readiness.expectedStatus,
          signal,
        )) &&
        (await owner())
      )
        return;
      await abortable(new Promise<void>((resolve) => setTimeout(resolve, 100)), signal);
    }
  }

  #driverSpec(
    input: AdapterInput,
    evidenceDirectory: string,
    rootProcess: WindowsDriverRequest["rootProcess"],
    port: number | undefined,
    scenario: InvestigationUiPlanAdapterConfiguration["profile"]["scenarios"][number],
  ): { spec: ProcessLaunchSpec; parse(output: string): DriverResult } {
    const profile = this.#configuration.profile;
    if (profile.target === "windows_desktop") {
      const request = parseWindowsDriverRequest({
        schemaVersion: "WindowsDriverRequestV1",
        rootProcess,
        scenario,
        readiness: profile.launch.readiness,
        evidence: profile.evidence,
        evidenceDirectory,
      });
      return {
        spec: this.#windowsSpec(input, request),
        parse: (output) => parseWindowsDriverResult(output, request),
      };
    }
    const driver = this.#configuration.webDriver!;
    const request = parseWebDriverRequest(
      {
        schemaVersion: "WebDriverRequestV1",
        servicePort: port,
        scenario,
        browser: profile.browser,
        evidence: profile.evidence,
        browserExecutablePath: driver.browser.path,
        evidenceDirectory,
      },
      { pathPlatform: "windows" },
    );
    return {
      spec: this.#spec(input, driver.executable.path, [driver.entry.path], request),
      parse: (output) => parseWebDriverResult(output, request, { pathPlatform: "windows" }),
    };
  }

  async #readEvidence(directory: string, result: DriverResult): Promise<InvestigationUiArtifact[]> {
    const artifacts: InvestigationUiArtifact[] = [];
    let totalBytes = 0;
    for (const file of result.evidenceFiles) {
      let bytes: Uint8Array;
      try {
        bytes = await this.#files.readEvidenceFile(directory, file.relativePath, file.sizeBytes);
      } catch {
        throw new InvestigationUiPlanAdapterError(
          "UI_EVIDENCE_INVALID",
          "A UI evidence file could not be read from its owned output directory.",
        );
      }
      totalBytes += bytes.byteLength;
      if (
        bytes.byteLength !== file.sizeBytes ||
        totalBytes > 128 * 1_024 * 1_024 ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256 ||
        (file.kind === "screenshot" &&
          !Buffer.from(bytes)
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      ) {
        throw new InvestigationUiPlanAdapterError(
          "UI_EVIDENCE_INVALID",
          "UI evidence bytes do not match the driver manifest and file format.",
        );
      }
      if (
        file.kind === "ui_steps" &&
        !Buffer.from(bytes).equals(Buffer.from(JSON.stringify(result.execution), "utf8"))
      ) {
        throw new InvestigationUiPlanAdapterError(
          "UI_EVIDENCE_INVALID",
          "The stored UI observation document differs from the driver result.",
        );
      }
      artifacts.push({
        name: win32.basename(file.relativePath),
        mediaType: file.mediaType,
        kind: file.kind === "screenshot" ? "image" : file.kind === "trace" ? "trace" : "log",
        bytes: Uint8Array.from(bytes),
      });
    }
    return artifacts;
  }
}

function pinnedFiles(configuration: InvestigationUiPlanAdapterConfiguration): PinnedFile[] {
  return [
    configuration.windowsDriver.executable,
    configuration.windowsDriver.entry,
    ...(configuration.webDriver === undefined
      ? []
      : [
          configuration.webDriver.executable,
          configuration.webDriver.entry,
          configuration.webDriver.browser,
        ]),
  ];
}

function configurationError(): never {
  throw new InvestigationUiPlanAdapterError(
    "UI_CONFIGURATION_INVALID",
    "The standalone UI adapter requires a valid trusted driver, application, and scenario configuration.",
  );
}

function safeRelativePath(path: string, allowRoot: boolean): boolean {
  return (
    (allowRoot && path === ".") ||
    (path.length > 0 &&
      !win32.isAbsolute(path) &&
      ![...path].some((character) => character.charCodeAt(0) < 32 || character === ":") &&
      path
        .split(/[\\/]/u)
        .every(
          (segment) =>
            segment !== "" && segment !== "." && segment !== ".." && !/[. ]$/u.test(segment),
        ))
  );
}

function isWithin(root: string, target: string): boolean {
  const relative = win32.relative(win32.resolve(root), win32.resolve(target));
  return (
    relative === "" ||
    (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"))
  );
}

function processIdentity(process: ManagedProcess): WindowsDriverRequest["rootProcess"] {
  if (
    !Number.isSafeInteger(process.processId) ||
    process.processId <= 0 ||
    process.processCreationTimeFileTime === undefined ||
    !/^[1-9][0-9]{0,19}$/u.test(process.processCreationTimeFileTime)
  ) {
    throw new InvestigationUiPlanAdapterError(
      "UI_APPLICATION_IDENTITY_UNAVAILABLE",
      "ProcessHost did not provide the exact owned application creation identity.",
    );
  }
  return { pid: process.processId, creationTimeFileTime: process.processCreationTimeFileTime };
}

interface TrackedApplication {
  readonly process: ManagedProcess;
  readonly settled: Promise<ProcessExitedEvent>;
  stopping: boolean;
}

function trackApplication(process: ManagedProcess, lifetime: AbortController): TrackedApplication {
  let outputBytes = 0;
  const drain = async (stream: ManagedProcess["stdout"]): Promise<void> => {
    for await (const raw of stream) {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      outputBytes += bytes.byteLength;
      if (outputBytes > 1_048_576)
        lifetime.abort(
          new InvestigationUiPlanAdapterError(
            "UI_APPLICATION_OUTPUT_INVALID",
            "The UI application exceeded its bounded output budget.",
          ),
        );
    }
  };
  const tracked: TrackedApplication = {
    process,
    stopping: false,
    settled: Promise.allSettled([
      process.completed,
      drain(process.stdout),
      drain(process.stderr),
    ] as const).then((results) => {
      const exited = results[0];
      if (
        exited?.status !== "fulfilled" ||
        results.some((result) => result.status === "rejected")
      ) {
        throw new InvestigationUiPlanAdapterError(
          "UI_APPLICATION_OUTPUT_INVALID",
          "The UI application output or termination receipt did not settle.",
        );
      }
      return exited.value;
    }),
  };
  void process.completed.then(
    () => {
      if (!tracked.stopping)
        lifetime.abort(
          new InvestigationUiPlanAdapterError(
            "UI_APPLICATION_EXITED",
            "The owned UI application exited before the scenario completed.",
          ),
        );
    },
    () =>
      lifetime.abort(
        new InvestigationUiPlanAdapterError(
          "UI_APPLICATION_EXITED",
          "The owned UI application lost its execution receipt.",
        ),
      ),
  );
  void tracked.settled.catch(() => undefined);
  return tracked;
}

async function stopApplication(application: TrackedApplication, timeoutMs: number): Promise<void> {
  application.stopping = true;
  const signal = AbortSignal.timeout(timeoutMs);
  await abortable(application.process.terminate("cancelled"), signal);
  const exit = await abortable(application.settled, signal);
  if (exit.outputTruncated)
    throw new InvestigationUiPlanAdapterError(
      "UI_APPLICATION_OUTPUT_INVALID",
      "The managed UI application lost output before shutdown.",
    );
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function allocateLoopbackPort(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new InvestigationUiPlanAdapterError(
        "UI_READINESS_FAILED",
        "The managed application port could not be allocated.",
      );
    signal.throwIfAborted();
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

async function httpReadiness(
  url: string,
  expectedStatus: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(url, { signal, redirect: "manual", cache: "no-store" });
    await response.body?.cancel();
    return response.status === expectedStatus;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function assertDirectoryChain(path: string): Promise<void> {
  assertWindowsLocalAbsolutePath(path, "UI evidence directory", false);
  let current = win32.resolve(path);
  for (;;) {
    const state = await lstat(current, { bigint: true });
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      (await realpath(current)).toLowerCase() !== current.toLowerCase()
    ) {
      throw new InvestigationUiPlanAdapterError(
        "UI_EVIDENCE_INVALID",
        "The UI output directory contains a redirected path.",
      );
    }
    const parent = win32.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readStableFile(
  path: string,
  maximumBytes: number,
  keepBytes: boolean,
): Promise<{ bytes: Uint8Array; digest: string }> {
  await assertDirectoryChain(win32.dirname(path));
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (keepBytes && before.nlink !== 1n) ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes) ||
    (await realpath(path)).toLowerCase() !== win32.resolve(path).toLowerCase()
  )
    throw new InvestigationUiPlanAdapterError(
      "UI_EVIDENCE_INVALID",
      "A UI file is redirected, shared, empty, or exceeds its byte limit.",
    );
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await handle.stat({ bigint: true })))
      throw new InvestigationUiPlanAdapterError(
        "UI_EVIDENCE_INVALID",
        "A UI file changed identity during opening.",
      );
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(65_536);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes)
        throw new InvestigationUiPlanAdapterError(
          "UI_EVIDENCE_INVALID",
          "A UI file grew beyond its allowed byte limit.",
        );
      hash.update(buffer.subarray(0, bytesRead));
      if (keepBytes) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await lstat(path, { bigint: true });
    if (
      BigInt(total) !== before.size ||
      !sameFile(before, after) ||
      !sameFile(before, await handle.stat({ bigint: true })) ||
      after.isSymbolicLink() ||
      (keepBytes && after.nlink !== 1n)
    )
      throw new InvestigationUiPlanAdapterError(
        "UI_EVIDENCE_INVALID",
        "A UI file changed during evidence capture.",
      );
    await assertDirectoryChain(win32.dirname(path));
    return {
      bytes: keepBytes ? Buffer.concat(chunks, total) : new Uint8Array(),
      digest: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

const productionFiles: InvestigationUiPlanAdapterFileSystem = {
  async verifyPinnedFile(file) {
    const result = await readStableFile(file.path, 1_024 * 1_024 * 1_024, false);
    if (result.digest !== file.sha256)
      throw new InvestigationUiPlanAdapterError(
        "UI_TRUSTED_FILE_INVALID",
        "A pinned UI driver file digest changed.",
      );
  },
  async createEvidenceDirectory(path) {
    await assertDirectoryChain(win32.dirname(path));
    await mkdir(path, { recursive: false, mode: 0o700 });
    await assertDirectoryChain(path);
  },
  async readEvidenceFile(directory, relativePath, maximumBytes) {
    if (!safeRelativePath(relativePath, false))
      throw new InvestigationUiPlanAdapterError(
        "UI_EVIDENCE_INVALID",
        "A UI evidence path must remain inside its owned directory.",
      );
    const path = win32.resolve(directory, relativePath);
    if (!isWithin(directory, path))
      throw new InvestigationUiPlanAdapterError(
        "UI_EVIDENCE_INVALID",
        "A UI evidence path escaped its owned directory.",
      );
    await assertDirectoryChain(directory);
    return (await readStableFile(path, maximumBytes, true)).bytes;
  },
};
