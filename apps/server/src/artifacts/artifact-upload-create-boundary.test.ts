import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = dirname(fileURLToPath(new URL("../artifacts", import.meta.url)));

const listTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
};

describe("artifact transaction composition boundary", () => {
  it("keeps the artifact storage owner on the dedicated Worker Thread transport", async () => {
    const productionSources = await Promise.all(
      (await listTypeScriptFiles(sourceRoot))
        .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".testing.ts"))
        .map(async (path) => ({
          path: relative(sourceRoot, path).replaceAll("\\", "/"),
          source: await readFile(path, "utf8"),
        })),
    );
    const references = (needle: string): string[] =>
      productionSources
        .filter(({ source }) => source.includes(needle))
        .map(({ path }) => path)
        .sort();
    const workerOnly = ["artifacts/artifact-storage-worker.ts"];
    expect(references('from "./artifact-storage.js"')).toEqual(workerOnly);
    expect(references('from "./linux-filesystem.js"')).toEqual(workerOnly);
    expect(references("new ArtifactStorageKernel(")).toEqual(workerOnly);
    expect(references("new LinuxArtifactStorageOperations(")).toEqual(workerOnly);
    expect(references("runArtifactStorageWorker(")).toEqual(workerOnly);
    expect(references('new URL("./artifact-storage-worker')).toEqual([
      "artifacts/artifact-storage-client.ts",
    ]);
    expect(references("new Worker(filename, options)")).toEqual([
      "artifacts/artifact-storage-client.ts",
    ]);
    expect(references("artifact-storage-process")).toEqual([]);

    const client = await readFile(
      join(sourceRoot, "artifacts", "artifact-storage-client.ts"),
      "utf8",
    );
    const worker = await readFile(
      join(sourceRoot, "artifacts", "artifact-storage-worker.ts"),
      "utf8",
    );
    expect(client).toContain('from "node:worker_threads"');
    expect(client).toContain("trackUnmanagedFds: true");
    expect(worker).toContain('from "node:worker_threads"');
    for (const source of [client, worker]) {
      expect(source).not.toContain('from "node:child_process"');
      expect(source).not.toContain("SIGKILL");
    }

    const compiledArtifacts = await readdir(join(sourceRoot, "..", "dist", "artifacts"));
    expect(compiledArtifacts).toContain("artifact-storage-worker.js");
    expect(
      compiledArtifacts.filter((path) => path.startsWith("artifact-storage-process.")),
    ).toEqual([]);
  });

  it("limits the internal handle registrar to DatabaseClient and fake-owner tests", async () => {
    const reference = "registerArtifactUploadCreateDatabaseHandle";
    const references: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      if ((await readFile(path, "utf8")).includes(reference)) {
        references.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }
    expect(references.sort()).toEqual(
      [
        "artifacts/artifact-transaction-coordinator.test.ts",
        "artifacts/artifact-transaction-coordinator.ts",
        "artifacts/artifact-upload-create-boundary.test.ts",
        "artifacts/artifact-upload-create-coordinator.test.ts",
        "artifacts/artifact-upload-create-coordinator.ts",
      ].sort(),
    );
  });

  it("keeps internal factories out of the public artifact barrel", async () => {
    const barrel = await readFile(join(sourceRoot, "artifacts", "index.ts"), "utf8");
    expect(barrel).not.toContain("registerArtifactUploadCreateDatabaseHandle");
    expect(barrel).not.toContain("attachArtifactUploadCreateDatabaseForTest");
    expect(barrel).not.toContain("registerArtifactTransaction");
    expect(barrel).not.toContain("revokeArtifactTransaction");
    expect(barrel).not.toContain("artifact-transaction-coordinator.testing");
  });

  it("omits every testing adapter from production output", async () => {
    const sourceFiles = await listTypeScriptFiles(sourceRoot);
    expect(
      sourceFiles
        .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
        .filter((path) => path.endsWith(".testing.ts"))
        .sort(),
    ).toEqual(
      ["runtime/server-lifecycle.testing.ts", "runtime/server-storage-runtime.testing.ts"].sort(),
    );
    const tsconfig = JSON.parse(
      await readFile(join(sourceRoot, "..", "tsconfig.json"), "utf8"),
    ) as { readonly exclude?: readonly string[] };
    expect(tsconfig.exclude).toContain("src/**/*.testing.ts");
    const packageManifest = JSON.parse(
      await readFile(join(sourceRoot, "..", "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    expect(packageManifest.scripts?.prebuild).toBe("node ./scripts/clean-build-output.mjs");
    expect(packageManifest.scripts?.clean).toBe(packageManifest.scripts?.prebuild);
    const cleanScript = await readFile(
      join(sourceRoot, "..", "scripts", "clean-build-output.mjs"),
      "utf8",
    );
    expect(cleanScript).toContain('resolve(packageDirectory, "dist")');
    expect(cleanScript).not.toContain("process.argv");
    const productionArtifacts = await readdir(join(sourceRoot, "..", "dist", "artifacts"));
    expect(productionArtifacts.filter((entry) => entry.includes(".testing."))).toEqual([]);
    const productionRuntime = await readdir(join(sourceRoot, "..", "dist", "runtime"));
    expect(productionRuntime.filter((entry) => entry.includes(".testing."))).toEqual([]);
  });

  it("keeps lifecycle effects behind the trusted-source architecture boundary", async () => {
    const coreModuleReference = `server-lifecycle-${"core.js"}`;
    const constructorReference = `new ${"ServerLifecycleCore"}(`;
    const coreSymbolReference = `ServerLifecycle${"Core"}`;
    const allImports: string[] = [];
    const productionImports: string[] = [];
    const allConstructors: string[] = [];
    const productionConstructors: string[] = [];
    const productionCoreReferences: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      const relativePath = relative(sourceRoot, path).replaceAll("\\", "/");
      const source = await readFile(path, "utf8");
      const production =
        !relativePath.endsWith(".test.ts") && !relativePath.endsWith(".testing.ts");
      if (source.includes(coreModuleReference)) {
        allImports.push(relativePath);
        if (production) productionImports.push(relativePath);
      }
      if (source.includes(constructorReference)) {
        allConstructors.push(relativePath);
        if (production) productionConstructors.push(relativePath);
      }
      if (production && source.includes(coreSymbolReference)) {
        productionCoreReferences.push(relativePath);
      }
    }

    expect(allImports.sort()).toEqual(
      ["runtime/server-lifecycle.testing.ts", "runtime/server-lifecycle.ts"].sort(),
    );
    expect(allConstructors.sort()).toEqual(
      ["runtime/server-lifecycle.testing.ts", "runtime/server-lifecycle.ts"].sort(),
    );
    expect(productionImports).toEqual(["runtime/server-lifecycle.ts"]);
    expect(productionConstructors).toEqual(["runtime/server-lifecycle.ts"]);
    expect(productionCoreReferences.sort()).toEqual(
      ["runtime/server-lifecycle-core.ts", "runtime/server-lifecycle.ts"].sort(),
    );

    const core = await readFile(join(sourceRoot, "runtime", "server-lifecycle-core.ts"), "utf8");
    expect(core).toContain("trusted-source architecture boundary");
    const lifecycle = await readFile(join(sourceRoot, "runtime", "server-lifecycle.ts"), "utf8");
    expect(lifecycle).not.toContain("export type {");
    const runtimeExports = await import("../../dist/runtime/server-lifecycle.js");
    expect(Object.keys(runtimeExports)).toEqual(["createProductionServerLifecycle"]);
  });

  it("keeps reconciliation registrars and testing adapters out of the public barrel", async () => {
    const barrelSource = await readFile(join(sourceRoot, "artifacts", "index.ts"), "utf8");
    const barrelRuntime = await import("../../dist/artifacts/index.js");
    const internalExports = [
      "registerArtifactReconciliationDatabaseHandle",
      "attachArtifactReconciliationDatabaseForTest",
      "consumeArtifactReconciliationDatabaseHandleForTest",
    ] as const;

    for (const exportName of internalExports) {
      expect(barrelSource).not.toContain(exportName);
      expect(Object.hasOwn(barrelRuntime, exportName)).toBe(false);
    }
    expect(barrelSource).not.toContain("artifact-reconciliation-coordinator.testing");
  });

  it("keeps the shared namespace contract independent from SQLite and database adapters", async () => {
    const contract = await readFile(
      join(sourceRoot, "artifacts", "artifact-namespace-contract.ts"),
      "utf8",
    );
    expect(contract).not.toContain("node:sqlite");
    expect(contract).not.toContain("../database/");
    for (const file of ["artifact-storage.ts", "linux-filesystem.ts", "worker-protocol.ts"]) {
      const source = await readFile(join(sourceRoot, "artifacts", file), "utf8");
      expect(source).not.toContain("../database/artifacts");
    }
  });

  it("limits the reconciliation handle registrar to DatabaseClient and fake-owner tests", async () => {
    const reference = "registerArtifactReconciliationDatabaseHandle";
    const references: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      if ((await readFile(path, "utf8")).includes(reference)) {
        references.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }
    expect(references.sort()).toEqual(
      [
        "artifacts/artifact-reconciliation-coordinator.test.ts",
        "artifacts/artifact-reconciliation-coordinator.ts",
        "artifacts/artifact-transaction-coordinator.ts",
        "artifacts/artifact-upload-create-boundary.test.ts",
      ].sort(),
    );
  });

  it("keeps coordinator construction in the single future composition root", async () => {
    const allowed = new Set([
      "artifacts/artifact-upload-create-boundary.test.ts",
      "artifacts/artifact-transaction-coordinator.ts",
      "artifacts/artifact-transaction-coordinator.test.ts",
      "artifacts/artifact-upload-create-coordinator.test.ts",
      "database/database-client.test.ts",
    ]);
    const unexpected: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      const relativePath = relative(sourceRoot, path).replaceAll("\\", "/");
      if (
        !allowed.has(relativePath) &&
        (await readFile(path, "utf8")).includes("ArtifactUploadCreateCoordinator.start(")
      ) {
        unexpected.push(relativePath);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it.each([
    [
      "registerArtifactTransactionDatabaseHandle",
      [
        "artifacts/artifact-transaction-coordinator.test.ts",
        "artifacts/artifact-transaction-coordinator.ts",
        "artifacts/artifact-upload-create-boundary.test.ts",
        "database/database-client.ts",
      ],
    ],
    [
      "registerArtifactTransactionStorageHandle",
      [
        "artifacts/artifact-storage-client.ts",
        "artifacts/artifact-transaction-coordinator.test.ts",
        "artifacts/artifact-transaction-coordinator.ts",
        "artifacts/artifact-upload-create-boundary.test.ts",
        "database/database-client.test.ts",
      ],
    ],
    [
      "registerArtifactTransactionOwnerLockHandle",
      [
        "artifacts/artifact-transaction-coordinator.test.ts",
        "artifacts/artifact-transaction-coordinator.ts",
        "artifacts/artifact-upload-create-boundary.test.ts",
        "database/database-client.test.ts",
        "database/owner-lock.ts",
      ],
    ],
  ] as const)(
    "limits %s to its production owner and excluded tests",
    async (reference, expected) => {
      const references: string[] = [];
      for (const path of await listTypeScriptFiles(sourceRoot)) {
        if ((await readFile(path, "utf8")).includes(reference)) {
          references.push(relative(sourceRoot, path).replaceAll("\\", "/"));
        }
      }
      expect(references.sort()).toEqual([...expected].sort());
    },
  );

  it.each([
    [
      "revokeArtifactTransactionDatabaseHandle",
      [
        "artifacts/artifact-transaction-coordinator.ts",
        "artifacts/artifact-upload-create-boundary.test.ts",
        "database/database-client.ts",
      ],
    ],
    [
      "revokeArtifactTransactionStorageHandle",
      [
        "artifacts/artifact-storage-client.ts",
        "artifacts/artifact-transaction-coordinator.ts",
        "artifacts/artifact-upload-create-boundary.test.ts",
      ],
    ],
    [
      "revokeArtifactTransactionOwnerLockHandle",
      [
        "artifacts/artifact-transaction-coordinator.ts",
        "artifacts/artifact-upload-create-boundary.test.ts",
        "database/owner-lock.ts",
      ],
    ],
  ] as const)("limits %s to the original owner module", async (reference, expected) => {
    const references: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      if ((await readFile(path, "utf8")).includes(reference)) {
        references.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }
    expect(references.sort()).toEqual([...expected].sort());
  });

  it("limits transaction coordinator construction to the reviewed lifecycle root", async () => {
    const allowed = new Set([
      "artifacts/artifact-upload-create-boundary.test.ts",
      "artifacts/artifact-transaction-coordinator.test.ts",
      "artifacts/artifact-transaction-coordinator.ts",
      "database/database-client.test.ts",
      "runtime/server-storage-runtime.ts",
    ]);
    const unexpected: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      const relativePath = relative(sourceRoot, path).replaceAll("\\", "/");
      if (
        !allowed.has(relativePath) &&
        (await readFile(path, "utf8")).includes("ArtifactTransactionCoordinator.create(")
      ) {
        unexpected.push(relativePath);
      }
    }
    expect(unexpected).toEqual([]);

    const runtime = await readFile(
      join(sourceRoot, "runtime", "server-storage-runtime.ts"),
      "utf8",
    );
    for (const method of [
      "createArtifactTransactionDatabaseHandle()",
      "createArtifactTransactionStorageHandle()",
      "createArtifactTransactionOwnerLockHandle()",
    ]) {
      expect(runtime.split(method)).toHaveLength(2);
    }
    expect(runtime).toContain(
      "await awaitInitialSweep(coordinator.ready, initialSweepTimeoutMilliseconds)",
    );
    expect(runtime).not.toContain("registerWorkerArtifactRoutes");

    const testingHook = "createServerStorageRuntimeWithInitialSweepTimeoutForTest";
    const testingHookReferences: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      if ((await readFile(path, "utf8")).includes(testingHook)) {
        testingHookReferences.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }
    expect(testingHookReferences.sort()).toEqual(
      [
        "artifacts/artifact-upload-create-boundary.test.ts",
        "runtime/server-storage-runtime.testing.ts",
        "runtime/server-storage-runtime.ts",
      ].sort(),
    );

    for (const relativePath of ["app.ts", "config.ts", "main.ts", "routes/workers.ts"]) {
      const source = await readFile(join(sourceRoot, relativePath), "utf8");
      expect(source).not.toContain("ArtifactTransactionCoordinator");
      expect(source).not.toContain("createArtifactTransaction");
      expect(source).not.toContain("artifact-transaction-coordinator");
    }
  });

  it("keeps the reviewed Worker artifact adapter unreachable from production roots", async () => {
    for (const relativePath of ["app.ts", "config.ts", "main.ts", "routes/workers.ts"]) {
      const source = await readFile(join(sourceRoot, relativePath), "utf8");
      expect(source).not.toContain("worker-artifacts");
      expect(source).not.toContain("registerWorkerArtifactRoutes");
    }

    const adapter = await readFile(join(sourceRoot, "routes", "worker-artifacts.ts"), "utf8");
    expect(adapter).toContain("createWorkerAuthenticationHooks");
    expect(adapter).toContain("onRequest: authenticateWorker.onRequest");
    expect(adapter).toContain("preValidation: [authenticateWorker.preValidation");
    expect(adapter).not.toContain("DatabaseClient");
    expect(adapter).not.toContain("ArtifactStorageClient.create(");
    expect(adapter).not.toContain("request.raw");
    expect(adapter).not.toContain("ArtifactTransactionCoordinator.create(");

    const productionReferences: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      const relativePath = relative(sourceRoot, path).replaceAll("\\", "/");
      if (relativePath.endsWith(".test.ts") || relativePath.endsWith(".testing.ts")) {
        continue;
      }
      const source = await readFile(path, "utf8");
      if (source.includes("worker-artifacts") || source.includes("registerWorkerArtifactRoutes")) {
        productionReferences.push(relativePath);
      }
    }
    expect(productionReferences).toEqual(["routes/worker-artifacts.ts"]);
  });
});
