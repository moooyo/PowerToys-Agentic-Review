import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function json(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function windowsPath(value, label) {
  assert.equal(typeof value, "string", label);
  assert.match(value, /^[A-Za-z]:[\\/]/u, label);
  const normalized = win32.normalize(value);
  assert.ok(normalized.length > 3 && !normalized.includes("\0"), label);
  return normalized;
}
function linuxPath(value, label) {
  assert.equal(typeof value, "string", label);
  assert.ok(value.startsWith("/") && value.length > 1 && !value.split("/").includes(".."), label);
  return value;
}
function mountedPath(value) {
  const path = windowsPath(value, "shared path");
  return `/mnt/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
}
async function versionOf(executable, root) {
  const child = spawn(executable, ["--version"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => child.kill(), 20_000);
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 65_536) child.kill();
    else chunks.push(chunk);
  });
  child.stderr.resume();
  const exit = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(exit.code, 0, "CLI version detection failed.");
  assert.equal(exit.signal, null);
  assert.ok(bytes <= 65_536);
  const version = Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/u)[0];
  assert.ok(
    version &&
      version.length <= 128 &&
      ![...version].some((character) => character.charCodeAt(0) < 32),
  );
  return version;
}
async function buildWorkerHarness(root) {
  const { build } = createRequire(join(repository, "apps/worker/package.json"))("esbuild");
  const entry = join(root, "worker-entry.mjs");
  await writeFile(
    entry,
    'export { runWorker } from "@acceptance/worker";\nexport { createGitFixture } from "@acceptance/fixture";\n',
    { flag: "wx" },
  );
  const alias = {
    "@acceptance/worker": join(repository, "deploy/worker/cli-workflow-acceptance/worker.ts"),
    "@acceptance/fixture": join(repository, "deploy/worker/cli-workflow-acceptance/git-fixture.ts"),
  };
  for (const name of ["contracts", "domain", "codex"])
    alias[`@agentic-review/${name}`] = join(repository, `packages/${name}/src/index.ts`);
  const outfile = join(root, "worker-harness.mjs");
  const result = await build({
    entryPoints: [entry],
    outfile,
    absWorkingDir: repository,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    alias,
    metafile: true,
    nodePaths: [join(repository, "apps/worker/node_modules")],
    logLevel: "warning",
  });
  const files = [];
  for (const path of Object.keys(result.metafile.inputs))
    files.push({ path, sha256: hash(await readFile(resolve(repository, path))) });
  await json(join(root, "worker-build-inputs.json"), files);
  await json(join(root, "worker-build-metadata.json"), result.metafile);
  return import(pathToFileURL(outfile).href);
}
async function prepareLinuxParent(config) {
  const child = spawn(
    "wsl.exe",
    [
      "--distribution",
      config.wslDistribution,
      "--exec",
      "/bin/mkdir",
      "--parents",
      "--mode=0700",
      "--",
      config.linuxRunParent,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  const timer = setTimeout(() => child.kill(), 20_000);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, "The Linux run parent could not be prepared.");
}
function startServer(config, inputPath, input) {
  const node = config.linuxNodeExecutablePath;
  const args = [
    "--distribution",
    config.wslDistribution,
    "--exec",
    "/usr/bin/env",
    "-i",
    `PATH=${dirname(node)}:/usr/local/bin:/usr/bin:/bin`,
    `HOME=${input.serverDirectory}/home`,
    `TMPDIR=${input.serverDirectory}/tmp`,
    "NODE_ENV=test",
    "NO_COLOR=1",
    node,
    `${config.linuxSourceDirectory}/deploy/worker/cli-workflow-acceptance/server.mjs`,
    mountedPath(inputPath),
  ];
  const child = spawn("wsl.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "",
    exit;
  const closed = new Promise((done) => {
    child.once("error", (error) => {
      exit = { code: null, signal: null, error: error.code ?? error.name };
      done(exit);
    });
    child.once("close", (code, signal) => {
      exit = { code, signal };
      done(exit);
    });
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      if (output.length < 4 * 1024 * 1024) output += chunk.toString("utf8");
    });
  return {
    child,
    closed,
    get exit() {
      return exit;
    },
    log: () =>
      output
        .replaceAll(input.workerToken, "[fixture-token]")
        .replaceAll(input.controlToken, "[control-token]"),
  };
}
async function readReady(path, server, nonce) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (server.exit) throw new Error("The Linux Server exited before readiness.");
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      assert.equal(value.nonce, nonce);
      const url = new URL(value.serverUrl);
      assert.equal(url.protocol, "http:");
      assert.equal(url.hostname, "127.0.0.1");
      assert.ok(url.port && url.pathname === "/");
      return value;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  throw new Error("The Linux Server did not become ready within 45 seconds.");
}
async function control(ready, token, action) {
  const response = await fetch(new URL(`/__acceptance/${action}`, ready.serverUrl), {
    method: action === "stop" ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.ok, true, `Server control ${action} failed.`);
  return response.json();
}
async function oneEngine(config, engine, harness) {
  const nonce = randomUUID().replaceAll("-", "");
  const root = join(config.runDirectory, engine.engine);
  await mkdir(root);
  const fixture = await harness.createGitFixture({
    directory: join(root, "fixture"),
    gitExecutablePath: config.gitExecutablePath,
    repoFullName: `agentic-review-fixture/workflow-${nonce.slice(0, 16)}`,
  });
  const cliVersion = await versionOf(engine.cliExecutablePath, root);
  const readyPath = join(root, "server-ready.json");
  const input = {
    schemaVersion: "CliWorkflowAcceptanceInputV1",
    nonce,
    engine: engine.engine,
    ...fixture,
    nodeExecutablePath: config.nodeExecutablePath,
    gitExecutablePath: config.gitExecutablePath,
    processHostPath: config.processHostPath,
    cliExecutablePath: engine.cliExecutablePath,
    cliVersion,
    workerDirectory: join(root, "worker"),
    workerNodeId: `m39-${engine.engine}-${nonce}`,
    workerToken: `arw1_${randomBytes(32).toString("base64url")}`,
    controlToken: randomBytes(32).toString("base64url"),
    serverDirectory: `${config.linuxRunParent}/agentic-review-${engine.engine}-${nonce}`,
    migrationsDirectory: `${config.linuxSourceDirectory}/migrations`,
    readyFilePath: mountedPath(readyPath),
    maximumRunMs: config.maximumRunMs ?? 900_000,
  };
  const inputPath = join(root, "input.json");
  await json(inputPath, input);
  const server = startServer(config, inputPath, input);
  let ready, worker, status, failure;
  try {
    ready = await readReady(readyPath, server, nonce);
    process.stdout.write(
      `${JSON.stringify({ engine: engine.engine, stage: "worker-started", cliVersion })}\n`,
    );
    worker = await harness.runWorker(input, ready, {
      onProgress(event) {
        if (
          [
            "task_started",
            "task_finished",
            "cli_started",
            "server_phase",
            "acceptance_failed",
          ].includes(event.kind)
        ) {
          process.stdout.write(
            `${JSON.stringify({ engine: engine.engine, stage: event.kind, details: event.details })}\n`,
          );
        }
      },
    });
    await json(join(root, "worker-receipt.json"), worker);
    assert.equal(worker.status, "passed", "Worker execution or cleanup verification failed.");
    status = await control(ready, input.controlToken, "status");
    assert.equal(
      status.phase,
      "complete",
      "The complete ordinary/Evaluation workflow did not settle.",
    );
    assert.equal(status.passed, true, "One or more required task or result checks failed.");
    await json(join(root, "server-status.json"), status);
  } catch (error) {
    failure = {
      name: error.name,
      message: String(error.message)
        .replaceAll(input.workerToken, "[fixture-token]")
        .replaceAll(input.controlToken, "[control-token]"),
    };
  } finally {
    if (ready && !server.exit) {
      try {
        await control(ready, input.controlToken, "stop");
      } catch (error) {
        failure ??= { name: error.name, message: "Server shutdown request failed." };
      }
    }
    const closed = await Promise.race([server.closed, delay(20_000).then(() => null)]);
    if (closed === null)
      failure ??= {
        name: "Error",
        message:
          "Linux Server closure was not confirmed; its bounded watchdog remains responsible for shutdown.",
      };
    else if (closed.code !== 0)
      failure ??= { name: "Error", message: `Linux Server exited with code ${closed.code}.` };
    await writeFile(join(root, "server.log"), server.log(), { flag: "wx" });
    const receipt = {
      engine: engine.engine,
      cliVersion,
      fixture,
      serverDirectory: input.serverDirectory,
      worker,
      status,
      serverExit: closed,
      failure,
    };
    await json(join(root, "receipt.json"), receipt);
    process.stdout.write(
      `${JSON.stringify({ engine: engine.engine, stage: "finished", failure })}\n`,
    );
  }
  if (failure) throw new Error(`${engine.engine} acceptance failed: ${failure.message}`);
}

assert.equal(
  process.platform,
  "win32",
  "Run the coordinator on the authorized Windows test machine.",
);
assert.equal(process.argv.length, 4, "Usage: node run.mjs <config.json> --allow-real-models");
assert.equal(
  process.argv[3],
  "--allow-real-models",
  "Real model execution requires an explicit opt-in.",
);
const config = JSON.parse(await readFile(resolve(process.argv[2]), "utf8"));
for (const key of ["runDirectory", "nodeExecutablePath", "gitExecutablePath", "processHostPath"])
  config[key] = windowsPath(config[key], key);
for (const key of ["linuxNodeExecutablePath", "linuxSourceDirectory", "linuxRunParent"])
  config[key] = linuxPath(config[key], key);
assert.match(config.wslDistribution, /^[A-Za-z0-9._-]+$/u);
assert.ok(Array.isArray(config.engines) && config.engines.length > 0 && config.engines.length <= 2);
assert.equal(new Set(config.engines.map((engine) => engine.engine)).size, config.engines.length);
for (const engine of config.engines) {
  assert.ok(["codex", "copilot"].includes(engine.engine));
  engine.cliExecutablePath = windowsPath(engine.cliExecutablePath, "cliExecutablePath");
}
await mkdir(config.runDirectory);
await json(join(config.runDirectory, "configuration.json"), config);
const harness = await buildWorkerHarness(config.runDirectory);
await prepareLinuxParent(config);
for (const engine of config.engines) await oneEngine(config, engine, harness);
await json(join(config.runDirectory, "complete.json"), {
  engines: config.engines.map((engine) => engine.engine),
  completedAt: new Date().toISOString(),
  scope:
    "Owned Git fixture, real profile commands and configured model CLIs, normal Worker/HTTP/SQLite completion and Evaluation scoring.",
});
