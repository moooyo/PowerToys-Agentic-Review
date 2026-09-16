import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EntityIdSchema,
  InvestigationNewPasswordSchema,
  InvestigationUsernameInputSchema,
  normalizeInvestigationUsername,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  defaultInvestigationEvidencePolicy,
  type InvestigationEvidencePolicy,
} from "./evidence-store.js";
import type { InvestigationWorkerPrincipal } from "./types.js";

export interface InvestigationWorkerCredential extends InvestigationWorkerPrincipal {
  readonly token: string;
}

export interface InvestigationPasswordRuntimeConfig {
  readonly mode: "password";
  readonly publicOrigin: string;
  readonly sessionTtlSeconds: number;
  readonly maxKdfConcurrency: number;
  readonly maxKdfQueue: number;
  readonly loginIpLimit: number;
  readonly loginAccountLimit: number;
  readonly loginWindowSeconds: number;
  readonly bootstrapAdmin: { username: string; password: string; displayName: string } | undefined;
}

export interface InvestigationRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly authDatabasePath: string;
  readonly dashboardDirectory: string;
  readonly auth: InvestigationPasswordRuntimeConfig;
  readonly workers: readonly InvestigationWorkerCredential[];
  readonly https: { key: string; cert: string; passphrase?: string } | undefined;
  readonly github: { token: string; expectedGitHubUserId: number } | undefined;
  readonly enableExternalWrites: boolean;
  readonly executionBindingsPath: string | undefined;
  readonly sourceImportMaximumBytes: number;
  readonly sourceImportMaximumPages: number;
  readonly evidencePolicy: InvestigationEvidencePolicy;
}

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

function passwordSecret(environment: Environment, name: string): string | undefined {
  const inline = environment[name];
  const path = environment[`${name}_PATH`];
  if (inline !== undefined && path !== undefined)
    throw new Error(`Configure only ${name} or ${name}_PATH.`);
  // Password bytes remain verbatim, including whitespace supplied through a protected file.
  const password = path === undefined ? inline : readFileSync(exact(path, `${name}_PATH`), "utf8");
  if (password !== undefined && !Value.Check(InvestigationNewPasswordSchema, password)) {
    throw new Error(
      `${name} must contain 15 to 128 characters, including a non-whitespace character.`,
    );
  }
  return password;
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

export function loadInvestigationRuntimeConfig(
  environment: Environment = process.env,
): InvestigationRuntimeConfig {
  const host = exact(environment.INVESTIGATION_HOST ?? "127.0.0.1", "INVESTIGATION_HOST");
  const port = integer(environment, "INVESTIGATION_PORT", 8000, 65535);
  if ((environment.INVESTIGATION_AUTH_MODE ?? "password") !== "password") {
    throw new Error("INVESTIGATION_AUTH_MODE only supports password authentication.");
  }
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
  if (publicOrigin.protocol === "http:") {
    if (
      host !== "127.0.0.1" ||
      publicOrigin.hostname !== "127.0.0.1" ||
      https !== undefined ||
      Number(publicOrigin.port || "80") !== port
    ) {
      throw new Error(
        "HTTP password authentication requires the literal 127.0.0.1 listener and matching local public origin.",
      );
    }
  } else if (publicOrigin.protocol !== "https:") {
    throw new Error("Password authentication requires an HTTP(S) public origin.");
  }
  if (host !== "127.0.0.1" && https === undefined)
    throw new Error(
      "A non-loopback listener requires TLS; use loopback behind an HTTPS reverse proxy.",
    );
  if (https !== undefined && publicOrigin.protocol !== "https:")
    throw new Error("TLS requires an HTTPS public origin.");

  const bootstrapUsername = environment.INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME;
  const bootstrapPassword = passwordSecret(environment, "INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD");
  const bootstrapDisplayName = environment.INVESTIGATION_BOOTSTRAP_ADMIN_DISPLAY_NAME;
  if (
    (bootstrapUsername === undefined) !== (bootstrapPassword === undefined) ||
    (bootstrapDisplayName !== undefined && bootstrapUsername === undefined)
  ) {
    throw new Error("Administrator bootstrap requires a username and password together.");
  }
  if (
    bootstrapUsername !== undefined &&
    !Value.Check(InvestigationUsernameInputSchema, bootstrapUsername)
  ) {
    throw new Error(
      "The bootstrap username must normalize to 3 to 64 ASCII letters, digits, dots, underscores, or hyphens.",
    );
  }
  const username =
    bootstrapUsername === undefined ? undefined : normalizeInvestigationUsername(bootstrapUsername);
  const displayName = bootstrapDisplayName ?? username;
  if (
    displayName !== undefined &&
    (displayName.length === 0 || displayName.length > 120 || !/\S/u.test(displayName))
  ) {
    throw new Error(
      "The bootstrap display name must contain 1 to 120 characters and a non-whitespace character.",
    );
  }
  const auth: InvestigationPasswordRuntimeConfig = {
    mode: "password",
    publicOrigin: publicOrigin.origin,
    sessionTtlSeconds: integer(environment, "INVESTIGATION_SESSION_TTL_SECONDS", 28800, 86400),
    maxKdfConcurrency: integer(environment, "INVESTIGATION_PASSWORD_KDF_CONCURRENCY", 2, 4),
    maxKdfQueue: integer(environment, "INVESTIGATION_PASSWORD_KDF_QUEUE_LIMIT", 8, 64),
    loginIpLimit: integer(environment, "INVESTIGATION_LOGIN_IP_LIMIT", 30, 1000),
    loginAccountLimit: integer(environment, "INVESTIGATION_LOGIN_ACCOUNT_LIMIT", 10, 1000),
    loginWindowSeconds: integer(environment, "INVESTIGATION_LOGIN_WINDOW_SECONDS", 900, 86400),
    bootstrapAdmin:
      username === undefined || bootstrapPassword === undefined || displayName === undefined
        ? undefined
        : { username, password: bootstrapPassword, displayName },
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
    environment.INVESTIGATION_AUTH_DATABASE_PATH ?? ".data/investigation-accounts.sqlite",
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
    evidencePolicy: {
      maximumBytes: integer(
        environment,
        "INVESTIGATION_EVIDENCE_MAXIMUM_BYTES",
        defaultInvestigationEvidencePolicy.maximumBytes,
        Number.MAX_SAFE_INTEGER,
      ),
      maximumCount: integer(
        environment,
        "INVESTIGATION_EVIDENCE_MAXIMUM_COUNT",
        defaultInvestigationEvidencePolicy.maximumCount,
        10_000_000,
      ),
      retentionSeconds: integer(
        environment,
        "INVESTIGATION_EVIDENCE_RETENTION_SECONDS",
        defaultInvestigationEvidencePolicy.retentionSeconds,
        10 * 366 * 24 * 60 * 60,
      ),
      cleanupIntervalSeconds: integer(
        environment,
        "INVESTIGATION_EVIDENCE_CLEANUP_INTERVAL_SECONDS",
        defaultInvestigationEvidencePolicy.cleanupIntervalSeconds,
        86_400,
      ),
      cleanupBatchSize: integer(
        environment,
        "INVESTIGATION_EVIDENCE_CLEANUP_BATCH_SIZE",
        defaultInvestigationEvidencePolicy.cleanupBatchSize,
        1_000,
      ),
    },
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
