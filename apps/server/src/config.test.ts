import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    expect(config.dashboardDirectory).toBeUndefined();
    expect(config.databasePath).toBe(
      resolve(dirname(config.artifactStorage.rootPath), ".data", "agentic-review.db"),
    );
    expect(config.artifactStorage).toEqual({
      rootPath: resolve(dirname(dirname(config.databasePath)), "artifacts"),
      capacity: {
        hardBytes: 10n * 1_024n * 1_024n * 1_024n,
        hardEntries: 100_000,
        emergencyReserveBytes: 1_024n * 1_024n * 1_024n,
        perUploadMetadataHeadroomBytes: 64n * 1_024n,
        cleanupBacklogHighWaterEntries: 1_024,
      },
    });
  });

  it("loads bounded artifact capacity without converting byte values through Number", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "database", "server.sqlite");
    const artifactRoot = join(directory, "artifact-root");
    const config = loadConfig({
      ...developmentEnvironment(),
      AGENTIC_REVIEW_DATABASE_PATH: databasePath,
      AGENTIC_REVIEW_ARTIFACT_ROOT: artifactRoot,
      AGENTIC_REVIEW_ARTIFACT_HARD_BYTES: "1099511627776",
      AGENTIC_REVIEW_ARTIFACT_HARD_ENTRIES: "1000000",
      AGENTIC_REVIEW_ARTIFACT_EMERGENCY_RESERVE_BYTES: "1073741824",
      AGENTIC_REVIEW_ARTIFACT_PER_UPLOAD_METADATA_HEADROOM_BYTES: "1048576",
      AGENTIC_REVIEW_ARTIFACT_CLEANUP_BACKLOG_HIGH_WATER_ENTRIES: "4096",
    });

    expect(config.artifactStorage).toEqual({
      rootPath: artifactRoot,
      capacity: {
        hardBytes: 1_099_511_627_776n,
        hardEntries: 1_000_000,
        emergencyReserveBytes: 1_073_741_824n,
        perUploadMetadataHeadroomBytes: 1_048_576n,
        cleanupBacklogHighWaterEntries: 4_096,
      },
    });

    const minimumEntries = loadConfig({
      ...developmentEnvironment(),
      AGENTIC_REVIEW_DATABASE_PATH: databasePath,
      AGENTIC_REVIEW_ARTIFACT_ROOT: artifactRoot,
      AGENTIC_REVIEW_ARTIFACT_HARD_ENTRIES: "7",
      AGENTIC_REVIEW_ARTIFACT_CLEANUP_BACKLOG_HIGH_WATER_ENTRIES: "1",
    });
    expect(minimumEntries.artifactStorage.capacity.hardEntries).toBe(7);
  });

  it("rejects unsafe artifact paths, malformed bytes, and inconsistent capacity", async () => {
    const directory = await temporaryDirectory();
    const base = {
      ...developmentEnvironment(),
      AGENTIC_REVIEW_DATABASE_PATH: join(directory, "database", "server.sqlite"),
      AGENTIC_REVIEW_ARTIFACT_ROOT: join(directory, "artifacts"),
    };
    const invalid: NodeJS.ProcessEnv[] = [
      {
        ...developmentEnvironment(),
        AGENTIC_REVIEW_DATABASE_PATH: join(directory, "database", "server.sqlite"),
      },
      { ...base, AGENTIC_REVIEW_ARTIFACT_ROOT: "relative/artifacts" },
      { ...base, AGENTIC_REVIEW_ARTIFACT_HARD_BYTES: "10000000junk" },
      { ...base, AGENTIC_REVIEW_ARTIFACT_HARD_BYTES: "1099511627777" },
      {
        ...base,
        AGENTIC_REVIEW_ARTIFACT_HARD_BYTES: "1073741824",
        AGENTIC_REVIEW_ARTIFACT_EMERGENCY_RESERVE_BYTES: "1073741824",
      },
      { ...base, AGENTIC_REVIEW_ARTIFACT_HARD_ENTRIES: "6" },
      {
        ...base,
        AGENTIC_REVIEW_ARTIFACT_HARD_ENTRIES: "100",
        AGENTIC_REVIEW_ARTIFACT_CLEANUP_BACKLOG_HIGH_WATER_ENTRIES: "101",
      },
      {
        ...base,
        AGENTIC_REVIEW_ARTIFACT_PER_UPLOAD_METADATA_HEADROOM_BYTES: "1048577",
      },
      {
        ...base,
        AGENTIC_REVIEW_ARTIFACT_CLEANUP_BACKLOG_HIGH_WATER_ENTRIES: "4097",
      },
      {
        ...base,
        AGENTIC_REVIEW_ARTIFACT_ROOT: join(directory, "database", "server.sqlite"),
      },
      {
        ...base,
        AGENTIC_REVIEW_ARTIFACT_ROOT: join(directory, "database", "artifacts"),
      },
      {
        ...base,
        AGENTIC_REVIEW_DATABASE_PATH: join(directory, "artifacts", "database", "server.sqlite"),
      },
    ];

    for (const environment of invalid) {
      expect(() => loadConfig(environment)).toThrow();
    }
  });

  it("documents the disjoint production layout and every artifact capacity control", async () => {
    const example = await readFile(resolve(import.meta.dirname, "..", ".env.example"), "utf8");
    expect(example).toContain(
      "AGENTIC_REVIEW_DATABASE_PATH=/var/lib/agentic-review/database/agentic-review.db",
    );
    expect(example).toContain("AGENTIC_REVIEW_ARTIFACT_ROOT=/var/lib/agentic-review/artifacts");
    for (const name of [
      "AGENTIC_REVIEW_ARTIFACT_HARD_BYTES",
      "AGENTIC_REVIEW_ARTIFACT_HARD_ENTRIES",
      "AGENTIC_REVIEW_ARTIFACT_EMERGENCY_RESERVE_BYTES",
      "AGENTIC_REVIEW_ARTIFACT_PER_UPLOAD_METADATA_HEADROOM_BYTES",
      "AGENTIC_REVIEW_ARTIFACT_CLEANUP_BACKLOG_HIGH_WATER_ENTRIES",
    ]) {
      expect(example).toContain(`${name}=`);
    }
    expect(example).toContain("Neither tree may equal or");
    expect(example).toContain("AGENTIC_REVIEW_ALLOW_INSECURE_HTTP=true");
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
    await Promise.all([writeFile(keyPath, "key", "utf8"), writeFile(certPath, "cert", "utf8")]);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        AGENTIC_REVIEW_HOST: "0.0.0.0",
        AGENTIC_REVIEW_TLS_KEY_PATH: keyPath,
        AGENTIC_REVIEW_TLS_CERT_PATH: certPath,
      }),
    ).toThrow(/OPERATOR_AUTH_MODE=oidc/u);
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
