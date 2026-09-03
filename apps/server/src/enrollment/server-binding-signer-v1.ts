import { createHash, timingSafeEqual } from "node:crypto";
import { isPromise } from "node:util/types";

import {
  deriveServerBindingIssuerKeyIdV1,
  marshalServerBindingActiveStatusStatementV1,
  marshalServerBindingActiveStatusV1,
  marshalServerBindingReceiptStatementV1,
  marshalServerBindingReceiptV1,
  SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
  SERVER_BINDING_AUTHORITY_ISSUER,
  SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES,
  SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
  SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
  SERVER_BINDING_RECEIPT_PROFILE_ID,
  type ServerBindingActiveStatusStatementV1,
  type ServerBindingActiveStatusV1,
  type ServerBindingReceiptStatementV1,
  type ServerBindingReceiptV1,
  serverBindingActiveStatusSigningPreimageV1,
  serverBindingReceiptSigningPreimageV1,
  verifyServerBindingActiveStatusWithSpkiV1,
  verifyServerBindingReceiptWithSpkiV1,
} from "@agentic-review/contracts/server-binding-authority-v1";

import {
  loadProductionServerBindingSignerProviderV1,
  ServerBindingSignerProviderStartupErrorV1,
} from "./server-binding-signer-provider-v1.js";
import { loadProductionServerBindingTrustProfileV1 } from "./server-binding-trust-profile-v1.js";

const canonicalP256SpkiBytes = 91;
const providerCleanupTimeoutMilliseconds = 30_000;
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get;
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;
const intrinsicPromiseThen = Promise.prototype.then;

export type ServerBindingSignerErrorCodeV1 =
  | "SIGNATURE_INVALID"
  | "SIGNER_INPUT_INVALID"
  | "SIGNER_MISMATCH"
  | "SIGNER_OUTCOME_UNKNOWN"
  | "SIGNER_UNAVAILABLE";

export class ServerBindingSignerErrorV1 extends Error {
  public constructor(
    public readonly code: ServerBindingSignerErrorCodeV1,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ServerBindingSignerErrorV1";
  }
}

/**
 * Startup-scoped signer facts. The SPKI property returns a detached canonical snapshot on every
 * read; mutating that returned view cannot change the signer context.
 */
export interface ServerBindingSignerContextV1 {
  readonly issuerKeyId: string;
  readonly issuerPublicKeySpki: Readonly<Uint8Array>;
  readonly terminalFailure: Promise<ServerBindingSignerErrorV1>;
  readonly readTerminalError: () => ServerBindingSignerErrorV1 | null;
}

export interface ServerBindingSignerDescriptorV1 {
  readonly issuerKeyId: string;
  readonly issuerPublicKeySpki: Uint8Array;
}

interface PreimageSha256ProviderV1 {
  readonly kind: "preimage-sha256";
  readonly issuerPublicKeySpki: Buffer;
  readonly signPreimageSha256: (preimage: Uint8Array, signal: AbortSignal) => Promise<unknown>;
  readonly close: () => Promise<unknown>;
}

interface DigestNativeProviderV1 {
  readonly kind: "digest-native";
  readonly issuerPublicKeySpki: Buffer;
  readonly signDigest: (digest: Uint8Array, signal: AbortSignal) => Promise<unknown>;
  readonly close: () => Promise<unknown>;
}

interface BindingStatementProviderV1 {
  readonly kind: "binding-statements-v1";
  readonly issuerPublicKeySpki: Buffer;
  readonly terminalFailure: Promise<unknown>;
  readonly readTerminalError: () => unknown;
  readonly signReceiptStatementV1: (
    statementJson: Uint8Array,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly signActiveStatusStatementV1: (
    statementJson: Uint8Array,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly close: () => Promise<unknown>;
}

type SignerProviderV1 =
  | BindingStatementProviderV1
  | DigestNativeProviderV1
  | PreimageSha256ProviderV1;

interface SignerTerminalStateV1 {
  readonly control: PromiseWithResolvers<ServerBindingSignerErrorV1>;
  error: ServerBindingSignerErrorV1 | undefined;
}

interface SignerContextStateV1 {
  readonly issuerKeyId: string;
  readonly issuerPublicKeySpki: Buffer;
  provider: SignerProviderV1 | undefined;
  closingProvider: SignerProviderV1 | undefined;
  readonly activeOperations: Set<Promise<unknown>>;
  readonly abortControllers: Set<AbortController>;
  closePromise: Promise<void> | undefined;
  unadoptedClosePromise: Promise<"closed"> | undefined;
  closed: boolean;
  owner: object | undefined;
  readonly terminal: SignerTerminalStateV1;
}

interface IntrinsicUint8View {
  readonly buffer: ArrayBufferLike;
  readonly byteLength: number;
  readonly byteOffset: number;
}

const signerContexts = new WeakMap<object, SignerContextStateV1>();
const unadoptedSignerCleanupOwner = Object.freeze(Object.create(null)) as object;
const quarantinedProviderCandidates = new Set<object>();
let signerLoaderTerminalError: ServerBindingSignerErrorV1 | undefined;
let signerLoadTail: Promise<void> = Promise.resolve();

/**
 * Loads the startup-scoped signer from the reviewed production material provider. The trust SPKI
 * and signing provider share no caller-controlled input or mutable registration fallback.
 */
export async function loadServerBindingSignerV1(): Promise<Readonly<ServerBindingSignerContextV1>> {
  const predecessor = signerLoadTail;
  const gate = Promise.withResolvers<void>();
  signerLoadTail = predecessor.then(
    () => gate.promise,
    () => gate.promise,
  );
  await predecessor.catch(() => undefined);
  try {
    return await loadServerBindingSignerUnlockedV1();
  } finally {
    gate.resolve();
  }
}

async function loadServerBindingSignerUnlockedV1(): Promise<
  Readonly<ServerBindingSignerContextV1>
> {
  if (signerLoaderTerminalError !== undefined) throw signerLoaderTerminalError;
  if (quarantinedProviderCandidates.size !== 0) {
    throw signerError(
      "SIGNER_UNAVAILABLE",
      "A prior Server binding signer provider cleanup remains unresolved.",
    );
  }
  let trustCandidate: unknown;
  try {
    trustCandidate = await loadProductionServerBindingTrustProfileV1();
  } catch {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding trust profile is unavailable.");
  }
  const trusted = snapshotTrustProfile(trustCandidate);
  let providerCandidate: unknown;
  try {
    providerCandidate = await loadProductionServerBindingSignerProviderV1();
  } catch (error) {
    throw normalizeProviderStartupError(error);
  }
  let provider: SignerProviderV1 | undefined;
  let terminal: SignerTerminalStateV1 | undefined;
  try {
    provider = snapshotProvider(providerCandidate);
    if (
      provider.issuerPublicKeySpki.byteLength !== trusted.bytes.byteLength ||
      !timingSafeEqual(provider.issuerPublicKeySpki, trusted.bytes)
    ) {
      throw signerError(
        "SIGNER_MISMATCH",
        "The Server binding signer provider does not match the compiled trust SPKI.",
      );
    }
    terminal = createSignerTerminalStateV1();
    if (provider.kind === "binding-statements-v1") {
      observeStatementProviderTerminal(provider, terminal);
      const startupTerminal = readStatementProviderTerminal(provider);
      if (startupTerminal !== null) throw normalizeProviderStartupError(startupTerminal);
    }
  } catch (error) {
    try {
      await closeProviderCandidate(providerCandidate);
    } catch (cleanupError) {
      signerLoaderTerminalError ??= signerError(
        "SIGNER_UNAVAILABLE",
        "The Server binding signer provider cleanup could not prove termination.",
        new AggregateError(
          [error, cleanupError],
          "Server binding signer validation and provider cleanup both failed.",
          { cause: error },
        ),
      );
      throw signerLoaderTerminalError;
    }
    throw error;
  }
  if (provider === undefined || terminal === undefined) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer provider is unavailable.");
  }

  const context = Object.create(null) as ServerBindingSignerContextV1;
  const readTerminalError = (): ServerBindingSignerErrorV1 | null => {
    const state = signerContexts.get(context);
    return state === undefined ? (terminal.error ?? null) : readSignerTerminalError(state);
  };
  Object.freeze(readTerminalError);
  Object.defineProperties(context, {
    issuerKeyId: {
      configurable: false,
      enumerable: true,
      value: trusted.issuerKeyId,
      writable: false,
    },
    issuerPublicKeySpki: {
      configurable: false,
      enumerable: true,
      get: () => Uint8Array.from(trusted.bytes),
    },
    readTerminalError: {
      configurable: false,
      enumerable: true,
      value: readTerminalError,
      writable: false,
    },
    terminalFailure: {
      configurable: false,
      enumerable: true,
      value: terminal.control.promise,
      writable: false,
    },
  });
  Object.freeze(context);
  signerContexts.set(context, {
    issuerKeyId: trusted.issuerKeyId,
    issuerPublicKeySpki: trusted.bytes,
    provider,
    closingProvider: undefined,
    activeOperations: new Set(),
    abortControllers: new Set(),
    closePromise: undefined,
    unadoptedClosePromise: undefined,
    closed: false,
    owner: undefined,
    terminal,
  });
  return context;
}

/**
 * Signs only the v1 receipt statement domain. A canonical statement byte document is accepted so
 * persistence can sign the exact committed statement instead of reconstructing mutable input.
 */
export async function signServerBindingReceiptStatementV1(
  context: Readonly<ServerBindingSignerContextV1>,
  statement: ServerBindingReceiptStatementV1 | Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const state =
    context !== null && typeof context === "object" ? signerContexts.get(context) : null;
  if (state === undefined || state === null) {
    throw signerError("SIGNER_MISMATCH", "The Server binding signer context is invalid.");
  }
  const terminalError = readSignerTerminalError(state);
  if (terminalError !== null) throw terminalError;
  const provider = state.provider;
  if (state.closed || provider === undefined) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer context is closed.");
  }
  if (signal?.aborted === true && provider.kind !== "binding-statements-v1") {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer operation was cancelled.");
  }

  const statementSnapshot = snapshotReceiptStatement(statement);
  let preimage: Buffer | undefined;
  let providerInput: Buffer;
  if (provider.kind === "binding-statements-v1") {
    providerInput = Buffer.from(marshalServerBindingReceiptStatementV1(statementSnapshot));
  } else {
    preimage = Buffer.from(serverBindingReceiptSigningPreimageV1(statementSnapshot));
    providerInput =
      provider.kind === "preimage-sha256"
        ? preimage
        : createHash("sha256").update(preimage).digest();
  }
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(signal?.reason);
  try {
    signal?.addEventListener("abort", relayAbort, { once: true });
    if (signal?.aborted === true) controller.abort(signal.reason);
  } catch {
    preimage?.fill(0);
    if (providerInput !== preimage) providerInput.fill(0);
    throw signerError("SIGNER_INPUT_INVALID", "The Server binding signer signal is invalid.");
  }
  const admissionTerminal = readSignerTerminalError(state);
  if (admissionTerminal !== null || state.closed || state.provider !== provider) {
    removeAbortRelay(signal, relayAbort);
    preimage?.fill(0);
    if (providerInput !== preimage) providerInput.fill(0);
    if (admissionTerminal !== null) throw admissionTerminal;
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer context is closed.");
  }
  state.abortControllers.add(controller);

  let providerResult: unknown;
  let operation: Promise<unknown> | undefined;
  try {
    const signOperation =
      provider.kind === "binding-statements-v1"
        ? provider.signReceiptStatementV1
        : provider.kind === "preimage-sha256"
          ? provider.signPreimageSha256
          : provider.signDigest;
    operation = Promise.resolve().then(() => {
      const result = Reflect.apply(signOperation, undefined, [
        Uint8Array.from(providerInput),
        controller.signal,
      ]);
      if (!isPromise(result)) {
        throw signerError(
          "SIGNER_MISMATCH",
          "The Server binding signer provider must return a native Promise.",
        );
      }
      return result;
    });
    state.activeOperations.add(operation);
    providerResult = await operation;
  } catch (error) {
    const observedTerminal = readSignerTerminalError(state);
    if (observedTerminal !== null) throw observedTerminal;
    if (error instanceof ServerBindingSignerErrorV1) throw error;
    throw signerError(
      "SIGNER_UNAVAILABLE",
      "The Server binding signer provider could not complete the operation.",
    );
  } finally {
    removeAbortRelay(signal, relayAbort);
    state.abortControllers.delete(controller);
    if (operation !== undefined) state.activeOperations.delete(operation);
    preimage?.fill(0);
    if (providerInput !== preimage) providerInput.fill(0);
  }
  const observedTerminal = readSignerTerminalError(state);
  if (observedTerminal !== null) throw observedTerminal;
  if (controller.signal.aborted || state.closed) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer operation was cancelled.");
  }

  let signature: Buffer;
  try {
    signature = canonicalizeP1363LowS(providerResult, provider.kind !== "binding-statements-v1");
  } catch (error) {
    if (provider.kind !== "binding-statements-v1") throw error;
    const terminal =
      error instanceof ServerBindingSignerErrorV1
        ? error
        : signerError("SIGNATURE_INVALID", "The statement signer result is invalid.");
    throw latchSignerTerminalError(state.terminal, terminal);
  }
  const encodedSignature = signature.toString("base64url");
  const receipt: ServerBindingReceiptV1 = {
    algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    issuerKeyId: state.issuerKeyId,
    profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    signature: encodedSignature,
    statement: statementSnapshot,
  };

  try {
    const document = marshalServerBindingReceiptV1(receipt);
    verifyServerBindingReceiptWithSpkiV1(document, state.issuerPublicKeySpki);
  } catch {
    const error = signerError(
      "SIGNATURE_INVALID",
      "The Server binding signer result did not verify against the compiled trust SPKI.",
    );
    throw provider.kind === "binding-statements-v1"
      ? latchSignerTerminalError(state.terminal, error)
      : error;
  }
  return encodedSignature;
}

/** Signs only the v1 active-status statement domain without widening the provider operation set. */
export async function signServerBindingActiveStatusStatementV1(
  context: Readonly<ServerBindingSignerContextV1>,
  statement: ServerBindingActiveStatusStatementV1 | Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const state =
    context !== null && typeof context === "object" ? signerContexts.get(context) : null;
  if (state === undefined || state === null) {
    throw signerError("SIGNER_MISMATCH", "The Server binding signer context is invalid.");
  }
  const terminalError = readSignerTerminalError(state);
  if (terminalError !== null) throw terminalError;
  const provider = state.provider;
  if (state.closed || provider === undefined) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer context is closed.");
  }
  if (signal?.aborted === true && provider.kind !== "binding-statements-v1") {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer operation was cancelled.");
  }

  const statementSnapshot = snapshotActiveStatusStatement(statement);
  let preimage: Buffer | undefined;
  let providerInput: Buffer;
  if (provider.kind === "binding-statements-v1") {
    providerInput = Buffer.from(marshalServerBindingActiveStatusStatementV1(statementSnapshot));
  } else {
    preimage = Buffer.from(serverBindingActiveStatusSigningPreimageV1(statementSnapshot));
    providerInput =
      provider.kind === "preimage-sha256"
        ? preimage
        : createHash("sha256").update(preimage).digest();
  }
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(signal?.reason);
  try {
    signal?.addEventListener("abort", relayAbort, { once: true });
    if (signal?.aborted === true) controller.abort(signal.reason);
  } catch {
    preimage?.fill(0);
    if (providerInput !== preimage) providerInput.fill(0);
    throw signerError("SIGNER_INPUT_INVALID", "The Server binding signer signal is invalid.");
  }
  const admissionTerminal = readSignerTerminalError(state);
  if (admissionTerminal !== null || state.closed || state.provider !== provider) {
    removeAbortRelay(signal, relayAbort);
    preimage?.fill(0);
    if (providerInput !== preimage) providerInput.fill(0);
    if (admissionTerminal !== null) throw admissionTerminal;
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer context is closed.");
  }
  state.abortControllers.add(controller);

  let providerResult: unknown;
  let operation: Promise<unknown> | undefined;
  try {
    const signOperation =
      provider.kind === "binding-statements-v1"
        ? provider.signActiveStatusStatementV1
        : provider.kind === "preimage-sha256"
          ? provider.signPreimageSha256
          : provider.signDigest;
    operation = Promise.resolve().then(() => {
      const result = Reflect.apply(signOperation, undefined, [
        Uint8Array.from(providerInput),
        controller.signal,
      ]);
      if (!isPromise(result)) {
        throw signerError(
          "SIGNER_MISMATCH",
          "The Server binding signer provider must return a native Promise.",
        );
      }
      return result;
    });
    state.activeOperations.add(operation);
    providerResult = await operation;
  } catch (error) {
    const observedTerminal = readSignerTerminalError(state);
    if (observedTerminal !== null) throw observedTerminal;
    if (error instanceof ServerBindingSignerErrorV1) throw error;
    throw signerError(
      "SIGNER_UNAVAILABLE",
      "The Server binding signer provider could not complete the operation.",
    );
  } finally {
    removeAbortRelay(signal, relayAbort);
    state.abortControllers.delete(controller);
    if (operation !== undefined) state.activeOperations.delete(operation);
    preimage?.fill(0);
    if (providerInput !== preimage) providerInput.fill(0);
  }
  const observedTerminal = readSignerTerminalError(state);
  if (observedTerminal !== null) throw observedTerminal;
  if (controller.signal.aborted || state.closed) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer operation was cancelled.");
  }

  let signature: Buffer;
  try {
    signature = canonicalizeP1363LowS(providerResult, provider.kind !== "binding-statements-v1");
  } catch (error) {
    if (provider.kind !== "binding-statements-v1") throw error;
    const terminal =
      error instanceof ServerBindingSignerErrorV1
        ? error
        : signerError("SIGNATURE_INVALID", "The statement signer result is invalid.");
    throw latchSignerTerminalError(state.terminal, terminal);
  }
  const encodedSignature = signature.toString("base64url");
  const activeStatus: ServerBindingActiveStatusV1 = {
    algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    issuerKeyId: state.issuerKeyId,
    profileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
    schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    signature: encodedSignature,
    statement: statementSnapshot,
  };

  try {
    const document = marshalServerBindingActiveStatusV1(activeStatus);
    verifyServerBindingActiveStatusWithSpkiV1(document, state.issuerPublicKeySpki);
  } catch {
    const error = signerError(
      "SIGNATURE_INVALID",
      "The Server binding signer result did not verify against the compiled trust SPKI.",
    );
    throw provider.kind === "binding-statements-v1"
      ? latchSignerTerminalError(state.terminal, error)
      : error;
  }
  return encodedSignature;
}

/** @internal Verifies the signer brand and ownership fence without reading its terminal snapshot. */
export function assertServerBindingSignerOwnershipAvailableV1(
  context: Readonly<ServerBindingSignerContextV1>,
): void {
  const state =
    context !== null && typeof context === "object" ? signerContexts.get(context) : null;
  if (state === undefined || state === null) {
    throw signerError("SIGNER_MISMATCH", "The Server binding signer context is invalid.");
  }
  if (state.closed || state.owner !== undefined) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer context is unavailable.");
  }
}

/** Verifies synchronously that a live signer has not yet been adopted. */
export function assertServerBindingSignerAdoptableV1(
  context: Readonly<ServerBindingSignerContextV1>,
): void {
  assertServerBindingSignerOwnershipAvailableV1(context);
  const state = signerContexts.get(context);
  if (state === undefined) {
    throw signerError("SIGNER_MISMATCH", "The Server binding signer context is invalid.");
  }
  const terminalError = readSignerTerminalError(state);
  if (terminalError !== null) throw terminalError;
}

/** Adopts one live signer context for exactly one coordinator owner. */
export function adoptServerBindingSignerV1(
  context: Readonly<ServerBindingSignerContextV1>,
  owner: object,
): Readonly<ServerBindingSignerDescriptorV1> {
  const state =
    context !== null && typeof context === "object" ? signerContexts.get(context) : null;
  if (state === undefined || state === null || owner === null || typeof owner !== "object") {
    throw signerError("SIGNER_MISMATCH", "The Server binding signer adoption is invalid.");
  }
  const terminalError = readSignerTerminalError(state);
  if (terminalError !== null) throw terminalError;
  if (state.closed || state.owner !== undefined) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer context is unavailable.");
  }
  state.owner = owner;
  return Object.freeze({
    issuerKeyId: state.issuerKeyId,
    issuerPublicKeySpki: Uint8Array.from(state.issuerPublicKeySpki),
  });
}

/** Cancels active signing and releases the single owned provider session exactly once. */
export function closeServerBindingSignerV1(
  context: Readonly<ServerBindingSignerContextV1>,
  owner: object,
): Promise<void> {
  const state =
    context !== null && typeof context === "object" ? signerContexts.get(context) : null;
  if (state === undefined || state === null || state.owner !== owner) {
    return Promise.reject(
      signerError("SIGNER_MISMATCH", "The Server binding signer owner is invalid."),
    );
  }
  if (state.closePromise !== undefined) return state.closePromise;
  const control = Promise.withResolvers<void>();
  state.closePromise = control.promise;
  void closeSignerStateV1(state).then(control.resolve, control.reject);
  return state.closePromise;
}

async function closeSignerStateV1(state: SignerContextStateV1): Promise<void> {
  state.closed = true;
  readSignerTerminalError(state);
  for (const controller of state.abortControllers) {
    controller.abort(new Error("Server binding signer shutdown requested."));
  }
  const provider = state.provider;
  state.provider = undefined;
  state.closingProvider = provider;
  try {
    let providerClose: Promise<unknown> = Promise.resolve();
    if (provider !== undefined) {
      quarantinedProviderCandidates.add(provider);
      providerClose = Promise.resolve()
        .then(() => {
          const result = Reflect.apply(provider.close, undefined, []);
          if (!isPromise(result)) {
            throw signerError(
              "SIGNER_MISMATCH",
              "The Server binding signer provider close operation must return a native Promise.",
            );
          }
          return result;
        })
        .then((result) => {
          quarantinedProviderCandidates.delete(provider);
          return result;
        });
    }
    const settlements = await Promise.allSettled([...state.activeOperations, providerClose]);
    if (settlements.at(-1)?.status === "rejected") {
      if (provider?.kind === "binding-statements-v1") {
        try {
          readStatementProviderTerminal(provider);
        } catch {
          // A malformed terminal snapshot is still outcome-unknown after context publication.
        }
        throw latchSignerOutcomeUnknown(state.terminal, settlements.at(-1));
      }
      throw signerError(
        "SIGNER_UNAVAILABLE",
        "The Server binding signer provider could not close cleanly.",
      );
    }
    if (provider?.kind === "binding-statements-v1" && state.terminal.error === undefined) {
      try {
        const providerTerminal = readStatementProviderTerminal(provider);
        if (providerTerminal !== null) latchSignerOutcomeUnknown(state.terminal, providerTerminal);
      } catch (error) {
        latchSignerOutcomeUnknown(state.terminal, error);
      }
    }
    if (state.terminal.error !== undefined) throw state.terminal.error;
  } finally {
    state.closingProvider = undefined;
  }
}

/** Closes a startup signer only when no coordinator or other owner has adopted it. */
export function closeUnadoptedServerBindingSignerV1(
  context: Readonly<ServerBindingSignerContextV1>,
): Promise<"already_adopted" | "closed"> {
  const state =
    context !== null && typeof context === "object" ? signerContexts.get(context) : null;
  if (state === undefined || state === null) {
    return Promise.reject(
      signerError("SIGNER_MISMATCH", "The Server binding signer context is invalid."),
    );
  }
  if (state.owner !== undefined && state.owner !== unadoptedSignerCleanupOwner) {
    return Promise.resolve("already_adopted");
  }
  state.owner = unadoptedSignerCleanupOwner;
  state.unadoptedClosePromise ??= closeServerBindingSignerV1(
    context,
    unadoptedSignerCleanupOwner,
  ).then(() => "closed" as const);
  return state.unadoptedClosePromise;
}

/** Returns a detached descriptor only for a context minted by the reviewed loader. */
export function readServerBindingSignerDescriptorV1(
  context: Readonly<ServerBindingSignerContextV1>,
): Readonly<ServerBindingSignerDescriptorV1> {
  const state =
    context !== null && typeof context === "object" ? signerContexts.get(context) : null;
  if (state === undefined || state === null) {
    throw signerError("SIGNER_MISMATCH", "The Server binding signer context is invalid.");
  }
  const terminalError = readSignerTerminalError(state);
  if (terminalError !== null) throw terminalError;
  if (state.closed) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer context is closed.");
  }
  return Object.freeze({
    issuerKeyId: state.issuerKeyId,
    issuerPublicKeySpki: Uint8Array.from(state.issuerPublicKeySpki),
  });
}

function snapshotTrustProfile(value: unknown): Readonly<{ bytes: Buffer; issuerKeyId: string }> {
  const fields = snapshotExactDataObject(value, "Server binding trust profile");
  assertExactKeys(fields, ["compiledTrustedIssuerPublicKeySpki"]);
  return snapshotCanonicalP256Spki(fields.compiledTrustedIssuerPublicKeySpki);
}

function createSignerTerminalStateV1(): SignerTerminalStateV1 {
  return { control: Promise.withResolvers<ServerBindingSignerErrorV1>(), error: undefined };
}

function observeStatementProviderTerminal(
  provider: BindingStatementProviderV1,
  terminal: SignerTerminalStateV1,
): void {
  const observe = (error: unknown): ServerBindingSignerErrorV1 =>
    latchSignerOutcomeUnknown(terminal, error);
  void Reflect.apply(intrinsicPromiseThen, provider.terminalFailure, [observe, observe]);
}

function readStatementProviderTerminal(provider: BindingStatementProviderV1): Error | null {
  let value: unknown;
  try {
    value = Reflect.apply(provider.readTerminalError, undefined, []);
  } catch {
    throw signerError(
      "SIGNER_MISMATCH",
      "The statement signer terminal snapshot could not be read.",
    );
  }
  if (value !== null && !(value instanceof Error)) {
    throw signerError("SIGNER_MISMATCH", "The statement signer terminal snapshot is invalid.");
  }
  return value;
}

function readSignerTerminalError(state: SignerContextStateV1): ServerBindingSignerErrorV1 | null {
  if (state.terminal.error !== undefined) return state.terminal.error;
  const provider = state.provider ?? state.closingProvider;
  if (provider?.kind !== "binding-statements-v1") return null;
  try {
    const providerError = readStatementProviderTerminal(provider);
    return providerError === null ? null : latchSignerOutcomeUnknown(state.terminal, providerError);
  } catch (error) {
    return latchSignerOutcomeUnknown(state.terminal, error);
  }
}

function removeAbortRelay(signal: AbortSignal | undefined, listener: () => void): void {
  try {
    signal?.removeEventListener("abort", listener);
  } catch {
    // The private controller and operation correlation remain authoritative.
  }
}

function latchSignerOutcomeUnknown(
  terminal: SignerTerminalStateV1,
  _cause: unknown,
): ServerBindingSignerErrorV1 {
  return latchSignerTerminalError(
    terminal,
    signerError("SIGNER_OUTCOME_UNKNOWN", "The Server binding signer outcome is unknown."),
  );
}

function latchSignerTerminalError(
  terminal: SignerTerminalStateV1,
  error: ServerBindingSignerErrorV1,
): ServerBindingSignerErrorV1 {
  if (terminal.error !== undefined) return terminal.error;
  terminal.error = error;
  terminal.control.resolve(error);
  return error;
}

function normalizeProviderStartupError(error: unknown): ServerBindingSignerErrorV1 {
  if (
    error instanceof ServerBindingSignerProviderStartupErrorV1 &&
    error.code === "SIGNER_MISMATCH"
  ) {
    return signerError(
      "SIGNER_MISMATCH",
      "The Server binding signer provider startup identity is invalid.",
    );
  }
  return signerError("SIGNER_UNAVAILABLE", "The Server binding signer provider is unavailable.");
}

function snapshotProvider(value: unknown): SignerProviderV1 {
  const fields = snapshotExactDataObject(value, "Server binding signer provider");
  if (fields.kind === "binding-statements-v1") {
    assertExactKeys(fields, [
      "close",
      "issuerPublicKeySpki",
      "kind",
      "readTerminalError",
      "signActiveStatusStatementV1",
      "signReceiptStatementV1",
      "terminalFailure",
    ]);
    if (
      typeof fields.close !== "function" ||
      typeof fields.readTerminalError !== "function" ||
      typeof fields.signActiveStatusStatementV1 !== "function" ||
      typeof fields.signReceiptStatementV1 !== "function" ||
      !isPromise(fields.terminalFailure)
    ) {
      throw signerError("SIGNER_MISMATCH", "The statement signer operations are invalid.");
    }
    return Object.freeze({
      close: fields.close as BindingStatementProviderV1["close"],
      issuerPublicKeySpki: snapshotCanonicalP256Spki(fields.issuerPublicKeySpki).bytes,
      kind: "binding-statements-v1" as const,
      readTerminalError:
        fields.readTerminalError as BindingStatementProviderV1["readTerminalError"],
      signActiveStatusStatementV1:
        fields.signActiveStatusStatementV1 as BindingStatementProviderV1["signActiveStatusStatementV1"],
      signReceiptStatementV1:
        fields.signReceiptStatementV1 as BindingStatementProviderV1["signReceiptStatementV1"],
      terminalFailure: fields.terminalFailure,
    });
  }
  if (fields.kind === "preimage-sha256") {
    assertExactKeys(fields, ["close", "issuerPublicKeySpki", "kind", "signPreimageSha256"]);
    if (typeof fields.signPreimageSha256 !== "function" || typeof fields.close !== "function") {
      throw signerError("SIGNER_MISMATCH", "The preimage signer operation is invalid.");
    }
    return Object.freeze({
      close: fields.close as PreimageSha256ProviderV1["close"],
      issuerPublicKeySpki: snapshotCanonicalP256Spki(fields.issuerPublicKeySpki).bytes,
      kind: "preimage-sha256" as const,
      signPreimageSha256:
        fields.signPreimageSha256 as PreimageSha256ProviderV1["signPreimageSha256"],
    });
  }
  if (fields.kind === "digest-native") {
    assertExactKeys(fields, ["close", "issuerPublicKeySpki", "kind", "signDigest"]);
    if (typeof fields.signDigest !== "function" || typeof fields.close !== "function") {
      throw signerError("SIGNER_MISMATCH", "The digest-native signer operation is invalid.");
    }
    return Object.freeze({
      close: fields.close as DigestNativeProviderV1["close"],
      issuerPublicKeySpki: snapshotCanonicalP256Spki(fields.issuerPublicKeySpki).bytes,
      kind: "digest-native" as const,
      signDigest: fields.signDigest as DigestNativeProviderV1["signDigest"],
    });
  }
  throw signerError("SIGNER_MISMATCH", "The Server binding signer provider kind is invalid.");
}

async function closeProviderCandidate(value: unknown): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw signerError(
      "SIGNER_UNAVAILABLE",
      "The Server binding signer provider cleanup capability is absent.",
    );
  }
  const candidate = value as object;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "close");
  } catch (error) {
    quarantinedProviderCandidates.add(candidate);
    throw signerError(
      "SIGNER_UNAVAILABLE",
      "The Server binding signer provider cleanup capability is inaccessible.",
      error,
    );
  }
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "function"
  ) {
    quarantinedProviderCandidates.add(candidate);
    throw signerError(
      "SIGNER_UNAVAILABLE",
      "The Server binding signer provider cleanup capability is invalid.",
    );
  }
  const closing = Promise.resolve().then(() => {
    const result = Reflect.apply(descriptor.value, undefined, []);
    if (!isPromise(result)) {
      throw signerError(
        "SIGNER_UNAVAILABLE",
        "The Server binding signer provider cleanup must return a native Promise.",
      );
    }
    return result;
  });
  try {
    await Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            signerError(
              "SIGNER_UNAVAILABLE",
              "The Server binding signer provider cleanup deadline expired.",
            ),
          );
        }, providerCleanupTimeoutMilliseconds);
        timer.unref();
      }),
    ]);
    quarantinedProviderCandidates.delete(candidate);
  } catch (error) {
    quarantinedProviderCandidates.add(candidate);
    void closing.then(
      () => quarantinedProviderCandidates.delete(candidate),
      () => undefined,
    );
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function snapshotReceiptStatement(
  value: ServerBindingReceiptStatementV1 | Uint8Array,
): Readonly<ServerBindingReceiptStatementV1> {
  let canonicalBytes: Buffer;
  const intrinsicView = readIntrinsicUint8ViewOrUndefined(value);
  if (intrinsicView === undefined) {
    try {
      canonicalBytes = Buffer.from(
        marshalServerBindingReceiptStatementV1(value as ServerBindingReceiptStatementV1),
      );
    } catch {
      throw signerError("SIGNER_INPUT_INVALID", "The receipt statement is invalid.");
    }
  } else {
    if (
      intrinsicView.byteLength === 0 ||
      intrinsicView.byteLength > SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES
    ) {
      throw signerError("SIGNER_INPUT_INVALID", "The receipt statement byte length is invalid.");
    }
    canonicalBytes = copyIntrinsicUint8View(
      value,
      intrinsicView,
      "receipt statement",
      "SIGNER_INPUT_INVALID",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes));
  } catch {
    throw signerError("SIGNER_INPUT_INVALID", "The receipt statement bytes are invalid.");
  }

  let remarshal: Buffer;
  try {
    remarshal = Buffer.from(
      marshalServerBindingReceiptStatementV1(parsed as ServerBindingReceiptStatementV1),
    );
  } catch {
    throw signerError("SIGNER_INPUT_INVALID", "The receipt statement fields are invalid.");
  }
  if (
    remarshal.byteLength !== canonicalBytes.byteLength ||
    !timingSafeEqual(remarshal, canonicalBytes)
  ) {
    throw signerError("SIGNER_INPUT_INVALID", "The receipt statement is not canonical.");
  }
  return Object.freeze(parsed as ServerBindingReceiptStatementV1);
}

function snapshotActiveStatusStatement(
  value: ServerBindingActiveStatusStatementV1 | Uint8Array,
): Readonly<ServerBindingActiveStatusStatementV1> {
  let canonicalBytes: Buffer;
  const intrinsicView = readIntrinsicUint8ViewOrUndefined(value);
  if (intrinsicView === undefined) {
    try {
      canonicalBytes = Buffer.from(
        marshalServerBindingActiveStatusStatementV1(value as ServerBindingActiveStatusStatementV1),
      );
    } catch {
      throw signerError("SIGNER_INPUT_INVALID", "The active-status statement is invalid.");
    }
  } else {
    if (
      intrinsicView.byteLength === 0 ||
      intrinsicView.byteLength > SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES
    ) {
      throw signerError(
        "SIGNER_INPUT_INVALID",
        "The active-status statement byte length is invalid.",
      );
    }
    canonicalBytes = copyIntrinsicUint8View(
      value,
      intrinsicView,
      "active-status statement",
      "SIGNER_INPUT_INVALID",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes));
  } catch {
    throw signerError("SIGNER_INPUT_INVALID", "The active-status statement bytes are invalid.");
  }

  let remarshal: Buffer;
  try {
    remarshal = Buffer.from(
      marshalServerBindingActiveStatusStatementV1(parsed as ServerBindingActiveStatusStatementV1),
    );
  } catch {
    throw signerError("SIGNER_INPUT_INVALID", "The active-status statement fields are invalid.");
  }
  if (
    remarshal.byteLength !== canonicalBytes.byteLength ||
    !timingSafeEqual(remarshal, canonicalBytes)
  ) {
    throw signerError("SIGNER_INPUT_INVALID", "The active-status statement is not canonical.");
  }
  return Object.freeze(parsed as ServerBindingActiveStatusStatementV1);
}

function snapshotCanonicalP256Spki(value: unknown): {
  readonly bytes: Buffer;
  readonly issuerKeyId: string;
} {
  const view = readIntrinsicUint8ViewOrUndefined(value);
  if (view === undefined || view.byteLength !== canonicalP256SpkiBytes) {
    throw signerError(
      "SIGNER_MISMATCH",
      "The Server binding signer SPKI is not an exact 91-byte Uint8Array.",
    );
  }
  const bytes = copyIntrinsicUint8View(value, view, "issuer SPKI", "SIGNER_MISMATCH");
  let issuerKeyId: string;
  try {
    issuerKeyId = deriveServerBindingIssuerKeyIdV1(bytes);
  } catch {
    throw signerError(
      "SIGNER_MISMATCH",
      "The Server binding signer SPKI is not canonical uncompressed P-256 PKIX DER.",
    );
  }
  return Object.freeze({ bytes, issuerKeyId });
}

function canonicalizeP1363LowS(value: unknown, normalizeHighS = true): Buffer {
  const view = readIntrinsicUint8ViewOrUndefined(value);
  if (view === undefined || view.byteLength !== 64) {
    throw signerError(
      "SIGNATURE_INVALID",
      "The Server binding signer did not return a 64-byte IEEE P1363 signature.",
    );
  }
  const signature = copyIntrinsicUint8View(value, view, "provider signature", "SIGNATURE_INVALID");
  const r = readUnsignedBigEndian(signature.subarray(0, 32));
  let s = readUnsignedBigEndian(signature.subarray(32));
  if (r <= 0n || r >= p256Order || s <= 0n || s >= p256Order) {
    throw signerError("SIGNATURE_INVALID", "The ECDSA signature scalars are invalid.");
  }
  if (s > p256HalfOrder) {
    if (!normalizeHighS) {
      throw signerError("SIGNATURE_INVALID", "The ECDSA signature is not low-S canonical.");
    }
    s = p256Order - s;
    writeUnsignedBigEndian(s, signature, 32, 32);
  }
  return signature;
}

function snapshotExactDataObject(value: unknown, name: string): Record<string, unknown> {
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("not an object");
    }
    prototype = Reflect.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw signerError("SIGNER_MISMATCH", `${name} could not be snapshotted.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw signerError("SIGNER_MISMATCH", `${name} must be a plain data object.`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw signerError("SIGNER_MISMATCH", `${name} contains a symbol member.`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw signerError("SIGNER_MISMATCH", `${name} contains a non-data member.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw signerError(
      "SIGNER_MISMATCH",
      "The Server binding signer provider does not have its exact member set.",
    );
  }
}

function readIntrinsicUint8ViewOrUndefined(value: unknown): IntrinsicUint8View | undefined {
  try {
    if (
      typedArrayBufferGetter === undefined ||
      typedArrayByteLengthGetter === undefined ||
      typedArrayByteOffsetGetter === undefined ||
      typedArrayTagGetter === undefined
    ) {
      return undefined;
    }
    const tag = Reflect.apply(typedArrayTagGetter, value, []) as unknown;
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as unknown;
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as unknown;
    const byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as unknown;
    if (
      tag !== "Uint8Array" ||
      !(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer) ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      typeof byteOffset !== "number" ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0
    ) {
      return undefined;
    }
    return { buffer, byteLength, byteOffset };
  } catch {
    return undefined;
  }
}

function copyIntrinsicUint8View(
  value: unknown,
  before: IntrinsicUint8View,
  name: string,
  code: ServerBindingSignerErrorCodeV1,
): Buffer {
  let snapshot: Buffer;
  try {
    snapshot = Buffer.from(new Uint8Array(before.buffer, before.byteOffset, before.byteLength));
  } catch {
    throw signerError(code, `The ${name} bytes could not be copied.`);
  }
  const after = readIntrinsicUint8ViewOrUndefined(value);
  if (
    after === undefined ||
    after.buffer !== before.buffer ||
    after.byteOffset !== before.byteOffset ||
    after.byteLength !== before.byteLength ||
    snapshot.byteLength !== before.byteLength
  ) {
    throw signerError(code, `The ${name} view changed while it was copied.`);
  }
  return snapshot;
}

function readUnsignedBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function writeUnsignedBigEndian(
  value: bigint,
  target: Uint8Array,
  offset: number,
  length: number,
): void {
  let remaining = value;
  for (let index = offset + length - 1; index >= offset; index -= 1) {
    target[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) {
    throw signerError("SIGNATURE_INVALID", "The ECDSA scalar does not fit its P1363 field.");
  }
}

Object.freeze(loadServerBindingSignerV1);
Object.freeze(assertServerBindingSignerOwnershipAvailableV1);
Object.freeze(assertServerBindingSignerAdoptableV1);
Object.freeze(adoptServerBindingSignerV1);
Object.freeze(closeServerBindingSignerV1);
Object.freeze(closeUnadoptedServerBindingSignerV1);
Object.freeze(signServerBindingActiveStatusStatementV1);

function signerError(
  code: ServerBindingSignerErrorCodeV1,
  message: string,
  cause?: unknown,
): ServerBindingSignerErrorV1 {
  return new ServerBindingSignerErrorV1(code, message, cause === undefined ? undefined : { cause });
}
