import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  type AssetAttestation,
  type AssetVerificationSnapshot,
  checkAssetSnapshot,
  checkScenarioObservationAttestation,
  checkScenarioObservationSelection,
  checkSnapshotRoot,
  checkVerificationSchema,
  createEvidenceClockMonitor,
  type EvidenceAttestation,
  type EvidenceSnapshot,
  EvidenceVerificationError,
  type EvidenceVerificationFailureCode,
  type EvidenceVerificationRequest,
  EvidenceVerificationRequestSchema,
  type EvidenceVerificationResponse,
  EvidenceVerificationResponseSchema,
  type EvidenceVerificationRoot,
  EvidenceVerificationRootSchema,
  evidenceCanonicalJson,
  evidenceSnapshotDigest,
  type IdentityAttestation,
  type IdentityProbeSnapshot,
  IdentityProbeSnapshotSchema,
  reusableEvidenceVerification,
  type ScenarioAttestation,
  type ScenarioVerificationSnapshot,
  ScenarioVerificationSnapshotSchema,
  sameEvidenceIdentity,
  verificationFailure,
} from "./evidence-verification-protocol.js";

export interface EvidenceVerifierTransport {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
}
export interface EvidenceVerificationClientOptions {
  readonly storageRoot: EvidenceVerificationRoot;
  readonly maximumQueuedTasks?: number;
  readonly maximumWaiters?: number;
  readonly maximumCacheBytes?: number;
  readonly maximumCacheEntries?: number;
  readonly operationTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}
export interface EvidenceVerificationRequestOptions {
  readonly priority?: "foreground" | "background";
}
interface Waiter {
  resolve(value: EvidenceAttestation): void;
  reject(error: Error): void;
  signal: AbortSignal;
  onAbort(): void;
}
interface Task {
  key: string;
  request: EvidenceVerificationRequest;
  priority: "foreground" | "background";
  waiters: Set<Waiter>;
  started: boolean;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout>;
}
interface CacheEntry {
  attestation: AssetAttestation | ScenarioAttestation;
  bytes: number;
}
const testAttachment = Symbol("evidence-verifier-test-transport");
function integer(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
  return result;
}
function probeFor(
  snapshot: AssetVerificationSnapshot | ScenarioVerificationSnapshot,
): IdentityProbeSnapshot {
  return "asset" in snapshot
    ? {
        storage: snapshot.storage,
        assets: [
          {
            assetId: snapshot.asset.id,
            state: snapshot.asset.state,
            expectedFile: snapshot.expectedFile,
          },
        ],
      }
    : {
        storage: snapshot.storage,
        assets: [
          {
            assetId: snapshot.steps.asset.id,
            state: snapshot.steps.asset.state,
            expectedFile: snapshot.steps.expectedFile,
          },
          ...snapshot.dependencies.map((item) => ({
            assetId: item.asset.id,
            state: item.asset.state,
            expectedFile: item.expectedFile,
          })),
        ],
      };
}

export class EvidenceVerificationClient {
  readonly #transport: EvidenceVerifierTransport;
  readonly #root: EvidenceVerificationRoot;
  readonly #queueLimit: number;
  readonly #waiterLimit: number;
  readonly #cacheLimit: number;
  readonly #entryLimit: number;
  readonly #timeout: number;
  readonly #closeTimeout: number;
  readonly #tasks = new Map<string, Task>();
  readonly #nonces = new Map<string, Task>();
  readonly #cache = new Map<string, CacheEntry>();
  readonly #clock = createEvidenceClockMonitor();
  #cacheClockStable = true;
  readonly #exited: Promise<void>;
  readonly #startupTimer: ReturnType<typeof setTimeout>;
  #cacheBytes = 0;
  #waiters = 0;
  #foregroundStreak = 0;
  #ready = false;
  #closing = false;
  #failure: EvidenceVerificationError | undefined;
  #closePromise: Promise<void> | undefined;
  constructor(options: EvidenceVerificationClientOptions);
  constructor(options: EvidenceVerificationClientOptions, transport?: EvidenceVerifierTransport) {
    this.#root = structuredClone(
      checkVerificationSchema(EvidenceVerificationRootSchema, options.storageRoot),
    );
    this.#queueLimit = integer(options.maximumQueuedTasks, 32, 32);
    this.#waiterLimit = integer(options.maximumWaiters, 64, 256);
    this.#cacheLimit = integer(options.maximumCacheBytes, 16 * 1024 * 1024, 16 * 1024 * 1024);
    this.#entryLimit = integer(options.maximumCacheEntries, 10000, 10000);
    this.#timeout = integer(options.operationTimeoutMs, 20000, 120000);
    this.#closeTimeout = integer(options.closeTimeoutMs, 5000, 10000);
    this.#transport =
      transport ??
      new Worker(new URL("./evidence-verification-worker.js", import.meta.url), {
        workerData: this.#root,
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
    this.#exited = new Promise((resolve) => {
      this.#transport.on("exit", () => {
        resolve();
        if (!this.#closing && this.#failure === undefined)
          this.#fail("EVIDENCE_VERIFIER_UNAVAILABLE");
      });
    });
    this.#transport.on("message", (message) => this.#onMessage(message));
    this.#transport.on("error", () => this.#fail("EVIDENCE_VERIFIER_UNAVAILABLE"));
    this.#startupTimer = setTimeout(() => this.#fail("EVIDENCE_VERIFIER_TIMEOUT"), this.#timeout);
    this.#startupTimer.unref();
  }
  static [testAttachment](
    transport: EvidenceVerifierTransport,
    options: EvidenceVerificationClientOptions,
  ): EvidenceVerificationClient {
    // Test injection never changes the production Worker URL or enables a script-path setting.
    const Constructor: new (
      options: EvidenceVerificationClientOptions,
      transport?: EvidenceVerifierTransport,
    ) => EvidenceVerificationClient = EvidenceVerificationClient;
    return new Constructor(options, transport);
  }
  async verifyAsset(
    snapshot: AssetVerificationSnapshot,
    signal: AbortSignal,
    options: EvidenceVerificationRequestOptions = {},
  ): Promise<AssetAttestation> {
    checkAssetSnapshot(snapshot);
    const result = await this.#cached(
      "verify_asset",
      structuredClone(snapshot),
      signal,
      options.priority ?? "foreground",
    );
    if (result.kind !== "asset_verified") return verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    return result;
  }

  /** Unprobed cache state only. Admission must separately await a fresh identity probe. */
  peekAssetAttestation(snapshot: AssetVerificationSnapshot): AssetAttestation | null {
    this.#checkClock();
    checkAssetSnapshot(snapshot);
    checkSnapshotRoot(this.#root, snapshot.storage);
    if (this.#closing || this.#failure !== undefined) return null;
    const cached = this.#cache.get(`verify_asset:${evidenceSnapshotDigest(snapshot)}`)?.attestation;
    return cached?.kind === "asset_verified" ? structuredClone(cached) : null;
  }

  /** Unprobed cache state only. It does not certify current file or database availability. */
  peekScenarioAttestation(snapshot: ScenarioVerificationSnapshot): ScenarioAttestation | null {
    this.#checkClock();
    checkVerificationSchema(ScenarioVerificationSnapshotSchema, snapshot);
    checkScenarioObservationSelection(snapshot);
    checkSnapshotRoot(this.#root, snapshot.storage);
    if (this.#closing || this.#failure !== undefined) return null;
    const cached = this.#cache.get(
      `verify_scenario:${evidenceSnapshotDigest(snapshot)}`,
    )?.attestation;
    return cached?.kind === "scenario_verified" ? structuredClone(cached) : null;
  }
  async verifyScenario(
    snapshot: ScenarioVerificationSnapshot,
    signal: AbortSignal,
    options: EvidenceVerificationRequestOptions = {},
  ): Promise<ScenarioAttestation> {
    checkVerificationSchema(ScenarioVerificationSnapshotSchema, snapshot);
    checkScenarioObservationSelection(snapshot);
    const result = await this.#cached(
      "verify_scenario",
      structuredClone(snapshot),
      signal,
      options.priority ?? "foreground",
    );
    if (result.kind !== "scenario_verified")
      return verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    return result;
  }
  async probeIdentities(
    snapshot: IdentityProbeSnapshot,
    signal: AbortSignal,
  ): Promise<IdentityAttestation> {
    checkVerificationSchema(IdentityProbeSnapshotSchema, snapshot);
    const result = await this.#enqueue(
      "probe_identities",
      structuredClone(snapshot),
      signal,
      "foreground",
    );
    if (result.kind !== "identities_probed")
      return verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    return result;
  }
  async #cached(
    type: "verify_asset" | "verify_scenario",
    snapshot: AssetVerificationSnapshot | ScenarioVerificationSnapshot,
    signal: AbortSignal,
    priority: "foreground" | "background",
  ): Promise<AssetAttestation | ScenarioAttestation> {
    this.#assertAvailable(signal);
    checkSnapshotRoot(this.#root, snapshot.storage);
    const key = `${type}:${evidenceSnapshotDigest(snapshot)}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      try {
        const fresh = await this.probeIdentities(probeFor(snapshot), signal);
        this.#assertAvailable(signal);
        if (!fresh.matches) verificationFailure("EVIDENCE_FILE_CHANGED");
        this.#remember(key, cached.attestation);
        return structuredClone(cached.attestation);
      } catch (error) {
        this.#removeCache(key);
        throw error;
      }
    }
    const result = await this.#enqueue(type, snapshot, signal, priority);
    if (result.kind === "identities_probed")
      return verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    return result;
  }
  #assertAvailable(signal: AbortSignal): void {
    this.#checkClock();
    if (!(signal instanceof AbortSignal)) verificationFailure("EVIDENCE_INVALID_SNAPSHOT");
    if (signal.aborted) verificationFailure("EVIDENCE_VERIFIER_CANCELLED");
    if (this.#closing) verificationFailure("EVIDENCE_VERIFIER_SHUTDOWN");
    if (this.#failure !== undefined) throw this.#failure;
  }
  #enqueue(
    type: EvidenceVerificationRequest["type"],
    snapshot: EvidenceSnapshot,
    signal: AbortSignal,
    priority: "foreground" | "background",
  ): Promise<EvidenceAttestation> {
    this.#assertAvailable(signal);
    checkSnapshotRoot(this.#root, snapshot.storage);
    const snapshotDigest = evidenceSnapshotDigest(snapshot);
    const key = `${type}:${snapshotDigest}`;
    let task = this.#tasks.get(key);
    if (task?.cancelled) verificationFailure("EVIDENCE_VERIFIER_BUSY");
    if (
      this.#waiters >= this.#waiterLimit ||
      (task === undefined &&
        [...this.#tasks.values()].filter((item) => !item.started).length >= this.#queueLimit)
    )
      verificationFailure("EVIDENCE_VERIFIER_BUSY");
    if (task === undefined) {
      const request = checkVerificationSchema(EvidenceVerificationRequestSchema, {
        type,
        nonce: randomUUID(),
        snapshotDigest,
        snapshot,
      });
      const timer = setTimeout(() => {
        const pending = this.#tasks.get(key);
        if (pending !== undefined) this.#cancel(pending, "EVIDENCE_VERIFIER_TIMEOUT");
      }, this.#timeout);
      timer.unref();
      task = {
        key,
        request,
        priority,
        waiters: new Set(),
        started: false,
        cancelled: false,
        timer,
      };
      this.#tasks.set(key, task);
      this.#nonces.set(request.nonce, task);
    } else if (priority === "foreground") task.priority = "foreground";
    const selected = task;
    const result = new Promise<EvidenceAttestation>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          if (!selected.waiters.delete(waiter)) return;
          this.#waiters--;
          signal.removeEventListener("abort", waiter.onAbort);
          reject(new EvidenceVerificationError("EVIDENCE_VERIFIER_CANCELLED"));
          if (selected.waiters.size === 0) this.#cancel(selected, "EVIDENCE_VERIFIER_CANCELLED");
        },
      };
      selected.waiters.add(waiter);
      this.#waiters++;
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
    this.#pump();
    return result;
  }
  #pump(): void {
    if (!this.#ready || this.#closing || this.#failure !== undefined) return;
    for (const probe of [true, false]) {
      if (
        [...this.#tasks.values()].some(
          (task) => task.started && (task.request.type === "probe_identities") === probe,
        )
      )
        continue;
      const waiting = [...this.#tasks.values()].filter(
        (task) =>
          !task.started && !task.cancelled && (task.request.type === "probe_identities") === probe,
      );
      const background = waiting.find((task) => task.priority === "background");
      const next =
        !probe && this.#foregroundStreak >= 4 && background !== undefined
          ? background
          : (waiting.find((task) => task.priority === "foreground") ?? waiting[0]);
      if (next === undefined) continue;
      next.started = true;
      if (!probe)
        this.#foregroundStreak = next.priority === "background" ? 0 : this.#foregroundStreak + 1;
      try {
        this.#transport.postMessage(next.request);
      } catch {
        this.#fail("EVIDENCE_VERIFIER_UNAVAILABLE");
        return;
      }
    }
  }
  #cancel(task: Task, code: EvidenceVerificationFailureCode): void {
    if (task.cancelled) return;
    task.cancelled = true;
    clearTimeout(task.timer);
    this.#settleWaiters(task, new EvidenceVerificationError(code));
    if (!task.started) {
      this.#forget(task);
      this.#pump();
      return;
    }
    try {
      this.#transport.postMessage({ type: "cancel", nonce: task.request.nonce });
    } catch {
      this.#fail("EVIDENCE_VERIFIER_UNAVAILABLE");
      return;
    }
    task.timer = setTimeout(() => this.#fail("EVIDENCE_VERIFIER_TIMEOUT"), this.#closeTimeout);
    task.timer.unref();
  }
  #settleWaiters(task: Task, error?: Error, result?: EvidenceAttestation): void {
    for (const waiter of task.waiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.#waiters--;
      if (error !== undefined) waiter.reject(error);
      else if (result !== undefined) waiter.resolve(structuredClone(result));
    }
    task.waiters.clear();
  }
  #forget(task: Task): void {
    clearTimeout(task.timer);
    this.#tasks.delete(task.key);
    this.#nonces.delete(task.request.nonce);
  }
  #onMessage(message: unknown): void {
    if (this.#closing || this.#failure !== undefined) return;
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "ready" &&
      Object.keys(message).length === 1
    ) {
      if (this.#ready) {
        this.#fail("EVIDENCE_VERIFIER_PROTOCOL");
        return;
      }
      this.#ready = true;
      clearTimeout(this.#startupTimer);
      this.#pump();
      return;
    }
    let response: EvidenceVerificationResponse;
    try {
      response = checkVerificationSchema(EvidenceVerificationResponseSchema, message);
    } catch {
      this.#fail("EVIDENCE_VERIFIER_PROTOCOL");
      return;
    }
    const task = this.#nonces.get(response.nonce);
    if (
      task === undefined ||
      !task.started ||
      response.snapshotDigest !== task.request.snapshotDigest
    ) {
      this.#fail("EVIDENCE_VERIFIER_PROTOCOL");
      return;
    }
    if (task.cancelled) {
      this.#forget(task);
      this.#pump();
      return;
    }
    if (response.type === "failure")
      this.#settleWaiters(task, new EvidenceVerificationError(response.code));
    else {
      try {
        this.#validateAttestation(task.request, response.attestation);
      } catch {
        this.#fail("EVIDENCE_VERIFIER_PROTOCOL");
        return;
      }
      if (response.attestation.kind !== "identities_probed")
        this.#remember(task.key, response.attestation);
      this.#settleWaiters(task, undefined, response.attestation);
    }
    this.#forget(task);
    this.#pump();
  }
  #validateAttestation(request: EvidenceVerificationRequest, proof: EvidenceAttestation): void {
    if (
      proof.snapshotDigest !== request.snapshotDigest ||
      evidenceCanonicalJson(proof.storage) !== evidenceCanonicalJson(request.snapshot.storage)
    )
      verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    if (
      proof.kind !== "identities_probed" &&
      proof.verification.reusable !==
        reusableEvidenceVerification(
          proof.verification,
          proof.kind === "asset_verified"
            ? [proof.before, proof.after]
            : proof.observed.map((item) => item.after),
        )
    )
      verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    if (request.type === "verify_asset") {
      if (
        proof.kind !== "asset_verified" ||
        proof.assetId !== request.snapshot.asset.id ||
        proof.manifestDigest !== request.snapshot.manifestDigest ||
        proof.sha256 !== request.snapshot.asset.metadata.sha256 ||
        proof.sizeBytes !== request.snapshot.asset.metadata.sizeBytes ||
        !sameEvidenceIdentity(proof.before, request.snapshot.expectedFile) ||
        !sameEvidenceIdentity(proof.after, proof.before)
      )
        verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
      return;
    }
    const expected =
      request.type === "probe_identities" ? request.snapshot : probeFor(request.snapshot);
    const actual =
      proof.kind === "identities_probed"
        ? proof.assets
        : proof.kind === "scenario_verified"
          ? proof.observed
          : [];
    if (actual.length !== expected.assets.length) verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    let matches = true;
    for (const [index, item] of expected.assets.entries()) {
      const observed = actual[index];
      if (
        observed === undefined ||
        observed.assetId !== item.assetId ||
        observed.state !== item.state ||
        !sameEvidenceIdentity(observed.before, observed.after)
      )
        verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
      if (!sameEvidenceIdentity(observed.after, item.expectedFile)) matches = false;
    }
    if (request.type === "probe_identities") {
      if (proof.kind !== "identities_probed" || proof.matches !== matches)
        verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    } else if (
      proof.kind !== "scenario_verified" ||
      !matches ||
      proof.resultDigest !== request.snapshot.resultDigest ||
      evidenceCanonicalJson(proof.scope) !==
        evidenceCanonicalJson(request.snapshot.steps.asset.scope) ||
      proof.scenarioId !== request.snapshot.scenario.id ||
      proof.stepsManifestDigest !== request.snapshot.steps.manifestDigest ||
      evidenceCanonicalJson(proof.dependencyManifestDigests) !==
        evidenceCanonicalJson(request.snapshot.dependencies.map((item) => item.manifestDigest))
    )
      verificationFailure("EVIDENCE_VERIFIER_PROTOCOL");
    if (request.type === "verify_scenario" && proof.kind === "scenario_verified")
      checkScenarioObservationAttestation(request.snapshot, proof);
  }
  #removeCache(key: string): void {
    const entry = this.#cache.get(key);
    if (entry !== undefined) {
      this.#cacheBytes -= entry.bytes;
      this.#cache.delete(key);
    }
  }
  #remember(key: string, attestation: AssetAttestation | ScenarioAttestation): void {
    this.#checkClock();
    this.#removeCache(key);
    if (!this.#cacheClockStable || !attestation.verification.reusable) return;
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(attestation));
    if (bytes > this.#cacheLimit) return;
    while (this.#cacheBytes + bytes > this.#cacheLimit || this.#cache.size >= this.#entryLimit) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#removeCache(oldest);
    }
    this.#cache.set(key, { attestation: structuredClone(attestation), bytes });
    this.#cacheBytes += bytes;
  }
  #checkClock(): void {
    if (!this.#clock().stable) {
      this.#cacheClockStable = false;
      this.#cache.clear();
      this.#cacheBytes = 0;
    }
  }
  #fail(code: EvidenceVerificationFailureCode): void {
    if (this.#failure !== undefined || this.#closing) return;
    this.#failure = new EvidenceVerificationError(code);
    clearTimeout(this.#startupTimer);
    for (const task of [...this.#tasks.values()]) {
      this.#settleWaiters(task, this.#failure);
      this.#forget(task);
    }
    this.#cache.clear();
    this.#cacheBytes = 0;
    void this.#transport.terminate().catch(() => undefined);
  }
  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }
  async #close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#startupTimer);
    for (const task of [...this.#tasks.values()]) {
      this.#settleWaiters(task, new EvidenceVerificationError("EVIDENCE_VERIFIER_SHUTDOWN"));
      this.#forget(task);
    }
    this.#cache.clear();
    this.#cacheBytes = 0;
    try {
      this.#transport.postMessage({ type: "shutdown" });
    } catch {
      /* Termination below still observes exit. */
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([
        this.#exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#closeTimeout);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) {
        await Promise.race([
          this.#transport.terminate().then(() => this.#exited),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new EvidenceVerificationError("EVIDENCE_VERIFIER_TIMEOUT")),
              this.#closeTimeout,
            );
          }),
        ]);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export function attachEvidenceVerifierForTest(
  transport: EvidenceVerifierTransport,
  options: EvidenceVerificationClientOptions,
): EvidenceVerificationClient {
  return EvidenceVerificationClient[testAttachment](transport, options);
}
