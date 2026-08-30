import { randomUUID } from "node:crypto";
import type {
  ClaimLeaseResponse,
  JobExecutionEnvelope,
  RunCompletionSubmission,
  RunFailureSubmission,
  WorkerRegistrationResponse,
  WorkerState,
} from "@agentic-review/contracts";
import type { WorkerConfig } from "./config.js";
import type { JobExecutor } from "./execution/job-executor.js";
import type { ProcessHostClient } from "./execution/process-host-protocol.js";
import { ExecutionTimeoutError, LeaseLostError } from "./leases/errors.js";
import { HeartbeatCoordinator } from "./leases/heartbeat-coordinator.js";
import type { Logger } from "./logging/logger.js";
import { digestCapabilities } from "./server-client/capabilities.js";
import { ProtocolError, WorkerApiError } from "./server-client/errors.js";
import type { WorkerApi } from "./server-client/worker-api.js";
import { delay, waitForPromisesWithTimeout } from "./util/async.js";

interface ActiveRun {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export class WorkerService {
  readonly #instanceId = randomUUID();
  readonly #stopController = new AbortController();
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #capabilitiesDigest: string;
  #registration?: WorkerRegistrationResponse;
  #registrationPromise: Promise<void> | undefined;
  #heartbeat?: HeartbeatCoordinator;
  #currentClaimController: AbortController | undefined;
  #fatalError: unknown = undefined;
  #draining = false;
  #stopping = false;
  #shutdownPromise?: Promise<void>;

  public constructor(
    private readonly config: WorkerConfig,
    private readonly api: WorkerApi,
    private readonly executor: JobExecutor,
    private readonly processHost: ProcessHostClient,
    private readonly logger: Logger,
  ) {
    this.#capabilitiesDigest = digestCapabilities(config.capabilities);
  }

  public async run(): Promise<void> {
    await this.#ensureRegistered("startup");
    const registration = this.#registration;
    if (registration === undefined) {
      throw new Error("Worker registration completed without a registration response.");
    }

    this.#heartbeat = new HeartbeatCoordinator({
      config: this.config,
      workerInstanceId: this.#instanceId,
      registration,
      api: this.api,
      logger: this.logger,
      stateProvider: () => this.#workerState(),
      availableSlotsProvider: () => this.#availableSlots(),
      onDrainRequested: (reason) => this.requestDrain(reason),
      onRegistrationLost: (error) => this.#requestRegistrationRecovery(error),
    });
    this.#heartbeat.start();

    this.logger.info("Worker registered.", {
      workerNodeId: this.config.workerNodeId,
      workerInstanceId: this.#instanceId,
      workerId: registration.workerId,
      executionEnabled: this.config.executionEnabled,
      maxSlots: this.config.maxSlots,
    });

    await this.#claimLoop();
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    await this.#shutdownPromise;
  }

  public requestDrain(reason: string): void {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    this.#currentClaimController?.abort(new Error(`Worker entered drain mode: ${reason}`));
    this.logger.info("Worker entered drain mode.", { reason });
  }

  public stop(reason: string): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise;
    }

    this.#stopping = true;
    this.requestDrain(reason);
    this.#stopController.abort(new Error(`Worker stopping: ${reason}`));
    this.#shutdownPromise = this.#drainAndStop(reason);
    return this.#shutdownPromise;
  }

  #ensureRegistered(reason: string): Promise<void> {
    if (this.#registrationPromise !== undefined) {
      return this.#registrationPromise;
    }

    const registrationPromise = this.#registerWithRetry(reason).then((registration) => {
      if (registration.state === "offline") {
        throw new Error("Server kept the worker offline after registration.");
      }
      this.#registration = registration;
      this.#heartbeat?.updateRegistration(registration);
      if (registration.state === "draining" || registration.state === "disabled") {
        this.requestDrain(`registration_state:${registration.state}`);
      }
    });
    this.#registrationPromise = registrationPromise;
    const clearRegistrationPromise = (): void => {
      if (this.#registrationPromise === registrationPromise) {
        this.#registrationPromise = undefined;
      }
    };
    void registrationPromise.then(clearRegistrationPromise, clearRegistrationPromise);
    return registrationPromise;
  }

  async #registerWithRetry(reason: string): Promise<WorkerRegistrationResponse> {
    const signal = this.#stopController.signal;
    while (!signal.aborted) {
      try {
        const requestStartedAt = performance.now();
        const response = await this.api.register(
          {
            protocolVersion: this.config.protocolVersion,
            workerNodeId: this.config.workerNodeId,
            workerInstanceId: this.#instanceId,
            displayName: this.config.displayName,
            workerVersion: this.config.workerVersion,
            maxSlots: this.config.maxSlots,
            capabilities: this.config.capabilities,
          },
          signal,
        );
        const responseReceivedAt = performance.now();
        if (response.protocolVersion !== this.config.protocolVersion) {
          throw new ProtocolError(
            `Server selected unsupported protocol version ${response.protocolVersion}.`,
          );
        }
        this.#heartbeat?.observeServerTime(response.serverTime, responseReceivedAt);
        this.logger.info("Worker registration succeeded.", {
          reason,
          requestDurationMilliseconds: responseReceivedAt - requestStartedAt,
        });
        return response;
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason;
        }
        if (
          error instanceof ProtocolError ||
          (error instanceof WorkerApiError && !error.isRetryable)
        ) {
          throw error;
        }
        this.logger.warn("Worker registration failed; retrying.", {
          reason,
          error,
          retrySeconds: this.config.registrationRetrySeconds,
        });
        await delay(this.config.registrationRetrySeconds * 1_000, signal);
      }
    }
    throw signal.reason ?? new Error("Worker stopped before registration completed.");
  }

  #requestRegistrationRecovery(error: WorkerApiError): void {
    if (this.#stopping || this.#stopController.signal.aborted) {
      return;
    }
    this.logger.warn("Worker registration was rejected; re-registering.", { error });
    this.#currentClaimController?.abort(error);
    void this.#ensureRegistered("heartbeat_worker_unavailable").catch(
      (registrationError: unknown) => {
        if (this.#stopping || this.#stopController.signal.aborted) {
          return;
        }
        this.#fatalError = registrationError;
        this.#stopController.abort(registrationError);
      },
    );
  }

  async #claimLoop(): Promise<void> {
    const stopSignal = this.#stopController.signal;
    while (!stopSignal.aborted) {
      if (this.#registrationPromise !== undefined) {
        await this.#registrationPromise;
      }
      if (this.#draining || !this.config.executionEnabled || this.#availableSlots() === 0) {
        try {
          await delay(this.config.idleDelayMilliseconds, stopSignal);
        } catch {
          break;
        }
        continue;
      }

      const claimController = new AbortController();
      this.#currentClaimController = claimController;
      const stopClaim = (): void => claimController.abort(stopSignal.reason);
      stopSignal.addEventListener("abort", stopClaim, { once: true });
      let response: ClaimLeaseResponse | undefined;
      let responseReceivedAt = 0;
      try {
        response = await this.api.claimLease(
          {
            protocolVersion: this.config.protocolVersion,
            workerNodeId: this.config.workerNodeId,
            workerInstanceId: this.#instanceId,
            availableSlots: this.#availableSlots(),
            waitSeconds: this.config.claimWaitSeconds,
            capabilitiesDigest: this.#capabilitiesDigest,
          },
          claimController.signal,
        );
        responseReceivedAt = performance.now();
      } catch (error) {
        if (!claimController.signal.aborted && !stopSignal.aborted) {
          this.logger.warn("Lease claim failed.", { error });
          await delay(this.config.idleDelayMilliseconds, stopSignal).catch(() => undefined);
        }
      } finally {
        stopSignal.removeEventListener("abort", stopClaim);
        if (this.#currentClaimController === claimController) {
          this.#currentClaimController = undefined;
        }
      }
      if (response === undefined) {
        continue;
      }
      this.#heartbeat?.observeServerTime(response.serverTime, responseReceivedAt);
      await this.#handleClaimResponse(response, stopSignal);
    }
  }

  async #handleClaimResponse(response: ClaimLeaseResponse, stopSignal: AbortSignal): Promise<void> {
    if (response.outcome === "granted") {
      if (this.#draining || this.#stopping || stopSignal.aborted) {
        await this.api
          .failRun(response.envelope.lease.runAttemptId, {
            ...response.envelope.lease,
            code: "WORKER_DRAINING",
            message: "The worker entered drain mode before the granted lease could start.",
            retryable: true,
          })
          .catch((error: unknown) => {
            this.logger.warn("Unable to release a lease granted during worker drain.", {
              runAttemptId: response.envelope.lease.runAttemptId,
              error,
            });
          });
        return;
      }
      this.#startRun(response.envelope);
      return;
    }
    if (response.outcome === "worker_unavailable") {
      if (
        response.reason === "not_registered" ||
        response.reason === "not_online" ||
        response.reason === "capabilities_changed"
      ) {
        await this.#ensureRegistered(`claim_response:${response.reason}`);
        return;
      }
      if (
        response.reason === "draining" ||
        response.reason === "disabled" ||
        response.reason === "upgrade_required"
      ) {
        this.requestDrain(`claim_response:${response.reason}`);
      }
      await delay(response.retryAfterMs ?? this.config.idleDelayMilliseconds, stopSignal).catch(
        () => undefined,
      );
      return;
    }
    await delay(response.retryAfterMs ?? this.config.idleDelayMilliseconds, stopSignal).catch(
      () => undefined,
    );
  }

  #startRun(envelope: JobExecutionEnvelope): void {
    validateEnvelopeOwnership(envelope, this.config.workerNodeId, this.#instanceId);
    const runAttemptId = envelope.lease.runAttemptId;
    if (this.#activeRuns.has(runAttemptId)) {
      throw new Error(`Server granted duplicate run attempt ${runAttemptId}.`);
    }

    const controller = new AbortController();
    const promise = this.#executeRun(envelope, controller)
      .catch((error: unknown) => {
        this.logger.error("Run attempt terminated unexpectedly.", { runAttemptId, error });
      })
      .finally(() => {
        this.#activeRuns.delete(runAttemptId);
      });
    this.#activeRuns.set(runAttemptId, { controller, promise });
    this.logger.info("Lease claimed.", {
      jobId: envelope.job.jobId,
      runAttemptId,
      leaseGeneration: envelope.lease.leaseGeneration,
    });
  }

  async #executeRun(envelope: JobExecutionEnvelope, controller: AbortController): Promise<void> {
    if (this.#heartbeat === undefined) {
      throw new Error("Heartbeat coordinator is not initialized.");
    }
    const lease = this.#heartbeat.attach(envelope, controller);
    const remainingMilliseconds = calculateExecutionTimeout(
      envelope,
      this.#heartbeat.remainingMillisecondsUntil(envelope.executionDeadlineAt),
      this.config.heartbeatSafetyMarginSeconds * 1_000,
    );
    let deadlineTimer: NodeJS.Timeout | undefined;
    if (remainingMilliseconds === 0) {
      controller.abort(new ExecutionTimeoutError(remainingMilliseconds));
    } else {
      deadlineTimer = setTimeout(() => {
        controller.abort(new ExecutionTimeoutError(remainingMilliseconds));
      }, remainingMilliseconds);
      deadlineTimer.unref();
    }

    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error("Run execution was aborted.");
      }
      lease.reportProgress("preparing", 0);
      const result = await this.executor.execute(envelope, {
        signal: controller.signal,
        processHost: this.processHost,
        reportProgress: ({ phase, processCount }) => lease.reportProgress(phase, processCount),
      });
      if (controller.signal.aborted) {
        throw controller.signal.reason ?? new Error("Run execution was aborted.");
      }
      if (!lease.isAuthoritative()) {
        const cancellationReason = lease.cancellationReason();
        if (cancellationReason !== undefined) {
          throw cancellationReason;
        }
        this.logger.warn("Discarding result because the lease is no longer authoritative.", {
          runAttemptId: envelope.lease.runAttemptId,
        });
        return;
      }

      lease.reportProgress("completing", 0);
      if (result.outcome === "succeeded") {
        const submission: RunCompletionSubmission = {
          jobId: envelope.lease.jobId,
          runAttemptId: envelope.lease.runAttemptId,
          workerNodeId: this.config.workerNodeId,
          workerInstanceId: this.#instanceId,
          leaseToken: envelope.lease.leaseToken,
          leaseGeneration: envelope.lease.leaseGeneration,
          resultDigest: result.resultDigest,
          result: result.result,
        };
        const submitted = await this.#submitTerminalWithRetry(
          "completion",
          () => this.api.completeRun(envelope.lease.runAttemptId, submission),
          () => lease.isAuthoritative(),
          envelope.lease.runAttemptId,
        );
        const cancellationReason = lease.cancellationReason();
        if (!submitted && cancellationReason !== undefined) {
          throw cancellationReason;
        }
        if (!submitted && controller.signal.aborted) {
          throw controller.signal.reason ?? new Error("Run execution was aborted.");
        }
      } else {
        const submission = this.#createFailureSubmission(
          envelope,
          result.code,
          result.message,
          result.retryable,
        );
        const submitted = await this.#submitTerminalWithRetry(
          "failure",
          () => this.api.failRun(envelope.lease.runAttemptId, submission),
          () => lease.isAuthoritative(),
          envelope.lease.runAttemptId,
        );
        if (!submitted && controller.signal.aborted) {
          throw controller.signal.reason ?? new Error("Run execution was aborted.");
        }
      }
    } catch (error) {
      const cancellationReason = lease.cancellationReason();
      const reason = cancellationReason ?? controller.signal.reason ?? error;
      const leaseLoss =
        error instanceof LeaseLostError
          ? error
          : reason instanceof LeaseLostError
            ? reason
            : undefined;
      if (leaseLoss !== undefined) {
        this.logger.warn("Run stopped after losing its lease.", {
          runAttemptId: envelope.lease.runAttemptId,
          error: leaseLoss,
        });
      }

      const cancellationAcknowledgement = cancellationReason !== undefined;
      const submission = this.#createFailureSubmission(
        envelope,
        cancellationAcknowledgement
          ? "CANCELLED_BY_SERVER"
          : reason instanceof ExecutionTimeoutError
            ? "EXECUTION_TIMEOUT"
            : leaseLoss !== undefined
              ? "LEASE_RENEWAL_FAILED"
              : "WORKER_EXECUTION_ERROR",
        reason instanceof Error ? reason.message : "Worker execution failed.",
        !cancellationAcknowledgement && !(reason instanceof ExecutionTimeoutError),
      );
      await this.#submitTerminalWithRetry(
        "termination",
        () => this.api.failRun(envelope.lease.runAttemptId, submission),
        () => lease.canRetryTerminalSubmission(),
        envelope.lease.runAttemptId,
      );
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      lease.detach();
    }
  }

  #createFailureSubmission(
    envelope: JobExecutionEnvelope,
    code: string,
    message: string,
    retryable: boolean,
  ): RunFailureSubmission {
    return {
      jobId: envelope.lease.jobId,
      runAttemptId: envelope.lease.runAttemptId,
      workerNodeId: this.config.workerNodeId,
      workerInstanceId: this.#instanceId,
      leaseToken: envelope.lease.leaseToken,
      leaseGeneration: envelope.lease.leaseGeneration,
      code,
      message: message.slice(0, 2_048),
      retryable,
    };
  }

  async #submitTerminalWithRetry(
    operation: string,
    submit: () => Promise<void>,
    canRetry: () => boolean,
    runAttemptId: string,
  ): Promise<boolean> {
    let retryDelayMilliseconds = 250;
    while (canRetry()) {
      try {
        await submit();
        return true;
      } catch (error) {
        const retryable =
          !(error instanceof ProtocolError) &&
          (!(error instanceof WorkerApiError) || error.isRetryable);
        if (!retryable) {
          this.logger.warn("Unable to report terminal run state.", {
            operation,
            runAttemptId,
            retryable,
            error,
          });
          return false;
        }

        this.logger.warn("Terminal run submission failed; retrying.", {
          operation,
          runAttemptId,
          retryDelayMilliseconds,
          error,
        });
        await delay(retryDelayMilliseconds);
        retryDelayMilliseconds = Math.min(2_000, retryDelayMilliseconds * 2);
      }
    }
    this.logger.warn("Terminal run submission stopped after lease authority expired.", {
      operation,
      runAttemptId,
    });
    return false;
  }

  async #drainAndStop(reason: string): Promise<void> {
    this.logger.info("Worker shutdown started.", {
      reason,
      activeRunCount: this.#activeRuns.size,
    });
    const completed = await waitForPromisesWithTimeout(
      [...this.#activeRuns.values()].map(({ promise }) => promise),
      this.config.shutdownGraceSeconds * 1_000,
    );
    if (!completed) {
      this.logger.warn("Shutdown grace period expired; cancelling active runs.", {
        activeRunCount: this.#activeRuns.size,
      });
      for (const { controller } of this.#activeRuns.values()) {
        controller.abort(new Error("Worker shutdown grace period expired."));
      }
      await this.processHost.terminateAll("worker_shutdown").catch((error: unknown) => {
        this.logger.error("ProcessHost failed to terminate active processes.", { error });
      });
      await waitForPromisesWithTimeout(
        [...this.#activeRuns.values()].map(({ promise }) => promise),
        5_000,
      );
    }

    await this.#heartbeat?.stop();
    await this.processHost.close();
    this.logger.info("Worker shutdown completed.");
  }

  #workerState(): WorkerState {
    return this.#draining || this.#stopping ? "draining" : "online";
  }

  #availableSlots(): number {
    if (this.#draining || !this.config.executionEnabled) {
      return 0;
    }
    return Math.max(0, this.config.maxSlots - this.#activeRuns.size);
  }
}

function validateEnvelopeOwnership(
  envelope: JobExecutionEnvelope,
  workerNodeId: string,
  workerInstanceId: string,
): void {
  if (
    envelope.lease.workerNodeId !== workerNodeId ||
    envelope.lease.workerInstanceId !== workerInstanceId
  ) {
    throw new Error("Server returned a lease assigned to a different worker identity.");
  }
}

function calculateExecutionTimeout(
  envelope: JobExecutionEnvelope,
  remainingAbsoluteBudgetMilliseconds: number,
  safetyMarginMilliseconds: number,
): number {
  const serverBudget = Math.max(0, remainingAbsoluteBudgetMilliseconds);
  const margin = Math.min(Math.max(0, safetyMarginMilliseconds), serverBudget);
  return Math.max(0, Math.min(envelope.executionPolicy.hardTimeoutMs, serverBudget) - margin);
}
