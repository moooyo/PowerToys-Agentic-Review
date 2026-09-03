import {
  createServerBindingSignerHostDirectClientV1,
  ServerBindingSignerHostClientErrorV1,
} from "./server-binding-signer-host-client-v1.js";
import {
  ServerBindingSignerProviderStartupErrorV1,
  type ServerBindingStatementSignerProviderV1,
} from "./server-binding-signer-provider-v1.js";

/** Creates the dormant statement-only bridge without exposing a profile or spawn seam. */
export async function createServerBindingSignerHostProviderV1(): Promise<
  Readonly<ServerBindingStatementSignerProviderV1>
> {
  const client = createServerBindingSignerHostDirectClientV1();
  try {
    await client.ready;
  } catch (error) {
    return await closeFailedStartup(client, error);
  }
  const issuerPublicKeySpki = client.readIssuerPublicKeySpki();
  const terminalError = client.readTerminalError();
  if (issuerPublicKeySpki === null || terminalError !== null) {
    return await closeFailedStartup(
      client,
      terminalError ??
        new ServerBindingSignerHostClientErrorV1(
          "SIGNER_HOST_MISMATCH",
          "The Server binding signer-host did not publish its issuer SPKI.",
        ),
    );
  }

  const readTerminalError = (): Error | null => client.readTerminalError();
  const signReceiptStatementV1 = (
    statementJson: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> => client.signReceiptStatementV1(statementJson, signal);
  const signActiveStatusStatementV1 = (
    statementJson: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> => client.signActiveStatusStatementV1(statementJson, signal);
  const closeClientWithCleanupProof = async (): Promise<void> => {
    try {
      await client.close();
    } catch (error) {
      if (error instanceof ServerBindingSignerHostClientErrorV1 && client.hasProvenCleanup())
        return;
      throw error;
    }
  };
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= closeClientWithCleanupProof();
    return closePromise;
  };
  Object.freeze(readTerminalError);
  Object.freeze(signReceiptStatementV1);
  Object.freeze(signActiveStatusStatementV1);
  Object.freeze(close);
  return Object.freeze({
    close,
    issuerPublicKeySpki: Uint8Array.from(issuerPublicKeySpki),
    kind: "binding-statements-v1" as const,
    readTerminalError,
    signActiveStatusStatementV1,
    signReceiptStatementV1,
    terminalFailure: client.terminalFailure,
  });
}

Object.freeze(createServerBindingSignerHostProviderV1);

async function closeFailedStartup(
  client: Readonly<ReturnType<typeof createServerBindingSignerHostDirectClientV1>>,
  error: unknown,
): Promise<never> {
  let closeRejected = false;
  let closeError: unknown;
  try {
    await client.close();
  } catch (caught) {
    closeRejected = true;
    closeError = caught;
  }
  if (
    !client.hasProvenCleanup() ||
    (closeRejected && !(closeError instanceof ServerBindingSignerHostClientErrorV1))
  ) {
    throw new ServerBindingSignerProviderStartupErrorV1(
      "SIGNER_UNAVAILABLE",
      "The Server binding signer-host startup cleanup could not prove termination.",
    );
  }
  throw normalizeStartupError(error);
}

function normalizeStartupError(error: unknown): ServerBindingSignerProviderStartupErrorV1 {
  if (error instanceof ServerBindingSignerProviderStartupErrorV1) return error;
  if (
    error instanceof ServerBindingSignerHostClientErrorV1 &&
    (error.code === "SIGNER_HOST_MISMATCH" || error.code === "SIGNER_HOST_PROTOCOL_FAILURE")
  ) {
    return new ServerBindingSignerProviderStartupErrorV1(
      "SIGNER_MISMATCH",
      "The Server binding signer-host startup identity is invalid.",
    );
  }
  return new ServerBindingSignerProviderStartupErrorV1(
    "SIGNER_UNAVAILABLE",
    "The Server binding signer-host is unavailable.",
  );
}
