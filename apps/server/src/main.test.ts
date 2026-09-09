import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AppDependencies } from "./app.js";
import type { GitHubIngestionHealthSource } from "./github/ingestion-health.js";
import { GitHubPollingInvariantError } from "./github/poller.js";
import type { GitHubPollingCoordinatorOptions } from "./github/polling-coordinator.js";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(sourceRoot, "main.ts");

const listTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
};

describe("production server composition", () => {
  it.each([
    { recoveryMaintenance: false, configured: true },
    { recoveryMaintenance: true, configured: true },
    { recoveryMaintenance: false, configured: false },
  ])(
    "forwards trusted administrators to storage for recovery=$recoveryMaintenance configured=$configured",
    async ({ recoveryMaintenance, configured }) => {
      vi.resetModules();
      const operatorAccess = {
        administrators: [{ issuer: "urn:fixture", subject: "Admin-Exact" }],
      };
      const config = {
        recoveryMaintenance,
        databasePath: "/private/database/server.sqlite",
        migrationsDirectory: "/app/migrations",
        github: undefined,
        ...(configured
          ? {
              operatorAccess,
              operatorAuth: {
                service: {
                  mode: "loopback",
                  developmentIdentity: {
                    ...operatorAccess.administrators[0],
                    displayName: "An untrusted display name",
                    email: null,
                  },
                },
                oidc: undefined,
              },
            }
          : {}),
      };
      const databaseRequest = vi.fn(async () => undefined);
      const storage = { database: { request: databaseRequest } };
      const production = vi.fn(async () => storage);
      const recovery = vi.fn(async () => storage);
      const mockedModules = [
        "./app.js",
        "./config.js",
        "./runtime/server-lifecycle.js",
        "./runtime/server-platform.js",
        "./runtime/server-storage-runtime.js",
        "./security/operator-auth.js",
      ];
      vi.doMock("./config.js", () => ({ loadConfig: () => config }));
      vi.doMock("./app.js", () => ({
        buildApp: () => ({ listen: async () => undefined, log: { info: vi.fn(), error: vi.fn() } }),
      }));
      vi.doMock("./runtime/server-platform.js", () => ({ assertLinuxServerPlatform: vi.fn() }));
      vi.doMock("./runtime/server-lifecycle.js", () => ({
        createProductionServerLifecycle: () => ({
          signal: new AbortController().signal,
          completion: Promise.resolve(),
          admission: {},
          adoptStorageRuntime: vi.fn(),
          adoptApplication: vi.fn(),
          markRunning: vi.fn(),
          sealStartupFailure: (error: unknown) => {
            throw error;
          },
        }),
      }));
      vi.doMock("./runtime/server-storage-runtime.js", () => ({
        createServerStorageRuntime: production,
        createRecoveryMaintenanceStorageRuntime: recovery,
      }));
      vi.doMock("./security/operator-auth.js", () => ({ OperatorAuthService: class {} }));
      try {
        await import("./main.js");
        const selected = recoveryMaintenance ? recovery : production;
        const unselected = recoveryMaintenance ? production : recovery;
        expect(selected).toHaveBeenCalledExactlyOnceWith({
          databasePath: config.databasePath,
          migrationsDirectory: config.migrationsDirectory,
          ...(configured ? { operatorAccess } : {}),
        });
        expect(unselected).not.toHaveBeenCalled();
        if (recoveryMaintenance)
          expect(databaseRequest).toHaveBeenCalledWith("purgeOperatorAuthForRecovery", {});
        else expect(databaseRequest).not.toHaveBeenCalled();
      } finally {
        for (const module of mockedModules) vi.doUnmock(module);
        vi.resetModules();
      }
    },
  );

  it("tracks committed reconciliation health and logs bounded polling failure details", async () => {
    const token = "test-polling-secret";
    const repository = { githubRepositoryId: 1, fullName: "owner/repository" };
    const reviewer = { githubUserId: 2, login: "reviewer" };
    const logError = vi.fn();
    const databaseRequest = vi.fn(async (_operation: string, _input: unknown) => ({
      eventResults: [],
    }));
    let pollingOptions: GitHubPollingCoordinatorOptions | undefined;
    let githubHealth: GitHubIngestionHealthSource | undefined;
    const mockedModules = [
      "./app.js",
      "./config.js",
      "./github/ingestion-service.js",
      "./github/polling-coordinator.js",
      "./runtime/server-lifecycle.js",
      "./runtime/server-platform.js",
      "./runtime/server-storage-runtime.js",
      "./runtime/managed-github-configuration.js",
      "./scheduling/index.js",
    ];
    vi.doMock("./app.js", () => ({
      buildApp: (dependencies: AppDependencies) => {
        githubHealth = dependencies.githubHealth;
        return {
          listen: async () => undefined,
          log: { error: logError, info: vi.fn(), warn: vi.fn() },
        };
      },
    }));
    vi.doMock("./config.js", () => ({
      loadConfig: () => ({
        recoveryMaintenance: false,
        github: {
          legacyBootstrap: undefined,
          polling: { token, intervalSeconds: 60 },
        },
      }),
    }));
    vi.doMock("./github/ingestion-service.js", () => ({
      GitHubEventIngestionService: class {},
    }));
    vi.doMock("./github/polling-coordinator.js", () => ({
      GitHubPollingCoordinator: class {
        constructor(options: GitHubPollingCoordinatorOptions) {
          pollingOptions = options;
        }
        async run(): Promise<void> {}
      },
    }));
    vi.doMock("./runtime/server-lifecycle.js", () => ({
      createProductionServerLifecycle: () => ({
        signal: new AbortController().signal,
        completion: Promise.resolve(),
        admission: { read: () => true },
        adoptStorageRuntime: vi.fn(),
        adoptApplication: vi.fn(),
        trackBackground: vi.fn(),
        markRunning: vi.fn(),
        sealStartupFailure: (error: unknown) => {
          throw error;
        },
      }),
    }));
    vi.doMock("./runtime/server-platform.js", () => ({ assertLinuxServerPlatform: vi.fn() }));
    vi.doMock("./runtime/server-storage-runtime.js", () => ({
      createServerStorageRuntime: async () => ({ database: { request: databaseRequest } }),
    }));
    vi.doMock("./runtime/managed-github-configuration.js", () => ({
      ManagedGitHubRuntimeConfiguration: class {
        async listPollingTargets() {
          return [{ repository, reviewer }];
        }
        async prepareReconciliation() {
          return [];
        }
      },
    }));
    vi.doMock("./scheduling/index.js", () => ({
      defaultTrustedSchedulingPolicy: {},
      loadTrustedSchedulingConfig: async () => ({
        pullRequestReview: { text: "Review the exact PR revision." },
        issueTriage: { text: "Triage this issue without execution." },
      }),
    }));

    try {
      await import("./main.js");
      const observeError = pollingOptions?.observeError;
      expect(observeError).toBeTypeOf("function");
      expect(pollingOptions?.repositories).toBeUndefined();
      expect(pollingOptions?.reviewer).toBeUndefined();
      await expect(pollingOptions?.resolveTargets?.()).resolves.toEqual([{ repository, reviewer }]);
      expect(
        databaseRequest.mock.calls.some(
          ([operation]) => operation === "bootstrapManagedRepositories",
        ),
      ).toBe(false);
      expect(databaseRequest).toHaveBeenCalledWith("bootstrapPromptTemplates", expect.any(Object));
      expect(githubHealth?.getHealth()).toMatchObject({ status: "healthy" });
      const context = { repository, reviewer };
      const invariantError = new GitHubPollingInvariantError("The search page is incomplete.");
      Object.assign(invariantError, { responseBody: token, cause: new Error(token) });
      await observeError?.(invariantError, context);
      expect(githubHealth?.getHealth()).toMatchObject({ status: "degraded" });
      expect(JSON.stringify(githubHealth?.getHealth())).not.toContain(token);
      expect(JSON.parse(JSON.stringify(logError.mock.calls[0]?.[0]))).toEqual({
        error: {
          name: "GitHubPollingInvariantError",
          message: "The search page is incomplete.",
        },
        repository: repository.fullName,
      });

      const longError = new Error(`${token}\n${"m".repeat(3_000)}`);
      longError.name = `${token}\r${"n".repeat(200)}`;
      await observeError?.(longError, context);
      const boundedLog = logError.mock.calls[1]?.[0];
      expect(boundedLog.error.name).toHaveLength(128);
      expect(boundedLog.error.message).toHaveLength(2_048);
      expect(boundedLog.error.name).toMatch(/^\[REDACTED\] n+$/u);
      expect(boundedLog.error.message).toMatch(/^\[REDACTED\] m+$/u);
      expect(JSON.stringify(boundedLog)).not.toContain(token);

      await observeError?.({ message: token, responseBody: token }, context);
      expect(logError.mock.calls[2]?.[0]).toEqual({
        error: {
          name: "UnknownError",
          message: "The GitHub polling operation received a non-Error failure.",
        },
        repository: repository.fullName,
      });

      const key = {
        githubRepositoryId: repository.githubRepositoryId,
        repositoryFullName: repository.fullName,
        reviewerGithubUserId: reviewer.githubUserId,
      };
      const projection = {
        ...key,
        version: 1 as const,
        reviewerLogin: reviewer.login,
        workItems: [],
      };
      const commitReconciliation = pollingOptions?.commitReconciliation;
      expect(commitReconciliation).toBeTypeOf("function");
      let finishCommit: ((result: { eventResults: [] }) => void) | undefined;
      databaseRequest.mockImplementationOnce(
        () =>
          new Promise<{ eventResults: [] }>((resolve) => {
            finishCommit = resolve;
          }),
      );
      const committing = commitReconciliation?.(key, [], projection, new AbortController().signal);
      expect(githubHealth?.getHealth()).toMatchObject({ status: "degraded" });
      await vi.waitFor(() => expect(finishCommit).toBeTypeOf("function"));
      finishCommit?.({ eventResults: [] });
      await committing;
      expect(githubHealth?.getHealth()).toMatchObject({ status: "healthy" });
      expect(databaseRequest).toHaveBeenCalledWith(
        "commitGitHubPollingReconciliation",
        expect.objectContaining({ key, projection, events: [] }),
      );

      await observeError?.(new Error("Read failed."), context);
      const failedCommit = new Error("Checkpoint persistence failed.");
      databaseRequest.mockRejectedValueOnce(failedCommit);
      await expect(
        commitReconciliation?.(key, [], projection, new AbortController().signal),
      ).rejects.toThrow(failedCommit);
      expect(githubHealth?.getHealth()).toMatchObject({ status: "degraded" });
    } finally {
      for (const module of mockedModules) {
        vi.doUnmock(module);
      }
      vi.resetModules();
    }
  });

  it("keeps storage and process shutdown under the production lifecycle", async () => {
    const source = await readFile(sourcePath, "utf8");

    for (const required of [
      "assertLinuxServerPlatform();",
      "createProductionServerLifecycle({",
      "await createRecoveryMaintenanceStorageRuntime({",
      "await createServerStorageRuntime({",
      "lifecycle.adoptStorageRuntime(storageRuntime);",
      'await database.request("purgeOperatorAuthForRecovery", {});',
      "serverAdmission: lifecycle.admission",
      "lifecycle.adoptApplication(app);",
      'lifecycle.trackBackground("github-polling", pollingCompletion);',
      "config.recoveryMaintenance || config.github === undefined",
      "!config.recoveryMaintenance",
      "lifecycle.markRunning();",
      "error === lifecycle.signal.reason",
      "Agentic Review server startup was stopped.",
      "lifecycle.sealStartupShutdown();",
      "lifecycle.sealStartupFailure(error);",
      'lifecycle.requestGracefulShutdown("SIGINT")',
      'lifecycle.requestGracefulShutdown("SIGTERM")',
    ]) {
      expect(source).toContain(required);
    }

    for (const forbidden of [
      "DatabaseOwnerLock",
      "closeDatabaseStorage",
      "process.exitCode",
      "setImmediate",
      "artifactRootPath",
      "worker-artifacts",
      "registerWorkerArtifactRoutes",
    ]) {
      expect(source).not.toContain(forbidden);
    }

    const platformCheck = source.indexOf("assertLinuxServerPlatform();");
    const lifecycleCreate = source.indexOf("createProductionServerLifecycle({");
    const storageCreate = source.indexOf("await createServerStorageRuntime({");
    const recoveryStorageCreate = source.indexOf("await createRecoveryMaintenanceStorageRuntime({");
    const storageAdoption = source.indexOf("lifecycle.adoptStorageRuntime(storageRuntime);");
    const appCreate = source.indexOf("const app = buildApp({");
    const recoveryPurge = source.indexOf('await database.request("purgeOperatorAuthForRecovery"');
    const appAdoption = source.indexOf("lifecycle.adoptApplication(app);");
    const listen = source.indexOf("await app.listen(");
    const backgroundTracking = source.indexOf("lifecycle.trackBackground(");
    const running = source.indexOf("lifecycle.markRunning();");

    expect(platformCheck).toBeLessThan(lifecycleCreate);
    expect(storageCreate).toBeLessThan(storageAdoption);
    expect(recoveryStorageCreate).toBeLessThan(storageAdoption);
    expect(storageAdoption).toBeLessThan(recoveryPurge);
    expect(recoveryPurge).toBeLessThan(appCreate);
    expect(storageAdoption).toBeLessThan(appCreate);
    expect(appCreate).toBeLessThan(appAdoption);
    expect(appAdoption).toBeLessThan(listen);
    expect(listen).toBeLessThan(backgroundTracking);
    expect(backgroundTracking).toBeLessThan(running);
  });

  it("keeps main as the only production composition root", async () => {
    const productionSources = await Promise.all(
      (await listTypeScriptFiles(sourceRoot))
        .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".testing.ts"))
        .map(async (path) => ({
          path: relative(sourceRoot, path).replaceAll("\\", "/"),
          source: await readFile(path, "utf8"),
        })),
    );
    const references = (identifier: string): string[] =>
      productionSources
        .filter(({ source }) => source.includes(identifier))
        .map(({ path }) => path)
        .sort();

    expect(references("createProductionServerLifecycle")).toEqual([
      "main.ts",
      "runtime/server-lifecycle.ts",
    ]);
    expect(references("createServerStorageRuntime")).toEqual([
      "main.ts",
      "runtime/server-storage-runtime.ts",
    ]);
    expect(references("createRecoveryMaintenanceStorageRuntime")).toEqual([
      "main.ts",
      "runtime/server-storage-runtime.ts",
    ]);
    expect(references("buildApp")).toEqual(["app.ts", "main.ts"]);
  });
});
