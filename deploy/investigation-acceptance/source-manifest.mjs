import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const sourceRoots = ["apps", "packages", "native", "config", "deploy", "migrations", ".github"];
const excludedDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "bin",
  "obj",
  ".cache",
  ".data",
  "coverage",
  "test-results",
  "playwright-report",
  "artifacts",
]);
const sourceExtension =
  /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|go|mod|sum|ps1|psm1|psd1|sh|sql|md|txt|html|css|scss|xml|props|targets|cs|c|cpp|h|hpp|csproj|sln|slnx|config)$/iu;

/** A base revision labels provenance; only this manifest identifies the actual source snapshot. */
export async function recordSourceManifest({ repo, output, git, declaredBaseRevision }) {
  if (declaredBaseRevision !== undefined) {
    assert(
      /^[a-f0-9]{7,40}$/iu.test(declaredBaseRevision),
      "--source-revision must be a Git revision hash label.",
    );
  }
  let checkout = false;
  try {
    await lstat(join(repo, ".git"));
    checkout = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let checkoutHead = null;
  if (checkout) {
    const result = await execute(git, ["-C", repo, "rev-parse", "HEAD"], {
      windowsHide: true,
      timeout: 20_000,
    });
    checkoutHead = result.stdout.trim();
    assert(
      /^[a-f0-9]{40}$/u.test(checkoutHead),
      "The checkout HEAD must resolve to a full commit hash.",
    );
  } else {
    assert(
      declaredBaseRevision,
      "An archive deployment requires --source-revision to label its declared base.",
    );
  }
  const files = [];
  async function add(path) {
    const state = await lstat(path);
    assert(!state.isSymbolicLink(), `Source manifest must not follow a symbolic link: ${path}`);
    if (state.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (!excludedDirectories.has(name.toLowerCase())) await add(join(path, name));
      }
    } else if (state.isFile() && sourceExtension.test(path)) {
      const bytes = await readFile(path);
      files.push({
        path: relative(repo, path).replaceAll("\\", "/"),
        byteLength: bytes.length,
        sha256: hash(bytes),
      });
    }
  }
  for (const root of sourceRoots) await add(join(repo, root));
  for (const name of (await readdir(repo)).sort()) {
    const path = join(repo, name);
    const state = await lstat(path);
    if (state.isFile() && sourceExtension.test(name)) await add(path);
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  assert(files.some((file) => file.path === "apps/worker/src/main.ts"));
  assert(files.some((file) => file.path === "apps/server/src/main.ts"));
  const manifest = {
    schemaVersion: "InvestigationAcceptanceSourceManifestV1",
    kind: checkout ? "checkout" : "archive",
    declaredBaseRevision: declaredBaseRevision ?? checkoutHead,
    checkoutHead,
    baseRevisionIsNotSnapshotIdentity: true,
    sourceRoots,
    excludedDirectories: [...excludedDirectories].sort(),
    fileSelection:
      "Source/configuration/documentation extensions; prebuilt runtime binaries are hashed separately.",
    files,
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(output, "source-manifest.json"), content, "utf8");
  const runtimeSnapshot = await recordRuntimeManifest(repo, output);
  return {
    kind: manifest.kind,
    declaredBaseRevision: manifest.declaredBaseRevision,
    checkoutHead,
    baseRevisionIsNotSnapshotIdentity: true,
    fileCount: files.length,
    manifestSha256: hash(Buffer.from(content)),
    filesSha256: hash(Buffer.from(JSON.stringify(files))),
    manifestPath: "source-manifest.json",
    runtimeSnapshot,
  };
}

async function recordRuntimeManifest(repo, output) {
  const roots = [
    "apps/server/dist",
    "apps/worker/dist",
    "apps/dashboard/dist",
    "packages/contracts/dist",
    "packages/domain/dist",
    "packages/codex/dist",
  ];
  const files = [];
  async function add(path) {
    const state = await lstat(path);
    assert(!state.isSymbolicLink(), `Runtime manifest must not follow a symbolic link: ${path}`);
    if (state.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await add(join(path, name));
    } else {
      assert(state.isFile(), `Unexpected runtime object: ${path}`);
      const bytes = await readFile(path);
      files.push({
        path: relative(repo, path).replaceAll("\\", "/"),
        byteLength: bytes.length,
        sha256: hash(bytes),
      });
    }
  }
  for (const root of roots) await add(join(repo, root));
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = {
    schemaVersion: "InvestigationAcceptanceRuntimeManifestV1",
    roots,
    thirdPartyDependencies:
      "Installed dependency identity is described by the separately hashed lockfile and deployment build receipt; node_modules contents are not included.",
    buildProvenance:
      "These are the observed prebuilt runtime files. Establishing the build-to-source relationship requires the deployment's build evidence.",
    files,
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(output, "runtime-manifest.json"), content, "utf8");
  return {
    fileCount: files.length,
    manifestPath: "runtime-manifest.json",
    manifestSha256: hash(Buffer.from(content)),
    filesSha256: hash(Buffer.from(JSON.stringify(files))),
  };
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
