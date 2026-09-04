import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  const result = await build({
    absWorkingDir: workerRoot,
    entryPoints: ["src/main.ts"],
    outfile: "dist/worker.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: "external",
    metafile: true,
    treeShaking: true,
    write: false,
  });
  for (const file of result.outputFiles) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
  }
  await writeFile(
    resolve(outputDirectory, "worker.meta.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
    "utf8",
  );
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
