import type { DatabaseSync } from "node:sqlite";
import type {
  ConsumeOperatorLoginTransactionInput,
  CreateOperatorLoginTransactionInput,
  CreateOperatorSessionInput,
  DeleteOperatorSessionInput,
  FindOperatorSessionInput,
  OperatorSession,
} from "../security/operator-auth.js";

const sha256Pattern = /^[0-9a-f]{64}$/u;

const assertSha256 = (value: string): void => {
  if (!sha256Pattern.test(value)) {
    throw new TypeError("Operator authentication token hashes must be lowercase SHA-256 values.");
  }
};

const assertDateTime = (value: string, name: string): void => {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be a valid date-time value.`);
  }
};

export const createOperatorLoginTransaction = (
  database: DatabaseSync,
  input: CreateOperatorLoginTransactionInput,
): { readonly created: true } => {
  assertSha256(input.tokenSha256);
  assertDateTime(input.createdAt, "createdAt");
  assertDateTime(input.expiresAt, "expiresAt");
  database
    .prepare("DELETE FROM operator_login_transactions WHERE expires_at <= ?")
    .run(input.createdAt);
  database.prepare("DELETE FROM operator_sessions WHERE expires_at <= ?").run(input.createdAt);
  database
    .prepare(`
      INSERT INTO operator_login_transactions (token_sha256, created_at, expires_at)
      VALUES (?, ?, ?)
    `)
    .run(input.tokenSha256, input.createdAt, input.expiresAt);
  return { created: true };
};

export const consumeOperatorLoginTransaction = (
  database: DatabaseSync,
  input: ConsumeOperatorLoginTransactionInput,
): { readonly consumed: boolean } => {
  assertSha256(input.tokenSha256);
  assertDateTime(input.consumedAt, "consumedAt");
  const result = database
    .prepare(`
      DELETE FROM operator_login_transactions
      WHERE token_sha256 = ? AND expires_at > ?
    `)
    .run(input.tokenSha256, input.consumedAt);
  return { consumed: Number(result.changes) === 1 };
};

export const createOperatorSession = (
  database: DatabaseSync,
  input: CreateOperatorSessionInput,
): { readonly created: true } => {
  assertSha256(input.tokenSha256);
  assertDateTime(input.createdAt, "createdAt");
  assertDateTime(input.expiresAt, "expiresAt");
  database.prepare("DELETE FROM operator_sessions WHERE expires_at <= ?").run(input.createdAt);
  database
    .prepare(`
      INSERT INTO operator_sessions (
        token_sha256,
        issuer,
        subject,
        display_name,
        email,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.tokenSha256,
      input.issuer,
      input.subject,
      input.displayName,
      input.email,
      input.createdAt,
      input.expiresAt,
    );
  return { created: true };
};

export const findOperatorSession = (
  database: DatabaseSync,
  input: FindOperatorSessionInput,
): { readonly session: OperatorSession | null } => {
  assertSha256(input.tokenSha256);
  assertDateTime(input.accessedAt, "accessedAt");
  const session = database
    .prepare(`
      SELECT
        issuer,
        subject,
        display_name AS "displayName",
        email,
        created_at AS "createdAt",
        expires_at AS "expiresAt"
      FROM operator_sessions
      WHERE token_sha256 = ? AND expires_at > ?
    `)
    .get(input.tokenSha256, input.accessedAt) as unknown as OperatorSession | undefined;
  return { session: session ?? null };
};

export const deleteOperatorSession = (
  database: DatabaseSync,
  input: DeleteOperatorSessionInput,
): { readonly deleted: boolean } => {
  assertSha256(input.tokenSha256);
  const result = database
    .prepare("DELETE FROM operator_sessions WHERE token_sha256 = ?")
    .run(input.tokenSha256);
  return { deleted: Number(result.changes) === 1 };
};
