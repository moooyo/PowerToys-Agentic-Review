import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  beginOperatorLogin,
  claimOperatorLoginTransaction,
  cleanupExpiredOperatorAuth,
  createOperatorSession,
  deleteOperatorBrowserFlow,
  deleteOperatorSession,
  finalizeOperatorLogin,
  findOperatorSession,
} from "../database/operator-auth.js";
import {
  OperatorAuthError,
  type OperatorAuthPersistence,
  OperatorAuthService,
  type OperatorOidcClient,
  type OperatorSession,
} from "../security/operator-auth.js";
import type { InvestigationRuntimeConfig } from "./runtime-config.js";
import type { InvestigationOperatorPrincipal, InvestigationWorkerPrincipal } from "./types.js";

const authSchema = `
  CREATE TABLE investigation_auth_metadata (version TEXT PRIMARY KEY NOT NULL) STRICT;
  INSERT INTO investigation_auth_metadata VALUES ('investigation-auth-v1');
  CREATE TABLE operator_browser_flows (
    browser_sha256 TEXT PRIMARY KEY NOT NULL CHECK(length(browser_sha256) = 64),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE operator_login_transactions (
    token_sha256 TEXT PRIMARY KEY NOT NULL CHECK(length(token_sha256) = 64),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, claimed_at TEXT,
    browser_sha256 TEXT NOT NULL REFERENCES operator_browser_flows(browser_sha256) ON DELETE CASCADE,
    browser_generation INTEGER NOT NULL CHECK(browser_generation BETWEEN 1 AND 9007199254740991)
  ) STRICT;
  CREATE TABLE operator_sessions (
    token_sha256 TEXT PRIMARY KEY NOT NULL CHECK(length(token_sha256) = 64),
    issuer TEXT NOT NULL, subject TEXT NOT NULL, display_name TEXT, email TEXT,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    browser_sha256 TEXT REFERENCES operator_browser_flows(browser_sha256) ON DELETE CASCADE,
    browser_generation INTEGER CHECK(browser_generation BETWEEN 1 AND 9007199254740991),
    CHECK((browser_sha256 IS NULL) = (browser_generation IS NULL))
  ) STRICT;
  CREATE TABLE operator_auth_clock (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), last_observed_at TEXT NOT NULL
  ) STRICT;
  INSERT INTO operator_auth_clock VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  CREATE INDEX investigation_auth_browser_expiry ON operator_browser_flows(expires_at);
  CREATE INDEX investigation_auth_login_expiry ON operator_login_transactions(expires_at);
  CREATE INDEX investigation_auth_session_expiry ON operator_sessions(expires_at);
  CREATE INDEX investigation_auth_login_browser ON operator_login_transactions(browser_sha256);
  CREATE INDEX investigation_auth_session_browser ON operator_sessions(browser_sha256);
`;

export class InvestigationAuthPersistence implements OperatorAuthPersistence {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    try {
      this.#database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const tables = this.#database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        if (tables.length === 0) {
          this.#database.exec(authSchema);
        } else {
          const expectedTables = new Set([
            "investigation_auth_metadata",
            "operator_browser_flows",
            "operator_login_transactions",
            "operator_sessions",
            "operator_auth_clock",
          ]);
          if (
            tables.length !== expectedTables.size ||
            tables.some((table) => !expectedTables.has(String(table.name)))
          ) {
            throw new Error(
              "The authentication database uses an incompatible schema; configure a new empty authentication database.",
            );
          }
          const versions = this.#database
            .prepare("SELECT version FROM investigation_auth_metadata")
            .all();
          if (versions.length !== 1 || versions[0]?.version !== "investigation-auth-v1") {
            throw new Error("The authentication database schema identity is incompatible.");
          }
        }
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
      this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  async beginLogin(input: Parameters<OperatorAuthPersistence["beginLogin"]>[0]) {
    return beginOperatorLogin(this.#database, input);
  }

  async claimLoginTransaction(
    input: Parameters<OperatorAuthPersistence["claimLoginTransaction"]>[0],
  ) {
    return claimOperatorLoginTransaction(this.#database, input).browserGeneration;
  }

  async finalizeLogin(input: Parameters<OperatorAuthPersistence["finalizeLogin"]>[0]) {
    return finalizeOperatorLogin(this.#database, input).finalized;
  }

  async createSession(input: Parameters<OperatorAuthPersistence["createSession"]>[0]) {
    createOperatorSession(this.#database, input);
  }

  async findSession(input: Parameters<OperatorAuthPersistence["findSession"]>[0]) {
    return findOperatorSession(this.#database, input).session;
  }

  async deleteSession(input: Parameters<OperatorAuthPersistence["deleteSession"]>[0]) {
    deleteOperatorSession(this.#database, input);
  }

  async deleteBrowserFlow(input: Parameters<OperatorAuthPersistence["deleteBrowserFlow"]>[0]) {
    deleteOperatorBrowserFlow(this.#database, input);
  }

  reapExpired(): void {
    cleanupExpiredOperatorAuth(this.#database, { batchSize: 500 });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const matches = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]?.slice(name.length + 1);
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
}

function cookie(
  reply: FastifyReply,
  name: string,
  value: string,
  expiresAt: string,
  secure: boolean,
): void {
  // Fastify appends Set-Cookie values itself; repeating existing headers creates duplicate tokens.
  reply.header(
    "set-cookie",
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure ? "; Secure" : ""}`,
  );
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
}

export class InvestigationRuntimeAuth {
  readonly #config: InvestigationRuntimeConfig;
  readonly #service: OperatorAuthService;
  readonly #persistence: InvestigationAuthPersistence;
  readonly #sessionCookie: string;
  readonly #browserCookie: string;
  readonly #transactionCookie: string;
  readonly #workers: readonly { digest: Buffer; principal: InvestigationWorkerPrincipal }[];

  constructor(config: InvestigationRuntimeConfig, oidc?: OperatorOidcClient) {
    this.#config = config;
    this.#persistence = new InvestigationAuthPersistence(config.authDatabasePath);
    try {
      this.#service = new OperatorAuthService({
        config: config.auth,
        persistence: this.#persistence,
        ...(oidc === undefined ? {} : { oidc }),
      });
    } catch (error) {
      this.#persistence.close();
      throw error;
    }
    const prefix = this.#service.secureCookies ? "__Host-investigation_" : "investigation_dev_";
    this.#sessionCookie = `${prefix}session`;
    this.#browserCookie = `${prefix}browser`;
    this.#transactionCookie = `${prefix}login`;
    this.#workers = config.workers.map((worker) => ({
      digest: createHash("sha256").update(worker.token).digest(),
      principal: { id: worker.id, repositoryIds: [...worker.repositoryIds] },
    }));
  }

  readonly authenticateOperator = async (
    request: FastifyRequest,
  ): Promise<InvestigationOperatorPrincipal | null> => {
    if (
      !this.#allowedRequest(request) ||
      (!new Set(["GET", "HEAD", "OPTIONS"]).has(request.method) && !this.#sameOrigin(request))
    )
      return null;
    const session = await this.#readSession(request);
    return session === null ? null : this.#principal(session);
  };

  readonly authenticateWorker = (request: FastifyRequest): InvestigationWorkerPrincipal | null => {
    const authorization = request.headers.authorization;
    if (authorization === undefined || !/^Bearer [A-Za-z0-9_-]{43,256}$/u.test(authorization))
      return null;
    const digest = createHash("sha256").update(authorization.slice(7)).digest();
    let principal: InvestigationWorkerPrincipal | null = null;
    for (const credential of this.#workers) {
      if (timingSafeEqual(digest, credential.digest)) principal = credential.principal;
    }
    return principal;
  };

  registerRoutes(app: FastifyInstance): void {
    app.register(async (scope) => {
      await scope.register(rateLimit, { global: false });
      scope.addHook("onRequest", async (request, reply) => {
        noStore(reply);
        if (!this.#allowedRequest(request))
          return reply.code(403).send({
            code: "auth_request_denied",
            message: "The operator request host or network origin is not allowed.",
          });
        if (request.method === "POST" && !this.#sameOrigin(request))
          return reply.code(403).send({
            code: "invalid_origin",
            message: "A same-origin browser request is required.",
          });
      });
      scope.setErrorHandler((error, _request, reply) => {
        if (error instanceof OperatorAuthError)
          return reply.code(error.statusCode).send({ code: error.code, message: error.message });
        if (error instanceof Error && "statusCode" in error && error.statusCode === 429)
          return reply
            .code(429)
            .send({ code: "auth_rate_limited", message: "Too many authentication requests." });
        if (
          error instanceof Error &&
          "statusCode" in error &&
          typeof error.statusCode === "number" &&
          error.statusCode >= 400 &&
          error.statusCode < 500
        ) {
          return reply.code(error.statusCode).send({
            code: "invalid_authentication_request",
            message: "The authentication request is invalid.",
          });
        }
        app.log.error(
          { errorName: error instanceof Error ? error.name : "UnknownError" },
          "Operator authentication failed.",
        );
        return reply.code(500).send({
          code: "authentication_unavailable",
          message: "Operator authentication is temporarily unavailable.",
        });
      });
      scope.get("/api/auth/session", async (request) =>
        this.#sessionResponse(await this.#readSession(request)),
      );
      scope.post(
        "/api/auth/login",
        { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const browserToken = cookieValue(request, this.#browserCookie);
          const binding = this.#service.ensureBrowserBinding(browserToken);
          const start = await this.#service.startLogin(binding?.token ?? browserToken);
          if (start.kind === "authorization_redirect") {
            this.#setCookie(
              reply,
              this.#transactionCookie,
              start.transactionToken,
              start.transactionExpiresAt,
            );
            this.#setCookie(
              reply,
              this.#browserCookie,
              start.browserBindingToken,
              start.browserBindingExpiresAt,
            );
            return { authenticated: false, authorizationUrl: start.authorizationUrl.href };
          }
          const previous = cookieValue(request, this.#sessionCookie);
          if (previous !== undefined) await this.#service.logout(previous);
          this.#setCookie(reply, this.#sessionCookie, start.sessionToken, start.session.expiresAt);
          return this.#sessionResponse(start.session);
        },
      );
      scope.get("/api/auth/callback", { logLevel: "silent" }, async (request, reply) => {
        const browserToken = cookieValue(request, this.#browserCookie);
        const completed = await this.#service.completeLogin(
          new URL(request.raw.url ?? "/api/auth/callback", this.#service.publicOrigin).searchParams,
          cookieValue(request, this.#transactionCookie),
          browserToken,
        );
        this.#setCookie(
          reply,
          this.#sessionCookie,
          completed.sessionToken,
          completed.session.expiresAt,
        );
        this.#setCookie(reply, this.#transactionCookie, "", "1970-01-01T00:00:00.000Z");
        if (browserToken !== undefined && completed.browserBindingExpiresAt !== undefined)
          this.#setCookie(
            reply,
            this.#browserCookie,
            browserToken,
            completed.browserBindingExpiresAt,
          );
        return reply.redirect(this.#service.postLoginRedirectPath, 303);
      });
      scope.post("/api/auth/logout", async (request, reply) => {
        await this.#service.logout(
          cookieValue(request, this.#sessionCookie),
          cookieValue(request, this.#browserCookie),
        );
        for (const name of [this.#sessionCookie, this.#transactionCookie, this.#browserCookie])
          this.#setCookie(reply, name, "", "1970-01-01T00:00:00.000Z");
        return reply.code(204).send();
      });
    });
  }

  reapExpired(): void {
    this.#persistence.reapExpired();
  }
  close(): void {
    this.#persistence.close();
  }

  #allowedRequest(request: FastifyRequest): boolean {
    if (
      request.headers.host?.toLowerCase() !== new URL(this.#service.publicOrigin).host.toLowerCase()
    )
      return false;
    if (!this.#service.requiresLoopbackRequest) return true;
    return (
      isLoopbackAddress(request.ip) &&
      !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some(
        (name) => request.headers[name] !== undefined,
      )
    );
  }

  #sameOrigin(request: FastifyRequest): boolean {
    return (
      request.headers.origin === this.#service.publicOrigin &&
      request.headers["sec-fetch-site"] !== "cross-site"
    );
  }

  async #readSession(request: FastifyRequest): Promise<OperatorSession | null> {
    return this.#service.getSession(
      cookieValue(request, this.#sessionCookie),
      cookieValue(request, this.#browserCookie),
    );
  }

  #principal(session: OperatorSession): InvestigationOperatorPrincipal | null {
    const binding = this.#config.operators.find(
      (operator) => operator.issuer === session.issuer && operator.subject === session.subject,
    );
    if (binding === undefined) return null;
    return {
      id: binding.id,
      displayName: session.displayName ?? binding.displayName,
      repositoryIds: [...binding.repositoryIds],
      permissions: [...binding.permissions],
      actionCapabilities: [...binding.actionCapabilities],
      allowRepositoryExecution: binding.allowRepositoryExecution,
    };
  }

  #sessionResponse(session: OperatorSession | null) {
    const principal = session === null ? null : this.#principal(session);
    return {
      authenticated: principal !== null,
      authMode: this.#config.auth.mode,
      loginPath: "/api/auth/login",
      user: principal === null ? null : { ...principal, email: session?.email ?? null },
      ...(principal === null || session === null ? {} : { expiresAt: session.expiresAt }),
    };
  }

  #setCookie(reply: FastifyReply, name: string, value: string, expiresAt: string): void {
    cookie(reply, name, value, expiresAt, this.#service.secureCookies);
  }
}
