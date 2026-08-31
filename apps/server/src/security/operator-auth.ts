import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const maximumTtlSeconds = 365 * 24 * 60 * 60;

export interface OperatorIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

export interface OperatorSession extends OperatorIdentity {
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface BeginOperatorLoginInput {
  readonly transactionTokenSha256: string;
  readonly browserSha256: string;
  readonly transactionExpiresAt: string;
  readonly browserExpiresAt: string;
}

export interface BeginOperatorLoginResult {
  readonly browserGeneration: number;
  readonly browserExpiresAt: string;
}

export interface ClaimOperatorLoginTransactionInput {
  readonly transactionTokenSha256: string;
  readonly browserSha256: string;
}

export interface FinalizeOperatorLoginInput extends OperatorSession {
  readonly transactionTokenSha256: string;
  readonly sessionTokenSha256: string;
  readonly browserSha256: string;
  readonly browserGeneration: number;
}

export interface CreateOperatorSessionInput extends OperatorSession {
  readonly tokenSha256: string;
  readonly browserSha256: string | null;
  readonly browserGeneration: number | null;
}

export interface FindOperatorSessionInput {
  readonly tokenSha256: string;
  readonly browserSha256: string | null;
}

export interface DeleteOperatorSessionInput {
  readonly tokenSha256: string;
}

export interface DeleteOperatorBrowserFlowInput {
  readonly browserSha256: string;
}

export interface OperatorAuthPersistence {
  beginLogin(input: BeginOperatorLoginInput): Promise<BeginOperatorLoginResult>;
  claimLoginTransaction(input: ClaimOperatorLoginTransactionInput): Promise<number | null>;
  finalizeLogin(input: FinalizeOperatorLoginInput): Promise<boolean>;
  createSession(input: CreateOperatorSessionInput): Promise<void>;
  findSession(input: FindOperatorSessionInput): Promise<OperatorSession | null>;
  deleteSession(input: DeleteOperatorSessionInput): Promise<void>;
  deleteBrowserFlow(input: DeleteOperatorBrowserFlowInput): Promise<void>;
}

export interface OperatorOidcAuthorizationInput {
  readonly state: string;
  readonly nonce: string;
  readonly pkceCodeVerifier: string;
}

export interface OperatorOidcCallbackInput {
  readonly callbackParameters: URLSearchParams;
  readonly expectedState: string;
  readonly expectedNonce: string;
  readonly pkceCodeVerifier: string;
}

export interface OperatorOidcClient {
  readonly issuer: string;
  buildAuthorizationUrl(input: OperatorOidcAuthorizationInput): Promise<URL>;
  exchangeAuthorizationCode(input: OperatorOidcCallbackInput): Promise<OperatorIdentity>;
}

interface BaseOperatorAuthConfig {
  readonly environment: string;
  readonly publicOrigin: string;
  readonly loginTransactionTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly postLoginRedirectPath: string;
}

export interface OidcOperatorAuthConfig extends BaseOperatorAuthConfig {
  readonly mode: "oidc";
  readonly authorizedSubjects: readonly string[];
}

export interface LoopbackDevelopmentOperatorAuthConfig extends BaseOperatorAuthConfig {
  readonly mode: "loopback-development-bypass";
  readonly developmentIdentity: OperatorIdentity;
}

export type OperatorAuthConfig = OidcOperatorAuthConfig | LoopbackDevelopmentOperatorAuthConfig;

export interface OperatorAuthServiceDependencies {
  readonly config: OperatorAuthConfig;
  readonly persistence: OperatorAuthPersistence;
  readonly oidc?: OperatorOidcClient;
  readonly now?: () => Date;
  readonly generateOpaqueToken?: () => string;
}

export interface OperatorBrowserBinding {
  readonly token: string;
  readonly expiresAt: string;
}

export type OperatorLoginStart =
  | {
      readonly kind: "authorization_redirect";
      readonly authorizationUrl: URL;
      readonly transactionToken: string;
      readonly transactionExpiresAt: string;
      readonly browserBindingToken: string;
      readonly browserBindingExpiresAt: string;
    }
  | {
      readonly kind: "session";
      readonly sessionToken: string;
      readonly session: OperatorSession;
    };

export interface CompletedOperatorLogin {
  readonly sessionToken: string;
  readonly session: OperatorSession;
  readonly browserBindingExpiresAt?: string;
}

export type OperatorAuthErrorCode =
  | "browser_binding_required"
  | "invalid_auth_callback"
  | "login_transaction_expired"
  | "oidc_authentication_failed"
  | "operator_not_authorized"
  | "unsupported_auth_flow";

export class OperatorAuthError extends Error {
  public constructor(
    public readonly code: OperatorAuthErrorCode,
    public readonly statusCode: 400 | 401 | 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = "OperatorAuthError";
  }
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const deriveTransactionValue = (
  transactionToken: string,
  purpose: "nonce" | "pkce" | "state",
): string =>
  createHash("sha256")
    .update("agentic-review/operator-auth/", "utf8")
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(transactionToken, "utf8")
    .digest("base64url");

const isExactString = (value: string, maximumLength: number): boolean =>
  value.length > 0 && value.length <= maximumLength && value.trim() === value;

const isValidIdentity = (identity: OperatorIdentity): boolean =>
  isExactString(identity.issuer, 2048) &&
  isExactString(identity.subject, 512) &&
  (identity.displayName === null || isExactString(identity.displayName, 512)) &&
  (identity.email === null || isExactString(identity.email, 320));

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
};

const readPublicOrigin = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Operator authentication publicOrigin must be an absolute URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Operator authentication publicOrigin must contain only an HTTP(S) origin.");
  }
  return url;
};

const validatePositiveTtl = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximumTtlSeconds) {
    throw new Error(`${name} must be a positive integer no greater than one year.`);
  }
};

const validateConfig = (config: OperatorAuthConfig, oidc: OperatorOidcClient | undefined): URL => {
  validatePositiveTtl(config.loginTransactionTtlSeconds, "loginTransactionTtlSeconds");
  validatePositiveTtl(config.sessionTtlSeconds, "sessionTtlSeconds");
  if (
    !/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(config.postLoginRedirectPath) ||
    config.postLoginRedirectPath.includes("\\")
  ) {
    throw new Error("postLoginRedirectPath must be an absolute same-origin path.");
  }

  const publicOrigin = readPublicOrigin(config.publicOrigin);
  const environment = config.environment.trim().toLowerCase();
  if (environment !== "production" && environment !== "development" && environment !== "test") {
    throw new Error(
      "Operator authentication environment must be production, development, or test.",
    );
  }
  const loopback = isLoopbackHostname(publicOrigin.hostname);
  if (publicOrigin.protocol !== "https:" && (environment !== "development" || !loopback)) {
    throw new Error(
      "Operator authentication requires HTTPS except for an explicit loopback development origin.",
    );
  }

  if (config.mode === "loopback-development-bypass") {
    if (environment !== "development" || !loopback) {
      throw new Error(
        "The operator authentication bypass is restricted to an explicit loopback development configuration.",
      );
    }
    if (oidc !== undefined) {
      throw new Error("An OIDC client must not be configured when development bypass is enabled.");
    }
    if (!isValidIdentity(config.developmentIdentity)) {
      throw new Error("developmentIdentity contains invalid operator identity fields.");
    }
    return publicOrigin;
  }

  if (oidc === undefined) {
    throw new Error("OIDC operator authentication requires an initialized OIDC client.");
  }
  if (config.authorizedSubjects.length === 0) {
    throw new Error("OIDC operator authentication requires at least one authorized subject.");
  }
  const seenSubjects = new Set<string>();
  for (const subject of config.authorizedSubjects) {
    if (!isExactString(subject, 512)) {
      throw new Error("Every authorized OIDC subject must be a non-empty exact string.");
    }
    if (seenSubjects.has(subject)) {
      throw new Error(`Authorized OIDC subject ${subject} is configured more than once.`);
    }
    seenSubjects.add(subject);
  }
  return publicOrigin;
};

const addSeconds = (date: Date, seconds: number): string =>
  new Date(date.getTime() + seconds * 1_000).toISOString();

const isValidDate = (value: Date): boolean => Number.isFinite(value.getTime());

const statesMatch = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

export class OperatorAuthService {
  readonly #config: OperatorAuthConfig;
  readonly #persistence: OperatorAuthPersistence;
  readonly #oidc: OperatorOidcClient | undefined;
  readonly #now: () => Date;
  readonly #generateOpaqueToken: () => string;
  readonly #authorizedSubjects: ReadonlySet<string>;

  public readonly publicOrigin: string;
  public readonly postLoginRedirectPath: string;
  public readonly requiresLoopbackRequest: boolean;
  public readonly secureCookies: boolean;
  public readonly usesBrowserBinding: boolean;

  public constructor(dependencies: OperatorAuthServiceDependencies) {
    const publicOrigin = validateConfig(dependencies.config, dependencies.oidc);
    this.#config = dependencies.config;
    this.#persistence = dependencies.persistence;
    this.#oidc = dependencies.oidc;
    this.#now = dependencies.now ?? (() => new Date());
    this.#generateOpaqueToken =
      dependencies.generateOpaqueToken ?? (() => randomBytes(32).toString("base64url"));
    this.#authorizedSubjects = new Set(
      dependencies.config.mode === "oidc" ? dependencies.config.authorizedSubjects : [],
    );
    this.publicOrigin = publicOrigin.origin;
    this.postLoginRedirectPath = dependencies.config.postLoginRedirectPath;
    this.secureCookies = publicOrigin.protocol === "https:";
    this.usesBrowserBinding = dependencies.config.mode === "oidc";
    this.requiresLoopbackRequest =
      dependencies.config.mode === "loopback-development-bypass" || !this.secureCookies;
  }

  public ensureBrowserBinding(browserBindingToken?: string): OperatorBrowserBinding | undefined {
    if (
      this.#config.mode !== "oidc" ||
      (browserBindingToken !== undefined && opaqueTokenPattern.test(browserBindingToken))
    ) {
      return undefined;
    }

    const issuedAt = this.#currentTime();
    return {
      token: this.#newOpaqueToken(),
      expiresAt: addSeconds(issuedAt, this.#config.sessionTtlSeconds),
    };
  }

  public async startLogin(browserBindingToken?: string): Promise<OperatorLoginStart> {
    if (this.#config.mode === "loopback-development-bypass") {
      const completed = await this.#createSession(this.#config.developmentIdentity);
      return { kind: "session", ...completed };
    }

    if (browserBindingToken === undefined || !opaqueTokenPattern.test(browserBindingToken)) {
      throw new OperatorAuthError(
        "browser_binding_required",
        409,
        "A browser binding must be established before operator login begins.",
      );
    }
    const effectiveBrowserBindingToken = browserBindingToken;
    const transactionToken = this.#newOpaqueToken();
    const createdAt = this.#currentTime();
    const transactionExpiresAt = addSeconds(createdAt, this.#config.loginTransactionTtlSeconds);
    const browserBindingExpiresAt = addSeconds(
      createdAt,
      Math.max(this.#config.loginTransactionTtlSeconds, this.#config.sessionTtlSeconds),
    );
    const state = deriveTransactionValue(transactionToken, "state");
    const authorizationUrl = await this.#requiredOidc().buildAuthorizationUrl({
      state,
      nonce: deriveTransactionValue(transactionToken, "nonce"),
      pkceCodeVerifier: deriveTransactionValue(transactionToken, "pkce"),
    });

    const begun = await this.#persistence.beginLogin({
      transactionTokenSha256: sha256Hex(transactionToken),
      browserSha256: sha256Hex(effectiveBrowserBindingToken),
      transactionExpiresAt,
      browserExpiresAt: browserBindingExpiresAt,
    });

    return {
      kind: "authorization_redirect",
      authorizationUrl,
      transactionToken,
      transactionExpiresAt,
      browserBindingToken: effectiveBrowserBindingToken,
      browserBindingExpiresAt: begun.browserExpiresAt,
    };
  }

  public async completeLogin(
    callbackParameters: URLSearchParams,
    transactionToken: string | undefined,
    browserBindingToken: string | undefined,
  ): Promise<CompletedOperatorLogin> {
    if (this.#config.mode !== "oidc") {
      throw new OperatorAuthError(
        "unsupported_auth_flow",
        400,
        "The OIDC callback is unavailable while development bypass is enabled.",
      );
    }
    if (
      transactionToken === undefined ||
      !opaqueTokenPattern.test(transactionToken) ||
      browserBindingToken === undefined ||
      !opaqueTokenPattern.test(browserBindingToken)
    ) {
      throw new OperatorAuthError(
        "login_transaction_expired",
        401,
        "The operator login transaction is missing or expired.",
      );
    }

    const states = callbackParameters.getAll("state");
    const expectedState = deriveTransactionValue(transactionToken, "state");
    if (states.length !== 1 || !statesMatch(states[0] ?? "", expectedState)) {
      throw new OperatorAuthError(
        "invalid_auth_callback",
        400,
        "The operator authentication callback is invalid.",
      );
    }

    const transactionTokenSha256 = sha256Hex(transactionToken);
    const browserSha256 = sha256Hex(browserBindingToken);
    const browserGeneration = await this.#persistence.claimLoginTransaction({
      transactionTokenSha256,
      browserSha256,
    });
    if (browserGeneration === null) {
      throw new OperatorAuthError(
        "login_transaction_expired",
        401,
        "The operator login transaction is missing, expired, or already used.",
      );
    }

    let identity: OperatorIdentity;
    try {
      identity = await this.#requiredOidc().exchangeAuthorizationCode({
        callbackParameters: new URLSearchParams(callbackParameters),
        expectedState,
        expectedNonce: deriveTransactionValue(transactionToken, "nonce"),
        pkceCodeVerifier: deriveTransactionValue(transactionToken, "pkce"),
      });
    } catch {
      throw new OperatorAuthError(
        "oidc_authentication_failed",
        401,
        "The identity provider could not authenticate the operator.",
      );
    }

    if (!isValidIdentity(identity) || identity.issuer !== this.#requiredOidc().issuer) {
      throw new OperatorAuthError(
        "oidc_authentication_failed",
        401,
        "The identity provider returned an invalid operator identity.",
      );
    }
    if (!this.#authorizedSubjects.has(identity.subject)) {
      throw new OperatorAuthError(
        "operator_not_authorized",
        403,
        "The authenticated identity is not authorized as an operator.",
      );
    }

    const sessionToken = this.#newOpaqueToken();
    const createdAt = this.#currentTime();
    const session: OperatorSession = {
      ...identity,
      createdAt: createdAt.toISOString(),
      expiresAt: addSeconds(createdAt, this.#config.sessionTtlSeconds),
    };
    const finalized = await this.#persistence.finalizeLogin({
      transactionTokenSha256,
      sessionTokenSha256: sha256Hex(sessionToken),
      browserSha256,
      browserGeneration,
      ...session,
    });
    if (!finalized) {
      throw new OperatorAuthError(
        "login_transaction_expired",
        401,
        "The operator login transaction is missing, expired, already used, or superseded.",
      );
    }
    if (Date.parse(session.expiresAt) <= this.#currentTime().getTime()) {
      await this.#persistence.deleteSession({ tokenSha256: sha256Hex(sessionToken) });
      throw new OperatorAuthError(
        "login_transaction_expired",
        401,
        "The operator login completed after its session lifetime expired.",
      );
    }
    return {
      sessionToken,
      session,
      browserBindingExpiresAt: session.expiresAt,
    };
  }

  public async getSession(
    sessionToken: string | undefined,
    browserBindingToken?: string,
  ): Promise<OperatorSession | null> {
    if (sessionToken === undefined || !opaqueTokenPattern.test(sessionToken)) {
      return null;
    }

    const browserSha256 =
      this.#config.mode === "oidc"
        ? browserBindingToken !== undefined && opaqueTokenPattern.test(browserBindingToken)
          ? sha256Hex(browserBindingToken)
          : undefined
        : null;
    if (browserSha256 === undefined) {
      return null;
    }

    const tokenSha256 = sha256Hex(sessionToken);
    const session = await this.#persistence.findSession({
      tokenSha256,
      browserSha256,
    });
    const verifiedAt = this.#currentTime();
    if (
      session === null ||
      !isValidIdentity(session) ||
      !Number.isFinite(Date.parse(session.createdAt)) ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= verifiedAt.getTime() ||
      !this.#isCurrentlyAuthorized(session)
    ) {
      if (session !== null) {
        await this.#persistence.deleteSession({ tokenSha256 });
      }
      return null;
    }
    return session;
  }

  public async logout(
    sessionToken: string | undefined,
    browserBindingToken?: string,
  ): Promise<void> {
    if (
      this.#config.mode === "oidc" &&
      browserBindingToken !== undefined &&
      opaqueTokenPattern.test(browserBindingToken)
    ) {
      await this.#persistence.deleteBrowserFlow({
        browserSha256: sha256Hex(browserBindingToken),
      });
    }
    if (sessionToken !== undefined && opaqueTokenPattern.test(sessionToken)) {
      await this.#persistence.deleteSession({ tokenSha256: sha256Hex(sessionToken) });
    }
  }

  async #createSession(identity: OperatorIdentity): Promise<CompletedOperatorLogin> {
    const sessionToken = this.#newOpaqueToken();
    const createdAt = this.#currentTime();
    const session: OperatorSession = {
      ...identity,
      createdAt: createdAt.toISOString(),
      expiresAt: addSeconds(createdAt, this.#config.sessionTtlSeconds),
    };
    await this.#persistence.createSession({
      tokenSha256: sha256Hex(sessionToken),
      browserSha256: null,
      browserGeneration: null,
      ...session,
    });
    return { sessionToken, session };
  }

  #newOpaqueToken(): string {
    const token = this.#generateOpaqueToken();
    if (!opaqueTokenPattern.test(token)) {
      throw new Error("The operator authentication token generator returned an invalid token.");
    }
    return token;
  }

  #currentTime(): Date {
    const now = this.#now();
    if (!isValidDate(now)) {
      throw new Error("The operator authentication clock returned an invalid date.");
    }
    return now;
  }

  #requiredOidc(): OperatorOidcClient {
    if (this.#oidc === undefined) {
      throw new Error("OIDC operator authentication is not initialized.");
    }
    return this.#oidc;
  }

  #isCurrentlyAuthorized(session: OperatorSession): boolean {
    if (this.#config.mode === "oidc") {
      return (
        session.issuer === this.#requiredOidc().issuer &&
        this.#authorizedSubjects.has(session.subject)
      );
    }
    return (
      session.issuer === this.#config.developmentIdentity.issuer &&
      session.subject === this.#config.developmentIdentity.subject
    );
  }
}
