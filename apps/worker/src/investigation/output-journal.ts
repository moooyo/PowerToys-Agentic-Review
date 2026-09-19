import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  EntityIdSchema,
  type InvestigationOutputBatchRequest,
  type InvestigationOutputBatchResponse,
  InvestigationOutputBatchResponseSchema,
  type InvestigationOutputEventInput,
  InvestigationOutputEventInputSchema,
  type InvestigationWorkerLease,
  InvestigationWorkerLeaseSchema,
  maximumInvestigationOutputBatchBytes,
  maximumInvestigationOutputBatchEvents,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import { InvestigationWorkerClientError } from "./http-client.js";
import { type ModelOutputObservation, sanitizeModelOutputText } from "./model-output-observer.js";

interface OutputBatch {
  batchId: string;
  events: InvestigationOutputEventInput[];
}
interface RetainedOutput {
  version: 1;
  taskId: string;
  attemptId: string;
  nextSequence: number;
  updatedAt: string;
  open: boolean;
  dropped: number;
  batches: OutputBatch[];
  terminalDeliveryFailure?: TerminalDeliveryFailure;
}
interface TerminalDeliveryFailure {
  code: "output_lease_lost";
  batchId: string;
  recordedAt: string;
}
interface PendingOutput {
  invocationId: string | null;
  observation: ModelOutputObservation;
  observedAt: string;
  bytes: number;
}
interface AttemptOutput {
  retained: RetainedOutput;
  lease: InvestigationWorkerLease;
  pending: PendingOutput[];
  pendingDropped: number;
  closeRequested: boolean;
  terminalDeliveryFailure?: TerminalDeliveryFailure;
}
const maximumDeliveryLeaseBytes = 16_384;

const retainedOutputSchema = Type.Object(
  {
    version: Type.Literal(1),
    taskId: EntityIdSchema,
    attemptId: EntityIdSchema,
    nextSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    updatedAt: Type.String({ format: "date-time" }),
    open: Type.Boolean(),
    dropped: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    terminalDeliveryFailure: Type.Optional(
      Type.Object(
        {
          code: Type.Literal("output_lease_lost"),
          batchId: EntityIdSchema,
          recordedAt: Type.String({ format: "date-time" }),
        },
        { additionalProperties: false },
      ),
    ),
    batches: Type.Array(
      Type.Object(
        {
          batchId: EntityIdSchema,
          events: Type.Array(InvestigationOutputEventInputSchema, { minItems: 1, maxItems: 64 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export interface InvestigationOutputJournalOptions {
  /** A private, durable Worker directory outside disposable attempt workspaces. */
  readonly directory: string;
  readonly deliver: (
    taskId: string,
    request: InvestigationOutputBatchRequest,
    signal: AbortSignal,
  ) => Promise<InvestigationOutputBatchResponse>;
  readonly protectedValues?: readonly string[];
  readonly now?: () => Date;
  readonly onFailure?: () => void;
  /** Fixed metadata only; rejected payloads, credentials and remote error messages are excluded. */
  readonly onTerminalFailure?: (diagnostic: {
    readonly taskId: string;
    readonly attemptId: string;
    readonly code: "output_lease_lost" | "output_archive_capacity";
  }) => void;
  readonly maximumMemoryBytes?: number;
  readonly maximumAttemptBytes?: number;
  readonly maximumAttempts?: number;
  readonly maximumQuarantinedAttempts?: number;
  readonly maximumQuarantinedBytes?: number;
  readonly retentionMs?: number;
  readonly requestTimeoutMs?: number;
  readonly retryDelayMs?: number;
}

/** The synchronous producer never waits for disk or network delivery. Only sanitized fields persist. */
export interface InvestigationOutputJournal {
  openAttempt(taskId: string, lease: InvestigationWorkerLease, signal?: AbortSignal): Promise<void>;
  append(
    taskId: string,
    attemptId: string,
    invocationId: string | null,
    observation: ModelOutputObservation,
  ): void;
  closeAttempt(taskId: string, attemptId: string): void;
  replay(): Promise<void>;
  flush(timeoutMs?: number): Promise<boolean>;
  stop(timeoutMs?: number): Promise<boolean>;
}

export class DurableInvestigationOutputJournal implements InvestigationOutputJournal {
  readonly #attempts = new Map<string, AttemptOutput>();
  readonly #opening = new Map<
    string,
    { lease: InvestigationWorkerLease; operation: Promise<void> }
  >();
  readonly #quarantined = new Map<string, number>();
  readonly #lifetime = new AbortController();
  readonly #maximumMemoryBytes: number;
  readonly #maximumAttemptBytes: number;
  readonly #maximumAttempts: number;
  readonly #maximumQuarantinedAttempts: number;
  readonly #maximumQuarantinedBytes: number;
  readonly #retentionMs: number;
  readonly #requestTimeoutMs: number;
  readonly #retryDelayMs: number;
  #memoryBytes = 0;
  #memoryEvents = 0;
  #quarantinedBytes = 0;
  #loaded = false;
  #stopped = false;
  #storage: Promise<unknown> = Promise.resolve();
  #storagePump: Promise<void> | undefined;
  #replay: Promise<void> | undefined;
  #delivery: Promise<void> | undefined;
  #retryAt = 0;
  #lastFailureNotice = Number.NEGATIVE_INFINITY;
  #retryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: InvestigationOutputJournalOptions) {
    registerWorkerContractFormats();
    this.#maximumMemoryBytes = bounded(options.maximumMemoryBytes ?? 2_097_152, 1_024, 16_777_216);
    this.#maximumAttemptBytes = bounded(
      options.maximumAttemptBytes ?? 4_194_304,
      2_048,
      16_777_216,
    );
    this.#maximumAttempts = bounded(options.maximumAttempts ?? 64, 1, 256);
    this.#maximumQuarantinedAttempts = bounded(options.maximumQuarantinedAttempts ?? 256, 1, 4_096);
    this.#maximumQuarantinedBytes = bounded(
      options.maximumQuarantinedBytes ?? 256 * 1_024 * 1_024,
      1_024,
      1_073_741_824,
    );
    this.#retentionMs = bounded(options.retentionMs ?? 7 * 86_400_000, 86_400_000, 30 * 86_400_000);
    this.#requestTimeoutMs = bounded(options.requestTimeoutMs ?? 5_000, 1, 30_000);
    this.#retryDelayMs = bounded(options.retryDelayMs ?? 2_000, 1, 60_000);
  }

  openAttempt(
    taskId: string,
    lease: InvestigationWorkerLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const frozen = structuredClone(lease);
    if (
      !Value.Check(EntityIdSchema, taskId) ||
      !Value.Check(InvestigationWorkerLeaseSchema, frozen)
    )
      return Promise.reject(new Error("The visible output attempt identity is invalid."));
    const key = attemptKey(taskId, frozen.attemptId);
    if (signal?.aborted)
      return Promise.reject(new Error("Visible output initialization was cancelled."));
    const opening = this.#opening.get(key);
    if (opening !== undefined) {
      if (!sameLease(opening.lease, frozen))
        return Promise.reject(
          new Error("An output attempt cannot change its original delivery lease."),
        );
      return opening.operation;
    }
    if (this.#opening.size >= this.#maximumAttempts)
      return Promise.reject(
        new Error("The pending visible output initialization limit was reached."),
      );
    const assertActive = (): void => {
      signal?.throwIfAborted();
      if (this.#stopped) throw new Error("The visible output attempt identity is invalid.");
    };
    const operation = this.#serial(async () => {
      assertActive();
      await this.#load();
      assertActive();
      if (
        this.#stopped ||
        !Value.Check(EntityIdSchema, taskId) ||
        !Value.Check(InvestigationWorkerLeaseSchema, frozen)
      )
        throw new Error("The visible output attempt identity is invalid.");
      if (this.#quarantined.has(key))
        throw new Error("A quarantined output producer cannot reopen its attempt.");
      const previous = this.#attempts.get(key);
      if (previous !== undefined) {
        if (!sameLease(previous.lease, frozen))
          throw new Error("An output attempt cannot change its original delivery lease.");
        if (previous.closeRequested)
          throw new Error("A closed output producer cannot reopen its attempt.");
        return;
      }
      await this.#prune();
      assertActive();
      if (this.#attempts.size >= this.#maximumAttempts)
        throw new Error("The retained visible output attempt limit was reached.");
      // Reserve space for every admitted active queue becoming permanently undeliverable.
      // Once exhausted, only optional output is disabled; no retained evidence is removed.
      if (this.#archiveCapacityReached()) {
        this.#terminalFailure(taskId, frozen.attemptId, "output_archive_capacity");
        throw new Error("The retained visible output quarantine capacity was reached.");
      }
      const retained: RetainedOutput = {
        version: 1,
        taskId,
        attemptId: frozen.attemptId,
        nextSequence: 1,
        updatedAt: this.#now(),
        open: true,
        dropped: 0,
        batches: [],
      };
      // Private delivery authority is stored separately and is never part of public event data.
      await this.#write(`${key}.delivery.json`, JSON.stringify(frozen));
      assertActive();
      await this.#save(retained);
      const entry: AttemptOutput = {
        retained,
        lease: frozen,
        pending: [],
        pendingDropped: 0,
        closeRequested: false,
      };
      this.#attempts.set(key, entry);
      if (signal?.aborted || this.#stopped) {
        // This operation owns this newly created entry. Never close an existing shared attempt.
        entry.closeRequested = true;
        entry.pending.push({
          invocationId: null,
          observedAt: this.#now(),
          bytes: 512,
          observation: {
            itemId: `initialization-${randomUUID()}`,
            kind: "gap",
            operation: "append",
            status: "info",
            text: "Visible output initialization ended after its deadline or cancellation. This producer was closed without starting capture.",
          },
        });
        this.#memoryBytes += 512;
        this.#memoryEvents++;
        // Complete late closure on the serial queue even after stop; no network or capture resumes.
        void this.#persistPending().catch(() => this.#failed());
        assertActive();
      }
    });
    this.#opening.set(key, { lease: frozen, operation });
    void operation
      .finally(() => {
        if (this.#opening.get(key)?.operation === operation) this.#opening.delete(key);
      })
      .catch(() => undefined);
    return operation;
  }

  append(
    taskId: string,
    attemptId: string,
    invocationId: string | null,
    observation: ModelOutputObservation,
  ): void {
    if (this.#stopped) return;
    const entry = this.#attempts.get(attemptKey(taskId, attemptId));
    if (entry === undefined || entry.closeRequested) return;
    const protectedValues = [...(this.options.protectedValues ?? []), entry.lease.leaseToken];
    const clean = (value: string) => sanitizeModelOutputText(value, protectedValues);
    // Reconstruct the allowlist even when an embedded caller supplies extra properties.
    const normalized: ModelOutputObservation = {
      itemId: `output-${createHash("sha256")
        .update(`${invocationId ?? "system"}\0${observation.itemId}`)
        .digest("hex")}`,
      kind: observation.kind,
      operation: observation.operation,
      text: clean(observation.text),
      ...(observation.command === undefined ? {} : { command: clean(observation.command) }),
      ...(observation.result === undefined ? {} : { result: clean(observation.result) }),
      ...(observation.status === undefined ? {} : { status: observation.status }),
    };
    const observedAt = this.#now();
    const event: InvestigationOutputEventInput = {
      ...normalized,
      schemaVersion: "InvestigationOutputEventV1",
      attemptId,
      invocationId,
      producerSequence: 1,
      observedAt,
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (
      entry.pendingDropped > 0 ||
      !Value.Check(InvestigationOutputEventInputSchema, event) ||
      bytes > 65_536 ||
      this.#memoryEvents >= 1_024 ||
      this.#memoryBytes + bytes > this.#maximumMemoryBytes
    ) {
      entry.pendingDropped = Math.min(Number.MAX_SAFE_INTEGER, entry.pendingDropped + 1);
    } else {
      entry.pending.push({ invocationId, observation: normalized, observedAt, bytes });
      this.#memoryBytes += bytes;
      this.#memoryEvents++;
    }
    this.#scheduleStorage();
  }

  closeAttempt(taskId: string, attemptId: string): void {
    const entry = this.#attempts.get(attemptKey(taskId, attemptId));
    if (entry === undefined) return;
    entry.closeRequested = true;
    this.#scheduleStorage();
  }

  replay(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    // Polling and flush callers share one storage operation even if disk never settles.
    this.#replay ??= (async () => {
      await this.#serial(() => this.#load());
      await this.#persistPending();
      this.#scheduleDelivery();
    })().finally(() => {
      this.#replay = undefined;
    });
    return this.#replay;
  }

  /** A timeout retains the committed queue for restart; it never waits indefinitely for a viewer. */
  async flush(timeoutMs = 2_000): Promise<boolean> {
    bounded(timeoutMs, 1, 30_000);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          await this.replay();
          await this.#delivery;
          await this.#persistPending();
          return (
            this.#quarantined.size === 0 &&
            [...this.#attempts.values()].every(
              (entry) =>
                entry.pending.length === 0 &&
                entry.pendingDropped === 0 &&
                entry.retained.dropped === 0 &&
                entry.retained.batches.length === 0,
            )
          );
        })(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async stop(timeoutMs = 2_000): Promise<boolean> {
    let complete = false;
    try {
      complete = await this.flush(timeoutMs);
    } finally {
      this.#stopped = true;
      this.#lifetime.abort();
      if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    }
    return complete;
  }

  #scheduleStorage(): void {
    if (this.#storagePump !== undefined || this.#stopped) return;
    this.#storagePump = this.#persistPending()
      .catch(() => this.#failed())
      .finally(() => {
        this.#storagePump = undefined;
        this.#scheduleDelivery();
      });
  }

  #persistPending(): Promise<void> {
    return this.#serial(async () => {
      await this.#load();
      for (const entry of this.#attempts.values()) {
        if (
          !entry.pending.length &&
          !entry.pendingDropped &&
          !entry.retained.dropped &&
          entry.terminalDeliveryFailure === undefined &&
          (!entry.closeRequested || !entry.retained.open)
        )
          continue;
        const pendingCount = entry.pending.length;
        const droppedCount = entry.pendingDropped;
        const retained = structuredClone(entry.retained);
        retained.updatedAt = this.#now();
        retained.open = !entry.closeRequested;
        if (entry.terminalDeliveryFailure !== undefined)
          retained.terminalDeliveryFailure = { ...entry.terminalDeliveryFailure };
        let batch: OutputBatch | undefined;
        const add = (
          observation: ModelOutputObservation,
          invocationId: string | null,
          observedAt: string,
        ): boolean => {
          const event: InvestigationOutputEventInput = {
            ...observation,
            schemaVersion: "InvestigationOutputEventV1",
            attemptId: retained.attemptId,
            invocationId,
            producerSequence: retained.nextSequence,
            observedAt,
          };
          const nextBatch: OutputBatch =
            batch === undefined
              ? { batchId: randomUUID(), events: [event] }
              : { ...batch, events: [...batch.events, event] };
          if (
            nextBatch.events.length > maximumInvestigationOutputBatchEvents ||
            Buffer.byteLength(JSON.stringify({ lease: entry.lease, ...nextBatch })) >
              maximumInvestigationOutputBatchBytes
          ) {
            batch = undefined;
            return add(observation, invocationId, observedAt);
          }
          const batches =
            batch === undefined
              ? [...retained.batches, nextBatch]
              : [...retained.batches.slice(0, -1), nextBatch];
          if (
            Buffer.byteLength(JSON.stringify({ ...retained, batches })) >
            this.#maximumAttemptBytes - 512
          )
            return false;
          retained.batches = batches;
          retained.nextSequence++;
          batch = nextBatch;
          return true;
        };
        if (retained.dropped > 0 && add(gap(retained.dropped), null, retained.updatedAt))
          retained.dropped = 0;
        for (const pending of entry.pending.slice(0, pendingCount)) {
          if (
            retained.dropped > 0 ||
            !add(pending.observation, pending.invocationId, pending.observedAt)
          )
            retained.dropped = Math.min(Number.MAX_SAFE_INTEGER, retained.dropped + 1);
        }
        // Memory overflow omits the tail after these admitted observations, never their prefix.
        retained.dropped = Math.min(Number.MAX_SAFE_INTEGER, retained.dropped + droppedCount);
        if (retained.dropped > 0 && add(gap(retained.dropped), null, retained.updatedAt))
          retained.dropped = 0;
        await this.#save(retained);
        entry.retained = retained;
        for (const pending of entry.pending.splice(0, pendingCount)) {
          this.#memoryBytes -= pending.bytes;
          this.#memoryEvents--;
        }
        entry.pendingDropped -= droppedCount;
        if (retained.terminalDeliveryFailure !== undefined) {
          const key = attemptKey(retained.taskId, retained.attemptId);
          const bytes =
            Buffer.byteLength(JSON.stringify(retained)) +
            Buffer.byteLength(JSON.stringify(entry.lease));
          this.#quarantined.set(key, bytes);
          this.#quarantinedBytes += bytes;
          this.#attempts.delete(key);
          this.#terminalFailure(
            retained.taskId,
            retained.attemptId,
            retained.terminalDeliveryFailure.code,
          );
        }
      }
    });
  }

  #scheduleDelivery(): void {
    if (this.#delivery !== undefined || this.#stopped) return;
    const remaining = this.#retryAt - Date.now();
    if (remaining > 0) {
      this.#retryTimer ??= setTimeout(() => {
        this.#retryTimer = undefined;
        this.#scheduleStorage();
      }, remaining);
      this.#retryTimer.unref();
      return;
    }
    this.#delivery = this.#deliver()
      .catch(() => {
        this.#retryAt = Date.now() + this.#retryDelayMs;
        this.#failed();
      })
      .finally(() => {
        this.#delivery = undefined;
        if (
          [...this.#attempts.values()].some(
            (entry) =>
              entry.retained.batches.length || entry.retained.dropped || entry.pending.length,
          )
        ) {
          this.#retryAt = Math.max(this.#retryAt, Date.now() + this.#retryDelayMs);
          this.#scheduleDelivery();
        }
      });
  }

  async #deliver(): Promise<void> {
    for (const entry of this.#attempts.values()) {
      // One attempt's unavailable transport must not starve another attempt's output.
      try {
        // A chatty active producer receives a bounded turn before the next attempt.
        for (
          let delivered = 0;
          delivered < 4 &&
          entry.retained.batches.length &&
          !this.#stopped &&
          entry.terminalDeliveryFailure === undefined;
          delivered++
        ) {
          const batch = structuredClone(entry.retained.batches[0]!);
          const signal = AbortSignal.any([
            this.#lifetime.signal,
            AbortSignal.timeout(this.#requestTimeoutMs),
          ]);
          const response = await untilAborted(
            this.options.deliver(
              entry.retained.taskId,
              { lease: structuredClone(entry.lease), ...batch },
              signal,
            ),
            signal,
          );
          if (
            !Value.Check(InvestigationOutputBatchResponseSchema, response) ||
            response.taskId !== entry.retained.taskId ||
            response.attemptId !== entry.retained.attemptId ||
            response.batchId !== batch.batchId ||
            response.lastAcceptedProducerSequence !== batch.events.at(-1)!.producerSequence
          )
            throw new Error("The visible output acknowledgement does not match its durable batch.");
          await this.#serial(async () => {
            if (entry.retained.batches[0]?.batchId !== batch.batchId)
              throw new Error("The visible output batch delivery order changed.");
            const retained = {
              ...entry.retained,
              batches: entry.retained.batches.slice(1),
              updatedAt: this.#now(),
            };
            await this.#save(retained);
            entry.retained = retained;
          });
          await this.#persistPending();
        }
      } catch (error) {
        if (
          error instanceof InvestigationWorkerClientError &&
          error.statusCode === 409 &&
          error.code === "output_lease_lost" &&
          !error.retryable &&
          entry.retained.batches.length > 0
        ) {
          entry.closeRequested = true;
          entry.terminalDeliveryFailure = {
            code: "output_lease_lost",
            batchId: entry.retained.batches[0]!.batchId,
            recordedAt: this.#now(),
          };
          // Atomically publish the terminal marker in the original bounded sanitized state file.
          // The immutable private lease stays alongside it; no two-file move can lose authority.
          await this.#persistPending();
          continue;
        }
        this.#retryAt = Date.now() + this.#retryDelayMs;
        this.#failed();
      }
    }
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("The output journal directory is unsafe.");
    const names = await readdir(this.options.directory);
    const files = names.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    const published = new Set(files);
    for (const name of names) {
      const temporary = /^[a-f0-9]{64}(?:\.delivery)?\.json\.[a-f0-9-]{36}\.pending$/u.test(name);
      const orphanedLease =
        /^[a-f0-9]{64}\.delivery\.json$/u.test(name) &&
        !published.has(name.replace(/\.delivery\.json$/u, ".json"));
      if (!temporary && !orphanedLease) continue;
      const path = join(this.options.directory, name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("An abandoned output journal entry is unsafe.");
      // These exact Worker-owned names were never atomically published as a public batch.
      await unlink(path);
    }
    if (files.length > this.#maximumAttempts + this.#maximumQuarantinedAttempts)
      throw new Error("The retained output attempt limit was exceeded.");
    const loaded = new Map<string, AttemptOutput>();
    const quarantined = new Map<string, number>();
    const terminalDiagnostics: Array<{ taskId: string; attemptId: string }> = [];
    let quarantinedBytes = 0;
    for (const file of files) {
      const retainedText = await this.#read(file, this.#maximumAttemptBytes);
      const retained: unknown = JSON.parse(retainedText);
      if (!Value.Check(retainedOutputSchema, retained))
        throw new Error("The retained output journal is invalid.");
      const state = retained as RetainedOutput;
      const key = attemptKey(state.taskId, state.attemptId);
      if (file !== `${key}.json`)
        throw new Error("The retained output attempt binding is invalid.");
      const leaseText = await this.#read(`${key}.delivery.json`, maximumDeliveryLeaseBytes);
      const lease: unknown = JSON.parse(leaseText);
      if (
        !Value.Check(InvestigationWorkerLeaseSchema, lease) ||
        lease.attemptId !== state.attemptId
      )
        throw new Error("The retained output delivery lease is invalid.");
      let previous: number | undefined;
      for (const batch of state.batches) {
        if (
          Buffer.byteLength(JSON.stringify({ lease, ...batch })) >
          maximumInvestigationOutputBatchBytes
        )
          throw new Error("The retained output batch exceeds its delivery limit.");
        for (const event of batch.events) {
          if (
            event.attemptId !== state.attemptId ||
            (previous !== undefined && event.producerSequence !== previous + 1)
          )
            throw new Error("The retained output sequence is invalid.");
          previous = event.producerSequence;
        }
      }
      if (previous !== undefined && state.nextSequence !== previous + 1)
        throw new Error("The retained output sequence counter is invalid.");
      if (state.terminalDeliveryFailure !== undefined) {
        if (state.open || state.batches[0]?.batchId !== state.terminalDeliveryFailure.batchId)
          throw new Error("The quarantined visible output identity is invalid.");
        const bytes = Buffer.byteLength(retainedText) + Buffer.byteLength(leaseText);
        quarantined.set(key, bytes);
        terminalDiagnostics.push({ taskId: state.taskId, attemptId: state.attemptId });
        quarantinedBytes += bytes;
        if (
          quarantined.size > this.#maximumQuarantinedAttempts ||
          quarantinedBytes > this.#maximumQuarantinedBytes
        ) {
          this.#terminalFailure(state.taskId, state.attemptId, "output_archive_capacity");
          throw new Error("The retained visible output quarantine capacity was exceeded.");
        }
        continue;
      }
      const entry: AttemptOutput = {
        retained: state,
        lease,
        pending: [],
        pendingDropped: 0,
        closeRequested: !state.open,
      };
      if (state.open) {
        // The previous producer may have died before asynchronous persistence. Never claim completeness.
        entry.pending.push({
          invocationId: null,
          observation: {
            itemId: `restart-${randomUUID()}`,
            kind: "gap",
            operation: "append",
            status: "info",
            text: "The Worker restarted while this output producer was active. Some visible output may be missing.",
          },
          observedAt: this.#now(),
          bytes: 512,
        });
        entry.closeRequested = true;
      }
      loaded.set(key, entry);
      if (loaded.size > this.#maximumAttempts)
        throw new Error("The retained output attempt limit was exceeded.");
    }
    for (const [key, bytes] of quarantined) this.#quarantined.set(key, bytes);
    this.#quarantinedBytes = quarantinedBytes;
    for (const [key, entry] of loaded) {
      this.#attempts.set(key, entry);
      for (const pending of entry.pending) {
        this.#memoryBytes += pending.bytes;
        this.#memoryEvents++;
      }
    }
    this.#loaded = true;
    for (const diagnostic of terminalDiagnostics)
      this.#terminalFailure(diagnostic.taskId, diagnostic.attemptId, "output_lease_lost");
    await this.#prune();
  }

  async #prune(): Promise<void> {
    const cutoff = (this.options.now?.() ?? new Date()).getTime() - this.#retentionMs;
    for (const [key, entry] of this.#attempts) {
      // Undelivered records are never silently discarded. Capacity then fails explicitly instead.
      if (
        entry.retained.open ||
        entry.retained.batches.length ||
        entry.retained.dropped ||
        entry.pending.length ||
        (Date.parse(entry.retained.updatedAt) >= cutoff &&
          this.#attempts.size < this.#maximumAttempts &&
          !this.#archiveCapacityReached())
      )
        continue;
      await unlink(join(this.options.directory, `${key}.json`));
      await unlink(join(this.options.directory, `${key}.delivery.json`)).catch(() =>
        this.#failed(),
      );
      this.#attempts.delete(key);
    }
  }
  async #read(name: string, maximumBytes: number): Promise<string> {
    const path = join(this.options.directory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes)
      throw new Error("The output journal entry is not a bounded regular file.");
    return readFile(path, "utf8");
  }
  #save(retained: RetainedOutput): Promise<void> {
    return this.#write(
      `${attemptKey(retained.taskId, retained.attemptId)}.json`,
      JSON.stringify(retained),
    );
  }
  async #write(name: string, value: string): Promise<void> {
    const path = join(this.options.directory, name);
    const temporary = `${path}.${randomUUID()}.pending`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(value, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#storage.then(work);
    this.#storage = operation.catch(() => undefined);
    return operation;
  }
  #now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  #archiveCapacityReached(): boolean {
    return (
      this.#quarantined.size + this.#attempts.size + 1 > this.#maximumQuarantinedAttempts ||
      this.#quarantinedBytes +
        (this.#attempts.size + 1) * (this.#maximumAttemptBytes + maximumDeliveryLeaseBytes) >
        this.#maximumQuarantinedBytes
    );
  }
  #terminalFailure(
    taskId: string,
    attemptId: string,
    code: "output_lease_lost" | "output_archive_capacity",
  ): void {
    try {
      this.options.onTerminalFailure?.({ taskId, attemptId, code });
    } catch {
      /* Optional output diagnostics cannot change task execution. */
    }
  }
  #failed(): void {
    const now = Date.now();
    if (now - this.#lastFailureNotice < 30_000) return;
    this.#lastFailureNotice = now;
    try {
      this.options.onFailure?.();
    } catch {
      /* Output cannot change execution. */
    }
  }
}

function attemptKey(taskId: string, attemptId: string): string {
  return createHash("sha256").update(`${taskId}\0${attemptId}`).digest("hex");
}
function sameLease(left: InvestigationWorkerLease, right: InvestigationWorkerLease): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.fence === right.fence &&
    left.leaseToken === right.leaseToken
  );
}
function gap(count: number): ModelOutputObservation {
  return {
    itemId: `gap-${randomUUID()}`,
    kind: "gap",
    operation: "append",
    status: "info",
    text: `${count} visible output record(s) were omitted because the bounded Worker output queue was full or the record was invalid.`,
  };
}
function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError("The visible output journal limit is outside its supported range.");
  return value;
}

async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("The visible output delivery deadline expired."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}
