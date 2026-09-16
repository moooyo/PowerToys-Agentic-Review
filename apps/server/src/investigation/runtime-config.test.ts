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
});
