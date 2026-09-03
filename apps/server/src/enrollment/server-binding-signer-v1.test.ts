import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
} from "node:crypto";
import {
  deriveServerBindingIssuerKeyIdV1,
  marshalServerBindingReceiptStatementV1,
  marshalServerBindingReceiptV1,
  SERVER_BINDING_AUTHORITY_ISSUER,
  SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
  SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
  SERVER_BINDING_RECEIPT_PROFILE_ID,
  type ServerBindingReceiptStatementV1,
  type ServerBindingReceiptV1,
  serverBindingReceiptSigningDigestV1,
  serverBindingReceiptSigningPreimageV1,
  verifyServerBindingReceiptWithSpkiV1,
} from "@agentic-review/contracts/server-binding-authority-v1";
import { afterEach, describe, expect, it, vi } from "vitest";

const signerMaterialMock = vi.hoisted(() => ({
  provider: undefined as unknown,
  trustProfile: undefined as unknown,
}));

vi.mock("./server-binding-signer-provider-v1.js", () => ({
  loadProductionServerBindingSignerProviderV1: async (): Promise<unknown> => {
    if (signerMaterialMock.provider === undefined) {
      throw new Error("The mocked production signer provider is unavailable.");
    }
    return signerMaterialMock.provider;
  },
}));

vi.mock("./server-binding-trust-profile-v1.js", () => ({
  loadProductionServerBindingTrustProfileV1: async (): Promise<unknown> => {
    if (signerMaterialMock.trustProfile === undefined) {
      throw new Error("The mocked production trust profile is unavailable.");
    }
    return signerMaterialMock.trustProfile;
  },
}));

import * as signerModule from "./server-binding-signer-v1.js";

const {
  adoptServerBindingSignerV1,
  assertServerBindingSignerAdoptableV1,
  closeServerBindingSignerV1,
  closeUnadoptedServerBindingSignerV1,
  loadServerBindingSignerV1,
  readServerBindingSignerDescriptorV1,
  signServerBindingReceiptStatementV1,
} = signerModule;
const p256Order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const p256HalfOrder = p256Order >> 1n;
const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQggZDZZcSzKuD4h3Iu
rGCGLBlKcNoYbAjlNgwsgHcJ/iGhRANCAAT6/SVhOAT0FIVQ9/JY4HhWm2IM5fxA
F0qkH3Q//jWyVZNp7k5o+oDKezoZWbxoB46t9HT3+DoCEUaaBPUsIz+c
-----END PRIVATE KEY-----`;
const testPrivateKey = createPrivateKey(testPrivateKeyPem);
const issuerSpki = createPublicKey(testPrivateKey).export({ format: "der", type: "spki" });
const issuerKeyId = deriveServerBindingIssuerKeyIdV1(issuerSpki);

const statement: ServerBindingReceiptStatementV1 = Object.freeze({
  bindingId: "0f7d78fa-f002-4ede-9cd6-06951ee9b745",
  bindingRevision: 1,
  boundAt: "2026-09-03T01:02:03.004Z",
  certificateDerSha256: "11".repeat(32),
  enrollmentGeneration: 1,
  installationId: "worker.installation-1",
  statementType: "durable-binding-created",
  workerNodeId: "worker:node-1",
});

type TestProvider =
  | Readonly<{
      kind: "digest-native";
      issuerPublicKeySpki: Uint8Array;
      signDigest: (digest: Uint8Array) => Promise<unknown> | unknown;
    }>
  | Readonly<{
      kind: "preimage-sha256";
      issuerPublicKeySpki: Uint8Array;
      signPreimageSha256: (preimage: Uint8Array) => Promise<unknown> | unknown;
    }>;

afterEach(() => {
  signerMaterialMock.provider = undefined;
  signerMaterialMock.trustProfile = undefined;
});

describe("dormant Server binding signer v1", () => {
  it("keeps production loading unavailable without a reflective test attachment", async () => {
    expect(Object.keys(signerModule).sort()).toEqual([
      "ServerBindingSignerErrorV1",
      "adoptServerBindingSignerV1",
      "assertServerBindingSignerAdoptableV1",
      "closeServerBindingSignerV1",
      "closeUnadoptedServerBindingSignerV1",
      "loadServerBindingSignerV1",
      "readServerBindingSignerDescriptorV1",
      "signServerBindingReceiptStatementV1",
    ]);
    expect(loadServerBindingSignerV1.length).toBe(0);
    expect(Object.keys(loadServerBindingSignerV1)).toEqual([]);
    expect(Object.getOwnPropertySymbols(loadServerBindingSignerV1)).toEqual([]);
    expect(Object.isFrozen(loadServerBindingSignerV1)).toBe(true);

    await expect(loadServerBindingSignerV1()).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
      message: "The Server binding trust profile is unavailable.",
    });

    const productionProvider = await vi.importActual<
      typeof import("./server-binding-signer-provider-v1.js")
    >("./server-binding-signer-provider-v1.js");
    expect(Object.keys(productionProvider)).toEqual([
      "loadProductionServerBindingSignerProviderV1",
    ]);
    expect(
      Object.getOwnPropertySymbols(productionProvider.loadProductionServerBindingSignerProviderV1),
    ).toEqual([]);
    expect(Object.isFrozen(productionProvider.loadProductionServerBindingSignerProviderV1)).toBe(
      true,
    );
    await expect(productionProvider.loadProductionServerBindingSignerProviderV1()).rejects.toThrow(
      "The production Server binding signer provider is unavailable.",
    );
    const productionTrust = await vi.importActual<
      typeof import("./server-binding-trust-profile-v1.js")
    >("./server-binding-trust-profile-v1.js");
    expect(Object.keys(productionTrust)).toEqual(["loadProductionServerBindingTrustProfileV1"]);
    await expect(productionTrust.loadProductionServerBindingTrustProfileV1()).rejects.toThrow(
      "The production Server binding trust profile is unavailable.",
    );
  });

  it("signs the exact preimage and returns frozen trusted facts", async () => {
    const observedInputs: Buffer[] = [];
    const context = await loadWithProvider({
      issuerPublicKeySpki: issuerSpki,
      kind: "preimage-sha256",
      signPreimageSha256: (preimage) => {
        observedInputs.push(Buffer.from(preimage));
        return forceHighS(
          nodeSign("sha256", preimage, {
            dsaEncoding: "ieee-p1363",
            key: testPrivateKey,
          }),
        );
      },
    });

    expect(Object.isFrozen(context)).toBe(true);
    expect(context.issuerKeyId).toBe(issuerKeyId);
    expect("sign" in context).toBe(false);

    const firstSpki = context.issuerPublicKeySpki as Uint8Array;
    firstSpki[0] = 0;
    expect(Buffer.from(context.issuerPublicKeySpki)).toEqual(issuerSpki);
    expect(context.issuerPublicKeySpki).not.toBe(firstSpki);
    expect(readServerBindingSignerDescriptorV1(context)).toEqual({
      issuerKeyId,
      issuerPublicKeySpki: Uint8Array.from(issuerSpki),
    });

    const signature = await signServerBindingReceiptStatementV1(context, statement);
    expect(observedInputs).toEqual([Buffer.from(serverBindingReceiptSigningPreimageV1(statement))]);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(
      readUnsignedBigEndian(Buffer.from(signature, "base64url").subarray(32)),
    ).toBeLessThanOrEqual(p256HalfOrder);
    verifySignature(signature);
  });

  it("passes only the already-derived digest to a digest-native provider", async () => {
    const preimage = serverBindingReceiptSigningPreimageV1(statement);
    const validRawSignature = nodeSign("sha256", preimage, {
      dsaEncoding: "ieee-p1363",
      key: testPrivateKey,
    });
    const observedInputs: Buffer[] = [];
    const context = await loadWithProvider({
      issuerPublicKeySpki: issuerSpki,
      kind: "digest-native",
      signDigest: (digest) => {
        observedInputs.push(Buffer.from(digest));
        return forceHighS(validRawSignature);
      },
    });

    const signature = await signServerBindingReceiptStatementV1(
      context,
      marshalServerBindingReceiptStatementV1(statement),
    );
    expect(observedInputs).toEqual([Buffer.from(serverBindingReceiptSigningDigestV1(statement))]);
    verifySignature(signature);
  });

  it("rejects digest-provider double hashing after complete re-verification", async () => {
    const context = await loadWithProvider({
      issuerPublicKeySpki: issuerSpki,
      kind: "digest-native",
      signDigest: (digest) =>
        nodeSign("sha256", digest, {
          dsaEncoding: "ieee-p1363",
          key: testPrivateKey,
        }),
    });

    await expect(signServerBindingReceiptStatementV1(context, statement)).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
    });
  });

  it("rejects invalid signatures and provider failures", async () => {
    const { privateKey: wrongPrivateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const preimage = serverBindingReceiptSigningPreimageV1(statement);
    const candidates: ReadonlyArray<Readonly<{ expectedCode: string; result: () => unknown }>> = [
      {
        expectedCode: "SIGNATURE_INVALID",
        result: () => nodeSign("sha256", preimage, testPrivateKey),
      },
      { expectedCode: "SIGNATURE_INVALID", result: () => Buffer.alloc(63) },
      { expectedCode: "SIGNATURE_INVALID", result: () => Buffer.alloc(64) },
      {
        expectedCode: "SIGNATURE_INVALID",
        result: () =>
          nodeSign("sha256", preimage, {
            dsaEncoding: "ieee-p1363",
            key: wrongPrivateKey,
          }),
      },
      {
        expectedCode: "SIGNER_UNAVAILABLE",
        result: () => {
          throw new Error("provider-private detail");
        },
      },
    ];

    for (const candidate of candidates) {
      const context = await loadWithProvider({
        issuerPublicKeySpki: issuerSpki,
        kind: "preimage-sha256",
        signPreimageSha256: candidate.result,
      });
      await expect(signServerBindingReceiptStatementV1(context, statement)).rejects.toMatchObject({
        code: candidate.expectedCode,
      });
    }
  });

  it("cancels active signing and closes the provider exactly once", async () => {
    let closeCalls = 0;
    let observedSignal: AbortSignal | undefined;
    const context = await loadWithRawMaterial(
      Object.freeze({
        close: async () => {
          closeCalls += 1;
        },
        issuerPublicKeySpki: Uint8Array.from(issuerSpki),
        kind: "preimage-sha256" as const,
        signPreimageSha256: (_preimage: Uint8Array, signal: AbortSignal) => {
          observedSignal = signal;
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      }),
    );
    const owner = {};
    adoptServerBindingSignerV1(context, owner);
    const signing = signServerBindingReceiptStatementV1(context, statement);
    await Promise.resolve();
    expect(observedSignal?.aborted).toBe(false);

    const closing = closeServerBindingSignerV1(context, owner);
    expect(closeServerBindingSignerV1(context, owner)).toBe(closing);
    await expect(signing).rejects.toMatchObject({ code: "SIGNER_UNAVAILABLE" });
    await expect(closing).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it("permits exactly one owner and rejects descriptors after close", async () => {
    const context = await loadWithProvider({
      issuerPublicKeySpki: issuerSpki,
      kind: "preimage-sha256",
      signPreimageSha256: () => Buffer.alloc(64),
    });
    const owner = {};
    expect(() => assertServerBindingSignerAdoptableV1(context)).not.toThrow();
    adoptServerBindingSignerV1(context, owner);
    expect(() => assertServerBindingSignerAdoptableV1(context)).toThrowError(
      expect.objectContaining({ code: "SIGNER_UNAVAILABLE" }),
    );
    expect(() => adoptServerBindingSignerV1(context, {})).toThrowError(
      expect.objectContaining({ code: "SIGNER_UNAVAILABLE" }),
    );
    await closeServerBindingSignerV1(context, owner);
    expect(() => readServerBindingSignerDescriptorV1(context)).toThrowError(
      expect.objectContaining({ code: "SIGNER_UNAVAILABLE" }),
    );
  });

  it("closes an unadopted signer exactly once without taking an adopted signer", async () => {
    let unadoptedCloseCalls = 0;
    const unadopted = await loadWithRawMaterial(
      Object.freeze({
        close: async () => {
          unadoptedCloseCalls += 1;
        },
        issuerPublicKeySpki: Uint8Array.from(issuerSpki),
        kind: "preimage-sha256" as const,
        signPreimageSha256: async () => Buffer.alloc(64),
      }),
    );
    const firstClose = closeUnadoptedServerBindingSignerV1(unadopted);
    expect(closeUnadoptedServerBindingSignerV1(unadopted)).toBe(firstClose);
    await expect(firstClose).resolves.toBe("closed");
    expect(unadoptedCloseCalls).toBe(1);
    expect(() => readServerBindingSignerDescriptorV1(unadopted)).toThrowError(
      expect.objectContaining({ code: "SIGNER_UNAVAILABLE" }),
    );

    const adopted = await loadWithProvider({
      issuerPublicKeySpki: issuerSpki,
      kind: "preimage-sha256",
      signPreimageSha256: () => Buffer.alloc(64),
    });
    const owner = {};
    adoptServerBindingSignerV1(adopted, owner);
    await expect(closeUnadoptedServerBindingSignerV1(adopted)).resolves.toBe("already_adopted");
    expect(readServerBindingSignerDescriptorV1(adopted).issuerKeyId).toBe(issuerKeyId);
    await closeServerBindingSignerV1(adopted, owner);
  });

  it("rejects synchronous provider results and non-Promise close operations", async () => {
    const synchronousSigner = await loadWithRawMaterial(
      Object.freeze({
        close: async () => undefined,
        issuerPublicKeySpki: Uint8Array.from(issuerSpki),
        kind: "preimage-sha256" as const,
        signPreimageSha256: () => Buffer.alloc(64),
      }),
    );
    await expect(
      signServerBindingReceiptStatementV1(synchronousSigner, statement),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
    await closeUnadoptedServerBindingSignerV1(synchronousSigner);

    const synchronousClose = await loadWithRawMaterial(
      Object.freeze({
        close: () => undefined,
        issuerPublicKeySpki: Uint8Array.from(issuerSpki),
        kind: "preimage-sha256" as const,
        signPreimageSha256: async () => Buffer.alloc(64),
      }),
    );
    await expect(closeUnadoptedServerBindingSignerV1(synchronousClose)).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
  });

  it("requires exact canonical trust and provider SPKIs in the loaded material", async () => {
    const { publicKey: wrongP256PublicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const { publicKey: p384PublicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const wrongP256Spki = wrongP256PublicKey.export({ format: "der", type: "spki" });
    const p384Spki = p384PublicKey.export({ format: "der", type: "spki" });
    const malformedP256Spki = Buffer.from(issuerSpki);
    malformedP256Spki[0] = 0xcf;
    let rejectedProviderCloseCalls = 0;

    await expect(
      loadWithRawMaterial(
        Object.freeze({
          close: async () => {
            rejectedProviderCloseCalls += 1;
          },
          issuerPublicKeySpki: wrongP256Spki,
          kind: "preimage-sha256",
          signPreimageSha256: () => Buffer.alloc(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
    expect(rejectedProviderCloseCalls).toBe(1);

    for (const invalidTrustedSpki of [
      p384Spki,
      malformedP256Spki,
      Buffer.concat([issuerSpki, Buffer.from([0])]),
    ]) {
      await expect(
        loadWithProvider(
          {
            issuerPublicKeySpki: issuerSpki,
            kind: "preimage-sha256",
            signPreimageSha256: () => Buffer.alloc(64),
          },
          invalidTrustedSpki,
        ),
      ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
    }
  });

  it("rejects malformed material, ambiguous providers, and forged contexts", async () => {
    await expect(
      loadWithRawMaterial(Object.freeze({ close: async () => undefined, provider: null })),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
    await expect(
      loadWithRawMaterial(
        createProvider({
          issuerPublicKeySpki: issuerSpki,
          kind: "digest-native",
          sign: () => Buffer.alloc(64),
          signDigest: () => Buffer.alloc(64),
        }),
      ),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });

    const validSignature = nodeSign("sha256", serverBindingReceiptSigningPreimageV1(statement), {
      dsaEncoding: "ieee-p1363",
      key: testPrivateKey,
    });
    const context = await loadWithProvider({
      issuerPublicKeySpki: issuerSpki,
      kind: "digest-native",
      signDigest: () => validSignature,
    });
    const canonical = Buffer.from(marshalServerBindingReceiptStatementV1(statement));
    await expect(
      signServerBindingReceiptStatementV1(context, Buffer.concat([Buffer.from(" "), canonical])),
    ).rejects.toMatchObject({ code: "SIGNER_INPUT_INVALID" });
    await expect(
      signServerBindingReceiptStatementV1(
        Object.freeze({
          issuerKeyId,
          issuerPublicKeySpki: Uint8Array.from(issuerSpki),
        }),
        statement,
      ),
    ).rejects.toMatchObject({ code: "SIGNER_MISMATCH" });
  });

  it("poisons signer loading when rejected candidate cleanup cannot prove termination", async () => {
    let closeCalls = 0;
    signerMaterialMock.provider = Object.freeze({
      close: async () => {
        closeCalls += 1;
        throw new Error("Private provider cleanup detail.");
      },
      issuerPublicKeySpki: Uint8Array.from(issuerSpki),
      kind: "invalid-provider-kind",
    });
    signerMaterialMock.trustProfile = Object.freeze({
      compiledTrustedIssuerPublicKeySpki: Uint8Array.from(issuerSpki),
    });
    const first = loadServerBindingSignerV1().catch((error: unknown) => error);
    const second = loadServerBindingSignerV1().catch((error: unknown) => error);
    const [observed, concurrentObserved] = await Promise.all([first, second]);
    signerMaterialMock.provider = undefined;
    signerMaterialMock.trustProfile = undefined;

    expect(observed).toMatchObject({
      name: "ServerBindingSignerErrorV1",
      code: "SIGNER_UNAVAILABLE",
      message: "The Server binding signer provider cleanup could not prove termination.",
      cause: expect.any(AggregateError),
    });
    expect(concurrentObserved).toBe(observed);
    expect(closeCalls).toBe(1);
    await expect(loadServerBindingSignerV1()).rejects.toBe(observed);
  });
});

async function loadWithProvider(
  provider: TestProvider,
  compiledTrustedIssuerPublicKeySpki: Uint8Array = issuerSpki,
) {
  const compliantProvider =
    provider.kind === "preimage-sha256"
      ? {
          ...provider,
          close: async () => undefined,
          signPreimageSha256: async (preimage: Uint8Array) => provider.signPreimageSha256(preimage),
        }
      : {
          ...provider,
          close: async () => undefined,
          signDigest: async (digest: Uint8Array) => provider.signDigest(digest),
        };
  return loadWithRawMaterial(
    Object.freeze(compliantProvider),
    Object.freeze({
      compiledTrustedIssuerPublicKeySpki: Uint8Array.from(compiledTrustedIssuerPublicKeySpki),
    }),
  );
}

function createProvider(provider: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...(provider as Record<string, unknown>), close: async () => undefined });
}

async function loadWithRawMaterial(
  provider: unknown,
  trustProfile: unknown = Object.freeze({
    compiledTrustedIssuerPublicKeySpki: Uint8Array.from(issuerSpki),
  }),
) {
  if (signerMaterialMock.provider !== undefined || signerMaterialMock.trustProfile !== undefined) {
    throw new Error("A signer material mock is already active.");
  }
  signerMaterialMock.provider = provider;
  signerMaterialMock.trustProfile = trustProfile;
  try {
    return await loadServerBindingSignerV1();
  } finally {
    signerMaterialMock.provider = undefined;
    signerMaterialMock.trustProfile = undefined;
  }
}

function verifySignature(signature: string): void {
  const receipt: ServerBindingReceiptV1 = {
    algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
    issuer: SERVER_BINDING_AUTHORITY_ISSUER,
    issuerKeyId,
    profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
    schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
    signature,
    statement,
  };
  expect(
    verifyServerBindingReceiptWithSpkiV1(marshalServerBindingReceiptV1(receipt), issuerSpki),
  ).toEqual(
    Object.freeze({
      algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
      documentKind: "receipt",
      issuerKeyId,
      signatureValid: true,
    }),
  );
}

function forceHighS(signature: Uint8Array): Buffer {
  const result = Buffer.from(signature);
  const s = readUnsignedBigEndian(result.subarray(32));
  if (s <= p256HalfOrder) writeUnsignedBigEndian(p256Order - s, result, 32, 32);
  return result;
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
  if (remaining !== 0n) throw new Error("Test scalar does not fit.");
}
