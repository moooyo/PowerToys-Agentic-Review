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

  it("omits every fake-owner adapter from production sources and output", async () => {
    const sourceFiles = await listTypeScriptFiles(sourceRoot);
    expect(
      sourceFiles
        .map((path) => relative(sourceRoot, path).replaceAll("\\", "/"))
        .filter((path) => path.endsWith(".testing.ts")),
    ).toEqual([]);
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

  it("keeps the transaction coordinator dark outside tests and its own module", async () => {
    const allowed = new Set([
      "artifacts/artifact-upload-create-boundary.test.ts",
      "artifacts/artifact-transaction-coordinator.test.ts",
      "artifacts/artifact-transaction-coordinator.ts",
      "database/database-client.test.ts",
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

    for (const relativePath of ["app.ts", "config.ts", "main.ts", "routes/workers.ts"]) {
      const source = await readFile(join(sourceRoot, relativePath), "utf8");
      expect(source).not.toContain("ArtifactTransactionCoordinator");
      expect(source).not.toContain("createArtifactTransaction");
      expect(source).not.toContain("artifact-transaction-coordinator");
    }
  });
});
