import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const runFile = promisify(execFile);
const dotnet = process.env.WINDOWS_OWNERSHIP_DOTNET;

function section(source: string, start: string, end: string): string {
  const offset = source.indexOf(start);
  if (offset === -1 || source.indexOf(start, offset + start.length) !== -1)
    throw new Error(`Expected exactly one production section starting with ${start}.`);
  const limit = source.indexOf(end, offset + start.length);
  if (limit === -1) throw new Error(`Missing production section boundary ${end}.`);
  return source.slice(offset, limit);
}

// These tests compile the exact production methods with synthetic OS dependencies. They
// expose no fake process tree through the production request protocol and never start UI,
// child process fixtures, listeners, or repository integrations. Set the SDK path explicitly
// in an authorized verification environment; the ordinary Worker suite has no SDK dependency.
describe.skipIf(dotnet === undefined)("Windows process ownership convergence", () => {
  it("preserves complete required ancestry while excluding transient siblings", async () => {
    const sdk = dotnet;
    if (sdk === undefined) throw new Error("The ownership harness requires an explicit SDK path.");
    const executable: string = sdk;
    const source = await readFile(new URL("./windows-driver-entry.ps1", import.meta.url), "utf8");
    const template = await readFile(
      new URL("./testdata/windows-ownership-harness.cs", import.meta.url),
      "utf8",
    );
    const failure = source.match(
      /^ {4}public static Failure OwnershipFailure\(\) \{[^\r\n]+\}/m,
    )?.[0];
    if (failure === undefined) throw new Error("Missing production ownership failure factory.");
    const production = [
      failure,
      section(source, "    void RefreshOwnership() {", "    static object ProbeSession("),
      section(source, "    static object ProbeTcp(", "    void OwnedWindow("),
      section(source, "    void OwnedWindow(", "    IntPtr FindWindow("),
    ].join("\n");
    const marker = "    // __PRODUCTION_OWNERSHIP_METHODS__";
    expect(template.split(marker)).toHaveLength(2);
    const target = process.env.WINDOWS_OWNERSHIP_TARGET_FRAMEWORK ?? "net10.0";
    if (!/^net(?:[8-9]|[1-9]\d)\.0$/.test(target))
      throw new Error("Unsupported harness target framework.");
    const directory = await mkdtemp(join(tmpdir(), "windows-ownership-algorithm-"));
    let succeeded = false;
    try {
      await writeFile(join(directory, "Program.cs"), template.replace(marker, production));
      await writeFile(
        join(directory, "OwnershipHarness.csproj"),
        `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>${target}</TargetFramework><ImplicitUsings>disable</ImplicitUsings><Nullable>disable</Nullable><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup></Project>\n`,
      );
      await writeFile(
        join(directory, "NuGet.Config"),
        "<configuration><packageSources><clear /></packageSources></configuration>\n",
      );
      const environment = {
        ...process.env,
        DOTNET_CLI_HOME: join(directory, "dotnet-home"),
        DOTNET_CLI_TELEMETRY_OPTOUT: "1",
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
        DOTNET_NOLOGO: "1",
        DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER: "1",
        NUGET_PACKAGES: join(directory, "packages"),
      };
      const options = {
        cwd: directory,
        env: environment,
        encoding: "utf8" as const,
        timeout: 90_000,
        maxBuffer: 4_194_304,
      };
      async function execute(stage: "build" | "run", arguments_: string[]) {
        let stdout = "";
        let stderr = "";
        let failure: unknown;
        try {
          const output = await runFile(executable, arguments_, options);
          stdout = output.stdout;
          stderr = output.stderr;
        } catch (error) {
          failure = error;
          const output = error as { stdout?: string; stderr?: string };
          stdout = output.stdout ?? "";
          stderr = output.stderr ?? "";
        }
        await writeFile(join(directory, `${stage}.stdout.txt`), stdout, { flag: "wx" });
        await writeFile(join(directory, `${stage}.stderr.txt`), stderr, { flag: "wx" });
        if (
          stage === "run" &&
          process.env.WINDOWS_OWNERSHIP_REPORT_PATH !== undefined &&
          stdout !== ""
        )
          await writeFile(process.env.WINDOWS_OWNERSHIP_REPORT_PATH, stdout, { flag: "wx" });
        if (failure !== undefined)
          throw new Error(`Ownership harness ${stage} failed. ${stdout}\n${stderr}`, {
            cause: failure,
          });
        return { stdout, stderr };
      }
      await execute("build", [
        "build",
        "OwnershipHarness.csproj",
        "--configuration",
        "Release",
        "--output",
        "out",
        "--nologo",
        "--verbosity",
        "quiet",
        "--disable-build-servers",
      ]);
      const execution = await execute("run", [join(directory, "out", "OwnershipHarness.dll")]);
      const report = JSON.parse(execution.stdout) as {
        cases: { name: string; passed: boolean; error: string | null }[];
      };
      expect(report.cases).toHaveLength(22);
      expect(new Set(report.cases.map((entry) => entry.name)).size).toBe(report.cases.length);
      for (const entry of report.cases)
        expect(entry.passed, `${entry.name}: ${entry.error}`).toBe(true);
      succeeded = true;
    } catch (error) {
      throw new Error(
        `Ownership harness failed; generated source and raw output remain at ${directory}.`,
        {
          cause: error,
        },
      );
    } finally {
      if (succeeded) await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
