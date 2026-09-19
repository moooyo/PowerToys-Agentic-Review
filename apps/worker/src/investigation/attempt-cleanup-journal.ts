import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { InvestigationWorkerLease } from "@agentic-review/contracts";
import type { ProcessHostRecoverySnapshot } from "../execution/process-host-protocol.js";
import { hasRecoveredProcessHostOwnership } from "./cleanup-recovery-proof.js";
import type { InvestigationWorkspaceOwnershipReceipt } from "./workspace.js";

export interface AttemptCleanupIdentity {
  readonly schemaVersion: "InvestigationAttemptCleanupIdentityV1";
  readonly taskId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly serverOrigin: string;
  readonly lease: InvestigationWorkerLease;
  readonly guardOwnerId: string;
  /** Private recovery credential; never include this identity in a log or API response. */
  readonly guardOwnerToken: string;
  readonly journalDirectory: string;
  readonly workspaceRootDirectory: string;
  readonly desktopLockDirectory: string;
  readonly processHostInstanceKey: string;
  readonly processHostRecovery: ProcessHostRecoverySnapshot | null;
  readonly registeredAt: string;
}

export interface AttemptCleanupState {
  readonly revision: number;
  readonly attemptId: string;
  readonly updatedAt: string;
  readonly executionStarted: boolean;
  readonly localCleanupConfirmed: boolean;
  readonly guardReleased: boolean;
  readonly acknowledged: boolean;
  readonly workspace: InvestigationWorkspaceOwnershipReceipt | null;
  readonly operatorConfirmation: {
    readonly operator: string;
    readonly reason: string;
    readonly confirmedAt: string;
    readonly desktopRestored: true;
    readonly ownedProcessTreeStopped: boolean;
  } | null;
  readonly lastFailure: string | null;
}

export interface AttemptCleanupStatus {
  readonly taskId: string;
  readonly attemptId: string;
  readonly fence: number;
  readonly state: "awaiting_cleanup" | "awaiting_acknowledgement" | "acknowledged";
  readonly executionStarted: boolean;
  readonly localCleanupConfirmed: boolean;
  readonly guardReleased: boolean;
  readonly missingProofs: readonly string[];
  readonly lastFailure: string | null;
}

export interface AttemptCleanupRecoveryActions {
  readonly processHostRecovery: ProcessHostRecoverySnapshot | undefined;
  readonly cleanupWorkspace: (
    identity: AttemptCleanupIdentity,
    ownership: InvestigationWorkspaceOwnershipReceipt | null,
  ) => Promise<void>;
  readonly releaseGuard: (identity: AttemptCleanupIdentity) => Promise<void>;
  readonly acknowledge: (identity: AttemptCleanupIdentity) => Promise<void>;
  readonly activeAttemptIds?: ReadonlySet<string>;
  /** Omit for the startup sweep; target one existing identity for an operator recovery action. */
  readonly attemptId?: string;
}

export interface AttemptCleanupJournalOptions {
  /** Private Worker-owned durable directory, outside every disposable attempt workspace. */
  readonly directory: string;
  readonly now?: () => Date;
}

export type AttemptCleanupJournal = Pick<
  InvestigationAttemptCleanupJournal,
  | "register"
  | "executionStarted"
  | "workspaceOwned"
  | "localCleanupConfirmed"
  | "guardReleased"
  | "acknowledged"
  | "failed"
  | "confirmRecovery"
  | "statuses"
  | "recover"
>;

/** Original leases and append-only fsynced state survive cleanup and Worker process failure. */
export class InvestigationAttemptCleanupJournal {
  readonly #identities = new Map<string, AttemptCleanupIdentity>();
  readonly #states = new Map<string, AttemptCleanupState>();
  #loaded = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AttemptCleanupJournalOptions) {}

  /** Must finish before acquiring a desktop guard, preparing source, or starting any task process. */
  register(
    input: Omit<
      AttemptCleanupIdentity,
      "schemaVersion" | "registeredAt" | "journalDirectory" | "guardOwnerToken"
    >,
  ): Promise<AttemptCleanupIdentity> {
    const snapshot = structuredClone(input);
    return this.#serial(async () => {
      await this.#load();
      if (this.#identities.has(snapshot.attemptId))
        throw new Error("This execution attempt already has a durable cleanup identity.");
      const identity: AttemptCleanupIdentity = {
        ...snapshot,
        schemaVersion: "InvestigationAttemptCleanupIdentityV1",
        registeredAt: this.#now(),
        journalDirectory: resolve(this.options.directory),
        guardOwnerToken: randomUUID(),
      };
      assertIdentity(identity, this.options.directory);
      await this.#write(this.#identityPath(identity.attemptId), identity);
      this.#identities.set(identity.attemptId, identity);
      // A crash before this event is safe: an identity without events has not dispatched work.
      await this.#save(initialState(identity));
      return structuredClone(identity);
    });
  }

  executionStarted(attemptId: string): Promise<void> {
    return this.#change(attemptId, (state) => ({ ...state, executionStarted: true }));
  }

  workspaceOwned(
    attemptId: string,
    workspace: InvestigationWorkspaceOwnershipReceipt,
  ): Promise<void> {
    const snapshot = structuredClone(workspace);
    return this.#change(attemptId, (state, identity) => {
      if (
        !state.executionStarted ||
        snapshot.taskId !== identity.taskId ||
        snapshot.attemptId !== identity.attemptId ||
        snapshot.leaseVersion !== identity.lease.fence ||
        !samePath(snapshot.workspaceRootDirectory, identity.workspaceRootDirectory)
      )
        throw new Error(
          "The cleanup workspace receipt does not match its registered execution owner.",
        );
      if (state.workspace !== null && JSON.stringify(state.workspace) !== JSON.stringify(snapshot))
        throw new Error("A cleanup workspace ownership receipt cannot change.");
      return { ...state, workspace: snapshot };
    });
  }

  localCleanupConfirmed(attemptId: string): Promise<void> {
    return this.#change(attemptId, (state) => ({
      ...state,
      localCleanupConfirmed: true,
      lastFailure: null,
    }));
  }

  guardReleased(attemptId: string): Promise<void> {
    return this.#change(attemptId, (state) => {
      if (!state.localCleanupConfirmed)
        throw new Error("Local cleanup must be confirmed before releasing its guard.");
      return { ...state, guardReleased: true, lastFailure: null };
    });
  }

  acknowledged(attemptId: string): Promise<void> {
    return this.#change(attemptId, (state) => {
      if (!state.localCleanupConfirmed || !state.guardReleased)
        throw new Error("Only a locally cleaned and released attempt can acknowledge cleanup.");
      return { ...state, acknowledged: true, lastFailure: null };
    });
  }

  failed(attemptId: string, code: string): Promise<void> {
    return this.#change(attemptId, (state) =>
      state.acknowledged ? state : { ...state, lastFailure: safeCode(code) },
    );
  }

  /** Explicit local operator action; registration cannot supply these confirmations automatically. */
  confirmRecovery(
    attemptId: string,
    confirmation: {
      operator: string;
      reason: string;
      desktopRestored: true;
      ownedProcessTreeStopped: boolean;
    },
  ): Promise<void> {
    if (
      confirmation.desktopRestored !== true ||
      typeof confirmation.ownedProcessTreeStopped !== "boolean" ||
      !boundedText(confirmation.operator, 256) ||
      !boundedText(confirmation.reason, 2_048)
    )
      return Promise.reject(
        new Error("Cleanup recovery requires an explicit bounded operator confirmation."),
      );
    return this.#change(attemptId, (state) =>
      state.acknowledged
        ? state
        : {
            ...state,
            operatorConfirmation: { ...structuredClone(confirmation), confirmedAt: this.#now() },
            lastFailure: null,
          },
    );
  }

  statuses(current?: ProcessHostRecoverySnapshot): Promise<AttemptCleanupStatus[]> {
    return this.#serial(async () => {
      await this.#load();
      return [...this.#identities.values()].map((identity) =>
        status(identity, this.#state(identity), current),
      );
    });
  }

  /** Recovery never calls an executor or repeats tests; only ownership-checked cleanup is possible. */
  recover(actions: AttemptCleanupRecoveryActions): Promise<AttemptCleanupStatus[]> {
    return this.#serial(async () => {
      await this.#load();
      if (actions.attemptId !== undefined && !this.#identities.has(actions.attemptId))
        throw new Error("The requested cleanup attempt has no retained private identity.");
      for (const identity of this.#identities.values()) {
        if (
          (actions.attemptId !== undefined && actions.attemptId !== identity.attemptId) ||
          actions.activeAttemptIds?.has(identity.attemptId)
        )
          continue;
        let state = this.#state(identity);
        if (state.acknowledged) continue;
        const observation = status(identity, state, actions.processHostRecovery);
        if (observation.missingProofs.length !== 0) continue;
        try {
          if (!state.localCleanupConfirmed) {
            await actions.cleanupWorkspace(
              structuredClone(identity),
              structuredClone(state.workspace),
            );
            state = await this.#save({ ...state, localCleanupConfirmed: true, lastFailure: null });
          }
          if (!state.guardReleased) {
            await actions.releaseGuard(structuredClone(identity));
            state = await this.#save({ ...state, guardReleased: true, lastFailure: null });
          }
          await actions.acknowledge(structuredClone(identity));
          await this.#save({ ...state, acknowledged: true, lastFailure: null });
        } catch (error) {
          // Never persist exception text: transports can include the private original lease.
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? safeCode(error.code)
              : "CLEANUP_RECOVERY_INCOMPLETE";
          await this.#save({ ...state, lastFailure: code });
        }
      }
      return [...this.#identities.values()].map((identity) =>
        status(identity, this.#state(identity), actions.processHostRecovery),
      );
    });
  }

  #change(
    attemptId: string,
    change: (state: AttemptCleanupState, identity: AttemptCleanupIdentity) => AttemptCleanupState,
  ): Promise<void> {
    return this.#serial(async () => {
      await this.#load();
      const identity = this.#identities.get(attemptId);
      if (identity === undefined)
        throw new Error("The cleanup attempt must be registered before any state change.");
      const previous = this.#state(identity);
      const next = change(structuredClone(previous), structuredClone(identity));
      if (previous.acknowledged && JSON.stringify(next) !== JSON.stringify(previous))
        throw new Error("An acknowledged cleanup receipt is immutable.");
      await this.#save(next);
    });
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await assertPrivatePath(this.options.directory, "directory");
    const names = (await readdir(this.options.directory)).sort();
    // A crash can occur after publishing a hard link but before removing its private temporary name.
    // Remove only a matching inode pair; never repair an unrelated or redirected file.
    for (const name of names) {
      const match = /^(.*\.json)\.[a-f0-9-]{36}\.pending$/u.exec(name);
      if (match === null) continue;
      const temporary = join(this.options.directory, name);
      const published = join(this.options.directory, match[1]!);
      try {
        const [before, after] = await Promise.all([lstat(temporary), lstat(published)]);
        if (
          before.isFile() &&
          after.isFile() &&
          !before.isSymbolicLink() &&
          !after.isSymbolicLink() &&
          before.dev === after.dev &&
          before.ino === after.ino &&
          before.nlink === 2 &&
          after.nlink === 2
        )
          await unlink(temporary);
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.identity\.json$/u.test(name)) continue;
      const value: unknown = await this.#read(join(this.options.directory, name));
      assertIdentity(value, this.options.directory);
      if (this.#identityPath(value.attemptId) !== join(this.options.directory, name))
        throw new Error("The retained cleanup identity has an invalid file binding.");
      this.#identities.set(value.attemptId, value);
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.\d+\.state\.json$/u.test(name)) continue;
      const value: unknown = await this.#read(join(this.options.directory, name));
      assertState(value);
      const identity = this.#identities.get(value.attemptId);
      if (identity === undefined || this.#statePath(value) !== join(this.options.directory, name))
        throw new Error("The retained cleanup state has no matching original identity.");
      const previous = this.#states.get(value.attemptId);
      if (previous === undefined || previous.revision < value.revision)
        this.#states.set(value.attemptId, value);
    }
    this.#loaded = true;
  }

  #state(identity: AttemptCleanupIdentity): AttemptCleanupState {
    return this.#states.get(identity.attemptId) ?? initialState(identity);
  }

  async #save(input: AttemptCleanupState): Promise<AttemptCleanupState> {
    const previous = this.#states.get(input.attemptId);
    if (
      previous !== undefined &&
      JSON.stringify({ ...input, revision: previous.revision, updatedAt: previous.updatedAt }) ===
        JSON.stringify(previous)
    )
      return previous;
    const next = { ...input, revision: (previous?.revision ?? 0) + 1, updatedAt: this.#now() };
    assertState(next);
    await this.#write(this.#statePath(next), next);
    this.#states.set(next.attemptId, next);
    return next;
  }

  async #read(path: string): Promise<unknown> {
    await assertPrivatePath(path, "file");
    const state = await lstat(path);
    if (state.size > 64 * 1024) throw new Error("The retained cleanup record is too large.");
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new Error("The retained cleanup record is invalid.");
    }
  }

  async #write(path: string, value: unknown): Promise<void> {
    await assertPrivatePath(this.options.directory, "directory");
    const temporary = `${path}.${randomUUID()}.pending`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(value), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  #identityPath(attemptId: string): string {
    return join(this.options.directory, `${hash(attemptId)}.identity.json`);
  }
  #statePath(state: Pick<AttemptCleanupState, "attemptId" | "revision">): string {
    return join(this.options.directory, `${hash(state.attemptId)}.${state.revision}.state.json`);
  }
  #now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(work);
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

function initialState(identity: AttemptCleanupIdentity): AttemptCleanupState {
  return {
    revision: 0,
    attemptId: identity.attemptId,
    updatedAt: identity.registeredAt,
    executionStarted: false,
    localCleanupConfirmed: false,
    guardReleased: false,
    acknowledged: false,
    workspace: null,
    operatorConfirmation: null,
    lastFailure: null,
  };
}

function status(
  identity: AttemptCleanupIdentity,
  state: AttemptCleanupState,
  current?: ProcessHostRecoverySnapshot,
): AttemptCleanupStatus {
  const noExecution = !state.executionStarted;
  const processesStopped =
    noExecution ||
    state.localCleanupConfirmed ||
    state.operatorConfirmation?.ownedProcessTreeStopped === true ||
    hasRecoveredProcessHostOwnership(identity.processHostRecovery ?? undefined, current);
  const desktopRestored =
    noExecution ||
    state.localCleanupConfirmed ||
    state.operatorConfirmation?.desktopRestored === true;
  return {
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    fence: identity.lease.fence,
    state: state.acknowledged
      ? "acknowledged"
      : state.guardReleased
        ? "awaiting_acknowledgement"
        : "awaiting_cleanup",
    executionStarted: state.executionStarted,
    localCleanupConfirmed: state.localCleanupConfirmed,
    guardReleased: state.guardReleased,
    missingProofs: [
      ...(!processesStopped ? ["owned_process_tree_stopped"] : []),
      ...(!desktopRestored ? ["desktop_restored"] : []),
    ],
    lastFailure: state.lastFailure,
  };
}

function assertIdentity(
  value: unknown,
  directory: string,
): asserts value is AttemptCleanupIdentity {
  const input = value as AttemptCleanupIdentity | null;
  if (
    input === null ||
    typeof input !== "object" ||
    input.schemaVersion !== "InvestigationAttemptCleanupIdentityV1" ||
    !id(input.taskId) ||
    !id(input.attemptId) ||
    !id(input.workerId) ||
    !validOrigin(input.serverOrigin) ||
    !input.lease ||
    input.lease.attemptId !== input.attemptId ||
    !Number.isSafeInteger(input.lease.fence) ||
    input.lease.fence < 0 ||
    !boundedText(input.lease.leaseToken, 4096) ||
    input.guardOwnerId !== `${input.attemptId}:${input.lease.fence}` ||
    !/^[a-f0-9-]{36}$/u.test(input.guardOwnerToken) ||
    !samePath(input.journalDirectory, directory) ||
    !boundedText(input.workspaceRootDirectory, 32767) ||
    !boundedText(input.desktopLockDirectory, 32767) ||
    !/^[a-f0-9]{64}$/u.test(input.processHostInstanceKey) ||
    !validDate(input.registeredAt) ||
    (input.processHostRecovery !== null &&
      (!validRecovery(input.processHostRecovery) ||
        input.processHostRecovery.instanceKey !== input.processHostInstanceKey))
  )
    throw new Error(
      "The retained cleanup identity is invalid or belongs to another Worker directory.",
    );
}

function assertState(value: unknown): asserts value is AttemptCleanupState {
  const state = value as AttemptCleanupState | null;
  if (
    state === null ||
    typeof state !== "object" ||
    !id(state.attemptId) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !validDate(state.updatedAt) ||
    [
      state.executionStarted,
      state.localCleanupConfirmed,
      state.guardReleased,
      state.acknowledged,
    ].some((entry) => typeof entry !== "boolean") ||
    (state.guardReleased && !state.localCleanupConfirmed) ||
    (state.acknowledged && !state.guardReleased) ||
    (state.workspace !== null &&
      (typeof state.workspace !== "object" ||
        state.workspace?.schemaVersion !== "InvestigationWorkspaceOwnershipReceiptV1")) ||
    (state.operatorConfirmation !== null &&
      (!state.operatorConfirmation ||
        state.operatorConfirmation.desktopRestored !== true ||
        typeof state.operatorConfirmation.ownedProcessTreeStopped !== "boolean" ||
        !boundedText(state.operatorConfirmation.operator, 256) ||
        !boundedText(state.operatorConfirmation.reason, 2048) ||
        !validDate(state.operatorConfirmation.confirmedAt))) ||
    (state.lastFailure !== null && safeCode(state.lastFailure) !== state.lastFailure)
  )
    throw new Error("The retained cleanup state is invalid.");
}

function validRecovery(value: ProcessHostRecoverySnapshot): boolean {
  return (
    value?.capability === "named-job-tree-v1" &&
    value.previousTreeDrained === true &&
    /^[a-f0-9]{64}$/u.test(value.instanceKey) &&
    /^[a-f0-9]{64}$/u.test(value.generation)
  );
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\0\r\n]/u.test(value)
  );
}
function validDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function safeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value)
    ? value
    : "CLEANUP_RECOVERY_INCOMPLETE";
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function samePath(first: string, second: string): boolean {
  if (typeof first !== "string" || typeof second !== "string") return false;
  return process.platform === "win32"
    ? resolve(first).toLowerCase() === resolve(second).toLowerCase()
    : resolve(first) === resolve(second);
}

async function assertPrivatePath(path: string, kind: "file" | "directory"): Promise<void> {
  let current = resolve(path);
  let expected = kind;
  for (;;) {
    const state = await lstat(current);
    const reparseAware = state as typeof state & { isReparsePoint?(): boolean };
    if (
      (expected === "file" ? !state.isFile() || state.nlink !== 1 : !state.isDirectory()) ||
      state.isSymbolicLink() ||
      reparseAware.isReparsePoint?.() === true ||
      !samePath(await realpath(current), current)
    )
      throw new Error("The cleanup journal contains an unsafe or redirected path.");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
    expected = "directory";
  }
}
