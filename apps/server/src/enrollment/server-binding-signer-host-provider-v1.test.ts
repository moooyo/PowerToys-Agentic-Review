import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  createClient: (): unknown => {
    throw new Error("Signer-host client was not configured.");
  },
}));

vi.mock("./server-binding-signer-host-client-v1.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-binding-signer-host-client-v1.js")>();
  return {
    ...actual,
    createServerBindingSignerHostDirectClientV1: (): unknown => harness.createClient(),
  };
});

import {
  ServerBindingSignerHostClientErrorV1,
  type ServerBindingSignerHostDirectClientV1,
} from "./server-binding-signer-host-client-v1.js";
import { createServerBindingSignerHostProviderV1 } from "./server-binding-signer-host-provider-v1.js";

const issuerPublicKeySpki = Buffer.alloc(91, 0x5a);

beforeEach(() => {
  harness.createClient = () => {
    throw new Error("Signer-host client was not configured.");
  };
});

describe("dormant Server binding signer-host provider v1", () => {
  it("exposes one frozen exact bridge and delegates only statement operations", async () => {
    const fixture = createFakeClient();
    harness.createClient = () => fixture.client;
    const provider = await createServerBindingSignerHostProviderV1();

    expect(Object.keys(provider).sort()).toEqual([
      "close",
      "issuerPublicKeySpki",
      "kind",
      "readTerminalError",
      "signActiveStatusStatementV1",
      "signReceiptStatementV1",
      "terminalFailure",
    ]);
    expect(Object.isFrozen(provider)).toBe(true);
    expect(provider.kind).toBe("binding-statements-v1");
    expect(Buffer.from(provider.issuerPublicKeySpki)).toEqual(issuerPublicKeySpki);
    expect(provider.issuerPublicKeySpki).not.toBe(fixture.issuerPublicKeySpki);
    expect(provider.terminalFailure).toBe(fixture.terminal.promise);
    expect(provider.readTerminalError()).toBeNull();

    const receipt = Buffer.from("receipt");
    const active = Buffer.from("active");
    const signal = new AbortController().signal;
    expect(Buffer.from(await provider.signReceiptStatementV1(receipt, signal))).toEqual(
      Buffer.from("receipt-signature"),
    );
    expect(Buffer.from(await provider.signActiveStatusStatementV1(active, signal))).toEqual(
      Buffer.from("active-signature"),
    );
    expect(fixture.receiptCalls).toEqual([{ signal, statement: receipt }]);
    expect(fixture.activeCalls).toEqual([{ signal, statement: active }]);
    const closing = provider.close();
    expect(provider.close()).toBe(closing);
    await closing;
    expect(fixture.closeCalls()).toBe(1);

    const terminalError = new ServerBindingSignerHostClientErrorV1(
      "SIGNER_HOST_OUTCOME_UNKNOWN",
      "The signer-host outcome is unknown.",
    );
    fixture.setTerminalError(terminalError);
    fixture.terminal.resolve(terminalError);
    expect(provider.readTerminalError()).toBe(terminalError);
    expect(await provider.terminalFailure).toBe(terminalError);
  });

  it("closes a failed startup and preserves the first stable client error", async () => {
    const startupError = new ServerBindingSignerHostClientErrorV1(
      "SIGNER_HOST_MISMATCH",
      "The signer-host startup identity is invalid.",
    );
    const fixture = createFakeClient({ ready: Promise.reject(startupError) });
    harness.createClient = () => fixture.client;

    await expect(createServerBindingSignerHostProviderV1()).rejects.toMatchObject({
      name: "ServerBindingSignerProviderStartupErrorV1",
      code: "SIGNER_MISMATCH",
    });
    expect(fixture.closeCalls()).toBe(1);

    const unproved = createFakeClient({
      cleanupProven: false,
      closeError: startupError,
      ready: Promise.reject(startupError),
    });
    harness.createClient = () => unproved.client;
    await expect(createServerBindingSignerHostProviderV1()).rejects.toMatchObject({
      name: "ServerBindingSignerProviderStartupErrorV1",
      code: "SIGNER_UNAVAILABLE",
      message: "The Server binding signer-host startup cleanup could not prove termination.",
    });
    expect(unproved.closeCalls()).toBe(1);
  });

  it("rejects missing SPKI and a terminal snapshot before returning a provider", async () => {
    const missing = createFakeClient({ issuerPublicKeySpki: null });
    harness.createClient = () => missing.client;
    await expect(createServerBindingSignerHostProviderV1()).rejects.toMatchObject({
      name: "ServerBindingSignerProviderStartupErrorV1",
      code: "SIGNER_MISMATCH",
    });
    expect(missing.closeCalls()).toBe(1);

    const terminalError = new ServerBindingSignerHostClientErrorV1(
      "SIGNER_HOST_OUTCOME_UNKNOWN",
      "The signer-host failed after readiness.",
    );
    const terminal = createFakeClient({ terminalError });
    harness.createClient = () => terminal.client;
    await expect(createServerBindingSignerHostProviderV1()).rejects.toMatchObject({
      name: "ServerBindingSignerProviderStartupErrorV1",
      code: "SIGNER_UNAVAILABLE",
    });
    expect(terminal.closeCalls()).toBe(1);
  });

  it("resolves a terminal client close only when cleanup proof is available", async () => {
    const terminalError = new ServerBindingSignerHostClientErrorV1(
      "SIGNER_HOST_OUTCOME_UNKNOWN",
      "The signer-host failed.",
    );
    const proved = createFakeClient({ closeError: terminalError, cleanupProven: true });
    harness.createClient = () => proved.client;
    const provedProvider = await createServerBindingSignerHostProviderV1();
    await expect(provedProvider.close()).resolves.toBeUndefined();

    const unproved = createFakeClient({ closeError: terminalError, cleanupProven: false });
    harness.createClient = () => unproved.client;
    const unprovedProvider = await createServerBindingSignerHostProviderV1();
    await expect(unprovedProvider.close()).rejects.toBe(terminalError);
  });
});

function createFakeClient(
  options: Readonly<{
    readonly cleanupProven?: boolean;
    readonly closeError?: Error;
    readonly issuerPublicKeySpki?: Uint8Array | null;
    readonly ready?: Promise<void>;
    readonly terminalError?: ServerBindingSignerHostClientErrorV1 | null;
  }> = {},
): {
  readonly activeCalls: Array<{ readonly signal: AbortSignal; readonly statement: Uint8Array }>;
  readonly client: Readonly<ServerBindingSignerHostDirectClientV1>;
  readonly closeCalls: () => number;
  readonly issuerPublicKeySpki: Uint8Array | null;
  readonly receiptCalls: Array<{ readonly signal: AbortSignal; readonly statement: Uint8Array }>;
  readonly setTerminalError: (error: ServerBindingSignerHostClientErrorV1 | null) => void;
  readonly terminal: PromiseWithResolvers<ServerBindingSignerHostClientErrorV1>;
} {
  const terminal = Promise.withResolvers<ServerBindingSignerHostClientErrorV1>();
  const receiptCalls: Array<{ readonly signal: AbortSignal; readonly statement: Uint8Array }> = [];
  const activeCalls: Array<{ readonly signal: AbortSignal; readonly statement: Uint8Array }> = [];
  const issuerSpki =
    options.issuerPublicKeySpki === undefined
      ? Uint8Array.from(issuerPublicKeySpki)
      : options.issuerPublicKeySpki;
  let terminalError = options.terminalError ?? null;
  let closeCalls = 0;
  const client = Object.freeze({
    close: async () => {
      closeCalls += 1;
      if (options.closeError !== undefined) throw options.closeError;
    },
    hasProvenCleanup: () => options.cleanupProven ?? true,
    readIssuerPublicKeySpki: () => (issuerSpki === null ? null : Uint8Array.from(issuerSpki)),
    readTerminalError: () => terminalError,
    ready: options.ready ?? Promise.resolve(),
    signActiveStatusStatementV1: async (statement: Uint8Array, signal: AbortSignal) => {
      activeCalls.push({ signal, statement });
      return Buffer.from("active-signature");
    },
    signReceiptStatementV1: async (statement: Uint8Array, signal: AbortSignal) => {
      receiptCalls.push({ signal, statement });
      return Buffer.from("receipt-signature");
    },
    terminalFailure: terminal.promise,
  } satisfies ServerBindingSignerHostDirectClientV1);
  return {
    activeCalls,
    client,
    closeCalls: () => closeCalls,
    issuerPublicKeySpki: issuerSpki,
    receiptCalls,
    setTerminalError: (error) => {
      terminalError = error;
    },
    terminal,
  };
}
