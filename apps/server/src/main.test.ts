import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
  it("keeps storage and process shutdown under the production lifecycle", async () => {
    const source = await readFile(sourcePath, "utf8");

    for (const required of [
      "createProductionServerLifecycle({",
      "await createServerStorageRuntime({",
      'message: "Artifact storage requested a fail-stop."',
      "code: error.code",
      "lifecycle.onArtifactFailStop(error);",
      "lifecycle.adoptStorageRuntime(storageRuntime);",
      "artifactReadiness: storageRuntime.artifactReadiness",
      "serverAdmission: lifecycle.admission",
      "lifecycle.adoptApplication(app);",
      'lifecycle.trackBackground("github-polling", pollingCompletion);',
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

    const storageCreate = source.indexOf("await createServerStorageRuntime({");
    const storageAdoption = source.indexOf("lifecycle.adoptStorageRuntime(storageRuntime);");
    const appCreate = source.indexOf("const app = buildApp({");
    const appAdoption = source.indexOf("lifecycle.adoptApplication(app);");
    const listen = source.indexOf("await app.listen(");
    const backgroundTracking = source.indexOf("lifecycle.trackBackground(");
    const running = source.indexOf("lifecycle.markRunning();");

    expect(storageCreate).toBeLessThan(storageAdoption);
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
    expect(references("buildApp")).toEqual(["app.ts", "main.ts"]);
  });
});
