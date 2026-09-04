import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../dist/config.js";

const temporaryDirectories: string[] = [];

const developmentEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "development",
  AGENTIC_REVIEW_HOST: "127.0.0.1",
  AGENTIC_REVIEW_ALLOW_INSECURE_HTTP: "true",
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("loadConfig Phase 1 integrations", () => {
  it("keeps GitHub and operator endpoints disabled when development does not configure them", () => {
    const config = loadConfig(developmentEnvironment());
    expect(config.github).toBeUndefined();
    expect(config.operatorAuth).toBeUndefined();
    expect(config.recoveryMaintenance).toBe(false);
    expect(config.dashboardDirectory).toBeUndefined();
    expect(config.databasePath).toMatch(/[\\/]\.data[\\/]agentic-review\.db$/u);
  });

  it("documents the production database layout and operator modes", async () => {
    const example = await readFile(resolve(import.meta.dirname, "..", ".env.example"), "utf8");
    expect(example).toContain(
      "AGENTIC_REVIEW_DATABASE_PATH=/var/lib/agentic-review/database/agentic-review.db",
    );
    expect(example).toContain("AGENTIC_REVIEW_ALLOW_INSECURE_HTTP=true");
    expect(example).toContain("AGENTIC_REVIEW_OPERATOR_AUTH_MODE=loopback");
    expect(example).toContain("AGENTIC_REVIEW_RECOVERY_MAINTENANCE=false");
    expect(example).not.toContain("AGENTIC_REVIEW_TLS_CLIENT_CA_PATH");
    expect(example).not.toContain("AGENTIC_REVIEW_WORKER_CERTIFICATE_BINDINGS_JSON");
    expect(example).not.toContain("AGENTIC_REVIEW_ALLOW_INSECURE_WORKER_AUTH");
  });

  it("rejects integer settings with trailing text or values outside their purpose limit", () => {
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_PORT: "8080junk",
      }),
    ).toThrow(/base-10 integer/u);
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_PORT: "65536",
      }),
    ).toThrow(/65535/u);
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_OPERATOR_AUTH_CLEANUP_BATCH_SIZE: "10001",
      }),
    ).toThrow(/10000/u);
  });

  it("loads repository and actor IDs separately from display logins", async () => {
    const directory = await temporaryDirectory();
    const webhookSecretPath = join(directory, "webhook-secret");
    await writeFile(webhookSecretPath, "webhook-secret", "utf8");
    const promptDirectory = join(directory, "trusted-prompts");
    const config = loadConfig({
      ...developmentEnvironment(),
      AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH: webhookSecretPath,
      AGENTIC_REVIEW_GITHUB_TARGET_USER_ID: "1001",
      AGENTIC_REVIEW_GITHUB_TARGET_LOGIN: "reviewer-login",
      AGENTIC_REVIEW_GITHUB_ALLOWED_ACTOR_IDS_JSON: "[1001,2002]",
      AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON:
        '[{"githubRepositoryId":123,"fullName":"microsoft/PowerToys"}]',
      AGENTIC_REVIEW_PROMPT_DIRECTORY: promptDirectory,
    });

    expect(config.github).toMatchObject({
      repositories: [{ githubRepositoryId: 123, fullName: "microsoft/PowerToys" }],
      reviewer: { githubUserId: 1001, login: "reviewer-login" },
      authorizationPolicy: {
        schedulingTargetGithubUserId: 1001,
        allowlistedActorGithubUserIds: [1001, 2002],
      },
      promptDirectory,
      webhook: { path: "/api/v1/github/webhook" },
    });
  });

  it("rejects a relative trusted prompt directory", async () => {
    const directory = await temporaryDirectory();
    const webhookSecretPath = join(directory, "webhook-secret");
    await writeFile(webhookSecretPath, "webhook-secret", "utf8");

    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH: webhookSecretPath,
        AGENTIC_REVIEW_GITHUB_TARGET_USER_ID: "1001",
        AGENTIC_REVIEW_GITHUB_TARGET_LOGIN: "reviewer",
        AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON:
          '[{"githubRepositoryId":123,"fullName":"microsoft/PowerToys"}]',
        AGENTIC_REVIEW_PROMPT_DIRECTORY: "config/prompts",
      }),
    ).toThrow(/absolute path/u);
  });

  it("loads explicit loopback operator authentication", () => {
    const config = loadConfig({
      ...developmentEnvironment(),
      AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
      AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
      AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "developer-1",
    });

    expect(config.operatorAuth).toMatchObject({
      service: {
        mode: "loopback",
        publicOrigin: "http://127.0.0.1:8080",
        developmentIdentity: { subject: "developer-1" },
      },
      oidc: undefined,
    });
  });

  it("loads recovery maintenance only from a canonical boolean with loopback operator auth", () => {
    const operatorEnvironment = {
      ...developmentEnvironment(),
      AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
      AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
      AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "recovery-operator",
    } satisfies NodeJS.ProcessEnv;

    expect(
      loadConfig({
        ...operatorEnvironment,
        AGENTIC_REVIEW_RECOVERY_MAINTENANCE: "true",
        AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH: "missing-during-maintenance",
      }),
    ).toMatchObject({
      host: "127.0.0.1",
      recoveryMaintenance: true,
      github: undefined,
      operatorAuth: { service: { mode: "loopback" } },
    });
    expect(
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_RECOVERY_MAINTENANCE: "false",
      }).recoveryMaintenance,
    ).toBe(false);

    for (const value of ["", " ", " true ", "false ", "1", "0", "TRUE", "yes"]) {
      expect(() =>
        loadConfig({
          ...operatorEnvironment,
          AGENTIC_REVIEW_RECOVERY_MAINTENANCE: value,
        }),
      ).toThrow(/must be true or false/u);
    }
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_RECOVERY_MAINTENANCE: "true",
      }),
    ).toThrow(/configured operator authentication/u);
    expect(() =>
      loadConfig({
        ...operatorEnvironment,
        AGENTIC_REVIEW_HOST: "0.0.0.0",
        AGENTIC_REVIEW_RECOVERY_MAINTENANCE: "true",
      }),
    ).toThrow(/loopback server listener/u);
  });

  it("requires an explicit operator authentication mode in production", async () => {
    const directory = await temporaryDirectory();
    const keyPath = join(directory, "server.key");
    const certPath = join(directory, "server.crt");
    await Promise.all([writeFile(keyPath, "key", "utf8"), writeFile(certPath, "cert", "utf8")]);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENTIC_REVIEW_HOST: "0.0.0.0",
        AGENTIC_REVIEW_TLS_KEY_PATH: keyPath,
        AGENTIC_REVIEW_TLS_CERT_PATH: certPath,
      }),
    ).toThrow(/explicitly set to oidc or loopback/u);
  });

  it("allows loopback mode in production only when listener and public origin are loopback", async () => {
    const directory = await temporaryDirectory();
    const keyPath = join(directory, "server.key");
    const certPath = join(directory, "server.crt");
    await Promise.all([writeFile(keyPath, "key", "utf8"), writeFile(certPath, "cert", "utf8")]);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENTIC_REVIEW_HOST: "127.0.0.1",
        AGENTIC_REVIEW_TLS_KEY_PATH: keyPath,
        AGENTIC_REVIEW_TLS_CERT_PATH: certPath,
        AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
        AGENTIC_REVIEW_PUBLIC_ORIGIN: "https://127.0.0.1:8080",
        AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "production-loopback",
      }),
    ).not.toThrow();

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENTIC_REVIEW_HOST: "0.0.0.0",
        AGENTIC_REVIEW_TLS_KEY_PATH: keyPath,
        AGENTIC_REVIEW_TLS_CERT_PATH: certPath,
        AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
        AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
        AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "production-loopback",
      }),
    ).toThrow(/loopback server listener/u);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENTIC_REVIEW_HOST: "127.0.0.1",
        AGENTIC_REVIEW_TLS_KEY_PATH: keyPath,
        AGENTIC_REVIEW_TLS_CERT_PATH: certPath,
        AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
        AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
        AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "production-loopback",
      }),
    ).toThrow(/HTTPS public origin/u);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENTIC_REVIEW_HOST: "127.0.0.1",
        AGENTIC_REVIEW_TLS_KEY_PATH: keyPath,
        AGENTIC_REVIEW_TLS_CERT_PATH: certPath,
        AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
        AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://operator.example.com:8080",
        AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "production-loopback",
      }),
    ).toThrow(/loopback public origin/u);
  });

  it("requires explicit loopback development HTTP and never configures client TLS", async () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        AGENTIC_REVIEW_HOST: "127.0.0.1",
      }),
    ).toThrow(/ALLOW_INSECURE_HTTP=true/u);
    expect(() =>
      loadConfig({
        NODE_ENV: "development",
        AGENTIC_REVIEW_HOST: "0.0.0.0",
        AGENTIC_REVIEW_ALLOW_INSECURE_HTTP: "true",
      }),
    ).toThrow(/loopback/u);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENTIC_REVIEW_HOST: "0.0.0.0",
        AGENTIC_REVIEW_ALLOW_INSECURE_HTTP: "true",
      }),
    ).toThrow(/cannot be enabled in production/u);

    const directory = await temporaryDirectory();
    const keyPath = join(directory, "server.key");
    const certPath = join(directory, "server.crt");
    await Promise.all([writeFile(keyPath, "key", "utf8"), writeFile(certPath, "cert", "utf8")]);
    const config = loadConfig({
      NODE_ENV: "development",
      AGENTIC_REVIEW_HOST: "0.0.0.0",
      AGENTIC_REVIEW_TLS_KEY_PATH: keyPath,
      AGENTIC_REVIEW_TLS_CERT_PATH: certPath,
    });
    expect(config.allowInsecureHttp).toBe(false);
    expect(config.tls).toMatchObject({ minVersion: "TLSv1.2" });
    expect(config.tls).not.toHaveProperty("ca");
    expect(config.tls).not.toHaveProperty("requestCert");
    expect(config.tls).not.toHaveProperty("rejectUnauthorized");
  });

  it.each([
    "AGENTIC_REVIEW_TLS_CLIENT_CA_PATH",
    "AGENTIC_REVIEW_WORKER_CERTIFICATE_BINDINGS_JSON",
    "AGENTIC_REVIEW_ALLOW_INSECURE_WORKER_AUTH",
  ])("rejects the legacy Worker mTLS setting %s", (name) => {
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        [name]: "legacy-value",
      }),
    ).toThrow(/no longer supported by Worker Token authentication/u);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
