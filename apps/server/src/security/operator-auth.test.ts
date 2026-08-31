import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type BeginOperatorLoginInput,
  type BeginOperatorLoginResult,
  type ClaimOperatorLoginTransactionInput,
  type CreateOperatorSessionInput,
  type DeleteOperatorBrowserFlowInput,
  type DeleteOperatorSessionInput,
  type FinalizeOperatorLoginInput,
  type FindOperatorSessionInput,
  OperatorAuthError,
  type OperatorAuthPersistence,
  OperatorAuthService,
  type OperatorIdentity,
  type OperatorOidcAuthorizationInput,
  type OperatorOidcCallbackInput,
  type OperatorOidcClient,
  type OperatorSession,
} from "../../dist/security/operator-auth.js";
import {
  createOperatorOidcClient,
  validateExactOidcIssuer,
} from "../../dist/security/operator-auth-oidc.js";

const fixedNow = new Date("2026-08-30T05:00:00.000Z");
const issuer = "https://identity.example.com";
const operatorIdentity: OperatorIdentity = {
  issuer,
  subject: "operator-123",
  displayName: "Test Operator",
  email: "operator@example.com",
};

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const browserBindingToken = "Z".repeat(43);
const browserBindingHash = hash(browserBindingToken);

class MemoryAuthPersistence implements OperatorAuthPersistence {
  public readonly browserFlows = new Map<
    string,
    { readonly generation: number; readonly expiresAt: string }
  >();
  public readonly transactions = new Map<
    string,
    BeginOperatorLoginInput & {
      readonly browserGeneration: number;
      readonly claimedAt: string | null;
    }
  >();
  public readonly sessions = new Map<string, CreateOperatorSessionInput>();

  public async beginLogin(input: BeginOperatorLoginInput): Promise<BeginOperatorLoginResult> {
    const generation = (this.browserFlows.get(input.browserSha256)?.generation ?? 0) + 1;
    this.browserFlows.set(input.browserSha256, {
      generation,
      expiresAt: input.browserExpiresAt,
    });
    for (const [token, transaction] of this.transactions) {
      if (transaction.browserSha256 === input.browserSha256) {
        this.transactions.delete(token);
      }
    }
    for (const [token, session] of this.sessions) {
      if (session.browserSha256 === input.browserSha256) {
        this.sessions.delete(token);
      }
    }
    this.transactions.set(input.transactionTokenSha256, {
      ...input,
      browserGeneration: generation,
      claimedAt: null,
    });
    return { browserGeneration: generation, browserExpiresAt: input.browserExpiresAt };
  }

  public async claimLoginTransaction(
    input: ClaimOperatorLoginTransactionInput,
  ): Promise<number | null> {
    const transaction = this.transactions.get(input.transactionTokenSha256);
    const browser = this.browserFlows.get(input.browserSha256);
    if (
      transaction === undefined ||
      browser === undefined ||
      transaction.claimedAt !== null ||
      transaction.browserSha256 !== input.browserSha256 ||
      transaction.transactionExpiresAt <= fixedNow.toISOString() ||
      browser.expiresAt <= fixedNow.toISOString() ||
      transaction.browserGeneration !== browser.generation
    ) {
      return null;
    }
    this.transactions.set(input.transactionTokenSha256, {
      ...transaction,
      claimedAt: fixedNow.toISOString(),
    });
    return transaction.browserGeneration;
  }

  public async finalizeLogin(input: FinalizeOperatorLoginInput): Promise<boolean> {
    const transaction = this.transactions.get(input.transactionTokenSha256);
    const browser = this.browserFlows.get(input.browserSha256);
    if (
      transaction === undefined ||
      browser === undefined ||
      transaction.claimedAt === null ||
      transaction.browserSha256 !== input.browserSha256 ||
      transaction.browserGeneration !== input.browserGeneration ||
      browser.generation !== input.browserGeneration ||
      transaction.transactionExpiresAt <= input.createdAt ||
      browser.expiresAt <= input.createdAt
    ) {
      return false;
    }
    this.transactions.delete(input.transactionTokenSha256);
    this.browserFlows.set(input.browserSha256, {
      generation: input.browserGeneration,
      expiresAt: input.expiresAt > browser.expiresAt ? input.expiresAt : browser.expiresAt,
    });
    this.sessions.set(input.sessionTokenSha256, {
      tokenSha256: input.sessionTokenSha256,
      browserSha256: input.browserSha256,
      browserGeneration: input.browserGeneration,
      issuer: input.issuer,
      subject: input.subject,
      displayName: input.displayName,
      email: input.email,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    });
    return true;
  }

  public async createSession(input: CreateOperatorSessionInput): Promise<void> {
    this.sessions.set(input.tokenSha256, input);
  }

  public async findSession(input: FindOperatorSessionInput): Promise<OperatorSession | null> {
    const session = this.sessions.get(input.tokenSha256);
    const browser =
      input.browserSha256 === null ? undefined : this.browserFlows.get(input.browserSha256);
    const browserMatches =
      input.browserSha256 === null
        ? session?.browserSha256 === null && session.browserGeneration === null
        : session?.browserSha256 === input.browserSha256 &&
          session.browserGeneration === browser?.generation &&
          browser.expiresAt > fixedNow.toISOString();
    if (session === undefined || session.expiresAt <= fixedNow.toISOString() || !browserMatches) {
      return null;
    }
    return {
      issuer: session.issuer,
      subject: session.subject,
      displayName: session.displayName,
      email: session.email,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }

  public async deleteSession(input: DeleteOperatorSessionInput): Promise<void> {
    this.sessions.delete(input.tokenSha256);
  }

  public async deleteBrowserFlow(input: DeleteOperatorBrowserFlowInput): Promise<void> {
    this.browserFlows.delete(input.browserSha256);
    for (const [token, transaction] of this.transactions) {
      if (transaction.browserSha256 === input.browserSha256) {
        this.transactions.delete(token);
      }
    }
    for (const [token, session] of this.sessions) {
      if (session.browserSha256 === input.browserSha256) {
        this.sessions.delete(token);
      }
    }
  }
}

class FakeOidcClient implements OperatorOidcClient {
  public readonly issuer = issuer;
  public authorizationInput: OperatorOidcAuthorizationInput | undefined;
  public callbackInput: OperatorOidcCallbackInput | undefined;
  public identity: OperatorIdentity = operatorIdentity;

  public async buildAuthorizationUrl(input: OperatorOidcAuthorizationInput): Promise<URL> {
    this.authorizationInput = input;
    const codeChallenge = createHash("sha256")
      .update(input.pkceCodeVerifier, "ascii")
      .digest("base64url");
    const url = new URL("https://identity.example.com/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  public async exchangeAuthorizationCode(
    input: OperatorOidcCallbackInput,
  ): Promise<OperatorIdentity> {
    this.callbackInput = input;
    return this.identity;
  }
}

const oidcConfig = {
  mode: "oidc" as const,
  environment: "production",
  publicOrigin: "https://review.example.com",
  loginTransactionTtlSeconds: 300,
  sessionTtlSeconds: 3600,
  postLoginRedirectPath: "/work-items",
  authorizedSubjects: [operatorIdentity.subject],
};

const createTokenGenerator = (...tokens: string[]): (() => string) => {
  let index = 0;
  return () => {
    const token = tokens[index];
    index += 1;
    if (token === undefined) {
      throw new Error("The test token generator was exhausted.");
    }
    return token;
  };
};

describe("OperatorAuthService", () => {
  it("requires browser bootstrap before creating a first-login transaction", async () => {
    const persistence = new MemoryAuthPersistence();
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc: new FakeOidcClient(),
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator("Q".repeat(43), "R".repeat(43)),
    });

    const first = auth.ensureBrowserBinding();
    const second = auth.ensureBrowserBinding();

    expect(first?.token).not.toBe(second?.token);
    expect(persistence.browserFlows.size).toBe(0);
    await expect(auth.startLogin()).rejects.toMatchObject({ code: "browser_binding_required" });
  });

  it("uses a one-time transaction for Authorization Code with PKCE and stores only token hashes", async () => {
    const transactionToken = "A".repeat(43);
    const sessionToken = "B".repeat(43);
    const persistence = new MemoryAuthPersistence();
    const oidc = new FakeOidcClient();
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc,
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator(transactionToken, sessionToken),
    });

    expect(auth.secureCookies).toBe(true);
    const start = await auth.startLogin(browserBindingToken);
    expect(start.kind).toBe("authorization_redirect");
    if (start.kind !== "authorization_redirect") {
      throw new Error("Expected an OIDC authorization redirect.");
    }
    expect(start.transactionToken).toBe(transactionToken);
    expect(start.browserBindingToken).toBe(browserBindingToken);
    expect(oidc.authorizationInput).toEqual({
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      pkceCodeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(oidc.authorizationInput?.state).not.toBe(oidc.authorizationInput?.nonce);
    expect(oidc.authorizationInput?.nonce).not.toBe(oidc.authorizationInput?.pkceCodeVerifier);
    expect(start.authorizationUrl.searchParams.get("code_challenge")).not.toBe(
      oidc.authorizationInput?.pkceCodeVerifier,
    );
    expect(persistence.transactions.has(hash(transactionToken))).toBe(true);
    expect(persistence.browserFlows.get(browserBindingHash)?.generation).toBe(1);
    expect([...persistence.transactions.keys()]).not.toContain(transactionToken);

    const callback = new URLSearchParams({
      code: "authorization-code",
      state: oidc.authorizationInput?.state ?? "",
    });
    const completed = await auth.completeLogin(callback, transactionToken, browserBindingToken);

    expect(completed.sessionToken).toBe(sessionToken);
    expect(oidc.callbackInput).toMatchObject({
      expectedState: oidc.authorizationInput?.state,
      expectedNonce: oidc.authorizationInput?.nonce,
      pkceCodeVerifier: oidc.authorizationInput?.pkceCodeVerifier,
    });
    expect(persistence.transactions.size).toBe(0);
    expect(persistence.sessions.has(hash(sessionToken))).toBe(true);
    expect([...persistence.sessions.keys()]).not.toContain(sessionToken);
    expect(JSON.stringify([...persistence.sessions.values()])).not.toContain("authorization-code");
  });

  it("rejects callback replay before exchanging another authorization code", async () => {
    const transactionToken = "C".repeat(43);
    const persistence = new MemoryAuthPersistence();
    const oidc = new FakeOidcClient();
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc,
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator(transactionToken, "D".repeat(43)),
    });
    const start = await auth.startLogin(browserBindingToken);
    if (start.kind !== "authorization_redirect") {
      throw new Error("Expected an OIDC authorization redirect.");
    }
    const callback = new URLSearchParams({
      code: "first",
      state: start.authorizationUrl.searchParams.get("state") ?? "",
    });

    await auth.completeLogin(callback, transactionToken, browserBindingToken);
    oidc.callbackInput = undefined;
    await expect(
      auth.completeLogin(callback, transactionToken, browserBindingToken),
    ).rejects.toMatchObject({
      code: "login_transaction_expired",
    });
    expect(oidc.callbackInput).toBeUndefined();
  });

  it("allows only one concurrent callback to exchange a claimed authorization code", async () => {
    const transactionToken = "I".repeat(43);
    const sessionToken = "J".repeat(43);
    const persistence = new MemoryAuthPersistence();
    const oidc = new FakeOidcClient();
    let exchangeCount = 0;
    let releaseExchange!: () => void;
    let markExchangeStarted!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    oidc.exchangeAuthorizationCode = async (input) => {
      oidc.callbackInput = input;
      exchangeCount += 1;
      markExchangeStarted();
      await exchangeGate;
      return operatorIdentity;
    };
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc,
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator(transactionToken, sessionToken),
    });
    const start = await auth.startLogin(browserBindingToken);
    if (start.kind !== "authorization_redirect") {
      throw new Error("Expected an OIDC authorization redirect.");
    }
    const callback = new URLSearchParams({
      code: "authorization-code",
      state: start.authorizationUrl.searchParams.get("state") ?? "",
    });

    const firstCompletion = auth.completeLogin(callback, transactionToken, browserBindingToken);
    await exchangeStarted;
    await expect(
      auth.completeLogin(callback, transactionToken, browserBindingToken),
    ).rejects.toMatchObject({ code: "login_transaction_expired" });
    expect(exchangeCount).toBe(1);
    releaseExchange();
    await expect(firstCompletion).resolves.toMatchObject({ sessionToken });
  });

  it("does not exchange a claimed authorization code again after exchange failure", async () => {
    const transactionToken = "V".repeat(43);
    const persistence = new MemoryAuthPersistence();
    const oidc = new FakeOidcClient();
    let exchangeCount = 0;
    oidc.exchangeAuthorizationCode = async (input) => {
      oidc.callbackInput = input;
      exchangeCount += 1;
      throw new Error("The token endpoint failed.");
    };
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc,
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator(transactionToken),
    });
    const start = await auth.startLogin(browserBindingToken);
    if (start.kind !== "authorization_redirect") {
      throw new Error("Expected an OIDC authorization redirect.");
    }
    const callback = new URLSearchParams({
      code: "authorization-code",
      state: start.authorizationUrl.searchParams.get("state") ?? "",
    });

    await expect(
      auth.completeLogin(callback, transactionToken, browserBindingToken),
    ).rejects.toMatchObject({ code: "oidc_authentication_failed" });
    await expect(
      auth.completeLogin(callback, transactionToken, browserBindingToken),
    ).rejects.toMatchObject({ code: "login_transaction_expired" });
    expect(exchangeCount).toBe(1);
  });

  it.each(["return_false", "throw"] as const)(
    "does not exchange a claimed authorization code again when finalizeLogin faults: %s",
    async (failureMode) => {
      const transactionToken = "W".repeat(43);
      const persistence = new MemoryAuthPersistence();
      const oidc = new FakeOidcClient();
      let exchangeCount = 0;
      let finalizeCount = 0;
      oidc.exchangeAuthorizationCode = async (input) => {
        oidc.callbackInput = input;
        exchangeCount += 1;
        return operatorIdentity;
      };
      persistence.finalizeLogin = async () => {
        finalizeCount += 1;
        if (failureMode === "throw") {
          throw new Error("Injected finalizeLogin failure.");
        }
        return false;
      };
      const auth = new OperatorAuthService({
        config: oidcConfig,
        persistence,
        oidc,
        now: () => fixedNow,
        generateOpaqueToken: createTokenGenerator(transactionToken, "X".repeat(43)),
      });
      const start = await auth.startLogin(browserBindingToken);
      if (start.kind !== "authorization_redirect") {
        throw new Error("Expected an OIDC authorization redirect.");
      }
      const callback = new URLSearchParams({
        code: "authorization-code",
        state: start.authorizationUrl.searchParams.get("state") ?? "",
      });

      const firstCompletion = auth.completeLogin(callback, transactionToken, browserBindingToken);
      if (failureMode === "throw") {
        await expect(firstCompletion).rejects.toThrow("Injected finalizeLogin failure.");
      } else {
        await expect(firstCompletion).rejects.toMatchObject({
          code: "login_transaction_expired",
        });
      }
      await expect(
        auth.completeLogin(callback, transactionToken, browserBindingToken),
      ).rejects.toMatchObject({ code: "login_transaction_expired" });
      expect(exchangeCount).toBe(1);
      expect(finalizeCount).toBe(1);
    },
  );

  it("fences an older callback when a newer browser generation completes first", async () => {
    const firstTransactionToken = "M".repeat(43);
    const secondTransactionToken = "N".repeat(43);
    const secondSessionToken = "O".repeat(43);
    const staleSessionToken = "P".repeat(43);
    const persistence = new MemoryAuthPersistence();
    const oidc = new FakeOidcClient();
    let firstCodeExchangeCount = 0;
    let releaseFirstExchange!: () => void;
    let markFirstExchangeStarted!: () => void;
    const firstExchangeGate = new Promise<void>((resolve) => {
      releaseFirstExchange = resolve;
    });
    const firstExchangeStarted = new Promise<void>((resolve) => {
      markFirstExchangeStarted = resolve;
    });
    oidc.exchangeAuthorizationCode = async (input) => {
      oidc.callbackInput = input;
      if (input.callbackParameters.get("code") === "first-code") {
        firstCodeExchangeCount += 1;
        markFirstExchangeStarted();
        await firstExchangeGate;
      }
      return operatorIdentity;
    };
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc,
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator(
        firstTransactionToken,
        secondTransactionToken,
        secondSessionToken,
        staleSessionToken,
      ),
    });

    const firstStart = await auth.startLogin(browserBindingToken);
    if (firstStart.kind !== "authorization_redirect") {
      throw new Error("Expected the first OIDC authorization redirect.");
    }
    const firstCallback = new URLSearchParams({
      code: "first-code",
      state: firstStart.authorizationUrl.searchParams.get("state") ?? "",
    });
    const firstCompletion = auth
      .completeLogin(firstCallback, firstTransactionToken, browserBindingToken)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await firstExchangeStarted;

    const secondStart = await auth.startLogin(browserBindingToken);
    if (secondStart.kind !== "authorization_redirect") {
      throw new Error("Expected the second OIDC authorization redirect.");
    }
    const secondCompletion = await auth.completeLogin(
      new URLSearchParams({
        code: "second-code",
        state: secondStart.authorizationUrl.searchParams.get("state") ?? "",
      }),
      secondTransactionToken,
      browserBindingToken,
    );
    releaseFirstExchange();
    const staleCompletion = await firstCompletion;

    expect(secondCompletion.sessionToken).toBe(secondSessionToken);
    expect(staleCompletion.ok).toBe(false);
    if (!staleCompletion.ok) {
      expect(staleCompletion.error).toMatchObject({ code: "login_transaction_expired" });
    }
    await expect(
      auth.completeLogin(firstCallback, firstTransactionToken, browserBindingToken),
    ).rejects.toMatchObject({ code: "login_transaction_expired" });
    expect(firstCodeExchangeCount).toBe(1);
    await expect(auth.getSession(secondSessionToken, browserBindingToken)).resolves.toMatchObject(
      operatorIdentity,
    );
    expect(persistence.sessions.has(hash(staleSessionToken))).toBe(false);
  });

  it("rejects a valid IdP identity that is not on the subject allowlist", async () => {
    const transactionToken = "E".repeat(43);
    const persistence = new MemoryAuthPersistence();
    const oidc = new FakeOidcClient();
    oidc.identity = { ...operatorIdentity, subject: "different-subject" };
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc,
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator(transactionToken),
    });
    const start = await auth.startLogin(browserBindingToken);
    if (start.kind !== "authorization_redirect") {
      throw new Error("Expected an OIDC authorization redirect.");
    }

    await expect(
      auth.completeLogin(
        new URLSearchParams({
          code: "authorization-code",
          state: start.authorizationUrl.searchParams.get("state") ?? "",
        }),
        transactionToken,
        browserBindingToken,
      ),
    ).rejects.toMatchObject({ code: "operator_not_authorized", statusCode: 403 });
    expect(persistence.sessions.size).toBe(0);
  });

  it("prevents an in-flight callback from finalizing after browser logout", async () => {
    const transactionToken = "L".repeat(43);
    const persistence = new MemoryAuthPersistence();
    const oidc = new FakeOidcClient();
    let releaseExchange!: () => void;
    let markExchangeStarted!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    oidc.exchangeAuthorizationCode = async (input) => {
      oidc.callbackInput = input;
      markExchangeStarted();
      await exchangeGate;
      return operatorIdentity;
    };
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc,
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator(transactionToken, "K".repeat(43)),
    });
    const start = await auth.startLogin(browserBindingToken);
    if (start.kind !== "authorization_redirect") {
      throw new Error("Expected an OIDC authorization redirect.");
    }

    const completion = auth
      .completeLogin(
        new URLSearchParams({
          code: "authorization-code",
          state: start.authorizationUrl.searchParams.get("state") ?? "",
        }),
        transactionToken,
        browserBindingToken,
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await exchangeStarted;
    await auth.logout(undefined, browserBindingToken);
    releaseExchange();

    const outcome = await completion;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ code: "login_transaction_expired" });
    }
    expect(oidc.callbackInput).toBeDefined();
  });

  it("looks up and revokes sessions by SHA-256 without accepting malformed cookies", async () => {
    const sessionToken = "F".repeat(43);
    const persistence = new MemoryAuthPersistence();
    persistence.sessions.set(hash(sessionToken), {
      tokenSha256: hash(sessionToken),
      browserSha256: browserBindingHash,
      browserGeneration: 1,
      ...operatorIdentity,
      createdAt: fixedNow.toISOString(),
      expiresAt: "2026-08-30T06:00:00.000Z",
    });
    persistence.browserFlows.set(browserBindingHash, {
      generation: 1,
      expiresAt: "2026-08-30T06:00:00.000Z",
    });
    const oidc = new FakeOidcClient();
    const auth = new OperatorAuthService({
      config: oidcConfig,
      persistence,
      oidc,
      now: () => fixedNow,
    });

    await expect(auth.getSession("malformed-cookie")).resolves.toBeNull();
    await expect(auth.getSession(sessionToken, browserBindingToken)).resolves.toMatchObject(
      operatorIdentity,
    );
    await auth.logout(sessionToken);
    await expect(auth.getSession(sessionToken, browserBindingToken)).resolves.toBeNull();
  });

  it("revokes an existing session when its subject is removed from the current allowlist", async () => {
    const sessionToken = "H".repeat(43);
    const tokenHash = hash(sessionToken);
    const persistence = new MemoryAuthPersistence();
    persistence.sessions.set(tokenHash, {
      tokenSha256: tokenHash,
      browserSha256: browserBindingHash,
      browserGeneration: 1,
      ...operatorIdentity,
      createdAt: fixedNow.toISOString(),
      expiresAt: "2026-08-30T06:00:00.000Z",
    });
    persistence.browserFlows.set(browserBindingHash, {
      generation: 1,
      expiresAt: "2026-08-30T06:00:00.000Z",
    });
    const auth = new OperatorAuthService({
      config: { ...oidcConfig, authorizedSubjects: ["another-operator"] },
      persistence,
      oidc: new FakeOidcClient(),
      now: () => fixedNow,
    });

    await expect(auth.getSession(sessionToken, browserBindingToken)).resolves.toBeNull();
    expect(persistence.sessions.has(tokenHash)).toBe(false);
  });

  it("rejects a discovery document URL in place of an OIDC issuer", async () => {
    await expect(
      createOperatorOidcClient({
        issuerUrl: "https://identity.example.com/.well-known/openid-configuration",
        clientId: "agentic-review",
        clientSecret: "test-secret",
        clientAuthenticationMethod: "client_secret_basic",
        redirectUri: "https://review.example.com/api/v1/auth/callback",
        scopes: ["openid"],
        requestTimeoutSeconds: 5,
      }),
    ).rejects.toThrow(/issuer, not a discovery document/u);
  });

  it.each(["common", "organizations", "consumers"])(
    "rejects the Microsoft Entra %s multi-tenant issuer",
    async (tenantAlias) => {
      await expect(
        createOperatorOidcClient({
          issuerUrl: `https://login.microsoftonline.com/${tenantAlias}/v2.0`,
          clientId: "agentic-review",
          clientSecret: "test-secret",
          clientAuthenticationMethod: "client_secret_basic",
          redirectUri: "https://review.example.com/api/v1/auth/callback",
          scopes: ["openid"],
          requestTimeoutSeconds: 5,
        }),
      ).rejects.toThrow(/tenant-specific Microsoft Entra issuer/u);
    },
  );

  it.each([
    "https://login.microsoftonline.com/{tenantid}/v2.0",
    "https://identity.example.com/%7Btenant%7D",
  ])("rejects a template issuer before discovery: %s", async (issuerUrl) => {
    await expect(
      createOperatorOidcClient({
        issuerUrl,
        clientId: "agentic-review",
        clientSecret: "test-secret",
        clientAuthenticationMethod: "client_secret_basic",
        redirectUri: "https://review.example.com/api/v1/auth/callback",
        scopes: ["openid"],
        requestTimeoutSeconds: 5,
      }),
    ).rejects.toThrow(/exact issuer.*template/u);
  });

  it("requires the discovered issuer to exactly match the configured issuer", () => {
    const configuredIssuer = "https://login.microsoftonline.com/tenant-id/v2.0";
    expect(validateExactOidcIssuer(configuredIssuer, configuredIssuer)).toBe(configuredIssuer);
    expect(() =>
      validateExactOidcIssuer(
        configuredIssuer,
        "https://login.microsoftonline.com/different-tenant/v2.0",
      ),
    ).toThrow(/exactly match the configured issuerUrl/u);
    expect(() =>
      validateExactOidcIssuer(
        configuredIssuer,
        "https://login.microsoftonline.com/{tenantid}/v2.0",
      ),
    ).toThrow(/must not contain a template/u);
  });

  it("fails closed for incomplete production OIDC and non-loopback development bypass", () => {
    expect(
      () =>
        new OperatorAuthService({
          config: oidcConfig,
          persistence: new MemoryAuthPersistence(),
        }),
    ).toThrow("requires an initialized OIDC client");
    expect(
      () =>
        new OperatorAuthService({
          config: { ...oidcConfig, authorizedSubjects: [] },
          persistence: new MemoryAuthPersistence(),
          oidc: new FakeOidcClient(),
        }),
    ).toThrow("requires at least one authorized subject");
    expect(
      () =>
        new OperatorAuthService({
          config: {
            mode: "loopback-development-bypass",
            environment: "production",
            publicOrigin: "https://review.example.com",
            loginTransactionTtlSeconds: 300,
            sessionTtlSeconds: 3600,
            postLoginRedirectPath: "/work-items",
            developmentIdentity: operatorIdentity,
          },
          persistence: new MemoryAuthPersistence(),
        }),
    ).toThrow("restricted to an explicit loopback development configuration");
  });

  it("creates an ordinary server-side session for explicit loopback development bypass", async () => {
    const persistence = new MemoryAuthPersistence();
    const auth = new OperatorAuthService({
      config: {
        mode: "loopback-development-bypass",
        environment: "development",
        publicOrigin: "http://127.0.0.1:8080",
        loginTransactionTtlSeconds: 300,
        sessionTtlSeconds: 3600,
        postLoginRedirectPath: "/work-items",
        developmentIdentity: {
          issuer: "urn:agentic-review:development",
          subject: "loopback-operator",
          displayName: "Local Operator",
          email: null,
        },
      },
      persistence,
      now: () => fixedNow,
      generateOpaqueToken: createTokenGenerator("G".repeat(43)),
    });

    expect(auth.secureCookies).toBe(false);
    await expect(auth.startLogin()).resolves.toMatchObject({
      kind: "session",
      sessionToken: "G".repeat(43),
    });
    expect(persistence.sessions.has(hash("G".repeat(43)))).toBe(true);
  });

  it("uses typed errors for callback failures", () => {
    const error = new OperatorAuthError("invalid_auth_callback", 400, "Invalid callback.");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "invalid_auth_callback", statusCode: 400 });
  });
});
