import type { DatabaseSync } from "node:sqlite";
import type {
  BeginOperatorLoginInput,
  BeginOperatorLoginResult,
  ClaimOperatorLoginTransactionInput,
  CreateOperatorSessionInput,
  DeleteOperatorBrowserFlowInput,
  DeleteOperatorSessionInput,
  FinalizeOperatorLoginInput,
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

const advanceOperatorAuthClock = (database: DatabaseSync): string => {
  database.exec(`
    UPDATE operator_auth_clock
    SET last_observed_at = MAX(
      last_observed_at,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    WHERE singleton = 1
  `);
  const row = database
    .prepare("SELECT last_observed_at AS now FROM operator_auth_clock WHERE singleton = 1")
    .get() as { readonly now: string } | undefined;
  if (row === undefined || !Number.isFinite(Date.parse(row.now))) {
    throw new Error("Operator authentication clock state is unavailable.");
  }
  return row.now;
};

const assertFuture = (value: string, now: string, name: string): void => {
  if (value <= now) {
    throw new TypeError(`${name} must be later than the authoritative database time.`);
  }
};

export interface CleanupExpiredOperatorAuthInput {
  readonly batchSize: number;
}

export interface CleanupExpiredOperatorAuthResult {
  readonly deletedBrowserFlows: number;
  readonly deletedLoginTransactions: number;
  readonly deletedSessions: number;
  readonly hasMore: boolean;
}

export interface PurgeOperatorAuthForRecoveryResult {
  readonly deletedBrowserFlows: number;
  readonly deletedLoginTransactions: number;
  readonly deletedSessions: number;
}

const assertGeneration = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Operator authentication browser generation must be a positive integer.");
  }
};

export const beginOperatorLogin = (
  database: DatabaseSync,
  input: BeginOperatorLoginInput,
): BeginOperatorLoginResult => {
  assertSha256(input.transactionTokenSha256);
  assertSha256(input.browserSha256);
  assertDateTime(input.transactionExpiresAt, "transactionExpiresAt");
  assertDateTime(input.browserExpiresAt, "browserExpiresAt");

  database.exec("BEGIN IMMEDIATE");
  try {
    const authoritativeNow = advanceOperatorAuthClock(database);
    assertFuture(input.transactionExpiresAt, authoritativeNow, "transactionExpiresAt");
    assertFuture(input.browserExpiresAt, authoritativeNow, "browserExpiresAt");
    const existing = database
      .prepare("SELECT generation FROM operator_browser_flows WHERE browser_sha256 = ?")
      .get(input.browserSha256) as { readonly generation: number } | undefined;
    const generation = existing === undefined ? 1 : existing.generation + 1;
    assertGeneration(generation);

    if (existing === undefined) {
      database
        .prepare(`
          INSERT INTO operator_browser_flows (
            browser_sha256, generation, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          input.browserSha256,
          generation,
          authoritativeNow,
          authoritativeNow,
          input.browserExpiresAt,
        );
    } else {
      database
        .prepare(`
          UPDATE operator_browser_flows
          SET generation = ?,
              updated_at = ?,
              expires_at = ?
          WHERE browser_sha256 = ?
        `)
        .run(generation, authoritativeNow, input.browserExpiresAt, input.browserSha256);
    }

    database
      .prepare("DELETE FROM operator_login_transactions WHERE browser_sha256 = ?")
      .run(input.browserSha256);
    database
      .prepare("DELETE FROM operator_sessions WHERE browser_sha256 = ?")
      .run(input.browserSha256);
    database
      .prepare(`
        INSERT INTO operator_login_transactions (
          token_sha256, created_at, expires_at, browser_sha256, browser_generation
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        input.transactionTokenSha256,
        authoritativeNow,
        input.transactionExpiresAt,
        input.browserSha256,
        generation,
      );

    database.exec("COMMIT");
    return { browserGeneration: generation, browserExpiresAt: input.browserExpiresAt };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const claimOperatorLoginTransaction = (
  database: DatabaseSync,
  input: ClaimOperatorLoginTransactionInput,
): { readonly browserGeneration: number | null } => {
  assertSha256(input.transactionTokenSha256);
  assertSha256(input.browserSha256);
  database.exec("BEGIN IMMEDIATE");
  try {
    const authoritativeNow = advanceOperatorAuthClock(database);
    const claimed = database
      .prepare(`
        UPDATE operator_login_transactions
        SET claimed_at = ?
        WHERE token_sha256 = ?
          AND browser_sha256 = ?
          AND claimed_at IS NULL
          AND expires_at > ?
          AND EXISTS (
            SELECT 1
            FROM operator_browser_flows AS browser
            WHERE browser.browser_sha256 = operator_login_transactions.browser_sha256
              AND browser.expires_at > ?
              AND browser.generation = operator_login_transactions.browser_generation
          )
        RETURNING browser_generation AS "browserGeneration"
      `)
      .get(
        authoritativeNow,
        input.transactionTokenSha256,
        input.browserSha256,
        authoritativeNow,
        authoritativeNow,
      ) as { readonly browserGeneration: number } | undefined;
    if (claimed !== undefined) {
      assertGeneration(claimed.browserGeneration);
    }
    database.exec("COMMIT");
    return { browserGeneration: claimed?.browserGeneration ?? null };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const finalizeOperatorLogin = (
  database: DatabaseSync,
  input: FinalizeOperatorLoginInput,
): { readonly finalized: boolean } => {
  assertSha256(input.transactionTokenSha256);
  assertSha256(input.sessionTokenSha256);
  assertSha256(input.browserSha256);
  assertGeneration(input.browserGeneration);
  assertDateTime(input.createdAt, "createdAt");
  assertDateTime(input.expiresAt, "expiresAt");

  database.exec("BEGIN IMMEDIATE");
  try {
    const authoritativeNow = advanceOperatorAuthClock(database);
    assertFuture(input.expiresAt, authoritativeNow, "expiresAt");
    const claimedTransaction = database
      .prepare(`
        DELETE FROM operator_login_transactions
        WHERE token_sha256 = ?
          AND browser_sha256 = ?
          AND browser_generation = ?
          AND claimed_at IS NOT NULL
          AND expires_at > ?
          AND EXISTS (
            SELECT 1
            FROM operator_browser_flows AS browser
            WHERE browser.browser_sha256 = operator_login_transactions.browser_sha256
              AND browser.expires_at > ?
              AND browser.generation = operator_login_transactions.browser_generation
          )
        RETURNING 1 AS consumed
      `)
      .get(
        input.transactionTokenSha256,
        input.browserSha256,
        input.browserGeneration,
        authoritativeNow,
        authoritativeNow,
      ) as { readonly consumed: number } | undefined;
    if (claimedTransaction === undefined) {
      database.exec("ROLLBACK");
      return { finalized: false };
    }

    database
      .prepare(`
        UPDATE operator_browser_flows
        SET expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END
        WHERE browser_sha256 = ? AND generation = ?
      `)
      .run(input.expiresAt, input.expiresAt, input.browserSha256, input.browserGeneration);
    database
      .prepare(`
        INSERT INTO operator_sessions (
          token_sha256,
          issuer,
          subject,
          display_name,
          email,
          created_at,
          expires_at,
          browser_sha256,
          browser_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.sessionTokenSha256,
        input.issuer,
        input.subject,
        input.displayName,
        input.email,
        authoritativeNow,
        input.expiresAt,
        input.browserSha256,
        input.browserGeneration,
      );
    database.exec("COMMIT");
    return { finalized: true };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const createOperatorSession = (
  database: DatabaseSync,
  input: CreateOperatorSessionInput,
): { readonly created: true } => {
  assertSha256(input.tokenSha256);
  assertDateTime(input.createdAt, "createdAt");
  assertDateTime(input.expiresAt, "expiresAt");
  const authoritativeNow = advanceOperatorAuthClock(database);
  assertFuture(input.expiresAt, authoritativeNow, "expiresAt");
  database
    .prepare(`
      INSERT INTO operator_sessions (
        token_sha256,
        issuer,
        subject,
        display_name,
        email,
        created_at,
        expires_at,
        browser_sha256,
        browser_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.tokenSha256,
      input.issuer,
      input.subject,
      input.displayName,
      input.email,
      authoritativeNow,
      input.expiresAt,
      input.browserSha256,
      input.browserGeneration,
    );
  return { created: true };
};

export const findOperatorSession = (
  database: DatabaseSync,
  input: FindOperatorSessionInput,
): { readonly session: OperatorSession | null } => {
  assertSha256(input.tokenSha256);
  if (input.browserSha256 !== null) {
    assertSha256(input.browserSha256);
  }
  const candidate = (
    input.browserSha256 === null
      ? database
          .prepare(`
            SELECT 1 AS present
            FROM operator_sessions
            WHERE token_sha256 = ?
              AND browser_sha256 IS NULL
              AND browser_generation IS NULL
            LIMIT 1
          `)
          .get(input.tokenSha256)
      : database
          .prepare(`
            SELECT 1 AS present
            FROM operator_sessions
            WHERE token_sha256 = ?
              AND browser_sha256 = ?
              AND browser_generation IS NOT NULL
            LIMIT 1
          `)
          .get(input.tokenSha256, input.browserSha256)
  ) as { readonly present: number } | undefined;
  if (candidate === undefined) {
    return { session: null };
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const authoritativeNow = advanceOperatorAuthClock(database);
    const session = (input.browserSha256 === null
      ? database
          .prepare(`
            SELECT
              issuer,
              subject,
              display_name AS "displayName",
              email,
              created_at AS "createdAt",
              expires_at AS "expiresAt"
            FROM operator_sessions
            WHERE token_sha256 = ?
              AND browser_sha256 IS NULL
              AND browser_generation IS NULL
              AND expires_at > ?
          `)
          .get(input.tokenSha256, authoritativeNow)
      : database
          .prepare(`
            SELECT
              session.issuer,
              session.subject,
              session.display_name AS "displayName",
              session.email,
              session.created_at AS "createdAt",
              session.expires_at AS "expiresAt"
            FROM operator_sessions AS session
            JOIN operator_browser_flows AS browser
              ON browser.browser_sha256 = session.browser_sha256
            WHERE session.token_sha256 = ?
              AND session.browser_sha256 = ?
              AND session.expires_at > ?
              AND browser.expires_at > ?
              AND browser.generation = session.browser_generation
          `)
          .get(
            input.tokenSha256,
            input.browserSha256,
            authoritativeNow,
            authoritativeNow,
          )) as unknown as OperatorSession | undefined;
    if (session === undefined) {
      if (input.browserSha256 === null) {
        database
          .prepare(`
            DELETE FROM operator_sessions
            WHERE token_sha256 = ?
              AND browser_sha256 IS NULL
              AND browser_generation IS NULL
          `)
          .run(input.tokenSha256);
      } else {
        database
          .prepare(`
            DELETE FROM operator_sessions
            WHERE token_sha256 = ?
              AND browser_sha256 = ?
          `)
          .run(input.tokenSha256, input.browserSha256);
      }
    }
    database.exec("COMMIT");
    return { session: session ?? null };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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

export const deleteOperatorBrowserFlow = (
  database: DatabaseSync,
  input: DeleteOperatorBrowserFlowInput,
): { readonly deleted: boolean } => {
  assertSha256(input.browserSha256);
  const result = database
    .prepare("DELETE FROM operator_browser_flows WHERE browser_sha256 = ?")
    .run(input.browserSha256);
  return { deleted: Number(result.changes) === 1 };
};

export const purgeOperatorAuthForRecovery = (
  database: DatabaseSync,
): PurgeOperatorAuthForRecoveryResult => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const loginResult = database.prepare("DELETE FROM operator_login_transactions").run();
    const sessionResult = database.prepare("DELETE FROM operator_sessions").run();
    const browserResult = database.prepare("DELETE FROM operator_browser_flows").run();
    database.exec("COMMIT");
    return {
      deletedBrowserFlows: Number(browserResult.changes),
      deletedLoginTransactions: Number(loginResult.changes),
      deletedSessions: Number(sessionResult.changes),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const cleanupExpiredOperatorAuth = (
  database: DatabaseSync,
  input: CleanupExpiredOperatorAuthInput,
): CleanupExpiredOperatorAuthResult => {
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize <= 0 || input.batchSize > 10_000) {
    throw new TypeError("Operator authentication cleanup batchSize must be between 1 and 10000.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const authoritativeNow = advanceOperatorAuthClock(database);
    const loginResult = database
      .prepare(`
        DELETE FROM operator_login_transactions
        WHERE rowid IN (
          SELECT rowid
          FROM operator_login_transactions
          WHERE expires_at <= ?
          ORDER BY expires_at, rowid
          LIMIT ?
        )
      `)
      .run(authoritativeNow, input.batchSize);
    const sessionResult = database
      .prepare(`
        DELETE FROM operator_sessions
        WHERE rowid IN (
          SELECT rowid
          FROM operator_sessions
          WHERE expires_at <= ?
          ORDER BY expires_at, rowid
          LIMIT ?
        )
      `)
      .run(authoritativeNow, input.batchSize);
    const browserResult = database
      .prepare(`
        DELETE FROM operator_browser_flows
        WHERE rowid IN (
          SELECT rowid
          FROM operator_browser_flows
          WHERE expires_at <= ?
          ORDER BY expires_at, rowid
          LIMIT ?
        )
      `)
      .run(authoritativeNow, input.batchSize);
    const remainingLogin = database
      .prepare("SELECT 1 AS present FROM operator_login_transactions WHERE expires_at <= ? LIMIT 1")
      .get(authoritativeNow);
    const remainingSession = database
      .prepare("SELECT 1 AS present FROM operator_sessions WHERE expires_at <= ? LIMIT 1")
      .get(authoritativeNow);
    const remainingBrowser = database
      .prepare("SELECT 1 AS present FROM operator_browser_flows WHERE expires_at <= ? LIMIT 1")
      .get(authoritativeNow);
    database.exec("COMMIT");
    return {
      deletedBrowserFlows: Number(browserResult.changes),
      deletedLoginTransactions: Number(loginResult.changes),
      deletedSessions: Number(sessionResult.changes),
      hasMore:
        remainingLogin !== undefined ||
        remainingSession !== undefined ||
        remainingBrowser !== undefined,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};
