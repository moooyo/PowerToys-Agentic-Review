import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("../../../", import.meta.url));
const directory = fileURLToPath(new URL(".", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

function windowsPath(value, label) {
  assert.equal(typeof value, "string", label);
  assert.match(value, /^[A-Za-z]:[\\/]/u, label);
  assert.ok(
    value.length > 3 && !value.includes("\0") && !value.split(/[\\/]/u).includes(".."),
    label,
  );
  return win32.normalize(value);
}
function linuxPath(value, label) {
  assert.equal(typeof value, "string", label);
  assert.ok(
    value.startsWith("/") &&
      value.length > 1 &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    label,
  );
  return value;
}
function mountedPath(value) {
  const path = windowsPath(value, "shared artifact path");
  return `/mnt/${path[0].toLowerCase()}${path.slice(2).replaceAll("\\", "/")}`;
}
async function versionOf(executable, cwd) {
  const child = spawn(executable, ["--version"], {
    cwd,
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

async function buildWorker(root) {
  const { build } = createRequire(join(source, "apps/worker/package.json"))("esbuild");
  const alias = {};
  for (const name of ["contracts", "domain", "codex"])
    alias[`@agentic-review/${name}`] = join(source, `packages/${name}/src/index.ts`);
  const artifacts = [];
  for (const [name, entry] of [
    ["production-runtime", join(source, "apps/worker/src/main.ts")],
    ["summary-worker", join(directory, "worker.ts")],
  ]) {
    const outfile = join(root, `${name}.mjs`);
    const built = await build({
      entryPoints: [entry],
      outfile,
      absWorkingDir: source,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      alias,
      metafile: true,
      nodePaths: [join(source, "apps/worker/node_modules")],
      logLevel: "warning",
    });
    const inputs = [];
    for (const path of Object.keys(built.metafile.inputs))
      inputs.push({ path, sha256: hash(await readFile(resolve(source, path))) });
    await json(join(root, `${name}-inputs.json`), inputs);
    await json(join(root, `${name}-metadata.json`), built.metafile);
    artifacts.push({ name, sha256: hash(await readFile(outfile)), inputCount: inputs.length });
  }
  await json(join(root, "worker-build.json"), artifacts);
  // Separate files preserve production main's import.meta.url entry guard.
  const runtime = await import(pathToFileURL(join(root, "production-runtime.mjs")).href);
  const harness = await import(pathToFileURL(join(root, "summary-worker.mjs")).href);
  return { runWorker: harness.runWorker, createRuntime: runtime.createExecutionRuntime };
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
  const exit = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  }).finally(() => clearTimeout(timer));
  assert.equal(exit, 0, "The Linux artifact parent could not be prepared.");
}
function startServer(config, inputPath, input) {
  const args = [
    "--distribution",
    config.wslDistribution,
    "--exec",
    "/usr/bin/env",
    "-i",
    `PATH=${dirname(config.linuxNodeExecutablePath)}:/usr/local/bin:/usr/bin:/bin`,
    `HOME=${input.serverDirectory}/home`,
    `TMPDIR=${input.serverDirectory}/tmp`,
    "NODE_ENV=test",
    "NO_COLOR=1",
    config.linuxNodeExecutablePath,
    `${config.linuxSourceDirectory}/deploy/worker/issue-summary-acceptance/server.mjs`,
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
      const ready = JSON.parse(await readFile(path, "utf8"));
      assert.equal(ready.nonce, nonce);
      const url = new URL(ready.serverUrl);
      assert.equal(url.protocol, "http:");
      assert.equal(url.hostname, "127.0.0.1");
      assert.ok(url.port && url.pathname === "/");
      return ready;
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

async function terminateOwnedServer(config, input, inputPath, signal) {
  // Match the current run's PID, Linux start time, executable and input before signalling it.
  const helper = `
    import assert from "node:assert/strict";
    import {readFile, realpath} from "node:fs/promises";
    const [ownerPath, nonce, executable, inputPath, signal] = process.argv.slice(1);
    let state = "unconfirmed";
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8"));
      assert.equal(owner.nonce, nonce);
      assert.ok(Number.isSafeInteger(owner.processId) && owner.processId > 1);
      assert.equal(owner.inputPath, inputPath);
      assert.equal(owner.executable, await realpath(executable));
      const root = "/proc/" + owner.processId;
      const stat = await readFile(root + "/stat", "utf8");
      assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], owner.startTicks);
      assert.equal(await realpath(root + "/exe"), owner.executable);
      const args = (await readFile(root + "/cmdline", "utf8")).split("\\0");
      assert.ok(args.includes(inputPath));
      assert.ok(args.some((arg) => arg.endsWith("/issue-summary-acceptance/server.mjs")));
      assert.ok(signal === "SIGTERM" || signal === "SIGKILL");
      process.kill(owner.processId, signal);
      state = "signalled";
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") state = "absent";
      else { state = "ownership_not_confirmed"; process.exitCode = 1; }
    }
    process.stdout.write(JSON.stringify({state, signal}) + "\\n");
  `;
  const child = spawn(
    "wsl.exe",
    [
      "--distribution",
      config.wslDistribution,
      "--exec",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      config.linuxNodeExecutablePath,
      "--input-type=module",
      "-e",
      helper,
      input.ownerFilePath,
      input.nonce,
      config.linuxNodeExecutablePath,
      mountedPath(inputPath),
      signal,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    if (output.length < 4096) output += chunk.toString("utf8");
  });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 10_000);
  const exit = await new Promise((done) => {
    child.once("error", (error) => done({ code: null, error: error.code ?? error.name }));
    child.once("close", (code, signal) => done({ code, signal }));
  }).finally(() => clearTimeout(timer));
  return { ...exit, output: output.trim() };
}

async function oneEngine(config, engine, harness) {
  const nonce = randomUUID().replaceAll("-", "");
  const root = join(config.runDirectory, engine.engine);
  await mkdir(root);
  const probe = join(root, "probe");
  await mkdir(probe);
  const probeFiles = [];
  for (const name of [
    "probe.mjs",
    "probe-contract.json",
    "source-manifest.json",
    "reported-timedtext.transcribed.json",
  ]) {
    const original = join(directory, "probe", name),
      target = join(probe, name);
    await copyFile(original, target);
    const sourceHash = hash(await readFile(original));
    assert.equal(hash(await readFile(target)), sourceHash);
    probeFiles.push({ path: name, sha256: sourceHash });
  }
  await json(join(root, "probe-files.json"), probeFiles);
  const cliExecutablePath = await realpath(engine.cliExecutablePath);
  const cliVersion = await versionOf(cliExecutablePath, root);
  const readyPath = join(root, "server-ready.json");
  const input = {
    schemaVersion: "IssueSummaryAcceptanceInputV1",
    nonce,
    engine: engine.engine,
    nodeExecutablePath: config.nodeExecutablePath,
    gitExecutablePath: config.gitExecutablePath,
    processHostPath: config.processHostPath,
    trustedExecutableRoot: config.trustedExecutableRoot,
    cliExecutablePath,
    cliVersion,
    probeScriptPath: join(probe, "probe.mjs"),
    workerDirectory: join(root, "worker"),
    workerNodeId: `m40-summary-${engine.engine}-${nonce}`,
    workerToken: `arw1_${randomBytes(32).toString("base64url")}`,
    controlToken: randomBytes(32).toString("base64url"),
    serverDirectory: `${config.linuxRunParent}/summary-${engine.engine}-${nonce}`,
    migrationsDirectory: `${config.linuxSourceDirectory}/migrations`,
    readyFilePath: mountedPath(readyPath),
    ownerFilePath: mountedPath(join(root, "server-owner.json")),
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
      createRuntime: harness.createRuntime,
      onProgress(event) {
        if (["task_started", "task_finished"].includes(event.kind))
          process.stdout.write(`${JSON.stringify(event)}\n`);
      },
    });
    await json(join(root, "worker-receipt.json"), worker);
    assert.equal(
      worker.status,
      "passed",
      "Worker execution, summary binding, or cleanup verification failed.",
    );
    status = await control(ready, input.controlToken, "status");
    assert.equal(status.phase, "complete");
    assert.equal(status.passed, true);
    await json(join(root, "server-status.json"), status);
  } catch (error) {
    failure = {
      name: error.name,
      message: String(error.message)
        .replaceAll(input.workerToken, "[fixture-token]")
        .replaceAll(input.controlToken, "[control-token]"),
    };
  } finally {
    if (ready && !server.exit)
      try {
        await control(ready, input.controlToken, "stop");
      } catch (error) {
        failure ??= { name: error.name, message: "Server shutdown request failed." };
      }
    const forcedClosure = [];
    if (!ready && !server.exit)
      forcedClosure.push(await terminateOwnedServer(config, input, inputPath, "SIGTERM"));
    let closed = await Promise.race([server.closed, delay(20_000).then(() => null)]);
    if (closed === null) {
      failure ??= { name: "Error", message: "The owned Linux Server required forced shutdown." };
      forcedClosure.push(await terminateOwnedServer(config, input, inputPath, "SIGTERM"));
      closed = await Promise.race([server.closed, delay(15_000).then(() => null)]);
    }
    if (closed === null) {
      forcedClosure.push(await terminateOwnedServer(config, input, inputPath, "SIGKILL"));
      closed = await Promise.race([server.closed, delay(10_000).then(() => null)]);
    }
    if (closed === null)
      failure ??= {
        name: "Error",
        message:
          "Linux Server closure was not confirmed; its bounded watchdog must close the owned process.",
      };
    else if (closed.code !== 0)
      failure ??= { name: "Error", message: `Linux Server exited with code ${closed.code}.` };
    await writeFile(join(root, "server.log"), server.log(), { flag: "wx" });
    await json(join(root, "receipt.json"), {
      engine: engine.engine,
      cliVersion,
      serverDirectory: input.serverDirectory,
      worker,
      status,
      serverExit: closed,
      forcedClosure,
      failure,
    });
    process.stdout.write(
      `${JSON.stringify({ engine: engine.engine, stage: "finished", failure })}\n`,
    );
  }
  if (failure)
    throw new Error(`${engine.engine} Issue summary acceptance failed: ${failure.message}`);
}

assert.equal(
  process.platform,
  "win32",
  "Run the coordinator on the authorized Windows test machine.",
);
assert.equal(process.argv.length, 4, "Usage: node run.mjs <config.json> --allow-real-models");
assert.equal(process.argv[3], "--allow-real-models");
const config = JSON.parse(await readFile(resolve(process.argv[2]), "utf8"));
for (const key of [
  "runDirectory",
  "nodeExecutablePath",
  "gitExecutablePath",
  "processHostPath",
  "trustedExecutableRoot",
])
  config[key] = windowsPath(config[key], key);
for (const key of ["linuxNodeExecutablePath", "linuxSourceDirectory", "linuxRunParent"])
  config[key] = linuxPath(config[key], key);
assert.match(config.wslDistribution, /^[A-Za-z0-9._-]+$/u);
assert.equal(
  win32.normalize(process.execPath).toLowerCase(),
  config.nodeExecutablePath.toLowerCase(),
);
assert.ok(
  Array.isArray(config.engines) && config.engines.length >= 1 && config.engines.length <= 2,
);
assert.equal(new Set(config.engines.map((entry) => entry.engine)).size, config.engines.length);
for (const engine of config.engines) {
  assert.ok(["codex", "copilot"].includes(engine.engine));
  engine.cliExecutablePath = windowsPath(engine.cliExecutablePath, "cliExecutablePath");
}
await mkdir(config.runDirectory);
await json(join(config.runDirectory, "configuration.json"), config);
const harness = await buildWorker(config.runDirectory);
await prepareLinuxParent(config);
for (const engine of config.engines) await oneEngine(config, engine, harness);
await json(join(config.runDirectory, "complete.json"), {
  engines: config.engines.map((engine) => engine.engine),
  completedAt: new Date().toISOString(),
  maximumCliTasks: config.engines.length * 3,
  scope:
    "Public Issue snapshot and fixed upstream code, fresh anonymous Git fetch and 19-field Node measurement, configured CLI summaries, ordinary plus paired Evaluation workflow with frozen summary inputs. No actual GitHub writes.",
});
