import { statfs } from "node:fs/promises";
import type {
  ActiveLeaseHeartbeat,
  ExecutionPhase,
  JobExecutionEnvelope,
  LeaseCommand,
  WorkerHeartbeatRequest,
  WorkerRegistrationResponse,
  WorkerState,
} from "@agentic-review/contracts";
import type { WorkerConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { isFatalWorkerError, WorkerApiError } from "../server-client/errors.js";
import type { WorkerApi } from "../server-client/worker-api.js";
import { delay } from "../util/async.js";
import { LeaseLostError } from "./errors.js";

interface LeaseSession {
  readonly envelope: JobExecutionEnvelope;
  readonly abortController: AbortController;
  readonly startedAtMilliseconds: number;
  leaseDeadlineMonotonicMilliseconds: number;
  terminalSubmissionFenced: boolean;
  cancellationReason?: LeaseLostError;
  phase: ExecutionPhase;
  progressSequence: number;
  lastProgressAt: string;
  processCount: number;
}

export interface LeaseHandle {
  readonly runAttemptId: string;
  reportProgress(phase: ExecutionPhase, processCount?: number): void;
  isAuthoritative(): boolean;
  canRetryTerminalSubmission(): boolean;
  cancellationReason(): LeaseLostError | undefined;
  detach(): void;
}

export interface HeartbeatCoordinatorOptions {
  readonly config: WorkerConfig;
  readonly workerInstanceId: string;
  readonly registration: WorkerRegistrationResponse;
  readonly api: WorkerApi;
  readonly logger: Logger;
  readonly stateProvider: () => WorkerState;
  readonly availableSlotsProvider: () => number;
  readonly onDrainRequested: (reason: string) => void;
  readonly onRegistrationLost: (error: WorkerApiError) => void;
  readonly onFatalError: (error: unknown) => void;
}

export class HeartbeatCoordinator {
  readonly #config: WorkerConfig;
  readonly #workerInstanceId: string;
  readonly #api: WorkerApi;
  readonly #logger: Logger;
  readonly #stateProvider: () => WorkerState;
  readonly #availableSlotsProvider: () => number;
  readonly #onDrainRequested: (reason: string) => void;
  readonly #onRegistrationLost: (error: WorkerApiError) => void;
  readonly #onFatalError: (error: unknown) => void;
  readonly #sessions = new Map<string, LeaseSession>();
  readonly #stopController = new AbortController();
  #heartbeatSequence = 0;
  #nextHeartbeatMilliseconds: number;
  #leaseTtlMilliseconds: number;
  #serverClockOffsetMilliseconds: number;
  #loopPromise?: Promise<void>;
  #watchdogTimer: NodeJS.Timeout | undefined;

  public constructor(options: HeartbeatCoordinatorOptions) {
    this.#config = options.config;
    this.#workerInstanceId = options.workerInstanceId;
    this.#api = options.api;
    this.#logger = options.logger;
    this.#stateProvider = options.stateProvider;
    this.#availableSlotsProvider = options.availableSlotsProvider;
    this.#onDrainRequested = options.onDrainRequested;
    this.#onRegistrationLost = options.onRegistrationLost;
    this.#onFatalError = options.onFatalError;
    this.#nextHeartbeatMilliseconds = clampHeartbeatDelay(
      Math.min(
        options.registration.heartbeatIntervalMs,
        options.config.heartbeatIntervalSeconds * 1_000,
      ),
    );
    this.#leaseTtlMilliseconds = options.registration.leaseTtlMs;
    this.#serverClockOffsetMilliseconds =
      parseDateTime(options.registration.serverTime, "serverTime") - performance.now();
  }

  public start(): void {
    if (this.#loopPromise !== undefined) {
      return;
    }
    this.#watchdogTimer = setInterval(() => this.#abortLeasesNearExpiry(), 1_000);
    this.#watchdogTimer.unref();
    this.#loopPromise = this.#runLoop();
  }

  public async stop(): Promise<void> {
    this.#stopController.abort(new Error("Heartbeat coordinator stopped."));
    if (this.#watchdogTimer !== undefined) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = undefined;
    }
    await this.#loopPromise?.catch(() => undefined);
  }

  public updateRegistration(registration: WorkerRegistrationResponse): void {
    this.#nextHeartbeatMilliseconds = clampHeartbeatDelay(
      Math.min(registration.heartbeatIntervalMs, this.#config.heartbeatIntervalSeconds * 1_000),
    );
    this.#leaseTtlMilliseconds = registration.leaseTtlMs;
    this.observeServerTime(registration.serverTime);
  }

  public observeServerTime(
    serverTime: string,
    observedAtMonotonicMilliseconds = performance.now(),
  ): void {
    this.#serverClockOffsetMilliseconds =
      parseDateTime(serverTime, "serverTime") - observedAtMonotonicMilliseconds;
  }

  public remainingMillisecondsUntil(serverDeadline: string): number {
    const estimatedServerTime = performance.now() + this.#serverClockOffsetMilliseconds;
    return Math.max(0, parseDateTime(serverDeadline, "serverDeadline") - estimatedServerTime);
  }

  public attach(envelope: JobExecutionEnvelope, abortController: AbortController): LeaseHandle {
    const runAttemptId = envelope.lease.runAttemptId;
    if (this.#sessions.has(runAttemptId)) {
      throw new Error(
        `Run attempt ${runAttemptId} is already attached to the heartbeat coordinator.`,
      );
    }

    const session: LeaseSession = {
      envelope,
      abortController,
      startedAtMilliseconds: Date.now(),
      leaseDeadlineMonotonicMilliseconds:
        performance.now() + this.remainingMillisecondsUntil(envelope.leaseExpiresAt),
      terminalSubmissionFenced: false,
      phase: "leased",
      progressSequence: 0,
      lastProgressAt: new Date().toISOString(),
      processCount: 0,
    };
    this.#sessions.set(runAttemptId, session);

    return {
      runAttemptId,
      reportProgress: (phase, processCount) => {
        if (this.#sessions.get(runAttemptId) !== session) {
          return;
        }
        session.phase = phase;
        session.processCount = processCount ?? session.processCount;
        session.progressSequence += 1;
        session.lastProgressAt = new Date().toISOString();
      },
      isAuthoritative: () =>
        this.#sessions.get(runAttemptId) === session &&
        !session.abortController.signal.aborted &&
        !session.terminalSubmissionFenced &&
        performance.now() < session.leaseDeadlineMonotonicMilliseconds,
      canRetryTerminalSubmission: () =>
        this.#sessions.get(runAttemptId) === session &&
        !session.terminalSubmissionFenced &&
        performance.now() < session.leaseDeadlineMonotonicMilliseconds,
      cancellationReason: () => session.cancellationReason,
      detach: () => {
        if (this.#sessions.get(runAttemptId) === session) {
          this.#sessions.delete(runAttemptId);
        }
      },
    };
  }

  async #runLoop(): Promise<void> {
    const signal = this.#stopController.signal;
    while (!signal.aborted) {
      await this.#sendHeartbeat(signal).catch((error: unknown) => {
        if (!signal.aborted) {
          if (error instanceof WorkerApiError && error.isWorkerRegistrationLost) {
            this.#onRegistrationLost(error);
            this.#abortLeasesNearExpiry();
          } else if (isFatalWorkerError(error)) {
            this.#stopController.abort(error);
            this.#onFatalError(error);
          } else {
            this.#logger.warn("Worker heartbeat failed.", { error });
            this.#abortLeasesNearExpiry();
          }
        }
      });

      try {
        await delay(this.#nextHeartbeatMilliseconds, signal);
      } catch {
        break;
      }
    }
  }

  async #sendHeartbeat(signal: AbortSignal): Promise<void> {
    const requestStartedAt = performance.now();
    const request: WorkerHeartbeatRequest = {
      protocolVersion: this.#config.protocolVersion,
      workerNodeId: this.#config.workerNodeId,
      workerInstanceId: this.#workerInstanceId,
      heartbeatSequence: this.#heartbeatSequence,
      observedAt: new Date().toISOString(),
      availableSlots: this.#availableSlotsProvider(),
      activeLeases: [...this.#sessions.values()].map(toHeartbeat),
      health: {
        state: this.#stateProvider(),
        freeDiskBytes: await readFreeDiskBytes(this.#config.dataDirectory, this.#logger),
        memoryUsageBytes: process.memoryUsage().rss,
      },
    };
    this.#heartbeatSequence += 1;

    const response = await this.#api.heartbeat(this.#workerInstanceId, request, signal);
    const responseReceivedAt = performance.now();
    const roundTripMilliseconds = responseReceivedAt - requestStartedAt;
    this.observeServerTime(response.serverTime, responseReceivedAt);
    this.#nextHeartbeatMilliseconds = clampHeartbeatDelay(
      Math.min(response.nextHeartbeatInMs, this.#config.heartbeatIntervalSeconds * 1_000),
    );
    if (response.workerState === "draining" || response.workerState === "disabled") {
      this.#onDrainRequested(`server_worker_state:${response.workerState}`);
    }
    for (const command of response.commands) {
      this.#applyCommand(command, response.serverTime, responseReceivedAt, roundTripMilliseconds);
    }
    this.#abortLeasesNearExpiry();
  }

  #applyCommand(
    command: LeaseCommand,
    serverTime: string,
    responseReceivedAt: number,
    roundTripMilliseconds: number,
  ): void {
    const session = this.#sessions.get(command.runAttemptId);
    if (session === undefined) {
      this.#logger.debug("Ignoring command for an inactive run attempt.", {
        runAttemptId: command.runAttemptId,
        action: command.action,
      });
      return;
    }
    if (session.envelope.lease.leaseGeneration !== command.leaseGeneration) {
      this.#logger.warn("Ignoring command with a mismatched lease generation.", {
        runAttemptId: command.runAttemptId,
        expectedGeneration: session.envelope.lease.leaseGeneration,
        actualGeneration: command.leaseGeneration,
      });
      return;
    }

    if (command.leaseExpiresAt !== null) {
      const remainingAtServer = Math.max(
        0,
        parseDateTime(command.leaseExpiresAt, "leaseExpiresAt") -
          parseDateTime(serverTime, "serverTime"),
      );
      session.leaseDeadlineMonotonicMilliseconds =
        responseReceivedAt + Math.max(0, remainingAtServer - roundTripMilliseconds);
    }
    if (command.action === "continue") {
      return;
    }
    if (command.action === "drain") {
      this.#onDrainRequested(command.reasonCode ?? "server_command:drain");
      return;
    }

    const leaseLoss = new LeaseLostError(
      `Server ended lease with command ${command.action}.`,
      command.reasonCode ?? command.action,
    );
    if (command.action === "cancel") {
      session.cancellationReason = leaseLoss;
    } else if (command.action === "stale") {
      session.terminalSubmissionFenced = true;
    }
    session.abortController.abort(leaseLoss);
  }

  #abortLeasesNearExpiry(): void {
    const configuredMargin = this.#config.heartbeatSafetyMarginSeconds * 1_000;
    const abortAtOffset = Math.min(
      configuredMargin,
      Math.max(1_000, this.#leaseTtlMilliseconds / 3),
    );
    const now = performance.now();
    for (const session of this.#sessions.values()) {
      if (
        !session.abortController.signal.aborted &&
        now >= session.leaseDeadlineMonotonicMilliseconds - abortAtOffset
      ) {
        session.abortController.abort(
          new LeaseLostError(
            "Lease could not be renewed before the local safety deadline.",
            "renewal_deadline",
          ),
        );
      }
    }
  }
}

function toHeartbeat(session: LeaseSession): ActiveLeaseHeartbeat {
  return {
    ...session.envelope.lease,
    phase: session.phase,
    progressSequence: session.progressSequence,
    lastProgressAt: session.lastProgressAt,
    elapsedMs: Math.max(0, Date.now() - session.startedAtMilliseconds),
    processCount: session.processCount,
  };
}

async function readFreeDiskBytes(path: string, logger: Logger): Promise<number> {
  try {
    const stats = await statfs(path);
    return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(stats.bavail * stats.bsize)));
  } catch (error) {
    logger.warn("Unable to read worker disk capacity.", { path, error });
    return 0;
  }
}

function parseDateTime(value: string, name: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return result;
}

function clampHeartbeatDelay(value: number): number {
  return Math.max(1_000, Math.min(60_000, value));
}
