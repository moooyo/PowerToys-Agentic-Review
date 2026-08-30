import { readFileSync } from "node:fs";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import { isAbsolute, resolve } from "node:path";
import type { SelfOrAllowlistPolicy } from "@agentic-review/contracts";
import type { OperatorAuthConfig } from "./security/operator-auth.js";
import type { OperatorOidcClientConfig } from "./security/operator-auth-oidc.js";

export interface GitHubRepositoryTargetConfig {
  readonly githubRepositoryId: number;
  readonly fullName: string;
}

export interface GitHubWebhookConfig {
  readonly path: string;
  readonly secret: Buffer;
  readonly maxPayloadBytes: number;
}

export interface GitHubPollingConfig {
  readonly token: string;
  readonly intervalSeconds: number;
}

export interface GitHubIntegrationConfig {
  readonly repositories: readonly GitHubRepositoryTargetConfig[];
  readonly reviewer: {
    readonly githubUserId: number;
    readonly login: string;
  };
  readonly authorizationPolicy: SelfOrAllowlistPolicy;
  readonly promptDirectory: string;
  readonly webhook: GitHubWebhookConfig | undefined;
  readonly polling: GitHubPollingConfig | undefined;
}

export interface OperatorAuthRuntimeConfig {
  readonly service: OperatorAuthConfig;
  readonly oidc: OperatorOidcClientConfig | undefined;
}

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly migrationsDirectory: string;
  readonly protocolVersion: string;
  readonly heartbeatIntervalSeconds: number;
  readonly leaseTtlSeconds: number;
  readonly leaseReaperIntervalSeconds: number;
  readonly retryDelaySeconds: number;
  readonly workerOfflineAfterSeconds: number;
  readonly maxLongPollSeconds: number;
  readonly allowInsecureWorkerAuth: boolean;
  readonly tls: HttpsServerOptions | undefined;
  readonly workerCertificateBindings: Readonly<Record<string, string>>;
  readonly github: GitHubIntegrationConfig | undefined;
  readonly operatorAuth: OperatorAuthRuntimeConfig | undefined;
  readonly dashboardDirectory: string | undefined;
}

const readPositiveInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }

  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(`${name} must be a positive base-10 integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }

  return value;
};

const readBoolean = (environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  throw new Error(`${name} must be true, false, 1, or 0.`);
};

const readRequired = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const readSecretFile = (environment: NodeJS.ProcessEnv, name: string): Buffer => {
  const path = resolve(readRequired(environment, name));
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`Unable to read ${name} from ${path}.`, { cause: error });
  }
};

const readOptionalSecretFile = (
  environment: NodeJS.ProcessEnv,
  name: string,
): Buffer | undefined => {
  const path = environment[name]?.trim();
  if (path === undefined || path === "") {
    return undefined;
  }
  try {
    return readFileSync(resolve(path));
  } catch (error) {
    throw new Error(`Unable to read ${name} from ${resolve(path)}.`, { cause: error });
  }
};

const readSecretText = (value: Buffer, name: string): string => {
  const text = value.toString("utf8").trim();
  if (text.length === 0 || text.includes("\u0000")) {
    throw new Error(`${name} must contain non-empty UTF-8 text without NUL characters.`);
  }
  return text;
};

const readPositiveIntegerValue = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value as number;
};

const readJson = (environment: NodeJS.ProcessEnv, name: string): unknown => {
  const text = readRequired(environment, name);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${name} must contain valid JSON.`, { cause: error });
  }
};

const readGitHubRepositories = (
  environment: NodeJS.ProcessEnv,
): readonly GitHubRepositoryTargetConfig[] => {
  const value = readJson(environment, "AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON");
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(
      "AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON must contain 1 through 100 repositories.",
    );
  }

  const ids = new Set<number>();
  const names = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`GitHub repository target ${index} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "githubRepositoryId" && key !== "fullName")) {
      throw new Error(`GitHub repository target ${index} contains an unsupported field.`);
    }
    const githubRepositoryId = readPositiveIntegerValue(
      record.githubRepositoryId,
      `GitHub repository target ${index}.githubRepositoryId`,
    );
    const fullName = record.fullName;
    if (typeof fullName !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName)) {
      throw new Error(`GitHub repository target ${index}.fullName must be an owner/name pair.`);
    }
    const normalizedName = fullName.toLowerCase();
    if (ids.has(githubRepositoryId) || names.has(normalizedName)) {
      throw new Error("GitHub repository targets must have unique IDs and names.");
    }
    ids.add(githubRepositoryId);
    names.add(normalizedName);
    return Object.freeze({ githubRepositoryId, fullName });
  });
};

const readGitHubActorAllowlist = (environment: NodeJS.ProcessEnv): readonly number[] => {
  const raw = environment.AGENTIC_REVIEW_GITHUB_ALLOWED_ACTOR_IDS_JSON;
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  const value = readJson(environment, "AGENTIC_REVIEW_GITHUB_ALLOWED_ACTOR_IDS_JSON");
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new Error(
      "AGENTIC_REVIEW_GITHUB_ALLOWED_ACTOR_IDS_JSON must contain at most 1024 user IDs.",
    );
  }
  const ids = value.map((entry, index) =>
    readPositiveIntegerValue(entry, `GitHub actor allowlist entry ${index}`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error("GitHub actor allowlist entries must be unique.");
  }
  return ids;
};

const readGitHubConfig = (
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): GitHubIntegrationConfig | undefined => {
  const webhookSecret = readOptionalSecretFile(
    environment,
    "AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH",
  );
  const pollingToken = readOptionalSecretFile(environment, "AGENTIC_REVIEW_GITHUB_TOKEN_PATH");
  if (webhookSecret === undefined && pollingToken === undefined) {
    return undefined;
  }

  const reviewerId = readPositiveIntegerValue(
    Number(readRequired(environment, "AGENTIC_REVIEW_GITHUB_TARGET_USER_ID")),
    "AGENTIC_REVIEW_GITHUB_TARGET_USER_ID",
  );
  const reviewerLogin = readRequired(environment, "AGENTIC_REVIEW_GITHUB_TARGET_LOGIN");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(reviewerLogin)) {
    throw new Error("AGENTIC_REVIEW_GITHUB_TARGET_LOGIN must be a valid GitHub login.");
  }
  const policyVersion = readPositiveInteger(
    environment,
    "AGENTIC_REVIEW_GITHUB_POLICY_VERSION",
    1,
    2_147_483_647,
  );
  const configuredPromptDirectory = environment.AGENTIC_REVIEW_PROMPT_DIRECTORY?.trim();
  if (
    configuredPromptDirectory !== undefined &&
    configuredPromptDirectory !== "" &&
    !isAbsolute(configuredPromptDirectory)
  ) {
    throw new Error("AGENTIC_REVIEW_PROMPT_DIRECTORY must be an absolute path.");
  }

  return Object.freeze({
    repositories: readGitHubRepositories(environment),
    reviewer: Object.freeze({ githubUserId: reviewerId, login: reviewerLogin }),
    authorizationPolicy: Object.freeze({
      kind: "self_or_allowlist",
      policyVersion,
      schedulingTargetGithubUserId: reviewerId,
      allowlistedActorGithubUserIds: [...readGitHubActorAllowlist(environment)],
      unknownActorPolicy: "deny",
      newRevisionPolicy: "inherit_authorized_epoch",
    }),
    promptDirectory:
      configuredPromptDirectory === undefined || configuredPromptDirectory === ""
        ? resolve(repositoryRoot, "config", "prompts")
        : resolve(configuredPromptDirectory),
    webhook:
      webhookSecret === undefined
        ? undefined
        : Object.freeze({
            path: environment.AGENTIC_REVIEW_GITHUB_WEBHOOK_PATH ?? "/api/v1/github/webhook",
            secret: webhookSecret,
            maxPayloadBytes: readPositiveInteger(
              environment,
              "AGENTIC_REVIEW_GITHUB_WEBHOOK_MAX_BYTES",
              2 * 1_024 * 1_024,
              25 * 1_024 * 1_024,
            ),
          }),
    polling:
      pollingToken === undefined
        ? undefined
        : Object.freeze({
            token: readSecretText(pollingToken, "AGENTIC_REVIEW_GITHUB_TOKEN_PATH"),
            intervalSeconds: readPositiveInteger(
              environment,
              "AGENTIC_REVIEW_GITHUB_POLL_INTERVAL_SECONDS",
              60,
              86_400,
            ),
          }),
  });
};

const readStringArrayJson = (
  environment: NodeJS.ProcessEnv,
  name: string,
  maximumItems: number,
): readonly string[] => {
  const value = readJson(environment, name);
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new Error(`${name} must contain 1 through ${maximumItems} strings.`);
  }
  const strings = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry) {
      throw new Error(`${name}[${index}] must be a non-empty exact string.`);
    }
    return entry;
  });
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${name} must contain unique values.`);
  }
  return strings;
};

const readOperatorAuthConfig = (
  environment: NodeJS.ProcessEnv,
  host: string,
): OperatorAuthRuntimeConfig | undefined => {
  const mode = environment.AGENTIC_REVIEW_OPERATOR_AUTH_MODE?.trim();
  const runtimeEnvironment = environment.NODE_ENV?.trim().toLowerCase() || "development";
  if (mode === undefined || mode === "") {
    if (runtimeEnvironment === "production") {
      throw new Error("AGENTIC_REVIEW_OPERATOR_AUTH_MODE=oidc is required in production.");
    }
    return undefined;
  }

  const publicOrigin = readRequired(environment, "AGENTIC_REVIEW_PUBLIC_ORIGIN");
  const common = {
    environment: runtimeEnvironment,
    publicOrigin,
    loginTransactionTtlSeconds: readPositiveInteger(
      environment,
      "AGENTIC_REVIEW_OPERATOR_LOGIN_TTL_SECONDS",
      600,
      365 * 24 * 60 * 60,
    ),
    sessionTtlSeconds: readPositiveInteger(
      environment,
      "AGENTIC_REVIEW_OPERATOR_SESSION_TTL_SECONDS",
      8 * 60 * 60,
      365 * 24 * 60 * 60,
    ),
    postLoginRedirectPath: environment.AGENTIC_REVIEW_OPERATOR_POST_LOGIN_PATH ?? "/work-items",
  } as const;

  if (mode === "loopback-development-bypass") {
    if (runtimeEnvironment !== "development") {
      throw new Error("Operator authentication bypass is allowed only in development.");
    }
    if (!isLoopbackHost(host)) {
      throw new Error("Operator authentication bypass requires a loopback server listener.");
    }
    return Object.freeze({
      service: {
        ...common,
        mode: "loopback-development-bypass" as const,
        developmentIdentity: {
          issuer: "urn:agentic-review:development",
          subject: readRequired(environment, "AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT"),
          displayName:
            environment.AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_NAME?.trim() || "Development Operator",
          email: null,
        },
      },
      oidc: undefined,
    });
  }

  if (mode !== "oidc") {
    throw new Error(
      "AGENTIC_REVIEW_OPERATOR_AUTH_MODE must be oidc or loopback-development-bypass.",
    );
  }

  const origin = new URL(publicOrigin);
  const clientAuthenticationMethod =
    environment.AGENTIC_REVIEW_OIDC_CLIENT_AUTH_METHOD ?? "client_secret_basic";
  if (
    clientAuthenticationMethod !== "client_secret_basic" &&
    clientAuthenticationMethod !== "client_secret_post"
  ) {
    throw new Error(
      "AGENTIC_REVIEW_OIDC_CLIENT_AUTH_METHOD must be client_secret_basic or client_secret_post.",
    );
  }
  const validatedClientAuthenticationMethod: "client_secret_basic" | "client_secret_post" =
    clientAuthenticationMethod;
  const secretBytes = readOptionalSecretFile(environment, "AGENTIC_REVIEW_OIDC_CLIENT_SECRET_PATH");
  if (secretBytes === undefined) {
    throw new Error("AGENTIC_REVIEW_OIDC_CLIENT_SECRET_PATH is required for OIDC authentication.");
  }
  const scopes = (environment.AGENTIC_REVIEW_OIDC_SCOPES ?? "openid profile email")
    .split(/\s+/u)
    .filter((scope) => scope.length > 0);

  return Object.freeze({
    service: {
      ...common,
      mode: "oidc" as const,
      authorizedSubjects: readStringArrayJson(
        environment,
        "AGENTIC_REVIEW_OIDC_AUTHORIZED_SUBJECTS_JSON",
        1_024,
      ),
    },
    oidc: {
      issuerUrl: readRequired(environment, "AGENTIC_REVIEW_OIDC_ISSUER_URL"),
      clientId: readRequired(environment, "AGENTIC_REVIEW_OIDC_CLIENT_ID"),
      clientSecret: readSecretText(secretBytes, "AGENTIC_REVIEW_OIDC_CLIENT_SECRET_PATH"),
      clientAuthenticationMethod: validatedClientAuthenticationMethod,
      redirectUri: new URL("/api/v1/auth/callback", origin).href,
      scopes,
      requestTimeoutSeconds: readPositiveInteger(
        environment,
        "AGENTIC_REVIEW_OIDC_REQUEST_TIMEOUT_SECONDS",
        15,
        300,
      ),
    },
  });
};

const normalizeSha256Fingerprint = (fingerprint: string): string => {
  const normalized = fingerprint.trim().replaceAll(":", "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(normalized)) {
    throw new Error(
      "Worker certificate fingerprints must be SHA-256 values encoded as 64 hexadecimal characters, with optional colon separators.",
    );
  }
  return normalized;
};

const readWorkerCertificateBindings = (
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> => {
  const raw = environment.AGENTIC_REVIEW_WORKER_CERTIFICATE_BINDINGS_JSON;
  if (raw === undefined || raw.trim() === "") {
    return Object.freeze({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("AGENTIC_REVIEW_WORKER_CERTIFICATE_BINDINGS_JSON must contain valid JSON.", {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AGENTIC_REVIEW_WORKER_CERTIFICATE_BINDINGS_JSON must contain a JSON object.");
  }

  const bindings: Record<string, string> = {};
  for (const [fingerprint, workerNodeId] of Object.entries(parsed)) {
    if (
      typeof workerNodeId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerNodeId)
    ) {
      throw new Error("Every worker certificate binding must map to a valid workerNodeId.");
    }

    const normalizedFingerprint = normalizeSha256Fingerprint(fingerprint);
    const existing = bindings[normalizedFingerprint];
    if (existing !== undefined && existing !== workerNodeId) {
      throw new Error(
        `Certificate fingerprint ${normalizedFingerprint} is mapped to more than one workerNodeId.`,
      );
    }
    bindings[normalizedFingerprint] = workerNodeId;
  }

  return Object.freeze(bindings);
};

const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
};

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): ServerConfig => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const host = environment.AGENTIC_REVIEW_HOST ?? "127.0.0.1";
  const allowInsecureWorkerAuth = readBoolean(
    environment,
    "AGENTIC_REVIEW_ALLOW_INSECURE_WORKER_AUTH",
    false,
  );
  const workerCertificateBindings = readWorkerCertificateBindings(environment);
  const configuredDashboardDirectory = environment.AGENTIC_REVIEW_DASHBOARD_DIRECTORY?.trim();
  if (
    configuredDashboardDirectory !== undefined &&
    configuredDashboardDirectory !== "" &&
    !isAbsolute(configuredDashboardDirectory)
  ) {
    throw new Error("AGENTIC_REVIEW_DASHBOARD_DIRECTORY must be an absolute path.");
  }

  if (allowInsecureWorkerAuth) {
    if (environment.NODE_ENV?.trim().toLowerCase() === "production") {
      throw new Error("AGENTIC_REVIEW_ALLOW_INSECURE_WORKER_AUTH cannot be enabled in production.");
    }
    if (!isLoopbackHost(host)) {
      throw new Error("Insecure Worker authentication is restricted to a loopback listener.");
    }
  } else if (Object.keys(workerCertificateBindings).length === 0) {
    throw new Error(
      "AGENTIC_REVIEW_WORKER_CERTIFICATE_BINDINGS_JSON must configure at least one certificate when insecure Worker authentication is disabled.",
    );
  }

  const tls: HttpsServerOptions | undefined = allowInsecureWorkerAuth
    ? undefined
    : Object.freeze({
        key: readSecretFile(environment, "AGENTIC_REVIEW_TLS_KEY_PATH"),
        cert: readSecretFile(environment, "AGENTIC_REVIEW_TLS_CERT_PATH"),
        ca: readSecretFile(environment, "AGENTIC_REVIEW_TLS_CLIENT_CA_PATH"),
        requestCert: true,
        // The shared listener also serves the operator dashboard. Worker routes
        // separately require an authorized client certificate in their preHandler.
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        ...(environment.AGENTIC_REVIEW_TLS_KEY_PASSPHRASE === undefined
          ? {}
          : { passphrase: environment.AGENTIC_REVIEW_TLS_KEY_PASSPHRASE }),
      });

  return Object.freeze({
    host,
    port: readPositiveInteger(environment, "AGENTIC_REVIEW_PORT", 8080, 65_535),
    databasePath: resolve(
      environment.AGENTIC_REVIEW_DATABASE_PATH ??
        resolve(repositoryRoot, ".data", "agentic-review.db"),
    ),
    migrationsDirectory: resolve(
      environment.AGENTIC_REVIEW_MIGRATIONS_DIRECTORY ?? resolve(repositoryRoot, "migrations"),
    ),
    protocolVersion: "1.0",
    heartbeatIntervalSeconds: readPositiveInteger(
      environment,
      "AGENTIC_REVIEW_HEARTBEAT_INTERVAL_SECONDS",
      20,
      3_600,
    ),
    leaseTtlSeconds: readPositiveInteger(
      environment,
      "AGENTIC_REVIEW_LEASE_TTL_SECONDS",
      120,
      86_400,
    ),
    leaseReaperIntervalSeconds: readPositiveInteger(
      environment,
      "AGENTIC_REVIEW_LEASE_REAPER_INTERVAL_SECONDS",
      15,
      3_600,
    ),
    retryDelaySeconds: readPositiveInteger(
      environment,
      "AGENTIC_REVIEW_RETRY_DELAY_SECONDS",
      30,
      86_400,
    ),
    workerOfflineAfterSeconds: readPositiveInteger(
      environment,
      "AGENTIC_REVIEW_WORKER_OFFLINE_AFTER_SECONDS",
      90,
      86_400,
    ),
    maxLongPollSeconds: readPositiveInteger(
      environment,
      "AGENTIC_REVIEW_MAX_LONG_POLL_SECONDS",
      30,
      300,
    ),
    allowInsecureWorkerAuth,
    tls,
    workerCertificateBindings,
    github: readGitHubConfig(environment, repositoryRoot),
    operatorAuth: readOperatorAuthConfig(environment, host),
    dashboardDirectory:
      configuredDashboardDirectory === undefined || configuredDashboardDirectory === ""
        ? environment.NODE_ENV?.trim().toLowerCase() === "production"
          ? resolve(repositoryRoot, "apps", "dashboard", "dist")
          : undefined
        : resolve(configuredDashboardDirectory),
  });
};
