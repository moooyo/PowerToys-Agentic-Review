import { createCanonicalResult } from "@agentic-review/codex";
import {
  getModelCallReceiptIssues,
  getModelInvocationReceiptSetIssues,
  getModelInvocationScopeIssues,
  type ModelCallReceiptV1,
  type ModelInvocationReceiptSet,
  type ModelInvocationScope,
  type ModelRuntimeIdentityV1,
  maximumModelInvocationCallCount,
  maximumModelRuntimeUtf8Bytes,
} from "@agentic-review/contracts";

export interface ModelInvocationRecorderOptions {
  readonly scope: ModelInvocationScope;
  readonly runtime: ModelInvocationReceiptSet["runtime"];
  readonly now?: () => Date;
}
export interface ModelCallStart {
  readonly requestSha256: string;
  readonly requestBytes: number;
  readonly requestedModel: string;
}
export interface ModelCallFinish {
  readonly httpStatus: ModelCallReceiptV1["httpStatus"];
  readonly response: ModelCallReceiptV1["response"];
  readonly outcome: ModelCallReceiptV1["outcome"];
}
export interface ModelInvocationClose {
  readonly state: ModelInvocationReceiptSet["state"];
  readonly modelOutputSha256: string | null;
}

export class ModelInvocationReceiptError extends Error {
  constructor(
    readonly code:
      | "INVALID_METADATA"
      | "INVOCATION_CLOSED"
      | "CALL_ACTIVE"
      | "CALL_LIMIT_EXCEEDED"
      | "RECEIPT_BUDGET_EXCEEDED"
      | "CALL_FINISHED",
  ) {
    super("Model invocation receipts could not retain a complete consistent observation chain.");
    this.name = "ModelInvocationReceiptError";
  }
}

const digestPattern = /^[a-f0-9]{64}(?![\s\S])/u;
// Three identifiers of at most 1,024 code points require at most 18 KiB after JSON
// escaping. The bounded timestamps, hashes, numbers, keys and outcome fields fit
// within the remaining 14 KiB. Reserve before dispatch, never truncate a recorded call.
const maximumReceiptEntryUtf8Bytes = 32 * 1024;
// The identity's model name needs at most 6 KiB; its schema, digest, output digest
// and closure-state overhead fit within the remaining 2 KiB. Runtime is counted separately.
const maximumClosureIdentityUtf8Bytes = 8 * 1024;
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
function fields<T extends object>(input: T, keys: readonly (keyof T)[]): T {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new ModelInvocationReceiptError("INVALID_METADATA");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((key) => {
      const descriptor = descriptors[String(key)];
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  )
    throw new ModelInvocationReceiptError("INVALID_METADATA");
  return Object.fromEntries(keys.map((key) => [key, descriptors[String(key)]?.value])) as T;
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function identityFromCalls(
  runtime: ModelInvocationReceiptSet["runtime"],
  calls: ModelInvocationReceiptSet["calls"],
): ModelRuntimeIdentityV1 | null {
  const modelId = calls[0]?.receipt.response?.modelId;
  if (
    modelId === undefined ||
    modelId === null ||
    calls.some(
      ({ receipt }) =>
        !["completed", "provider_failed", "provider_incomplete"].includes(receipt.outcome) ||
        !receipt.response?.transportComplete ||
        receipt.response.outcome === "invalid" ||
        receipt.response.responseId === null ||
        receipt.response.modelId !== modelId,
    )
  )
    return null;
  return { schemaVersion: "ModelRuntimeIdentityV1", ...structuredClone(runtime), modelId };
}

function versionedReceiptScope(scope: ModelInvocationScope) {
  return scope.schemaVersion === "ModelInvocationScopeV1"
    ? { schemaVersion: "ModelInvocationReceiptSetV1" as const, scope }
    : { schemaVersion: "ModelInvocationReceiptSetV2" as const, scope };
}

/** Records observations from one trusted relay. This class does not authenticate or attest them. */
export class ModelInvocationRecorder {
  readonly #scope: ModelInvocationScope;
  readonly #scopeSha256: string;
  readonly #runtime: ModelInvocationReceiptSet["runtime"];
  readonly #now: () => Date;
  readonly #closureBudgetBytes: number;
  readonly #calls: ModelInvocationReceiptSet["calls"] = [];
  #callBytes = 0;
  #active: object | undefined;
  #closed: ModelInvocationReceiptSet | undefined;
  #closeIntent: ModelInvocationClose | undefined;

  constructor(options: ModelInvocationRecorderOptions) {
    if (getModelInvocationScopeIssues(options.scope).length > 0)
      throw new ModelInvocationReceiptError("INVALID_METADATA");
    const scopeSha256 = createCanonicalResult(options.scope).sha256;
    const probe: ModelInvocationReceiptSet = {
      ...versionedReceiptScope(options.scope),
      scopeSha256,
      runtime: options.runtime,
      calls: [],
      closedAt: "1970-01-01T00:00:00.000Z",
      state: "closed",
      modelOutputSha256: null,
      observedIdentity: null,
      observedIdentitySha256: null,
    };
    if (getModelInvocationReceiptSetIssues(probe).length > 0)
      throw new ModelInvocationReceiptError("INVALID_METADATA");
    this.#scope = immutable(structuredClone(options.scope));
    this.#scopeSha256 = scopeSha256;
    this.#runtime = immutable(structuredClone(options.runtime));
    this.#closureBudgetBytes =
      jsonBytes(probe) + jsonBytes(this.#runtime) + maximumClosureIdentityUtf8Bytes;
    this.#now = options.now ?? (() => new Date());
  }

  get active(): boolean {
    return this.#active !== undefined;
  }
  get callCount(): number {
    return this.#calls.length;
  }

  begin(input: ModelCallStart): { finish(input: ModelCallFinish): void } {
    if (this.#closed) throw new ModelInvocationReceiptError("INVOCATION_CLOSED");
    if (this.#active) throw new ModelInvocationReceiptError("CALL_ACTIVE");
    if (this.#calls.length >= maximumModelInvocationCallCount)
      throw new ModelInvocationReceiptError("CALL_LIMIT_EXCEEDED");
    if (
      this.#closureBudgetBytes + this.#callBytes + maximumReceiptEntryUtf8Bytes >
      maximumModelRuntimeUtf8Bytes
    )
      throw new ModelInvocationReceiptError("RECEIPT_BUDGET_EXCEEDED");
    const request = fields(input, ["requestSha256", "requestBytes", "requestedModel"]);
    const startedAt = this.#timestamp();
    const base = {
      schemaVersion: "ModelCallReceiptV1" as const,
      scopeSha256: this.#scopeSha256,
      sequence: this.#calls.length + 1,
      previousReceiptSha256: this.#calls.at(-1)?.sha256 ?? null,
      startedAt,
      requestSha256: request.requestSha256,
      requestBytes: request.requestBytes,
      requestedModel: request.requestedModel,
    };
    if (
      base.requestedModel !== this.#scope.requestedModel ||
      getModelCallReceiptIssues({
        ...base,
        finishedAt: startedAt,
        httpStatus: null,
        response: null,
        outcome: "transport_failed",
      }).length > 0
    )
      throw new ModelInvocationReceiptError("INVALID_METADATA");
    const previous = this.#calls.at(-1)?.receipt;
    if (previous && Date.parse(startedAt) < Date.parse(previous.finishedAt))
      throw new ModelInvocationReceiptError("INVALID_METADATA");
    const token = {};
    this.#active = token;
    return Object.freeze({
      finish: (completion: ModelCallFinish): void => {
        if (this.#active !== token) throw new ModelInvocationReceiptError("CALL_FINISHED");
        const candidate = {
          ...base,
          finishedAt: this.#timestamp(),
          ...fields(completion, ["httpStatus", "response", "outcome"]),
        };
        if (getModelCallReceiptIssues(candidate).length > 0)
          throw new ModelInvocationReceiptError("INVALID_METADATA");
        const receipt = immutable(structuredClone(candidate));
        const entry = immutable({ receipt, sha256: createCanonicalResult(receipt).sha256 });
        this.#callBytes += jsonBytes(entry) + 1;
        this.#calls.push(entry);
        this.#active = undefined;
      },
    });
  }

  close(input: ModelInvocationClose): ModelInvocationReceiptSet {
    input = fields(input, ["state", "modelOutputSha256"]);
    if (this.#closed) {
      if (
        input.state !== this.#closeIntent?.state ||
        input.modelOutputSha256 !== this.#closeIntent.modelOutputSha256
      )
        throw new ModelInvocationReceiptError("INVOCATION_CLOSED");
      return this.#closed;
    }
    if (this.#active) throw new ModelInvocationReceiptError("CALL_ACTIVE");
    if (
      !["closed", "cancelled"].includes(input.state) ||
      (input.modelOutputSha256 !== null && !digestPattern.test(input.modelOutputSha256)) ||
      (input.state === "cancelled" && input.modelOutputSha256 !== null)
    )
      throw new ModelInvocationReceiptError("INVALID_METADATA");
    const observedIdentity = identityFromCalls(this.#runtime, this.#calls);
    const last = this.#calls.at(-1)?.receipt;
    const modelOutputSha256 =
      input.state === "closed" &&
      last?.outcome === "completed" &&
      last.response?.outputJsonSha256 === input.modelOutputSha256
        ? input.modelOutputSha256
        : null;
    const result: ModelInvocationReceiptSet = {
      ...versionedReceiptScope(this.#scope),
      scopeSha256: this.#scopeSha256,
      runtime: this.#runtime,
      calls: this.#calls,
      closedAt: this.#timestamp(),
      state: input.state,
      modelOutputSha256,
      observedIdentity,
      observedIdentitySha256:
        observedIdentity === null ? null : createCanonicalResult(observedIdentity).sha256,
    };
    if (getModelInvocationReceiptSetIssues(result).length > 0)
      throw new ModelInvocationReceiptError("INVALID_METADATA");
    this.#closeIntent = immutable({ ...input });
    this.#closed = immutable(structuredClone(result));
    return this.#closed;
  }

  #timestamp(): string {
    try {
      return this.#now().toISOString();
    } catch {
      throw new ModelInvocationReceiptError("INVALID_METADATA");
    }
  }
}
