import { describe, expect, it, vi } from "vitest";

import {
  loadWorkerConfig as loadWorkerConfigProduction,
  type SecretFileSystem,
  type StableSecretFileMetadata,
  type WorkerConfig,
  type WorkerConfigDependencies,
} from "./config.js";

const mebibyte = 1024 * 1024;
const gibibyte = 1024 * mebibyte;
const workerAuthProfilePath = "C:\\ProgramData\\AgenticReview\\Worker\\worker-auth-v1.json";
const workerNodeId = "worker-config:test";
const workerToken = `arw1_${"A".repeat(43)}`;

describe("Worker transport policy", () => {
  it.each(["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"])(
    "allows explicit development HTTP for loopback origin %s",
    (serverUrl) => {
      const config = loadWorkerConfig({
        ...baseEnvironment(),
        WORKER_SERVER_URL: serverUrl,
        WORKER_ALLOW_INSECURE_HTTP: "true",
        NODE_ENV: "development",
      });

      expect(config.serverUrl.origin).toBe(new URL(serverUrl).origin);
      expect(config.allowInsecureHttp).toBe(true);
    },
  );

  it("rejects the insecure HTTP switch in production", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnvironment(),
        WORKER_ALLOW_INSECURE_HTTP: "true",
        NODE_ENV: "production",
      }),
    ).toThrow(/must not be enabled in production/u);
  });

  it.each([
    "http://example.internal:8080",
    "http://127.0.0.2:8080",
    "http://127.1:8080",
    "https://example.internal",
  ])("rejects insecure-switch use with non-explicit loopback origin %s", (serverUrl) => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnvironment(),
        WORKER_SERVER_URL: serverUrl,
        WORKER_ALLOW_INSECURE_HTTP: "true",
        NODE_ENV: "development",
      }),
    ).toThrow(/requires WORKER_SERVER_URL to use 127\.0\.0\.1/u);
  });

  it("still rejects loopback HTTP unless the development switch is explicit", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnvironment(),
        WORKER_ALLOW_INSECURE_HTTP: "false",
      }),
    ).toThrow(/must use HTTPS/u);
  });
});

describe("Worker authentication profile", () => {
  it("loads the exact production file and derives both Worker credentials from it", () => {
    const reader = vi.fn(() => workerAuthProfileBytes());
    const config = loadWorkerConfigProduction(
      {
        ...baseEnvironment(),
        WORKER_NODE_ID: "ignored-environment-node",
        WORKER_TOKEN: `arw1_${"E".repeat(43)}`,
      },
      { workerAuthFileReader: reader },
    );

    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith(workerAuthProfilePath);
    expect(config.workerNodeId).toBe(workerNodeId);
    expect(config.workerToken).toBe(workerToken);
  });

  it.each([
    ["trailing whitespace", Buffer.from(`${workerAuthProfileBytes().toString("utf8")}\n`)],
    [
      "a different member order",
      Buffer.from(
        JSON.stringify({
          token: workerToken,
          profileId: "agentic-review-worker-auth-v1",
          workerNodeId,
        }),
      ),
    ],
    [
      "an escaped equivalent Token",
      Buffer.from(
        `{"profileId":"agentic-review-worker-auth-v1","token":"arw1_\\u0041${"A".repeat(42)}","workerNodeId":"${workerNodeId}"}`,
      ),
    ],
    [
      "a duplicate member",
      Buffer.from(
        `{"profileId":"agentic-review-worker-auth-v1","token":"${workerToken}","token":"${workerToken}","workerNodeId":"${workerNodeId}"}`,
      ),
    ],
  ])("rejects canonical-profile deviations including %s", (_scenario, bytes) => {
    expect(() =>
      loadWorkerConfigProduction(baseEnvironment(), { workerAuthFileReader: () => bytes }),
    ).toThrow("Unable to load Worker authentication profile.");
  });

  it.each([
    ["an empty file", Buffer.alloc(0)],
    ["more than 4 KiB", Buffer.alloc(4 * 1024 + 1, 0x20)],
    ["invalid UTF-8", Buffer.from([0xff])],
    ["invalid JSON", Buffer.from("{", "utf8")],
    ["a non-object", Buffer.from("[]", "utf8")],
    [
      "a missing member",
      Buffer.from(
        JSON.stringify({ profileId: "agentic-review-worker-auth-v1", token: workerToken }),
      ),
    ],
    ["an extra member", Buffer.from(JSON.stringify({ ...workerAuthProfile(), extra: true }))],
    [
      "the wrong profile ID",
      Buffer.from(JSON.stringify({ ...workerAuthProfile(), profileId: "other-profile" })),
    ],
    ["a non-string Token", Buffer.from(JSON.stringify({ ...workerAuthProfile(), token: 1 }))],
    [
      "a non-canonical Token",
      Buffer.from(JSON.stringify({ ...workerAuthProfile(), token: `arw1_${"A".repeat(42)}B` })),
    ],
    [
      "an invalid Worker node ID",
      Buffer.from(JSON.stringify({ ...workerAuthProfile(), workerNodeId: ":invalid" })),
    ],
  ])("rejects %s without exposing profile contents", (_scenario, bytes) => {
    let caught: unknown;
    try {
      loadWorkerConfigProduction(baseEnvironment(), { workerAuthFileReader: () => bytes });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Unable to load Worker authentication profile.");
    expect((caught as Error).message).not.toContain(workerToken);
    expect((caught as Error).cause).toBeUndefined();
  });

  it("does not fall back to environment credentials when the fixed file cannot be read", () => {
    const environmentToken = `arw1_${"E".repeat(42)}A`;

    expect(() =>
      loadWorkerConfigProduction(
        {
          ...baseEnvironment(),
          WORKER_NODE_ID: "environment-node",
          WORKER_TOKEN: environmentToken,
        },
        {
          workerAuthFileReader: () => {
            throw new Error(`${environmentToken} is unavailable at ${workerAuthProfilePath}`);
          },
        },
      ),
    ).toThrow("Unable to load Worker authentication profile.");
  });
});

describe("Worker TLS material policy", () => {
  it("requires no client certificate and ignores legacy client TLS settings", () => {
    const config = loadWorkerConfig({
      ...httpsEnvironment(),
      WORKER_TLS_CERT_PATH: "C:\\legacy\\worker.crt",
      WORKER_TLS_KEY_PATH: "C:\\legacy\\worker.key",
      WORKER_TLS_PFX_PATH: "C:\\legacy\\worker.pfx",
      WORKER_TLS_PFX_PASSPHRASE: "unused",
      WORKER_TLS_SERVER_NAME: "review.internal",
    });

    expect(config.tls).toEqual({
      serverName: "review.internal",
      rejectUnauthorized: true,
    });
  });

  it("reads only the Server CA from a stable file descriptor and always closes it", () => {
    const content = Buffer.from("test-server-ca", "utf8");
    const fixture = createSecretFileSystem(new Map([[tlsCaPath, content]]));

    const config = loadWorkerConfig(
      { ...httpsEnvironment(), WORKER_TLS_CA_PATH: tlsCaPath },
      { secretFileSystem: fixture.fileSystem },
    );

    expect(config.tls?.ca).toEqual(content);
    expect(fixture.open).toHaveBeenCalledWith(tlsCaPath);
    expect(fixture.read).toHaveBeenCalledWith(47, expect.any(Buffer), 0, content.length, 0);
    expect(fixture.fstat).toHaveBeenCalledTimes(2);
    expect(fixture.lstat).toHaveBeenCalledTimes(2);
    expect(fixture.realpath).toHaveBeenCalledTimes(2);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledWith(47);
  });

  it("rejects oversized Server CA material before opening it", () => {
    const fixture = createSecretFileSystem(new Map([[tlsCaPath, Buffer.from("small", "utf8")]]));
    fixture.lstat.mockReturnValue(secretMetadata(BigInt(mebibyte + 1)));

    expect(() =>
      loadWorkerConfig(
        { ...httpsEnvironment(), WORKER_TLS_CA_PATH: tlsCaPath },
        { secretFileSystem: fixture.fileSystem },
      ),
    ).toThrow("Unable to securely read WORKER_TLS_CA_PATH.");
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it("rejects symbolic links and canonical-path mismatches before opening the Server CA", () => {
    const symlinkFixture = createSecretFileSystem(
      new Map([[tlsCaPath, Buffer.from("ca", "utf8")]]),
    );
    symlinkFixture.lstat.mockReturnValue(
      secretMetadata(2n, { isFile: false, isSymbolicLink: true }),
    );

    expect(() =>
      loadWorkerConfig(
        { ...httpsEnvironment(), WORKER_TLS_CA_PATH: tlsCaPath },
        { secretFileSystem: symlinkFixture.fileSystem },
      ),
    ).toThrow("Unable to securely read WORKER_TLS_CA_PATH.");
    expect(symlinkFixture.open).not.toHaveBeenCalled();

    const mismatchFixture = createSecretFileSystem(
      new Map([[tlsCaPath, Buffer.from("ca", "utf8")]]),
    );
    mismatchFixture.realpath.mockReturnValue("C:\\AgenticReview\\Secrets\\other-ca.pem");

    expect(() =>
      loadWorkerConfig(
        { ...httpsEnvironment(), WORKER_TLS_CA_PATH: tlsCaPath },
        { secretFileSystem: mismatchFixture.fileSystem },
      ),
    ).toThrow("Unable to securely read WORKER_TLS_CA_PATH.");
    expect(mismatchFixture.open).not.toHaveBeenCalled();
  });

  it("does not expose an underlying Server CA read error", () => {
    const fixture = createSecretFileSystem(
      new Map([[tlsCaPath, Buffer.from("private-secret-marker", "utf8")]]),
    );
    fixture.read.mockImplementation(() => {
      throw new Error(`private-secret-marker at ${tlsCaPath}`);
    });

    let caught: unknown;
    try {
      loadWorkerConfig(
        { ...httpsEnvironment(), WORKER_TLS_CA_PATH: tlsCaPath },
        { secretFileSystem: fixture.fileSystem },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Unable to securely read WORKER_TLS_CA_PATH.");
    expect((caught as Error).message).not.toContain("private-secret-marker");
    expect((caught as Error).message).not.toContain(tlsCaPath);
    expect((caught as Error).cause).toBeUndefined();
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});

describe("loadWorkerConfig execution mode", () => {
  it("keeps execution absent and does not parse or probe execution paths when disabled", () => {
    const config = loadWorkerConfig({
      ...baseEnvironment(),
      WORKER_EXECUTION_ENABLED: "false",
      WORKER_TRUSTED_EXECUTABLE_ROOT: "relative/trusted",
      WORKER_PROCESS_HOST_PATH: "Z:\\missing\\ProcessHost.exe",
      WORKER_PROCESS_HOST_SHA256: "invalid",
      WORKER_CODEX_EXECUTABLE_PATH: "\\\\server\\share\\codex.exe",
      WORKER_CODEX_SHA256: "invalid",
      WORKER_CODEX_VERSION: "not-configured",
      WORKER_GIT_EXECUTABLE_PATH: "C:\\unsafe\\..\\git.exe",
      WORKER_GIT_SHA256: "invalid",
      WORKER_WORKSPACE_ROOT_DIRECTORY: "relative/workspaces",
    });

    expect(config.executionEnabled).toBe(false);
    expect(config.execution).toBeUndefined();
    expect(config.capabilities).toMatchObject({
      codexVersion: "not-configured",
      recipeIds: [],
      labels: { execution: "disabled", processHost: "unavailable" },
    });
  });

  it("loads a complete execution configuration using Windows path semantics", () => {
    const config = loadWorkerConfig(enabledEnvironment());

    expect(config.executionEnabled).toBe(true);
    expect(config.dataDirectory).toBe("D:\\AgenticReview\\Data");
    expect(config.execution).toEqual({
      trustedExecutableRoot: "C:\\AgenticReview\\Bin",
      processHostPath: "C:\\AgenticReview\\Bin\\AgenticReview.ProcessHost.exe",
      processHostSha256: "a".repeat(64),
      codexExecutablePath: "C:\\AgenticReview\\Bin\\Codex\\codex.exe",
      codexSha256: "b".repeat(64),
      codexVersion: "codex-cli 1.2.3",
      gitExecutablePath: "C:\\AgenticReview\\Bin\\Git\\git.exe",
      gitSha256: "c".repeat(64),
      gitSharedRootDirectory: "D:\\AgenticReview\\Data\\Repositories",
      workspaceRootDirectory: "D:\\AgenticReview\\Data\\Workspaces",
      tempDirectory: "D:\\AgenticReview\\Data\\Temp",
      profileDirectory: "D:\\AgenticReview\\Data\\Profile",
      processHostRequestTimeoutMs: 15_000,
      processHostStartTimeoutMs: 30_000,
      processHostShutdownTimeoutMs: 15_000,
      codexMaximumHardTimeoutMs: 60 * 60 * 1_000,
      gitHardTimeoutMs: 10 * 60 * 1_000,
      codexResourceLimits: {
        maximumProcessCount: 32,
        maximumMemoryBytes: 8 * gibibyte,
        maximumOutputBytes: 8 * mebibyte,
      },
      gitResourceLimits: {
        maximumProcessCount: 8,
        maximumMemoryBytes: 2 * gibibyte,
        maximumOutputBytes: 4 * mebibyte,
      },
      totalResourceBudget: {
        maximumProcessCount: 64,
        maximumMemoryBytes: 16 * gibibyte,
        maximumOutputBytes: 64 * mebibyte,
      },
      perAttemptDiskBytes: 16 * gibibyte,
      totalWorkspaceDiskBytes: 32 * gibibyte,
      minimumFreeDiskBytes: 10 * gibibyte,
      orphanRetentionHours: 24,
      orphanScanLimit: 100,
    });
    expect(config.shutdownGraceSeconds).toBe(90);
    expect(config.capabilities).toMatchObject({
      codexVersion: "codex-cli 1.2.3",
      recipeIds: [],
      labels: { execution: "enabled", processHost: "available" },
    });
  });

  it("accepts configured nonexistent binary paths without filesystem access", () => {
    const config = loadWorkerConfig({
      ...enabledEnvironment(),
      WORKER_TRUSTED_EXECUTABLE_ROOT: "Z:\\NotInstalled\\Bin",
      WORKER_PROCESS_HOST_PATH: "Z:\\NotInstalled\\Bin\\ProcessHost.exe",
      WORKER_CODEX_EXECUTABLE_PATH: "Z:\\NotInstalled\\Bin\\Codex\\codex.exe",
      WORKER_GIT_EXECUTABLE_PATH: "Z:\\NotInstalled\\Bin\\Git\\git.exe",
    });

    expect(config.execution?.processHostPath).toBe("Z:\\NotInstalled\\Bin\\ProcessHost.exe");
  });

  it("rejects a drive root data directory while execution is disabled", () => {
    expect(() =>
      loadWorkerConfig({
        ...baseEnvironment(),
        WORKER_EXECUTION_ENABLED: "false",
        WORKER_DATA_DIR: "D:\\",
      }),
    ).toThrow(/WORKER_DATA_DIR must not be a filesystem root/u);
  });

  it.each([
    "WORKER_TRUSTED_EXECUTABLE_ROOT",
    "WORKER_PROCESS_HOST_PATH",
    "WORKER_PROCESS_HOST_SHA256",
    "WORKER_CODEX_EXECUTABLE_PATH",
    "WORKER_CODEX_SHA256",
    "WORKER_CODEX_VERSION",
    "WORKER_GIT_EXECUTABLE_PATH",
    "WORKER_GIT_SHA256",
    "WORKER_WORKSPACE_ROOT_DIRECTORY",
    "WORKER_EXECUTION_TEMP_DIRECTORY",
    "WORKER_EXECUTION_PROFILE_DIRECTORY",
  ])("requires %s when execution is enabled", (name) => {
    const environment = enabledEnvironment();
    delete environment[name];

    expect(() => loadWorkerConfig(environment)).toThrow(new RegExp(`${name} is required`, "u"));
  });
});

describe("Worker execution path policy", () => {
  it.each([
    ["WORKER_TRUSTED_EXECUTABLE_ROOT", "\\\\server\\share\\bin", /local Windows drive/u],
    [
      "WORKER_PROCESS_HOST_PATH",
      "\\\\?\\C:\\AgenticReview\\Bin\\ProcessHost.exe",
      /local Windows drive/u,
    ],
    [
      "WORKER_CODEX_EXECUTABLE_PATH",
      "C:\\AgenticReview\\Bin\\Codex\\..\\codex.exe",
      /unsafe Windows path/u,
    ],
    [
      "WORKER_GIT_EXECUTABLE_PATH",
      "C:\\AgenticReview\\Bin\\Git\\git.exe:payload",
      /alternate data stream/u,
    ],
    ["WORKER_WORKSPACE_ROOT_DIRECTORY", "D:\\AgenticReview\\Data\\CON", /reserved/u],
    ["WORKER_EXECUTION_TEMP_DIRECTORY", "D:\\AgenticReview\\Data\\Temp.", /unsafe/u],
    ["WORKER_EXECUTION_PROFILE_DIRECTORY", "D:\\AgenticReview\\Data\\Profile ", /whitespace/u],
    ["WORKER_DATA_DIR", "/var/lib/agentic-review", /local Windows drive/u],
  ])("rejects unsafe Windows path in %s", (name, value, expected) => {
    expect(() => loadWorkerConfig({ ...enabledEnvironment(), [name]: value })).toThrow(expected);
  });

  it("requires every executable to be a distinct child of the trusted root", () => {
    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_CODEX_EXECUTABLE_PATH: "C:\\Other\\codex.exe",
      }),
    ).toThrow(/WORKER_CODEX_EXECUTABLE_PATH must be contained beneath/u);

    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_GIT_EXECUTABLE_PATH: enabledEnvironment().WORKER_CODEX_EXECUTABLE_PATH,
      }),
    ).toThrow(/must not overlap/u);

    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_PROCESS_HOST_PATH: "C:\\AgenticReview\\Bin\\ProcessHost.cmd",
      }),
    ).toThrow(/\.exe file/u);
  });

  it("keeps trusted executables and mutable data in disjoint roots", () => {
    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_DATA_DIR: "C:\\AgenticReview\\Bin\\Data",
        WORKER_WORKSPACE_ROOT_DIRECTORY: "C:\\AgenticReview\\Bin\\Data\\Workspaces",
        WORKER_EXECUTION_TEMP_DIRECTORY: "C:\\AgenticReview\\Bin\\Data\\Temp",
        WORKER_EXECUTION_PROFILE_DIRECTORY: "C:\\AgenticReview\\Bin\\Data\\Profile",
      }),
    ).toThrow(/trusted executable root and data root must not overlap/u);
  });

  it.each([
    ["WORKER_TRUSTED_EXECUTABLE_ROOT", "C:\\"],
    ["WORKER_DATA_DIR", "D:\\"],
    ["WORKER_GIT_SHARED_ROOT_DIRECTORY", "D:\\"],
    ["WORKER_WORKSPACE_ROOT_DIRECTORY", "D:\\"],
    ["WORKER_EXECUTION_TEMP_DIRECTORY", "D:\\"],
    ["WORKER_EXECUTION_PROFILE_DIRECTORY", "D:\\"],
  ])("rejects filesystem root in %s", (name, value) => {
    expect(() => loadWorkerConfig({ ...enabledEnvironment(), [name]: value })).toThrow(
      new RegExp(`${name} must not be a filesystem root`, "u"),
    );
  });

  it("requires mutable execution directories to be disjoint children of the data root", () => {
    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_GIT_SHARED_ROOT_DIRECTORY: "E:\\Outside\\Repositories",
      }),
    ).toThrow(/WORKER_GIT_SHARED_ROOT_DIRECTORY must be contained beneath/u);

    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_WORKSPACE_ROOT_DIRECTORY: "E:\\Outside\\Workspaces",
      }),
    ).toThrow(/WORKER_WORKSPACE_ROOT_DIRECTORY must be contained beneath/u);

    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_EXECUTION_TEMP_DIRECTORY: "D:\\AgenticReview\\Data\\Workspaces\\Temp",
      }),
    ).toThrow(/must not overlap/u);
  });
});

describe("Worker execution identity policy", () => {
  it.each([
    ["WORKER_PROCESS_HOST_SHA256", "A".repeat(64)],
    ["WORKER_CODEX_SHA256", "a".repeat(63)],
    ["WORKER_GIT_SHA256", `${"a".repeat(63)}g`],
  ])("rejects invalid digest in %s", (name, value) => {
    expect(() => loadWorkerConfig({ ...enabledEnvironment(), [name]: value })).toThrow(
      /64 lowercase hexadecimal/u,
    );
  });

  it.each(["not-configured", "NOT-CONFIGURED", "", "v".repeat(129)])(
    "rejects unavailable Codex version %j when enabled",
    (value) => {
      expect(() =>
        loadWorkerConfig({ ...enabledEnvironment(), WORKER_CODEX_VERSION: value }),
      ).toThrow(/WORKER_CODEX_VERSION/u);
    },
  );

  it("rejects obsolete validation recipe advertisement", () => {
    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_RECIPE_IDS: "powertoys.build.x64",
      }),
    ).toThrow(/not used by the trusted-code Worker/u);
  });
});

describe("Worker registration metadata policy", () => {
  it.each(["", " ", "x".repeat(129), "worker\r\nforged"])(
    "rejects invalid display name %j",
    (displayName) => {
      expect(() =>
        loadWorkerConfig({ ...baseEnvironment(), WORKER_DISPLAY_NAME: displayName }),
      ).toThrow(/WORKER_DISPLAY_NAME/u);
    },
  );

  it.each(["", "version 1", "1.2.3/forged", "1.2.3\r\nX-Test: forged", "v".repeat(129)])(
    "rejects invalid User-Agent version %j",
    (workerVersion) => {
      expect(() =>
        loadWorkerConfig({ ...baseEnvironment(), WORKER_VERSION: workerVersion }),
      ).toThrow(/WORKER_VERSION/u);
    },
  );

  it("accepts bounded metadata and reserves two label entries for execution state", () => {
    const customLabels = Object.fromEntries(
      Array.from({ length: 62 }, (_, index) => [`label-${index}`, `value-${index}`]),
    );
    const config = loadWorkerConfig({
      ...baseEnvironment(),
      WORKER_DISPLAY_NAME: "PowerToys Review Worker",
      WORKER_VERSION: "1.2.3+build.7",
      WORKER_LABELS_JSON: JSON.stringify(customLabels),
    });

    expect(config.displayName).toBe("PowerToys Review Worker");
    expect(config.workerVersion).toBe("1.2.3+build.7");
    expect(Object.keys(config.capabilities.labels)).toHaveLength(64);
  });

  it("rejects label count, key, and value limits before registration", () => {
    const tooManyLabels = Object.fromEntries(
      Array.from({ length: 63 }, (_, index) => [`label-${index}`, "value"]),
    );
    expect(() =>
      loadWorkerConfig({
        ...baseEnvironment(),
        WORKER_LABELS_JSON: JSON.stringify(tooManyLabels),
      }),
    ).toThrow(/at most 64 entries/u);
    expect(() =>
      loadWorkerConfig({
        ...baseEnvironment(),
        WORKER_LABELS_JSON: JSON.stringify({ ["k".repeat(65)]: "value" }),
      }),
    ).toThrow(/keys must contain 1 through 64/u);
    expect(() =>
      loadWorkerConfig({
        ...baseEnvironment(),
        WORKER_LABELS_JSON: JSON.stringify({ key: "v".repeat(257) }),
      }),
    ).toThrow(/values must not exceed 256/u);
  });
});

describe("Worker execution shutdown policy", () => {
  it("accepts the configured shutdown grace period independently of service hosting", () => {
    const config = loadWorkerConfig({
      ...enabledEnvironment(),
      WORKER_SHUTDOWN_GRACE_SECONDS: "3600",
    });

    expect(config.shutdownGraceSeconds).toBe(3_600);
  });

  it("does not apply execution shutdown phases while execution is disabled", () => {
    const config = loadWorkerConfig({
      ...baseEnvironment(),
      WORKER_EXECUTION_ENABLED: "false",
      WORKER_SHUTDOWN_GRACE_SECONDS: "3600",
      WORKER_PROCESS_HOST_REQUEST_TIMEOUT_MS: "300000",
      WORKER_PROCESS_HOST_SHUTDOWN_TIMEOUT_MS: "300000",
    });

    expect(config.shutdownGraceSeconds).toBe(3_600);
  });
});

describe("Worker execution resource policy", () => {
  it.each([
    ["WORKER_CODEX_MAX_PROCESSES", "257"],
    ["WORKER_GIT_MAX_MEMORY_BYTES", String(128 * mebibyte - 1)],
    ["WORKER_CODEX_MAX_OUTPUT_BYTES", String(128 * mebibyte + 1)],
    ["WORKER_CODEX_MAXIMUM_HARD_TIMEOUT_MS", "9999"],
    ["WORKER_GIT_HARD_TIMEOUT_MS", String(2 * 60 * 60 * 1_000 + 1)],
    ["WORKER_PROCESS_HOST_REQUEST_TIMEOUT_MS", "999"],
    ["WORKER_PROCESS_HOST_START_TIMEOUT_MS", "300001"],
    ["WORKER_PROCESS_HOST_SHUTDOWN_TIMEOUT_MS", "not-an-integer"],
    ["WORKER_EXECUTION_TOTAL_MAX_MEMORY_BYTES", "9007199254740992"],
  ])("rejects out-of-range or unsafe integer %s", (name, value) => {
    expect(() => loadWorkerConfig({ ...enabledEnvironment(), [name]: value })).toThrow(
      new RegExp(name, "u"),
    );
  });

  it("rejects slot multiplication that exceeds a total resource budget", () => {
    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_MAX_SLOTS: "3",
        WORKER_EXECUTION_TOTAL_MAX_PROCESSES: "96",
      }),
    ).toThrow(/Codex memory multiplied by WORKER_MAX_SLOTS/u);

    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_EXECUTION_TOTAL_MAX_PROCESSES: "63",
      }),
    ).toThrow(/Codex process count multiplied by WORKER_MAX_SLOTS/u);

    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_EXECUTION_TOTAL_MAX_OUTPUT_BYTES: String(16 * mebibyte - 1),
      }),
    ).toThrow(/Codex output multiplied by WORKER_MAX_SLOTS/u);

    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_CODEX_MAX_PROCESSES: "1",
        WORKER_CODEX_MAX_MEMORY_BYTES: String(128 * mebibyte),
        WORKER_CODEX_MAX_OUTPUT_BYTES: "4096",
        WORKER_MAX_SLOTS: "9",
      }),
    ).toThrow(/Git process count multiplied by WORKER_MAX_SLOTS/u);
  });

  it("accepts multiple slots when per-task resources fit every total budget", () => {
    const config = loadWorkerConfig({
      ...enabledEnvironment(),
      WORKER_MAX_SLOTS: "4",
      WORKER_CODEX_MAX_PROCESSES: "16",
      WORKER_CODEX_MAX_MEMORY_BYTES: String(4 * gibibyte),
      WORKER_CODEX_MAX_OUTPUT_BYTES: String(8 * mebibyte),
      WORKER_GIT_MAX_PROCESSES: "8",
      WORKER_GIT_MAX_MEMORY_BYTES: String(2 * gibibyte),
      WORKER_GIT_MAX_OUTPUT_BYTES: String(4 * mebibyte),
      WORKER_EXECUTION_TOTAL_WORKSPACE_DISK_BYTES: String(64 * gibibyte),
    });

    expect(config.maxSlots).toBe(4);
    expect(config.execution?.totalResourceBudget).toEqual({
      maximumProcessCount: 64,
      maximumMemoryBytes: 16 * gibibyte,
      maximumOutputBytes: 64 * mebibyte,
    });
  });
});

describe("Worker execution disk policy", () => {
  it.each([
    ["WORKER_EXECUTION_PER_ATTEMPT_DISK_BYTES", String(512 * mebibyte - 1)],
    ["WORKER_EXECUTION_TOTAL_WORKSPACE_DISK_BYTES", "9007199254740992"],
    ["WORKER_EXECUTION_MINIMUM_FREE_DISK_BYTES", String(gibibyte - 1)],
    ["WORKER_EXECUTION_ORPHAN_RETENTION_HOURS", "0"],
    ["WORKER_EXECUTION_ORPHAN_SCAN_LIMIT", "10001"],
  ])("rejects unsafe disk or orphan setting %s", (name, value) => {
    expect(() => loadWorkerConfig({ ...enabledEnvironment(), [name]: value })).toThrow(
      new RegExp(name, "u"),
    );
  });

  it("requires aggregate attempt disk limits to fit the workspace budget", () => {
    expect(() =>
      loadWorkerConfig({
        ...enabledEnvironment(),
        WORKER_EXECUTION_TOTAL_WORKSPACE_DISK_BYTES: String(32 * gibibyte - 1),
      }),
    ).toThrow(/Per-attempt disk multiplied by WORKER_MAX_SLOTS/u);
  });

  it("accepts explicit bounded disk and orphan cleanup settings", () => {
    const config = loadWorkerConfig({
      ...enabledEnvironment(),
      WORKER_EXECUTION_PER_ATTEMPT_DISK_BYTES: String(8 * gibibyte),
      WORKER_EXECUTION_TOTAL_WORKSPACE_DISK_BYTES: String(24 * gibibyte),
      WORKER_EXECUTION_MINIMUM_FREE_DISK_BYTES: String(12 * gibibyte),
      WORKER_EXECUTION_ORPHAN_RETENTION_HOURS: "48",
      WORKER_EXECUTION_ORPHAN_SCAN_LIMIT: "250",
    });

    expect(config.execution).toMatchObject({
      perAttemptDiskBytes: 8 * gibibyte,
      totalWorkspaceDiskBytes: 24 * gibibyte,
      minimumFreeDiskBytes: 12 * gibibyte,
      orphanRetentionHours: 48,
      orphanScanLimit: 250,
    });
  });
});

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    WORKER_SERVER_URL: "http://127.0.0.1:8080",
    WORKER_ALLOW_INSECURE_HTTP: "true",
    WORKER_DATA_DIR: "D:\\AgenticReview\\Data",
    WORKER_RECIPE_IDS: "",
  };
}

function enabledEnvironment(): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment(),
    WORKER_EXECUTION_ENABLED: "true",
    WORKER_MAX_SLOTS: "2",
    WORKER_TRUSTED_EXECUTABLE_ROOT: "c:/AgenticReview/Bin/",
    WORKER_PROCESS_HOST_PATH: "c:/AgenticReview/Bin/AgenticReview.ProcessHost.exe",
    WORKER_PROCESS_HOST_SHA256: "a".repeat(64),
    WORKER_CODEX_EXECUTABLE_PATH: "c:/AgenticReview/Bin/Codex/codex.exe",
    WORKER_CODEX_SHA256: "b".repeat(64),
    WORKER_CODEX_VERSION: "codex-cli 1.2.3",
    WORKER_GIT_EXECUTABLE_PATH: "c:/AgenticReview/Bin/Git/git.exe",
    WORKER_GIT_SHA256: "c".repeat(64),
    WORKER_WORKSPACE_ROOT_DIRECTORY: "d:/AgenticReview/Data/Workspaces",
    WORKER_EXECUTION_TEMP_DIRECTORY: "d:/AgenticReview/Data/Temp",
    WORKER_EXECUTION_PROFILE_DIRECTORY: "d:/AgenticReview/Data/Profile",
  };
}

const tlsCaPath = "C:\\AgenticReview\\Secrets\\server-ca.pem";

function httpsEnvironment(): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment(),
    WORKER_SERVER_URL: "https://review.internal",
    WORKER_ALLOW_INSECURE_HTTP: "false",
  };
}

function loadWorkerConfig(
  environment: NodeJS.ProcessEnv,
  dependencies: WorkerConfigDependencies = {},
): WorkerConfig {
  return loadWorkerConfigProduction(environment, {
    ...dependencies,
    workerAuthFileReader: dependencies.workerAuthFileReader ?? (() => workerAuthProfileBytes()),
  });
}

function workerAuthProfile(): Readonly<Record<string, unknown>> {
  return {
    profileId: "agentic-review-worker-auth-v1",
    token: workerToken,
    workerNodeId,
  };
}

function workerAuthProfileBytes(): Buffer {
  return Buffer.from(JSON.stringify(workerAuthProfile()), "utf8");
}

function secretMetadata(
  size: bigint,
  overrides: Partial<StableSecretFileMetadata> = {},
): StableSecretFileMetadata {
  return {
    device: 3n,
    inode: 17n,
    size,
    mode: 0o100600n,
    linkCount: 1n,
    modifiedTimeNanoseconds: 41n,
    changedTimeNanoseconds: 43n,
    isFile: true,
    isSymbolicLink: false,
    ...overrides,
  };
}

function createSecretFileSystem(files: ReadonlyMap<string, Buffer>) {
  let openedPath: string | undefined;
  const metadataFor = (path: string): StableSecretFileMetadata => {
    const content = files.get(path);
    if (content === undefined) {
      throw new Error("missing test file");
    }
    return secretMetadata(BigInt(content.length));
  };
  const lstat = vi.fn((path: string) => metadataFor(path));
  const realpath = vi.fn((path: string) => path);
  const open = vi.fn((path: string) => {
    metadataFor(path);
    openedPath = path;
    return 47;
  });
  const fstat = vi.fn((_descriptor: number) => {
    if (openedPath === undefined) {
      throw new Error("test descriptor is not open");
    }
    return metadataFor(openedPath);
  });
  const read = vi.fn(
    (_descriptor: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (openedPath === undefined) {
        throw new Error("test descriptor is not open");
      }
      const content = files.get(openedPath);
      if (content === undefined) {
        throw new Error("missing test file");
      }
      const bytesRead = Math.min(length, Math.max(0, content.length - position));
      content.copy(buffer, offset, position, position + bytesRead);
      return bytesRead;
    },
  );
  const close = vi.fn((_descriptor: number) => {
    openedPath = undefined;
  });
  const fileSystem: SecretFileSystem = { lstat, realpath, open, fstat, read, close };

  return { fileSystem, lstat, realpath, open, fstat, read, close };
}
