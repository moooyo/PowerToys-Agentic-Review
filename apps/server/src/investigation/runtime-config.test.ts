import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInvestigationRuntimeConfig } from "../../dist/investigation/runtime-config.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("password runtime configuration", () => {
  it("loads an explicit public webhook URL independently of the dashboard origin", () => {
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_PUBLIC_ORIGIN: "https://console.example.test",
      INVESTIGATION_GITHUB_WEBHOOK_PUBLIC_URL: "https://gateway.example.test/receive",
    });
    expect(config.webhookPublicUrl).toBe("https://gateway.example.test/receive");
    expect(config.auth.publicOrigin).toBe("https://console.example.test");
    expect(config.webhook).toBeUndefined();
    for (const url of [
      "/receive",
      "https://user:secret@example.test/receive",
      "https://example.test/receive?token=x",
    ])
      expect(() =>
        loadInvestigationRuntimeConfig({ INVESTIGATION_GITHUB_WEBHOOK_PUBLIC_URL: url }),
      ).toThrow("public webhook URL");
  });

  it("defaults to password authentication without any predefined credentials", () => {
    const config = loadInvestigationRuntimeConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.auth).toMatchObject({
      mode: "password",
      bootstrapAdmin: undefined,
      maxKdfConcurrency: 2,
      maxKdfQueue: 8,
    });
    expect(config.authDatabasePath).toMatch(/investigation-accounts\.sqlite$/u);
    expect(config.authDatabasePath).not.toBe(config.databasePath);
    expect(config).not.toHaveProperty("operators");
    expect(config).not.toHaveProperty("oidc");
    expect(config.workers).toEqual([]);
    expect(config.enableExternalWrites).toBe(false);
    expect(config.staticConcurrency).toBe(1);
    expect(config.defaultTaskBudget).toEqual({
      maxTokens: 120_000,
      maxRounds: 24,
      maxDurationMs: 1_800_000,
    });
    expect(config.media).toEqual({ enabled: true, requestTimeoutMs: 120_000 });
  });

  it("loads bounded media publication settings without changing the external-write gate", () => {
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_MEDIA_UPLOADS_ENABLED: "false",
      INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS: "45000",
    });
    expect(config.media).toEqual({ enabled: false, requestTimeoutMs: 45_000 });
    expect(config.enableExternalWrites).toBe(false);
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS: "600001" }),
    ).toThrow("INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS");
  });

  it("accepts a bounded independent static concurrency without configuring E2E parallelism", () => {
    expect(
      loadInvestigationRuntimeConfig({ INVESTIGATION_STATIC_CONCURRENCY: "4" }).staticConcurrency,
    ).toBe(4);
    for (const value of ["0", "17", "1.5", "-1", "invalid"])
      expect(() =>
        loadInvestigationRuntimeConfig({ INVESTIGATION_STATIC_CONCURRENCY: value }),
      ).toThrow("INVESTIGATION_STATIC_CONCURRENCY");
  });

  it("loads immutable per-Task deployment budgets independently of source import limits", () => {
    const environment = {
      INVESTIGATION_DEFAULT_TASK_MAX_TOKENS: "5000000",
      INVESTIGATION_DEFAULT_TASK_MAX_ROUNDS: "8",
      INVESTIGATION_DEFAULT_TASK_MAX_DURATION_MS: "7200000",
    };
    const config = loadInvestigationRuntimeConfig(environment);
    environment.INVESTIGATION_DEFAULT_TASK_MAX_TOKENS = "7";
    expect(config.defaultTaskBudget).toEqual({
      maxTokens: 5_000_000,
      maxRounds: 8,
      maxDurationMs: 7_200_000,
    });
    expect(Object.isFrozen(config.defaultTaskBudget)).toBe(true);
    expect(config.sourceImportMaximumBytes).toBe(16 * 1024 * 1024);
  });

  it.each(["MAX_TOKENS", "MAX_ROUNDS", "MAX_DURATION_MS"])(
    "rejects invalid default Task %s values",
    (field) => {
      for (const value of [
        "0",
        "-1",
        "1.5",
        "NaN",
        "Infinity",
        "1e6",
        " 1",
        "01",
        "9007199254740992",
        "999999999999999999999",
      ])
        expect(() =>
          loadInvestigationRuntimeConfig({ [`INVESTIGATION_DEFAULT_TASK_${field}`]: value }),
        ).toThrow(`INVESTIGATION_DEFAULT_TASK_${field}`);
    },
  );

  it("accepts safe token counters and bounds durations to the timer implementation", () => {
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_DEFAULT_TASK_MAX_TOKENS: String(Number.MAX_SAFE_INTEGER),
      INVESTIGATION_DEFAULT_TASK_MAX_ROUNDS: String(Number.MAX_SAFE_INTEGER),
      INVESTIGATION_DEFAULT_TASK_MAX_DURATION_MS: "2147483647",
    });
    expect(config.defaultTaskBudget).toEqual({
      maxTokens: Number.MAX_SAFE_INTEGER,
      maxRounds: Number.MAX_SAFE_INTEGER,
      maxDurationMs: 2_147_483_647,
    });
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_DEFAULT_TASK_MAX_DURATION_MS: "2147483648" }),
    ).toThrow("INVESTIGATION_DEFAULT_TASK_MAX_DURATION_MS");
  });

  it("rejects every no-password mode and non-loopback HTTP listener", () => {
    for (const mode of ["loopback", "oidc", "none", "disabled"])
      expect(() => loadInvestigationRuntimeConfig({ INVESTIGATION_AUTH_MODE: mode })).toThrow(
        "only supports password",
      );
    for (const host of ["0.0.0.0", "::", "localhost", "127.0.0.2"])
      expect(() => loadInvestigationRuntimeConfig({ INVESTIGATION_HOST: host })).toThrow(
        "literal 127.0.0.1",
      );
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_PUBLIC_ORIGIN: "http://127.0.0.1:9000" }),
    ).toThrow("matching local public origin");
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_PUBLIC_ORIGIN: "http://127.0.0.1:8000/path" }),
    ).toThrow("without a path");
  });

  it("accepts a private loopback HTTPS proxy and requires TLS for public listeners", () => {
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_PUBLIC_ORIGIN: "https://review.example",
    });
    expect(config.auth.publicOrigin).toBe("https://review.example");
    expect(config.https).toBeUndefined();
    expect(() =>
      loadInvestigationRuntimeConfig({
        INVESTIGATION_HOST: "0.0.0.0",
        INVESTIGATION_PUBLIC_ORIGIN: "https://review.example",
      }),
    ).toThrow("requires TLS");
  });

  it("normalizes only the bootstrap username and preserves password file content verbatim", async () => {
    const directory = await mkdtemp(join(tmpdir(), "password-config-"));
    directories.push(directory);
    const path = join(directory, "password.txt");
    const password = "  Synthetic bootstrap password  \n";
    await writeFile(path, password);
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "  FIXTURE.Admin  ",
      INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD_PATH: path,
    });
    expect(config.auth.bootstrapAdmin).toEqual({
      username: "fixture.admin",
      displayName: "fixture.admin",
      password,
    });
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin" }),
    ).toThrow("username and password together");
    expect(() =>
      loadInvestigationRuntimeConfig({
        INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
        INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: " ".repeat(20),
      }),
    ).toThrow("non-whitespace");
    expect(() =>
      loadInvestigationRuntimeConfig({
        INVESTIGATION_BOOTSTRAP_ADMIN_USERNAME: "fixture-admin",
        INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD: "Synthetic bootstrap password",
        INVESTIGATION_BOOTSTRAP_ADMIN_PASSWORD_PATH: path,
      }),
    ).toThrow("Configure only");
  });

  it("bounds password derivation and login throttling configuration", () => {
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_PASSWORD_KDF_CONCURRENCY: "5" }),
    ).toThrow("out of range");
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_PASSWORD_KDF_QUEUE_LIMIT: "1000" }),
    ).toThrow("out of range");
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_LOGIN_ACCOUNT_LIMIT: "0" }),
    ).toThrow("positive integer");
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_SESSION_TTL_SECONDS: "86401" }),
    ).toThrow("out of range");
  });

  it("configures bounded evidence storage and retention without an unlimited mode", () => {
    expect(loadInvestigationRuntimeConfig({}).evidencePolicy).toEqual({
      maximumBytes: 1_024 * 1_024 * 1_024,
      maximumCount: 10_000,
      retentionSeconds: 2_592_000,
      cleanupIntervalSeconds: 60,
      cleanupBatchSize: 100,
    });
    expect(
      loadInvestigationRuntimeConfig({
        INVESTIGATION_EVIDENCE_MAXIMUM_BYTES: "1024",
        INVESTIGATION_EVIDENCE_MAXIMUM_COUNT: "2",
        INVESTIGATION_EVIDENCE_RETENTION_SECONDS: "3600",
        INVESTIGATION_EVIDENCE_CLEANUP_INTERVAL_SECONDS: "5",
        INVESTIGATION_EVIDENCE_CLEANUP_BATCH_SIZE: "10",
      }).evidencePolicy,
    ).toEqual({
      maximumBytes: 1024,
      maximumCount: 2,
      retentionSeconds: 3600,
      cleanupIntervalSeconds: 5,
      cleanupBatchSize: 10,
    });
    for (const [name, value] of [
      ["MAXIMUM_BYTES", "0"],
      ["MAXIMUM_COUNT", "-1"],
      ["RETENTION_SECONDS", "316224001"],
      ["CLEANUP_INTERVAL_SECONDS", "86401"],
      ["CLEANUP_BATCH_SIZE", "1001"],
    ]) {
      expect(() =>
        loadInvestigationRuntimeConfig({ [`INVESTIGATION_EVIDENCE_${name}`]: value }),
      ).toThrow();
    }
  });

  it("retains explicitly scoped bearer workers and opt-in GitHub transport", () => {
    const worker = { id: "worker-1", token: "T".repeat(43), repositoryIds: ["repo-1"] };
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_WORKERS_JSON: JSON.stringify([worker]),
      INVESTIGATION_GITHUB_TOKEN: "synthetic-token",
      INVESTIGATION_GITHUB_USER_ID: "123",
    });
    expect(config.workers).toEqual([worker]);
    expect(config.github).toEqual({ token: "synthetic-token", expectedGitHubUserId: 123 });
    expect(config.enableExternalWrites).toBe(false);
    expect(() =>
      loadInvestigationRuntimeConfig({
        INVESTIGATION_WORKERS_JSON: JSON.stringify([{ ...worker, token: "short" }]),
      }),
    ).toThrow("43 to 256");
  });

  it("accepts optional friendly worker names without changing their stable identities", () => {
    const worker = {
      id: "worker-1",
      displayName: "Windows Review Worker",
      token: "T".repeat(43),
      repositoryIds: ["repo-1"],
    };
    expect(
      loadInvestigationRuntimeConfig({ INVESTIGATION_WORKERS_JSON: JSON.stringify([worker]) })
        .workers,
    ).toEqual([worker]);
    for (const displayName of ["", " ", " Worker", "Worker ", "W".repeat(121), 1, null]) {
      expect(() =>
        loadInvestigationRuntimeConfig({
          INVESTIGATION_WORKERS_JSON: JSON.stringify([{ ...worker, displayName }]),
        }),
      ).toThrow("worker.displayName");
    }
  });
});
