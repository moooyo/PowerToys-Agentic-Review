import { describe, expect, it } from "vitest";
import { loadInvestigationWorkerRuntimeConfig } from "./runtime-config.js";

function environment(): Record<string, string> {
  return {
    SYSTEMROOT: "C:\\Windows",
    INVESTIGATION_WORKER_SERVER_URL: "http://127.0.0.1:18080",
    INVESTIGATION_WORKER_ALLOW_INSECURE_HTTP: "true",
    INVESTIGATION_WORKER_TOKEN: "synthetic_worker_token_".padEnd(48, "x"),
    INVESTIGATION_WORKER_DATA_DIRECTORY: "D:\\InvestigationData",
    INVESTIGATION_WORKER_TRUSTED_EXECUTABLE_ROOT: "D:\\TrustedTools",
    INVESTIGATION_WORKER_PROCESS_HOST_PATH: "D:\\TrustedTools\\ProcessHost.exe",
    INVESTIGATION_WORKER_PROCESS_HOST_SHA256: "a".repeat(64),
    INVESTIGATION_WORKER_GIT_PATH: "D:\\TrustedTools\\Git\\git.exe",
    INVESTIGATION_WORKER_GIT_SHA256: "b".repeat(64),
    INVESTIGATION_WORKER_CLI_PATH: "C:\\ModelCli\\codex.exe",
    INVESTIGATION_WORKER_CLI_SHA256: "c".repeat(64),
    INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON: JSON.stringify({
      USERPROFILE: "C:\\DedicatedAccount",
      CODEX_HOME: "C:\\DedicatedAccount\\.codex",
    }),
    INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON: JSON.stringify(["moooyo/PowerToys"]),
    INVESTIGATION_WORKER_STATIC_CONFIG_VERIFIED: "true",
  };
}

describe("native investigation Worker configuration", () => {
  it("loads the native token and never forwards ambient service or Git credentials", () => {
    const input: Record<string, string> = {
      ...environment(),
      GITHUB_TOKEN: "ambient-github-secret",
      WORKER_TOKEN: "old-token",
      PATH: "C:\\UntrustedAmbientPath",
    };
    const config = loadInvestigationWorkerRuntimeConfig(input);
    expect(config.workerToken).toBe(input.INVESTIGATION_WORKER_TOKEN);
    expect(config.serverUrl).toBe("http://127.0.0.1:18080");
    expect(config.allowedRepositories).toEqual(["moooyo/PowerToys"]);
    expect(config.operatingSystemEnvironment.PATH).not.toContain("UntrustedAmbientPath");
    expect(
      JSON.stringify([
        config.operatingSystemEnvironment,
        config.modelEnvironment,
        config.planEnvironment,
      ]),
    ).not.toMatch(/ambient-github-secret|old-token|synthetic_worker_token/);
    expect(config.supportedKinds).toContain("pr-review");
    expect(config.workspaceRootDirectory).toBe("D:\\InvestigationData\\attempts");
  });

  it("uses the same credential bounds as the Server worker registration", () => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_TOKEN: "too-short",
      }),
    ).toThrow(/base64url/);
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_TOKEN: "x".repeat(257),
      }),
    ).toThrow(/base64url/);
  });

  it("rejects unknown repository origins and source names", () => {
    for (const name of [
      "https://github.com/moooyo/PowerToys",
      "../PowerToys",
      "moooyo/PowerToys.git",
      "moooyo/repo/extra",
    ]) {
      expect(() =>
        loadInvestigationWorkerRuntimeConfig({
          ...environment(),
          INVESTIGATION_WORKER_ALLOWED_REPOSITORIES_JSON: JSON.stringify([name]),
        }),
      ).toThrow();
    }
  });

  it("keeps mutable workspaces disjoint from executables and CLI home", () => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_DATA_DIRECTORY: "D:\\TrustedTools\\data",
      }),
    ).toThrow(/separate/);
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_CLI_PATH: "D:\\InvestigationData\\cli.exe",
      }),
    ).toThrow(/inside/);
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON: JSON.stringify({
          USERPROFILE: "D:\\InvestigationData",
          CODEX_HOME: "D:\\InvestigationData\\home",
        }),
      }),
    ).toThrow(/separate/);
  });

  it("rejects credentials even when disguised as a non-secret child variable", () => {
    const input = environment();
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...input,
        INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON: JSON.stringify({
          CUSTOM_VALUE: input.INVESTIGATION_WORKER_TOKEN,
        }),
      }),
    ).toThrow(/credential/);
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...input,
        INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON: JSON.stringify({ GITHUB_TOKEN: "other-token" }),
      }),
    ).toThrow(/credential/);
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...input,
        INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON: JSON.stringify({
          USERPROFILE: "C:\\Account",
          CODEX_HOME: "C:\\Account\\.codex",
          GITHUB_TOKEN: "other-token",
        }),
      }),
    ).toThrow(/unsupported/);
  });

  it("requires explicit HTTP opt-in and a strict canonical Server origin", () => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_ALLOW_INSECURE_HTTP: "false",
      }),
    ).toThrow(/HTTP/);
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_SERVER_URL: "https://user:password@example.test",
      }),
    ).toThrow(/credentials/);
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_SERVER_URL: "https://example.test/api",
      }),
    ).toThrow(/origin/);
  });

  it("requires explicit trusted executable IDs and hashes for saved plan execution", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      INVESTIGATION_WORKER_EXECUTABLES_JSON: JSON.stringify({
        node: { path: "C:\\Node\\node.exe", sha256: "d".repeat(64) },
      }),
    });
    expect(config.executables.node).toEqual({ path: "C:\\Node\\node.exe", sha256: "d".repeat(64) });
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_EXECUTABLES_JSON: JSON.stringify({
          node: { path: "C:\\Node\\node.exe" },
        }),
      }),
    ).toThrow(/path and sha256/);
  });
});
