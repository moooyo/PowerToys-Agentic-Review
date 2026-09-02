import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { build } from "esbuild";
import { verifyRoleBundle } from "./verify-role-bundles.mjs";
import { verifyZeroExecutionProductionArchitecture } from "./verify-zero-execution-architecture.mjs";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const outputDirectory = resolve(workerRoot, "dist");
const contractsSource = resolve(repositoryRoot, "packages/contracts/src/worker.ts");
const localProtocolSource = resolve(repositoryRoot, "packages/local-protocol/src/index.ts");
const typeBoxEntry = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
const typeBoxRoot = realpathSync(resolve(dirname(typeBoxEntry), "../.."));
const reviewedTypeBoxVersion = "0.34.52";
const reviewedTypeBoxRepositoryPath =
  "node_modules/.pnpm/@sinclair+typebox@0.34.52/node_modules/@sinclair/typebox";
const reviewedTypeBoxValueEntrySha256 =
  "26bade598ae18ef71234cafa577be8cdb6f75016a6964dae67265343caf8ed12";
const typeBoxValueEntry = realpathSync(resolve(typeBoxRoot, "build/esm/value/index.mjs"));
const resolvedTypeBoxValueEntry = realpathSync(
  fileURLToPath(import.meta.resolve("@sinclair/typebox/value")),
);
const typeBoxCheckModule = realpathSync(resolve(typeBoxRoot, "build/esm/value/check/check.mjs"));
const typeBoxValueCheckShim = realpathSync(
  resolve(workerRoot, "src/service-host/typebox-value-check.ts"),
);
const requiredReviewedRoleTypeBoxValueImporters = new Set([
  realpathSync(resolve(repositoryRoot, "packages/local-protocol/src/capability.ts")),
  realpathSync(resolve(repositoryRoot, "packages/local-protocol/src/messages.ts")),
]);
const reviewedRoleTypeBoxValueImporters = new Set([
  ...requiredReviewedRoleTypeBoxValueImporters,
  realpathSync(resolve(workerRoot, "src/control/host-control-api-common.ts")),
]);

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await buildWorkerBundles();
}

async function buildWorkerBundles() {
  verifyZeroExecutionProductionArchitecture();
  await cleanOutputDirectory(outputDirectory, workerRoot);
  await typecheckWorker();

  const [legacy, control, executor] = await Promise.all([
    bundle("src/main.ts", "dist/worker.mjs", "legacy"),
    bundle("src/control-main.ts", "dist/control.mjs", "reviewed-role"),
    bundle("src/executor-main.ts", "dist/executor.mjs", "reviewed-role"),
  ]);

  verifyRoleBundle("control", control.metafile, control.outputFiles);
  verifyRoleBundle("executor", executor.metafile, executor.outputFiles);

  await writeBuild(legacy);
  await writeBuild(control);
  await writeBuild(executor);
  await writeFile(
    resolve(outputDirectory, "control.meta.json"),
    `${JSON.stringify(control.metafile, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(outputDirectory, "executor.meta.json"),
    `${JSON.stringify(executor.metafile, null, 2)}\n`,
    "utf8",
  );
}

async function bundle(entryPoint, output, mode) {
  if (mode !== "legacy" && mode !== "reviewed-role") {
    throw new TypeError("Worker bundle mode is invalid.");
  }
  if (mode === "reviewed-role") verifyReviewedRoleTypeBoxValueInstallation();
  return await build({
    absWorkingDir: workerRoot,
    entryPoints: [entryPoint],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: "external",
    metafile: true,
    treeShaking: true,
    write: false,
    plugins: [
      reviewedWorkspaceSources(mode),
      ...(mode === "reviewed-role" ? [reviewedRoleTypeBoxValue()] : []),
      reviewedTypeBoxTreeShaking(),
    ],
  });
}

function reviewedRoleTypeBoxValue() {
  return {
    name: "reviewed-role-typebox-value",
    setup(buildContext) {
      const seenImporters = new Set();
      buildContext.onResolve({ filter: /^@sinclair\/typebox\/value$/ }, (arguments_) => {
        if (
          arguments_.namespace !== "file" ||
          arguments_.kind !== "import-statement" ||
          Object.keys(arguments_.with ?? {}).length !== 0
        ) {
          throw new Error("Role TypeBox Value import uses an unreviewed import form.");
        }
        const importer = realpathSync(arguments_.importer);
        if (!reviewedRoleTypeBoxValueImporters.has(importer)) {
          throw new Error("Role TypeBox Value import has an unreviewed importer.");
        }
        seenImporters.add(importer);
        return { path: typeBoxValueCheckShim };
      });
      buildContext.onEnd(() => {
        const missing = [...requiredReviewedRoleTypeBoxValueImporters].filter(
          (importer) => !seenImporters.has(importer),
        );
        if (missing.length === 0) return undefined;
        return {
          errors: [
            {
              text: `Reviewed role TypeBox Value import edges changed: ${missing.join(",")}`,
            },
          ],
        };
      });
    },
  };
}

function verifyReviewedRoleTypeBoxValueInstallation() {
  const packageDocument = JSON.parse(readFileSync(resolve(typeBoxRoot, "package.json"), "utf8"));
  const packagePath = normalizePath(relative(realpathSync(repositoryRoot), typeBoxRoot));
  const valueEntryDigest = createHash("sha256")
    .update(readFileSync(typeBoxValueEntry))
    .digest("hex");
  if (
    packageDocument?.version !== reviewedTypeBoxVersion ||
    packagePath !== reviewedTypeBoxRepositoryPath ||
    resolvedTypeBoxValueEntry !== typeBoxValueEntry ||
    valueEntryDigest !== reviewedTypeBoxValueEntrySha256
  ) {
    throw new Error("Role TypeBox Value redirect requires the reviewed package and entry point.");
  }
  for (const importer of reviewedRoleTypeBoxValueImporters) {
    verifyReviewedRoleTypeBoxValueImport(readFileSync(importer, "utf8"));
  }
  const shimSource = readFileSync(typeBoxValueCheckShim, "utf8");
  const shimTarget = verifyReviewedRoleTypeBoxValueShim(shimSource);
  if (realpathSync(resolve(dirname(typeBoxValueCheckShim), shimTarget)) !== typeBoxCheckModule) {
    throw new Error("Role TypeBox Value shim target changed.");
  }
}

export function verifyReviewedRoleTypeBoxValueImport(source) {
  const sourceFile = parseReviewedModule(source, true, "TypeBox Value importer");
  const declarations = sourceFile.program.body.filter(
    (node) => node.type === "ImportDeclaration" && node.source.value === "@sinclair/typebox/value",
  );
  const declaration = declarations[0];
  const specifier =
    declaration?.type === "ImportDeclaration" ? declaration.specifiers[0] : undefined;
  if (
    declarations.length !== 1 ||
    declaration.type !== "ImportDeclaration" ||
    declaration.importKind === "type" ||
    declaration.specifiers.length !== 1 ||
    specifier?.type !== "ImportSpecifier" ||
    specifier.importKind === "type" ||
    specifier.imported.type !== "Identifier" ||
    specifier.imported.name !== "Value" ||
    specifier.local.name !== "Value" ||
    (declaration.attributes?.length ?? 0) !== 0 ||
    (declaration.assertions?.length ?? 0) !== 0
  ) {
    throw new Error("Reviewed role TypeBox Value import declaration changed.");
  }
}

export function verifyReviewedRoleTypeBoxValueShim(source) {
  const sourceFile = parseReviewedModule(source, true, "TypeBox Value shim");
  if (sourceFile.program.body.length !== 1) {
    throw new Error("Reviewed role TypeBox Value shim declaration count changed.");
  }
  const declaration = sourceFile.program.body[0];
  const specifier =
    declaration?.type === "ExportNamedDeclaration" ? declaration.specifiers[0] : undefined;
  if (
    declaration?.type !== "ExportNamedDeclaration" ||
    declaration.exportKind === "type" ||
    declaration.specifiers.length !== 1 ||
    specifier?.type !== "ExportNamespaceSpecifier" ||
    specifier.exported.type !== "Identifier" ||
    specifier.exported.name !== "Value" ||
    declaration.source?.type !== "StringLiteral" ||
    (declaration.attributes?.length ?? 0) !== 0 ||
    (declaration.assertions?.length ?? 0) !== 0
  ) {
    throw new Error("Reviewed role TypeBox Value shim declaration changed.");
  }
  return declaration.source.value;
}

function parseReviewedModule(source, typescript, description) {
  try {
    return parse(source, {
      sourceType: "module",
      plugins: typescript ? ["typescript"] : [],
    });
  } catch {
    throw new Error(`Reviewed role ${description} could not be parsed.`);
  }
}

function reviewedWorkspaceSources(mode) {
  return {
    name: "reviewed-workspace-sources",
    setup(buildContext) {
      if (mode === "reviewed-role") {
        buildContext.onResolve({ filter: /^@agentic-review\/contracts$/ }, () => ({
          path: contractsSource,
        }));
      }
      buildContext.onResolve({ filter: /^@agentic-review\/local-protocol$/ }, () => ({
        path: localProtocolSource,
      }));
    },
  };
}

function reviewedTypeBoxTreeShaking() {
  return {
    name: "reviewed-typebox-tree-shaking",
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, async (arguments_) => {
        if (arguments_.pluginData?.reviewedTypeBox === true) return undefined;
        const requestTargetsTypeBox = arguments_.path.startsWith("@sinclair/typebox");
        const importerIsTypeBox = isWithin(typeBoxRoot, arguments_.resolveDir);
        if (!requestTargetsTypeBox && !importerIsTypeBox) return undefined;
        const resolution = await buildContext.resolve(arguments_.path, {
          importer: arguments_.importer,
          kind: arguments_.kind,
          namespace: arguments_.namespace,
          resolveDir: arguments_.resolveDir,
          pluginData: { reviewedTypeBox: true },
        });
        if (resolution.errors.length !== 0) return resolution;
        return { ...resolution, sideEffects: false };
      });
    },
  };
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

async function writeBuild(result) {
  for (const file of result.outputFiles) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
  }
}

export async function cleanOutputDirectory(target, expectedParent) {
  const relativeTarget = relative(resolve(expectedParent), resolve(target));
  if (
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    relativeTarget.includes(sep) ||
    relativeTarget !== "dist"
  ) {
    throw new Error("Worker output cleanup target is outside the fixed dist directory.");
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

function isWithin(parent, candidate) {
  const relativeCandidate = relative(resolve(parent), resolve(candidate));
  return (
    relativeCandidate === "" ||
    (relativeCandidate !== ".." &&
      !relativeCandidate.startsWith(`..${sep}`) &&
      !isAbsolute(relativeCandidate))
  );
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}
