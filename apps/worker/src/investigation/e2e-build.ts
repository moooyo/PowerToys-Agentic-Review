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
import type { InvestigationSourceBinding, PreparedInvestigationWorkspace } from "./workspace.js";

export interface E2eMsbuildToolchain {
  readonly vcToolsVersion: string;
  readonly platformToolset: "v143" | "v145";
}

/** Only deployment configuration may select a supported, exact MSVC toolset. */
export function parseE2eMsbuildToolchain(value: unknown): E2eMsbuildToolchain {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw failure("E2E_BUILD_TOOL_UNAVAILABLE", "The deployment MSBuild toolchain is invalid.");
  const entry = value as Record<string, unknown>;
  const version = entry.vcToolsVersion;
  if (
    Object.keys(entry).length !== 2 ||
    !Object.hasOwn(entry, "vcToolsVersion") ||
    !Object.hasOwn(entry, "platformToolset") ||
    typeof version !== "string" ||
    !/^14\.[3-9][0-9]\.[0-9]{5}(?![\s\S])/u.test(version) ||
    entry.platformToolset !== (Number(version.split(".")[1]) < 50 ? "v143" : "v145")
  )
    throw failure(
      "E2E_BUILD_TOOL_UNAVAILABLE",
      "The deployment MSBuild toolchain must use a compatible exact version and platform toolset.",
    );
  return Object.freeze({
    vcToolsVersion: version,
    platformToolset: entry.platformToolset as "v143" | "v145",
  });
}

export type E2eBuildSourceBinding = Pick<
  InvestigationSourceBinding,
  "subjectRef" | "revisionKey" | "sourceSha" | "patchDigest" | "artifactRef"
>;

export interface E2eBuildInvocation {
  /** Verified build driver identity (MSBuild/dotnet), not an observed cl.exe version. */
  readonly compilerExecutable: string;
  readonly compilerSha256: string | null;
  readonly tool: E2eBuildRequest["tool"];
  readonly projectPath: string;
  readonly projectDigest: string;
  readonly headSha: string;
  readonly sourceBinding?: E2eBuildSourceBinding;
  readonly configuration: E2eBuildRequest["configuration"];
  readonly platform: E2eBuildRequest["platform"] | null;
  readonly command: readonly string[];
  /** Explicit requested MSBuild global properties; remote inventory verifies installed CL/STL. */
  readonly msbuildToolchain?: E2eMsbuildToolchain;
}

export interface E2eBuildCapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
  readonly captureLimitBytes: number;
  readonly retainedBytes: number;
}

const capturedBuildOutput = new WeakMap<E2eBuildError, E2eBuildCapturedOutput>();
export function getE2eBuildCapturedOutput(error: E2eBuildError): E2eBuildCapturedOutput | null {
  const output = capturedBuildOutput.get(error);
  return output === undefined ? null : structuredClone(output);
}

export interface E2eBuildArtifactDiagnostics {
  readonly schemaVersion: "E2eBuildArtifactDiagnosticsV1";
  readonly phase: "manifest_capture" | "output_tree_validation" | "artifact_validation";
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly changedFields: readonly string[];
  readonly expected: Readonly<Record<string, string | null>> | null;
  readonly actual: Readonly<Record<string, string | null>> | null;
  readonly actualSha256Status: "captured" | "unavailable" | "size_limit" | "not_file";
  readonly sha256LimitBytes: number;
}

// Filesystem details belong in a private artifact, not the model's diagnostic preview.
const artifactDiagnostics = new WeakMap<E2eBuildError, E2eBuildArtifactDiagnostics>();
export function getE2eBuildArtifactDiagnostics(
  error: E2eBuildError,
): E2eBuildArtifactDiagnostics | null {
  const diagnostic = artifactDiagnostics.get(error);
  return diagnostic === undefined ? null : structuredClone(diagnostic);
}

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
  readonly sourceBinding?: E2eBuildSourceBinding;
  readonly projectPath: string;
  readonly projectDigest: string;
  readonly tool: E2eBuildRequest["tool"];
  readonly command: readonly string[];
  readonly invocation?: E2eBuildInvocation;
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
  readonly toolDigests?: Readonly<Partial<Record<E2eBuildRequest["tool"], string>>>;
  readonly msbuildToolchain?: E2eMsbuildToolchain;
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
  readonly invocation?: E2eBuildInvocation;
  readonly capture?: {
    readonly artifactRef: string;
    readonly captureLimitBytes: number;
    readonly retainedBytes: number;
    readonly outputTruncated: boolean;
  };
}

export function describeE2eBuildFailure(
  value: unknown,
  invocation?: E2eBuildInvocation,
): E2eBuildError {
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
    ...(invocation === undefined ? {} : { invocation: structuredClone(invocation) }),
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
  const error = new E2eBuildError(
    "E2E_BUILD_FAILED",
    `The controlled compiler did not complete successfully (exit ${diagnostics.exitCode ?? "unknown"}). ${detail.slice(0, 2_048)}`,
    diagnostics,
  );
  const captureLimitBytes = 1024 * 1024;
  const totalBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
  const captured =
    totalBytes <= captureLimitBytes
      ? { stdout, stderr }
      : { stdout: tail(stdout), stderr: tail(stderr) };
  capturedBuildOutput.set(
    error,
    Object.freeze({
      ...captured,
      outputTruncated:
        result.outputTruncated === true ||
        [
          "OUTPUT_TRUNCATED",
          "INVALID_UTF8_OUTPUT",
          "OUTPUT_READ_FAILED",
          "PROCESS_START_FAILED",
        ].includes(String(result.code)) ||
        totalBytes > captureLimitBytes,
      captureLimitBytes,
      retainedBytes:
        Buffer.byteLength(captured.stdout, "utf8") + Buffer.byteLength(captured.stderr, "utf8"),
    }),
  );
  return error;
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
  readonly validatedFileStats: Map<string, BigIntStats>;
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
  const toolchain =
    input.msbuildToolchain !== undefined
      ? parseE2eMsbuildToolchain(input.msbuildToolchain)
      : undefined;
  if (toolchain !== undefined) assertToolchainEnvironment(input.environment);
  let compilerSha256: string | null = null;
  const configuredDigest = input.toolDigests?.[request.tool];
  if (configuredDigest !== undefined) {
    if (!/^[a-f0-9]{64}(?![\s\S])/u.test(configuredDigest))
      throw failure("E2E_BUILD_TOOL_UNAVAILABLE", "The configured compiler digest is invalid.");
    try {
      const observed = await observeArtifact(
        executable,
        win32.basename(executable),
        0n,
        0n,
        false,
        true,
      );
      if (observed.artifact.digest !== configuredDigest)
        throw new Error("Compiler identity changed.");
      compilerSha256 = observed.artifact.digest;
    } catch {
      throw failure(
        "E2E_BUILD_TOOL_UNAVAILABLE",
        "The compiler no longer matches its deployment-pinned executable identity.",
      );
    }
  }
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
        "Repository build output must be absent before compilation; existing or tracked output cannot be adopted.",
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
    toolchain,
  );
  const invocation: E2eBuildInvocation = Object.freeze({
    compilerExecutable: executable,
    compilerSha256,
    tool: request.tool,
    projectPath: request.projectPath,
    projectDigest: source.projectDigest,
    headSha: source.headSha,
    sourceBinding: source.sourceBinding,
    configuration: request.configuration,
    platform: request.platform ?? null,
    command: Object.freeze([executable, ...args]),
    ...(toolchain === undefined ? {} : { msbuildToolchain: toolchain }),
  });
  const spec: ProcessLaunchSpec = {
    executable,
    arguments: args,
    workingDirectory: source.sourceDirectory,
    environmentMode: "replace",
    environment: buildEnvironment(input.environment, directory),
    limits: { ...input.limits },
  };
  assertValidProcessLaunchSpec(spec);
  await assertSourceUnchanged(input, source);
  input.signal.throwIfAborted();
  const startedAtNs = await writeClockMarker(directory, "started");
  let result: Awaited<ReturnType<E2eBuildInput["run"]>>;
  try {
    result = await input.run(spec, input.signal);
  } catch (error) {
    input.signal.throwIfAborted();
    throw describeE2eBuildFailure(error, invocation);
  }
  input.signal.throwIfAborted();
  const completedAtNs = await writeClockMarker(directory, "completed");
  await assertSourceUnchanged(input, source);
  if (result.exitCode !== 0) throw describeE2eBuildFailure(result, invocation);
  if (completedAtNs < startedAtNs)
    throw failure("E2E_BUILD_ARTIFACT_INVALID", "The build filesystem clock moved backwards.");
  await assertDirectoryIdentities(directoryIdentities);
  if (nativeOutput !== undefined) {
    await readOutputTree(nativeOutput);
    await assertSourceUnchanged(input, source);
    // Both absolute paths are resolved descendants of this attempt's verified source/control roots.
    if (!within(source.sourceDirectory, nativeOutput) || !within(buildRoot, outputDirectory))
      throw failure(
        "E2E_BUILD_ARTIFACT_INVALID",
        "The repository output seal escaped its owned workspace.",
      );
    await rename(nativeOutput, outputDirectory);
    await assertSourceUnchanged(input, source);
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
      throw await artifactChangeFailure(
        "The output tree changed while its manifest was being captured.",
        "manifest_capture",
        file.relativePath,
        "file",
        file.stat,
        observation.stat,
        file.path,
        undefined,
        observation.artifact.digest,
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
  await assertSameOutputTree(
    outputTree,
    await readOutputTree(outputDirectory),
    outputDirectory,
    manifest,
  );
  await assertDirectoryIdentities(directoryIdentities);
  input.signal.throwIfAborted();
  const fields = {
    id: input.id,
    headSha: source.headSha,
    sourceBinding: source.sourceBinding,
    projectPath: request.projectPath,
    projectDigest: source.projectDigest,
    tool: request.tool,
    command: Object.freeze([executable, ...args]),
    invocation,
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
    validatedFileStats: new Map([...manifest].map(([key, observation]) => [key, observation.stat])),
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
  // Freshness was proven at sealing; runtime timestamps may change without changing bytes.
  const observed = await observeArtifact(
    expected.artifact.path,
    expected.artifact.relativePath,
    provenance.startedAtNs,
    provenance.completedAtNs,
    false,
  );
  await assertOutputManifest(provenance);
  await assertDirectoryIdentities(provenance.directoryIdentities);
  if (
    !sameFileIdentity(expected.stat, observed.stat) ||
    expected.artifact.digest !== observed.artifact.digest ||
    expected.artifact.byteLength !== observed.artifact.byteLength
  )
    throw await artifactChangeFailure(
      "The build artifact changed after the compiler completed.",
      "artifact_validation",
      expected.artifact.relativePath,
      "file",
      expected.stat,
      observed.stat,
      expected.artifact.path,
      expected.artifact.digest,
      observed.artifact.digest,
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
      (sourceBinding.patchDigest !== null &&
        !/^[a-f0-9]{64}(?![\s\S])/u.test(sourceBinding.patchDigest)) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u.test(sourceBinding.sourceSha)
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
      sourceBinding: Object.freeze({
        subjectRef: sourceBinding.subjectRef,
        revisionKey: sourceBinding.revisionKey,
        sourceSha: sourceBinding.sourceSha,
        patchDigest: sourceBinding.patchDigest,
        artifactRef: sourceBinding.artifactRef,
      }),
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
  source: Awaited<ReturnType<typeof readPinnedProject>>,
): Promise<void> {
  const observed = await readPinnedProject(input, source.projectPath);
  if (
    !samePath(observed.sourceDirectory, source.sourceDirectory) ||
    observed.projectDigest !== source.projectDigest ||
    observed.sourceBinding.subjectRef !== source.sourceBinding.subjectRef ||
    observed.sourceBinding.revisionKey !== source.sourceBinding.revisionKey ||
    observed.sourceBinding.sourceSha !== source.sourceBinding.sourceSha ||
    observed.sourceBinding.patchDigest !== source.sourceBinding.patchDigest ||
    observed.sourceBinding.artifactRef !== source.sourceBinding.artifactRef
  )
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
    await assertSourceUnchanged(input, source);
    const checkoutDirectories = boundBuildCheckoutDirectories(input, source.sourceDirectory);
    // Capture every checkout before any cleanup can replace a later dependency's directory.
    const sourceDirectories = new Map<string, BigIntStats>();
    for (const checkoutDirectory of checkoutDirectories) {
      for (const [path, identity] of await directoryChain(win32.join(checkoutDirectory, ".git"))) {
        const original = sourceDirectories.get(path);
        if (
          original !== undefined &&
          (original.dev !== identity.dev || original.ino !== identity.ino)
        )
          throw new Error("An owned source directory changed before cleanup.");
        sourceDirectories.set(path, identity);
      }
    }
    const environment = {
      ...Object.fromEntries(
        Object.entries(input.environment)
          .map(([name, value]) => [name.toUpperCase(), value] as const)
          .filter(([name]) =>
            ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT"].includes(name),
          ),
      ),
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
    };
    for (const checkoutDirectory of checkoutDirectories) {
      // Patch additions are untracked; retain this freshly materialized root and rebuild it.
      if (
        source.sourceBinding.patchDigest !== null &&
        samePath(checkoutDirectory, source.sourceDirectory)
      )
        continue;
      const spec: ProcessLaunchSpec = {
        executable: input.gitExecutablePath,
        arguments: [
          `--git-dir=${win32.join(checkoutDirectory, ".git")}`,
          `--work-tree=${checkoutDirectory}`,
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
        workingDirectory: checkoutDirectory,
        environmentMode: "replace",
        environment: {
          ...environment,
          HOME: checkoutDirectory,
          USERPROFILE: checkoutDirectory,
          XDG_CONFIG_HOME: checkoutDirectory,
          TEMP: checkoutDirectory,
          TMP: checkoutDirectory,
        },
        limits: { ...input.limits },
      };
      assertValidProcessLaunchSpec(spec);
      await assertSourceUnchanged(input, source);
      await assertDirectoryIdentities(sourceDirectories);
      input.signal.throwIfAborted();
      const result = await input.run(spec, input.signal);
      input.signal.throwIfAborted();
      await assertDirectoryIdentities(sourceDirectories);
      await assertSourceUnchanged(input, source);
      if (result.exitCode !== 0) throw new Error("The owned source cleanup failed.");
    }
  } catch {
    input.signal.throwIfAborted();
    throw failure(
      "E2E_BUILD_SOURCE_INVALID",
      "The owned source checkout could not be safely cleaned and reverified.",
    );
  }
}

function boundBuildCheckoutDirectories(input: E2eBuildInput, sourceDirectory: string): string[] {
  const seen = new Set<string>();
  const submodules = (input.workspace.sourceBinding?.submodules ?? []).map(({ path }) => {
    if (
      typeof path !== "string" ||
      path.length > 4_096 ||
      path.includes("\\") ||
      win32.isAbsolute(path) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Bound paths must reject control bytes.
      /[\u0000-\u001f\u007f:]/u.test(path) ||
      path
        .split("/")
        .some(
          (part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git",
        )
    )
      throw new Error("A bound dependency path is unsafe.");
    const directory = win32.join(sourceDirectory, path);
    assertWindowsLocalAbsolutePath(directory, "bound dependency checkout", false);
    if (!within(sourceDirectory, directory) || samePath(sourceDirectory, directory))
      throw new Error("A bound dependency path escaped the source root.");
    const key = pathKey(directory);
    if (seen.has(key)) throw new Error("A bound dependency checkout is duplicated.");
    seen.add(key);
    return { directory, depth: path.split("/").length, path };
  });
  submodules.sort(
    (left, right) =>
      right.depth - left.depth || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  return [...submodules.map(({ directory }) => directory), sourceDirectory];
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
  toolchain?: E2eMsbuildToolchain,
): readonly string[] {
  // Forward slashes retain a trailing directory separator without Windows quote/backslash ambiguity.
  const directoryProperty = (path: string): string => `${path.replaceAll("\\", "/")}/`;
  // Keep each referenced project's intermediate layout instead of sharing obj/assets across projects.
  const properties = [
    ...(toolchain === undefined
      ? []
      : [
          `-property:VCToolsVersion=${toolchain.vcToolsVersion}`,
          `-property:PlatformToolset=${toolchain.platformToolset}`,
        ]),
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

function assertToolchainEnvironment(environment: E2eBuildInput["environment"]): void {
  const overrides = new Set([
    "VCTOOLSVERSION",
    "PLATFORMTOOLSET",
    "VCTOOLSINSTALLDIR",
    "VCTARGETSPATH",
    "CLTOOLPATH",
    "CLTOOLEXE",
    "VCINSTALLDIR",
    "CL",
    "_CL_",
  ]);
  if (Object.keys(environment).some((name) => overrides.has(name.toUpperCase())))
    throw failure(
      "E2E_BUILD_TOOL_UNAVAILABLE",
      "Explicit MSBuild toolchain selection cannot be combined with environment overrides for compiler paths, versions, or flags.",
    );
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

async function assertSameOutputTree(
  expected: OutputTree,
  actual: OutputTree,
  outputDirectory: string,
  manifest: ReadonlyMap<string, ArtifactObservation>,
  allowRuntimeMetadataChanges = false,
): Promise<void> {
  for (const [key, original] of expected.files) {
    const observed = actual.files.get(key);
    if (
      observed === undefined ||
      observed.relativePath !== original.relativePath ||
      !(allowRuntimeMetadataChanges
        ? sameFileIdentity(original.stat, observed.stat)
        : sameFile(original.stat, observed.stat))
    )
      throw await artifactChangeFailure(
        "A file in the complete build output manifest changed.",
        "output_tree_validation",
        original.relativePath,
        "file",
        original.stat,
        observed?.stat,
        observed?.path,
        manifest.get(key)?.artifact.digest,
        undefined,
        observed !== undefined && observed.relativePath !== original.relativePath
          ? ["relativePath"]
          : [],
      );
  }
  for (const [key, observed] of actual.files) {
    if (!expected.files.has(key))
      throw await artifactChangeFailure(
        "Files or directories were added to or removed from the build output.",
        "output_tree_validation",
        observed.relativePath,
        "file",
        undefined,
        observed.stat,
        observed.path,
      );
  }
  for (const [key, original] of expected.directories) {
    const observed = actual.directories.get(key);
    if (
      observed === undefined ||
      !(allowRuntimeMetadataChanges
        ? sameDirectoryIdentity(original, observed)
        : sameDirectory(original, observed))
    )
      throw await artifactChangeFailure(
        "A directory in the complete build output manifest changed.",
        "output_tree_validation",
        win32.relative(outputDirectory, key).replaceAll("\\", "/") || ".",
        "directory",
        original,
        observed,
      );
  }
  for (const [key, observed] of actual.directories) {
    if (!expected.directories.has(key))
      throw await artifactChangeFailure(
        "Files or directories were added to or removed from the build output.",
        "output_tree_validation",
        win32.relative(outputDirectory, key).replaceAll("\\", "/") || ".",
        "directory",
        undefined,
        observed,
      );
  }
}

async function assertOutputManifest(provenance: BuildProvenance): Promise<void> {
  const observed = await readOutputTree(provenance.outputDirectory);
  await assertSameOutputTree(
    provenance.outputTree,
    observed,
    provenance.outputDirectory,
    provenance.manifest,
    true,
  );
  // Keep the sealed identities and hashes. Runtime timestamp changes require a stable
  // content read before refreshing the metadata cache used by subsequent interactions.
  for (const [key, original] of provenance.manifest) {
    const file = observed.files.get(key);
    if (file === undefined || !sameFileIdentity(original.stat, file.stat))
      throw await artifactChangeFailure(
        "A hashed build dependency changed after manifest capture.",
        "output_tree_validation",
        original.artifact.relativePath,
        "file",
        original.stat,
        file?.stat,
        file?.path,
        original.artifact.digest,
      );
    const lastValidated = provenance.validatedFileStats.get(key) ?? original.stat;
    if (sameFile(lastValidated, file.stat)) continue;
    const rehashed = await observeArtifact(
      file.path,
      file.relativePath,
      provenance.startedAtNs,
      provenance.completedAtNs,
      false,
    );
    if (
      !sameFile(file.stat, rehashed.stat) ||
      original.artifact.digest !== rehashed.artifact.digest ||
      original.artifact.byteLength !== rehashed.artifact.byteLength
    )
      throw await artifactChangeFailure(
        "A hashed build dependency changed after manifest capture.",
        "output_tree_validation",
        original.artifact.relativePath,
        "file",
        original.stat,
        rehashed.stat,
        file.path,
        original.artifact.digest,
        rehashed.artifact.digest,
      );
    provenance.validatedFileStats.set(key, rehashed.stat);
  }
}

async function artifactChangeFailure(
  message: string,
  phase: E2eBuildArtifactDiagnostics["phase"],
  relativePath: string,
  kind: E2eBuildArtifactDiagnostics["kind"],
  expected: BigIntStats | undefined,
  actual: BigIntStats | undefined,
  path?: string,
  expectedSha256?: string,
  actualSha256?: string,
  extraChangedFields: readonly string[] = [],
): Promise<E2eBuildError> {
  const sha256LimitBytes = 16 * 1024 * 1024;
  let actualSha256Status: E2eBuildArtifactDiagnostics["actualSha256Status"] = "not_file";
  if (kind === "file" && actual !== undefined) {
    actualSha256Status = actualSha256 === undefined ? "unavailable" : "captured";
    if (actualSha256 === undefined && path !== undefined) {
      if (actual.size > BigInt(sha256LimitBytes)) actualSha256Status = "size_limit";
      else {
        try {
          const observed = await observeArtifact(
            path,
            relativePath,
            0n,
            0n,
            false,
            false,
            sha256LimitBytes,
          );
          if (sameFile(actual, observed.stat)) {
            actualSha256 = observed.artifact.digest;
            actualSha256Status = "captured";
          }
        } catch {
          // A failed diagnostic read must preserve the original validation failure.
        }
      }
    }
  }
  const snapshot = (
    stat: BigIntStats | undefined,
    digest: string | undefined,
  ): Readonly<Record<string, string | null>> | null =>
    stat === undefined
      ? null
      : {
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
          size: stat.size.toString(),
          nlink: stat.nlink.toString(),
          mtimeNs: stat.mtimeNs.toString(),
          ctimeNs: stat.ctimeNs.toString(),
          birthtimeNs: stat.birthtimeNs.toString(),
          sha256: digest ?? null,
        };
  const before = snapshot(expected, expectedSha256);
  const after = snapshot(actual, actualSha256);
  const changedFields =
    before === null || after === null
      ? ["presence"]
      : Object.keys(before).filter(
          (field) =>
            before[field] !== after[field] &&
            (field !== "sha256" || (before.sha256 !== null && after.sha256 !== null)),
        );
  const error = failure("E2E_BUILD_ARTIFACT_INVALID", message);
  artifactDiagnostics.set(error, {
    schemaVersion: "E2eBuildArtifactDiagnosticsV1",
    phase,
    relativePath: relativePath.slice(0, 1024),
    kind,
    changedFields: [...extraChangedFields, ...changedFields],
    expected: before,
    actual: after,
    actualSha256Status,
    sha256LimitBytes,
  });
  return error;
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
  allowTrustedBinaryHardlinks = false,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<ArtifactObservation> {
  try {
    await directoryChain(win32.dirname(path));
    const original = await lstat(path, { bigint: true });
    if (
      !original.isFile() ||
      isLink(original) ||
      !samePath(await realpath(path), path) ||
      (allowTrustedBinaryHardlinks ? original.nlink < 1n : original.nlink !== 1n) ||
      original.size < 0n ||
      original.size > BigInt(maximumBytes) ||
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
      if (!sameFile(original, await handle.stat({ bigint: true }), allowTrustedBinaryHardlinks))
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
        !sameFile(original, await handle.stat({ bigint: true }), allowTrustedBinaryHardlinks) ||
        !sameFile(original, await lstat(path, { bigint: true }), allowTrustedBinaryHardlinks)
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

function sameFile(
  left: BigIntStats,
  right: BigIntStats,
  allowTrustedBinaryHardlinks = false,
): boolean {
  return (
    right.isFile() &&
    !isLink(right) &&
    right.nlink === (allowTrustedBinaryHardlinks ? left.nlink : 1n) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    !isLink(right) &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
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

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isDirectory() &&
    !isLink(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
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
      ...(record.sourceBinding === undefined ? {} : { sourceBinding: record.sourceBinding }),
      projectPath: record.projectPath,
      projectDigest: record.projectDigest,
      tool: record.tool,
      command: record.command,
      ...(record.invocation === undefined ? {} : { invocation: record.invocation }),
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
