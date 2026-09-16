import { createHash, timingSafeEqual } from "node:crypto";
import {
  EntityIdSchema,
  type InvestigationAccount,
  InvestigationAccountListSchema,
  InvestigationAccountSchema,
  type InvestigationChangePasswordRequest,
  InvestigationChangePasswordRequestSchema,
  type InvestigationCreateAccountRequest,
  InvestigationCreateAccountRequestSchema,
  type InvestigationLoginRequest,
  InvestigationLoginRequestSchema,
  type InvestigationResetAccountPasswordRequest,
  InvestigationResetAccountPasswordRequestSchema,
  type InvestigationSession,
  InvestigationSessionSchema,
  type InvestigationUpdateAccountRequest,
  InvestigationUpdateAccountRequestSchema,
  normalizeInvestigationUsername,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InvestigationPasswordStore, InvestigationPasswordStoreError } from "./password-store.js";
import type { InvestigationRuntimeConfig } from "./runtime-config.js";
import type { InvestigationOperatorPrincipal, InvestigationWorkerPrincipal } from "./types.js";

type AccountSession = { account: InvestigationAccount; expiresAt: string };
const accountParams = Type.Object({ id: EntityIdSchema }, { additionalProperties: false });
const signedOut: InvestigationSession = {
  authenticated: false,
  authMode: "password",
  loginPath: "/api/auth/login",
  user: null,
};
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const matches = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]?.slice(name.length + 1);
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
}

function sessionResponse(session: AccountSession | null): InvestigationSession {
  if (session === null) return signedOut;
  const account = session.account;
  return {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: session.expiresAt,
    user: {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      isAdmin: account.isAdmin,
      repositoryIds: [...account.repositoryIds],
      permissions: [...account.permissions],
      actionCapabilities: [...account.actionCapabilities],
      allowRepositoryExecution: account.allowRepositoryExecution,
      email: null,
    },
  };
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

/** Rejects new keys when full, rather than evicting a throttled account and resetting its budget. */
class LoginRateLimiter {
  readonly #entries = new Map<string, { count: number; expiresAt: number }>();
  constructor(
    private readonly maximumAttempts: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  take(key: string): boolean {
    const now = this.now();
    for (const [entryKey, entry] of this.#entries)
      if (entry.expiresAt <= now) this.#entries.delete(entryKey);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      if (this.#entries.size >= 10_000) return false;
      entry = { count: 0, expiresAt: now + this.windowMs };
      this.#entries.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.maximumAttempts;
  }
}

export class InvestigationRuntimeAuth {
  readonly #store: InvestigationPasswordStore;
  readonly #config: InvestigationRuntimeConfig;
  readonly #publicOrigin: URL;
  readonly #secureCookies: boolean;
  readonly #sessionCookie: string;
  readonly #ipLimits: LoginRateLimiter;
  readonly #accountLimits: LoginRateLimiter;
  readonly #workers: readonly { digest: Buffer; principal: InvestigationWorkerPrincipal }[];
  #initialization: Promise<void> | undefined;

  constructor(config: InvestigationRuntimeConfig, dependencies: { now?: () => number } = {}) {
    this.#config = config;
    this.#publicOrigin = new URL(config.auth.publicOrigin);
    this.#secureCookies = this.#publicOrigin.protocol === "https:";
    this.#sessionCookie = this.#secureCookies
      ? "__Host-investigation_session"
      : "investigation_session";
    this.#store = new InvestigationPasswordStore(config.authDatabasePath, {
      sessionTtlMs: config.auth.sessionTtlSeconds * 1000,
      maxKdfConcurrency: config.auth.maxKdfConcurrency,
      maxKdfQueue: config.auth.maxKdfQueue,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    const now = dependencies.now ?? Date.now;
    this.#ipLimits = new LoginRateLimiter(
      config.auth.loginIpLimit,
      config.auth.loginWindowSeconds * 1000,
      now,
    );
    this.#accountLimits = new LoginRateLimiter(
      config.auth.loginAccountLimit,
      config.auth.loginWindowSeconds * 1000,
      now,
    );
    this.#workers = config.workers.map((worker) => ({
      digest: createHash("sha256").update(worker.token).digest(),
      principal: { id: worker.id, repositoryIds: [...worker.repositoryIds] },
    }));
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#store
      .initializeBootstrap(this.#config.auth.bootstrapAdmin)
      .then(() => undefined);
    return this.#initialization;
  }

  readonly authenticateOperator = (
    request: FastifyRequest,
  ): InvestigationOperatorPrincipal | null => {
    if (
      !this.#allowedRequest(request) ||
      (!safeMethods.has(request.method) && !this.#sameOrigin(request))
    )
      return null;
    const session = this.#readSession(request);
    if (session === null) return null;
    const account = session.account;
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      isAdmin: account.isAdmin,
      repositoryIds: [...account.repositoryIds],
      permissions: [...account.permissions],
      actionCapabilities: [...account.actionCapabilities],
      allowRepositoryExecution: account.allowRepositoryExecution,
    };
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
      await this.initialize();
      scope.addHook("onRoute", (route) => {
        route.logLevel = "silent";
      });
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
        if (!this.#allowedRequest(request))
          return reply.code(403).send({
            code: "auth_request_denied",
            message: "The request host or network origin is not allowed.",
          });
        if (!safeMethods.has(request.method) && !this.#sameOrigin(request))
          return reply.code(403).send({
            code: "invalid_origin",
            message: "A same-origin browser request is required.",
          });
      });
      scope.setErrorHandler((error, _request, reply) => {
        if (error instanceof InvestigationPasswordStoreError) {
          if (error.statusCode === 401)
            return reply.code(401).send({
              code: "authentication_failed",
              message: "The credentials could not be verified.",
            });
          if (error.statusCode === 429) return this.#limited(reply);
          return reply.code(error.statusCode).send({ code: error.code, message: error.message });
        }
        if (
          error instanceof Error &&
          "statusCode" in error &&
          typeof error.statusCode === "number" &&
          error.statusCode >= 400 &&
          error.statusCode < 500
        ) {
          return reply.code(error.statusCode).send({
            code: "invalid_authentication_request",
            message: "The request does not match the account contract.",
          });
        }
        app.log.error(
          { code: "account_service_failed" },
          "The account service could not complete a request.",
        );
        return reply.code(500).send({
          code: "authentication_unavailable",
          message: "The account service is temporarily unavailable.",
        });
      });
      scope.get(
        "/api/auth/session",
        { schema: { response: { 200: InvestigationSessionSchema } } },
        async (request) => sessionResponse(this.#readSession(request)),
      );
      scope.post<{ Body: InvestigationLoginRequest }>(
        "/api/auth/login",
        {
          onRequest: async (request, reply) => {
            if (!this.#ipLimits.take(createHash("sha256").update(request.ip).digest("hex")))
              return this.#limited(reply);
          },
          schema: {
            body: InvestigationLoginRequestSchema,
            response: { 200: InvestigationSessionSchema },
          },
        },
        async (request, reply) => {
          const accountKey = createHash("sha256")
            .update(normalizeInvestigationUsername(request.body.username))
            .digest("hex");
          if (!this.#accountLimits.take(accountKey)) return this.#limited(reply);
          const authenticated = await this.#store.authenticate(
            request.body.username,
            request.body.password,
          );
          if (authenticated === null)
            return reply.code(401).send({
              code: "authentication_failed",
              message: "The credentials could not be verified.",
            });
          const previous = cookieValue(request, this.#sessionCookie);
          if (previous !== undefined) this.#store.logout(previous);
          this.#setSessionCookie(reply, authenticated.token, authenticated.expiresAt);
          return sessionResponse(authenticated);
        },
      );
      scope.post("/api/auth/logout", async (request, reply) => {
        const token = cookieValue(request, this.#sessionCookie);
        if (token !== undefined) this.#store.logout(token);
        this.#clearSessionCookie(reply);
        return reply.code(204).send();
      });
      scope.post<{ Body: InvestigationChangePasswordRequest }>(
        "/api/auth/password",
        { schema: { body: InvestigationChangePasswordRequestSchema } },
        async (request, reply) => {
          const session = this.#requiredSession(request);
          if (!this.#passwordOperationAllowed(request, session.account.username))
            return this.#limited(reply);
          await this.#store.changeOwnPassword(
            this.#actor(session.account),
            request.body.currentPassword,
            request.body.newPassword,
          );
          this.#clearSessionCookie(reply);
          return reply.code(204).send();
        },
      );
      scope.get(
        "/api/accounts",
        { schema: { response: { 200: InvestigationAccountListSchema } } },
        async (request) => {
          const session = this.#requiredAdminSession(request);
          return { items: this.#store.listAccountsForAdmin(this.#actor(session.account)) };
        },
      );
      scope.post<{ Body: InvestigationCreateAccountRequest }>(
        "/api/accounts",
        {
          schema: {
            body: InvestigationCreateAccountRequestSchema,
            response: { 201: InvestigationAccountSchema },
          },
        },
        async (request, reply) => {
          const session = this.#requiredAdminSession(request);
          if (
            !this.#passwordOperationAllowed(
              request,
              session.account.username,
              normalizeInvestigationUsername(request.body.username),
            )
          )
            return this.#limited(reply);
          const account = await this.#store.createAccount(
            this.#actor(session.account),
            request.body,
          );
          return reply.code(201).send(account);
        },
      );
      scope.post<{ Params: { id: string }; Body: InvestigationUpdateAccountRequest }>(
        "/api/accounts/:id/update",
        {
          schema: {
            params: accountParams,
            body: InvestigationUpdateAccountRequestSchema,
            response: { 200: InvestigationAccountSchema },
          },
        },
        async (request) => {
          const session = this.#requiredAdminSession(request);
          const { version, ...updates } = request.body;
          return this.#store.updateAccount(
            this.#actor(session.account),
            request.params.id,
            version,
            updates,
          );
        },
      );
      scope.post<{ Params: { id: string }; Body: InvestigationResetAccountPasswordRequest }>(
        "/api/accounts/:id/password",
        {
          schema: {
            params: accountParams,
            body: InvestigationResetAccountPasswordRequestSchema,
            response: { 200: InvestigationAccountSchema },
          },
        },
        async (request, reply) => {
          const session = this.#requiredAdminSession(request);
          const target = this.#store.getAccount(request.params.id);
          if (
            !this.#passwordOperationAllowed(
              request,
              session.account.username,
              target?.username ?? `target:${request.params.id}`,
            )
          )
            return this.#limited(reply);
          return await this.#store.adminResetPassword(
            this.#actor(session.account),
            request.params.id,
            request.body.version,
            request.body.newPassword,
          );
        },
      );
    });
  }

  reapExpired(): void {
    this.#store.reapExpired();
  }
  close(): void {
    this.#store.close();
  }

  #actor(account: InvestigationAccount): { id: string; version: number } {
    return { id: account.id, version: account.version };
  }

  #allowedRequest(request: FastifyRequest): boolean {
    if (request.headers.host?.toLowerCase() !== this.#publicOrigin.host.toLowerCase()) return false;
    if (this.#secureCookies) return true;
    return (
      isLoopbackAddress(request.ip) &&
      !["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some(
        (name) => request.headers[name] !== undefined,
      )
    );
  }

  #sameOrigin(request: FastifyRequest): boolean {
    return (
      request.headers.origin === this.#publicOrigin.origin &&
      request.headers["sec-fetch-site"] !== "cross-site"
    );
  }

  #readSession(request: FastifyRequest): AccountSession | null {
    const token = cookieValue(request, this.#sessionCookie);
    return token === undefined ? null : this.#store.getSession(token);
  }

  #requiredSession(request: FastifyRequest): AccountSession {
    const session = this.#readSession(request);
    if (session === null)
      throw new InvestigationPasswordStoreError("unauthorized", "Authentication is required.");
    return session;
  }

  #requiredAdminSession(request: FastifyRequest): AccountSession {
    const session = this.#requiredSession(request);
    if (!session.account.isAdmin)
      throw new InvestigationPasswordStoreError(
        "forbidden",
        "Account administration requires an enabled administrator.",
      );
    return session;
  }

  #limited(reply: FastifyReply): FastifyReply {
    return reply.header("retry-after", this.#config.auth.loginWindowSeconds).code(429).send({
      code: "authentication_throttled",
      message: "Too many authentication attempts; try again later.",
    });
  }

  #passwordOperationAllowed(
    request: FastifyRequest,
    actorUsername: string,
    targetUsername = actorUsername,
  ): boolean {
    if (!this.#ipLimits.take(createHash("sha256").update(request.ip).digest("hex"))) return false;
    if (!this.#accountLimits.take(createHash("sha256").update(actorUsername).digest("hex")))
      return false;
    return (
      targetUsername === actorUsername ||
      this.#accountLimits.take(createHash("sha256").update(targetUsername).digest("hex"))
    );
  }

  #setSessionCookie(reply: FastifyReply, token: string, expiresAt: string): void {
    // Fastify appends Set-Cookie values; never repeat existing headers here.
    reply.header(
      "set-cookie",
      `${this.#sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${this.#secureCookies ? "; Secure" : ""}`,
    );
  }

  #clearSessionCookie(reply: FastifyReply): void {
    this.#setSessionCookie(reply, "", "1970-01-01T00:00:00.000Z");
  }
}
