import { createCanonicalResult } from "@agentic-review/codex";
import type {
  LeaseIdentity,
  ModelInvocationOpening,
  ModelInvocationReceiptSet,
  ModelInvocationScope,
  ModelInvocationSealRequest,
  ModelInvocationSealV1,
  ModelInvocationSubmissionV1,
  ModelInvocationSubmitRequest,
} from "@agentic-review/contracts";
import {
  modelInvocationReceiptSetDigest,
  modelInvocationScopeDigest,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import {
  type ModelInvocationApi,
  parseModelInvocationOpening,
  parseModelInvocationSeal,
  parseModelInvocationSubmission,
  snapshotModelInvocationBeginRequest,
  snapshotModelInvocationSealRequest,
  snapshotModelInvocationSubmitRequest,
} from "../server-client/model-invocation-api.js";
import {
  createModelResponseRelay,
  type ModelResponseRelay,
  type ModelResponseRelayOptions,
} from "./model-response-relay.js";
import { type ManagedProcess, ProcessExitedEventSchema } from "./process-host-protocol.js";

export interface ModelInvocationSessionOptions {
  readonly api: ModelInvocationApi;
  readonly lease: LeaseIdentity;
  readonly expectedScope: ModelInvocationScope;
  readonly runtime: ModelInvocationReceiptSet["runtime"];
  readonly relayOptions: Omit<ModelResponseRelayOptions, "scope" | "runtime">;
  readonly operationTimeoutMs?: number;
  readonly processTimeoutMs?: number;
}

export interface ModelInvocationSessionResult {
  readonly submission: ModelInvocationSubmissionV1;
  readonly modelOutputBound: boolean;
  readonly executionAccepted: false;
}

export interface ModelInvocationSession {
  readonly opening: ModelInvocationOpening;
  /** Only connection information is exposed. The coordinator retains relay closure authority. */
  readonly relay: Pick<ModelResponseRelay, "url" | "bearerToken">;
  /** The parent supplies its actual process and the promise draining both output streams. */
  attachProcess(managed: ManagedProcess, drained: Promise<unknown>): void;
  /** The parent must validate the model output before supplying its canonical JSON digest. */
  close(input: {
    readonly modelOutputSha256: string | null;
  }): Promise<ModelInvocationSessionResult>;
}

export type ModelInvocationCoordinatorFailureCode =
  | "INVALID_CONFIGURATION"
  | "BEGIN_UNCONFIRMED"
  | "OPENING_INVALID"
  | "RELAY_START_UNCONFIRMED"
  | "PROCESS_ALREADY_ATTACHED"
  | "PROCESS_NOT_ATTACHED"
  | "PROCESS_DRAIN_UNCONFIRMED"
  | "CLOSE_INPUT_INVALID"
  | "CLOSE_INPUT_CONFLICT"
  | "RELAY_CLOSE_UNCONFIRMED"
  | "RECEIPTS_INVALID"
  | "SEAL_UNCONFIRMED"
  | "SEAL_INVALID"
  | "SUBMISSION_UNCONFIRMED"
  | "SUBMISSION_INVALID"
  | "CANCELLED_NOT_SUBMITTED";

export class ModelInvocationCoordinatorError extends Error {
  readonly submissionConfirmed = false;
  readonly executionAccepted = false;
  constructor(readonly code: ModelInvocationCoordinatorFailureCode) {
    // Transport errors and cancellation reasons may contain protected provider or lease data.
    super("Model invocation recording was not confirmed by the parent coordinator.");
    this.name = "ModelInvocationCoordinatorError";
  }
}

const fail = (code: ModelInvocationCoordinatorFailureCode) =>
  new ModelInvocationCoordinatorError(code);
const digestPattern = /^[a-f0-9]{64}(?![\s\S])/u;
const equal = (left: unknown, right: unknown) =>
  createCanonicalResult(left).json === createCanonicalResult(right).json;

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function timeout(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw fail("INVALID_CONFIGURATION");
  return result;
}

function closeDigest(input: { readonly modelOutputSha256: string | null }): string | null {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw fail("CLOSE_INPUT_INVALID");
  const descriptor = Object.getOwnPropertyDescriptor(input, "modelOutputSha256");
  if (
    Reflect.ownKeys(input).length !== 1 ||
    !descriptor?.enumerable ||
    !("value" in descriptor) ||
    (descriptor.value !== null &&
      (typeof descriptor.value !== "string" || !digestPattern.test(descriptor.value)))
  ) {
    throw fail("CLOSE_INPUT_INVALID");
  }
  return descriptor.value as string | null;
}

/** A bounded wait never converts termination acknowledgement or cancellation into process exit. */
async function bounded<T>(
  task: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  code: ModelInvocationCoordinatorFailureCode,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          controller.abort();
          reject(fail("CANCELLED_NOT_SUBMITTED"));
        };
        parent?.addEventListener("abort", onAbort, { once: true });
        if (parent?.aborted) onAbort();
        timer = setTimeout(() => {
          controller.abort();
          reject(fail(code));
        }, milliseconds);
      }),
      Promise.resolve().then(() => {
        if (parent?.aborted) throw fail("CANCELLED_NOT_SUBMITTED");
        return task(controller.signal);
      }),
    ]);
  } catch (error) {
    if (error instanceof ModelInvocationCoordinatorError) throw error;
    throw fail(code);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) parent?.removeEventListener("abort", onAbort);
  }
}

/**
 * The attempt execution context owns exactly one session. Retry close on that same session;
 * calling this factory again cannot recover an invocation that already started executing.
 * Cross-factory ownership and restart fencing belong to the Worker attempt lifecycle.
 */
export async function createModelInvocationSession(
  options: ModelInvocationSessionOptions,
): Promise<ModelInvocationSession> {
  const operationTimeoutMs = timeout(options.operationTimeoutMs, 10_000, 60_000);
  const processTimeoutMs = timeout(options.processTimeoutMs, 30_000, 2 * 60 * 60 * 1000);
  let expectedScope: ModelInvocationScope;
  let begin: ReturnType<typeof snapshotModelInvocationBeginRequest>["value"];
  let relayOptions: Omit<ModelResponseRelayOptions, "scope" | "runtime">;
  try {
    modelInvocationScopeDigest(options.expectedScope);
    expectedScope = immutable(structuredClone(options.expectedScope));
    begin = immutable(
      snapshotModelInvocationBeginRequest({
        lease: options.lease,
        invocationId: expectedScope.invocationId,
        runtime: options.runtime,
        ...(expectedScope.schemaVersion === "ModelInvocationScopeV2"
          ? { summaryInput: expectedScope.inputRef }
          : {}),
      }).value,
    );
    if (
      begin.lease.jobId !== expectedScope.jobId ||
      begin.lease.runAttemptId !== expectedScope.attemptId ||
      begin.lease.workerNodeId !== expectedScope.workerNodeId ||
      begin.lease.workerInstanceId !== expectedScope.workerInstanceId ||
      begin.lease.leaseGeneration !== expectedScope.leaseGeneration
    )
      throw new Error();
    relayOptions = {
      ...options.relayOptions,
      ...(options.relayOptions.limits === undefined
        ? {}
        : { limits: immutable(structuredClone(options.relayOptions.limits)) }),
    };
  } catch {
    throw fail("INVALID_CONFIGURATION");
  }
  const parentSignal = relayOptions.signal;
  const deadline = Date.parse(relayOptions.deadlineAt);
  if (
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    deadline - Date.now() > 2 * 60 * 60 * 1000
  ) {
    throw fail("INVALID_CONFIGURATION");
  }
  const lifetime = new AbortController();
  const signal = AbortSignal.any([parentSignal, lifetime.signal]);
  const timer = setTimeout(() => lifetime.abort(), Math.max(1, deadline - Date.now()));
  timer.unref();
  let relay: ModelResponseRelay | undefined;
  try {
    const returned = await bounded(
      (requestSignal) => options.api.beginModelInvocation(begin, requestSignal),
      operationTimeoutMs,
      "BEGIN_UNCONFIRMED",
      signal,
    );
    let opening: ModelInvocationOpening;
    try {
      opening = immutable(structuredClone(parseModelInvocationOpening(returned, begin)));
      if (!equal(opening.scope, expectedScope)) throw new Error();
    } catch {
      throw fail("OPENING_INVALID");
    }
    const starting = createModelResponseRelay({
      ...relayOptions,
      scope: expectedScope,
      runtime: begin.runtime,
      signal,
    });
    // A late listener must still close if bounded startup loses the race to cancellation.
    void starting.then(
      (late) => {
        if (signal.aborted) void late.close().catch(() => undefined);
      },
      () => undefined,
    );
    relay = await bounded(() => starting, operationTimeoutMs, "RELAY_START_UNCONFIRMED", signal);
    if (signal.aborted) throw fail("CANCELLED_NOT_SUBMITTED");
    const owned = new OwnedModelInvocationSession(
      options.api,
      begin.lease,
      opening,
      relay,
      signal,
      operationTimeoutMs,
      processTimeoutMs,
      (cancel) => {
        clearTimeout(timer);
        if (cancel) lifetime.abort();
      },
    );
    // The facade cannot expose the owned relay, control API, frozen requests or cleanup setters.
    return Object.freeze({
      opening: owned.opening,
      relay: owned.relay,
      attachProcess: (managed: ManagedProcess, drained: Promise<unknown>) =>
        owned.attachProcess(managed, drained),
      close: (input: { readonly modelOutputSha256: string | null }) => owned.close(input),
    });
  } catch (error) {
    clearTimeout(timer);
    lifetime.abort();
    if (relay !== undefined)
      await bounded(() => relay!.close(), operationTimeoutMs, "RELAY_CLOSE_UNCONFIRMED").catch(
        () => undefined,
      );
    throw error;
  }
}

class OwnedModelInvocationSession implements ModelInvocationSession {
  readonly relay: ModelInvocationSession["relay"];
  #managed: ManagedProcess | undefined;
  #settlement:
    | Promise<
        readonly [
          PromiseSettledResult<Awaited<ManagedProcess["completed"]>>,
          PromiseSettledResult<unknown>,
        ]
      >
    | undefined;
  #intent: { readonly modelOutputSha256: string | null } | undefined;
  #closing: Promise<ModelInvocationSessionResult> | undefined;
  #prepared: Promise<void> | undefined;
  #sealRequest: ModelInvocationSealRequest | undefined;
  #submitRequest: ModelInvocationSubmitRequest | undefined;
  #seal: ModelInvocationSealV1 | undefined;
  #result: ModelInvocationSessionResult | undefined;
  #modelOutputBound = false;
  #terminalFailure: ModelInvocationCoordinatorError | undefined;

  constructor(
    private readonly api: ModelInvocationApi,
    private readonly lease: LeaseIdentity,
    readonly opening: ModelInvocationOpening,
    private readonly ownedRelay: ModelResponseRelay,
    private readonly signal: AbortSignal,
    private readonly operationTimeoutMs: number,
    private readonly processTimeoutMs: number,
    private readonly stopLifetime: (cancel: boolean) => void,
  ) {
    this.relay = Object.freeze({ url: ownedRelay.url, bearerToken: ownedRelay.bearerToken });
  }

  attachProcess(managed: ManagedProcess, drained: Promise<unknown>): void {
    this.assertActive();
    if (this.#managed !== undefined || this.#intent !== undefined)
      throw fail("PROCESS_ALREADY_ATTACHED");
    this.#managed = managed;
    // Install rejection handlers immediately, even when the parent has not called close yet.
    this.#settlement = Promise.allSettled([managed.completed, drained] as const);
  }

  close(input: {
    readonly modelOutputSha256: string | null;
  }): Promise<ModelInvocationSessionResult> {
    try {
      const modelOutputSha256 = closeDigest(input);
      if (this.#intent !== undefined && this.#intent.modelOutputSha256 !== modelOutputSha256) {
        throw fail("CLOSE_INPUT_CONFLICT");
      }
      this.#intent ??= Object.freeze({ modelOutputSha256 });
      if (this.#closing !== undefined) return this.#closing;
      this.#closing = this.closeOnce();
      void this.#closing.then(
        () => {
          this.#closing = undefined;
        },
        () => {
          if (this.signal.aborted) this.stopLifetime(true);
          this.#closing = undefined;
        },
      );
      return this.#closing;
    } catch (error) {
      return Promise.reject(
        error instanceof ModelInvocationCoordinatorError ? error : fail("CLOSE_INPUT_INVALID"),
      );
    }
  }

  private assertActive(): void {
    if (this.signal.aborted) throw fail("CANCELLED_NOT_SUBMITTED");
  }

  private async closeOnce(): Promise<ModelInvocationSessionResult> {
    if (this.#terminalFailure !== undefined) throw this.#terminalFailure;
    if (this.#result !== undefined) {
      this.assertActive();
      return this.#result;
    }
    this.#prepared ??= this.prepare();
    await this.#prepared;
    this.assertActive();
    const sealRequest = this.#sealRequest!;
    const submitRequest = this.#submitRequest!;
    if (this.#seal === undefined) {
      const response = await bounded(
        (signal) => this.api.sealModelInvocation(sealRequest, signal),
        this.operationTimeoutMs,
        "SEAL_UNCONFIRMED",
        this.signal,
      );
      this.assertActive();
      try {
        this.#seal = immutable(structuredClone(parseModelInvocationSeal(response, sealRequest)));
      } catch {
        throw fail("SEAL_INVALID");
      }
    }
    const response = await bounded(
      (signal) => this.api.submitModelInvocationReceipts(submitRequest, signal),
      this.operationTimeoutMs,
      "SUBMISSION_UNCONFIRMED",
      this.signal,
    );
    this.assertActive();
    let submission: ModelInvocationSubmissionV1;
    try {
      submission = immutable(
        structuredClone(parseModelInvocationSubmission(response, submitRequest)),
      );
    } catch {
      throw fail("SUBMISSION_INVALID");
    }
    this.#result = Object.freeze({
      submission,
      modelOutputBound: this.#modelOutputBound,
      executionAccepted: false,
    });
    this.stopLifetime(false);
    return this.#result;
  }

  private async prepare(): Promise<void> {
    try {
      this.assertActive();
      if (this.#settlement === undefined || this.#managed === undefined)
        throw fail("PROCESS_NOT_ATTACHED");
      const settled = await bounded(
        () => this.#settlement!,
        this.processTimeoutMs,
        "PROCESS_DRAIN_UNCONFIRMED",
        this.signal,
      );
      const completed = settled[0];
      if (
        completed.status !== "fulfilled" ||
        settled[1].status !== "fulfilled" ||
        !Value.Check(ProcessExitedEventSchema, completed.value) ||
        completed.value.requestId !== this.#managed.requestId
      ) {
        throw fail("PROCESS_DRAIN_UNCONFIRMED");
      }
      const processOutputEligible =
        completed.value.exitCode === 0 &&
        completed.value.signal === null &&
        !completed.value.outputTruncated;
      this.assertActive();
      const closed = await bounded(
        () =>
          this.ownedRelay.close({
            modelOutputSha256: processOutputEligible ? this.#intent!.modelOutputSha256 : null,
          }),
        this.operationTimeoutMs,
        "RELAY_CLOSE_UNCONFIRMED",
        this.signal,
      );
      this.assertActive();
      // A provider failure or unbound output still has a real ledger worth recording. Only
      // parent cancellation prevents new control writes; submission never accepts execution.
      this.#modelOutputBound =
        processOutputEligible &&
        this.#intent!.modelOutputSha256 !== null &&
        closed.receiptSet.modelOutputSha256 === this.#intent!.modelOutputSha256;
      try {
        const receiptSet = closed.receiptSet;
        this.#submitRequest = immutable(
          snapshotModelInvocationSubmitRequest({
            lease: this.lease,
            invocationId: this.opening.scope.invocationId,
            receiptSet,
          }).value,
        );
        if (
          !equal(receiptSet.scope, this.opening.scope) ||
          !equal(receiptSet.runtime, this.opening.runtime)
        )
          throw new Error();
        this.#sealRequest = immutable(
          snapshotModelInvocationSealRequest({
            lease: this.lease,
            invocationId: this.opening.scope.invocationId,
            scopeSha256: receiptSet.scopeSha256,
            receiptSetSha256: modelInvocationReceiptSetDigest(receiptSet),
            closedAt: receiptSet.closedAt,
            state: receiptSet.state,
            callCount: receiptSet.calls.length,
            lastReceiptSha256: receiptSet.calls.at(-1)?.sha256 ?? null,
            modelOutputSha256: receiptSet.modelOutputSha256,
            observedIdentitySha256: receiptSet.observedIdentitySha256,
            processClosed: true,
            relayClosed: true,
          }).value,
        );
      } catch {
        throw fail("RECEIPTS_INVALID");
      }
    } catch (error) {
      this.#terminalFailure =
        error instanceof ModelInvocationCoordinatorError ? error : fail("RECEIPTS_INVALID");
      this.stopLifetime(true);
      // Termination is cleanup only. Neither its acknowledgement nor a rejected completion
      // supplies the missing process-closed evidence for a seal.
      if (this.#managed !== undefined) {
        await bounded(
          () => this.#managed!.terminate("cancelled"),
          this.operationTimeoutMs,
          "PROCESS_DRAIN_UNCONFIRMED",
        ).catch(() => undefined);
      }
      await bounded(
        () => this.ownedRelay.close(),
        this.operationTimeoutMs,
        "RELAY_CLOSE_UNCONFIRMED",
      ).catch(() => undefined);
      throw this.#terminalFailure;
    }
  }
}
