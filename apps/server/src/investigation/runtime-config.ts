import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EntityIdSchema,
  type InvestigationActionKind,
  InvestigationActionKindSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { OperatorAuthConfig } from "../security/operator-auth.js";
import type { OperatorOidcClientConfig } from "../security/operator-auth-oidc.js";
import type { InvestigationOperatorPrincipal, InvestigationWorkerPrincipal } from "./types.js";

export interface InvestigationOperatorBinding extends InvestigationOperatorPrincipal {
  readonly issuer: string;
  readonly subject: string;
}

export interface InvestigationWorkerCredential extends InvestigationWorkerPrincipal {
  readonly token: string;
}

export interface InvestigationRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly authDatabasePath: string;
  readonly dashboardDirectory: string;
  readonly auth: OperatorAuthConfig;
  readonly oidc: OperatorOidcClientConfig | undefined;
  readonly operators: readonly InvestigationOperatorBinding[];
  readonly workers: readonly InvestigationWorkerCredential[];
  readonly https: { key: string; cert: string; passphrase?: string } | undefined;
  readonly github: { token: string; expectedGitHubUserId: number } | undefined;
  readonly enableExternalWrites: boolean;
  readonly executionBindingsPath: string | undefined;
  readonly sourceImportMaximumBytes: number;
  readonly sourceImportMaximumPages: number;
}

const permissions = [
  "repository:manage",
  "task:create",
  "task:cancel",
  "action:prepare",
  "action:execute",
] as const;
type Environment = Readonly<Record<string, string | undefined>>;

function exact(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.trim() !== value
  ) {
    throw new Error(`${name} must be a non-empty exact string.`);
  }
  return value;
}

function entries(value: unknown, name: string): readonly Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.length > 1024 ||
    value.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))
  ) {
    throw new Error(`${name} must be a JSON array of at most 1024 objects.`);
  }
  return value;
}

function entityId(value: unknown, name: string): string {
  const id = exact(value, name);
  if (!Value.Check(EntityIdSchema, id)) throw new Error(`${name} must be a valid entity ID.`);
  return id;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 4096)
    throw new Error(`${name} must be a string array.`);
  const result = value.map((entry) => exact(entry, name));
  if (new Set(result).size !== result.length || result.includes("*")) {
    throw new Error(`${name} must contain unique exact values; wildcard scopes are unsupported.`);
  }
  return result;
}

function integer(
  environment: Environment,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(raw)) throw new Error(`${name} must be a positive integer.`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result > maximum)
    throw new Error(`${name} is out of range.`);
  return result;
}

function boolean(environment: Environment, name: string, fallback: boolean): boolean {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false.`);
  return value === "true";
}

function secret(environment: Environment, name: string): string | undefined {
  const inline = environment[name];
  const path = environment[`${name}_PATH`];
  if (inline !== undefined && path !== undefined)
    throw new Error(`Configure only ${name} or ${name}_PATH.`);
  if (path !== undefined)
    return exact(readFileSync(exact(path, `${name}_PATH`), "utf8").trim(), name);
  return inline === undefined ? undefined : exact(inline, name);
}

function parseJson(environment: Environment, name: string, fallback: unknown): unknown {
  const inline = environment[name];
  const path = environment[`${name}_PATH`];
  if (inline !== undefined && path !== undefined)
    throw new Error(`Configure only ${name} or ${name}_PATH.`);
  const value = path === undefined ? inline : readFileSync(exact(path, `${name}_PATH`), "utf8");
  if (value === undefined) return fallback;
  if (Buffer.byteLength(value) > 2 * 1024 * 1024)
    throw new Error(`${name} exceeds the configuration size limit.`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

function operatorBinding(
  value: Record<string, unknown>,
  issuer: string,
): InvestigationOperatorBinding {
  const grantedPermissions = stringList(value.permissions, "operator.permissions");
  if (
    grantedPermissions.some((permission) => !permissions.some((allowed) => permission === allowed))
  ) {
    throw new Error("operator.permissions contains an unknown permission.");
  }
  const actionCapabilities = stringList(value.actionCapabilities, "operator.actionCapabilities");
  if (actionCapabilities.some((action) => !Value.Check(InvestigationActionKindSchema, action))) {
    throw new Error("operator.actionCapabilities contains an unknown action.");
  }
  if (typeof value.allowRepositoryExecution !== "boolean")
    throw new Error("operator.allowRepositoryExecution must be boolean.");
  return {
    issuer,
    id: entityId(value.id, "operator.id"),
    subject: exact(value.subject, "operator.subject"),
    displayName: exact(value.displayName, "operator.displayName"),
    repositoryIds: stringList(value.repositoryIds, "operator.repositoryIds").map((id) =>
      entityId(id, "operator.repositoryIds"),
    ),
    permissions: grantedPermissions as InvestigationOperatorBinding["permissions"],
    actionCapabilities: actionCapabilities as InvestigationActionKind[],
    allowRepositoryExecution: value.allowRepositoryExecution,
  };
}

export function loadInvestigationRuntimeConfig(
  environment: Environment = process.env,
): InvestigationRuntimeConfig {
  const host = exact(environment.INVESTIGATION_HOST ?? "127.0.0.1", "INVESTIGATION_HOST");
  const port = integer(environment, "INVESTIGATION_PORT", 8000, 65535);
  const mode = environment.INVESTIGATION_AUTH_MODE ?? "loopback";
  if (mode !== "oidc" && mode !== "loopback")
    throw new Error("INVESTIGATION_AUTH_MODE must be oidc or loopback.");
  const publicOrigin = new URL(
    environment.INVESTIGATION_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
  );
  if (
    publicOrigin.href !== `${publicOrigin.origin}/` ||
    publicOrigin.username !== "" ||
    publicOrigin.password !== ""
  ) {
    throw new Error(
      "INVESTIGATION_PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials.",
    );
  }
  if (mode === "loopback" && (host !== "127.0.0.1" || publicOrigin.hostname !== "127.0.0.1")) {
    throw new Error(
      "Loopback authentication requires the literal 127.0.0.1 listener and public origin.",
    );
  }
  const keyPath = environment.INVESTIGATION_TLS_KEY_PATH;
  const certPath = environment.INVESTIGATION_TLS_CERT_PATH;
  if ((keyPath === undefined) !== (certPath === undefined))
    throw new Error("TLS key and certificate paths must be configured together.");
  const tlsPassphrase = secret(environment, "INVESTIGATION_TLS_KEY_PASSPHRASE");
  const https =
    keyPath === undefined || certPath === undefined
      ? undefined
      : {
          key: readFileSync(keyPath, "utf8"),
          cert: readFileSync(certPath, "utf8"),
          ...(tlsPassphrase === undefined ? {} : { passphrase: tlsPassphrase }),
        };
  if (tlsPassphrase !== undefined && https === undefined)
    throw new Error("A TLS key passphrase requires a configured TLS listener.");
  if (
    publicOrigin.protocol !== "https:" &&
    !(mode === "loopback" && publicOrigin.protocol === "http:" && https === undefined)
  ) {
    throw new Error("Remote operator authentication requires an HTTPS public origin.");
  }
  if (host !== "127.0.0.1" && https === undefined)
    throw new Error(
      "A non-loopback listener requires TLS; use loopback behind an HTTPS reverse proxy.",
    );
  if (https !== undefined && publicOrigin.protocol !== "https:")
    throw new Error("TLS requires an HTTPS public origin.");
  const issuer =
    mode === "loopback"
      ? "urn:agentic-review:loopback"
      : exact(environment.INVESTIGATION_OIDC_ISSUER_URL, "INVESTIGATION_OIDC_ISSUER_URL");
  const operators = entries(
    parseJson(
      environment,
      "INVESTIGATION_OPERATORS_JSON",
      mode === "loopback"
        ? [
            {
              id: "local-operator",
              subject: "local-operator",
              displayName: "Local Operator",
              repositoryIds: [],
              permissions: ["repository:manage"],
              actionCapabilities: [],
              allowRepositoryExecution: false,
            },
          ]
        : [],
    ),
    "INVESTIGATION_OPERATORS_JSON",
  ).map((value) => operatorBinding(value, issuer));
  if (
    operators.length === 0 ||
    new Set(operators.map((operator) => operator.id)).size !== operators.length ||
    new Set(operators.map((operator) => operator.subject)).size !== operators.length
  ) {
    throw new Error("Configure at least one operator with a unique ID and subject.");
  }
  if (mode === "loopback" && operators.length !== 1)
    throw new Error("Loopback mode supports exactly one local operator.");
  const commonAuth = {
    environment: mode === "loopback" && https === undefined ? "development" : "production",
    publicOrigin: publicOrigin.origin,
    loginTransactionTtlSeconds: integer(environment, "INVESTIGATION_LOGIN_TTL_SECONDS", 600, 3600),
    sessionTtlSeconds: integer(environment, "INVESTIGATION_SESSION_TTL_SECONDS", 28800, 86400),
    postLoginRedirectPath: "/pull-requests",
  };
  const firstOperator = operators[0];
  if (firstOperator === undefined) throw new Error("The operator binding is missing.");
  const auth: OperatorAuthConfig =
    mode === "loopback"
      ? {
          ...commonAuth,
          mode,
          developmentIdentity: {
            issuer,
            subject: firstOperator.subject,
            displayName: firstOperator.displayName,
            email: null,
          },
        }
      : { ...commonAuth, mode, authorizedSubjects: operators.map((operator) => operator.subject) };
  const oidcSecret = secret(environment, "INVESTIGATION_OIDC_CLIENT_SECRET");
  const oidc: OperatorOidcClientConfig | undefined =
    mode === "loopback"
      ? undefined
      : {
          issuerUrl: issuer,
          clientId: exact(environment.INVESTIGATION_OIDC_CLIENT_ID, "INVESTIGATION_OIDC_CLIENT_ID"),
          clientSecret: exact(oidcSecret, "INVESTIGATION_OIDC_CLIENT_SECRET"),
          clientAuthenticationMethod: "client_secret_basic",
          redirectUri: `${publicOrigin.origin}/api/auth/callback`,
          scopes: ["openid", "profile", "email"],
          requestTimeoutSeconds: 30,
        };
  const workers = entries(
    parseJson(environment, "INVESTIGATION_WORKERS_JSON", []),
    "INVESTIGATION_WORKERS_JSON",
  ).map((value): InvestigationWorkerCredential => {
    const token = exact(value.token, "worker.token");
    if (!/^[A-Za-z0-9_-]{43,256}$/u.test(token))
      throw new Error(
        "worker.token must contain 43 to 256 base64url characters generated from a cryptographically random source.",
      );
    return {
      id: entityId(value.id, "worker.id"),
      token,
      repositoryIds: stringList(value.repositoryIds, "worker.repositoryIds").map((id) =>
        entityId(id, "worker.repositoryIds"),
      ),
    };
  });
  if (
    new Set(workers.map((worker) => worker.id)).size !== workers.length ||
    new Set(workers.map((worker) => worker.token)).size !== workers.length
  ) {
    throw new Error("Worker IDs and credentials must be unique.");
  }
  const githubToken = secret(environment, "INVESTIGATION_GITHUB_TOKEN");
  const githubUserId = environment.INVESTIGATION_GITHUB_USER_ID;
  if ((githubToken === undefined) !== (githubUserId === undefined))
    throw new Error("GitHub token and expected user ID must be configured together.");
  const enableExternalWrites = boolean(environment, "INVESTIGATION_ENABLE_EXTERNAL_WRITES", false);
  if (enableExternalWrites && githubToken === undefined)
    throw new Error("External writes require configured GitHub transport credentials.");
  const databasePath = resolve(
    environment.INVESTIGATION_DATABASE_PATH ?? ".data/investigation.sqlite",
  );
  const authDatabasePath = resolve(
    environment.INVESTIGATION_AUTH_DATABASE_PATH ?? ".data/investigation-auth.sqlite",
  );
  if (databasePath === authDatabasePath)
    throw new Error("Investigation and authentication must use separate database files.");
  return {
    host,
    port,
    databasePath,
    authDatabasePath,
    dashboardDirectory: resolve(
      environment.INVESTIGATION_DASHBOARD_DIRECTORY ??
        fileURLToPath(new URL("../../../dashboard/dist/", import.meta.url)),
    ),
    auth,
    oidc,
    operators,
    workers,
    https,
    enableExternalWrites,
    executionBindingsPath:
      environment.INVESTIGATION_EXECUTION_BINDINGS_PATH === undefined
        ? undefined
        : resolve(
            exact(
              environment.INVESTIGATION_EXECUTION_BINDINGS_PATH,
              "INVESTIGATION_EXECUTION_BINDINGS_PATH",
            ),
          ),
    sourceImportMaximumBytes: integer(
      environment,
      "INVESTIGATION_SOURCE_IMPORT_MAXIMUM_BYTES",
      16 * 1024 * 1024,
      128 * 1024 * 1024,
    ),
    sourceImportMaximumPages: integer(
      environment,
      "INVESTIGATION_SOURCE_IMPORT_MAXIMUM_PAGES",
      1000,
      10000,
    ),
    github:
      githubToken === undefined
        ? undefined
        : {
            token: githubToken,
            expectedGitHubUserId: integer(
              environment,
              "INVESTIGATION_GITHUB_USER_ID",
              0,
              Number.MAX_SAFE_INTEGER,
            ),
          },
  };
}
