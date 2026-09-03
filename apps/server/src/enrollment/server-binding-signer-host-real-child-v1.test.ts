import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  deriveServerBindingIssuerKeyIdV1,
  marshalServerBindingActiveStatusV1,
  marshalServerBindingReceiptStatementV1,
  marshalServerBindingReceiptV1,
  SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
  SERVER_BINDING_AUTHORITY_ISSUER,
  SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
  SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
  SERVER_BINDING_RECEIPT_PROFILE_ID,
  type ServerBindingActiveStatusStatementV1,
  type ServerBindingReceiptStatementV1,
  verifyServerBindingActiveStatusWithSpkiV1,
  verifyServerBindingReceiptWithSpkiV1,
} from "@agentic-review/contracts/server-binding-authority-v1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileHarness = vi.hoisted(() => ({
  fixturePath: "",
  scenario: "normal",
  workingDirectory: "",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      executablePath: string,
      argumentsList: readonly string[],
      options: SpawnOptionsWithoutStdio,
    ) => {
      if (
        executablePath !== process.execPath ||
        argumentsList.length !== 1 ||
        argumentsList[0] !== "--server-binding-signer-host-v1" ||
        options.cwd !== profileHarness.workingDirectory ||
        options.detached !== false ||
        options.shell !== false ||
        options.windowsHide !== true ||
        JSON.stringify(options.stdio) !== '["pipe","pipe","pipe"]' ||
        options.env === undefined ||
        Reflect.getPrototypeOf(options.env) !== null ||
        Object.keys(options.env).length !== 0
      ) {
        throw new Error("The production signer-host spawn shape changed.");
      }
      return actual.spawn(
        executablePath,
        [
          profileHarness.fixturePath,
          `--fixture-scenario=${profileHarness.scenario}`,
          ...argumentsList,
        ],
        options,
      );
    },
  };
});

vi.mock("./server-binding-signer-host-profile-v1.js", () => ({
  loadProductionServerBindingSignerHostProfileV1: async () => ({
    arguments: ["--server-binding-signer-host-v1"],
    executablePath: process.execPath,
    workingDirectory: profileHarness.workingDirectory,
  }),
}));

import { createServerBindingSignerHostDirectClientV1 } from "./server-binding-signer-host-client-v1.js";
import { createServerBindingSignerHostProviderV1 } from "./server-binding-signer-host-provider-v1.js";

const fixturePath = resolve(
  process.cwd(),
  "apps/server/testdata/server-binding-signer-host-fixture-v1.mjs",
);
const receiptStatement: ServerBindingReceiptStatementV1 = Object.freeze({
  bindingId: "0f7d78fa-f002-4ede-9cd6-06951ee9b745",
  bindingRevision: 1,
  boundAt: "2026-09-03T01:02:03.004Z",
  certificateDerSha256: "11".repeat(32),
  enrollmentGeneration: 1,
  installationId: "worker.installation-1",
  statementType: "durable-binding-created",
  workerNodeId: "worker:node-1",
});
const activeStatusStatement: ServerBindingActiveStatusStatementV1 = Object.freeze({
  bindingId: receiptStatement.bindingId,
  bindingRevision: 1,
  certificateDerSha256: receiptStatement.certificateDerSha256,
  challengeNonceBase64Url: "A".repeat(43),
  enrollmentGeneration: 1,
  expiresAt: "2026-09-03T01:02:33.004Z",
  installationId: receiptStatement.installationId,
  issuedAt: "2026-09-03T01:02:03.004Z",
  receiptSha256: "22".repeat(32),
  recordDocumentSha256: "33".repeat(32),
  statementType: "active-binding-current",
  workerNodeId: receiptStatement.workerNodeId,
});

let workingDirectory = "";

beforeEach(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), "agentic-review-signer-host-v1-"));
  profileHarness.fixturePath = fixturePath;
  profileHarness.workingDirectory = workingDirectory;
  selectScenario("normal");
});

afterEach(async () => {
  await rm(workingDirectory, { force: true, recursive: true });
});

describe("dormant Server binding signer-host real child fixture v1", () => {
  it("signs both exact S0 statements and exits after acknowledged shutdown", async () => {
    const client = createServerBindingSignerHostDirectClientV1();
    await client.ready;
    const spki = client.readIssuerPublicKeySpki();
    if (spki === null) throw new Error("Expected fixture SPKI.");
    const issuerKeyId = deriveServerBindingIssuerKeyIdV1(spki);

    const receiptSignature = Buffer.from(
      await client.signReceiptStatementV1(
        Buffer.from(JSON.stringify(receiptStatement)),
        new AbortController().signal,
      ),
    ).toString("base64url");
    expect(
      verifyServerBindingReceiptWithSpkiV1(
        marshalServerBindingReceiptV1({
          algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
          issuer: SERVER_BINDING_AUTHORITY_ISSUER,
          issuerKeyId,
          profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
          schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
          signature: receiptSignature,
          statement: receiptStatement,
        }),
        spki,
      ).signatureValid,
    ).toBe(true);

    const activeSignature = Buffer.from(
      await client.signActiveStatusStatementV1(
        Buffer.from(JSON.stringify(activeStatusStatement)),
        new AbortController().signal,
      ),
    ).toString("base64url");
    expect(
      verifyServerBindingActiveStatusWithSpkiV1(
        marshalServerBindingActiveStatusV1({
          algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
          issuer: SERVER_BINDING_AUTHORITY_ISSUER,
          issuerKeyId,
          profileId: SERVER_BINDING_ACTIVE_STATUS_PROFILE_ID,
          schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
          signature: activeSignature,
          statement: activeStatusStatement,
        }),
        spki,
      ).signatureValid,
    ).toBe(true);

    await client.close();
    expect(client.readTerminalError()).toBeNull();
  });

  it("composes the statement-only provider over the real direct child", async () => {
    const provider = await createServerBindingSignerHostProviderV1();
    const spki = provider.issuerPublicKeySpki;
    const issuerKeyId = deriveServerBindingIssuerKeyIdV1(spki);
    const signature = Buffer.from(
      await provider.signReceiptStatementV1(
        marshalServerBindingReceiptStatementV1(receiptStatement),
        new AbortController().signal,
      ),
    ).toString("base64url");
    expect(
      verifyServerBindingReceiptWithSpkiV1(
        marshalServerBindingReceiptV1({
          algorithm: SERVER_BINDING_AUTHORITY_SIGNATURE_ALGORITHM,
          issuer: SERVER_BINDING_AUTHORITY_ISSUER,
          issuerKeyId,
          profileId: SERVER_BINDING_RECEIPT_PROFILE_ID,
          schemaVersion: SERVER_BINDING_AUTHORITY_SCHEMA_VERSION,
          signature,
          statement: receiptStatement,
        }),
        spki,
      ).signatureValid,
    ).toBe(true);
    const closing = provider.close();
    expect(provider.close()).toBe(closing);
    await closing;
  });

  it("fails closed on pre-ready exit and protocol corruption", async () => {
    selectScenario("exit_before_ready");
    const exited = createServerBindingSignerHostDirectClientV1();
    const exitError = await rejection(exited.ready);
    expect(exitError).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    await expect(exited.close()).rejects.toBe(exitError);

    selectScenario("protocol_corruption");
    const corrupt = createServerBindingSignerHostDirectClientV1();
    const protocolError = await rejection(corrupt.ready);
    expect(protocolError).toMatchObject({ code: "SIGNER_HOST_MISMATCH" });
    await expect(corrupt.close()).rejects.toBe(protocolError);

    selectScenario("stdout_overflow");
    const overflow = createServerBindingSignerHostDirectClientV1();
    const overflowError = await rejection(overflow.ready);
    expect(overflowError).toMatchObject({ code: "SIGNER_HOST_MISMATCH" });
    await expect(overflow.close()).rejects.toBe(overflowError);
  });

  it("kills a fixture whose signing event loop is blocked", async () => {
    selectScenario("hang_sign");
    const client = createServerBindingSignerHostDirectClientV1();
    await client.ready;
    const controller = new AbortController();
    const signing = client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      controller.signal,
    );
    const signingRejection = rejection(signing);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
    controller.abort();
    const error = await signingRejection;
    expect(error).toMatchObject({ code: "SIGNER_HOST_OUTCOME_UNKNOWN" });
    await expect(client.close()).rejects.toBe(error);
  });

  it("keeps cancellation terminal when the fixture can process the cancel frame", async () => {
    selectScenario("responsive_cancel");
    const client = createServerBindingSignerHostDirectClientV1();
    await client.ready;
    const controller = new AbortController();
    const signing = client.signReceiptStatementV1(
      Buffer.from(JSON.stringify(receiptStatement)),
      controller.signal,
    );
    const signingRejection = rejection(signing);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
    controller.abort();
    const error = await signingRejection;
    expect(error).toMatchObject({ code: "SIGNER_HOST_OUTCOME_UNKNOWN" });
    await expect(client.close()).rejects.toBe(error);
  });

  it("forces and proves exit when the fixture blocks during orderly shutdown", async () => {
    selectScenario("hang_shutdown");
    const client = createServerBindingSignerHostDirectClientV1();
    await client.ready;
    await client.close();
    expect(client.readTerminalError()).toBeNull();
  }, 20_000);

  it("drains and redacts a real stderr overflow before killing the fixture", async () => {
    selectScenario("stderr_overflow");
    const client = createServerBindingSignerHostDirectClientV1();
    const error = await rejection(client.ready);
    expect(error).toMatchObject({ code: "SIGNER_HOST_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toContain("fixture-secret-marker");
    await expect(client.close()).rejects.toBe(error);
  });
});

function selectScenario(
  scenario:
    | "normal"
    | "responsive_cancel"
    | "exit_before_ready"
    | "hang_shutdown"
    | "protocol_corruption"
    | "hang_sign"
    | "stderr_overflow"
    | "stdout_overflow",
): void {
  profileHarness.scenario = scenario;
}

async function rejection(promise: Promise<unknown>): Promise<Error & { readonly code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { readonly code?: string };
  }
  throw new Error("Expected rejection.");
}
