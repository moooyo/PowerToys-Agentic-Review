import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux", "Prepare the SQLite Server on Linux.");
assert.equal(process.argv.length, 3, "Usage: node prepare-server.mjs <new-build-report-directory>");
const source = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.argv[2]);
await mkdir(output, { mode: 0o700 });
const commands = [];
async function run(args, label) {
  const child = spawn(process.execPath, args, { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [],
    stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  const result = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  }).finally(() => clearTimeout(timer));
  await writeFile(join(output, `${label}.log`), Buffer.concat([...stdout, ...stderr]), {
    flag: "wx",
  });
  commands.push({ label, args, ...result });
  assert.equal(result.code, 0, `${label} failed; inspect its retained log.`);
  assert.equal(result.signal, null);
}
const startedAt = new Date().toISOString();
let failure = null;
const emitted = [];
try {
  const workspaceScope = join(source, "node_modules/@agentic-review");
  await mkdir(workspaceScope, { recursive: true });
  for (const name of ["contracts", "domain", "codex"]) {
    const destination = join(workspaceScope, name);
    const target = join(source, "packages", name);
    try {
      await symlink(target, destination, "dir");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      assert.equal(await realpath(destination), await realpath(target));
    }
  }
  const compiler = join(source, "node_modules/typescript/bin/tsc");
  await run(
    [
      compiler,
      "-b",
      "--force",
      "packages/contracts",
      "packages/domain",
      "packages/codex",
      "apps/server",
    ],
    "shared-server-build",
  );
  await run(
    [compiler, "-p", "deploy/worker/issue-summary-acceptance/tsconfig.json"],
    "acceptance-typecheck",
  );
  const { transform } = createRequire(join(source, "apps/worker/package.json"))("esbuild");
  const directory = join(source, "deploy/worker/issue-summary-acceptance");
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".ts"))) {
    const bytes = await readFile(join(directory, name));
    const result = await transform(bytes.toString("utf8"), {
      loader: "ts",
      format: "esm",
      platform: "node",
      target: "node24",
      sourcefile: name,
      sourcemap: false,
    });
    const target = name === "server.ts" ? "server.mjs" : name.replace(/\.ts$/u, ".js");
    await writeFile(join(directory, target), result.code, { flag: "wx" });
    emitted.push({
      path: target,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      outputSha256: createHash("sha256").update(result.code).digest("hex"),
    });
  }
} catch (error) {
  failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  const receipt = {
    startedAt,
    finishedAt: new Date().toISOString(),
    source,
    node: process.execPath,
    commands,
    emitted,
    failure,
  };
  await writeFile(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
