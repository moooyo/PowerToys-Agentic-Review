import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { SecureContext, SecureContextOptions } from "node:tls";
import { inspect } from "node:util";
import type { RunCompletionSubmission, WorkerRegistrationRequest } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { ProtocolError, WorkerApiError } from "./errors.js";
import { HttpWorkerApi } from "./http-worker-api.js";

const serverTime = "2026-08-31T00:00:00.000Z";
const workerToken = `arw1_${"A".repeat(43)}`;

describe("HttpWorkerApi transport and authentication", () => {
  it("creates one Server-only secure context and reuses it with Bearer authentication", async () => {
    const secureContext = {} as SecureContext;
    const contextOptions: SecureContextOptions[] = [];
    const requestOptions: RequestOptions[] = [];
    const createContext = vi.fn((options: SecureContextOptions) => {
      contextOptions.push(options);
      return secureContext;
    });
    const httpsRequest = vi.fn(
      (
        _url: URL,
        options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ): ClientRequest => {
        requestOptions.push(options);
        return new StubClientRequest(callback, registrationResponse()) as unknown as ClientRequest;
      },
    );
    const config = createHttpsConfig();
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: createContext,
      httpsRequest,
    });

    await api.register(registrationRequest(config));
    await api.register(registrationRequest(config));

    expect(createContext).toHaveBeenCalledOnce();
    expect(contextOptions).toEqual([{ ca: config.tls?.ca }]);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    for (const options of requestOptions) {
      expect((options as RequestOptions & { secureContext?: SecureContext }).secureContext).toBe(
        secureContext,
      );
      expect(options.servername).toBe("worker-api.internal");
      expect(options.rejectUnauthorized).toBe(true);
      expect(options.headers).toMatchObject({ authorization: `Bearer ${workerToken}` });
      expect(options).not.toHaveProperty("ca");
      expect(options).not.toHaveProperty("cert");
      expect(options).not.toHaveProperty("key");
      expect(options).not.toHaveProperty("pfx");
      expect(options).not.toHaveProperty("passphrase");
    }
  });

  it("propagates TLS preflight failures synchronously without logging or requesting", () => {
    const logs: string[] = [];
    const logger = capturingLogger(logs);
    const preflightError = new Error("TLS Server trust material is invalid.");
    const createContext = vi.fn(() => {
      throw preflightError;
    });
    const httpsRequest = vi.fn(
      (
        _url: URL,
        _options: RequestOptions,
        _callback: (response: IncomingMessage) => void,
      ): ClientRequest => {
        throw new Error("Network request was not expected.");
      },
    );

    expect(
      () =>
        new HttpWorkerApi(createHttpsConfig(), logger, {
          createSecureContext: createContext,
          httpsRequest,
        }),
    ).toThrow(preflightError);
    expect(createContext).toHaveBeenCalledOnce();
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("keeps Bearer authentication enabled on explicit development HTTP", async () => {
    const { tls: _tls, ...httpsConfig } = createHttpsConfig();
    const config: WorkerConfig = {
      ...httpsConfig,
      serverUrl: new URL("http://127.0.0.1:8080"),
      allowInsecureHttp: true,
    };
    const requestOptions: RequestOptions[] = [];
    const api = new HttpWorkerApi(config, silentLogger(), {
      httpRequest: (_url, options, callback) => {
        requestOptions.push(options);
        return new StubClientRequest(callback, registrationResponse()) as unknown as ClientRequest;
      },
    });

    await api.register(registrationRequest(config));

    expect(requestOptions).toHaveLength(1);
    expect(requestOptions[0]?.headers).toMatchObject({
      authorization: `Bearer ${workerToken}`,
    });
  });

  it("never includes the Worker Token in request logs", async () => {
    const logEntries: unknown[] = [];
    const logger: Logger = {
      debug: (message, fields) => logEntries.push({ level: "debug", message, fields }),
      info: (message, fields) => logEntries.push({ level: "info", message, fields }),
      warn: (message, fields) => logEntries.push({ level: "warn", message, fields }),
      error: (message, fields) => logEntries.push({ level: "error", message, fields }),
    };
    const config = createHttpsConfig();
    const api = new HttpWorkerApi(config, logger, {
      createSecureContext: () => ({}) as SecureContext,
      httpsRequest: (_url, _options, callback) =>
        new StubClientRequest(callback, registrationResponse()) as unknown as ClientRequest,
    });

    await api.register(registrationRequest(config));

    expect(logEntries).toEqual([
      {
        level: "debug",
        message: "Worker API request started.",
        fields: { method: "POST", path: "/api/v1/worker/instances" },
      },
    ]);
    expect(JSON.stringify(logEntries)).not.toContain(workerToken);
  });

  it.each([
    ["a direct Token", { ...registrationResponse(), workerId: workerToken }, false],
    [
      "a JSON-escaped Token",
      `{"protocolVersion":"1.0","workerId":"${jsonUnicodeEscape(workerToken)}","state":"online","heartbeatIntervalMs":5000,"leaseTtlMs":30000,"serverTime":"${serverTime}"}`,
      true,
    ],
  ])("rejects registration responses that reflect %s", async (_scenario, responseBody, rawJson) => {
    const config = createHttpsConfig();
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => ({}) as SecureContext,
      httpsRequest: (_url, _options, callback) =>
        new StubClientRequest(
          callback,
          responseBody,
          "complete",
          200,
          rawJson,
        ) as unknown as ClientRequest,
    });

    const failure = await rejectionOf(api.register(registrationRequest(config)));

    expect(failure).toBeInstanceOf(ProtocolError);
    expect(failure).toMatchObject({
      message: "Worker API response contained confidential authentication data.",
    });
    expect(inspect(failure, { depth: 5, showHidden: true })).not.toContain(workerToken);
    expect(JSON.stringify(failure)).not.toContain(workerToken);
  });

  it("recursively rejects a reflected Token before interpreting an HTTP error", async () => {
    const config = createHttpsConfig();
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => ({}) as SecureContext,
      httpsRequest: (_url, _options, callback) =>
        new StubClientRequest(
          callback,
          { error: { details: { echoed: `prefix-${workerToken}-suffix` } } },
          "complete",
          503,
        ) as unknown as ClientRequest,
    });

    await expect(api.register(registrationRequest(config))).rejects.toMatchObject({
      name: "ProtocolError",
      message: "Worker API response contained confidential authentication data.",
    });
  });

  it("adds the same Bearer Token to every Worker API operation", async () => {
    const config = createHttpsConfig();
    const requestOptions: RequestOptions[] = [];
    const completion = completionSubmission(config);
    const failure = {
      jobId: "job-failure",
      runAttemptId: "run-failure",
      workerNodeId: config.workerNodeId,
      workerInstanceId: "worker-instance",
      leaseToken: "f".repeat(32),
      leaseGeneration: 1,
      code: "test_failure",
      message: "The test run failed.",
      retryable: false,
    };
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => ({}) as SecureContext,
      httpsRequest: (url, options, callback) => {
        requestOptions.push(options);
        const responseBody =
          url.pathname === "/api/v1/worker/instances"
            ? registrationResponse()
            : url.pathname === "/api/v1/worker/leases/claim"
              ? { outcome: "no_work", serverTime }
              : url.pathname.endsWith("/heartbeat")
                ? {
                    serverTime,
                    nextHeartbeatInMs: 5_000,
                    workerState: "online",
                    commands: [],
                  }
                : url.pathname.endsWith("/complete")
                  ? {
                      jobId: completion.jobId,
                      runAttemptId: completion.runAttemptId,
                      jobState: "succeeded",
                      runState: "succeeded",
                    }
                  : {
                      jobId: failure.jobId,
                      runAttemptId: failure.runAttemptId,
                      jobState: "failed",
                      runState: "failed",
                    };
        return new StubClientRequest(callback, responseBody) as unknown as ClientRequest;
      },
    });

    await api.register(registrationRequest(config));
    await api.claimLease({
      protocolVersion: config.protocolVersion,
      workerNodeId: config.workerNodeId,
      workerInstanceId: "worker-instance",
      availableSlots: 1,
      waitSeconds: 0,
      capabilitiesDigest: "f".repeat(64),
    });
    await api.heartbeat("worker-instance", {
      protocolVersion: config.protocolVersion,
      workerNodeId: config.workerNodeId,
      workerInstanceId: "worker-instance",
      heartbeatSequence: 1,
      observedAt: serverTime,
      availableSlots: 1,
      activeLeases: [],
      health: {
        state: "online",
        freeDiskBytes: 1,
        memoryUsageBytes: 1,
      },
    });
    await api.completeRun(completion.runAttemptId, completion);
    await api.failRun(failure.runAttemptId, failure);

    expect(requestOptions).toHaveLength(5);
    for (const options of requestOptions) {
      expect(options.headers).toMatchObject({ authorization: `Bearer ${workerToken}` });
    }
  });

  it("accepts a bounded claim envelope larger than the completion-result limit", async () => {
    const secureContext = {} as SecureContext;
    const config = createHttpsConfig();
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => secureContext,
      httpsRequest: (
        _url: URL,
        _options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ) => new StubClientRequest(callback, largeClaimResponse(config)) as unknown as ClientRequest,
    });

    const response = await api.claimLease({
      protocolVersion: "1.0",
      workerNodeId: config.workerNodeId,
      workerInstanceId: "worker-instance",
      availableSlots: 1,
      waitSeconds: 0,
      capabilitiesDigest: "f".repeat(64),
    });

    expect(response.outcome).toBe("granted");
    if (response.outcome === "granted") {
      expect(JSON.stringify(response).length).toBeGreaterThan(2 * 1024 * 1024);
    }
  });

  it.each(["aborted", "error", "closed"] as const)(
    "rejects when a response is %s before end",
    async (responseOutcome) => {
      const secureContext = {} as SecureContext;
      const config = createHttpsConfig();
      const api = new HttpWorkerApi(config, silentLogger(), {
        createSecureContext: () => secureContext,
        httpsRequest: (
          _url: URL,
          _options: RequestOptions,
          callback: (response: IncomingMessage) => void,
        ) =>
          new StubClientRequest(
            callback,
            registrationResponse(),
            responseOutcome,
          ) as unknown as ClientRequest,
      });

      await expect(api.register(registrationRequest(config))).rejects.toThrow(
        /response (?:was aborted|failed|closed) before completion/u,
      );
    },
  );

  it("returns an identity-bound terminal response", async () => {
    const secureContext = {} as SecureContext;
    const config = createHttpsConfig();
    const submission = completionSubmission(config);
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => secureContext,
      httpsRequest: (
        _url: URL,
        _options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ) =>
        new StubClientRequest(callback, {
          jobId: submission.jobId,
          runAttemptId: submission.runAttemptId,
          jobState: "succeeded",
          runState: "succeeded",
        }) as unknown as ClientRequest,
    });

    await expect(api.completeRun(submission.runAttemptId, submission)).resolves.toEqual({
      jobId: submission.jobId,
      runAttemptId: submission.runAttemptId,
      jobState: "succeeded",
      runState: "succeeded",
    });
    await expect(api.completeRun("another-run", submission)).rejects.toThrow(
      /route and body attempt identities/u,
    );
  });

  it("rejects a terminal response for another run", async () => {
    const secureContext = {} as SecureContext;
    const config = createHttpsConfig();
    const submission = completionSubmission(config);
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => secureContext,
      httpsRequest: (
        _url: URL,
        _options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ) =>
        new StubClientRequest(callback, {
          jobId: submission.jobId,
          runAttemptId: "another-run",
          jobState: "succeeded",
          runState: "succeeded",
        }) as unknown as ClientRequest,
    });

    await expect(api.completeRun(submission.runAttemptId, submission)).rejects.toThrow(
      /terminal response for another run/u,
    );
  });

  it.each([
    [503, false],
    [400, true],
  ] as const)(
    "honors an exact Server ErrorDetails retryable flag for HTTP %i",
    async (statusCode, retryable) => {
      const config = createHttpsConfig();
      const api = new HttpWorkerApi(config, silentLogger(), {
        createSecureContext: () => ({}) as SecureContext,
        httpsRequest: (_url, _options, callback) =>
          new StubClientRequest(
            callback,
            { code: "remote_failure", message: "The remote operation failed.", retryable },
            "complete",
            statusCode,
          ) as unknown as ClientRequest,
      });

      const failure = await rejectionOf(api.register(registrationRequest(config)));

      expect(failure).toBeInstanceOf(WorkerApiError);
      expect(failure).toMatchObject({
        statusCode,
        errorCode: "remote_failure",
        message: `Worker API returned HTTP ${statusCode}.`,
        isRetryable: retryable,
      });
    },
  );

  it("falls back to HTTP status when the response is not an exact ErrorDetails", async () => {
    const config = createHttpsConfig();
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => ({}) as SecureContext,
      httpsRequest: (_url, _options, callback) =>
        new StubClientRequest(
          callback,
          {
            code: "remote_failure",
            message: "The remote operation failed.",
            retryable: false,
            unexpected: true,
          },
          "complete",
          503,
        ) as unknown as ClientRequest,
    });

    await expect(api.register(registrationRequest(config))).rejects.toMatchObject({
      statusCode: 503,
      errorCode: undefined,
      message: "Worker API returned HTTP 503.",
      isRetryable: true,
    });
  });

  it("does not attach the HTTP response body, lease token, or a remote cause", async () => {
    const config = createHttpsConfig();
    const leaseToken = "secret-lease-token";
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => ({}) as SecureContext,
      httpsRequest: (_url, _options, callback) =>
        new StubClientRequest(
          callback,
          {
            error: {
              code: "server_integrity_failure",
              message: "Server integrity validation failed.",
              retryable: false,
            },
            requestBody: { leaseToken },
            cause: { message: leaseToken },
          },
          "complete",
          503,
        ) as unknown as ClientRequest,
    });

    const failure = await rejectionOf(api.register(registrationRequest(config)));

    expect(failure).toMatchObject({
      statusCode: 503,
      errorCode: "server_integrity_failure",
      isRetryable: false,
    });
    expect(failure).not.toHaveProperty("body");
    expect(failure).not.toHaveProperty("requestBody");
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain(leaseToken);
  });

  it("drops invalid JSON parser causes that can echo remote response bytes", async () => {
    const config = createHttpsConfig();
    const leaseToken = "a".repeat(32);
    const api = new HttpWorkerApi(config, silentLogger(), {
      createSecureContext: () => ({}) as SecureContext,
      httpsRequest: (_url, _options, callback) =>
        new StubClientRequest(
          callback,
          `{"leaseToken":"${leaseToken}`,
          "complete",
          503,
          true,
        ) as unknown as ClientRequest,
    });

    const failure = await rejectionOf(api.register(registrationRequest(config)));

    expect(failure).toMatchObject({ message: "Worker API returned invalid JSON." });
    expect(failure).not.toHaveProperty("cause");
    expect(inspect(failure, { depth: 5, showHidden: true })).not.toContain(leaseToken);
    expect(JSON.stringify(failure)).not.toContain(leaseToken);
  });
});

class StubClientRequest extends EventEmitter {
  public constructor(
    private readonly callback: (response: IncomingMessage) => void,
    private readonly responseBody: unknown,
    private readonly responseOutcome: "complete" | "aborted" | "error" | "closed" = "complete",
    private readonly responseStatusCode = 200,
    private readonly rawResponseBody = false,
  ) {
    super();
  }

  public setTimeout(): this {
    return this;
  }

  public destroy(error?: Error): this {
    if (error !== undefined) {
      queueMicrotask(() => this.emit("error", error));
    }
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  public write(): boolean {
    return true;
  }

  public end(): this {
    const response = Object.assign(new EventEmitter(), {
      statusCode: this.responseStatusCode,
    }) as IncomingMessage;
    response.destroy = () => response;
    this.callback(response);
    queueMicrotask(() => {
      const responseBody = this.rawResponseBody
        ? String(this.responseBody)
        : JSON.stringify(this.responseBody);
      response.emit("data", Buffer.from(responseBody, "utf8"));
      if (this.responseOutcome === "complete") {
        response.emit("end");
      } else if (this.responseOutcome === "aborted") {
        response.emit("aborted");
      } else if (this.responseOutcome === "error") {
        response.emit("error", new Error("response reset"));
      } else {
        response.emit("close");
      }
      this.emit("close");
    });
    return this;
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}

function jsonUnicodeEscape(value: string): string {
  return [...value]
    .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("");
}

function createHttpsConfig(): WorkerConfig {
  return {
    serverUrl: new URL("https://worker-api.internal"),
    protocolVersion: "1.0",
    workerNodeId: "worker-node",
    workerToken,
    displayName: "Test worker",
    workerVersion: "0.1.0-test",
    maxSlots: 1,
    dataDirectory: ".",
    executionEnabled: false,
    claimWaitSeconds: 1,
    registrationRetrySeconds: 1,
    idleDelayMilliseconds: 1_000,
    heartbeatIntervalSeconds: 5,
    heartbeatSafetyMarginSeconds: 0,
    shutdownGraceSeconds: 1,
    requestTimeoutSeconds: 1,
    logLevel: "error",
    capabilities: {
      operatingSystem: "windows",
      architecture: "x64",
      headless: true,
      interactiveDesktop: false,
      codexVersion: "not-configured",
      recipeIds: [],
      labels: { execution: "disabled", processHost: "unavailable" },
    },
    allowInsecureHttp: false,
    tls: {
      ca: Buffer.from("test-ca"),
      serverName: "worker-api.internal",
      rejectUnauthorized: true,
    },
  };
}

function registrationRequest(config: WorkerConfig): WorkerRegistrationRequest {
  return {
    protocolVersion: config.protocolVersion,
    workerNodeId: config.workerNodeId,
    workerInstanceId: "worker-instance",
    displayName: config.displayName,
    workerVersion: config.workerVersion,
    maxSlots: config.maxSlots,
    capabilities: config.capabilities,
  };
}

function completionSubmission(config: WorkerConfig): RunCompletionSubmission {
  return {
    jobId: "job-terminal",
    runAttemptId: "run-terminal",
    workerNodeId: config.workerNodeId,
    workerInstanceId: "worker-instance",
    leaseToken: "t".repeat(32),
    leaseGeneration: 1,
    resultDigest: "a".repeat(64),
    result: { summary: "ok" },
  };
}

function registrationResponse() {
  return {
    protocolVersion: "1.0" as const,
    workerId: "worker-id",
    state: "online" as const,
    heartbeatIntervalMs: 5_000,
    leaseTtlMs: 30_000,
    serverTime,
  };
}

function largeClaimResponse(config: WorkerConfig) {
  const jobId = "job-large-envelope";
  const runAttemptId = "run-large-envelope";
  return {
    outcome: "granted" as const,
    serverTime,
    envelope: {
      protocolVersion: "1.0" as const,
      envelopeVersion: 1 as const,
      assignedAt: serverTime,
      leaseExpiresAt: "2026-08-31T00:01:00.000Z",
      executionDeadlineAt: "2026-08-31T00:05:00.000Z",
      lease: {
        jobId,
        runAttemptId,
        workerNodeId: config.workerNodeId,
        workerInstanceId: "worker-instance",
        leaseToken: "t".repeat(32),
        leaseGeneration: 1,
      },
      job: {
        jobId,
        kind: "issue_triage" as const,
        priority: 1,
        attempt: 1,
        maxAttempts: 3,
        generation: 1,
        intentVersion: 1,
        semanticKey: "large-envelope",
      },
      repository: { githubRepositoryId: 1, fullName: "microsoft/PowerToys" },
      resource: {
        kind: "issue" as const,
        githubNodeId: "issue-node",
        number: 1,
        title: "Large issue",
        author: { githubUserId: 1, login: "author", accountType: "user" as const },
        canonicalSnapshot: { body: "x".repeat(2 * 1024 * 1024 + 64 * 1024) },
        revisionDigest: "a".repeat(64),
      },
      prompt: {
        name: "issue-triage",
        version: "1",
        renderedPrompt: "Review the issue.",
        promptSha256: "b".repeat(64),
        outputSchema: { additionalProperties: false, type: "object" },
        outputSchemaSha256: "c".repeat(64),
      },
      executionPolicy: {
        hardTimeoutMs: 300_000,
        noProgressTimeoutMs: 60_000,
        maxCodexTurns: 4,
        allowedRecipeIds: [],
        requiredCapabilityLabels: {},
      },
    },
  };
}

function silentLogger(): Logger {
  return capturingLogger([]);
}

function capturingLogger(messages: string[]): Logger {
  return {
    debug: (message) => messages.push(message),
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  };
}
