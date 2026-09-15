import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadInvestigationRuntimeConfig } from "../../dist/investigation/runtime-config.js";

const operator = {
  id: "operator-1",
  subject: "subject-1",
  displayName: "Test Operator",
  repositoryIds: ["repo-1"],
  permissions: ["task:create", "action:prepare"],
  actionCapabilities: ["comment"],
  allowRepositoryExecution: true,
};

describe("investigation runtime configuration", () => {
  it("documents the native databases, scoped authority, and disabled-by-default external writes", async () => {
    const example = await readFile(resolve(import.meta.dirname, "../..", ".env.example"), "utf8");
    expect(example).toContain(
      "INVESTIGATION_DATABASE_PATH=/var/lib/agentic-review/investigation.sqlite",
    );
    expect(example).toContain(
      "INVESTIGATION_AUTH_DATABASE_PATH=/var/lib/agentic-review/investigation-auth.sqlite",
    );
    expect(example).toContain("INVESTIGATION_AUTH_MODE=loopback");
    expect(example).toContain("INVESTIGATION_OPERATORS_JSON");
    expect(example).toContain("INVESTIGATION_WORKERS_JSON");
    expect(example).toContain("INVESTIGATION_ENABLE_EXTERNAL_WRITES=false");
    expect(example).not.toContain("AGENTIC_REVIEW_");
  });

  it("defaults to a loopback listener with no repository or execution authority", () => {
    const config = loadInvestigationRuntimeConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.auth.mode).toBe("loopback");
    expect(config.operators[0]?.repositoryIds).toEqual([]);
    expect(config.operators[0]?.allowRepositoryExecution).toBe(false);
    expect(config.workers).toEqual([]);
    expect(config.github).toBeUndefined();
    expect(config.enableExternalWrites).toBe(false);
    expect(config.authDatabasePath).not.toBe(config.databasePath);
  });

  it("does not allow loopback authentication on any other listener or public host", () => {
    for (const host of ["0.0.0.0", "::", "localhost", "127.0.0.2"]) {
      expect(() => loadInvestigationRuntimeConfig({ INVESTIGATION_HOST: host })).toThrow(
        "literal 127.0.0.1",
      );
    }
    expect(() =>
      loadInvestigationRuntimeConfig({
        INVESTIGATION_PUBLIC_ORIGIN: "http://attacker.example:8000",
      }),
    ).toThrow("literal 127.0.0.1");
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_PUBLIC_ORIGIN: "http://127.0.0.1:8000/path" }),
    ).toThrow("without a path");
  });

  it("accepts exact OIDC bindings behind a loopback HTTPS reverse proxy", () => {
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_AUTH_MODE: "oidc",
      INVESTIGATION_PUBLIC_ORIGIN: "https://review.example",
      INVESTIGATION_OIDC_ISSUER_URL: "https://identity.example",
      INVESTIGATION_OIDC_CLIENT_ID: "client-1",
      INVESTIGATION_OIDC_CLIENT_SECRET: "test-client-secret",
      INVESTIGATION_OPERATORS_JSON: JSON.stringify([operator]),
    });
    expect(config.auth).toMatchObject({ mode: "oidc", authorizedSubjects: ["subject-1"] });
    expect(config.operators[0]).toEqual({ ...operator, issuer: "https://identity.example" });
    expect(config.oidc?.redirectUri).toBe("https://review.example/api/auth/callback");
    expect(config.https).toBeUndefined();
  });

  it("rejects public HTTP deployment and malformed authority grants", () => {
    expect(() =>
      loadInvestigationRuntimeConfig({
        INVESTIGATION_AUTH_MODE: "oidc",
        INVESTIGATION_HOST: "0.0.0.0",
        INVESTIGATION_PUBLIC_ORIGIN: "https://review.example",
      }),
    ).toThrow("requires TLS");
    for (const invalid of [
      { ...operator, repositoryIds: ["*"] },
      { ...operator, permissions: ["administrator"] },
      { ...operator, actionCapabilities: ["push"] },
      { ...operator, allowRepositoryExecution: "true" },
    ]) {
      expect(() =>
        loadInvestigationRuntimeConfig({ INVESTIGATION_OPERATORS_JSON: JSON.stringify([invalid]) }),
      ).toThrow();
    }
  });

  it("binds long random bearer credentials to exact worker IDs and repository scopes", () => {
    const worker = { id: "worker-1", token: "T".repeat(43), repositoryIds: ["repo-1"] };
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_WORKERS_JSON: JSON.stringify([worker]),
    });
    expect(config.workers).toEqual([worker]);
    expect(() =>
      loadInvestigationRuntimeConfig({
        INVESTIGATION_WORKERS_JSON: JSON.stringify([{ ...worker, token: "short" }]),
      }),
    ).toThrow("43 to 256");
    expect(() =>
      loadInvestigationRuntimeConfig({
        INVESTIGATION_WORKERS_JSON: JSON.stringify([worker, { ...worker, id: "worker-2" }]),
      }),
    ).toThrow("unique");
  });

  it("requires an account binding for GitHub and keeps external writes an explicit setting", () => {
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_GITHUB_TOKEN: "test-token" }),
    ).toThrow("configured together");
    expect(() =>
      loadInvestigationRuntimeConfig({ INVESTIGATION_ENABLE_EXTERNAL_WRITES: "true" }),
    ).toThrow("require configured");
    const config = loadInvestigationRuntimeConfig({
      INVESTIGATION_GITHUB_TOKEN: "test-token",
      INVESTIGATION_GITHUB_USER_ID: "123",
    });
    expect(config.github).toEqual({ token: "test-token", expectedGitHubUserId: 123 });
    expect(config.enableExternalWrites).toBe(false);
  });
});
