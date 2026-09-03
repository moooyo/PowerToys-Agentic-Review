import { createHash, timingSafeEqual } from "node:crypto";
import { isPromise } from "node:util/types";

import {
  deriveServerBindingIssuerKeyIdV1,
  marshalServerBindingReceiptStatementV1,
  marshalServerBindingReceiptV1,
  SERVER_BINDING_AUTHORITY_ISSUER,
  SERVER_BINDING_AUTHORITY_MAXIMUM_DOCUMENT_BYTES,
  SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
  SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
  SERVER_BINDING_RECEIPT_PROFILE_ID,
  type ServerBindingReceiptStatementV1,
  type ServerBindingReceiptV1,
  serverBindingReceiptSigningPreimageV1,
  verifyServerBindingReceiptWithSpkiV1,
} from "@agentic-review/contracts/server-binding-authority-v1";

import { loadProductionServerBindingSignerProviderV1 } from "./server-binding-signer-provider-v1.js";
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

export type ServerBindingSignerErrorCodeV1 =
  | "SIGNATURE_INVALID"
  | "SIGNER_INPUT_INVALID"
  | "SIGNER_MISMATCH"
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

type SignerProviderV1 = DigestNativeProviderV1 | PreimageSha256ProviderV1;

interface SignerContextStateV1 {
  readonly issuerKeyId: string;
  readonly issuerPublicKeySpki: Buffer;
  provider: SignerProviderV1 | undefined;
  readonly activeOperations: Set<Promise<unknown>>;
  readonly abortControllers: Set<AbortController>;
  closePromise: Promise<void> | undefined;
  unadoptedClosePromise: Promise<"closed"> | undefined;
  closed: boolean;
  owner: object | undefined;
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
  } catch {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer provider is unavailable.");
  }
  let provider: SignerProviderV1;
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

  const context = Object.create(null) as ServerBindingSignerContextV1;
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
  });
  Object.freeze(context);
  signerContexts.set(context, {
    issuerKeyId: trusted.issuerKeyId,
    issuerPublicKeySpki: trusted.bytes,
    provider,
    activeOperations: new Set(),
    abortControllers: new Set(),
    closePromise: undefined,
    unadoptedClosePromise: undefined,
    closed: false,
    owner: undefined,
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
  const provider = state.provider;
  if (state.closed || provider === undefined) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer context is closed.");
  }
  if (signal?.aborted === true) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer operation was cancelled.");
  }

  const statementSnapshot = snapshotReceiptStatement(statement);
  const preimage = Buffer.from(serverBindingReceiptSigningPreimageV1(statementSnapshot));
  const providerInput =
    provider.kind === "preimage-sha256" ? preimage : createHash("sha256").update(preimage).digest();
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", relayAbort, { once: true });
  state.abortControllers.add(controller);

  let providerResult: unknown;
  let operation: Promise<unknown> | undefined;
  try {
    const signOperation =
      provider.kind === "preimage-sha256" ? provider.signPreimageSha256 : provider.signDigest;
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
    if (error instanceof ServerBindingSignerErrorV1) throw error;
    throw signerError(
      "SIGNER_UNAVAILABLE",
      "The Server binding signer provider could not complete the operation.",
    );
  } finally {
    signal?.removeEventListener("abort", relayAbort);
    state.abortControllers.delete(controller);
    if (operation !== undefined) state.activeOperations.delete(operation);
    preimage.fill(0);
    if (providerInput !== preimage) providerInput.fill(0);
  }
  if (controller.signal.aborted || state.closed) {
    throw signerError("SIGNER_UNAVAILABLE", "The Server binding signer operation was cancelled.");
  }

  const signature = canonicalizeP1363LowS(providerResult);
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
    throw signerError(
      "SIGNATURE_INVALID",
      "The Server binding signer result did not verify against the compiled trust SPKI.",
    );
  }
  return encodedSignature;
}

/** Verifies synchronously that a live signer has not yet been adopted. */
export function assertServerBindingSignerAdoptableV1(
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
  state.closePromise ??= (async () => {
    state.closed = true;
    for (const controller of state.abortControllers) {
      controller.abort(new Error("Server binding signer shutdown requested."));
    }
    const provider = state.provider;
    state.provider = undefined;
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
      throw signerError(
        "SIGNER_UNAVAILABLE",
        "The Server binding signer provider could not close cleanly.",
      );
    }
  })();
  return state.closePromise;
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

function snapshotProvider(value: unknown): SignerProviderV1 {
  const fields = snapshotExactDataObject(value, "Server binding signer provider");
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

function canonicalizeP1363LowS(value: unknown): Buffer {
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
Object.freeze(assertServerBindingSignerAdoptableV1);
Object.freeze(adoptServerBindingSignerV1);
Object.freeze(closeServerBindingSignerV1);
Object.freeze(closeUnadoptedServerBindingSignerV1);

function signerError(
  code: ServerBindingSignerErrorCodeV1,
  message: string,
  cause?: unknown,
): ServerBindingSignerErrorV1 {
  return new ServerBindingSignerErrorV1(code, message, cause === undefined ? undefined : { cause });
}
