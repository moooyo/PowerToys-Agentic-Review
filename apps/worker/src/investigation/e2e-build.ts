import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { win32 } from "node:path";
import {
  assertValidProcessLaunchSpec,
  assertWindowsLocalAbsolutePath,
  type ProcessLaunchSpec,
  type ProcessResourceLimits,
} from "../execution/process-host-protocol.js";
import type { PreparedInvestigationWorkspace } from "./workspace.js";

export interface E2eBuildRequest {
  readonly tool: "msbuild" | "dotnet";
  readonly projectPath: string;
  readonly configuration: "Debug" | "Release";
  readonly platform?: "x64" | "x86" | "ARM64" | "AnyCPU";
  readonly outputs: readonly string[];
  /** Optional project selected from a pinned .slnx solution, never an arbitrary MSBuild target. */
  readonly solutionProject?: string;
  /** Preserve a repository's declared output layout before sealing this freshly built tree. */
  readonly repositoryOutputDirectory?: string;
}

export interface E2eBuildArtifact {
  readonly relativePath: string;
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
}

export interface E2eBuildRecord {
  readonly id: string;
  readonly headSha: string;
  readonly projectPath: string;
  readonly projectDigest: string;
  readonly tool: E2eBuildRequest["tool"];
  readonly command: readonly string[];
  readonly artifacts: readonly E2eBuildArtifact[];
  readonly manifestDigest: string;
  readonly manifestFileCount: number;
  readonly identity: string;
}

export interface E2eBuildInput {
  readonly id: string;
  readonly request: E2eBuildRequest;
  readonly workspace: Pick<
    PreparedInvestigationWorkspace,
    | "sourceDirectory"
    | "sourceBinding"
    | "assertSourceBinding"
    | "readSourceFile"
    | "resolveSourcePath"
  >;
  /** Deployment-owned location outside the source tree, never a model-selected path. */
  readonly buildRootDirectory: string;
  /** Deployment-pinned compiler paths; model requests only select the dictionary key. */
  readonly tools: Readonly<Partial<Record<E2eBuildRequest["tool"], string>>>;
  /** Deployment-pinned Git used only for fixed preparation of the owned source checkout. */
  readonly gitExecutablePath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly limits: ProcessResourceLimits;
  readonly signal: AbortSignal;
  readonly run: (
    spec: ProcessLaunchSpec,
    signal: AbortSignal,
  ) => Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
}

type E2eBuildErrorCode =
  | "E2E_BUILD_REQUEST_INVALID"
  | "E2E_BUILD_TOOL_UNAVAILABLE"
  | "E2E_BUILD_SOURCE_INVALID"
  | "E2E_BUILD_FAILED"
  | "E2E_BUILD_ARTIFACT_INVALID"
  | "E2E_BUILD_RECORD_INVALID";

export class E2eBuildError extends Error {
  public constructor(
    public readonly code: E2eBuildErrorCode,
    message: string,
    public readonly diagnostics?: E2eBuildDiagnostics,
  ) {
    super(message);
    this.name = "E2eBuildError";
  }
}

export interface E2eBuildDiagnostics {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export function describeE2eBuildFailure(value: unknown): E2eBuildError {
  const result =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const limit = 16_384;
  const tail = (text: string): string => {
    const bytes = Buffer.from(text, "utf8");
    let start = Math.max(0, bytes.byteLength - limit);
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  };
  const diagnostics: E2eBuildDiagnostics = {
    exitCode:
      typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode)
        ? result.exitCode
        : null,
    stdout: tail(stdout),
    stderr: tail(stderr),
    outputTruncated:
      Buffer.byteLength(stdout, "utf8") > limit ||
      Buffer.byteLength(stderr, "utf8") > limit ||
      result.outputTruncated === true ||
      result.code === "OUTPUT_TRUNCATED",
  };
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/u).filter((line) => line.trim());
  const warning = (line: string): boolean => /\bwarning\b/iu.test(line);
  const detail =
    lines.find((line) => !warning(line) && /\b(?:error|fatal)\b/iu.test(line)) ??
    lines.find((line) => !warning(line) && /\b(?:MSB|NU|CS)[0-9]{4}\b/iu.test(line)) ??
    lines.at(-1) ??
    (value instanceof Error ? value.message : "No compiler diagnostics were reported.");
  return new E2eBuildError(
    "E2E_BUILD_FAILED",
    `The controlled compiler did not complete successfully (exit ${diagnostics.exitCode ?? "unknown"}). ${detail.slice(0, 2_048)}`,
    diagnostics,
  );
}

interface ArtifactObservation {
  readonly artifact: E2eBuildArtifact;
  readonly stat: BigIntStats;
}

interface OutputTreeFile {
  readonly path: string;
  readonly relativePath: string;
  readonly stat: BigIntStats;
}

interface OutputTree {
  readonly files: ReadonlyMap<string, OutputTreeFile>;
  readonly directories: ReadonlyMap<string, BigIntStats>;
}

interface BuildProvenance {
  readonly outputDirectory: string;
  readonly directoryIdentities: ReadonlyMap<string, BigIntStats>;
  readonly artifacts: ReadonlyMap<string, ArtifactObservation>;
  readonly manifest: ReadonlyMap<string, ArtifactObservation>;
  readonly outputTree: OutputTree;
  readonly startedAtNs: bigint;
  readonly completedAtNs: bigint;
  readonly identity: string;
}

// A JSON manifest or a caller-computed digest cannot issue a Worker build capability.
const issuedBuilds = new WeakMap<E2eBuildRecord, BuildProvenance>();
const requestKeys = new Set([
  "tool",
  "projectPath",
  "configuration",
  "platform",
  "outputs",
  "solutionProject",
  "repositoryOutputDirectory",
]);
const projectExtensions = new Set([
  ".sln",
  ".slnx",
  ".csproj",
  ".vcxproj",
  ".vbproj",
  ".fsproj",
  ".proj",
]);
const platforms = new Set(["x64", "x86", "ARM64", "AnyCPU"]);

/** Builds pinned source using a fixed compiler invocation and issues process-local provenance. */
export async function performE2eBuild(input: E2eBuildInput): Promise<E2eBuildRecord> {
  input.signal.throwIfAborted();
  const request = validateRequest(input.request);
  if (typeof input.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.id))
    throw failure("E2E_BUILD_REQUEST_INVALID", "The build identifier is invalid.");
  if (process.platform !== "win32")
    throw failure(
      "E2E_BUILD_TOOL_UNAVAILABLE",
      "Controlled E2E builds require the Windows Worker.",
    );
  const executable = configuredCompiler(input.tools, request.tool);
  const source = await readPinnedProject(input, request.projectPath);
  let solutionTarget: string | undefined;
  if (request.solutionProject !== undefined) {
    await readPinnedProject(input, request.solutionProject);
    const solution = await input.workspace.readSourceFile(request.projectPath);
    if (solution.content === null)
      throw failure("E2E_BUILD_SOURCE_INVALID", "The pinned solution text is unavailable.");
    solutionTarget = resolveE2eSolutionTarget(solution.content, request.solutionProject);
  }
  const buildRoot = validateBuildRoot(input.buildRootDirectory, source.sourceDirectory);
  await cleanBuildInputs(input, source);
  await ensureDirectory(buildRoot);
  input.signal.throwIfAborted();

  // mkdtemp is exclusive and unpredictable. Never adopt a caller's existing output tree.
  const directory = await mkdtemp(win32.join(buildRoot, "e2e-build-"));
  const outputDirectory = win32.join(directory, "output");
  const nativeOutput =
    request.repositoryOutputDirectory === undefined
      ? undefined
      : win32.join(source.sourceDirectory, request.repositoryOutputDirectory);
  if (nativeOutput !== undefined) {
    if (
      !within(source.sourceDirectory, nativeOutput) ||
      samePath(source.sourceDirectory, nativeOutput)
    )
      throw failure(
        "E2E_BUILD_REQUEST_INVALID",
        "Repository build output must remain inside the owned source checkout.",
      );
    try {
      await lstat(nativeOutput);
      throw failure(
        "E2E_BUILD_SOURCE_INVALID",
        "Repository build output must be absent after clean; existing or tracked output cannot be adopted.",
      );
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  } else await mkdir(outputDirectory, { mode: 0o700 });
  const directoryIdentities = new Map(
    await directoryChain(nativeOutput === undefined ? outputDirectory : directory),
  );
  const args = compilerArguments(
    request,
    source.absoluteProjectPath,
    outputDirectory,
    solutionTarget,
  );
  const spec: ProcessLaunchSpec = {
    executable,
    arguments: args,
    workingDirectory: source.sourceDirectory,
    environmentMode: "replace",
    environment: buildEnvironment(input.environment, directory),
    limits: { ...input.limits },
  };
  assertValidProcessLaunchSpec(spec);
  await assertSourceUnchanged(input, source.headSha, request.projectPath, source.projectDigest);
  input.signal.throwIfAborted();
  const startedAtNs = await writeClockMarker(directory, "started");
  let result: Awaited<ReturnType<E2eBuildInput["run"]>>;
  try {
    result = await input.run(spec, input.signal);
  } catch (error) {
    input.signal.throwIfAborted();
    throw describeE2eBuildFailure(error);
  }
  input.signal.throwIfAborted();
  const completedAtNs = await writeClockMarker(directory, "completed");
  await assertSourceUnchanged(input, source.headSha, request.projectPath, source.projectDigest);
  if (result.exitCode !== 0) throw describeE2eBuildFailure(result);
  if (completedAtNs < startedAtNs)
    throw failure("E2E_BUILD_ARTIFACT_INVALID", "The build filesystem clock moved backwards.");
  await assertDirectoryIdentities(directoryIdentities);
  if (nativeOutput !== undefined) {
    await readOutputTree(nativeOutput);
    await assertSourceUnchanged(input, source.headSha, request.projectPath, source.projectDigest);
    // Both absolute paths are resolved descendants of this attempt's verified source/control roots.
    if (!within(source.sourceDirectory, nativeOutput) || !within(buildRoot, outputDirectory))
      throw failure(
        "E2E_BUILD_ARTIFACT_INVALID",
        "The repository output seal escaped its owned workspace.",
      );
    await rename(nativeOutput, outputDirectory);
    await assertSourceUnchanged(input, source.headSha, request.projectPath, source.projectDigest);
    for (const [path, identity] of await directoryChain(outputDirectory))
      directoryIdentities.set(path, identity);
  }

  const outputTree = await readOutputTree(outputDirectory);
  const requestedPaths = new Set(
    request.outputs.map((path) => pathKey(win32.join(outputDirectory, path))),
  );
  const manifest = new Map<string, ArtifactObservation>();
  for (const [key, file] of outputTree.files) {
    input.signal.throwIfAborted();
    const observation = await observeArtifact(
      file.path,
      file.relativePath,
      startedAtNs,
      completedAtNs,
      requestedPaths.has(key),
    );
    if (!sameFile(file.stat, observation.stat))
      throw failure(
        "E2E_BUILD_ARTIFACT_INVALID",
        "The output tree changed while its manifest was being captured.",
      );
    manifest.set(key, observation);
  }
  const observations = new Map<string, ArtifactObservation>();
  for (const relativePath of request.outputs) {
    const key = pathKey(win32.join(outputDirectory, relativePath));
    const observation = manifest.get(key);
    if (observation === undefined)
      throw failure(
        "E2E_BUILD_ARTIFACT_INVALID",
        "The compiler did not produce every declared artifact.",
      );
    observations.set(key, observation);
  }
  assertSameOutputTree(outputTree, await readOutputTree(outputDirectory));
  await assertDirectoryIdentities(directoryIdentities);
  input.signal.throwIfAborted();
  const fields = {
    id: input.id,
    headSha: source.headSha,
    projectPath: request.projectPath,
    projectDigest: source.projectDigest,
    tool: request.tool,
    command: Object.freeze([executable, ...args]),
    artifacts: Object.freeze([...observations.values()].map(({ artifact }) => artifact)),
    manifestDigest: outputManifestDigest(manifest),
    manifestFileCount: manifest.size,
  };
  const record: E2eBuildRecord = Object.freeze({ ...fields, identity: buildIdentity(fields) });
  issuedBuilds.set(record, {
    outputDirectory,
    directoryIdentities,
    artifacts: observations,
    manifest,
    outputTree,
    startedAtNs,
    completedAtNs,
    identity: record.identity,
  });
  return record;
}

/** Rechecks the entire loadable output tree and the entry bytes immediately before launch. */
export async function validateE2eBuildArtifact(
  record: E2eBuildRecord,
  path: string,
): Promise<E2eBuildArtifact> {
  return await validateBuildFile(record, path, false);
}

/** Verifies a child executable or another loadable file against the complete build manifest. */
export async function validateE2eBuildFile(
  record: E2eBuildRecord,
  path: string,
): Promise<E2eBuildArtifact> {
  return await validateBuildFile(record, path, true);
}

async function validateBuildFile(
  record: E2eBuildRecord,
  path: string,
  includeDependencies: boolean,
): Promise<E2eBuildArtifact> {
  const provenance = issuedBuilds.get(record);
  if (
    provenance === undefined ||
    record.identity !== provenance.identity ||
    buildIdentity(record) !== record.identity
  )
    throw failure("E2E_BUILD_RECORD_INVALID", "The build record was not issued by this Worker.");
  let absolutePath: string;
  try {
    if (win32.isAbsolute(path)) {
      assertWindowsLocalAbsolutePath(path, "artifact path", false);
      absolutePath = win32.resolve(path);
    } else {
      absolutePath = win32.join(provenance.outputDirectory, relativePath(path));
    }
  } catch {
    throw failure("E2E_BUILD_ARTIFACT_INVALID", "The artifact path is invalid.");
  }
  const key = pathKey(absolutePath);
  const expected = (includeDependencies ? provenance.manifest : provenance.artifacts).get(key);
  if (expected === undefined)
    throw failure(
      "E2E_BUILD_ARTIFACT_INVALID",
      "The requested file is not a recorded build artifact.",
    );
  await assertDirectoryIdentities(provenance.directoryIdentities);
  await assertOutputManifest(provenance);
  const observed = await observeArtifact(
    expected.artifact.path,
    expected.artifact.relativePath,
    provenance.startedAtNs,
    provenance.completedAtNs,
    provenance.artifacts.has(key),
  );
  await assertOutputManifest(provenance);
  await assertDirectoryIdentities(provenance.directoryIdentities);
  if (
    !sameFile(expected.stat, observed.stat) ||
    expected.artifact.digest !== observed.artifact.digest ||
    expected.artifact.byteLength !== observed.artifact.byteLength
  )
    throw failure(
      "E2E_BUILD_ARTIFACT_INVALID",
      "The build artifact changed after the compiler completed.",
    );
  return expected.artifact;
}

function validateRequest(value: E2eBuildRequest): E2eBuildRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !requestKeys.has(key)) ||
    (value.tool !== "msbuild" && value.tool !== "dotnet") ||
    (value.configuration !== "Debug" && value.configuration !== "Release") ||
    (value.platform !== undefined && !platforms.has(value.platform)) ||
    !Array.isArray(value.outputs) ||
    value.outputs.length === 0 ||
    value.outputs.length > 64
  )
    throw failure("E2E_BUILD_REQUEST_INVALID", "The controlled build request is invalid.");
  const projectPath = relativePath(value.projectPath);
  if (!projectExtensions.has(win32.extname(projectPath).toLowerCase()))
    throw failure("E2E_BUILD_REQUEST_INVALID", "The build project type is not supported.");
  const solutionProject =
    value.solutionProject === undefined ? undefined : relativePath(value.solutionProject);
  const repositoryOutputDirectory =
    value.repositoryOutputDirectory === undefined
      ? undefined
      : relativePath(value.repositoryOutputDirectory);
  if (
    (solutionProject !== undefined &&
      (value.tool !== "msbuild" ||
        win32.extname(projectPath).toLowerCase() !== ".slnx" ||
        !projectExtensions.has(win32.extname(solutionProject).toLowerCase()) ||
        /\.slnx?$/iu.test(solutionProject))) ||
    (repositoryOutputDirectory !== undefined &&
      (value.tool !== "msbuild" ||
        repositoryOutputDirectory.split("/").some((part) => part.toLowerCase() === ".git")))
  )
    throw failure(
      "E2E_BUILD_REQUEST_INVALID",
      "Native layout requires MSBuild and solution selection requires a pinned .slnx project entry.",
    );
  const outputs = value.outputs.map((path) => {
    const normalized = relativePath(path);
    if (![".exe", ".dll"].includes(win32.extname(normalized).toLowerCase()))
      throw failure(
        "E2E_BUILD_REQUEST_INVALID",
        "Build artifacts must be executable or library files.",
      );
    return normalized;
  });
  if (new Set(outputs.map((path) => path.toLowerCase())).size !== outputs.length)
    throw failure("E2E_BUILD_REQUEST_INVALID", "Build artifact paths must be distinct.");
  return Object.freeze({
    tool: value.tool,
    projectPath,
    configuration: value.configuration,
    ...(value.platform === undefined ? {} : { platform: value.platform }),
    outputs: Object.freeze(outputs),
    ...(solutionProject === undefined ? {} : { solutionProject }),
    ...(repositoryOutputDirectory === undefined ? {} : { repositoryOutputDirectory }),
  });
}

/** Resolve the documented solution-folder/project target syntax from the pinned SLNX entry. */
export function resolveE2eSolutionTarget(xml: string, selectedProject: string): string {
  const selected = relativePath(selectedProject);
  if (xml.length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/iu.test(xml))
    throw failure("E2E_BUILD_SOURCE_INVALID", "The solution uses unsupported XML declarations.");
  const folders: string[] = [];
  const targets: string[] = [];
  const attribute = (source: string, name: string): string | undefined => {
    const value = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "u").exec(source)?.[2];
    if (value === undefined) return undefined;
    if (value.includes("&"))
      throw failure(
        "E2E_BUILD_SOURCE_INVALID",
        "Solution target names must use literal bounded path attributes.",
      );
    return value;
  };
  for (const tag of xml
    .replace(/<!--[\s\S]*?-->/gu, "")
    .matchAll(/<\s*(\/?)\s*(Folder|Project)\b([^>]*?)(\/?)\s*>/gu)) {
    const closing = tag[1] === "/";
    const kind = tag[2];
    const attributes = tag[3]!;
    if (kind === "Folder") {
      if (closing) {
        if (folders.length === 0)
          throw failure("E2E_BUILD_SOURCE_INVALID", "The solution folder structure is invalid.");
        folders.pop();
        continue;
      }
      const name = attribute(attributes, "Name");
      if (name === undefined)
        throw failure("E2E_BUILD_SOURCE_INVALID", "The solution folder has no name.");
      const clean = name.replace(/^\/+|\/+$/gu, "").replaceAll("/", "\\");
      if (
        clean.split("\\").some((part) => !part || part === "." || part === "..") ||
        /[:;<>|?*]/u.test(clean)
      )
        throw failure("E2E_BUILD_SOURCE_INVALID", "The solution folder name is unsupported.");
      folders.push(
        name.startsWith("/") || folders.length === 0 ? clean : `${folders.at(-1)}\\${clean}`,
      );
      if (tag[4] === "/") folders.pop();
    } else if (!closing) {
      const path = attribute(attributes, "Path");
      if (path === undefined || path.replaceAll("\\", "/") !== selected) continue;
      if (
        attribute(attributes, "DisplayName") !== undefined ||
        attribute(attributes, "Name") !== undefined
      )
        throw failure(
          "E2E_BUILD_SOURCE_INVALID",
          "A renamed solution project requires an unambiguous supported target name.",
        );
      const projectName = win32.basename(selected, win32.extname(selected));
      const uniqueName = [folders.at(-1), projectName]
        .filter(Boolean)
        .join("\\")
        .replace(/[%$@;.()']/gu, "_");
      if (!/^[A-Za-z0-9_ \\-]+$/u.test(uniqueName))
        throw failure(
          "E2E_BUILD_SOURCE_INVALID",
          "The solution project target name is unsupported.",
        );
      targets.push(
        ["Build", "Rebuild", "Clean", "Publish"].some(
          (name) => name.toLowerCase() === uniqueName.toLowerCase(),
        )
          ? `Solution:${uniqueName}`
          : uniqueName,
      );
    }
  }
  if (targets.length !== 1 || folders.length !== 0)
    throw failure(
      "E2E_BUILD_SOURCE_INVALID",
      "The requested project must identify one unambiguous pinned solution entry.",
    );
  return targets[0]!;
}

function relativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    win32.isAbsolute(value) ||
    /^[\\/\-@]/u.test(value) ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Build paths must reject all control bytes and Windows argument separators.
    /[\u0000-\u001f\u007f:;,%"<>|?*]/u.test(value)
  )
    throw failure("E2E_BUILD_REQUEST_INVALID", "A build path must be a safe relative file path.");
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || /[. ]$/u.test(part))
  )
    throw failure("E2E_BUILD_REQUEST_INVALID", "A build path contains an unsafe component.");
  try {
    assertWindowsLocalAbsolutePath(`C:\\${normalized}`, "relative build path", false);
  } catch {
    throw failure(
      "E2E_BUILD_REQUEST_INVALID",
      "A build path contains an invalid Windows component.",
    );
  }
  return normalized;
}

function configuredCompiler(tools: E2eBuildInput["tools"], tool: E2eBuildRequest["tool"]): string {
  const executable = Object.hasOwn(tools, tool) ? tools[tool] : undefined;
  try {
    if (executable === undefined || win32.basename(executable).toLowerCase() !== `${tool}.exe`)
      throw new Error("Unconfigured compiler.");
    assertWindowsLocalAbsolutePath(executable, "compiler executable", true);
    return executable;
  } catch {
    throw failure(
      "E2E_BUILD_TOOL_UNAVAILABLE",
      "The requested compiler has no pinned deployment path.",
    );
  }
}

async function readPinnedProject(input: E2eBuildInput, projectPath: string) {
  try {
    const { sourceDirectory, sourceBinding } = input.workspace;
    if (
      sourceDirectory === null ||
      sourceBinding === null ||
      sourceBinding.patchDigest !== null ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceBinding.sourceSha)
    )
      throw new Error("Unpinned source.");
    assertWindowsLocalAbsolutePath(sourceDirectory, "build source directory", false);
    await input.workspace.assertSourceBinding();
    const project = await input.workspace.readSourceFile(projectPath);
    if (
      project === null ||
      typeof project.content !== "string" ||
      typeof project.digest !== "string" ||
      project.digest !== sha256(project.content) ||
      relativePath(project.path) !== projectPath
    )
      throw new Error("Untracked or changed project.");
    const absoluteProjectPath = await input.workspace.resolveSourcePath(projectPath);
    assertWindowsLocalAbsolutePath(absoluteProjectPath, "build project", false);
    if (!samePath(absoluteProjectPath, win32.join(sourceDirectory, projectPath)))
      throw new Error("Project path escaped the pinned source.");
    input.signal.throwIfAborted();
    return {
      sourceDirectory,
      projectPath,
      headSha: sourceBinding.sourceSha,
      projectDigest: project.digest,
      absoluteProjectPath,
    };
  } catch (error) {
    input.signal.throwIfAborted();
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      /^(?:SOURCE|WORKSPACE)_[A-Z0-9_]+$/u.test(error.code)
        ? error.code
        : undefined;
    const detail =
      error instanceof Error
        ? `${code === undefined ? "" : `${code}: `}${error.message.slice(0, 1_024)}`
        : "The source reader did not provide verified project text.";
    throw failure(
      "E2E_BUILD_SOURCE_INVALID",
      `The build project is not verified text from the pinned source revision. ${detail}`,
    );
  }
}

async function assertSourceUnchanged(
  input: E2eBuildInput,
  headSha: string,
  projectPath: string,
  digest: string,
): Promise<void> {
  const observed = await readPinnedProject(input, projectPath);
  if (observed.headSha !== headSha || observed.projectDigest !== digest)
    throw failure(
      "E2E_BUILD_SOURCE_INVALID",
      "The pinned source revision changed during the build.",
    );
}

async function cleanBuildInputs(
  input: E2eBuildInput,
  source: Awaited<ReturnType<typeof readPinnedProject>>,
): Promise<void> {
  try {
    assertWindowsLocalAbsolutePath(input.gitExecutablePath, "build preparation Git", true);
    if (win32.basename(input.gitExecutablePath).toLowerCase() !== "git.exe")
      throw new Error("The deployment Git executable is unavailable.");
  } catch {
    throw failure(
      "E2E_BUILD_TOOL_UNAVAILABLE",
      "Build preparation requires the pinned deployment Git executable.",
    );
  }
  try {
    const gitDirectory = win32.join(source.sourceDirectory, ".git");
    const sourceDirectories = await directoryChain(gitDirectory);
    await assertSourceUnchanged(input, source.headSha, source.projectPath, source.projectDigest);
    const environment = {
      ...Object.fromEntries(
        Object.entries(input.environment)
          .map(([name, value]) => [name.toUpperCase(), value] as const)
          .filter(([name]) =>
            ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT"].includes(name),
          ),
      ),
      HOME: source.sourceDirectory,
      USERPROFILE: source.sourceDirectory,
      XDG_CONFIG_HOME: source.sourceDirectory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "NUL",
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_PAGER: "",
      GIT_EDITOR: "",
      LC_ALL: "C",
      LANG: "C",
      TEMP: source.sourceDirectory,
      TMP: source.sourceDirectory,
    };
    const spec: ProcessLaunchSpec = {
      executable: input.gitExecutablePath,
      arguments: [
        `--git-dir=${gitDirectory}`,
        `--work-tree=${source.sourceDirectory}`,
        "-c",
        "core.hooksPath=NUL",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.protectNTFS=true",
        "-c",
        "core.longpaths=true",
        "-c",
        "submodule.recurse=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "clean",
        "-ffdqx",
        "--",
        ".",
      ],
      workingDirectory: source.sourceDirectory,
      environmentMode: "replace",
      environment,
      limits: { ...input.limits },
    };
    assertValidProcessLaunchSpec(spec);
    await assertDirectoryIdentities(sourceDirectories);
    input.signal.throwIfAborted();
    const result = await input.run(spec, input.signal);
    input.signal.throwIfAborted();
    await assertDirectoryIdentities(sourceDirectories);
    if (result.exitCode !== 0) throw new Error("The owned source cleanup failed.");
    await assertSourceUnchanged(input, source.headSha, source.projectPath, source.projectDigest);
  } catch {
    input.signal.throwIfAborted();
    throw failure(
      "E2E_BUILD_SOURCE_INVALID",
      "The owned source checkout could not be safely cleaned and reverified.",
    );
  }
}

function validateBuildRoot(root: string, sourceDirectory: string): string {
  try {
    assertWindowsLocalAbsolutePath(root, "build root directory", false);
    // MSBuild property values have their own list/escaping syntax, independent of process argv.
    if (/[;,"%$]/u.test(root) || within(sourceDirectory, root))
      throw new Error("Unsafe output root.");
    return win32.resolve(root);
  } catch {
    throw failure(
      "E2E_BUILD_REQUEST_INVALID",
      "The Worker build root must be a safe directory outside the source tree.",
    );
  }
}

function compilerArguments(
  request: E2eBuildRequest,
  project: string,
  output: string,
  solutionTarget?: string,
): readonly string[] {
  // Forward slashes retain a trailing directory separator without Windows quote/backslash ambiguity.
  const directoryProperty = (path: string): string => `${path.replaceAll("\\", "/")}/`;
  // Keep each referenced project's intermediate layout instead of sharing obj/assets across projects.
  const properties = [
    ...(request.platform === undefined ? [] : [`-property:Platform=${request.platform}`]),
    "-property:UseSharedCompilation=false",
    "-noAutoResponse",
    "-nodeReuse:false",
    "-maxCpuCount:1",
    // Bound native compiler parallelism independently of the MSBuild node count.
    "-property:CL_MPCount=1",
    "-verbosity:minimal",
    // Explicit Summary replays errors at build completion into the bounded output tail.
    "-consoleLoggerParameters:Summary;DisableConsoleColor",
  ];
  return Object.freeze(
    request.tool === "msbuild"
      ? [
          project,
          "-restore",
          "-property:RestorePackagesConfig=true",
          `-target:${solutionTarget === undefined ? "" : `${solutionTarget}:`}Rebuild`,
          `-property:Configuration=${request.configuration}`,
          ...(request.repositoryOutputDirectory === undefined
            ? [`-property:OutDir=${directoryProperty(output)}`]
            : []),
          ...properties,
        ]
      : [
          "build",
          project,
          "--configuration",
          request.configuration,
          "--no-incremental",
          "--output",
          output,
          ...properties,
        ],
  );
}

function buildEnvironment(
  environment: E2eBuildInput["environment"],
  directory: string,
): Record<string, string> {
  const overrides = {
    TEMP: directory,
    TMP: directory,
    MSBUILDDISABLENODEREUSE: "1",
    DOTNET_CLI_USE_MSBUILD_SERVER: "0",
  };
  const protectedNames = new Set(Object.keys(overrides));
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(([name]) => !protectedNames.has(name.toUpperCase())),
    ),
    ...overrides,
  };
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await lstat(path, { bigint: true });
    await directoryChain(path);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const parent = win32.dirname(path);
  if (samePath(path, parent))
    throw failure(
      "E2E_BUILD_ARTIFACT_INVALID",
      "The build directory has no available filesystem root.",
    );
  await ensureDirectory(parent);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await directoryChain(path);
}

async function directoryChain(path: string): Promise<ReadonlyMap<string, BigIntStats>> {
  const chain = new Map<string, BigIntStats>();
  let current = win32.resolve(path);
  try {
    while (true) {
      const stat = await lstat(current, { bigint: true });
      if (!stat.isDirectory() || isLink(stat) || !samePath(await realpath(current), current))
        throw new Error("Redirected build directory.");
      chain.set(current, stat);
      const parent = win32.dirname(current);
      if (samePath(current, parent)) break;
      current = parent;
    }
    return chain;
  } catch {
    throw failure("E2E_BUILD_ARTIFACT_INVALID", "A build directory is unavailable or redirected.");
  }
}

async function assertDirectoryIdentities(
  expected: ReadonlyMap<string, BigIntStats>,
): Promise<void> {
  for (const [path, original] of expected) {
    const actual = (await directoryChain(path)).get(path);
    if (actual === undefined || actual.dev !== original.dev || actual.ino !== original.ino)
      throw failure("E2E_BUILD_ARTIFACT_INVALID", "A build directory was replaced.");
  }
}

async function writeClockMarker(directory: string, label: string): Promise<bigint> {
  const path = win32.join(directory, `${label}-${randomUUID()}.marker`);
  await writeFile(path, label, { flag: "wx", mode: 0o600 });
  return (await lstat(path, { bigint: true })).mtimeNs;
}

async function readOutputTree(outputDirectory: string): Promise<OutputTree> {
  const files = new Map<string, OutputTreeFile>();
  const directories = new Map<string, BigIntStats>();
  const visit = async (directory: string): Promise<void> => {
    const original = await lstat(directory, { bigint: true });
    if (
      !original.isDirectory() ||
      isLink(original) ||
      !samePath(await realpath(directory), directory)
    )
      throw new Error("The build output contains a redirected directory.");
    directories.set(pathKey(directory), original);
    for (const name of (await readdir(directory)).sort()) {
      const path = win32.join(directory, name);
      assertWindowsLocalAbsolutePath(path, "build output file", false);
      if (!within(outputDirectory, path))
        throw new Error("The output path escaped the build tree.");
      const stat = await lstat(path, { bigint: true });
      if (isLink(stat)) throw new Error("The build output contains a link.");
      if (stat.isDirectory()) {
        await visit(path);
      } else {
        if (!stat.isFile() || stat.nlink !== 1n || !samePath(await realpath(path), path))
          throw new Error("The build output contains an unsafe file.");
        const key = pathKey(path);
        if (files.has(key)) throw new Error("The build output contains ambiguous file names.");
        files.set(key, {
          path,
          relativePath: win32.relative(outputDirectory, path).replaceAll("\\", "/"),
          stat,
        });
      }
    }
    if (!sameDirectory(original, await lstat(directory, { bigint: true })))
      throw new Error("The output directory changed during enumeration.");
  };
  try {
    await visit(outputDirectory);
    return { files, directories };
  } catch {
    throw failure(
      "E2E_BUILD_ARTIFACT_INVALID",
      "The complete build output tree is missing, redirected, or changed.",
    );
  }
}

function assertSameOutputTree(expected: OutputTree, actual: OutputTree): void {
  if (
    expected.files.size !== actual.files.size ||
    expected.directories.size !== actual.directories.size
  )
    throw failure(
      "E2E_BUILD_ARTIFACT_INVALID",
      "Files or directories were added to or removed from the build output.",
    );
  for (const [key, original] of expected.files) {
    const observed = actual.files.get(key);
    if (
      observed === undefined ||
      observed.relativePath !== original.relativePath ||
      !sameFile(original.stat, observed.stat)
    )
      throw failure(
        "E2E_BUILD_ARTIFACT_INVALID",
        "A file in the complete build output manifest changed.",
      );
  }
  for (const [key, original] of expected.directories) {
    const observed = actual.directories.get(key);
    if (observed === undefined || !sameDirectory(original, observed))
      throw failure(
        "E2E_BUILD_ARTIFACT_INVALID",
        "A directory in the complete build output manifest changed.",
      );
  }
}

async function assertOutputManifest(provenance: BuildProvenance): Promise<void> {
  const observed = await readOutputTree(provenance.outputDirectory);
  assertSameOutputTree(provenance.outputTree, observed);
  // Initial hashes are bound to exact file identities and change times. Unchanged metadata
  // avoids rehashing every dependency on each interaction; any change fails closed.
  for (const [key, original] of provenance.manifest) {
    const file = observed.files.get(key);
    if (file === undefined || !sameFile(original.stat, file.stat))
      throw failure(
        "E2E_BUILD_ARTIFACT_INVALID",
        "A hashed build dependency changed after manifest capture.",
      );
  }
}

function outputManifestDigest(manifest: ReadonlyMap<string, ArtifactObservation>): string {
  const entries = [...manifest.values()]
    .map(({ artifact }) => artifact)
    .sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
  return sha256(JSON.stringify(entries));
}

async function observeArtifact(
  path: string,
  relativePath: string,
  startedAtNs: bigint,
  completedAtNs: bigint,
  enforceBuildWindow = true,
): Promise<ArtifactObservation> {
  try {
    await directoryChain(win32.dirname(path));
    const original = await lstat(path, { bigint: true });
    if (
      !original.isFile() ||
      isLink(original) ||
      !samePath(await realpath(path), path) ||
      original.nlink !== 1n ||
      original.size < 0n ||
      original.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      (enforceBuildWindow &&
        (original.size === 0n ||
          original.mtimeNs < startedAtNs ||
          original.mtimeNs > completedAtNs ||
          original.birthtimeNs < startedAtNs ||
          original.birthtimeNs > completedAtNs))
    )
      throw new Error("Artifact was not produced inside the compiler output interval.");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(original, await handle.stat({ bigint: true })))
        throw new Error("Artifact was replaced while opening.");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(65_536);
      let byteLength = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        byteLength += bytesRead;
        if (byteLength > Number(original.size)) throw new Error("Artifact grew while reading.");
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (
        byteLength !== Number(original.size) ||
        !sameFile(original, await handle.stat({ bigint: true })) ||
        !sameFile(original, await lstat(path, { bigint: true }))
      )
        throw new Error("Artifact changed while reading.");
      await directoryChain(win32.dirname(path));
      return {
        artifact: Object.freeze({ relativePath, path, digest: hash.digest("hex"), byteLength }),
        stat: original,
      };
    } finally {
      await handle.close();
    }
  } catch {
    throw failure(
      "E2E_BUILD_ARTIFACT_INVALID",
      "The compiler output is missing, redirected, stale, or changed.",
    );
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    !isLink(right) &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isDirectory() &&
    !isLink(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function isLink(stat: BigIntStats): boolean {
  return (
    stat.isSymbolicLink() ||
    (stat as BigIntStats & { isReparsePoint?(): boolean }).isReparsePoint?.() === true
  );
}

function within(root: string, path: string): boolean {
  const relative = win32.relative(win32.resolve(root), win32.resolve(path));
  return (
    relative === "" ||
    (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"))
  );
}

function pathKey(path: string): string {
  return win32.resolve(path).toLowerCase();
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildIdentity(record: Omit<E2eBuildRecord, "identity">): string {
  return sha256(
    JSON.stringify({
      schemaVersion: "InvestigationE2eBuildV1",
      id: record.id,
      headSha: record.headSha,
      projectPath: record.projectPath,
      projectDigest: record.projectDigest,
      tool: record.tool,
      command: record.command,
      artifacts: record.artifacts,
      manifestDigest: record.manifestDigest,
      manifestFileCount: record.manifestFileCount,
    }),
  );
}
function failure(code: E2eBuildErrorCode, message: string): E2eBuildError {
  return new E2eBuildError(code, message);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
