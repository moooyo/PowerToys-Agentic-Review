export interface WorkerApiErrorOptions extends ErrorOptions {
  readonly retryable?: boolean;
}

export class WorkerApiError extends Error {
  readonly #retryableOverride: boolean | undefined;

  public constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly errorCode?: string,
    options?: WorkerApiErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkerApiError";
    this.#retryableOverride = options?.retryable;
  }

  public get isLeaseLost(): boolean {
    return this.statusCode === 409 && this.errorCode === "lease_lost";
  }

  public get isWorkerRegistrationLost(): boolean {
    return (
      this.statusCode === 409 &&
      (this.errorCode === "worker_unavailable" ||
        this.errorCode === "not_registered" ||
        this.errorCode === "not_online")
    );
  }

  public get isWorkerInstanceSuperseded(): boolean {
    return this.statusCode === 409 && this.errorCode === "worker_instance_superseded";
  }

  public get isRetryable(): boolean {
    return (
      this.#retryableOverride ??
      (this.statusCode === undefined ||
        this.statusCode === 408 ||
        this.statusCode === 429 ||
        this.statusCode >= 500)
    );
  }
}

export class ProtocolError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtocolError";
  }
}

const permanentWorkerClientErrorCodes = new Set([
  "CERT_CHAIN_TOO_LONG",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_OSSL_ASN1_BAD_TAG",
  "ERR_OSSL_ASN1_HEADER_TOO_LONG",
  "ERR_OSSL_ASN1_NESTED_ASN1_ERROR",
  "ERR_OSSL_ASN1_TOO_LONG",
  "ERR_OSSL_ASN1_WRONG_TAG",
  "ERR_OSSL_EVP_BAD_DECRYPT",
  "ERR_OSSL_EVP_UNSUPPORTED",
  "ERR_OSSL_PEM_BAD_BASE64_DECODE",
  "ERR_OSSL_PEM_BAD_DECRYPT",
  "ERR_OSSL_PEM_BAD_END_LINE",
  "ERR_OSSL_PEM_BAD_PASSWORD_READ",
  "ERR_OSSL_PEM_NO_START_LINE",
  "ERR_OSSL_PKCS12_CIPHERFINAL_ERROR",
  "ERR_OSSL_PKCS12_MAC_VERIFY_FAILURE",
  "ERR_OSSL_PKCS12_PARSE_ERROR",
  "ERR_OSSL_SSL_NO_CIPHERS_AVAILABLE",
  "ERR_OSSL_X509_KEY_VALUES_MISMATCH",
  "ERR_OSSL_X509_UNKNOWN_CERTIFICATE_TYPE",
  "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_SSLV3_ALERT_UNSUPPORTED_CERTIFICATE",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
  "ERR_SSL_TLSV1_ALERT_ACCESS_DENIED",
  "ERR_SSL_TLSV1_ALERT_CERTIFICATE_EXPIRED",
  "ERR_SSL_TLSV1_ALERT_CERTIFICATE_REVOKED",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_INVALID_CONTEXT",
  "ERR_TLS_INVALID_PROTOCOL_METHOD",
  "ERR_TLS_INVALID_PROTOCOL_VERSION",
  "ERR_TLS_PROTOCOL_VERSION_CONFLICT",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "HOSTNAME_MISMATCH",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export function isPermanentWorkerClientError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null ||
      visited.has(current)
    ) {
      return false;
    }
    visited.add(current);
    const record = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof record.code === "string" && permanentWorkerClientErrorCodes.has(record.code)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

export function isFatalWorkerControlError(error: unknown): boolean {
  return (
    error instanceof ProtocolError ||
    (error instanceof WorkerApiError && !error.isRetryable && !error.isWorkerRegistrationLost) ||
    isPermanentWorkerClientError(error)
  );
}
