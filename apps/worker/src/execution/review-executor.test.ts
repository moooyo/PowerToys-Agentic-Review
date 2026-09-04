import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  createCanonicalResult,
  IssueTriageV1ModelOutputSchema,
  PrReviewPlanV1ModelOutputSchema,
  PrReviewPlanV1Schema,
} from "@agentic-review/codex";
import type { JobExecutionEnvelope } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger.js";
import type { ExecutionProgress } from "./job-executor.js";
import {
  JobWorkspaceError,
  type JobWorkspaceProvider,
  type PreparedJobWorkspace,
} from "./job-workspace.js";
import { ProcessHostRequestError } from "./process-host-client.js";
import type {
  ManagedProcess,
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessLaunchSpec,
} from "./process-host-protocol.js";
import {
  buildReviewCodexConfig,
  type ReviewFileHandle,
  type ReviewFileIO,
  type ReviewFileStat,
  ReviewJobExecutor,
  type ReviewJobExecutorOptions,
} from "./review-executor.js";
import { WorkspaceDiskBudgetError, type WorkspaceDiskMonitor } from "./workspace-disk-budget.js";

const paths = {
  attempt: "C:\\AgenticReview\\attempt-1",
  checkout: "C:\\AgenticReview\\attempt-1\\checkout",
  control: "C:\\AgenticReview\\attempt-1\\control",
  codexHome: "C:\\AgenticReview\\attempt-1\\codex-home",
  temp: "C:\\AgenticReview\\attempt-1\\temp",
  userProfile: "C:\\AgenticReview\\attempt-1\\user-profile",
  result: "C:\\AgenticReview\\attempt-1\\control\\result.json",
  schema: "C:\\AgenticReview\\attempt-1\\control\\schema.json",
  config: "C:\\AgenticReview\\attempt-1\\codex-home\\config.toml",
} as const;

const prompt = "Review the immutable target revision.";
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const schemaSnapshot = (schema: unknown): { readonly value: unknown; readonly digest: string } => {
  const value = JSON.parse(JSON.stringify(schema)) as unknown;
  return { value, digest: createCanonicalResult(value).sha256 };
};

const prSchema = schemaSnapshot(PrReviewPlanV1ModelOutputSchema);
const issueSchema = schemaSnapshot(IssueTriageV1ModelOutputSchema);
const prApplicationSchema = schemaSnapshot(PrReviewPlanV1Schema);

const validPrFinding = () => ({
  findingId: "finding-1",
  priority: 1,
  title: "Review note",
  body: "The implementation has one actionable review note.",
  path: "src/module/file.ts",
  line: 10,
  endLine: 12,
  confidence: 0.9,
});

const validPrResult = () => ({
  schemaVersion: "PrReviewPlanV1" as const,
  summary: "The revision is ready for review.",
  assessment: "comment" as const,
  findings: [validPrFinding()],
  requestedRecipeIds: ["powertoys.static-check"],
});

const validIssueResult = () => ({
  schemaVersion: "IssueTriageV1" as const,
  summary: "The issue contains enough information for triage.",
  category: "bug" as const,
  priority: 1,
  confidence: 0.9,
  suggestedLabels: ["bug"],
  missingInformation: [],
  duplicateCandidates: [],
  requestedRecipeIds: [],
});

const createEnvelope = (kind: "pull_request_review" | "issue_triage"): JobExecutionEnvelope => {
  const isPr = kind === "pull_request_review";
  const output = isPr ? prSchema : issueSchema;
  return {
    protocolVersion: "1.0",
    envelopeVersion: 1,
    assignedAt: "2026-08-31T00:00:00.000Z",
    leaseExpiresAt: "2026-08-31T00:05:00.000Z",
    executionDeadlineAt: "2026-08-31T00:20:00.000Z",
    lease: {
      jobId: "job-1",
      runAttemptId: "attempt-1",
      workerNodeId: "worker-1",
      workerInstanceId: "instance-1",
      leaseToken: "x".repeat(32),
      leaseGeneration: 1,
    },
    job: {
      jobId: "job-1",
      kind,
      priority: 100,
      attempt: 1,
      maxAttempts: 3,
      generation: 1,
      intentVersion: 1,
      semanticKey: "review-job-1",
    },
    repository: { githubRepositoryId: 1, fullName: "microsoft/PowerToys" },
    resource: isPr
      ? {
          kind: "pull_request",
          githubNodeId: "PR_test",
          number: 42,
          title: "Test pull request",
          author: { githubUserId: 1, login: "author" },
          canonicalSnapshot: {},
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          isDraft: false,
        }
      : {
          kind: "issue",
          githubNodeId: "I_test",
          number: 42,
          title: "Test issue",
          author: { githubUserId: 1, login: "author" },
          canonicalSnapshot: {},
          revisionDigest: "c".repeat(64),
        },
    prompt: {
      name: isPr ? "pull-request-review" : "issue-triage",
      version: "1",
      renderedPrompt: prompt,
      promptSha256: sha256(prompt),
      outputSchema: output.value,
      outputSchemaSha256: output.digest,
    },
    executionPolicy: {
      hardTimeoutMs: 600_000,
      noProgressTimeoutMs: 120_000,
      allowedRecipeIds: ["powertoys.static-check"],
      requiredCapabilityLabels: {},
    },
  };
};

const successfulJsonl = (): string =>
  [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "turn.completed" }),
    "",
  ].join("\n");

class FakeStat implements ReviewFileStat {
  public constructor(
    public readonly dev: bigint,
    public readonly ino: bigint,
    public readonly size: bigint,
    public readonly mtimeMs: bigint,
    public readonly ctimeMs: bigint,
    private readonly file = true,
    private readonly symbolicLink = false,
  ) {}

  public isFile(): boolean {
    return this.file;
  }

  public isSymbolicLink(): boolean {
    return this.symbolicLink;
  }
}

interface FakeFileEntry {
  readonly content: Buffer;
  readonly ino: number;
  readonly file: boolean;
  readonly symbolicLink: boolean;
  readonly realPath: string;
  readonly changeDuringRead: boolean;
  handleStatCalls: number;
}

class FakeFileIO implements ReviewFileIO {
  readonly #entries = new Map<string, FakeFileEntry>();
  #nextIno = 1;
  public openReadError: unknown;
  public writeError: unknown;
  public readError: unknown;
  public closeError: unknown;

  public put(
    path: string,
    content: string | Buffer,
    options: {
      readonly file?: boolean;
      readonly symbolicLink?: boolean;
      readonly realPath?: string;
      readonly changeDuringRead?: boolean;
    } = {},
  ): void {
    this.#entries.set(this.#key(path), {
      content: Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8"),
      ino: this.#nextIno++,
      file: options.file ?? true,
      symbolicLink: options.symbolicLink ?? false,
      realPath: options.realPath ?? win32.normalize(path),
      changeDuringRead: options.changeDuringRead ?? false,
      handleStatCalls: 0,
    });
  }

  public readText(path: string): string | undefined {
    return this.#entries.get(this.#key(path))?.content.toString("utf8");
  }

  public async writeExclusiveUtf8(path: string, content: string): Promise<void> {
    if (this.writeError !== undefined) throw this.writeError;
    if (this.#entries.has(this.#key(path))) {
      throw fileSystemError("EEXIST");
    }
    this.put(path, content);
  }

  public async lstat(path: string): Promise<ReviewFileStat> {
    const entry = this.#entries.get(this.#key(path));
    if (entry === undefined) {
      throw fileSystemError("ENOENT");
    }
    return this.#stat(entry, false);
  }

  public async realpath(path: string): Promise<string> {
    return this.#entries.get(this.#key(path))?.realPath ?? win32.normalize(path);
  }

  public async openRead(path: string): Promise<ReviewFileHandle> {
    if (this.openReadError !== undefined) {
      throw this.openReadError;
    }
    const entry = this.#entries.get(this.#key(path));
    if (entry === undefined) {
      throw fileSystemError("ENOENT");
    }
    return {
      stat: async () => {
        entry.handleStatCalls += 1;
        return this.#stat(entry, entry.changeDuringRead && entry.handleStatCalls > 1);
      },
      read: async (buffer, offset, length, position) => {
        if (this.readError !== undefined) {
          throw this.readError;
        }
        const available = Math.max(0, entry.content.length - position);
        const bytesRead = Math.min(length, available);
        if (bytesRead > 0) {
          entry.content.copy(buffer, offset, position, position + bytesRead);
        }
        return { bytesRead };
      },
      close: async () => {
        if (this.closeError !== undefined) {
          throw this.closeError;
        }
      },
    };
  }

  #stat(entry: FakeFileEntry, changed: boolean): ReviewFileStat {
    return new FakeStat(
      1n,
      BigInt(entry.ino),
      BigInt(entry.content.length),
      changed ? 2n : 1n,
      changed ? 2n : 1n,
      entry.file,
      entry.symbolicLink,
    );
  }

  #key(path: string): string {
    return win32.normalize(path).toLowerCase();
  }
}

class FakeWorkspaceProvider implements JobWorkspaceProvider {
  public prepareCalls = 0;
  public cleanupCalls = 0;
  public prepareError: unknown;
  public cleanupError: unknown;
  public diskViolation: WorkspaceDiskBudgetError | undefined;
  public diskMonitorCalls = 0;
  public diskMonitorCloseCalls = 0;
  public readonly diskMonitorController = new AbortController();
  public onPrepare: (() => void) | undefined;

  public async prepare(): Promise<PreparedJobWorkspace> {
    this.prepareCalls += 1;
    this.onPrepare?.();
    if (this.prepareError !== undefined) {
      throw this.prepareError;
    }
    return {
      attemptDirectory: paths.attempt,
      checkoutDirectory: paths.checkout,
      controlDirectory: paths.control,
      codexHomeDirectory: paths.codexHome,
      tempDirectory: paths.temp,
      userProfileDirectory: paths.userProfile,
      startDiskMonitoring: async (parentSignal): Promise<WorkspaceDiskMonitor> => {
        this.diskMonitorCalls += 1;
        const onParentAbort = () => this.diskMonitorController.abort(parentSignal.reason);
        if (parentSignal.aborted) onParentAbort();
        else parentSignal.addEventListener("abort", onParentAbort, { once: true });
        return {
          signal: this.diskMonitorController.signal,
          violation: this.diskViolation,
          close: async () => {
            this.diskMonitorCloseCalls += 1;
            parentSignal.removeEventListener("abort", onParentAbort);
            if (this.diskViolation !== undefined) throw this.diskViolation;
          },
        };
      },
      cleanup: async () => {
        this.cleanupCalls += 1;
        if (this.cleanupError !== undefined) {
          throw this.cleanupError;
        }
      },
    };
  }
}

const exitEvent = (overrides: Partial<ProcessExitedEvent> = {}): ProcessExitedEvent => ({
  protocolVersion: "1.0",
  type: "exited",
  requestId: "process-1",
  exitCode: 0,
  signal: null,
  outputTruncated: false,
  ...overrides,
});

class FakeProcessHost implements ProcessHostClient {
  public stdout: Readable = Readable.from([successfulJsonl()]);
  public stderr: Readable = Readable.from(["discarded diagnostic"]);
  public completion: Promise<ProcessExitedEvent> = Promise.resolve(exitEvent());
  public startError: unknown;
  public onStart: (() => void) | undefined;
  public seenSpec: ProcessLaunchSpec | undefined;
  public seenSignal: AbortSignal | undefined;
  public startCalls = 0;

  public async start(spec: ProcessLaunchSpec, signal?: AbortSignal): Promise<ManagedProcess> {
    this.startCalls += 1;
    this.seenSpec = spec;
    this.seenSignal = signal;
    this.onStart?.();
    if (this.startError !== undefined) {
      throw this.startError;
    }
    return {
      requestId: "process-1",
      processId: 42,
      stdout: this.stdout,
      stderr: this.stderr,
      completed: this.completion,
      terminate: async () => undefined,
    };
  }

  public async terminateAll(): Promise<void> {}
  public async close(): Promise<void> {}
}

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
});

const createOptions = (
  workspaceProvider: JobWorkspaceProvider,
  fileIO: ReviewFileIO,
  overrides: Partial<ReviewJobExecutorOptions> = {},
): ReviewJobExecutorOptions => ({
  workspaceProvider,
  codexExecutablePath: "C:\\Tools\\Codex\\codex.exe",
  systemRoot: "C:\\Windows",
  comSpec: "C:\\Windows\\System32\\cmd.exe",
  path: "C:\\Windows\\System32;C:\\Tools",
  pathExt: ".COM;.EXE;.BAT;.CMD",
  maximumHardTimeoutMs: 1_200_000,
  maximumProcessCount: 64,
  maximumMemoryBytes: 8_589_934_592,
  maximumOutputBytes: 67_108_864,
  fileIO,
  logger,
  ...overrides,
});

const execute = async (
  envelope: JobExecutionEnvelope,
  result: unknown | undefined,
  options: {
    readonly fileIO?: FakeFileIO;
    readonly workspace?: FakeWorkspaceProvider;
    readonly processHost?: FakeProcessHost;
    readonly signal?: AbortSignal;
  } = {},
) => {
  const fileIO = options.fileIO ?? new FakeFileIO();
  const workspace = options.workspace ?? new FakeWorkspaceProvider();
  const processHost = options.processHost ?? new FakeProcessHost();
  if (result !== undefined) {
    processHost.onStart = () => fileIO.put(paths.result, JSON.stringify(result));
  }
  const progress: ExecutionProgress[] = [];
  const nodeHealthFaults: Error[] = [];
  const deferredCleanups: Array<() => Promise<void>> = [];
  const executor = new ReviewJobExecutor(createOptions(workspace, fileIO));
  const execution = executor.execute(envelope, {
    signal: options.signal ?? new AbortController().signal,
    processHost,
    reportProgress: (update) => progress.push(update),
    reportNodeHealthFault: (error) => nodeHealthFaults.push(error),
    deferCleanup: (cleanup) => deferredCleanups.push(cleanup),
  });
  return {
    execution,
    fileIO,
    workspace,
    processHost,
    progress,
    nodeHealthFaults,
    deferredCleanups,
  };
};

describe("buildReviewCodexConfig", () => {
  it("builds a fixed workspace execution posture with a safely escaped project path", () => {
    const config = buildReviewCodexConfig("c:/AgenticReview/attempt-1/checkout");

    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).toContain('project_doc_fallback_filenames = ["AGENTS.md"]');
    expect(config).toContain('[shell_environment_policy]\ninherit = "none"');
    expect(config).toContain("ignore_default_excludes = false");
    expect(config).toContain("[sandbox_workspace_write]\nnetwork_access = true");
    expect(config).toContain('sandbox = "elevated"');
    expect(config).toContain('web_search = "disabled"');
    expect(config).toContain('persistence = "none"');
    expect(config).toContain('cli_auth_credentials_store = "keyring"');
    expect(config).toContain('[projects."C:\\\\AgenticReview\\\\attempt-1\\\\checkout"]');
    expect(config).toContain('trust_level = "trusted"');
    expect(config).toContain("apps = false");
    expect(config).toContain("hooks = false");
    expect(config).toContain("memories = false");
    expect(config).toContain("multi_agent = false");
    expect(config).toContain("remote_plugin = false");
    expect(config).toContain("skill_mcp_dependency_install = false");
    expect(config).toContain("view_image = false");
    expect(config).not.toContain("strict-config");
  });

  it.each(["relative\\checkout", "C:\\review\\..\\checkout", "C:\\review\ncheckout"])(
    "rejects unsafe TOML project path %j",
    (path) => expect(() => buildReviewCodexConfig(path)).toThrow(TypeError),
  );
});

describe("ReviewJobExecutor success", () => {
  it("executes a PR review through ProcessHost and writes isolated control files", async () => {
    const result = validPrResult();
    const run = await execute(createEnvelope("pull_request_review"), result);

    await expect(run.execution).resolves.toMatchObject({ outcome: "succeeded", result });
    expect(run.processHost.seenSpec).toMatchObject({
      executable: "C:\\Tools\\Codex\\codex.exe",
      workingDirectory: paths.control,
      environmentMode: "replace",
      environment: {
        CODEX_HOME: paths.codexHome,
        TEMP: paths.temp,
        TMP: paths.temp,
        USERPROFILE: paths.userProfile,
      },
      limits: { hardTimeoutMs: 600_000 },
    });
    expect(run.processHost.seenSpec?.arguments).toContain("--ephemeral");
    expect(run.processHost.seenSpec?.arguments).toEqual(
      expect.arrayContaining(["--cd", paths.checkout]),
    );
    expect(run.workspace.diskMonitorCalls).toBe(1);
    expect(run.workspace.diskMonitorCloseCalls).toBe(1);
    expect(run.processHost.seenSignal).toBe(run.workspace.diskMonitorController.signal);
    expect(run.fileIO.readText(paths.schema)).toBe(createCanonicalResult(prSchema.value).json);
    expect(run.fileIO.readText(paths.config)).toContain('trust_level = "trusted"');
    expect(run.workspace.cleanupCalls).toBe(0);
    expect(run.deferredCleanups).toHaveLength(1);
    await Promise.all([run.deferredCleanups[0]?.(), run.deferredCleanups[0]?.()]);
    expect(run.workspace.cleanupCalls).toBe(1);
    expect(run.deferredCleanups).toHaveLength(1);
    expect(run.progress).toEqual(
      expect.arrayContaining([
        { phase: "preparing", processCount: 0 },
        { phase: "codex_review", processCount: 0 },
        { phase: "codex_review", processCount: 1 },
      ]),
    );
    expect(run.progress.at(-1)).toEqual({ phase: "codex_review", processCount: 0 });
  });

  it("selects the authoritative issue schema for issue triage", async () => {
    const result = validIssueResult();
    const run = await execute(createEnvelope("issue_triage"), result);

    await expect(run.execution).resolves.toMatchObject({ outcome: "succeeded", result });
    expect(run.fileIO.readText(paths.schema)).toBe(createCanonicalResult(issueSchema.value).json);
  });

  it("accepts a PR finding with an explicit null end line", async () => {
    const result = {
      ...validPrResult(),
      findings: [{ ...validPrFinding(), endLine: null }],
    };
    const run = await execute(createEnvelope("pull_request_review"), result);

    await expect(run.execution).resolves.toMatchObject({ outcome: "succeeded", result });
  });
});

describe("ReviewJobExecutor trust validation", () => {
  it("fails closed before workspace creation when cleanup registration is unavailable", async () => {
    const fileIO = new FakeFileIO();
    const workspace = new FakeWorkspaceProvider();
    const executor = new ReviewJobExecutor(createOptions(workspace, fileIO));

    await expect(
      executor.execute(createEnvelope("issue_triage"), {
        signal: new AbortController().signal,
        processHost: new FakeProcessHost(),
        reportProgress: () => undefined,
        reportNodeHealthFault: () => undefined,
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      code: "CLEANUP_REGISTRATION_UNAVAILABLE",
      retryable: false,
    });
    expect(workspace.prepareCalls).toBe(0);
  });

  it.each([
    {
      name: "job/resource mismatch",
      mutate: (envelope: JobExecutionEnvelope) => ({
        ...envelope,
        resource: createEnvelope("issue_triage").resource,
      }),
    },
    {
      name: "prompt digest mismatch",
      mutate: (envelope: JobExecutionEnvelope) => ({
        ...envelope,
        prompt: { ...envelope.prompt, promptSha256: "0".repeat(64) },
      }),
    },
    {
      name: "schema digest mismatch",
      mutate: (envelope: JobExecutionEnvelope) => ({
        ...envelope,
        prompt: { ...envelope.prompt, outputSchemaSha256: "0".repeat(64) },
      }),
    },
    {
      name: "non-authoritative schema",
      mutate: (envelope: JobExecutionEnvelope) => ({
        ...envelope,
        prompt: {
          ...envelope.prompt,
          outputSchema: issueSchema.value,
          outputSchemaSha256: issueSchema.digest,
        },
      }),
    },
    {
      name: "application validation schema used as the model schema",
      mutate: (envelope: JobExecutionEnvelope) => ({
        ...envelope,
        prompt: {
          ...envelope.prompt,
          outputSchema: prApplicationSchema.value,
          outputSchemaSha256: prApplicationSchema.digest,
        },
      }),
    },
  ])("rejects $name before workspace preparation", async ({ mutate }) => {
    const envelope = mutate(createEnvelope("pull_request_review")) as JobExecutionEnvelope;
    const run = await execute(envelope, validPrResult());

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "JOB_CONTRACT_INVALID",
      retryable: false,
    });
    expect(run.workspace.prepareCalls).toBe(0);
    expect(run.processHost.startCalls).toBe(0);
  });

  it.each([
    ["INVALID_CONFIGURATION", true],
    ["INVALID_ENVELOPE", false],
    ["WORKSPACE_ROOT_UNSAFE", true],
    ["WORKSPACE_PATH_UNSAFE", true],
    ["ATTEMPT_ALREADY_EXISTS", true],
    ["WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED", false],
    ["GIT_REVISION_MISMATCH", false],
    ["GIT_LOCAL_OR_REVISION_FAILED", false],
    ["GIT_POLICY_LIMIT_EXCEEDED", false],
    ["GIT_SHARED_CACHE_LIMIT_EXCEEDED", true],
    ["WORKSPACE_CREATE_FAILED", true],
    ["GIT_COMMAND_FAILED", true],
    ["WORKSPACE_CLEANUP_FAILED", true],
  ] as const)("classifies workspace %s retryability", async (code, retryable) => {
    const workspace = new FakeWorkspaceProvider();
    workspace.prepareError = new JobWorkspaceError(code, "untrusted detail");
    const run = await execute(createEnvelope("issue_triage"), validIssueResult(), { workspace });

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: `WORKSPACE_${code}`,
      retryable,
    });
  });
});

describe("ReviewJobExecutor process and result handling", () => {
  it("reports trusted control-file I/O failure as a node health fault", async () => {
    const fileIO = new FakeFileIO();
    fileIO.writeError = fileSystemError("EIO");
    const run = await execute(createEnvelope("issue_triage"), undefined, { fileIO });

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "CONTROL_FILE_WRITE_FAILED",
    });
    expect(run.nodeHealthFaults).toHaveLength(1);
    expect(run.processHost.startCalls).toBe(0);
  });

  it("reports ProcessHost start and stream/control failures but not a hard timeout", async () => {
    const startHost = new FakeProcessHost();
    startHost.startError = new Error("control channel unavailable");
    const startRun = await execute(createEnvelope("issue_triage"), undefined, {
      processHost: startHost,
    });
    await expect(startRun.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "CODEX_PROCESS_START_FAILED",
    });
    expect(startRun.nodeHealthFaults).toHaveLength(1);

    const streamHost = new FakeProcessHost();
    streamHost.stdout = new Readable({
      read() {
        this.destroy(new Error("ProcessHost stdout failed"));
      },
    });
    const streamRun = await execute(createEnvelope("issue_triage"), undefined, {
      processHost: streamHost,
    });
    await expect(streamRun.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "CODEX_STREAM_FAILED",
    });
    expect(streamRun.nodeHealthFaults).toHaveLength(1);

    const timeoutHost = new FakeProcessHost();
    timeoutHost.completion = Promise.reject(
      new ProcessHostRequestError("PROCESS_HARD_TIMEOUT", "hard timeout"),
    );
    const timeoutRun = await execute(createEnvelope("issue_triage"), undefined, {
      processHost: timeoutHost,
    });
    await expect(timeoutRun.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "CODEX_PROCESS_FAILED",
    });
    expect(timeoutRun.nodeHealthFaults).toEqual([]);
  });

  it.each([
    {
      code: "CURRENT_ATTEMPT_LIMIT_EXCEEDED" as const,
      expectedCode: "WORKSPACE_DISK_ATTEMPT_LIMIT_EXCEEDED",
      retryable: false,
      drain: false,
    },
    {
      code: "INSUFFICIENT_FREE_SPACE" as const,
      expectedCode: "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE",
      retryable: true,
      drain: true,
    },
    {
      code: "EXISTING_WORKSPACE_UNHEALTHY" as const,
      expectedCode: "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE",
      retryable: true,
      drain: true,
    },
    {
      code: "WORKSPACE_PATH_UNSAFE" as const,
      expectedCode: "WORKSPACE_DISK_INFRASTRUCTURE_UNAVAILABLE",
      retryable: true,
      drain: true,
    },
  ])(
    "classifies Codex disk monitor failure $code before accepting its result",
    async ({ code, expectedCode, retryable, drain }) => {
      const workspace = new FakeWorkspaceProvider();
      workspace.diskViolation = new WorkspaceDiskBudgetError(code, "injected disk failure");
      const run = await execute(createEnvelope("issue_triage"), validIssueResult(), { workspace });

      await expect(run.execution).resolves.toMatchObject({
        outcome: "failed",
        code: expectedCode,
        retryable,
      });
      expect(run.fileIO.readText(paths.result)).toBe(JSON.stringify(validIssueResult()));
      expect(run.workspace.diskMonitorCalls).toBe(1);
      expect(run.nodeHealthFaults).toHaveLength(drain ? 1 : 0);
    },
  );

  it.each([
    {
      name: "invalid JSONL",
      configure: (host: FakeProcessHost) => {
        host.stdout = Readable.from(["not-json\n"]);
      },
      result: validIssueResult(),
      rawResult: false,
      code: "CODEX_INVALID_EVENT_STREAM",
    },
    {
      name: "non-zero exit",
      configure: (host: FakeProcessHost) => {
        host.completion = Promise.resolve(exitEvent({ exitCode: 2 }));
      },
      result: undefined,
      rawResult: false,
      code: "CODEX_NON_ZERO_EXIT",
    },
    {
      name: "missing result file",
      configure: (_host: FakeProcessHost) => undefined,
      result: undefined,
      rawResult: false,
      code: "CODEX_MISSING_RESULT",
    },
    {
      name: "invalid result JSON",
      configure: (_host: FakeProcessHost) => undefined,
      result: "not-json",
      rawResult: true,
      code: "CODEX_INVALID_RESULT_JSON",
    },
  ])("returns a stable failure for $name", async ({ configure, result, rawResult, code }) => {
    const fileIO = new FakeFileIO();
    const processHost = new FakeProcessHost();
    configure(processHost);
    if (result !== undefined) {
      processHost.onStart = () =>
        fileIO.put(paths.result, rawResult === true ? String(result) : JSON.stringify(result));
    }
    const run = await execute(createEnvelope("issue_triage"), undefined, {
      fileIO,
      processHost,
    });

    await expect(run.execution).resolves.toMatchObject({ outcome: "failed", code });
    expect(run.workspace.cleanupCalls).toBe(0);
    expect(run.deferredCleanups).toHaveLength(1);
  });

  it.each([
    { name: "symbolic link", options: { symbolicLink: true } },
    { name: "non-regular file", options: { file: false } },
    { name: "changed file", options: { changeDuringRead: true } },
    { name: "escaping realpath", options: { realPath: "C:\\Outside\\result.json" } },
  ])("rejects a $name result", async ({ options }) => {
    const fileIO = new FakeFileIO();
    const processHost = new FakeProcessHost();
    processHost.onStart = () =>
      fileIO.put(paths.result, JSON.stringify(validIssueResult()), options);
    const run = await execute(createEnvelope("issue_triage"), undefined, {
      fileIO,
      processHost,
    });

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "RESULT_FILE_INVALID",
      retryable: false,
    });
  });

  it.each(["open", "read", "close"] as const)(
    "classifies result-file %s I/O errors as retryable",
    async (operation) => {
      const fileIO = new FakeFileIO();
      const error = fileSystemError(operation === "open" ? "EBUSY" : "EIO");
      if (operation === "open") fileIO.openReadError = error;
      if (operation === "read") fileIO.readError = error;
      if (operation === "close") fileIO.closeError = error;
      const run = await execute(createEnvelope("issue_triage"), validIssueResult(), { fileIO });

      await expect(run.execution).resolves.toMatchObject({
        outcome: "failed",
        code: "RESULT_FILE_READ_FAILED",
        retryable: true,
      });
    },
  );

  it("rejects a PR finding that omits the required nullable end line", async () => {
    const findingWithoutEndLine: Record<string, unknown> = { ...validPrFinding() };
    delete findingWithoutEndLine.endLine;
    const result = { ...validPrResult(), findings: [findingWithoutEndLine] };
    const run = await execute(createEnvelope("pull_request_review"), result);

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "CODEX_INVALID_RESULT_SCHEMA",
      retryable: false,
    });
  });

  it("does not launch Codex when result.json already exists", async () => {
    const fileIO = new FakeFileIO();
    fileIO.put(paths.result, JSON.stringify(validIssueResult()));
    const run = await execute(createEnvelope("issue_triage"), undefined, { fileIO });

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "RESULT_FILE_PREEXISTS",
    });
    expect(run.processHost.startCalls).toBe(0);
  });

  it("bounds retained JSONL records while continuing to drain stdout", async () => {
    const processHost = new FakeProcessHost();
    const lines = Array.from({ length: 4_097 }, (_, index) =>
      JSON.stringify({ type: "future.event", index }),
    );
    processHost.stdout = Readable.from([`${lines.join("\n")}\n`]);
    const run = await execute(createEnvelope("issue_triage"), validIssueResult(), {
      processHost,
    });

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "CODEX_EVENT_LIMIT_EXCEEDED",
    });
  });

  it("starts stdout and stderr drains concurrently and waits for both", async () => {
    let stdoutStarted = false;
    let stderrStarted = false;
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const maybeRelease = (): void => {
      if (stdoutStarted && stderrStarted) release?.();
    };
    const processHost = new FakeProcessHost();
    processHost.stdout = Readable.from(
      (async function* () {
        stdoutStarted = true;
        maybeRelease();
        await bothStarted;
        yield successfulJsonl();
      })(),
    );
    processHost.stderr = Readable.from(
      (async function* () {
        stderrStarted = true;
        maybeRelease();
        await bothStarted;
        yield "discarded";
      })(),
    );
    const run = await execute(createEnvelope("issue_triage"), validIssueResult(), {
      processHost,
    });

    await expect(run.execution).resolves.toMatchObject({ outcome: "succeeded" });
    expect(stdoutStarted).toBe(true);
    expect(stderrStarted).toBe(true);
  });

  it("reports progress only on throttled stdout and stderr activity", async () => {
    vi.useFakeTimers();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveCompletion!: (event: ProcessExitedEvent) => void;
    const processHost = new FakeProcessHost();
    processHost.stdout = stdout;
    processHost.stderr = stderr;
    processHost.completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const run = await execute(createEnvelope("issue_triage"), validIssueResult(), {
      processHost,
    });
    await waitFor(() => processHost.startCalls === 1);
    const activeReports = (): number =>
      run.progress.filter((entry) => entry.phase === "codex_review" && entry.processCount === 1)
        .length;
    expect(activeReports()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(activeReports()).toBe(1);

    stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n`);
    await flushAsyncWork();
    expect(activeReports()).toBe(2);
    stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
    await flushAsyncWork();
    expect(activeReports()).toBe(2);

    stderr.write("discarded diagnostic\n");
    await flushAsyncWork();
    expect(activeReports()).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    stderr.write("later diagnostic\n");
    await flushAsyncWork();
    expect(activeReports()).toBe(3);
    stdout.end(`${JSON.stringify({ type: "turn.completed" })}\n`);
    stderr.end();
    resolveCompletion(exitEvent());
    await expect(run.execution).resolves.toMatchObject({ outcome: "succeeded" });

    const reportsAfterCompletion = activeReports();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(activeReports()).toBe(reportsAfterCompletion);
    expect(run.progress.at(-1)).toEqual({ phase: "codex_review", processCount: 0 });
  });
});

describe("ReviewJobExecutor business validation", () => {
  it.each([
    {
      name: "duplicate finding IDs",
      mutate: (result: ReturnType<typeof validPrResult>) => ({
        ...result,
        findings: [validPrFinding(), validPrFinding()],
      }),
    },
    {
      name: "reversed line range",
      mutate: (result: ReturnType<typeof validPrResult>) => ({
        ...result,
        findings: [{ ...validPrFinding(), line: 12, endLine: 10 }],
      }),
    },
    {
      name: "non-normalized path",
      mutate: (result: ReturnType<typeof validPrResult>) => ({
        ...result,
        findings: [{ ...validPrFinding(), path: "src//module/file.ts" }],
      }),
    },
    {
      name: "recipe outside allowlist",
      mutate: (result: ReturnType<typeof validPrResult>) => ({
        ...result,
        requestedRecipeIds: ["unapproved.recipe"],
      }),
    },
  ])("rejects $name after schema validation", async ({ mutate }) => {
    const run = await execute(createEnvelope("pull_request_review"), mutate(validPrResult()));

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "RESULT_BUSINESS_VALIDATION_FAILED",
      retryable: false,
    });
  });
});

describe("ReviewJobExecutor abort and cleanup", () => {
  it("rethrows the AbortSignal reason without converting it to a job failure", async () => {
    const controller = new AbortController();
    const abortReason = new Error("lease lost");
    const workspace = new FakeWorkspaceProvider();
    const processHost = new FakeProcessHost();
    processHost.onStart = () => controller.abort(abortReason);
    processHost.startError = abortReason;
    const run = await execute(createEnvelope("issue_triage"), undefined, {
      workspace,
      processHost,
      signal: controller.signal,
    });

    await expect(run.execution).rejects.toBe(abortReason);
    expect(workspace.cleanupCalls).toBe(0);
    expect(run.deferredCleanups).toHaveLength(1);
    await run.deferredCleanups[0]?.();
    expect(workspace.cleanupCalls).toBe(1);
  });

  it("returns before cleanup and exposes one idempotent deferred cleanup hook", async () => {
    const workspace = new FakeWorkspaceProvider();
    workspace.cleanupError = new Error("locked path");
    const run = await execute(createEnvelope("issue_triage"), validIssueResult(), { workspace });

    await expect(run.execution).resolves.toMatchObject({ outcome: "succeeded" });
    expect(workspace.cleanupCalls).toBe(0);
    expect(run.deferredCleanups).toHaveLength(1);
    const cleanup = run.deferredCleanups[0];
    if (cleanup === undefined) throw new Error("Expected deferred cleanup.");
    const first = cleanup();
    const second = cleanup();
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("locked path");
    await expect(second).rejects.toThrow("locked path");
    expect(workspace.cleanupCalls).toBe(1);
  });

  it("preserves a primary failure while leaving cleanup to the deferred hook", async () => {
    const workspace = new FakeWorkspaceProvider();
    workspace.cleanupError = new Error("locked path");
    const fileIO = new FakeFileIO();
    const processHost = new FakeProcessHost();
    processHost.onStart = () => fileIO.put(paths.result, "not-json");
    const run = await execute(createEnvelope("issue_triage"), undefined, {
      workspace,
      fileIO,
      processHost,
    });

    await expect(run.execution).resolves.toMatchObject({
      outcome: "failed",
      code: "CODEX_INVALID_RESULT_JSON",
    });
    expect(workspace.cleanupCalls).toBe(0);
    const cleanup = run.deferredCleanups[0];
    if (cleanup === undefined) throw new Error("Expected deferred cleanup.");
    await expect(cleanup()).rejects.toThrow("locked path");
    expect(workspace.cleanupCalls).toBe(1);
  });
});

function fileSystemError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function flushAsyncWork(): Promise<void> {
  vi.runAllTicks();
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await flushAsyncWork();
  }
  throw new Error("Timed out waiting for asynchronous work.");
}
