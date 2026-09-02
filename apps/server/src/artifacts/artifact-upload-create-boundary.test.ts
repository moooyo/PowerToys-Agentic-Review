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

describe("artifact upload create composition boundary", () => {
  it("limits the internal handle registrar to DatabaseClient and fake-owner tests", async () => {
    const reference = "registerArtifactUploadCreateDatabaseHandle";
    const references: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      if ((await readFile(path, "utf8")).includes(reference)) {
        references.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }
    expect(references.sort()).toEqual([
      "artifacts/artifact-upload-create-boundary.test.ts",
      "artifacts/artifact-upload-create-coordinator.testing.ts",
      "artifacts/artifact-upload-create-coordinator.ts",
      "database/database-client.ts",
    ]);
  });

  it("keeps internal factories out of the public artifact barrel", async () => {
    const barrel = await readFile(join(sourceRoot, "artifacts", "index.ts"), "utf8");
    expect(barrel).not.toContain("registerArtifactUploadCreateDatabaseHandle");
    expect(barrel).not.toContain("attachArtifactUploadCreateDatabaseForTest");
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

  it("limits the reconciliation handle registrar to DatabaseClient and fake-owner tests", async () => {
    const reference = "registerArtifactReconciliationDatabaseHandle";
    const references: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      if ((await readFile(path, "utf8")).includes(reference)) {
        references.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }
    expect(references.sort()).toEqual([
      "artifacts/artifact-reconciliation-coordinator.testing.ts",
      "artifacts/artifact-reconciliation-coordinator.ts",
      "artifacts/artifact-upload-create-boundary.test.ts",
      "database/database-client.ts",
    ]);
  });

  it("limits the reconciliation fake-owner attachment to its unit test", async () => {
    const reference = "artifact-reconciliation-coordinator.testing.js";
    const references: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      if ((await readFile(path, "utf8")).includes(reference)) {
        references.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }
    expect(references.sort()).toEqual([
      "artifacts/artifact-reconciliation-coordinator.test.ts",
      "artifacts/artifact-upload-create-boundary.test.ts",
    ]);
  });

  it("limits the fake-owner attachment module to its unit test", async () => {
    const reference = "artifact-upload-create-coordinator.testing.js";
    const references: string[] = [];
    for (const path of await listTypeScriptFiles(sourceRoot)) {
      if ((await readFile(path, "utf8")).includes(reference)) {
        references.push(relative(sourceRoot, path).replaceAll("\\", "/"));
      }
    }
    expect(references.sort()).toEqual([
      "artifacts/artifact-upload-create-boundary.test.ts",
      "artifacts/artifact-upload-create-coordinator.test.ts",
    ]);
  });

  it("keeps coordinator construction in the single future composition root", async () => {
    const allowed = new Set([
      "artifacts/artifact-upload-create-boundary.test.ts",
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
});
