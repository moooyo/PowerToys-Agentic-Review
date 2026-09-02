import { describe, expect, it } from "vitest";
import { isPermanentWorkerClientError, WorkerApiError } from "./errors.js";

describe("WorkerApiError", () => {
  it("treats a superseded process instance as a terminal registration error", () => {
    const error = new WorkerApiError(
      "A newer process owns the node.",
      409,
      "worker_instance_superseded",
    );

    expect(error.isWorkerInstanceSuperseded).toBe(true);
    expect(error.isWorkerRegistrationLost).toBe(false);
    expect(error.isRetryable).toBe(false);
  });

  it("honors a trusted retryability override instead of the status fallback", () => {
    expect(
      new WorkerApiError("Storage integrity failed.", 503, "artifact_storage_integrity", {
        retryable: false,
      }).isRetryable,
    ).toBe(false);
    expect(
      new WorkerApiError("Request may be retried.", 400, "temporary_failure", {
        retryable: true,
      }).isRetryable,
    ).toBe(true);
  });

  it("keeps status-based retryability and ErrorOptions compatibility without an override", () => {
    const cause = new Error("connection reset");
    const transportError = new WorkerApiError("Transport failed.", undefined, undefined, {
      cause,
    });

    expect(transportError.isRetryable).toBe(true);
    expect(transportError.cause).toBe(cause);
    expect(new WorkerApiError("Server failed.", 503).isRetryable).toBe(true);
    expect(new WorkerApiError("Request failed.", 400).isRetryable).toBe(false);
  });

  it("does not expose the retryability override as serialized error metadata", () => {
    const error = new WorkerApiError("Remote failure.", 503, "remote_failure", {
      retryable: false,
    });

    expect(error).not.toHaveProperty("retryable");
    expect(error).not.toHaveProperty("retryableOverride");
    expect(JSON.stringify(error)).not.toContain("retryable");
  });
});

describe("isPermanentWorkerClientError", () => {
  it.each([
    "ERR_TLS_CERT_ALTNAME_FORMAT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_OSSL_PEM_NO_START_LINE",
    "ERR_OSSL_PKCS12_MAC_VERIFY_FAILURE",
    "ERR_OSSL_X509_KEY_VALUES_MISMATCH",
    "ERR_SSL_TLSV1_ALERT_CERTIFICATE_EXPIRED",
  ])("classifies permanent TLS client error code %s", (code) => {
    expect(isPermanentWorkerClientError(Object.assign(new Error("TLS failed."), { code }))).toBe(
      true,
    );
  });

  it.each([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ERR_TLS_HANDSHAKE_TIMEOUT",
  ])("keeps transient transport error code %s retryable", (code) => {
    expect(
      isPermanentWorkerClientError(Object.assign(new Error("Transport failed."), { code })),
    ).toBe(false);
  });

  it("recognizes a permanent TLS code through a bounded cause chain", () => {
    const cause = Object.assign(new Error("Certificate rejected."), { code: "CERT_REVOKED" });
    expect(isPermanentWorkerClientError(new Error("Request failed.", { cause }))).toBe(true);
  });

  it("does not classify error messages without a permanent code", () => {
    expect(isPermanentWorkerClientError(new Error("CERT_HAS_EXPIRED"))).toBe(false);
  });
});
