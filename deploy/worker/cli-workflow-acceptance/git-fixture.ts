import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface GitFixtureOptions {
  readonly directory: string;
  readonly gitExecutablePath: string;
  readonly repoFullName: string;
}

export interface GitFixture {
  readonly repoFullName: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly bareDirectory: string;
  readonly sourceDirectory: string;
  readonly fixtureCheckScript: "check.mjs";
  readonly reviewPrompt: string;
  readonly expectedFinding: { readonly path: "src/discount.js"; readonly line: 2 };
  readonly fileSha256: Readonly<Record<string, string>>;
  readonly commands: readonly { readonly arguments: readonly string[]; readonly stdout: string }[];
}

/** Creates only a new, owned repository; no existing Git configuration or remote is changed. */
export async function createGitFixture(options: GitFixtureOptions): Promise<GitFixture> {
  assert.equal(process.platform, "win32");
  assert.ok(win32.isAbsolute(options.directory));
  assert.ok(win32.isAbsolute(options.gitExecutablePath));
  assert.notEqual(win32.normalize(options.directory), win32.parse(options.directory).root);
  const repoFullName = options.repoFullName;
  assert.match(repoFullName, /^agentic-review-fixture\/workflow-[a-f0-9]{16}$/u);
  await mkdir(options.directory);
  const directory = await realpath(options.directory);
  const sourceDirectory = join(directory, "source");
  const bareDirectory = join(directory, "repository.git");
  const tempDirectory = join(directory, "temp");
  await mkdir(tempDirectory);
  const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot;
  assert.ok(systemRoot);
  const environment = {
    SYSTEMROOT: systemRoot,
    COMSPEC: join(systemRoot, "System32", "cmd.exe"),
    PATH: `${dirname(options.gitExecutablePath)};${join(systemRoot, "System32")}`,
    PATHEXT: ".EXE;.CMD",
    HOME: tempDirectory,
    USERPROFILE: tempDirectory,
    TEMP: tempDirectory,
    TMP: tempDirectory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  const commands: { arguments: readonly string[]; stdout: string }[] = [];
  const git = async (...argumentsList: string[]): Promise<string> => {
    const args = [
      "-c",
      "user.name=Agentic Review Synthetic Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "core.hooksPath=NUL",
      "-c",
      "init.templateDir=",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      ...argumentsList,
    ];
    const result = await executeFile(options.gitExecutablePath, args, {
      cwd: directory,
      env: environment,
      windowsHide: true,
      shell: false,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    commands.push({ arguments: args, stdout: result.stdout.trim() });
    return result.stdout.trim();
  };
  await git("init", "--quiet", "--initial-branch=main", "--object-format=sha1", sourceDirectory);
  await mkdir(join(sourceDirectory, "src"));
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "owned-cli-workflow-fixture", private: true, type: "module", scripts: { test: "node check.mjs" } }, null, 2)}\n`,
    "README.md":
      "# Discount calculation\n\n`applyDiscount(price, percent)` returns the price after applying a percentage discount.\n`percent` is a number from 0 through 100, inclusive; it is not a fraction.\nFor example, a price of 100 with a 25 percent discount must return 75.\nA zero percent discount leaves the price unchanged.\n\nRun `node check.mjs` for the dependency-free smoke check.\nThe smoke check covers only the zero percent case, so passing it does not prove all documented cases.\n",
    "check.mjs":
      "import assert from 'node:assert/strict';\nimport { applyDiscount } from './src/discount.js';\nassert.equal(applyDiscount(100, 0), 100);\nassert.equal(applyDiscount(49, 0), 49);\nconsole.log('Zero-percent discount smoke checks passed.');\n",
    "src/discount.js":
      "export function applyDiscount(price, percent) {\n  return price * (1 - percent / 100);\n}\n",
  };
  for (const [path, content] of Object.entries(files))
    await writeFile(join(sourceDirectory, path), content, { flag: "wx" });
  await git("-C", sourceDirectory, "add", "--all");
  await git(
    "-C",
    sourceDirectory,
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "Add the documented percentage calculation",
  );
  const baseSha = await git("-C", sourceDirectory, "rev-parse", "HEAD");
  files["src/discount.js"] =
    "export function applyDiscount(price, percent) {\n  return price * (1 - percent);\n}\n";
  await writeFile(join(sourceDirectory, "src/discount.js"), files["src/discount.js"]);
  await git("-C", sourceDirectory, "add", "src/discount.js");
  await git(
    "-C",
    sourceDirectory,
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "Simplify the discount calculation",
  );
  const headSha = await git("-C", sourceDirectory, "rev-parse", "HEAD");
  assert.match(baseSha, /^[a-f0-9]{40}$/u);
  assert.match(headSha, /^[a-f0-9]{40}$/u);
  assert.notEqual(baseSha, headSha);
  await git(
    "clone",
    "--quiet",
    "--bare",
    "--no-hardlinks",
    "--local",
    sourceDirectory,
    bareDirectory,
  );
  await git(`--git-dir=${bareDirectory}`, "update-ref", "refs/pull/1/head", headSha);
  assert.equal(await git(`--git-dir=${bareDirectory}`, "rev-parse", "refs/pull/1/head"), headSha);
  assert.equal(await git("-C", sourceDirectory, "status", "--porcelain=v1"), "");
  const fileSha256: Record<string, string> = {};
  for (const path of Object.keys(files))
    fileSha256[path] = createHash("sha256")
      .update(await readFile(join(sourceDirectory, path)))
      .digest("hex");
  return {
    repoFullName,
    baseSha,
    headSha,
    bareDirectory,
    sourceDirectory,
    fixtureCheckScript: "check.mjs",
    expectedFinding: { path: "src/discount.js", line: 2 },
    fileSha256,
    commands,
    reviewPrompt: [
      "Review this owned synthetic pull request for concrete correctness defects.",
      `The exact base commit is ${baseSha}; the exact head commit is ${headSha}.`,
      "Inspect their local Git diff and the checked-out source against the README contract. You may run the local dependency-free check with Node.",
      "Keep all inspection inside the disposable checkout. Do not modify repository files, install dependencies, fetch or push any remote, access GitHub, or create, edit, comment on, review, or merge any pull request or issue.",
      "Do not inspect credentials, provider configuration, authentication files, or files outside this checkout.",
      "Report only actionable findings supported by the actual source. Passing the smoke check alone is not a correctness assessment.",
      "Return the required PrReviewPlanV2 JSON. Set requestedRecipeIds to an empty array and describe only verification you actually performed.",
    ].join("\n"),
  };
}
