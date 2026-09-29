import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductionManagedProcessRunner } from "../execution/managed-process-runner.js";
import type {
  ProcessExitedEvent,
  ProcessHostClient,
  ProcessLaunchSpec,
  ProcessResourceLimits,
} from "../execution/process-host-protocol.js";
import {
  describeE2eBuildFailure,
  E2eBuildError,
  type E2eBuildRecord,
  type E2eBuildRequest,
  getE2eBuildArtifactDiagnostics,
  getE2eBuildCapturedOutput,
  parseE2eMsbuildToolchain,
  performE2eBuild,
  resolveE2eSolutionTarget,
  validateE2eBuildArtifact,
  validateE2eBuildFile,
} from "./e2e-build.js";

type BuildInput = Parameters<typeof performE2eBuild>[0];
type BoundSubmodule = NonNullable<
  NonNullable<BuildInput["workspace"]["sourceBinding"]>["submodules"]
>[number];

const headSha = "a".repeat(40);
const projectContent =
  '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>';
const artifactContent = Buffer.from("Synthetic build output.\n");
const applicationFiles = {
  "App.exe": artifactContent,
  "Child.exe": Buffer.from("Synthetic child executable.\n"),
  "App.dll": Buffer.from("Original application library.\n"),
  "App.deps.json": Buffer.from('{"runtimeTarget":{"name":"net10.0"}}'),
  "App.runtimeconfig.json": Buffer.from('{"runtimeOptions":{"tfm":"net10.0"}}'),
  "App.exe.config": Buffer.from("<configuration />"),
  "assets/theme.json": Buffer.from('{"theme":"original"}'),
  "assets/icons/app.svg": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'),
};
const tools = {
  msbuild: "C:\\TrustedTools\\MSBuild.exe",
  dotnet: "C:\\TrustedTools\\dotnet.exe",
};
const gitExecutablePath = "C:\\TrustedTools\\git.exe";
const unavailableToolConfigurations: BuildInput["tools"][] = [
  {},
  { msbuild: "msbuild.exe" },
  { msbuild: "C:\\TrustedTools\\cmd.exe" },
  { msbuild: "\\\\server\\share\\msbuild.exe" },
];
const environment = { SystemRoot: "C:\\Windows", PATH: "C:\\TrustedTools" };
const limits: ProcessResourceLimits = {
  hardTimeoutMs: 30_000,
  maximumProcessCount: 4,
  maximumMemoryBytes: 512 * 1_024 * 1_024,
  maximumOutputBytes: 1_048_576,
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function digest(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function request(overrides: Partial<E2eBuildRequest> = {}): E2eBuildRequest {
  return {
    tool: "msbuild",
    projectPath: "src/App/App.csproj",
    configuration: "Release",
    platform: "x64",
    outputs: ["App.exe"],
    ...overrides,
  };
}

function sourceBinding() {
  return {
    subjectRef: "subject-pr",
    revisionKey: `pr:${headSha}`,
    sourceSha: headSha,
    patchDigest: null as string | null,
    artifactRef: null,
    submodules: [] as BoundSubmodule[],
  };
}

function submodule(path: string, parent?: BoundSubmodule): BoundSubmodule {
  return {
    path,
    repository: "example/dependency",
    commitSha: createHash("sha1").update(path).digest("hex"),
    parentPath: parent?.path ?? null,
    parentCommitSha: parent?.commitSha ?? headSha,
  };
}

function rejectedRequestInput(value: unknown): BuildInput {
  return {
    id: "build-1",
    request: value as E2eBuildRequest,
    workspace: {
      sourceDirectory: "C:\\Attempts\\source",
      sourceBinding: sourceBinding(),
      assertSourceBinding: vi.fn(async () => undefined),
      readSourceFile: vi.fn(async () => {
        throw new Error("Rejected build requests must not read source files.");
      }),
      resolveSourcePath: vi.fn(async () => {
        throw new Error("Rejected build requests must not resolve source files.");
      }),
    },
    buildRootDirectory: "C:\\Attempts\\builds",
    gitExecutablePath,
    tools,
    environment,
    limits,
    signal: new AbortController().signal,
    run: vi.fn(async () => {
      throw new Error("Rejected build requests must not execute a process.");
    }),
  };
}

function outputDirectory(spec: ProcessLaunchSpec): string {
  const outputIndex = spec.arguments.indexOf("--output");
  if (outputIndex !== -1) {
    const output = spec.arguments[outputIndex + 1];
    if (output === undefined) throw new Error("The build launch is missing its output directory.");
    return win32.normalize(output);
  }
  const prefix = "-property:OutDir=";
  const output = spec.arguments.find((argument) => argument.startsWith(prefix));
  if (output === undefined) throw new Error("The build launch is missing its output property.");
  return win32.normalize(output.slice(prefix.length));
}

async function writeOutputs(
  spec: ProcessLaunchSpec,
  outputs: readonly string[],
  content: Uint8Array = artifactContent,
): Promise<void> {
  for (const relativePath of outputs) {
    const path = win32.join(outputDirectory(spec), relativePath);
    await mkdir(win32.dirname(path), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
  }
}

async function fixture(overrides: Partial<E2eBuildRequest> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agentic-e2e-build-"));
  temporaryRoots.push(root);
  const sourceDirectory = win32.join(root, "source");
  const buildRootDirectory = win32.join(root, "builds");
  const buildRequest = request(overrides);
  const projectPath = win32.join(sourceDirectory, buildRequest.projectPath);
  await mkdir(win32.dirname(projectPath), { recursive: true });
  await mkdir(win32.join(sourceDirectory, ".git"));
  await mkdir(buildRootDirectory);
  await writeFile(projectPath, projectContent, { flag: "wx" });
  const binding = sourceBinding();
  const assertSourceBinding = vi.fn(async () => undefined);
  const readSourceFile = vi.fn<BuildInput["workspace"]["readSourceFile"]>(async (path) => {
    const content = await readFile(win32.join(sourceDirectory, path), "utf8");
    return { path, content, digest: digest(content) };
  });
  const workspace: BuildInput["workspace"] = {
    sourceDirectory,
    sourceBinding: binding,
    assertSourceBinding,
    readSourceFile,
    resolveSourcePath: vi.fn(async (path: string) => win32.join(sourceDirectory, path)),
  };
  const run = vi.fn<BuildInput["run"]>(async (spec) => {
    await writeOutputs(spec, buildRequest.outputs);
    return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
  });
  const cleanupRun = vi.fn<BuildInput["run"]>(async () => ({
    exitCode: 0,
    stdout: "Source cleanup completed.",
    stderr: "",
  }));
  const allProcessCalls = vi.fn<BuildInput["run"]>(async (spec, signal) => {
    if (spec.executable === gitExecutablePath) return cleanupRun(spec, signal);
    return run(spec, signal);
  });
  const input: BuildInput = {
    id: "build-1",
    request: buildRequest,
    workspace,
    buildRootDirectory,
    gitExecutablePath,
    tools,
    environment,
    limits,
    signal: new AbortController().signal,
    run: allProcessCalls,
  };
  return {
    input,
    root,
    sourceDirectory,
    buildRootDirectory,
    projectPath,
    binding,
    assertSourceBinding,
    readSourceFile,
    run,
    cleanupRun,
    allProcessCalls,
  };
}

async function addSubmodules(
  f: Awaited<ReturnType<typeof fixture>>,
  submodules: readonly BoundSubmodule[],
): Promise<void> {
  f.binding.submodules.push(...submodules);
  for (const { path } of submodules)
    await mkdir(win32.join(f.sourceDirectory, path, ".git"), { recursive: true });
}

async function writeApplicationOutputs(spec: ProcessLaunchSpec): Promise<void> {
  for (const [relativePath, content] of Object.entries(applicationFiles)) {
    await writeOutputs(spec, [relativePath], content);
  }
  await mkdir(win32.join(outputDirectory(spec), "plugins"));
}

async function applicationFixture() {
  const f = await fixture({ tool: "dotnet", outputs: ["App.exe"] });
  f.run.mockImplementation(async (spec) => {
    await writeApplicationOutputs(spec);
    return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
  });
  return f;
}

describe("E2E build request boundaries", () => {
  it.each([
    { vcToolsVersion: "14.50.35717", platformToolset: "v145" },
    { vcToolsVersion: "14.44.35207", platformToolset: "v143" },
  ])("accepts only a compatible exact deployment toolchain: %j", (value) => {
    expect(parseE2eMsbuildToolchain(value)).toEqual(value);
    expect(Object.isFrozen(parseE2eMsbuildToolchain(value))).toBe(true);
  });

  it.each([
    null,
    { vcToolsVersion: "14.50.35717" },
    { vcToolsVersion: "14.50.35717", platformToolset: "v143" },
    { vcToolsVersion: "14.44.35207", platformToolset: "v145" },
    { vcToolsVersion: "14.50.35717\n", platformToolset: "v145" },
    { vcToolsVersion: "14.50.35717;Unsafe=true", platformToolset: "v145" },
    { vcToolsVersion: "14.50.35717", platformToolset: "v145", arguments: ["-target:Unsafe"] },
  ])("rejects malformed or inconsistent deployment toolchain selection: %j", (value) => {
    expect(() => parseE2eMsbuildToolchain(value)).toThrow();
  });

  it("retains bounded full build output separately from the short diagnostic preview", () => {
    const stdout = `${"compiler details\n".repeat(6000)}error C2653: missing namespace\n`;
    const error = describeE2eBuildFailure({ exitCode: 1, stdout, stderr: "" });
    const captured = getE2eBuildCapturedOutput(error)!;
    expect(captured).toEqual({
      stdout,
      stderr: "",
      outputTruncated: false,
      captureLimitBytes: 1024 * 1024,
      retainedBytes: Buffer.byteLength(stdout),
    });
    expect(error.diagnostics?.outputTruncated).toBe(true);
    expect(Buffer.byteLength(error.diagnostics!.stdout)).toBeLessThanOrEqual(16_384);
    const modified = { ...captured, stdout: "changed copy" };
    expect(modified.stdout).not.toBe(getE2eBuildCapturedOutput(error)!.stdout);
  });

  it("does not label an upstream-truncated build transcript as complete", () => {
    const error = describeE2eBuildFailure({
      exitCode: 1,
      stdout: "tail",
      stderr: "",
      outputTruncated: true,
    });
    expect(getE2eBuildCapturedOutput(error)).toMatchObject({
      outputTruncated: true,
      stdout: "tail",
    });
  });

  it.each(["error", "fatal"])(
    "prioritizes an explicit %s over an earlier compiler warning",
    (severity) => {
      const stdout = [
        "warning CS1668: Invalid search path specified in LIB environment variable.",
        `${severity}: vcpkg requires APPDATA or LOCALAPPDATA to locate its cache.`,
        "error MSB3073: The vcpkg command exited with code 1.",
      ].join("\n");
      const error = describeE2eBuildFailure({
        exitCode: 1,
        stdout,
        stderr: "",
        outputTruncated: true,
      });
      expect(error.message).toContain("vcpkg requires APPDATA or LOCALAPPDATA");
      expect(error.message).not.toContain("CS1668");
      expect(error.diagnostics).toEqual({ exitCode: 1, stdout, stderr: "", outputTruncated: true });
    },
  );
  it("falls back to a non-warning compiler code when no explicit error severity was emitted", () => {
    const error = describeE2eBuildFailure({
      exitCode: 1,
      stdout:
        "warning CS1668: Invalid search path.\nMSB3073: The command exited with code 1.\nBuild finished.",
      stderr: "",
    });
    expect(error.message).toContain("MSB3073");
    expect(error.message).not.toContain("CS1668");
  });
  it("uses the last available line when a failed process emitted only warnings", () => {
    const stdout =
      "warning CS1668: Invalid search path.\nwarning NU1904: The package has a vulnerability.";
    const error = describeE2eBuildFailure({ exitCode: 1, stdout, stderr: "" });
    expect(error.message).toContain("warning NU1904");
    expect(error.message).not.toContain("CS1668");
    expect(error.diagnostics).toEqual({ exitCode: 1, stdout, stderr: "", outputTruncated: false });
  });
  it("preserves the actual final MSBuild error through managed capture and build diagnostics", async () => {
    const errorLine = "error MSB4019: The imported C++ targets are unavailable.\n";
    const exit: ProcessExitedEvent = {
      protocolVersion: "1.0",
      type: "exited",
      requestId: "compiler",
      exitCode: 1,
      signal: null,
      outputTruncated: false,
    };
    const host: ProcessHostClient = {
      start: async () => ({
        requestId: exit.requestId,
        processId: 123,
        stdout: Readable.from(["Restored package.\n".repeat(7000), errorLine]),
        stderr: Readable.from([]),
        completed: Promise.resolve(exit),
        terminate: async () => {},
      }),
      terminateAll: async () => {},
      close: async () => {},
    };
    const failure = await new ProductionManagedProcessRunner({
      maximumErrorPreviewBytes: 16 * 1024,
    })
      .run(
        {
          executable: tools.msbuild,
          arguments: [],
          workingDirectory: "C:\\Attempt",
          environmentMode: "replace",
          environment,
          limits: { ...limits, maximumOutputBytes: 1024 * 1024 },
        },
        { processHost: host, signal: new AbortController().signal },
      )
      .catch((error: unknown) => error);
    const buildError = describeE2eBuildFailure(failure);
    expect(buildError.message).toContain("MSB4019");
    expect(buildError.diagnostics).toMatchObject({ exitCode: 1, outputTruncated: true });
    expect(buildError.diagnostics?.stdout.endsWith(errorLine)).toBe(true);
    expect(Buffer.byteLength(buildError.diagnostics!.stdout)).toBeLessThanOrEqual(16_384);
  });
  it("keeps bounded build diagnostic tails on UTF-8 character boundaries", () => {
    const errorLine = "\nerror MSB3644: 缺少引用程序集。🙂\n";
    const error = describeE2eBuildFailure({
      exitCode: 1,
      stdout: "中🙂".repeat(5000) + errorLine,
      stderr: "",
      outputTruncated: true,
    });
    expect(error.diagnostics?.stdout.endsWith(errorLine)).toBe(true);
    expect(error.diagnostics?.stdout.isWellFormed()).toBe(true);
    expect(error.diagnostics?.stdout).not.toContain("\uFFFD");
    expect(Buffer.byteLength(error.diagnostics!.stdout)).toBeLessThanOrEqual(16_384);
    expect(error.diagnostics?.outputTruncated).toBe(true);
  });
  it("resolves the solution folder target from its pinned SLNX project entry", () => {
    const xml =
      '<Solution><Folder Name="/modules/launcher/"><Project Path="src/PowerLauncher.csproj"><BuildDependency Project="src/Plugins/UnitConverter.csproj" /></Project></Folder></Solution>';
    expect(resolveE2eSolutionTarget(xml, "src/PowerLauncher.csproj")).toBe(
      "modules\\launcher\\PowerLauncher",
    );
    expect(() => resolveE2eSolutionTarget(xml, "src/Unlisted.csproj")).toThrow(/unambiguous/u);
    expect(() => resolveE2eSolutionTarget(xml, "../other.csproj")).toThrow();
    expect(() =>
      resolveE2eSolutionTarget("<!DOCTYPE Solution><Solution/>", "src/PowerLauncher.csproj"),
    ).toThrow(/declarations/u);
  });
  it("retains concrete compiler failures with bounded stdout and stderr", () => {
    const error = describeE2eBuildFailure({
      exitCode: 1,
      stdout: "a".repeat(50_000) + "\nerror MSB3644: Reference assemblies are missing.",
      stderr: "error NU1301: Package feed unavailable.",
    });
    expect(error.message).toContain("NU1301");
    expect(error.diagnostics?.stdout).toContain("MSB3644");
    expect(error.diagnostics?.stdout.length).toBeLessThanOrEqual(16_384);
    expect(error.diagnostics?.outputTruncated).toBe(true);
  });
  it.each(["../outside", ".git/output", "C:/outside"])(
    "rejects unsafe native output %s",
    async (repositoryOutputDirectory) => {
      await expect(
        performE2eBuild(rejectedRequestInput(request({ repositoryOutputDirectory }))),
      ).rejects.toMatchObject({ code: "E2E_BUILD_REQUEST_INVALID" });
    },
  );
  it("does not read source or run the compiler when cancelled before the build", async () => {
    const input = rejectedRequestInput(request());
    const controller = new AbortController();
    const reason = new Error("The build was cancelled before starting.");
    controller.abort(reason);
    await expect(performE2eBuild({ ...input, signal: controller.signal })).rejects.toBe(reason);
    expect(input.run).not.toHaveBeenCalled();
    expect(input.workspace.readSourceFile).not.toHaveBeenCalled();
  });

  it.each([
    { tool: "powershell" },
    { arguments: ["-target:CustomTarget"] },
    { args: ["-property:OutDir=C:/old/"] },
    { command: "msbuild App.csproj" },
    { executable: "C:\\Untrusted\\msbuild.exe" },
    { environment: { MSBuildExtensionsPath: "C:\\Untrusted" } },
    { msbuildToolchain: { vcToolsVersion: "14.50.35717", platformToolset: "v145" } },
    { vcToolsVersion: "14.50.35717" },
    { platformToolset: "v145" },
    { configuration: "Release;CustomProperty=true" },
    { platform: "x64;CustomProperty=true" },
    { outputs: [] },
    { outputs: ["App.exe", "App.exe"] },
    { outputs: ["App.exe", "app.EXE"] },
  ])("rejects an unsupported request field or value: %j", async (overrides) => {
    const input = rejectedRequestInput({ ...request(), ...overrides });
    await expect(performE2eBuild(input)).rejects.toMatchObject({
      code: "E2E_BUILD_REQUEST_INVALID",
    });
    expect(input.run).not.toHaveBeenCalled();
    expect(input.workspace.readSourceFile).not.toHaveBeenCalled();
  });

  it.each([
    "../App.csproj",
    "src/../App.csproj",
    "C:\\Source\\App.csproj",
    "/App.csproj",
    "-target:Custom.csproj",
    "src/App.csproj:stream",
    'src/"App".csproj',
    "src/%TEMP%/App.csproj",
    "src/App;Custom.csproj",
    "src/App\n.csproj",
    "src/build.ps1",
  ])("rejects a project path that can escape or alter the build: %s", async (projectPath) => {
    const input = rejectedRequestInput(request({ projectPath }));
    await expect(performE2eBuild(input)).rejects.toMatchObject({
      code: "E2E_BUILD_REQUEST_INVALID",
    });
    expect(input.run).not.toHaveBeenCalled();
  });

  it.each([
    "../App.exe",
    "bin/../../App.exe",
    "C:\\Old\\App.exe",
    "/App.exe",
    "-App.exe",
    "bin/App.exe:stream",
    'bin/"App".exe',
    "bin/%TEMP%/App.exe",
    "bin/App;Other.exe",
    "bin/App\r.exe",
    "App.ps1",
  ])("rejects an output outside the supported artifact paths: %s", async (output) => {
    const input = rejectedRequestInput(request({ outputs: [output] }));
    await expect(performE2eBuild(input)).rejects.toMatchObject({
      code: "E2E_BUILD_REQUEST_INVALID",
    });
    expect(input.run).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("E2E build provenance", () => {
  it.each(["msbuild", "dotnet"] as const)(
    "pins MSVC with explicit trusted global properties through %s and seals that configuration",
    async (tool) => {
      const f = await fixture({ tool });
      const toolchain = { vcToolsVersion: "14.50.35717", platformToolset: "v145" as const };
      const result = await performE2eBuild({ ...f.input, msbuildToolchain: toolchain });
      const spec = f.run.mock.calls[0]![0];
      expect(spec.arguments).toContain("-property:VCToolsVersion=14.50.35717");
      expect(spec.arguments).toContain("-property:PlatformToolset=v145");
      expect(result.invocation).toMatchObject({
        compilerExecutable: tools[tool],
        compilerSha256: null,
        headSha,
        projectPath: f.input.request.projectPath,
        configuration: "Release",
        platform: "x64",
        msbuildToolchain: toolchain,
      });
      expect(result.invocation?.command).toEqual(result.command);
      expect(Object.isFrozen(result.invocation)).toBe(true);
    },
  );

  it("preserves automatic toolset selection when no trusted pin is configured", async () => {
    const f = await fixture();
    const result = await performE2eBuild(f.input);
    expect(
      f.run.mock.calls[0]![0].arguments.some((arg) => /VCToolsVersion|PlatformToolset/u.test(arg)),
    ).toBe(false);
    expect(result.invocation?.msbuildToolchain).toBeUndefined();
  });

  it.each([
    "VCToolsVersion",
    "platformtoolset",
    "VCToolsInstallDir",
    "VCTargetsPath",
    "CLToolPath",
    "CLToolExe",
    "VCInstallDir",
    "CL",
    "_CL_",
  ])(
    "rejects environment %s overriding an explicit deployment pin before any process",
    async (name) => {
      const f = await fixture();
      await expect(
        performE2eBuild({
          ...f.input,
          msbuildToolchain: { vcToolsVersion: "14.50.35717", platformToolset: "v145" },
          environment: { ...environment, [name]: "untrusted override" },
        }),
      ).rejects.toMatchObject({ code: "E2E_BUILD_TOOL_UNAVAILABLE" });
      expect(f.allProcessCalls).not.toHaveBeenCalled();
      expect(f.readSourceFile).not.toHaveBeenCalled();
    },
  );

  it("records the actual verified compiler executable digest with the pinned invocation", async () => {
    const f = await fixture();
    const executable = win32.join(f.root, "MSBuild.exe");
    await writeFile(executable, "Synthetic pinned compiler bytes");
    const expected = digest("Synthetic pinned compiler bytes");
    const result = await performE2eBuild({
      ...f.input,
      tools: { msbuild: executable },
      toolDigests: { msbuild: expected },
    });
    expect(result.invocation?.compilerSha256).toBe(expected);
    expect(result.invocation?.compilerExecutable).toBe(executable);
  });

  it("rejects a compiler digest mismatch before source preparation or process execution", async () => {
    const f = await fixture();
    const executable = win32.join(f.root, "MSBuild.exe");
    await writeFile(executable, "Changed compiler bytes");
    await expect(
      performE2eBuild({
        ...f.input,
        tools: { msbuild: executable },
        toolDigests: { msbuild: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "E2E_BUILD_TOOL_UNAVAILABLE" });
    expect(f.allProcessCalls).not.toHaveBeenCalled();
    expect(f.readSourceFile).not.toHaveBeenCalled();
  });

  it("preserves deployment compatibility for a hardlinked compiler with a matching verified digest", async () => {
    const f = await fixture();
    const original = win32.join(f.root, "compiler-original.exe");
    const executable = win32.join(f.root, "MSBuild.exe");
    const content = "Synthetic shared deployment compiler bytes";
    await writeFile(original, content);
    await link(original, executable);
    const result = await performE2eBuild({
      ...f.input,
      tools: { msbuild: executable },
      toolDigests: { msbuild: digest(content) },
    });
    expect(result.invocation?.compilerSha256).toBe(digest(content));
    expect(await readFile(original, "utf8")).toBe(content);
  });

  it("retains the source and compiler invocation when the pinned compiler fails", async () => {
    const f = await fixture();
    f.run.mockResolvedValue({ exitCode: 1, stdout: "error C2653: missing namespace", stderr: "" });
    const error = await performE2eBuild({
      ...f.input,
      msbuildToolchain: { vcToolsVersion: "14.50.35717", platformToolset: "v145" },
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "E2E_BUILD_FAILED",
      diagnostics: {
        invocation: {
          compilerExecutable: tools.msbuild,
          headSha,
          projectDigest: digest(projectContent),
          configuration: "Release",
          msbuildToolchain: { vcToolsVersion: "14.50.35717", platformToolset: "v145" },
        },
      },
    });
  });

  it("builds a verified CRLF checkout project using its observed-byte digest", async () => {
    const f = await fixture();
    const checkout = '<Project Sdk="Microsoft.NET.Sdk">\r\n  <PropertyGroup />\r\n</Project>\r\n';
    await writeFile(f.projectPath, checkout);
    const record = await performE2eBuild(f.input);
    expect(record.projectDigest).toBe(digest(checkout));
    expect(record.projectDigest).not.toBe(digest(checkout.replaceAll("\r\n", "\n")));
  });
  it("retains the actionable source verification cause when a project cannot be read", async () => {
    const f = await fixture();
    f.readSourceFile.mockRejectedValueOnce(
      Object.assign(
        new Error("The source file bytes do not match the pinned checkout representation."),
        { code: "SOURCE_BINDING_MISMATCH" },
      ),
    );
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
      message: expect.stringContaining("SOURCE_BINDING_MISMATCH"),
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("preserves native plugin layout and builds the selected solution graph in one invocation", async () => {
    const f = await fixture({
      projectPath: "Suite.slnx",
      solutionProject: "src/PowerLauncher.csproj",
      repositoryOutputDirectory: "x64/Debug",
      outputs: ["App.exe", "RunPlugins/UnitConverter/Plugin.dll"],
    });
    await writeFile(
      f.projectPath,
      '<Solution><Folder Name="/modules/launcher/"><Project Path="src/PowerLauncher.csproj" /></Folder></Solution>',
    );
    await mkdir(win32.join(f.sourceDirectory, "src"));
    await writeFile(win32.join(f.sourceDirectory, "src", "PowerLauncher.csproj"), projectContent);
    const nativeOutput = win32.join(f.sourceDirectory, "x64", "Debug");
    f.run.mockImplementation(async (spec) => {
      expect(spec.arguments).toContain("-target:modules\\launcher\\PowerLauncher:Rebuild");
      expect(spec.arguments).toContain("-property:RestorePackagesConfig=true");
      expect(spec.arguments.some((arg) => arg.startsWith("-property:OutDir="))).toBe(false);
      await mkdir(win32.join(nativeOutput, "RunPlugins", "UnitConverter"), { recursive: true });
      await writeFile(win32.join(nativeOutput, "App.exe"), artifactContent);
      await writeFile(
        win32.join(nativeOutput, "RunPlugins", "UnitConverter", "Plugin.dll"),
        artifactContent,
      );
      await writeFile(
        win32.join(nativeOutput, "RunPlugins", "UnitConverter", "plugin.json"),
        '{"Name":"UnitConverter"}',
      );
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    const built = await performE2eBuild(f.input);
    expect(built.artifacts.map((artifact) => artifact.relativePath)).toEqual([
      "App.exe",
      "RunPlugins/UnitConverter/Plugin.dll",
    ]);
    expect(
      built.artifacts.every((artifact) => artifact.path.startsWith(f.buildRootDirectory)),
    ).toBe(true);
    await expect(lstat(nativeOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      validateE2eBuildFile(built, "RunPlugins/UnitConverter/plugin.json"),
    ).resolves.toMatchObject({ relativePath: "RunPlugins/UnitConverter/plugin.json" });
  });
  it("refuses an existing repository output directory instead of sealing an old package", async () => {
    const f = await fixture({ repositoryOutputDirectory: "x64/Debug" });
    await mkdir(win32.join(f.sourceDirectory, "x64", "Debug"), { recursive: true });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("keeps managed compiler exception diagnostics available to the agent", async () => {
    const f = await fixture();
    f.run.mockRejectedValue(
      Object.assign(new Error("Managed process exited with code 1."), {
        exitCode: 1,
        stdout: "error MSB4019: Missing C++ build targets.",
        stderr: "",
      }),
    );
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_FAILED",
      diagnostics: { exitCode: 1, stdout: "error MSB4019: Missing C++ build targets." },
    });
  });
  it("cleans the bound checkout with fixed Git arguments before launching the compiler", async () => {
    const f = await fixture();
    await performE2eBuild(f.input);
    expect(f.allProcessCalls.mock.calls.map(([spec]) => spec.executable)).toEqual([
      gitExecutablePath,
      tools.msbuild,
    ]);
    const [spec, signal] = f.cleanupRun.mock.calls[0]!;
    expect(spec).toMatchObject({
      executable: gitExecutablePath,
      workingDirectory: f.sourceDirectory,
      environmentMode: "replace",
      limits,
    });
    expect(signal).toBe(f.input.signal);
    expect(spec.arguments).toEqual([
      `--git-dir=${win32.join(f.sourceDirectory, ".git")}`,
      `--work-tree=${f.sourceDirectory}`,
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
    ]);
    expect(spec.environment).toMatchObject({
      SYSTEMROOT: environment.SystemRoot,
      PATH: environment.PATH,
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_CONFIG_SYSTEM: "NUL",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      HOME: f.sourceDirectory,
      TEMP: f.sourceDirectory,
      TMP: f.sourceDirectory,
    });
  });

  it("cleans pinned dependencies deepest first with exact roots and source checks around every cleanup", async () => {
    const f = await fixture();
    const parent = submodule("vendor/library");
    const nested = submodule("vendor/library/deps/nested", parent);
    const sibling = submodule("vendor/other");
    await addSubmodules(f, [sibling, parent, nested]);
    const expectedDirectories = [nested.path, parent.path, sibling.path].map((path) =>
      win32.join(f.sourceDirectory, path),
    );
    expectedDirectories.push(f.sourceDirectory);
    const events: string[] = [];
    f.assertSourceBinding.mockImplementation(async () => {
      events.push("verify");
    });
    for (const directory of expectedDirectories)
      await writeFile(win32.join(directory, "Directory.Build.targets"), "Injected build input.");
    f.cleanupRun.mockImplementation(async (spec) => {
      events.push(`clean:${spec.workingDirectory}`);
      await rm(win32.join(spec.workingDirectory, "Directory.Build.targets"));
      return { exitCode: 0, stdout: "Removed untracked build inputs.", stderr: "" };
    });
    f.run.mockImplementation(async (spec) => {
      for (const directory of expectedDirectories)
        await expect(
          readFile(win32.join(directory, "Directory.Build.targets")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      expect(await readFile(f.projectPath, "utf8")).toBe(projectContent);
      await writeOutputs(spec, f.input.request.outputs);
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await performE2eBuild(f.input);
    expect(f.cleanupRun.mock.calls.map(([spec]) => spec.workingDirectory)).toEqual(
      expectedDirectories,
    );
    for (const [index, directory] of expectedDirectories.entries()) {
      const [spec, signal] = f.cleanupRun.mock.calls[index]!;
      expect(spec.arguments.slice(0, 2)).toEqual([
        `--git-dir=${win32.join(directory, ".git")}`,
        `--work-tree=${directory}`,
      ]);
      expect(spec.arguments.slice(-4)).toEqual(["clean", "-ffdqx", "--", "."]);
      expect(spec.arguments).toContain("submodule.recurse=false");
      expect(spec.environment).toMatchObject({
        HOME: directory,
        USERPROFILE: directory,
        XDG_CONFIG_HOME: directory,
        TEMP: directory,
        TMP: directory,
        GIT_CONFIG_GLOBAL: "NUL",
      });
      expect(signal).toBe(f.input.signal);
      const eventIndex = events.indexOf(`clean:${directory}`);
      expect(events.slice(eventIndex - 1, eventIndex + 2)).toEqual([
        "verify",
        `clean:${directory}`,
        "verify",
      ]);
    }
    expect(f.allProcessCalls.mock.calls.map(([spec]) => spec.executable)).toEqual([
      ...expectedDirectories.map(() => gitExecutablePath),
      tools.msbuild,
    ]);
  });

  it("accepts ordinary bound dependency paths that are not build request paths", async () => {
    const f = await fixture();
    const dependency = submodule("@vendor/-library%name,;");
    await addSubmodules(f, [dependency]);
    await performE2eBuild(f.input);
    expect(f.cleanupRun.mock.calls.map(([spec]) => spec.workingDirectory)).toEqual([
      win32.join(f.sourceDirectory, dependency.path),
      f.sourceDirectory,
    ]);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each([
    "",
    "../outside",
    "vendor\\library",
    "/outside",
    "C:/outside",
    "vendor/../outside",
    "vendor/.git/hooks",
    "vendor//library",
    "vendor/NUL",
    "vendor/library.",
    "vendor/library ",
  ])("rejects unsafe bound dependency paths before any cleanup: %s", async (path) => {
    const f = await fixture();
    f.binding.submodules.push(submodule(path));
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.allProcessCalls).not.toHaveBeenCalled();
  });

  it("rejects ambiguous bound dependency roots before any cleanup", async () => {
    const f = await fixture();
    await addSubmodules(f, [submodule("vendor/library"), submodule("VENDOR/LIBRARY")]);
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.allProcessCalls).not.toHaveBeenCalled();
  });

  it.each(["missing", "gitfile", "junction"] as const)(
    "rejects a dependency with %s Git metadata before any cleanup",
    async (kind) => {
      const f = await fixture();
      const dependency = submodule("vendor/library");
      f.binding.submodules.push(dependency);
      const directory = win32.join(f.sourceDirectory, dependency.path);
      const gitDirectory = win32.join(directory, ".git");
      await mkdir(directory, { recursive: true });
      if (kind === "gitfile") await writeFile(gitDirectory, "gitdir: C:/Outside/control\n");
      else if (kind === "junction")
        await symlink(win32.join(f.sourceDirectory, ".git"), gitDirectory, "junction");
      await expect(performE2eBuild(f.input)).rejects.toMatchObject({
        code: "E2E_BUILD_SOURCE_INVALID",
      });
      expect(f.allProcessCalls).not.toHaveBeenCalled();
    },
  );

  it.each(["checkout", "Git metadata"] as const)(
    "rejects replacement of a later dependency's %s during cleanup",
    async (target) => {
      const f = await fixture();
      const first = submodule("vendor/first");
      const later = submodule("vendor/later");
      await addSubmodules(f, [later, first]);
      const laterDirectory = win32.join(f.sourceDirectory, later.path);
      const laterGitDirectory = win32.join(laterDirectory, ".git");
      f.cleanupRun.mockImplementationOnce(async () => {
        await rename(
          target === "checkout" ? laterDirectory : laterGitDirectory,
          win32.join(f.root, "retired-dependency"),
        );
        await mkdir(laterGitDirectory, { recursive: true });
        return { exitCode: 0, stdout: "Source cleanup completed.", stderr: "" };
      });
      await expect(performE2eBuild(f.input)).rejects.toMatchObject({
        code: "E2E_BUILD_SOURCE_INVALID",
      });
      expect(f.cleanupRun.mock.calls.map(([spec]) => spec.workingDirectory)).toEqual([
        win32.join(f.sourceDirectory, first.path),
      ]);
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each(["failed", "binding drift", "cancelled"] as const)(
    "stops before root cleanup and compilation when dependency cleanup is %s",
    async (outcome) => {
      const f = await fixture();
      const dependency = submodule("vendor/library");
      await addSubmodules(f, [dependency]);
      const controller = new AbortController();
      let drifted = false;
      f.assertSourceBinding.mockImplementation(async () => {
        if (drifted) throw new Error("The pinned dependency binding changed.");
      });
      f.cleanupRun.mockImplementation(async () => {
        if (outcome === "binding drift") drifted = true;
        else if (outcome === "cancelled")
          controller.abort(new Error("Dependency cleanup cancelled."));
        return { exitCode: outcome === "failed" ? 1 : 0, stdout: "", stderr: "" };
      });
      const build = performE2eBuild({ ...f.input, signal: controller.signal });
      if (outcome === "cancelled")
        await expect(build).rejects.toThrow("Dependency cleanup cancelled.");
      else await expect(build).rejects.toMatchObject({ code: "E2E_BUILD_SOURCE_INVALID" });
      expect(f.cleanupRun.mock.calls.map(([spec]) => spec.workingDirectory)).toEqual([
        win32.join(f.sourceDirectory, dependency.path),
      ]);
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("removes injected build inputs before the compiler can observe them", async () => {
    const f = await fixture();
    const injectedTargets = win32.join(f.sourceDirectory, "Directory.Build.targets");
    const injectedSource = win32.join(win32.dirname(f.projectPath), "Injected.cs");
    await writeFile(injectedTargets, '<Project><Target Name="Injected" /></Project>');
    await writeFile(injectedSource, "class Injected {}\n");
    f.cleanupRun.mockImplementation(async () => {
      await rm(injectedTargets);
      await rm(injectedSource);
      return { exitCode: 0, stdout: "Removed untracked build inputs.", stderr: "" };
    });
    f.run.mockImplementation(async (spec) => {
      await expect(readFile(injectedTargets)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(injectedSource)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.projectPath, "utf8")).toBe(projectContent);
      await writeOutputs(spec, f.input.request.outputs);
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await performE2eBuild(f.input);
    expect(f.cleanupRun).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.allProcessCalls.mock.calls.map(([spec]) => spec.executable)).toEqual([
      gitExecutablePath,
      tools.msbuild,
    ]);
  });

  it.each([1, null])(
    "does not compile after an unsuccessful cleanup exit: %s",
    async (exitCode) => {
      const f = await fixture();
      f.cleanupRun.mockResolvedValue({ exitCode, stdout: "", stderr: "Source cleanup failed." });
      await expect(performE2eBuild(f.input)).rejects.toMatchObject({
        code: "E2E_BUILD_SOURCE_INVALID",
      });
      expect(f.cleanupRun).toHaveBeenCalledOnce();
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("does not compile after the cleanup process throws", async () => {
    const f = await fixture();
    f.cleanupRun.mockRejectedValueOnce(new Error("The cleanup process could not start."));
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rechecks the source revision after cleanup before invoking the compiler", async () => {
    const f = await fixture();
    f.cleanupRun.mockImplementation(async () => {
      f.binding.sourceSha = "b".repeat(40);
      return { exitCode: 0, stdout: "Source cleanup completed.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.cleanupRun).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("constructs a fixed MSBuild invocation and seals exact-head artifact evidence", async () => {
    const f = await fixture();
    const record = await performE2eBuild(f.input);
    const [spec, signal] = f.run.mock.calls[0]!;
    const outputProperty = spec.arguments.find((value) => value.startsWith("-property:OutDir="))!;
    expect(spec).toMatchObject({
      executable: tools.msbuild,
      workingDirectory: f.sourceDirectory,
      environmentMode: "replace",
      environment,
      limits,
    });
    expect(signal).toBe(f.input.signal);
    expect(spec.arguments).toEqual([
      f.projectPath,
      "-restore",
      "-property:RestorePackagesConfig=true",
      "-target:Rebuild",
      "-property:Configuration=Release",
      outputProperty,
      "-property:Platform=x64",
      "-property:UseSharedCompilation=false",
      "-noAutoResponse",
      "-nodeReuse:false",
      "-maxCpuCount:1",
      "-property:CL_MPCount=1",
      "-verbosity:minimal",
      "-consoleLoggerParameters:Summary;DisableConsoleColor",
    ]);
    expect(outputProperty).toMatch(/\/$/);
    expect(outputProperty).not.toContain("\\");
    expect(
      spec.arguments.filter((argument) =>
        /^-property:(?:IntDir|BaseIntermediateOutputPath|MSBuildProjectExtensionsPath)=/u.test(
          argument,
        ),
      ),
    ).toEqual([]);
    expect(record).toMatchObject({
      id: f.input.id,
      headSha,
      projectPath: f.input.request.projectPath,
      projectDigest: digest(projectContent),
      tool: "msbuild",
      command: [tools.msbuild, ...spec.arguments],
      artifacts: [
        {
          relativePath: "App.exe",
          path: win32.join(outputDirectory(spec), "App.exe"),
          digest: digest(artifactContent),
          byteLength: artifactContent.byteLength,
        },
      ],
    });
    expect(record.identity).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.command)).toBe(true);
    expect(Object.isFrozen(record.artifacts)).toBe(true);
    expect(Object.isFrozen(record.artifacts[0])).toBe(true);
    await expect(validateE2eBuildArtifact(record, "App.exe")).resolves.toBe(record.artifacts[0]);
    await expect(validateE2eBuildArtifact(record, record.artifacts[0]!.path)).resolves.toBe(
      record.artifacts[0],
    );
  });

  it("supports DLL artifacts through a fixed dotnet build invocation", async () => {
    const f = await fixture({ tool: "dotnet", configuration: "Debug", outputs: ["App.dll"] });
    const record = await performE2eBuild(f.input);
    const spec = f.run.mock.calls[0]![0];
    expect(spec.executable).toBe(tools.dotnet);
    expect(spec.arguments.slice(0, 6)).toEqual([
      "build",
      f.projectPath,
      "--configuration",
      "Debug",
      "--no-incremental",
      "--output",
    ]);
    expect(spec.arguments).toContain("-noAutoResponse");
    expect(spec.arguments).toContain("-property:Platform=x64");
    expect(spec.arguments).toContain("-property:UseSharedCompilation=false");
    expect(spec.arguments).toContain("-property:CL_MPCount=1");
    expect(spec.arguments).toContain("-consoleLoggerParameters:Summary;DisableConsoleColor");
    expect(
      spec.arguments.filter((argument) =>
        /^-property:(?:IntDir|BaseIntermediateOutputPath|MSBuildProjectExtensionsPath)=/u.test(
          argument,
        ),
      ),
    ).toEqual([]);
    expect(record.artifacts[0]?.relativePath).toBe("App.dll");
    await expect(validateE2eBuildArtifact(record, "App.dll")).resolves.toBe(record.artifacts[0]);
  });

  it.each(unavailableToolConfigurations)(
    "rejects unavailable or incorrectly pinned build tools: %j",
    async (configuredTools) => {
      const f = await fixture();
      await expect(performE2eBuild({ ...f.input, tools: configuredTools })).rejects.toMatchObject({
        code: "E2E_BUILD_TOOL_UNAVAILABLE",
      });
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each(["sourceDirectory", "sourceBinding"] as const)(
    "requires a bound source checkout when %s is absent",
    async (field) => {
      const f = await fixture();
      await expect(
        performE2eBuild({ ...f.input, workspace: { ...f.input.workspace, [field]: null } }),
      ).rejects.toMatchObject({ code: "E2E_BUILD_SOURCE_INVALID" });
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("rejects an untracked project even when the project file exists", async () => {
    const f = await fixture();
    f.readSourceFile.mockResolvedValueOnce({
      path: f.input.request.projectPath,
      content: null,
      digest: null,
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects a project that disappeared from the source checkout", async () => {
    const f = await fixture();
    await rm(f.projectPath);
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects a project resolved outside the bound source tree", async () => {
    const f = await fixture();
    await expect(
      performE2eBuild({
        ...f.input,
        workspace: {
          ...f.input.workspace,
          resolveSourcePath: async () => win32.join(f.root, "another-project.csproj"),
        },
      }),
    ).rejects.toMatchObject({ code: "E2E_BUILD_SOURCE_INVALID" });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects a project digest that does not describe its source text", async () => {
    const f = await fixture();
    f.readSourceFile.mockResolvedValueOnce({
      path: f.input.request.projectPath,
      content: projectContent,
      digest: "0".repeat(64),
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects a patched checkout instead of attributing it to the PR head", async () => {
    const f = await fixture();
    f.binding.patchDigest = "b".repeat(64);
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects source drift before starting a build", async () => {
    const f = await fixture();
    f.assertSourceBinding.mockRejectedValueOnce(new Error("Observed HEAD changed."));
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects source drift observed after a successful build", async () => {
    const f = await fixture();
    let drifted = false;
    f.assertSourceBinding.mockImplementation(async () => {
      if (drifted) throw new Error("Observed HEAD changed during the build.");
    });
    f.run.mockImplementation(async (spec) => {
      await writeOutputs(spec, f.input.request.outputs);
      drifted = true;
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
    expect(f.run).toHaveBeenCalledOnce();
  });

  it("rejects a changed source SHA even if the source verifier does not throw", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (spec) => {
      await writeOutputs(spec, f.input.request.outputs);
      f.binding.sourceSha = "b".repeat(40);
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
  });

  it("rejects a project changed during the build even when the binding object is unchanged", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (spec) => {
      await writeOutputs(spec, f.input.request.outputs);
      await writeFile(f.projectPath, `${projectContent}\n<!-- Changed during build. -->`);
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_SOURCE_INVALID",
    });
  });

  it.each([1, null])("rejects an unsuccessful build exit code: %s", async (exitCode) => {
    const f = await fixture();
    f.run.mockImplementation(async (spec) => {
      await writeOutputs(spec, f.input.request.outputs);
      return { exitCode, stdout: "", stderr: "Build did not complete successfully." };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({ code: "E2E_BUILD_FAILED" });
  });

  it("does not accept an exit-zero build without every declared artifact", async () => {
    const f = await fixture({ outputs: ["App.exe", "App.dll"] });
    f.run.mockImplementation(async (spec) => {
      await writeOutputs(spec, ["App.exe"]);
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("does not substitute an old source-tree binary for a missing fresh output", async () => {
    const f = await fixture();
    const oldOutput = win32.join(f.sourceDirectory, "bin", "App.exe");
    await mkdir(win32.dirname(oldOutput));
    await writeFile(oldOutput, artifactContent);
    f.run.mockResolvedValue({ exitCode: 0, stdout: "Build succeeded.", stderr: "" });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("isolates output directories for consecutive builds of the same project", async () => {
    const f = await fixture();
    const first = await performE2eBuild(f.input);
    const second = await performE2eBuild({ ...f.input, id: "build-2" });
    const directories = f.run.mock.calls.map(([spec]) => outputDirectory(spec));
    expect(directories[0]).not.toBe(directories[1]);
    for (const directory of directories) {
      expect(win32.relative(f.buildRootDirectory, directory)).not.toMatch(/^\.\./);
      expect(win32.relative(f.sourceDirectory, directory)).toMatch(/^\.\./);
    }
    expect(first.artifacts[0]?.path).not.toBe(second.artifacts[0]?.path);
    await expect(validateE2eBuildArtifact(first, first.artifacts[0]!.path)).resolves.toBe(
      first.artifacts[0],
    );
    await expect(validateE2eBuildArtifact(second, second.artifacts[0]!.path)).resolves.toBe(
      second.artifacts[0],
    );
  });

  it("rejects a build root inside the source checkout", async () => {
    const f = await fixture();
    await expect(
      performE2eBuild({
        ...f.input,
        buildRootDirectory: win32.join(f.sourceDirectory, "builds"),
      }),
    ).rejects.toMatchObject({ code: "E2E_BUILD_REQUEST_INVALID" });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects output files whose timestamps predate the build", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (spec) => {
      await writeOutputs(spec, f.input.request.outputs);
      const oldTime = new Date("2000-01-01T00:00:00.000Z");
      await utimes(win32.join(outputDirectory(spec), "App.exe"), oldTime, oldTime);
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects a directory in place of an output binary", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (spec) => {
      await mkdir(win32.join(outputDirectory(spec), "App.exe"));
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects a hard-linked output even if its content and timestamp are fresh", async () => {
    const f = await fixture();
    f.run.mockImplementation(async (spec) => {
      const original = win32.join(f.root, "shared-output.exe");
      await writeFile(original, artifactContent);
      await link(original, win32.join(outputDirectory(spec), "App.exe"));
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects an output reached through a directory junction", async () => {
    const f = await fixture({ outputs: ["nested/App.exe"] });
    f.run.mockImplementation(async (spec) => {
      const outsideDirectory = win32.join(f.root, "redirected-output");
      await mkdir(outsideDirectory);
      await writeFile(win32.join(outsideDirectory, "App.exe"), artifactContent);
      await symlink(outsideDirectory, win32.join(outputDirectory(spec), "nested"), "junction");
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects copied or deserialized manifests without the trusted in-memory record", async () => {
    const f = await fixture();
    const record = await performE2eBuild(f.input);
    const copies = [{ ...record }, JSON.parse(JSON.stringify(record)) as E2eBuildRecord];
    for (const copy of copies) {
      await expect(validateE2eBuildArtifact(copy, "App.exe")).rejects.toMatchObject({
        code: "E2E_BUILD_RECORD_INVALID",
      });
    }
  });

  it("rejects a path that is not one of the sealed build artifacts", async () => {
    const f = await fixture();
    const record = await performE2eBuild(f.input);
    const unrecordedPath = win32.join(win32.dirname(record.artifacts[0]!.path), "Other.exe");
    await writeFile(unrecordedPath, artifactContent);
    await expect(validateE2eBuildArtifact(record, unrecordedPath)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects artifact bytes modified before launch", async () => {
    const f = await fixture();
    const record = await performE2eBuild(f.input);
    await writeFile(record.artifacts[0]!.path, Buffer.from("Modified build output.\n"));
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects replacing an artifact with a different file containing identical bytes", async () => {
    const f = await fixture();
    const record = await performE2eBuild(f.input);
    const path = record.artifacts[0]!.path;
    await rename(path, win32.join(f.root, "displaced-original.exe"));
    await writeFile(path, artifactContent, { flag: "wx" });
    await expect(validateE2eBuildArtifact(record, path)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rechecks link counts before launch", async () => {
    const f = await fixture();
    const record = await performE2eBuild(f.input);
    await link(record.artifacts[0]!.path, win32.join(f.root, "added-link.exe"));
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });
});

describe.skipIf(process.platform !== "win32")("E2E build output tree integrity", () => {
  it("retains the first changed dependency's metadata and hashes separately from the error preview", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const path = win32.join(win32.dirname(record.artifacts[0]!.path), "App.dll");
    const content = Buffer.from("Modified dependency content.");
    await writeFile(path, content);
    const error = await validateE2eBuildArtifact(record, "App.exe").catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(E2eBuildError);
    const diagnostic = getE2eBuildArtifactDiagnostics(error as E2eBuildError)!;
    expect(diagnostic).toMatchObject({
      schemaVersion: "E2eBuildArtifactDiagnosticsV1",
      phase: "output_tree_validation",
      relativePath: "App.dll",
      kind: "file",
      changedFields: expect.arrayContaining(["size", "sha256"]),
      expected: {
        size: String(applicationFiles["App.dll"].byteLength),
        sha256: digest(applicationFiles["App.dll"]),
      },
      actual: { size: String(content.byteLength), sha256: digest(content) },
      actualSha256Status: "captured",
    });
    expect(JSON.stringify(error)).not.toContain("App.dll");
    expect(JSON.stringify(diagnostic)).not.toContain(f.root);
    expect((error as E2eBuildError).diagnostics).toBeUndefined();
    expect(diagnostic).not.toBe(getE2eBuildArtifactDiagnostics(error as E2eBuildError));
  });

  it("identifies a same-byte replacement without reporting a content change", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const path = win32.join(win32.dirname(record.artifacts[0]!.path), "App.dll");
    await rename(path, win32.join(f.root, "original-library.dll"));
    await writeFile(path, applicationFiles["App.dll"], { flag: "wx" });
    const error = await validateE2eBuildArtifact(record, "App.exe").catch(
      (value: unknown) => value,
    );
    const diagnostic = getE2eBuildArtifactDiagnostics(error as E2eBuildError)!;
    expect(diagnostic.changedFields).toContain("ino");
    expect(diagnostic.changedFields).not.toContain("sha256");
    expect(diagnostic.actual?.sha256).toBe(diagnostic.expected?.sha256);
  });

  it("records a removed dependency without attempting to hash a missing file", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    await rm(win32.join(win32.dirname(record.artifacts[0]!.path), "App.deps.json"));
    const error = await validateE2eBuildArtifact(record, "App.exe").catch(
      (value: unknown) => value,
    );
    expect(getE2eBuildArtifactDiagnostics(error as E2eBuildError)).toMatchObject({
      relativePath: "App.deps.json",
      changedFields: ["presence"],
      expected: { sha256: digest(applicationFiles["App.deps.json"]) },
      actual: null,
      actualSha256Status: "not_file",
    });
  });

  it("bounds diagnostic hashing when a changed dependency exceeds the capture limit", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const path = win32.join(win32.dirname(record.artifacts[0]!.path), "App.dll");
    await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1));
    const error = await validateE2eBuildArtifact(record, "App.exe").catch(
      (value: unknown) => value,
    );
    expect(getE2eBuildArtifactDiagnostics(error as E2eBuildError)).toMatchObject({
      relativePath: "App.dll",
      actual: { sha256: null },
      actualSha256Status: "size_limit",
      sha256LimitBytes: 16 * 1024 * 1024,
    });
  });

  it("seals every output file while only issuing the requested executable for launch", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    expect(record.manifestFileCount).toBe(Object.keys(applicationFiles).length);
    expect(record.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.artifacts.map((artifact) => artifact.relativePath)).toEqual(["App.exe"]);
    await expect(validateE2eBuildArtifact(record, "App.exe")).resolves.toBe(record.artifacts[0]);
    await expect(validateE2eBuildArtifact(record, "App.dll")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("recognizes a child executable in the manifest without making it a requested entry point", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const childPath = win32.join(win32.dirname(record.artifacts[0]!.path), "Child.exe");
    await expect(validateE2eBuildArtifact(record, "Child.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
    await expect(validateE2eBuildFile(record, childPath)).resolves.toMatchObject({
      relativePath: "Child.exe",
      path: childPath,
      digest: digest(applicationFiles["Child.exe"]),
      byteLength: applicationFiles["Child.exe"].byteLength,
    });
  });

  it("rejects an outside executable or a copied record when identifying a child process file", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const oldExecutable = win32.join(f.root, "old-child.exe");
    await writeFile(oldExecutable, applicationFiles["Child.exe"]);
    await expect(validateE2eBuildFile(record, oldExecutable)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
    const copied = JSON.parse(JSON.stringify(record)) as E2eBuildRecord;
    const childPath = win32.join(win32.dirname(record.artifacts[0]!.path), "Child.exe");
    await expect(validateE2eBuildFile(copied, childPath)).rejects.toMatchObject({
      code: "E2E_BUILD_RECORD_INVALID",
    });
  });

  it("accepts an unchanged copied dependency whose modification time predates the build", async () => {
    const f = await applicationFixture();
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    f.run.mockImplementation(async (spec) => {
      await writeApplicationOutputs(spec);
      await utimes(win32.join(outputDirectory(spec), "App.dll"), oldTime, oldTime);
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    const record = await performE2eBuild(f.input);
    expect(record.manifestFileCount).toBe(Object.keys(applicationFiles).length);
    await expect(validateE2eBuildArtifact(record, "App.exe")).resolves.toBe(record.artifacts[0]);
  });

  it.each(["App.exe", "App.dll"] as const)(
    "accepts post-seal timestamp changes without changing file identity or content: %s",
    async (relativePath) => {
      const f = await applicationFixture();
      const record = await performE2eBuild(f.input);
      const path = win32.join(win32.dirname(record.artifacts[0]!.path), relativePath);
      const before = await lstat(path, { bigint: true });
      const oldTime = new Date("2000-01-01T00:00:00.000Z");
      await utimes(path, oldTime, oldTime);
      const after = await lstat(path, { bigint: true });
      expect(after).toMatchObject({
        dev: before.dev,
        ino: before.ino,
        birthtimeNs: before.birthtimeNs,
        size: before.size,
      });
      expect(after.mtimeNs).not.toBe(before.mtimeNs);
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
      await expect(validateE2eBuildFile(record, path)).resolves.toMatchObject({
        relativePath,
        digest: digest(applicationFiles[relativePath]),
      });
      await expect(validateE2eBuildArtifact(record, "App.exe")).resolves.toBe(record.artifacts[0]);
    },
  );

  it("accepts a dependency change-time update with unchanged modification time and bytes", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const path = win32.join(win32.dirname(record.artifacts[0]!.path), "App.dll");
    const before = await lstat(path, { bigint: true });
    try {
      await chmod(path, 0o444);
    } finally {
      await chmod(path, Number(before.mode & 0o777n));
    }
    const after = await lstat(path, { bigint: true });
    expect(after).toMatchObject({
      dev: before.dev,
      ino: before.ino,
      birthtimeNs: before.birthtimeNs,
      size: before.size,
      mtimeNs: before.mtimeNs,
    });
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    await expect(validateE2eBuildArtifact(record, "App.exe")).resolves.toBe(record.artifacts[0]);
  });

  it.each([".", "assets", "plugins"])(
    "accepts post-seal directory timestamp changes with an unchanged output tree: %s",
    async (relativePath) => {
      const f = await applicationFixture();
      const record = await performE2eBuild(f.input);
      const path = win32.join(win32.dirname(record.artifacts[0]!.path), relativePath);
      const before = await lstat(path, { bigint: true });
      const oldTime = new Date("2000-01-01T00:00:00.000Z");
      await utimes(path, oldTime, oldTime);
      const after = await lstat(path, { bigint: true });
      expect(after).toMatchObject({
        dev: before.dev,
        ino: before.ino,
        birthtimeNs: before.birthtimeNs,
      });
      expect(after.mtimeNs).not.toBe(before.mtimeNs);
      await expect(validateE2eBuildArtifact(record, "App.exe")).resolves.toBe(record.artifacts[0]);
    },
  );

  it.each(["App.exe", "App.dll"] as const)(
    "rejects changed bytes after accepting and caching a timestamp-only update: %s",
    async (relativePath) => {
      const f = await applicationFixture();
      const record = await performE2eBuild(f.input);
      const path = win32.join(win32.dirname(record.artifacts[0]!.path), relativePath);
      const oldTime = new Date("2000-01-01T00:00:00.000Z");
      await utimes(path, oldTime, oldTime);
      await expect(validateE2eBuildArtifact(record, "App.exe")).resolves.toBe(record.artifacts[0]);
      const before = await lstat(path, { bigint: true });
      await writeFile(path, Buffer.alloc(applicationFiles[relativePath].byteLength, 0x58));
      await utimes(path, oldTime, oldTime);
      const after = await lstat(path, { bigint: true });
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
      await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
        code: "E2E_BUILD_ARTIFACT_INVALID",
      });
    },
  );

  it.each([
    "App.dll",
    "App.runtimeconfig.json",
    "App.exe.config",
    "assets/theme.json",
    "assets/icons/app.svg",
  ])("rejects launching an unchanged executable after its dependency changes: %s", async (path) => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const output = win32.dirname(record.artifacts[0]!.path);
    await writeFile(win32.join(output, path), "Modified dependency content.");
    expect(await readFile(record.artifacts[0]!.path)).toEqual(artifactContent);
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects a new plugin DLL added after the output tree was sealed", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const output = win32.dirname(record.artifacts[0]!.path);
    await writeFile(win32.join(output, "plugins", "NewPlugin.dll"), "New plugin content.");
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects a new empty directory added after the output tree was sealed", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    await mkdir(win32.join(win32.dirname(record.artifacts[0]!.path), "new-plugins"));
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects removal of the dependency manifest before launching the executable", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const output = win32.dirname(record.artifacts[0]!.path);
    await rm(win32.join(output, "App.deps.json"));
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects an unrequested hard-linked dependency during the build", async () => {
    const f = await fixture({ tool: "dotnet", outputs: ["App.exe"] });
    f.run.mockImplementation(async (spec) => {
      await writeOutputs(spec, ["App.exe"]);
      const outsideDependency = win32.join(f.root, "shared-library.dll");
      await writeFile(outsideDependency, applicationFiles["App.dll"]);
      await link(outsideDependency, win32.join(outputDirectory(spec), "App.dll"));
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects an unrequested asset directory junction during the build", async () => {
    const f = await fixture({ tool: "dotnet", outputs: ["App.exe"] });
    f.run.mockImplementation(async (spec) => {
      await writeOutputs(spec, ["App.exe"]);
      const outsideDirectory = win32.join(f.root, "redirected-assets");
      await mkdir(outsideDirectory);
      await writeFile(
        win32.join(outsideDirectory, "theme.json"),
        applicationFiles["assets/theme.json"],
      );
      await symlink(outsideDirectory, win32.join(outputDirectory(spec), "assets"), "junction");
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    await expect(performE2eBuild(f.input)).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rechecks the link count of an unrequested dependency before launch", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const output = win32.dirname(record.artifacts[0]!.path);
    await link(win32.join(output, "App.dll"), win32.join(f.root, "added-library-link.dll"));
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects replacement of an empty output directory", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const plugins = win32.join(win32.dirname(record.artifacts[0]!.path), "plugins");
    await rename(plugins, win32.join(f.root, "original-plugins"));
    await mkdir(plugins);
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects a same-byte replacement of an unrequested dependency", async () => {
    const f = await applicationFixture();
    const record = await performE2eBuild(f.input);
    const path = win32.join(win32.dirname(record.artifacts[0]!.path), "App.dll");
    await rename(path, win32.join(f.root, "original-library.dll"));
    await writeFile(path, applicationFiles["App.dll"], { flag: "wx" });
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });

  it("rejects changed dependency bytes when size and modification time are restored", async () => {
    const f = await applicationFixture();
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    f.run.mockImplementation(async (spec) => {
      await writeApplicationOutputs(spec);
      await utimes(win32.join(outputDirectory(spec), "App.dll"), oldTime, oldTime);
      return { exitCode: 0, stdout: "Build succeeded.", stderr: "" };
    });
    const record = await performE2eBuild(f.input);
    const path = win32.join(win32.dirname(record.artifacts[0]!.path), "App.dll");
    const before = await lstat(path, { bigint: true });
    await writeFile(path, Buffer.alloc(applicationFiles["App.dll"].byteLength, 0x58));
    await utimes(path, oldTime, oldTime);
    const after = await lstat(path, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    await expect(validateE2eBuildArtifact(record, "App.exe")).rejects.toMatchObject({
      code: "E2E_BUILD_ARTIFACT_INVALID",
    });
  });
});
