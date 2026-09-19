import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = resolve(workerRoot, "dist");

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await buildWorkerBundle();
}

async function buildWorkerBundle() {
  await cleanOutputDirectory(outputDirectory, workerRoot);
  await typecheckWorker();
  const bundleOptions = {
    absWorkingDir: workerRoot,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: "external",
    metafile: true,
    treeShaking: true,
    write: false,
  };
  const bundles = [
    { name: "worker", entryPoint: "src/main.ts" },
    {
      name: "cleanup-recovery-operations",
      entryPoint: "src/investigation/cleanup-recovery-operations-entry.ts",
    },
    { name: "web-driver", entryPoint: "src/ui/web-driver-entry.ts" },
  ];
  const results = await Promise.all(
    bundles.map(async ({ name, entryPoint }) => ({
      name,
      result: await build({
        ...bundleOptions,
        entryPoints: [entryPoint],
        outfile: `dist/${name}.mjs`,
        external: ["playwright-core"],
      }),
    })),
  );
  for (const { name, result } of results) {
    for (const file of result.outputFiles) {
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.contents);
    }
    await writeFile(
      resolve(outputDirectory, `${name}.meta.json`),
      `${JSON.stringify(result.metafile, null, 2)}\n`,
      "utf8",
    );
  }
  await copyWorkerRuntimeAssets(outputDirectory);
}

export async function copyWorkerRuntimeAssets(targetDirectory) {
  await mkdir(targetDirectory, { recursive: true });
  await copyFile(
    resolve(workerRoot, "src", "investigation", "e2e-desktop-driver.ps1"),
    resolve(targetDirectory, "e2e-desktop-driver.ps1"),
  );
  // Web readiness also uses this entry for Windows process and TCP ownership probes.
  await copyFile(
    resolve(workerRoot, "src", "ui", "windows-driver-entry.ps1"),
    resolve(targetDirectory, "windows-driver-entry.ps1"),
  );
  await copyPlaywrightRuntime(targetDirectory);
}

async function copyPlaywrightRuntime(targetDirectory) {
  const packagePath = fileURLToPath(import.meta.resolve("playwright-core/package.json"));
  const packageDirectory = await realpath(dirname(packagePath));
  const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageMetadata.name !== "playwright-core") {
    throw new Error("The installed Playwright runtime package has an unexpected identity.");
  }
  const runtimeDirectory = resolve(targetDirectory, "node_modules", "playwright-core");
  await mkdir(dirname(runtimeDirectory), { recursive: true });
  await cp(packageDirectory, runtimeDirectory, { recursive: true, dereference: true });
}

async function typecheckWorker() {
  const typeScriptPackage = fileURLToPath(import.meta.resolve("typescript/package.json"));
  const compiler = resolve(dirname(typeScriptPackage), "bin/tsc");
  const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json", "--noEmit"], {
    cwd: workerRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(output === "" ? "Worker typecheck failed." : output);
  }
}

export async function cleanOutputDirectory(target, expectedParent) {
  const relativeTarget = relative(resolve(expectedParent), resolve(target));
  if (
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    relativeTarget.includes(sep) ||
    relativeTarget !== "dist" ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error("Worker output cleanup target is outside the fixed dist directory.");
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}
