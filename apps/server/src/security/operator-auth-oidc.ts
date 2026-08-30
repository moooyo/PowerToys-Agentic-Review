import * as oidc from "openid-client";
import type {
  OperatorIdentity,
  OperatorOidcAuthorizationInput,
  OperatorOidcCallbackInput,
  OperatorOidcClient,
} from "./operator-auth.js";

export interface OperatorOidcClientConfig {
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientAuthenticationMethod: "client_secret_basic" | "client_secret_post";
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly requestTimeoutSeconds: number;
}

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
};

const readHttpsUrl = (value: string, name: string, allowLoopbackHttp: boolean): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  const loopbackHttp =
    allowLoopbackHttp && url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be a secure URL without credentials, a query, or a fragment.`);
  }
  return url;
};

const validateConfig = (
  config: OperatorOidcClientConfig,
): { readonly issuerUrl: URL; readonly redirectUri: URL; readonly scope: string } => {
  const issuerUrl = readHttpsUrl(config.issuerUrl, "issuerUrl", false);
  if (issuerUrl.pathname.includes("/.well-known/")) {
    throw new Error("issuerUrl must identify the issuer, not a discovery document URL.");
  }
  const redirectUri = readHttpsUrl(config.redirectUri, "redirectUri", true);
  if (config.clientId.length === 0 || config.clientId.length > 512) {
    throw new Error("clientId must contain between 1 and 512 characters.");
  }
  if (config.clientSecret.length === 0 || config.clientSecret.length > 4096) {
    throw new Error("clientSecret must contain between 1 and 4096 characters.");
  }
  if (
    !Number.isSafeInteger(config.requestTimeoutSeconds) ||
    config.requestTimeoutSeconds <= 0 ||
    config.requestTimeoutSeconds > 300
  ) {
    throw new Error("requestTimeoutSeconds must be a positive integer no greater than 300.");
  }
  if (config.scopes.length === 0 || !config.scopes.includes("openid")) {
    throw new Error("OIDC scopes must include openid.");
  }
  const seenScopes = new Set<string>();
  for (const scope of config.scopes) {
    if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope) || seenScopes.has(scope)) {
      throw new Error("OIDC scopes must be unique valid OAuth 2.0 scope tokens.");
    }
    seenScopes.add(scope);
  }
  return { issuerUrl, redirectUri, scope: config.scopes.join(" ") };
};

const readOptionalClaim = (
  claims: Readonly<Record<string, unknown>>,
  name: string,
  maximumLength: number,
): string | null => {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    ? value
    : null;
};

class OpenIdClientOperatorAdapter implements OperatorOidcClient {
  readonly #configuration: oidc.Configuration;
  readonly #redirectUri: URL;
  readonly #scope: string;

  public readonly issuer: string;

  public constructor(configuration: oidc.Configuration, redirectUri: URL, scope: string) {
    this.#configuration = configuration;
    this.#redirectUri = redirectUri;
    this.#scope = scope;
    const issuer = configuration.serverMetadata().issuer;
    if (typeof issuer !== "string" || issuer.length === 0) {
      throw new Error("OIDC discovery did not return an issuer identifier.");
    }
    this.issuer = issuer;
  }

  public async buildAuthorizationUrl(input: OperatorOidcAuthorizationInput): Promise<URL> {
    const codeChallenge = await oidc.calculatePKCECodeChallenge(input.pkceCodeVerifier);
    return oidc.buildAuthorizationUrl(this.#configuration, {
      redirect_uri: this.#redirectUri.href,
      response_mode: "query",
      scope: this.#scope,
      state: input.state,
      nonce: input.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
  }

  public async exchangeAuthorizationCode(
    input: OperatorOidcCallbackInput,
  ): Promise<OperatorIdentity> {
    const callbackUrl = new URL(this.#redirectUri);
    callbackUrl.search = input.callbackParameters.toString();
    const tokenResponse = await oidc.authorizationCodeGrant(this.#configuration, callbackUrl, {
      expectedState: input.expectedState,
      expectedNonce: input.expectedNonce,
      pkceCodeVerifier: input.pkceCodeVerifier,
      idTokenExpected: true,
    });
    const claims = tokenResponse.claims();
    if (claims === undefined) {
      throw new Error("The OIDC token response did not include a validated ID Token.");
    }

    const claimRecord = claims as Readonly<Record<string, unknown>>;
    const displayName =
      readOptionalClaim(claimRecord, "name", 512) ??
      readOptionalClaim(claimRecord, "preferred_username", 512);
    const email =
      claimRecord.email_verified === true ? readOptionalClaim(claimRecord, "email", 320) : null;

    return {
      issuer: claims.iss,
      subject: claims.sub,
      displayName,
      email,
    };
  }
}

export const createOperatorOidcClient = async (
  config: OperatorOidcClientConfig,
): Promise<OperatorOidcClient> => {
  const validated = validateConfig(config);
  const clientAuthentication =
    config.clientAuthenticationMethod === "client_secret_basic"
      ? oidc.ClientSecretBasic(config.clientSecret)
      : oidc.ClientSecretPost(config.clientSecret);
  const configuration = await oidc.discovery(
    validated.issuerUrl,
    config.clientId,
    {
      client_secret: config.clientSecret,
      redirect_uris: [validated.redirectUri.href],
      response_types: ["code"],
      token_endpoint_auth_method: config.clientAuthenticationMethod,
    },
    clientAuthentication,
    { timeout: config.requestTimeoutSeconds },
  );

  return new OpenIdClientOperatorAdapter(configuration, validated.redirectUri, validated.scope);
};
