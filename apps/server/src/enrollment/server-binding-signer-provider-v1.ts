/**
 * Transport contract for an already-isolated signer subprocess. The server process must only copy
 * bounded input into IPC and return a native Promise immediately. Private-key or synchronous native
 * SDK work is forbidden in the server process. Close must cancel outstanding requests, terminate
 * the isolated owner if necessary, and resolve only after its exit has been observed.
 *
 * A high-level provider receives the exact domain-separated preimage and performs one internal
 * SHA-256 as part of its ECDSA P-256 operation.
 */
export interface ServerBindingPreimageSha256SignerProviderV1 {
  readonly kind: "preimage-sha256";
  readonly issuerPublicKeySpki: Uint8Array;
  readonly signPreimageSha256: (preimage: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  readonly close: () => Promise<void>;
}

/** A digest-native provider signs the supplied 32-byte SHA-256 digest without hashing it again. */
export interface ServerBindingDigestNativeSignerProviderV1 {
  readonly kind: "digest-native";
  readonly issuerPublicKeySpki: Uint8Array;
  readonly signDigest: (digest: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
  readonly close: () => Promise<void>;
}

/** Exact statement-only provider backed by the dormant direct-child signer-host client. */
export interface ServerBindingStatementSignerProviderV1 {
  readonly kind: "binding-statements-v1";
  readonly issuerPublicKeySpki: Uint8Array;
  readonly terminalFailure: Promise<Error>;
  readonly readTerminalError: () => Error | null;
  readonly signReceiptStatementV1: (
    statementJson: Uint8Array,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly signActiveStatusStatementV1: (
    statementJson: Uint8Array,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly close: () => Promise<void>;
}

export type ServerBindingSignerProviderV1 =
  | ServerBindingDigestNativeSignerProviderV1
  | ServerBindingPreimageSha256SignerProviderV1
  | ServerBindingStatementSignerProviderV1;

export type ServerBindingSignerProviderStartupErrorCodeV1 =
  | "SIGNER_MISMATCH"
  | "SIGNER_UNAVAILABLE";

/** Stable startup-only category shared by the dormant bridge and signer loader. */
export class ServerBindingSignerProviderStartupErrorV1 extends Error {
  public constructor(
    public readonly code: ServerBindingSignerProviderStartupErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "ServerBindingSignerProviderStartupErrorV1";
  }
}

/**
 * Production signing remains unavailable until a later decision supplies protected private-key
 * storage. Public trust is loaded independently by server-binding-trust-profile-v1. There is
 * deliberately no environment, database, caller, or mutable registration fallback.
 */
export async function loadProductionServerBindingSignerProviderV1(): Promise<
  Readonly<ServerBindingSignerProviderV1>
> {
  throw new Error("The production Server binding signer provider is unavailable.");
}

Object.freeze(loadProductionServerBindingSignerProviderV1);
