import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const temporaryDirectories: string[] = [];

const developmentEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "development",
  AGENTIC_REVIEW_HOST: "127.0.0.1",
  AGENTIC_REVIEW_ALLOW_INSECURE_HTTP: "true",
});

const legacyBootstrapEnvironment = (): NodeJS.ProcessEnv => ({
  AGENTIC_REVIEW_GITHUB_TARGET_USER_ID: "1001",
  AGENTIC_REVIEW_GITHUB_TARGET_LOGIN: "reviewer-login",
  AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON:
    '[{"githubRepositoryId":123,"fullName":"microsoft/PowerToys"}]',
});

const legacyBootstrapRequiredSettings = [
  "AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON",
  "AGENTIC_REVIEW_GITHUB_TARGET_USER_ID",
  "AGENTIC_REVIEW_GITHUB_TARGET_LOGIN",
] as const;

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
    expect(config.operatorAccess).toBeUndefined();
    expect(config.recoveryMaintenance).toBe(false);
    expect(config.dashboardDirectory).toBeUndefined();
    expect(config.databasePath).toMatch(/[\\/]\.data[\\/]agentic-review\.db$/u);
  });

  it.each([
    { description: "a polling token", polling: true, webhook: false },
    { description: "a webhook secret", polling: false, webhook: true },
    { description: "both transports", polling: true, webhook: true },
  ])(
    "starts managed mode with $description and no legacy bootstrap",
    async ({ polling, webhook }) => {
      const transportEnvironment = await githubTransportEnvironment();
      const config = loadConfig({
        ...developmentEnvironment(),
        ...(polling
          ? {
              AGENTIC_REVIEW_GITHUB_TOKEN_PATH:
                transportEnvironment.AGENTIC_REVIEW_GITHUB_TOKEN_PATH,
            }
          : {}),
        ...(webhook
          ? {
              AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH:
                transportEnvironment.AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH,
            }
          : {}),
      });

      expect(config.github).toStrictEqual({
        legacyBootstrap: undefined,
        promptDirectory: resolve(import.meta.dirname, "../../..", "config", "prompts"),
        polling: polling ? { token: "github-token", intervalSeconds: 60 } : undefined,
        webhook: webhook
          ? {
              path: "/api/v1/github/webhook",
              secret: Buffer.from("webhook-secret"),
              maxPayloadBytes: 2 * 1_024 * 1_024,
            }
          : undefined,
      });
    },
  );

  it("loads a complete legacy bootstrap without enabling a transport", () => {
    const config = loadConfig({
      ...developmentEnvironment(),
      ...legacyBootstrapEnvironment(),
    });

    expect(config.github).toStrictEqual({
      legacyBootstrap: {
        repositories: [{ githubRepositoryId: 123, fullName: "microsoft/PowerToys" }],
        reviewer: { githubUserId: 1001, login: "reviewer-login" },
        authorizationPolicy: {
          kind: "self_or_allowlist",
          policyVersion: 1,
          schedulingTargetGithubUserId: 1001,
          allowlistedActorGithubUserIds: [],
          unknownActorPolicy: "deny",
          newRevisionPolicy: "require_new_authorization",
        },
      },
      promptDirectory: resolve(import.meta.dirname, "../../..", "config", "prompts"),
      webhook: undefined,
      polling: undefined,
    });
  });

  it.each(legacyBootstrapRequiredSettings)(
    "requires non-empty %s alongside the other legacy bootstrap fields without a transport",
    (name) => {
      for (const value of [undefined, "", " "]) {
        expect(() =>
          loadConfig({
            ...developmentEnvironment(),
            ...legacyBootstrapEnvironment(),
            [name]: value,
          }),
        ).toThrow(/Legacy GitHub bootstrap requires .+ together\./u);
      }
    },
  );

  it.each([
    {
      name: "AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON",
      configuredValue: '[{"githubRepositoryId":123,"fullName":"microsoft/PowerToys"}]',
    },
    { name: "AGENTIC_REVIEW_GITHUB_TARGET_USER_ID", configuredValue: "1001" },
    { name: "AGENTIC_REVIEW_GITHUB_TARGET_LOGIN", configuredValue: "reviewer-login" },
    { name: "AGENTIC_REVIEW_GITHUB_ALLOWED_ACTOR_IDS_JSON", configuredValue: "[]" },
    { name: "AGENTIC_REVIEW_GITHUB_POLICY_VERSION", configuredValue: "2" },
    {
      name: "AGENTIC_REVIEW_GITHUB_NEW_REVISION_POLICY",
      configuredValue: "require_new_authorization",
    },
  ])("rejects $name alone even when it is blank", ({ name, configuredValue }) => {
    for (const value of [configuredValue, "", " "]) {
      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          [name]: value,
        }),
      ).toThrow(/Legacy GitHub bootstrap requires .+ together\./u);
    }
  });

  it("rejects partial legacy bootstrap settings when managed transports are configured", async () => {
    const transportEnvironment = await githubTransportEnvironment();
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        ...transportEnvironment,
        AGENTIC_REVIEW_GITHUB_TARGET_USER_ID: "1001",
      }),
    ).toThrow(/Legacy GitHub bootstrap requires .+ together\./u);
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
      ...legacyBootstrapEnvironment(),
      AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH: webhookSecretPath,
      AGENTIC_REVIEW_GITHUB_ALLOWED_ACTOR_IDS_JSON: "[1001,2002]",
      AGENTIC_REVIEW_PROMPT_DIRECTORY: promptDirectory,
    });

    expect(config.github).toMatchObject({
      legacyBootstrap: {
        repositories: [{ githubRepositoryId: 123, fullName: "microsoft/PowerToys" }],
        reviewer: { githubUserId: 1001, login: "reviewer-login" },
        authorizationPolicy: {
          schedulingTargetGithubUserId: 1001,
          allowlistedActorGithubUserIds: [1001, 2002],
          unknownActorPolicy: "deny",
          newRevisionPolicy: "require_new_authorization",
        },
      },
      promptDirectory,
      webhook: { path: "/api/v1/github/webhook" },
    });
  });

  it("freezes the legacy bootstrap and its nested repository and policy values", () => {
    const config = loadConfig({
      ...developmentEnvironment(),
      ...legacyBootstrapEnvironment(),
      AGENTIC_REVIEW_GITHUB_ALLOWED_ACTOR_IDS_JSON: "[1001,2002]",
      AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON: JSON.stringify([
        { githubRepositoryId: 123, fullName: "microsoft/PowerToys" },
        { githubRepositoryId: 456, fullName: "microsoft/vscode" },
      ]),
    });
    const bootstrap = config.github?.legacyBootstrap;

    expect(bootstrap).toBeDefined();
    expect(Object.isFrozen(config.github)).toBe(true);
    expect(Object.isFrozen(bootstrap)).toBe(true);
    expect(Object.isFrozen(bootstrap?.repositories)).toBe(true);
    expect(bootstrap?.repositories.every((repository) => Object.isFrozen(repository))).toBe(true);
    expect(Object.isFrozen(bootstrap?.reviewer)).toBe(true);
    expect(Object.isFrozen(bootstrap?.authorizationPolicy)).toBe(true);
    expect(Object.isFrozen(bootstrap?.authorizationPolicy.allowlistedActorGithubUserIds)).toBe(
      true,
    );
  });

  it.each(["1", "9007199254740991", " 1001 "])(
    "accepts the positive safe base-10 reviewer ID %s",
    (value) => {
      const config = loadConfig({
        ...developmentEnvironment(),
        ...legacyBootstrapEnvironment(),
        AGENTIC_REVIEW_GITHUB_TARGET_USER_ID: value,
      });

      expect(config.github?.legacyBootstrap?.reviewer.githubUserId).toBe(Number(value));
      expect(config.github?.legacyBootstrap?.authorizationPolicy.schedulingTargetGithubUserId).toBe(
        Number(value),
      );
    },
  );

  it.each([
    "0",
    "-1",
    "+1001",
    "01001",
    "1.0",
    "1e3",
    "0x3e9",
    "1001junk",
    "NaN",
    "Infinity",
    "9007199254740992",
  ])("rejects the invalid legacy reviewer ID %s", (value) => {
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        ...legacyBootstrapEnvironment(),
        AGENTIC_REVIEW_GITHUB_TARGET_USER_ID: value,
      }),
    ).toThrow(/AGENTIC_REVIEW_GITHUB_TARGET_USER_ID must be a positive/u);
  });

  it.each(["a/b", "owner/Repo.Name_1-2", "a--b/repo"])(
    "preserves the valid managed repository name %s in legacy bootstrap",
    (fullName) => {
      const config = loadConfig({
        ...developmentEnvironment(),
        ...legacyBootstrapEnvironment(),
        AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON: JSON.stringify([
          { githubRepositoryId: 123, fullName },
        ]),
      });

      expect(config.github?.legacyBootstrap?.repositories).toEqual([
        { githubRepositoryId: 123, fullName },
      ]);
    },
  );

  it.each([
    "https://github.com/microsoft/PowerToys",
    "microsoft/PowerToys/extra",
    "microsoft\\PowerToys",
    "../PowerToys",
    "microsoft/.",
    "microsoft/..",
    "micro.soft/PowerToys",
    "micro_soft/PowerToys",
    "-microsoft/PowerToys",
    "microsoft-/PowerToys",
    "microsoft/PowerToys?ref=main",
    "microsoft/PowerToys#readme",
    "microsoft/%2e%2e",
    "microsoft/Power Toys",
    " microsoft/PowerToys",
    "microsoft/PowerToys ",
    `${"a".repeat(101)}/repo`,
    `owner/${"a".repeat(101)}`,
  ])("rejects an unsafe legacy repository name %s", (fullName) => {
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        ...legacyBootstrapEnvironment(),
        AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON: JSON.stringify([
          { githubRepositoryId: 123, fullName },
        ]),
      }),
    ).toThrow(/fullName must be an owner\/name pair/u);
  });

  it("requires an explicit exact policy value to enable revision inheritance", () => {
    const environment = {
      ...developmentEnvironment(),
      ...legacyBootstrapEnvironment(),
    };

    for (const value of ["require_new_authorization", "inherit_authorized_epoch"]) {
      expect(
        loadConfig({
          ...environment,
          AGENTIC_REVIEW_GITHUB_POLICY_VERSION: "2",
          AGENTIC_REVIEW_GITHUB_NEW_REVISION_POLICY: value,
        }).github?.legacyBootstrap?.authorizationPolicy,
      ).toMatchObject({ policyVersion: 2, newRevisionPolicy: value });
    }
    for (const value of [
      "",
      " ",
      "true",
      "inherit",
      "INHERIT_AUTHORIZED_EPOCH",
      " inherit_authorized_epoch ",
    ]) {
      expect(() =>
        loadConfig({
          ...environment,
          AGENTIC_REVIEW_GITHUB_NEW_REVISION_POLICY: value,
        }),
      ).toThrow(/AGENTIC_REVIEW_GITHUB_NEW_REVISION_POLICY/u);
    }
  });

  it("loads an absolute trusted prompt directory in managed mode", async () => {
    const directory = await temporaryDirectory();
    const promptDirectory = join(directory, "trusted-prompts");
    const config = loadConfig({
      ...developmentEnvironment(),
      ...(await githubTransportEnvironment()),
      AGENTIC_REVIEW_PROMPT_DIRECTORY: promptDirectory,
    });

    expect(config.github?.legacyBootstrap).toBeUndefined();
    expect(config.github?.promptDirectory).toBe(promptDirectory);
  });

  it("rejects a relative trusted prompt directory in managed mode", async () => {
    const transportEnvironment = await githubTransportEnvironment();
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        ...transportEnvironment,
        AGENTIC_REVIEW_PROMPT_DIRECTORY: "config/prompts",
      }),
    ).toThrow(/absolute path/u);
  });

  it("loads the maximum transport limits in managed mode", async () => {
    const config = loadConfig({
      ...developmentEnvironment(),
      ...(await githubTransportEnvironment()),
      AGENTIC_REVIEW_GITHUB_WEBHOOK_PATH: "/hooks/github",
      AGENTIC_REVIEW_GITHUB_WEBHOOK_MAX_BYTES: String(25 * 1_024 * 1_024),
      AGENTIC_REVIEW_GITHUB_POLL_INTERVAL_SECONDS: "86400",
    });

    expect(config.github).toMatchObject({
      legacyBootstrap: undefined,
      webhook: { path: "/hooks/github", maxPayloadBytes: 25 * 1_024 * 1_024 },
      polling: { intervalSeconds: 86_400 },
    });
  });

  it.each([
    { name: "AGENTIC_REVIEW_GITHUB_WEBHOOK_MAX_BYTES", maximum: 25 * 1_024 * 1_024 },
    { name: "AGENTIC_REVIEW_GITHUB_POLL_INTERVAL_SECONDS", maximum: 86_400 },
  ])("enforces the managed-mode transport limit for $name", async ({ name, maximum }) => {
    const transportEnvironment = await githubTransportEnvironment();

    for (const value of ["0", "-1", "1.5", "1e3", "10junk", String(maximum + 1)]) {
      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          ...transportEnvironment,
          [name]: value,
        }),
      ).toThrow(name);
    }
  });

  it.each(["AGENTIC_REVIEW_GITHUB_TOKEN_PATH", "AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH"])(
    "rejects an unreadable managed-mode secret at %s",
    async (name) => {
      const directory = await temporaryDirectory();

      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          [name]: join(directory, "missing-secret"),
        }),
      ).toThrow(`Unable to read ${name}`);
    },
  );

  it.each(["", " \r\n", "github-token\u0000suffix"])(
    "rejects an empty, blank, or NUL-containing managed-mode polling token %j",
    async (contents) => {
      const directory = await temporaryDirectory();
      const tokenPath = join(directory, "github-token");
      await writeFile(tokenPath, contents, "utf8");

      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          AGENTIC_REVIEW_GITHUB_TOKEN_PATH: tokenPath,
        }),
      ).toThrow(/AGENTIC_REVIEW_GITHUB_TOKEN_PATH must contain non-empty UTF-8 text without NUL/u);
    },
  );

  it("rejects an empty managed-mode webhook secret during configuration", async () => {
    const directory = await temporaryDirectory();
    const webhookSecretPath = join(directory, "webhook-secret");
    await writeFile(webhookSecretPath, "", "utf8");

    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH: webhookSecretPath,
      }),
    ).toThrow(/AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH must contain a non-empty secret/u);
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

  it("skips missing secrets and invalid GitHub configuration during recovery maintenance", async () => {
    const directory = await temporaryDirectory();
    const missingSecretPath = join(directory, "missing-secret");
    const invalidGitHubEnvironments: NodeJS.ProcessEnv[] = [
      {
        AGENTIC_REVIEW_GITHUB_TOKEN_PATH: missingSecretPath,
        AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH: missingSecretPath,
      },
      { AGENTIC_REVIEW_GITHUB_TARGET_USER_ID: "invalid-reviewer" },
      { AGENTIC_REVIEW_GITHUB_POLICY_VERSION: "" },
      {
        ...legacyBootstrapEnvironment(),
        AGENTIC_REVIEW_GITHUB_TARGET_USER_ID: "1e3",
        AGENTIC_REVIEW_GITHUB_REPOSITORIES_JSON: "invalid-json",
        AGENTIC_REVIEW_GITHUB_NEW_REVISION_POLICY: "inherit",
      },
      {
        AGENTIC_REVIEW_GITHUB_TOKEN_PATH: missingSecretPath,
        AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH: missingSecretPath,
        AGENTIC_REVIEW_GITHUB_POLL_INTERVAL_SECONDS: "0",
        AGENTIC_REVIEW_GITHUB_WEBHOOK_MAX_BYTES: "invalid-size",
        AGENTIC_REVIEW_PROMPT_DIRECTORY: "relative/prompts",
      },
    ];

    for (const githubEnvironment of invalidGitHubEnvironments) {
      const config = loadConfig({
        ...developmentEnvironment(),
        ...githubEnvironment,
        AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
        AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
        AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "recovery-operator",
        AGENTIC_REVIEW_RECOVERY_MAINTENANCE: "true",
      });

      expect(config.github).toBeUndefined();
      expect(config.recoveryMaintenance).toBe(true);
      expect(config.operatorAuth?.service.mode).toBe("loopback");
    }
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

describe("loadConfig evidence storage", () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const dayMilliseconds = 24 * 60 * 60 * 1_000;
  const numericSettings = [
    {
      name: "AGENTIC_REVIEW_EVIDENCE_GLOBAL_QUOTA_BYTES",
      property: "globalQuotaBytes",
      maximum: 1_024 ** 4,
    },
    {
      name: "AGENTIC_REVIEW_EVIDENCE_GLOBAL_ASSET_LIMIT",
      property: "globalAssetLimit",
      maximum: 1_000_000,
    },
    {
      name: "AGENTIC_REVIEW_EVIDENCE_RETENTION_MS",
      property: "retentionMs",
      maximum: 365 * dayMilliseconds,
    },
    {
      name: "AGENTIC_REVIEW_EVIDENCE_INCOMPLETE_UPLOAD_TTL_MS",
      property: "incompleteUploadTtlMs",
      maximum: 7 * dayMilliseconds,
    },
  ] as const;

  it("provides frozen evidence defaults outside the private database directory", () => {
    const config = loadConfig(developmentEnvironment());

    expect(config.evidenceStorage).toStrictEqual({
      evidenceDirectory: resolve(repositoryRoot, ".evidence"),
      globalQuotaBytes: 10 * 1_024 ** 3,
      globalAssetLimit: 10_000,
      retentionMs: 7 * dayMilliseconds,
      incompleteUploadTtlMs: dayMilliseconds,
    });
    expect(Object.isFrozen(config.evidenceStorage)).toBe(true);
    expect(
      Reflect.set(config.evidenceStorage as object, "evidenceDirectory", resolve(repositoryRoot)),
    ).toBe(false);
  });

  it("normalizes an explicit evidence directory without requiring it to exist", () => {
    const environment = {
      ...developmentEnvironment(),
      AGENTIC_REVIEW_EVIDENCE_DIRECTORY: `${repositoryRoot}${sep}external-evidence${sep}..${sep}evidence-assets${sep}`,
      AGENTIC_REVIEW_EVIDENCE_GLOBAL_QUOTA_BYTES: "1024",
      AGENTIC_REVIEW_EVIDENCE_GLOBAL_ASSET_LIMIT: "12",
      AGENTIC_REVIEW_EVIDENCE_RETENTION_MS: "60000",
      AGENTIC_REVIEW_EVIDENCE_INCOMPLETE_UPLOAD_TTL_MS: "1000",
    };
    const config = loadConfig(environment);
    environment.AGENTIC_REVIEW_EVIDENCE_GLOBAL_ASSET_LIMIT = "99";
    environment.AGENTIC_REVIEW_EVIDENCE_DIRECTORY = resolve(repositoryRoot, "different-assets");

    expect(config.evidenceStorage).toStrictEqual({
      evidenceDirectory: resolve(repositoryRoot, "evidence-assets"),
      globalQuotaBytes: 1024,
      globalAssetLimit: 12,
      retentionMs: 60000,
      incompleteUploadTtlMs: 1000,
    });
  });

  it.each(["", " "])("uses the default evidence directory for a blank setting %j", (value) => {
    expect(
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_EVIDENCE_DIRECTORY: value,
      }).evidenceStorage?.evidenceDirectory,
    ).toBe(resolve(repositoryRoot, ".evidence"));
  });

  it.each(["evidence", "./evidence", "../evidence"])(
    "rejects relative evidence directory %j",
    (value) => {
      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          AGENTIC_REVIEW_EVIDENCE_DIRECTORY: value,
        }),
      ).toThrow(/AGENTIC_REVIEW_EVIDENCE_DIRECTORY must be an absolute path/u);
    },
  );

  it("rejects a NUL-bearing evidence directory", () => {
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_EVIDENCE_DIRECTORY: `${resolve(repositoryRoot, "evidence")}\u0000suffix`,
      }),
    ).toThrow(/without NUL/u);
  });

  it("rejects the filesystem root, including a normalized path to it", () => {
    const root = parse(repositoryRoot).root;
    for (const directory of [root, `${root}evidence${sep}..`]) {
      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          AGENTIC_REVIEW_EVIDENCE_DIRECTORY: directory,
        }),
      ).toThrow(/must not be a filesystem root/u);
    }
  });

  it("rejects the private database parent and all normalized descendants", () => {
    const databaseDirectory = resolve(repositoryRoot, "private-database");
    for (const directory of [
      databaseDirectory,
      `${databaseDirectory}${sep}`,
      join(databaseDirectory, "evidence"),
      `${databaseDirectory}${sep}..${sep}private-database${sep}nested${sep}evidence`,
    ]) {
      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          AGENTIC_REVIEW_DATABASE_PATH: join(databaseDirectory, "server.db"),
          AGENTIC_REVIEW_EVIDENCE_DIRECTORY: directory,
        }),
      ).toThrow(/outside the private SQLite parent directory/u);
    }
  });

  it("validates the default evidence directory against a custom database parent", () => {
    expect(() =>
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_DATABASE_PATH: join(repositoryRoot, "server.db"),
      }),
    ).toThrow(/outside the private SQLite parent directory/u);
  });

  it("allows sibling directories whose names share the database directory prefix", () => {
    const databaseDirectory = resolve(repositoryRoot, "private-database");
    const evidenceDirectory = `${databaseDirectory}-evidence`;

    expect(
      loadConfig({
        ...developmentEnvironment(),
        AGENTIC_REVIEW_DATABASE_PATH: join(databaseDirectory, "server.db"),
        AGENTIC_REVIEW_EVIDENCE_DIRECTORY: evidenceDirectory,
      }).evidenceStorage?.evidenceDirectory,
    ).toBe(evidenceDirectory);
  });

  it.runIf(process.platform === "win32")(
    "rejects Windows UNC roots and case aliases inside SQLite",
    () => {
      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          AGENTIC_REVIEW_EVIDENCE_DIRECTORY: "\\\\evidence-host\\evidence-share\\",
        }),
      ).toThrow(/must not be a filesystem root/u);
      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          AGENTIC_REVIEW_DATABASE_PATH: "C:\\PRIVATE-DATABASE\\server.db",
          AGENTIC_REVIEW_EVIDENCE_DIRECTORY: "c:\\private-database\\evidence",
        }),
      ).toThrow(/outside the private SQLite parent directory/u);
    },
  );

  it.each(numericSettings)("accepts the bounds for $name", ({ name, property, maximum }) => {
    for (const value of [1, maximum]) {
      expect(
        loadConfig({ ...developmentEnvironment(), [name]: String(value) }).evidenceStorage?.[
          property
        ],
      ).toBe(value);
    }
  });

  it.each(numericSettings)("rejects invalid values for $name", ({ name, maximum }) => {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "1e3",
      "10junk",
      "Infinity",
      String(maximum + 1),
      "9007199254740992",
    ]) {
      expect(() => loadConfig({ ...developmentEnvironment(), [name]: value })).toThrow(name);
    }
  });

  it("retains evidence options in recovery maintenance without enabling GitHub ingestion", () => {
    const config = loadConfig({
      ...developmentEnvironment(),
      AGENTIC_REVIEW_RECOVERY_MAINTENANCE: "true",
      AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
      AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
      AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "recovery-operator",
      AGENTIC_REVIEW_EVIDENCE_GLOBAL_ASSET_LIMIT: "500",
    });

    expect(config.recoveryMaintenance).toBe(true);
    expect(config.github).toBeUndefined();
    expect(config.evidenceStorage).toMatchObject({
      evidenceDirectory: resolve(repositoryRoot, ".evidence"),
      globalAssetLimit: 500,
    });
  });
});

describe("loadConfig trusted operator administrators", () => {
  it("grants platform administration only to the exact configured OIDC subset", async () => {
    const environment = await oidcEnvironment();
    environment.AGENTIC_REVIEW_OIDC_AUTHORIZED_SUBJECTS_JSON = '["viewer","Admin","admin"]';
    environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON = '["Admin","admin"]';
    environment.AGENTIC_REVIEW_OIDC_ISSUER_URL = "https://LOGIN.example.com:443/Tenant/v2.0/";
    const config = loadConfig(environment);
    expect(config.operatorAccess).toStrictEqual({
      administrators: [
        { issuer: "https://LOGIN.example.com:443/Tenant/v2.0/", subject: "Admin" },
        { issuer: "https://LOGIN.example.com:443/Tenant/v2.0/", subject: "admin" },
      ],
    });
    expect(config.operatorAuth?.oidc?.issuerUrl).toBe(environment.AGENTIC_REVIEW_OIDC_ISSUER_URL);
    expect(
      config.operatorAccess?.administrators.some((principal) => principal.subject === "viewer"),
    ).toBe(false);
    expect(Object.isFrozen(config.operatorAccess)).toBe(true);
    expect(Object.isFrozen(config.operatorAccess?.administrators)).toBe(true);
    expect(
      config.operatorAccess?.administrators.every((principal) => Object.isFrozen(principal)),
    ).toBe(true);
    environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON = '["viewer"]';
    environment.AGENTIC_REVIEW_OIDC_ISSUER_URL = "https://different.example.com";
    const administrator = config.operatorAccess?.administrators[0];
    expect(administrator).toBeDefined();
    expect(Reflect.set(administrator as object, "subject", "viewer")).toBe(false);
    expect(config.operatorAccess?.administrators[0]?.subject).toBe("Admin");
  });

  it.each([
    undefined,
    "",
    " ",
    "not-json",
    "null",
    "{}",
    "[]",
    '[""]',
    '[" admin"]',
    '["admin "]',
    '["admin","admin"]',
    "[1]",
    '["admin\\u0000suffix"]',
    '["\\ud800"]',
  ])("rejects missing or invalid administrator JSON %j", async (value) => {
    const environment = await oidcEnvironment();
    if (value === undefined) delete environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON;
    else environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON = value;
    expect(() => loadConfig(environment)).toThrow("AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON");
  });

  it.each(["unknown", "ADMIN", "Admin"])(
    "rejects unknown or differently cased admin subject %s",
    async (subject) => {
      const environment = await oidcEnvironment();
      environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON = JSON.stringify([subject]);
      expect(() => loadConfig(environment)).toThrow(/exact, case-sensitive subset/u);
    },
  );

  it("does not silently trim login subjects to make an administrator match", async () => {
    const environment = await oidcEnvironment();
    environment.AGENTIC_REVIEW_OIDC_AUTHORIZED_SUBJECTS_JSON = '["admin "]';
    expect(() => loadConfig(environment)).toThrow("AGENTIC_REVIEW_OIDC_AUTHORIZED_SUBJECTS_JSON");
  });

  it("bounds the administrator set to 1024 exact identities", async () => {
    const environment = await oidcEnvironment();
    const subjects = Array.from({ length: 1_024 }, (_, index) => `subject-${index}`);
    environment.AGENTIC_REVIEW_OIDC_AUTHORIZED_SUBJECTS_JSON = JSON.stringify(subjects);
    environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON = JSON.stringify(subjects);
    expect(loadConfig(environment).operatorAccess?.administrators).toHaveLength(1_024);
    environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON = JSON.stringify([...subjects, "overflow"]);
    expect(() => loadConfig(environment)).toThrow(
      /ADMIN_SUBJECTS_JSON must contain 1 through 1024/u,
    );
  });

  it("requires administrator subjects to fit the principal contract", async () => {
    const environment = await oidcEnvironment();
    const subject = "s".repeat(512);
    environment.AGENTIC_REVIEW_OIDC_AUTHORIZED_SUBJECTS_JSON = JSON.stringify([subject]);
    environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON = JSON.stringify([subject]);
    expect(loadConfig(environment).operatorAccess?.administrators[0]?.subject).toBe(subject);
    environment.AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON = JSON.stringify([`${subject}s`]);
    expect(() => loadConfig(environment)).toThrow("AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON");
  });

  it.each([
    " https://login.example.com/tenant",
    "https://login.example.com/tenant ",
    "https://login.example.com/tenant\u0000",
    "x".repeat(2_049),
  ])("rejects non-exact issuer identity %j", async (issuer) => {
    const environment = await oidcEnvironment();
    environment.AGENTIC_REVIEW_OIDC_ISSUER_URL = issuer;
    expect(() => loadConfig(environment)).toThrow("AGENTIC_REVIEW_OIDC_ISSUER_URL");
  });

  it("uses only the explicit loopback identity, without granting display names or OIDC subjects", () => {
    const config = loadConfig({
      ...developmentEnvironment(),
      AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
      AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
      AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "Developer-Exact",
      AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_NAME: "admin@example.com",
      AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON: '["foreign-admin"]',
      AGENTIC_REVIEW_OIDC_AUTHORIZED_SUBJECTS_JSON: '["foreign-admin"]',
    });
    expect(config.operatorAccess).toStrictEqual({
      administrators: [{ issuer: "urn:agentic-review:development", subject: "Developer-Exact" }],
    });
    expect(Object.isFrozen(config.operatorAccess?.administrators[0])).toBe(true);
  });

  it.each(["", " developer", "developer "])(
    "requires the explicit loopback identity to be exact %j",
    (subject) => {
      expect(() =>
        loadConfig({
          ...developmentEnvironment(),
          AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "loopback",
          AGENTIC_REVIEW_PUBLIC_ORIGIN: "http://127.0.0.1:8080",
          AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: subject,
        }),
      ).toThrow("AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT");
    },
  );

  it("creates no trusted administrators when operator authentication is disabled", () => {
    const config = loadConfig({
      ...developmentEnvironment(),
      AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON: "invalid-json",
      AGENTIC_REVIEW_DEVELOPMENT_OPERATOR_SUBJECT: "unused",
    });
    expect(config.operatorAuth).toBeUndefined();
    expect(config.operatorAccess).toBeUndefined();
    expect(Object.hasOwn(config, "operatorAccess")).toBe(false);
  });
});

async function oidcEnvironment(): Promise<NodeJS.ProcessEnv> {
  const directory = await temporaryDirectory();
  const secretPath = join(directory, "oidc-fixture-secret");
  await writeFile(secretPath, "fixture-client-secret", "utf8");
  return {
    ...developmentEnvironment(),
    AGENTIC_REVIEW_OPERATOR_AUTH_MODE: "oidc",
    AGENTIC_REVIEW_PUBLIC_ORIGIN: "https://agentic-review.example.com",
    AGENTIC_REVIEW_OIDC_ISSUER_URL: "https://login.example.com/tenant",
    AGENTIC_REVIEW_OIDC_CLIENT_ID: "fixture-client",
    AGENTIC_REVIEW_OIDC_CLIENT_SECRET_PATH: secretPath,
    AGENTIC_REVIEW_OIDC_AUTHORIZED_SUBJECTS_JSON: '["admin","viewer"]',
    AGENTIC_REVIEW_OIDC_ADMIN_SUBJECTS_JSON: '["admin"]',
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentic-review-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function githubTransportEnvironment(): Promise<NodeJS.ProcessEnv> {
  const directory = await temporaryDirectory();
  const tokenPath = join(directory, "github-token");
  const webhookSecretPath = join(directory, "webhook-secret");
  await Promise.all([
    writeFile(tokenPath, " github-token\n", "utf8"),
    writeFile(webhookSecretPath, "webhook-secret", "utf8"),
  ]);
  return {
    AGENTIC_REVIEW_GITHUB_TOKEN_PATH: tokenPath,
    AGENTIC_REVIEW_GITHUB_WEBHOOK_SECRET_PATH: webhookSecretPath,
  };
}
