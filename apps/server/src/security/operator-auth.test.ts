import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ConsumeOperatorLoginTransactionInput,
  type CreateOperatorLoginTransactionInput,
  type CreateOperatorSessionInput,
  type DeleteOperatorSessionInput,
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
import { createOperatorOidcClient } from "../../dist/security/operator-auth-oidc.js";

const fixedNow = new Date("2026-08-30T05:00:00.000Z");
const issuer = "https://identity.example.com";
const operatorIdentity: OperatorIdentity = {
  issuer,
  subject: "operator-123",
  displayName: "Test Operator",
  email: "operator@example.com",
};

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

class MemoryAuthPersistence implements OperatorAuthPersistence {
  public readonly transactions = new Map<string, CreateOperatorLoginTransactionInput>();
  public readonly sessions = new Map<string, CreateOperatorSessionInput>();

  public async createLoginTransaction(input: CreateOperatorLoginTransactionInput): Promise<void> {
    this.transactions.set(input.tokenSha256, input);
  }

  public async consumeLoginTransaction(
    input: ConsumeOperatorLoginTransactionInput,
  ): Promise<boolean> {
    const transaction = this.transactions.get(input.tokenSha256);
    if (transaction === undefined || transaction.expiresAt <= input.consumedAt) {
      return false;
    }
    this.transactions.delete(input.tokenSha256);
    return true;
  }

  public async createSession(input: CreateOperatorSessionInput): Promise<void> {
    this.sessions.set(input.tokenSha256, input);
  }

  public async findSession(input: FindOperatorSessionInput): Promise<OperatorSession | null> {
    const session = this.sessions.get(input.tokenSha256);
    if (session === undefined || session.expiresAt <= input.accessedAt) {
      return null;
    }
    const { tokenSha256: _tokenSha256, ...stored } = session;
    return stored;
  }

  public async deleteSession(input: DeleteOperatorSessionInput): Promise<void> {
    this.sessions.delete(input.tokenSha256);
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
    const start = await auth.startLogin();
    expect(start.kind).toBe("authorization_redirect");
    if (start.kind !== "authorization_redirect") {
      throw new Error("Expected an OIDC authorization redirect.");
    }
    expect(start.transactionToken).toBe(transactionToken);
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
    expect([...persistence.transactions.keys()]).not.toContain(transactionToken);

    const callback = new URLSearchParams({
      code: "authorization-code",
      state: oidc.authorizationInput?.state ?? "",
    });
    const completed = await auth.completeLogin(callback, transactionToken);

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
    const start = await auth.startLogin();
    if (start.kind !== "authorization_redirect") {
      throw new Error("Expected an OIDC authorization redirect.");
    }
    const callback = new URLSearchParams({
      code: "first",
      state: start.authorizationUrl.searchParams.get("state") ?? "",
    });

    await auth.completeLogin(callback, transactionToken);
    oidc.callbackInput = undefined;
    await expect(auth.completeLogin(callback, transactionToken)).rejects.toMatchObject({
      code: "login_transaction_expired",
    });
    expect(oidc.callbackInput).toBeUndefined();
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
    const start = await auth.startLogin();
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
      ),
    ).rejects.toMatchObject({ code: "operator_not_authorized", statusCode: 403 });
    expect(persistence.sessions.size).toBe(0);
  });

  it("looks up and revokes sessions by SHA-256 without accepting malformed cookies", async () => {
    const sessionToken = "F".repeat(43);
    const persistence = new MemoryAuthPersistence();
    persistence.sessions.set(hash(sessionToken), {
      tokenSha256: hash(sessionToken),
      ...operatorIdentity,
      createdAt: fixedNow.toISOString(),
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
    await expect(auth.getSession(sessionToken)).resolves.toMatchObject(operatorIdentity);
    await auth.logout(sessionToken);
    await expect(auth.getSession(sessionToken)).resolves.toBeNull();
  });

  it("revokes an existing session when its subject is removed from the current allowlist", async () => {
    const sessionToken = "H".repeat(43);
    const tokenHash = hash(sessionToken);
    const persistence = new MemoryAuthPersistence();
    persistence.sessions.set(tokenHash, {
      tokenSha256: tokenHash,
      ...operatorIdentity,
      createdAt: fixedNow.toISOString(),
      expiresAt: "2026-08-30T06:00:00.000Z",
    });
    const auth = new OperatorAuthService({
      config: { ...oidcConfig, authorizedSubjects: ["another-operator"] },
      persistence,
      oidc: new FakeOidcClient(),
      now: () => fixedNow,
    });

    await expect(auth.getSession(sessionToken)).resolves.toBeNull();
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
