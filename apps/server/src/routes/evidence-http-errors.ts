import type { FastifyReply } from "fastify";
import type { EvidenceVerificationFailureCode } from "../database/evidence-verification-protocol.js";

interface EvidenceHttpFailure {
  readonly statusCode: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

type ErrorMapping = Omit<EvidenceHttpFailure, "code">;
const temporaryVerificationFailure: ErrorMapping = {
  statusCode: 503,
  message: "Evidence verification is temporarily unavailable. Retry after the indicated delay.",
  retryable: true,
};
const verificationErrors = {
  EVIDENCE_INVALID_SNAPSHOT: {
    statusCode: 400,
    message: "The evidence verification request is invalid.",
    retryable: false,
  },
  EVIDENCE_FILE_UNAVAILABLE: {
    statusCode: 404,
    message: "The evidence asset is unavailable.",
    retryable: false,
  },
  EVIDENCE_FILE_CHANGED: {
    statusCode: 409,
    message: "The evidence asset changed after it was recorded.",
    retryable: false,
  },
  EVIDENCE_INTEGRITY_FAILED: {
    statusCode: 409,
    message: "The evidence asset failed integrity verification.",
    retryable: false,
  },
  EVIDENCE_SCENARIO_MISMATCH: {
    statusCode: 409,
    message: "The evidence does not match the frozen validation scenario.",
    retryable: false,
  },
  EVIDENCE_VERIFIER_BUSY: temporaryVerificationFailure,
  EVIDENCE_VERIFIER_TIMEOUT: temporaryVerificationFailure,
  EVIDENCE_VERIFIER_CANCELLED: temporaryVerificationFailure,
  EVIDENCE_VERIFIER_UNAVAILABLE: temporaryVerificationFailure,
  EVIDENCE_VERIFIER_SHUTDOWN: temporaryVerificationFailure,
  EVIDENCE_VERIFIER_PROTOCOL: {
    statusCode: 503,
    message: "The evidence verifier returned an unsupported response.",
    retryable: false,
  },
} satisfies Record<EvidenceVerificationFailureCode, ErrorMapping>;

const storageErrors = {
  EVIDENCE_INVALID: {
    statusCode: 400,
    message: "The evidence request is invalid.",
    retryable: false,
  },
  EVIDENCE_LEASE_REJECTED: {
    statusCode: 409,
    message: "The active validation lease does not authorize this upload.",
    retryable: false,
  },
  EVIDENCE_CONFLICT: {
    statusCode: 409,
    message: "The evidence upload conflicts with its committed state.",
    retryable: false,
  },
  EVIDENCE_QUOTA: {
    statusCode: 413,
    message: "The evidence storage quota has been reached.",
    retryable: false,
  },
  EVIDENCE_UNAVAILABLE: {
    statusCode: 503,
    message: "Evidence bytes are unavailable or failed integrity checks.",
    retryable: false,
  },
  EVIDENCE_NOT_FOUND: {
    statusCode: 404,
    message: "The evidence asset was not found in this attempt.",
    retryable: false,
  },
} satisfies Record<string, ErrorMapping>;

const evidenceErrors: Readonly<Record<string, ErrorMapping>> = {
  ...verificationErrors,
  ...storageErrors,
  DATABASE_WORKER_SHUTTING_DOWN: {
    statusCode: 503,
    message: "The service is shutting down. Retry after the indicated delay.",
    retryable: true,
  },
};

export function mapEvidenceHttpError(error: unknown): EvidenceHttpFailure | undefined {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string")
    return undefined;
  if (!Object.hasOwn(evidenceErrors, error.code)) return undefined;
  const mapping = evidenceErrors[error.code];
  return mapping === undefined ? undefined : { ...mapping, code: error.code.toLowerCase() };
}

export function sendMappedEvidenceError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  const mapped = mapEvidenceHttpError(error);
  if (mapped === undefined) return undefined;
  if (mapped.statusCode === 503 && mapped.retryable) reply.header("retry-after", "1");
  return reply.code(mapped.statusCode).send({
    code: mapped.code,
    message: mapped.message,
    retryable: mapped.retryable,
  });
}
