import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { SecureContext, SecureContextOptions } from "node:tls";
import type { WorkerRegistrationRequest } from "@agentic-review/contracts";
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
});

class StubClientRequest extends EventEmitter {
  public constructor(
    private readonly callback: (response: IncomingMessage) => void,
    private readonly responseBody: unknown,
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
    this.callback(response);
    queueMicrotask(() => {
      response.emit("data", Buffer.from(JSON.stringify(this.responseBody), "utf8"));
      response.emit("end");
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
