import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { SecureContext, SecureContextOptions } from "node:tls";
import type { RunCompletionSubmission, WorkerRegistrationRequest } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { HttpWorkerApi } from "./http-worker-api.js";

const serverTime = "2026-08-31T00:00:00.000Z";

describe("HttpWorkerApi TLS preflight", () => {
  it("creates one secure context and reuses it without forwarding raw TLS material", async () => {
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
    expect(contextOptions).toEqual([
      {
        ca: config.tls?.ca,
        pfx: config.tls?.pfx,
        passphrase: config.tls?.passphrase,
      },
    ]);
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    for (const options of requestOptions) {
      expect((options as RequestOptions & { secureContext?: SecureContext }).secureContext).toBe(
        secureContext,
      );
      expect(options.servername).toBe("worker-api.internal");
      expect(options.rejectUnauthorized).toBe(true);
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
    const preflightError = new Error("TLS client material is invalid.");
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
});

class StubClientRequest extends EventEmitter {
  public constructor(
    private readonly callback: (response: IncomingMessage) => void,
    private readonly responseBody: unknown,
    private readonly responseOutcome: "complete" | "aborted" | "error" | "closed" = "complete",
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
    const response = Object.assign(new EventEmitter(), { statusCode: 200 }) as IncomingMessage;
    response.destroy = () => response;
    this.callback(response);
    queueMicrotask(() => {
      response.emit("data", Buffer.from(JSON.stringify(this.responseBody), "utf8"));
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

function createHttpsConfig(): WorkerConfig {
  return {
    serverUrl: new URL("https://worker-api.internal"),
    protocolVersion: "1.0",
    workerNodeId: "worker-node",
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
      pfx: Buffer.from("test-pfx"),
      passphrase: "test-passphrase",
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
