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

function msbuildEnvironment(): Record<string, string> {
  return {
    ...environment(),
    INVESTIGATION_WORKER_EXECUTABLES_JSON: JSON.stringify({
      msbuild: { path: "D:\\TrustedTools\\MSBuild\\MSBuild.exe", sha256: "d".repeat(64) },
    }),
    INVESTIGATION_WORKER_MSBUILD_VC_TOOLS_VERSION: "14.38.33130",
    INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET: "v143",
  };
}

describe("native investigation Worker configuration", () => {
  it("allows the default managed process to use the task's full two-hour duration", () => {
    expect(loadInvestigationWorkerRuntimeConfig(environment()).processLimits.hardTimeoutMs).toBe(
      7_200_000,
    );
  });

  it("selects the explicit Codex transport without changing model or provider configuration", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      INVESTIGATION_WORKER_CLI_MODEL: "gpt-6-luna",
      INVESTIGATION_WORKER_CODEX_TRANSPORT: "app-server",
    });
    expect(config.cli.model).toBe("gpt-6-luna");
    expect(config.cli.codexTransport).toBe("app-server");
    expect(loadInvestigationWorkerRuntimeConfig(environment()).cli.codexTransport).toBeUndefined();
  });

  it.each([
    { INVESTIGATION_WORKER_CODEX_TRANSPORT: "unknown" },
    {
      INVESTIGATION_WORKER_CODEX_TRANSPORT: "app-server",
      INVESTIGATION_WORKER_CLI_ENGINE: "copilot",
    },
  ])("rejects unsupported transport selections", (overrides) => {
    expect(() => loadInvestigationWorkerRuntimeConfig({ ...environment(), ...overrides })).toThrow(
      /CODEX_TRANSPORT/,
    );
  });

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
    expect(config.supportedKinds).toContain("pr-e2e");
    expect(config.maximumConcurrentStaticTasks).toBe(1);
    expect(config.maximumConcurrentTasks).toBe(1);
    expect(config.role).toBe("all");
    expect(config.workspaceRootDirectory).toBe("D:\\InvestigationData\\attempts");
  });

  it("preserves the legacy capacity as a static pool alias", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      INVESTIGATION_WORKER_MAX_CONCURRENT_TASKS: "3",
    });
    expect(config.maximumConcurrentStaticTasks).toBe(3);
    expect(config.maximumConcurrentTasks).toBe(3);
  });

  it("shares the machine execution lock across Worker roles and data directories", () => {
    const first = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      ProgramData: "C:\\SharedProgramData",
      INVESTIGATION_WORKER_ROLE: "static",
    });
    const second = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      ProgramData: "C:\\SharedProgramData",
      INVESTIGATION_WORKER_ROLE: "e2e",
      INVESTIGATION_WORKER_DATA_DIRECTORY: "E:\\AnotherWorker",
    });
    expect(first.desktopLockDirectory).toBe(
      "C:\\SharedProgramData\\PowerToysAgenticReview\\desktop-locks",
    );
    expect(second.desktopLockDirectory).toBe(first.desktopLockDirectory);
  });

  it("uses the Windows system drive when ProgramData is absent", () => {
    const config = loadInvestigationWorkerRuntimeConfig(environment());
    expect(config.desktopLockDirectory).toBe(
      "C:\\ProgramData\\PowerToysAgenticReview\\desktop-locks",
    );
  });

  it("accepts an explicitly shared deployment execution lock directory", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      INVESTIGATION_WORKER_DESKTOP_LOCK_DIRECTORY: "D:\\SharedExecutionLocks",
    });
    expect(config.desktopLockDirectory).toBe("D:\\SharedExecutionLocks");
  });

  it.each([
    "D:\\InvestigationData",
    "D:\\InvestigationData\\attempts\\locks",
    "D:\\TrustedTools\\locks",
    "D:\\",
    "relative\\locks",
    "\\\\server\\locks",
  ])("rejects unsafe or Worker-specific execution lock roots: %s", (path) => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_DESKTOP_LOCK_DIRECTORY: path,
      }),
    ).toThrow();
  });

  it("prefers the explicit static capacity when both capacity settings are present", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      INVESTIGATION_WORKER_MAX_CONCURRENT_TASKS: "3",
      INVESTIGATION_WORKER_MAX_CONCURRENT_STATIC_TASKS: "5",
    });
    expect(config.maximumConcurrentStaticTasks).toBe(5);
    expect(config.maximumConcurrentTasks).toBe(5);
  });

  it.each(["0", "17", "1.5", "invalid"])("rejects an invalid static capacity: %s", (value) => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_MAX_CONCURRENT_STATIC_TASKS: value,
      }),
    ).toThrow(/MAX_CONCURRENT_STATIC_TASKS/);
  });

  it("filters supported kinds by the static Worker role", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      INVESTIGATION_WORKER_ROLE: "static",
    });
    expect(config.role).toBe("static");
    expect(config.supportedKinds).toEqual(["pr-review", "issue-investigate"]);
  });

  it("puts every execution kind in the E2E Worker role", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      INVESTIGATION_WORKER_ROLE: "e2e",
    });
    expect(config.role).toBe("e2e");
    expect(config.supportedKinds).toEqual([
      "pr-e2e",
      "pr-verify",
      "issue-verify",
      "reproduction-setup",
      "issue-fix",
      "feature-implement",
    ]);
  });

  it("rejects an unknown role or an empty role and kind intersection", () => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_ROLE: "other",
      }),
    ).toThrow(/ROLE/);
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_ROLE: "e2e",
        INVESTIGATION_WORKER_SUPPORTED_KINDS_JSON: JSON.stringify(["pr-review"]),
      }),
    ).toThrow(/matching the Worker role/);
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
  it("normalizes explicit Windows x86 program directories without changing their distinct values", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON: JSON.stringify({
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        "cOmMoNpRoGrAmFiLeS(X86)": "C:\\Program Files (x86)\\Common Files",
      }),
    });
    expect(config.planEnvironment).toEqual({
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      "COMMONPROGRAMFILES(X86)": "C:\\Program Files (x86)\\Common Files",
    });
  });
  it.each(["ProgramFiles(x86)", "CommonProgramFiles(x86)"])(
    "rejects case-folded duplicate %s values",
    (name) => {
      expect(() =>
        loadInvestigationWorkerRuntimeConfig({
          ...environment(),
          INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON: JSON.stringify({
            [name]: "C:\\One",
            [name.toUpperCase()]: "C:\\Two",
          }),
        }),
      ).toThrow(/invalid or reserved/u);
    },
  );
  it("does not inherit ambient x86 directory variables into the plan environment", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      "ProgramFiles(x86)": "C:\\Ambient Programs",
      "COMMONPROGRAMFILES(X86)": "C:\\Ambient Common",
    });
    expect(config.planEnvironment).not.toHaveProperty("PROGRAMFILES(X86)");
    expect(config.planEnvironment).not.toHaveProperty("COMMONPROGRAMFILES(X86)");
  });
  it.each(["PROGRAMFILES(X86)", "COMMONPROGRAMFILES(X86)"])(
    "preserves model-variable restrictions for %s",
    (name) => {
      expect(() =>
        loadInvestigationWorkerRuntimeConfig({
          ...environment(),
          INVESTIGATION_WORKER_MODEL_ENVIRONMENT_JSON: JSON.stringify({
            USERPROFILE: "C:\\DedicatedAccount",
            CODEX_HOME: "C:\\DedicatedAccount\\.codex",
            [name]: "C:\\Program Files (x86)",
          }),
        }),
      ).toThrow(/unsupported variable/u);
    },
  );
  it.each([
    "PROGRAMFILES(X64)",
    "OTHER(X86)",
    "PROGRAMFILES(X86)\n",
    "PATH\n",
    "BAD\0NAME",
    "BAD\u0085NAME",
    "BAD=NAME",
    "INVESTIGATION_CUSTOM",
  ])("rejects invalid or reserved explicit environment name %j", (name) => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...environment(),
        INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON: JSON.stringify({ [name]: "C:\\Directory" }),
      }),
    ).toThrow(/invalid or reserved/u);
  });
  it("does not let an accepted x86 directory name disclose the Worker credential", () => {
    const input = environment();
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...input,
        INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON: JSON.stringify({
          "PROGRAMFILES(X86)": `C:\\${input.INVESTIGATION_WORKER_TOKEN}`,
        }),
      }),
    ).toThrow(/credential/u);
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

  it("omits an MSBuild toolchain from legacy configuration even when MSBuild is configured", () => {
    const input = msbuildEnvironment();
    delete input.INVESTIGATION_WORKER_MSBUILD_VC_TOOLS_VERSION;
    delete input.INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET;
    expect(loadInvestigationWorkerRuntimeConfig(environment())).not.toHaveProperty(
      "msbuildToolchain",
    );
    expect(loadInvestigationWorkerRuntimeConfig(input)).not.toHaveProperty("msbuildToolchain");
  });

  it.each([
    ["14.30.12345", "v143"],
    ["14.49.99999", "v143"],
    ["14.50.35717", "v145"],
    ["14.99.99999", "v145"],
  ])("loads the exact deployment compiler pin %s with %s", (vcToolsVersion, platformToolset) => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...msbuildEnvironment(),
      INVESTIGATION_WORKER_MSBUILD_VC_TOOLS_VERSION: vcToolsVersion,
      INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET: platformToolset,
      INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON: JSON.stringify({ INCLUDE: "D:\\Sdk\\include" }),
    });
    expect(config.msbuildToolchain).toEqual({ vcToolsVersion, platformToolset });
    expect(config.planEnvironment).toEqual({ INCLUDE: "D:\\Sdk\\include" });
    expect(config.executables.msbuild).toEqual({
      path: "D:\\TrustedTools\\MSBuild\\MSBuild.exe",
      sha256: "d".repeat(64),
    });
  });

  it.each([
    "INVESTIGATION_WORKER_MSBUILD_VC_TOOLS_VERSION",
    "INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET",
  ])("rejects a partially configured MSBuild pin missing %s", (name) => {
    const input = msbuildEnvironment();
    delete input[name];
    expect(() => loadInvestigationWorkerRuntimeConfig(input)).toThrow(
      /MSBUILD_VC_TOOLS_VERSION.*MSBUILD_PLATFORM_TOOLSET must be configured together/,
    );
  });

  it.each([
    ["", ""],
    ["", "v143"],
    ["14.38.33130", ""],
    ["14.29.33130", "v143"],
    ["14.100.33130", "v145"],
    ["14.3.33130", "v143"],
    ["14.38.3313", "v143"],
    ["15.38.33130", "v143"],
    ["14.38.33130", "v145"],
    ["14.50.35717", "v143"],
    ["14.38.33130", "v142"],
    ["14.38.33130", "V143"],
    ["14.38.33130;Other=1", "v143"],
    ["14.38.33130 -p:Other=1", "v143"],
    ["14.38.33130", "v143;Other=1"],
    ["14.38.33130\n", "v143"],
    ["14.38.33130\r\n", "v143"],
    ["14.38.33130", "v143\n"],
    ["14.38.33130", "v143\r\n"],
    ["14.38.33130\0", "v143"],
    ["14.38.33130", "v143\u0001"],
    [" 14.38.33130", "v143"],
  ])("rejects an invalid deployment compiler pin %j with %j", (vcToolsVersion, platformToolset) => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...msbuildEnvironment(),
        INVESTIGATION_WORKER_MSBUILD_VC_TOOLS_VERSION: vcToolsVersion,
        INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET: platformToolset,
      }),
    ).toThrow(
      /INVESTIGATION_WORKER_MSBUILD_VC_TOOLS_VERSION.*supported, compatible compiler version and toolset/,
    );
  });

  it.each([
    {},
    { dotnet: { path: "D:\\TrustedTools\\dotnet.exe", sha256: "d".repeat(64) } },
    { MSBuild: { path: "D:\\TrustedTools\\MSBuild.exe", sha256: "d".repeat(64) } },
  ])("requires the exact deployment-owned msbuild executable entry: %j", (executables) => {
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...msbuildEnvironment(),
        INVESTIGATION_WORKER_EXECUTABLES_JSON: JSON.stringify(executables),
      }),
    ).toThrow(/INVESTIGATION_WORKER_EXECUTABLES_JSON.*deployment-owned msbuild/);
  });

  it.each([
    "vcTOOLSversion",
    "PLATFORMtoolSET",
    "vCToolsINSTALLdir",
    "VCTargetsPath",
    "clToolPath",
    "CLtoolEXE",
    "VCInstallDir",
    "cL",
    "_cL_",
  ])("rejects a case-insensitive plan environment override of the pinned compiler: %s", (name) => {
    const override =
      name.toUpperCase() === "VCTOOLSVERSION"
        ? "14.38.33130"
        : name.toUpperCase() === "PLATFORMTOOLSET"
          ? "v143"
          : "D:\\OtherToolchain";
    expect(() =>
      loadInvestigationWorkerRuntimeConfig({
        ...msbuildEnvironment(),
        INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON: JSON.stringify({ [name]: override }),
      }),
    ).toThrow(
      new RegExp(
        `INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON conflicts with the pinned MSBuild toolchain through ${name.toUpperCase()}`,
      ),
    );
  });

  it("preserves legacy plan environment compiler settings when there is no explicit pin", () => {
    const input = msbuildEnvironment();
    delete input.INVESTIGATION_WORKER_MSBUILD_VC_TOOLS_VERSION;
    delete input.INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET;
    input.INVESTIGATION_WORKER_PLAN_ENVIRONMENT_JSON = JSON.stringify({
      VCToolsVersion: "14.29.30133",
      PlatformToolset: "v142",
      VCToolsInstallDir: "D:\\LegacyCompiler",
      VCTargetsPath: "D:\\LegacyTargets",
      CLToolPath: "D:\\LegacyCompiler\\bin",
      CLToolExe: "cl.exe",
      VCInstallDir: "D:\\LegacyVisualStudio",
      CL: "/DLEGACY_TOOLCHAIN",
      _CL_: "/I D:\\LegacyHeaders",
    });
    const config = loadInvestigationWorkerRuntimeConfig(input);
    expect(config).not.toHaveProperty("msbuildToolchain");
    expect(config.planEnvironment).toEqual({
      VCTOOLSVERSION: "14.29.30133",
      PLATFORMTOOLSET: "v142",
      VCTOOLSINSTALLDIR: "D:\\LegacyCompiler",
      VCTARGETSPATH: "D:\\LegacyTargets",
      CLTOOLPATH: "D:\\LegacyCompiler\\bin",
      CLTOOLEXE: "cl.exe",
      VCINSTALLDIR: "D:\\LegacyVisualStudio",
      CL: "/DLEGACY_TOOLCHAIN",
      _CL_: "/I D:\\LegacyHeaders",
    });
  });

  it("does not infer a compiler pin or plan overrides from ambient MSBuild variables", () => {
    const config = loadInvestigationWorkerRuntimeConfig({
      ...environment(),
      VCToolsVersion: "14.38.33130",
      PlatformToolset: "v143",
      VCToolsInstallDir: "D:\\AmbientCompiler",
      VCTargetsPath: "D:\\AmbientTargets",
      CLToolPath: "D:\\AmbientCompiler\\bin",
      CLToolExe: "cl.exe",
      VCInstallDir: "D:\\AmbientVisualStudio",
      CL: "/DAMBIENT_TOOLCHAIN",
      _CL_: "/I D:\\AmbientHeaders",
    });
    expect(config).not.toHaveProperty("msbuildToolchain");
    expect(config.planEnvironment).toEqual({});
  });
});
