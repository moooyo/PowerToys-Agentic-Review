import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type CompletedOperatorLogin,
  OperatorAuthError,
  type OperatorBrowserBinding,
  type OperatorLoginStart,
  type OperatorSession,
} from "../security/operator-auth.js";

export const OPERATOR_SESSION_COOKIE = "__Host-agentic_review_session";
export const OPERATOR_LOGIN_TRANSACTION_COOKIE = "__Host-agentic_review_login";
export const OPERATOR_BROWSER_BINDING_COOKIE = "__Host-agentic_review_browser";
export const DEVELOPMENT_OPERATOR_SESSION_COOKIE = "agentic_review_dev_session";
export const DEVELOPMENT_OPERATOR_LOGIN_TRANSACTION_COOKIE = "agentic_review_dev_login";
export const DEVELOPMENT_OPERATOR_BROWSER_BINDING_COOKIE = "agentic_review_dev_browser";
export const OPERATOR_SESSION_PATH = "/api/v1/auth/session";
export const OPERATOR_LOGIN_PATH = "/api/v1/auth/login";
export const OPERATOR_CALLBACK_PATH = "/api/v1/auth/callback";
export const OPERATOR_LOGOUT_PATH = "/api/v1/auth/logout";

export interface OperatorAuthRouteService {
  readonly publicOrigin: string;
  readonly postLoginRedirectPath: string;
  readonly requiresLoopbackRequest: boolean;
  readonly secureCookies: boolean;
  readonly usesBrowserBinding: boolean;
  ensureBrowserBinding(browserBindingToken?: string): OperatorBrowserBinding | undefined;
  startLogin(browserBindingToken?: string): Promise<OperatorLoginStart>;
  completeLogin(
    callbackParameters: URLSearchParams,
    transactionToken: string | undefined,
    browserBindingToken: string | undefined,
  ): Promise<CompletedOperatorLogin>;
  getSession(
    sessionToken: string | undefined,
    browserBindingToken?: string,
  ): Promise<OperatorSession | null>;
  logout(sessionToken: string | undefined, browserBindingToken?: string): Promise<void>;
}

const baseCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  priority: "high" as const,
};

interface OperatorCookiePolicy {
  readonly sessionCookie: string;
  readonly loginTransactionCookie: string;
  readonly browserBindingCookie: string | undefined;
  readonly secure: boolean;
}

const cookiePolicyFor = (auth: OperatorAuthRouteService): OperatorCookiePolicy =>
  auth.secureCookies
    ? {
        sessionCookie: OPERATOR_SESSION_COOKIE,
        loginTransactionCookie: OPERATOR_LOGIN_TRANSACTION_COOKIE,
        browserBindingCookie: auth.usesBrowserBinding ? OPERATOR_BROWSER_BINDING_COOKIE : undefined,
        secure: true,
      }
    : {
        sessionCookie: DEVELOPMENT_OPERATOR_SESSION_COOKIE,
        loginTransactionCookie: DEVELOPMENT_OPERATOR_LOGIN_TRANSACTION_COOKIE,
        browserBindingCookie: auth.usesBrowserBinding
          ? DEVELOPMENT_OPERATOR_BROWSER_BINDING_COOKIE
          : undefined,
        secure: false,
      };

const noStore = (reply: FastifyReply): FastifyReply =>
  reply
    .header("cache-control", "no-store")
    .header("pragma", "no-cache")
    .header("referrer-policy", "no-referrer");

const isLoopbackAddress = (address: string): boolean => {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.")
  );
};

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
};

const validateRouteSecurityPolicy = (auth: OperatorAuthRouteService): void => {
  let publicOrigin: URL;
  try {
    publicOrigin = new URL(auth.publicOrigin);
  } catch {
    throw new Error("Operator authentication routes require a valid public origin.");
  }
  if (publicOrigin.origin !== auth.publicOrigin) {
    throw new Error("Operator authentication routes require a canonical public origin.");
  }
  if (auth.secureCookies && publicOrigin.protocol !== "https:") {
    throw new Error("Secure operator cookies require an HTTPS public origin.");
  }
  if (
    !auth.secureCookies &&
    (publicOrigin.protocol !== "http:" ||
      !isLoopbackHostname(publicOrigin.hostname) ||
      !auth.requiresLoopbackRequest)
  ) {
    throw new Error(
      "Non-Secure operator cookies are restricted to loopback HTTP development requests.",
    );
  }
};

const isAllowedRequest = (request: FastifyRequest, auth: OperatorAuthRouteService): boolean => {
  if (!auth.requiresLoopbackRequest) {
    return true;
  }
  const expectedHost = new URL(auth.publicOrigin).host.toLowerCase();
  const actualHost = request.headers.host?.toLowerCase();
  const hasForwardingHeaders = [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ].some((name) => request.headers[name] !== undefined);
  return isLoopbackAddress(request.ip) && actualHost === expectedHost && !hasForwardingHeaders;
};

const sendLoopbackDenied = (reply: FastifyReply): FastifyReply =>
  noStore(reply).code(403).send({
    code: "loopback_operator_auth_denied",
    message: "Loopback operator authentication is restricted to loopback requests.",
    retryable: false,
  });

const sendAuthError = (reply: FastifyReply, error: OperatorAuthError): FastifyReply =>
  noStore(reply).code(error.statusCode).send({
    code: error.code,
    message: error.message,
    retryable: false,
  });

const sendInvalidOrigin = (reply: FastifyReply): FastifyReply =>
  noStore(reply).code(403).send({
    code: "invalid_operator_auth_origin",
    message: "The request origin is not authorized for this operator authentication action.",
    retryable: false,
  });

const setSessionCookie = (
  reply: FastifyReply,
  auth: OperatorAuthRouteService,
  sessionToken: string,
  expiresAt: string,
): void => {
  const policy = cookiePolicyFor(auth);
  reply.setCookie(policy.sessionCookie, sessionToken, {
    ...baseCookieOptions,
    secure: policy.secure,
    expires: new Date(expiresAt),
  });
};

const setLoginTransactionCookie = (
  reply: FastifyReply,
  auth: OperatorAuthRouteService,
  transactionToken: string,
  expiresAt: string,
): void => {
  const policy = cookiePolicyFor(auth);
  reply.setCookie(policy.loginTransactionCookie, transactionToken, {
    ...baseCookieOptions,
    secure: policy.secure,
    expires: new Date(expiresAt),
  });
};

const setBrowserBindingCookie = (
  reply: FastifyReply,
  auth: OperatorAuthRouteService,
  browserBindingToken: string,
  expiresAt: string,
): void => {
  const policy = cookiePolicyFor(auth);
  if (policy.browserBindingCookie === undefined) {
    return;
  }
  reply.setCookie(policy.browserBindingCookie, browserBindingToken, {
    ...baseCookieOptions,
    secure: policy.secure,
    expires: new Date(expiresAt),
  });
};

const clearSessionCookie = (reply: FastifyReply, auth: OperatorAuthRouteService): void => {
  const policy = cookiePolicyFor(auth);
  reply.clearCookie(policy.sessionCookie, { ...baseCookieOptions, secure: policy.secure });
};

const clearLoginTransactionCookie = (reply: FastifyReply, auth: OperatorAuthRouteService): void => {
  const policy = cookiePolicyFor(auth);
  reply.clearCookie(policy.loginTransactionCookie, {
    ...baseCookieOptions,
    secure: policy.secure,
  });
};

const clearBrowserBindingCookie = (reply: FastifyReply, auth: OperatorAuthRouteService): void => {
  const policy = cookiePolicyFor(auth);
  if (policy.browserBindingCookie !== undefined) {
    reply.clearCookie(policy.browserBindingCookie, {
      ...baseCookieOptions,
      secure: policy.secure,
    });
  }
};

const browserBindingTokenFrom = (
  request: FastifyRequest,
  auth: OperatorAuthRouteService,
): string | undefined => {
  const cookieName = cookiePolicyFor(auth).browserBindingCookie;
  return cookieName === undefined ? undefined : request.cookies[cookieName];
};

const callbackParametersFrom = (request: FastifyRequest): URLSearchParams => {
  const requestUrl = new URL(request.raw.url ?? OPERATOR_CALLBACK_PATH, "https://callback.invalid");
  return requestUrl.searchParams;
};

const requestSessions = new WeakMap<
  FastifyRequest,
  WeakMap<OperatorAuthRouteService, Promise<OperatorSession | null>>
>();

export const readOperatorSession = async (
  request: FastifyRequest,
  auth: OperatorAuthRouteService,
): Promise<OperatorSession | null> => {
  if (!isAllowedRequest(request, auth)) {
    return null;
  }
  let services = requestSessions.get(request);
  if (services === undefined) {
    services = new WeakMap();
    requestSessions.set(request, services);
  }
  let session = services.get(auth);
  if (session === undefined) {
    // Reuse authentication only within this request. The next request must observe expiry,
    // revocation, and current identity-provider policy through the production service again.
    session = auth.getSession(
      request.cookies[cookiePolicyFor(auth).sessionCookie],
      browserBindingTokenFrom(request, auth),
    );
    services.set(auth, session);
  }
  return session;
};

export const registerOperatorAuthRoutes = (
  app: FastifyInstance,
  auth: OperatorAuthRouteService,
): void => {
  validateRouteSecurityPolicy(auth);
  app.register(cookie, { hook: "onRequest" });
  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => done(null, body),
    );
    await scope.register(rateLimit, { global: false });

    scope.get(OPERATOR_SESSION_PATH, async (request, reply) => {
      if (!isAllowedRequest(request, auth)) {
        return sendLoopbackDenied(reply);
      }
      noStore(reply);
      const sessionToken = request.cookies[cookiePolicyFor(auth).sessionCookie];
      const session = await auth.getSession(sessionToken, browserBindingTokenFrom(request, auth));
      if (session === null) {
        return { authenticated: false };
      }
      return {
        authenticated: true,
        operator: {
          issuer: session.issuer,
          subject: session.subject,
          displayName: session.displayName,
          email: session.email,
        },
        expiresAt: session.expiresAt,
      };
    });

    scope.post(
      OPERATOR_LOGIN_PATH,
      {
        config: {
          rateLimit: {
            max: 10,
            timeWindow: "1 minute",
          },
        },
      },
      async (request, reply) => {
        if (!isAllowedRequest(request, auth)) {
          return sendLoopbackDenied(reply);
        }
        noStore(reply);
        if (request.headers.origin !== auth.publicOrigin) {
          return sendInvalidOrigin(reply);
        }
        const browserBindingToken = browserBindingTokenFrom(request, auth);
        const issuedBrowserBinding = auth.usesBrowserBinding
          ? auth.ensureBrowserBinding(browserBindingToken)
          : undefined;
        const start = await auth.startLogin(issuedBrowserBinding?.token ?? browserBindingToken);
        if (start.kind === "authorization_redirect") {
          setLoginTransactionCookie(
            reply,
            auth,
            start.transactionToken,
            start.transactionExpiresAt,
          );
          setBrowserBindingCookie(
            reply,
            auth,
            start.browserBindingToken,
            start.browserBindingExpiresAt,
          );
          return reply.redirect(start.authorizationUrl.href, 302);
        }

        setSessionCookie(reply, auth, start.sessionToken, start.session.expiresAt);
        return reply.redirect(auth.postLoginRedirectPath, 303);
      },
    );

    scope.get(OPERATOR_CALLBACK_PATH, { logLevel: "silent" }, async (request, reply) => {
      if (!isAllowedRequest(request, auth)) {
        return sendLoopbackDenied(reply);
      }
      noStore(reply);
      const transactionToken = request.cookies[cookiePolicyFor(auth).loginTransactionCookie];
      const browserBindingToken = browserBindingTokenFrom(request, auth);
      try {
        const completed = await auth.completeLogin(
          callbackParametersFrom(request),
          transactionToken,
          browserBindingToken,
        );
        setSessionCookie(reply, auth, completed.sessionToken, completed.session.expiresAt);
        if (completed.browserBindingExpiresAt !== undefined && browserBindingToken !== undefined) {
          setBrowserBindingCookie(
            reply,
            auth,
            browserBindingToken,
            completed.browserBindingExpiresAt,
          );
        }
        return reply.redirect(auth.postLoginRedirectPath, 303);
      } catch (error) {
        if (error instanceof OperatorAuthError) {
          return sendAuthError(reply, error);
        }
        throw error;
      }
    });

    scope.post(OPERATOR_LOGOUT_PATH, async (request, reply) => {
      if (!isAllowedRequest(request, auth)) {
        return sendLoopbackDenied(reply);
      }
      noStore(reply);
      if (request.headers.origin !== auth.publicOrigin) {
        return sendInvalidOrigin(reply);
      }
      await auth.logout(
        request.cookies[cookiePolicyFor(auth).sessionCookie],
        browserBindingTokenFrom(request, auth),
      );
      clearSessionCookie(reply, auth);
      clearLoginTransactionCookie(reply, auth);
      clearBrowserBindingCookie(reply, auth);
      return reply.code(204).send();
    });
  });
};
