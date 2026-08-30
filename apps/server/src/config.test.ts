import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../dist/config.js";

const temporaryDirectories: string[] = [];

const developmentEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "development",
  AGENTIC_REVIEW_HOST: "127.0.0.1",
  AGENTIC_REVIEW_ALLOW_INSECURE_WORKER_AUTH: "true",
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
    expect(config.dashboardDirectory).toBeUndefined();
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

  it("loads an explicit loopback-only development operator bypass", () => {
    const config = loadConfig({
      ...developmentEnvironment(),
      AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback-development-bypass",
      AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
      AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "developer-1",
    });

    expect(config.operatorAuth).toMatchObject({
      service: {
        mode: "loopback-development-bypass",
        publicOrigin: "http://127.0.0.1:8080",
        developmentIdentity: { subject: "developer-1" },
      },
      oidc: undefined,
    });
  });

  it("requires OIDC operator authentication in production", async () => {
    const directory = await temporaryDirectory();
    const keyPath = join(directory, "server.key");
    const certPath = join(directory, "server.crt");
    const caPath = join(directory, "worker-ca.crt");
    await Promise.all([
      writeFile(keyPath, "key", "utf8"),
      writeFile(certPath, "cert", "utf8"),
      writeFile(caPath, "ca", "utf8"),
    ]);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENTIC_REVIEW_HOST: "0.0.0.0",
        AGENTIC_REVIEW_TLS_KEY_PATH: keyPath,
        AGENTIC_REVIEW_TLS_CERT_PATH: certPath,
        AGENTIC_REVIEW_TLS_CLIENT_CA_PATH: caPath,
        AGENTIC_REVIEW_WORKER_CERTIFICATE_BINDINGS_JSON: `{"${"a".repeat(64)}":"worker-1"}`,
      }),
    ).toThrow(/OPERATOR_AUTH_MODE=oidc/u);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
