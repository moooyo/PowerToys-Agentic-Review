import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type InvestigationModelInvocationIdentity,
  type InvestigationModelInvocationReceipt,
  InvestigationModelInvocationReceiptSchema,
  type InvestigationWorkerLease,
  InvestigationWorkerLeaseSchema,
  unavailableInvestigationTokenUsage,
  validateInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { registerWorkerContractFormats } from "../contracts-formats.js";
import {
  type ProcessHostRecoverySnapshot,
  ProcessHostRecoverySnapshotSchema,
} from "../execution/process-host-protocol.js";
import { hasRecoveredProcessHostOwnership } from "./cleanup-recovery-proof.js";

interface ModelUsageDeliveryContext {
  readonly lease?: InvestigationWorkerLease;
  readonly nativeOwnership?: ProcessHostRecoverySnapshot;
}

export type ModelInvocationContext = Pick<
  InvestigationModelInvocationIdentity,
  "taskId" | "attemptId" | "purpose" | "engine" | "model"
>;
export type ModelUsageReceiptUpdate = Partial<
  Pick<InvestigationModelInvocationReceipt, "state" | "disposition" | "usage" | "completeness">
>;

export interface ModelUsageDeliveryAcknowledgement {
  readonly executionAllowed?: boolean;
}

export interface ModelUsageJournalOptions {
  /** A Worker-owned durable directory outside disposable attempt workspaces. */
  readonly directory: string;
  /** Must acknowledge this exact revision only after its durable Server commit. */
  readonly deliver?: (
    receipt: InvestigationModelInvocationReceipt,
    lease: InvestigationWorkerLease | undefined,
  ) => Promise<void | ModelUsageDeliveryAcknowledgement>;
  readonly now?: () => Date;
  readonly createInvocationId?: () => string;
}

/** Immutable, fsynced receipts survive process failure and can be delivered idempotently. */
export class InvestigationModelUsageJournal {
  readonly #options: ModelUsageJournalOptions;
  readonly #latest = new Map<string, InvestigationModelInvocationReceipt>();
  #tail: Promise<unknown> = Promise.resolve();
  #loaded = false;

  constructor(options: ModelUsageJournalOptions) {
    registerWorkerContractFormats();
    this.#options = options;
  }

  /** Await registration before dispatching any actual model process. */
  begin(
    context: ModelInvocationContext,
    lease?: InvestigationWorkerLease,
    nativeOwnership?: ProcessHostRecoverySnapshot,
  ): Promise<InvestigationModelInvocationReceipt> {
    const frozenContext = structuredClone(context);
    const frozenLease = lease === undefined ? undefined : structuredClone(lease);
    const frozenOwnership =
      nativeOwnership === undefined ? undefined : structuredClone(nativeOwnership);
    return this.#serial(async () => {
      await this.#load();
      const now = this.#now();
      const receipt: InvestigationModelInvocationReceipt = {
        ...frozenContext,
        invocationId: this.#options.createInvocationId?.() ?? randomUUID(),
        startedAt: now,
        updatedAt: now,
        revision: 1,
        state: "registered",
        disposition: "pending",
        completeness: "unavailable",
        usage: unavailableInvestigationTokenUsage(),
      };
      if (this.#latest.has(receipt.invocationId))
        throw new Error("The model invocation ID was already registered.");
      if (
        frozenOwnership !== undefined &&
        !Value.Check(ProcessHostRecoverySnapshotSchema, frozenOwnership)
      )
        throw new Error("The model invocation native ownership proof is invalid.");
      if (frozenLease !== undefined) {
        if (
          !Value.Check(InvestigationWorkerLeaseSchema, frozenLease) ||
          frozenLease.attemptId !== receipt.attemptId
        )
          throw new Error("The model invocation delivery lease does not match its attempt.");
      }
      if (frozenLease !== undefined || frozenOwnership !== undefined) {
        // Preserve both the original delivery fence and native generation before
        // dispatch. Neither belongs in a public accounting receipt.
        await this.#writeExclusive(
          this.#deliveryPath(receipt.invocationId),
          JSON.stringify({
            ...(frozenLease === undefined ? {} : { lease: frozenLease }),
            ...(frozenOwnership === undefined ? {} : { nativeOwnership: frozenOwnership }),
          }),
        );
      }
      await this.#persist(receipt);
      let acknowledgement: ModelUsageDeliveryAcknowledgement | undefined;
      try {
        acknowledgement = await this.#deliver(receipt);
      } catch (error) {
        // Dispatch has not happened. Retain the failed registration so recovery cannot
        // mistake it for a live process or a call whose tokens are still outstanding.
        await this.#persist(failedRegistration(receipt));
        throw error;
      }
      if (acknowledgement?.executionAllowed === false) {
        const rejected = failedRegistration(receipt);
        await this.#persist(rejected);
        try {
          await this.#deliver(rejected);
        } catch {
          /* The durable zero-consumption receipt remains pending for replay. */
        }
        throw new Error("The model invocation was not admitted for execution.");
      }
      return structuredClone(receipt);
    });
  }

  update(
    invocationId: string,
    patch: ModelUsageReceiptUpdate,
  ): Promise<InvestigationModelInvocationReceipt> {
    return this.#serial(async () => {
      await this.#load();
      const previous = this.#latest.get(invocationId);
      if (previous === undefined)
        throw new Error("The model invocation must be registered before reporting usage.");
      const receipt: InvestigationModelInvocationReceipt = {
        ...previous,
        ...structuredClone(patch),
        revision: previous.revision + 1,
        updatedAt: new Date(
          Math.max(Date.parse(previous.updatedAt), Date.parse(this.#now())),
        ).toISOString(),
      };
      assertTransition(previous, receipt);
      await this.#persist(receipt);
      // Replay any earlier unacknowledged revisions before delivering this new one.
      await this.#deliverPending(invocationId);
      return structuredClone(receipt);
    });
  }

  /** Startup and heartbeat recovery resend receipts, never restart their model invocations. */
  replay(): Promise<void> {
    return this.#serial(async () => {
      await this.#load();
      await this.#deliverPending();
    });
  }

  /** Only a validated replacement native Host can prove that these invocation trees stopped. */
  closeInterruptedInvocations(current: ProcessHostRecoverySnapshot): Promise<number> {
    const proof = structuredClone(current);
    return this.#serial(async () => {
      if (!Value.Check(ProcessHostRecoverySnapshotSchema, proof)) return 0;
      await this.#load();
      let closed = 0;
      for (const previous of [...this.#latest.values()]) {
        if (!["registered", "running"].includes(previous.state)) continue;
        const retained = await this.#deliveryContext(previous);
        if (!hasRecoveredProcessHostOwnership(retained?.nativeOwnership, proof)) continue;
        const receipt: InvestigationModelInvocationReceipt = {
          ...previous,
          revision: previous.revision + 1,
          updatedAt: new Date(
            Math.max(Date.parse(previous.updatedAt), Date.parse(this.#now())),
          ).toISOString(),
          state: "failed",
          disposition: previous.disposition === "pending" ? "rejected" : previous.disposition,
        };
        // A drained tree proves termination, never zero or complete usage. Retain
        // every provider counter and its original completeness without inference.
        assertTransition(previous, receipt);
        await this.#persist(receipt);
        closed++;
      }
      return closed;
    });
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    await mkdir(this.#options.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.#options.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("The usage journal must be a Worker-owned directory.");
    for (const receipt of await this.#receipts()) {
      const previous = this.#latest.get(receipt.invocationId);
      if (previous === undefined || receipt.revision > previous.revision)
        this.#latest.set(receipt.invocationId, receipt);
    }
    this.#loaded = true;
  }

  async #persist(receipt: InvestigationModelInvocationReceipt): Promise<void> {
    if (
      !Value.Check(InvestigationModelInvocationReceiptSchema, receipt) ||
      !validateInvestigationTokenUsage(receipt.usage)
    )
      throw new Error("The model invocation usage receipt is invalid.");
    await this.#writeExclusive(this.#path(receipt), JSON.stringify(receipt));
    this.#latest.set(receipt.invocationId, structuredClone(receipt));
  }

  async #deliverPending(invocationId?: string): Promise<void> {
    for (const receipt of await this.#receipts()) {
      if (invocationId !== undefined && receipt.invocationId !== invocationId) continue;
      const acknowledgement = await this.#deliver(receipt);
      if (
        receipt.revision === 1 &&
        receipt.state === "registered" &&
        acknowledgement?.executionAllowed === false &&
        this.#latest.get(receipt.invocationId)?.revision === 1
      ) {
        // Recover a crash between the denied registration ACK and its zero receipt.
        const rejected = failedRegistration(receipt);
        await this.#persist(rejected);
        await this.#deliver(rejected);
      }
    }
  }

  async #deliver(
    receipt: InvestigationModelInvocationReceipt,
  ): Promise<ModelUsageDeliveryAcknowledgement | undefined> {
    if (this.#options.deliver === undefined) return;
    const acknowledged = `${this.#path(receipt)}.ack`;
    try {
      const stat = await lstat(acknowledged);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384)
        throw new Error("The usage acknowledgement is not a bounded regular file.");
      let value: unknown;
      try {
        value = JSON.parse(await readFile(acknowledged, "utf8"));
      } catch {
        throw new Error("The retained usage acknowledgement is invalid.");
      }
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("invocationId" in value) ||
        value.invocationId !== receipt.invocationId ||
        !("revision" in value) ||
        value.revision !== receipt.revision ||
        Object.keys(value).some(
          (key) => !["invocationId", "revision", "executionAllowed"].includes(key),
        ) ||
        ("executionAllowed" in value && typeof value.executionAllowed !== "boolean")
      )
        throw new Error("The retained usage acknowledgement is invalid.");
      return "executionAllowed" in value
        ? { executionAllowed: value.executionAllowed as boolean }
        : undefined;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const delivered = await this.#options.deliver(
      structuredClone(receipt),
      await this.#deliveryLease(receipt),
    );
    if (
      delivered !== undefined &&
      (typeof delivered !== "object" ||
        delivered === null ||
        (delivered.executionAllowed !== undefined &&
          typeof delivered.executionAllowed !== "boolean"))
    )
      throw new Error("The model usage delivery acknowledgement is invalid.");
    const acknowledgement =
      typeof delivered === "object" && delivered.executionAllowed !== undefined
        ? { executionAllowed: delivered.executionAllowed }
        : undefined;
    await this.#writeExclusive(
      acknowledged,
      JSON.stringify({
        invocationId: receipt.invocationId,
        revision: receipt.revision,
        ...acknowledgement,
      }),
    );
    return acknowledgement;
  }

  async #receipts(): Promise<InvestigationModelInvocationReceipt[]> {
    const receipts: InvestigationModelInvocationReceipt[] = [];
    for (const name of await readdir(this.#options.directory)) {
      if (!/^[a-f0-9]+\.\d+\.json$/u.test(name)) continue;
      const path = join(this.#options.directory, name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576)
        throw new Error("The retained usage receipt is not a bounded regular file.");
      const receipt: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        !Value.Check(InvestigationModelInvocationReceiptSchema, receipt) ||
        !validateInvestigationTokenUsage(receipt.usage) ||
        this.#path(receipt) !== path
      )
        throw new Error("The retained usage receipt is invalid.");
      receipts.push(receipt);
    }
    return receipts.sort(
      (a, b) => a.invocationId.localeCompare(b.invocationId) || a.revision - b.revision,
    );
  }

  async #writeExclusive(path: string, text: string): Promise<void> {
    const pendingPath = `${path}.${randomUUID()}.pending`;
    const handle = await open(pendingPath, "wx", 0o600);
    try {
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A hard link publishes only the fully fsynced file and never replaces a
      // prior receipt. A crash leaves at most an ignored, owned pending file.
      await link(pendingPath, path);
    } finally {
      // Publication is already committed if linking succeeded. A failed cleanup
      // must not make a caller retry that immutable revision with different data.
      await unlink(pendingPath).catch(() => undefined);
    }
  }
  #path(receipt: Pick<InvestigationModelInvocationReceipt, "invocationId" | "revision">): string {
    return join(
      this.#options.directory,
      `${Buffer.from(receipt.invocationId).toString("hex")}.${receipt.revision}.json`,
    );
  }
  #deliveryPath(invocationId: string): string {
    return join(
      this.#options.directory,
      `${Buffer.from(invocationId).toString("hex")}.delivery.json`,
    );
  }
  async #deliveryLease(
    receipt: InvestigationModelInvocationReceipt,
  ): Promise<InvestigationWorkerLease | undefined> {
    return (await this.#deliveryContext(receipt))?.lease;
  }
  async #deliveryContext(
    receipt: InvestigationModelInvocationReceipt,
  ): Promise<ModelUsageDeliveryContext | undefined> {
    const path = this.#deliveryPath(receipt.invocationId);
    let text: string;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384)
        throw new Error("The model usage delivery context is not a bounded regular file.");
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let context: unknown;
    try {
      context = JSON.parse(text);
    } catch {
      throw new Error("The model usage delivery context is invalid.");
    }
    if (
      typeof context !== "object" ||
      context === null ||
      Array.isArray(context) ||
      Object.keys(context).length === 0 ||
      Object.keys(context).some((key) => !["lease", "nativeOwnership"].includes(key)) ||
      ("lease" in context &&
        (!Value.Check(InvestigationWorkerLeaseSchema, context.lease) ||
          context.lease.attemptId !== receipt.attemptId)) ||
      ("nativeOwnership" in context &&
        !Value.Check(ProcessHostRecoverySnapshotSchema, context.nativeOwnership))
    )
      throw new Error("The model usage delivery context is invalid.");
    return context as ModelUsageDeliveryContext;
  }
  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(work);
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function failedRegistration(
  receipt: InvestigationModelInvocationReceipt,
): InvestigationModelInvocationReceipt {
  return {
    ...receipt,
    revision: 2,
    state: "failed",
    disposition: "rejected",
    completeness: "complete",
    usage: { ...unavailableInvestigationTokenUsage(), totalTokens: 0 },
  };
}

function assertTransition(
  previous: InvestigationModelInvocationReceipt,
  next: InvestigationModelInvocationReceipt,
): void {
  if (!["registered", "running"].includes(previous.state) && previous.state !== next.state)
    throw new Error("A model invocation cannot change its terminal state.");
  if (previous.state === "running" && next.state === "registered")
    throw new Error("A model invocation cannot return to registration.");
  if (previous.disposition !== "pending" && previous.disposition !== next.disposition)
    throw new Error("A model invocation cannot change its recorded disposition.");
  if (previous.completeness === "complete" && next.completeness !== "complete")
    throw new Error("Complete model usage cannot become incomplete.");
  const before: Record<string, number | null> = { ...previous.usage.providerCounters };
  const after: Record<string, number | null> = { ...next.usage.providerCounters };
  for (const field of [
    "inputTokens",
    "cachedReadTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheWriteTokens",
    "totalTokens",
  ] as const) {
    before[`token.${field}`] = previous.usage[field];
    after[`token.${field}`] = next.usage[field];
  }
  for (const [field, value] of Object.entries(before)) {
    if (value === null) continue;
    const newer = Object.hasOwn(after, field) ? after[field] : undefined;
    if (newer == null || newer < value || (previous.completeness === "complete" && newer !== value))
      throw new Error("A model invocation cannot change already reported consumption.");
  }
}
