import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createValidationWorkspaceResolvers,
  loadValidationRuntimeConfig,
  prepareValidationRuntime,
  type ValidationRuntimeConfig,
  type ValidationRuntimeFileHandle,
  type ValidationRuntimeFileStat,
  type ValidationRuntimeFileSystem,
  type ValidationRuntimeTrustedDefaults,
} from "./validation-runtime-config.js";

const checkout = "C:\\WorkerData\\Workspaces\\attempt-1\\checkout";
const secretPath = "C:\\ProtectedSecrets\\test-token.txt";
const browserPath = "C:\\Program Files\\Browser\\browser.exe";
const desktopPath = "C:\\ProgramData\\AgenticReviewDesktopLocks";
const customPath = "C:\\TrustedTools\\dotnet.exe";
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const signal = (): AbortSignal => new AbortController().signal;

function defaults(
  overrides: Partial<ValidationRuntimeTrustedDefaults> = {},
): ValidationRuntimeTrustedDefaults {
  return {
    executionEnabled: true,
    maxSlots: 1,
    bundleDirectory: "C:\\WorkerBundle\\dist",
    executables: [
      { name: "git", path: "C:\\TrustedTools\\git.exe" },
      { name: "node", path: "C:\\TrustedTools\\node.exe" },
      {
        name: "powershell",
        path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      },
      { name: "cmd", path: "C:\\Windows\\System32\\cmd.exe" },
    ],
    untrustedDirectories: ["C:\\WorkerData\\Workspaces", "C:\\WorkerData\\Temp"],
    ...overrides,
  };
}

class FakeEntry {
  public canonical: string;
  public content: Buffer;
  public mode: bigint;
  public nlink = 1n;
  public dev = 1n;
  public mtimeNs = 1_000n;
  public ctimeNs = 1_000n;
  public symbolicLink = false;
  public reparsePoint = false;
  public sizeOverride: bigint | undefined;

  public constructor(
    readonly path: string,
    readonly kind: "file" | "directory",
    readonly ino: bigint,
    contents: Buffer = Buffer.from("MZ fixture"),
  ) {
    this.canonical = path;
    this.content = contents;
    this.mode = kind === "file" ? 0o100600n : 0o40700n;
  }

  public snapshot(): ValidationRuntimeFileStat {
    const kind = this.kind;
    const symbolicLink = this.symbolicLink;
    const reparsePoint = this.reparsePoint;
    return {
      dev: this.dev,
      ino: this.ino,
      size: this.sizeOverride ?? BigInt(this.kind === "file" ? this.content.length : 0),
      mode: this.mode,
      nlink: this.nlink,
      mtimeNs: this.mtimeNs,
      ctimeNs: this.ctimeNs,
      isDirectory: () => kind === "directory",
      isFile: () => kind === "file",
      isSymbolicLink: () => symbolicLink,
      isReparsePoint: () => reparsePoint,
    };
  }
}

class FakeFileSystem implements ValidationRuntimeFileSystem {
  readonly #entries = new Map<string, FakeEntry>();
  #nextIdentity = 1n;
  public readonly opened: string[] = [];
  public closeCount = 0;
  public readCount = 0;
  public maximumReadLength = 0;
  public onOpen: ((entry: FakeEntry) => void) | undefined;
  public onRead: ((entry: FakeEntry) => void) | undefined;
  public onClose: (() => void) | undefined;
  public readOverride:
    | ((entry: FakeEntry, buffer: Uint8Array, length: number, position: number) => number)
    | undefined;

  public directory(path: string): FakeEntry {
    const existing = this.#entries.get(path.toLowerCase());
    if (existing !== undefined) return existing;
    const parent = win32.dirname(path);
    if (parent !== path) this.directory(parent);
    const entry = new FakeEntry(path, "directory", this.#nextIdentity++);
    this.#entries.set(path.toLowerCase(), entry);
    return entry;
  }

  public file(path: string, content?: Buffer): FakeEntry {
    this.directory(win32.dirname(path));
    const entry = new FakeEntry(path, "file", this.#nextIdentity++, content);
    this.#entries.set(path.toLowerCase(), entry);
    return entry;
  }

  public entry(path: string): FakeEntry {
    const entry = this.#entries.get(path.toLowerCase());
    if (entry === undefined)
      throw new Error("Synthetic filesystem failure with SECRET-DO-NOT-EXPOSE.");
    return entry;
  }

  public remove(path: string): void {
    this.#entries.delete(path.toLowerCase());
  }

  public async lstat(path: string): Promise<ValidationRuntimeFileStat> {
    return this.entry(path).snapshot();
  }

  public async realpath(path: string): Promise<string> {
    return this.entry(path).canonical;
  }

  public async open(path: string): Promise<ValidationRuntimeFileHandle> {
    this.opened.push(path);
    const entry = this.entry(path);
    this.onOpen?.(entry);
    return {
      stat: async () => entry.snapshot(),
      read: async (buffer, offset, length, position) => {
        this.readCount += 1;
        this.maximumReadLength = Math.max(this.maximumReadLength, length);
        this.onRead?.(entry);
        if (this.readOverride !== undefined)
          return { bytesRead: this.readOverride(entry, buffer, length, position) };
        const count = Math.max(0, Math.min(length, entry.content.length - position));
        buffer.set(entry.content.subarray(position, position + count), offset);
        return { bytesRead: count };
      },
      close: async () => {
        this.closeCount += 1;
        this.onClose?.();
      },
    };
  }
}

function fixture(
  environment: NodeJS.ProcessEnv = {},
  trustedDefaults = defaults(),
): {
  config: ValidationRuntimeConfig;
  fs: FakeFileSystem;
} {
  const config = loadValidationRuntimeConfig(environment, trustedDefaults);
  const fs = new FakeFileSystem();
  fs.directory(checkout);
  for (const registration of config.executables) fs.file(registration.path);
  if (config.web !== undefined) {
    fs.file(config.web.browserExecutablePath);
    fs.file(config.web.driverEntryPath);
    fs.file(config.web.windowsProbeEntryPath);
    for (const name of [
      "package.json",
      "index.mjs",
      "index.js",
      "lib/bootstrap.js",
      "lib/coreBundle.js",
      "browsers.json",
    ])
      fs.file(win32.join(config.bundleDirectory, "node_modules", "playwright-core", name));
  }
  if (config.windows !== undefined) {
    fs.file(config.windows.driverEntryPath);
    fs.directory(config.windows.desktopLockDirectory);
  }
  return { config, fs };
}

const uiEnvironment = (): NodeJS.ProcessEnv => ({
  WORKER_VALIDATION_WEB_ENABLED: "true",
  WORKER_VALIDATION_WEB_BROWSER_EXECUTABLE_PATH: browserPath,
  WORKER_VALIDATION_WINDOWS_ENABLED: "true",
  WORKER_VALIDATION_DESKTOP_LOCK_DIRECTORY: desktopPath,
});

describe("validation runtime deployment configuration", () => {
  it("defaults headless to the actual execution setting and leaves UI opt-in", () => {
    const enabled = loadValidationRuntimeConfig({}, defaults());
    expect(enabled.headlessEnabled).toBe(true);
    expect(enabled.cleanupTimeoutMs).toBe(30_000);
    expect(enabled.web).toBeUndefined();
    expect(enabled.windows).toBeUndefined();
    expect(enabled.summary).toBeUndefined();
    expect(
      loadValidationRuntimeConfig({}, defaults({ executionEnabled: false })).headlessEnabled,
    ).toBe(false);
  });

  it("requires explicit summary opt-in and freezes its bounded timeout", () => {
    const config = loadValidationRuntimeConfig(
      { WORKER_VALIDATION_SUMMARY_ENABLED: "true" },
      defaults(),
    );
    expect(config.summary).toEqual({ maximumTimeoutMs: 60_000 });
    expect(Object.isFrozen(config.summary)).toBe(true);
    expect(
      loadValidationRuntimeConfig(
        {
          WORKER_VALIDATION_SUMMARY_ENABLED: "false",
          WORKER_VALIDATION_SUMMARY_TIMEOUT_MS: "300000",
        },
        defaults(),
      ).summary,
    ).toBeUndefined();
  });

  it.each(["10000", "300000"])("accepts the summary timeout boundary %s", (value) => {
    expect(
      loadValidationRuntimeConfig(
        { WORKER_VALIDATION_SUMMARY_ENABLED: "true", WORKER_VALIDATION_SUMMARY_TIMEOUT_MS: value },
        defaults(),
      ).summary?.maximumTimeoutMs,
    ).toBe(Number(value));
  });

  it.each(["0", "9999", "300001", "10000.5", "1e4", " 10000", "10000\n", "", "Infinity"])(
    "rejects an invalid summary timeout %s",
    (value) => {
      expect(() =>
        loadValidationRuntimeConfig(
          {
            WORKER_VALIDATION_SUMMARY_ENABLED: "true",
            WORKER_VALIDATION_SUMMARY_TIMEOUT_MS: value,
          },
          defaults(),
        ),
      ).toThrow(/SUMMARY_TIMEOUT_MS/u);
    },
  );

  it("cannot enable summaries when execution or every validation runner is disabled", () => {
    expect(() =>
      loadValidationRuntimeConfig(
        { WORKER_VALIDATION_SUMMARY_ENABLED: "true" },
        defaults({ executionEnabled: false }),
      ),
    ).toThrow(/EXECUTION_ENABLED/u);
    expect(() =>
      loadValidationRuntimeConfig(
        { WORKER_VALIDATION_SUMMARY_ENABLED: "true", WORKER_VALIDATION_HEADLESS_ENABLED: "false" },
        defaults(),
      ),
    ).toThrow(/enabled validation runner/u);
  });

  it("derives driver assets from the supplied deployment bundle and trusted system aliases", () => {
    const config = loadValidationRuntimeConfig(uiEnvironment(), defaults());
    expect(config.web).toStrictEqual({
      browserExecutablePath: browserPath,
      nodeExecutablePath: "C:\\TrustedTools\\node.exe",
      driverEntryPath: "C:\\WorkerBundle\\dist\\web-driver.mjs",
      powerShellExecutablePath: defaults().executables[2]?.path,
      windowsProbeEntryPath: "C:\\WorkerBundle\\dist\\windows-driver-entry.ps1",
    });
    expect(config.windows).toStrictEqual({
      powerShellExecutablePath: defaults().executables[2]?.path,
      driverEntryPath: "C:\\WorkerBundle\\dist\\windows-driver-entry.ps1",
      desktopLockDirectory: desktopPath,
    });
  });

  it("snapshots and freezes all nested paths and registry entries", () => {
    const trustedDefaults = defaults();
    const config = loadValidationRuntimeConfig(
      {
        ...uiEnvironment(),
        WORKER_VALIDATION_SECRET_FILES_JSON: JSON.stringify({ token: secretPath }),
      },
      trustedDefaults,
    );
    expect(Object.isFrozen(config)).toBe(true);
    for (const value of [
      config.executables,
      ...config.executables,
      config.untrustedDirectories,
      config.secretFiles,
      config.web,
      config.windows,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    Reflect.set(trustedDefaults.executables[0] as object, "path", "C:\\Changed\\git.exe");
    expect(config.executables[0]?.path).toBe("C:\\TrustedTools\\git.exe");
    expect(Reflect.set(config.secretFiles, "token", "C:\\Changed\\token.txt")).toBe(false);
  });

  it.each([
    "WORKER_VALIDATION_HEADLESS_ENABLED",
    "WORKER_VALIDATION_WEB_ENABLED",
    "WORKER_VALIDATION_WINDOWS_ENABLED",
  ])("requires execution for %s", (setting) => {
    expect(() =>
      loadValidationRuntimeConfig({ [setting]: "true" }, defaults({ executionEnabled: false })),
    ).toThrow(/require WORKER_EXECUTION_ENABLED/u);
  });

  it.each(["", "TRUE", "yes", " true "])("rejects malformed opt-in %j", (value) => {
    expect(() =>
      loadValidationRuntimeConfig({ WORKER_VALIDATION_WEB_ENABLED: value }, defaults()),
    ).toThrow(/must be true/u);
  });

  it("requires a browser path, a shared desktop directory, and a single Windows slot", () => {
    expect(() =>
      loadValidationRuntimeConfig({ WORKER_VALIDATION_WEB_ENABLED: "true" }, defaults()),
    ).toThrow(/paths/u);
    expect(() =>
      loadValidationRuntimeConfig({ WORKER_VALIDATION_WINDOWS_ENABLED: "true" }, defaults()),
    ).toThrow(/paths/u);
    expect(() => loadValidationRuntimeConfig(uiEnvironment(), defaults({ maxSlots: 2 }))).toThrow(
      /WORKER_MAX_SLOTS=1/u,
    );
    expect(() =>
      loadValidationRuntimeConfig(uiEnvironment(), defaults({ executables: [] })),
    ).toThrow(/trusted node alias/u);
  });

  it.each([
    "WORKER_VALIDATION_WEB_BROWSER_EXECUTABLE_PATH",
    "WORKER_VALIDATION_DESKTOP_LOCK_DIRECTORY",
  ])("rejects orphaned %s", (setting) => {
    expect(() => loadValidationRuntimeConfig({ [setting]: browserPath }, defaults())).toThrow(
      /requires WORKER_VALIDATION/u,
    );
  });

  it("rejects unknown validation settings without including their values in the error", () => {
    expect(() =>
      loadValidationRuntimeConfig(
        { WORKER_VALIDATION_DRIVER_PATH: "SECRET-DO-NOT-EXPOSE" },
        defaults(),
      ),
    ).toThrow("Validation runtime configuration contains an unsupported setting.");
  });

  it.each(["999", "300001", "0", "-1", "1e3", "30000ms", "", "30000.0"])(
    "bounds cleanup timeout %j",
    (value) => {
      expect(() =>
        loadValidationRuntimeConfig({ WORKER_VALIDATION_CLEANUP_TIMEOUT_MS: value }, defaults()),
      ).toThrow(/1000 through 300000/u);
    },
  );

  it.each(["1000", "60000", "180000", "300000"])("accepts cleanup timeout %s", (value) => {
    expect(
      loadValidationRuntimeConfig({ WORKER_VALIDATION_CLEANUP_TIMEOUT_MS: value }, defaults())
        .cleanupTimeoutMs,
    ).toBe(Number(value));
  });

  it.each(["node", "NODE", "cmd.exe", "powershell", "git"])(
    "rejects replacement of system alias %s",
    (name) => {
      expect(() =>
        loadValidationRuntimeConfig(
          { WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify([{ name, path: customPath }]) },
          defaults(),
        ),
      ).toThrow(/system aliases/u);
    },
  );

  it("rejects duplicate custom aliases and extra registry fields", () => {
    for (const registrations of [
      [
        { name: "dotnet", path: customPath },
        { name: "DotNet", path: customPath },
      ],
      [{ name: "dotnet", path: customPath, arguments: ["secret"] }],
    ]) {
      expect(() =>
        loadValidationRuntimeConfig(
          { WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify(registrations) },
          defaults(),
        ),
      ).toThrow();
    }
  });

  it.each([
    "C:relative.exe",
    "relative.exe",
    "\\\\host\\share\\tool.exe",
    "C:\\Tools\\..\\tool.exe",
    "C:\\Tools\\tool.exe:stream",
    "C:\\Tools\\CON.exe",
    "C:\\Tools\\COM¹.exe",
    "C:\\Tools\\tool.exe ",
    "C:\\Tools\\tool.cmd",
  ])("rejects unsafe registered path %j", (path) => {
    expect(() =>
      loadValidationRuntimeConfig(
        { WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify([{ name: "dotnet", path }]) },
        defaults(),
      ),
    ).toThrow(/paths/u);
  });

  it.each([
    "invalid-json",
    "[]",
    '{"token":{"value":"SECRET-DO-NOT-EXPOSE"}}',
    '{"token":"inline-secret"}',
    '{"constructor":"C:\\\\ProtectedSecrets\\\\secret"}',
  ])("rejects invalid secret path-map %j", (value) => {
    expect(() =>
      loadValidationRuntimeConfig({ WORKER_VALIDATION_SECRET_FILES_JSON: value }, defaults()),
    ).toThrow();
  });

  it("bounds registry JSON and SHA-256 pins", () => {
    expect(() =>
      loadValidationRuntimeConfig(
        { WORKER_VALIDATION_COMMANDS_JSON: " ".repeat(65_537) },
        defaults(),
      ),
    ).toThrow(/size limit/u);
    expect(() =>
      loadValidationRuntimeConfig(
        {
          WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify(
            Array.from({ length: 129 }, (_, index) => ({ name: `tool${index}`, path: customPath })),
          ),
        },
        defaults(),
      ),
    ).toThrow(/bounded array/u);
    expect(() =>
      loadValidationRuntimeConfig(
        {
          WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify([
            { name: "dotnet", path: customPath, sha256: "A".repeat(64) },
          ]),
        },
        defaults(),
      ),
    ).toThrow(/SHA-256/u);
  });

  it("keeps commands, secrets, drivers, browsers, and desktop locks outside mutable roots", () => {
    const unsafeFile = win32.join(checkout, "tool.exe");
    const environments = [
      { WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify([{ name: "dotnet", path: unsafeFile }]) },
      { WORKER_VALIDATION_SECRET_FILES_JSON: JSON.stringify({ token: unsafeFile }) },
      { ...uiEnvironment(), WORKER_VALIDATION_WEB_BROWSER_EXECUTABLE_PATH: unsafeFile },
      { ...uiEnvironment(), WORKER_VALIDATION_DESKTOP_LOCK_DIRECTORY: checkout },
    ];
    for (const environment of environments)
      expect(() => loadValidationRuntimeConfig(environment, defaults())).toThrow(
        /outside mutable/u,
      );
    expect(() =>
      loadValidationRuntimeConfig({}, defaults({ bundleDirectory: win32.join(checkout, "dist") })),
    ).toThrow(/outside mutable/u);
  });
});

describe("validation runtime preparation", () => {
  it.each(["PS probe", "Playwright core", "Playwright bootstrap", "browser metadata"])(
    "requires %s for Web-only deployments",
    async (missing) => {
      const { config, fs } = fixture({
        WORKER_VALIDATION_WEB_ENABLED: "true",
        WORKER_VALIDATION_WEB_BROWSER_EXECUTABLE_PATH: browserPath,
      });
      const files: Record<string, string> = {
        "PS probe": config.web?.windowsProbeEntryPath as string,
        "Playwright core": win32.join(
          config.bundleDirectory,
          "node_modules",
          "playwright-core",
          "lib",
          "coreBundle.js",
        ),
        "Playwright bootstrap": win32.join(
          config.bundleDirectory,
          "node_modules",
          "playwright-core",
          "lib",
          "bootstrap.js",
        ),
        "browser metadata": win32.join(
          config.bundleDirectory,
          "node_modules",
          "playwright-core",
          "browsers.json",
        ),
      };
      fs.remove(files[missing] as string);
      await expect(prepareValidationRuntime(config, { fileSystem: fs })).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
    },
  );

  it("does no file access when every runner is disabled", async () => {
    const config = loadValidationRuntimeConfig({}, defaults({ executionEnabled: false }));
    await expect(
      prepareValidationRuntime(config, { fileSystem: new FakeFileSystem() }),
    ).resolves.toBe(config);
  });

  it("verifies installed UI drivers, browser, and packaged browser runtime before preparation succeeds", async () => {
    const { config, fs } = fixture(uiEnvironment());
    await expect(prepareValidationRuntime(config, { fileSystem: fs })).resolves.toBe(config);
    expect(fs.opened).toContain(config.web?.driverEntryPath);
    expect(fs.opened).toContain(config.windows?.driverEntryPath);
    expect(fs.opened).toContain(browserPath);
    expect(fs.closeCount).toBe(fs.opened.length);
  });

  it.each([
    "browser",
    "web driver",
    "Windows driver",
    "Playwright package",
    "Playwright entry",
    "desktop directory",
  ])("does not prepare a missing %s", async (missing) => {
    const { config, fs } = fixture(uiEnvironment());
    const paths: Record<string, string> = {
      browser: browserPath,
      "web driver": config.web?.driverEntryPath as string,
      "Windows driver": config.windows?.driverEntryPath as string,
      "Playwright package": win32.join(
        config.bundleDirectory,
        "node_modules",
        "playwright-core",
        "package.json",
      ),
      "Playwright entry": win32.join(
        config.bundleDirectory,
        "node_modules",
        "playwright-core",
        "index.mjs",
      ),
      "desktop directory": desktopPath,
    };
    fs.remove(paths[missing] as string);
    await expect(prepareValidationRuntime(config, { fileSystem: fs })).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      message: "The configured validation runtime is unavailable or unsafe.",
    });
  });

  it("allows actual OS hard links only for caller-provided system defaults", async () => {
    const { config, fs } = fixture({
      WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify([{ name: "dotnet", path: customPath }]),
    });
    fs.entry("C:\\Windows\\System32\\cmd.exe").nlink = 2n;
    await expect(prepareValidationRuntime(config, { fileSystem: fs })).resolves.toBe(config);
    fs.entry(customPath).nlink = 2n;
    await expect(prepareValidationRuntime(config, { fileSystem: fs })).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
  });

  it("checks pins through bounded reads and rejects changed digests", async () => {
    const content = Buffer.alloc(140_000, 0x5a);
    const { config, fs } = fixture({
      WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify([
        { name: "dotnet", path: customPath, sha256: digest(content) },
      ]),
    });
    fs.entry(customPath).content = content;
    await expect(prepareValidationRuntime(config, { fileSystem: fs })).resolves.toBe(config);
    expect(fs.maximumReadLength).toBeLessThanOrEqual(65_536);
    fs.entry(customPath).content = Buffer.from("Different binary");
    await expect(prepareValidationRuntime(config, { fileSystem: fs })).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
  });
});

describe("per-workspace executable resolution", () => {
  it("resolves a registered alias independently of checkout files and inherited PATH", async () => {
    const { config, fs } = fixture();
    fs.file(win32.join(checkout, "git.exe"));
    const resolvers = createValidationWorkspaceResolvers(config, checkout, { fileSystem: fs });
    await expect(resolvers.resolveExecutable("GIT", signal())).resolves.toBe(
      "C:\\TrustedTools\\git.exe",
    );
    expect(fs.opened).not.toContain(win32.join(checkout, "git.exe"));
  });

  it.each([
    "unregistered",
    "git.exe",
    "build/tool.exe",
    ".\\build\\tool.exe",
    "../tool.exe",
    "./../tool.exe",
    "./build//tool.exe",
    "./build/../tool.exe",
    "./build/tool.cmd",
    "C:\\TrustedTools\\git.exe",
    "./build/tool.exe:stream",
    "./C:/outside.exe",
  ])("rejects unapproved executable syntax %j", async (name) => {
    const { config, fs } = fixture();
    const resolvers = createValidationWorkspaceResolvers(config, checkout, { fileSystem: fs });
    await expect(resolvers.resolveExecutable(name, signal())).rejects.toMatchObject({
      code: "EXECUTABLE_UNAVAILABLE",
    });
    expect(fs.opened).toHaveLength(0);
  });

  it("accepts only the explicit generated executable in the current checkout", async () => {
    const { config, fs } = fixture();
    const path = win32.join(checkout, "build", "app.exe");
    fs.file(path).canonical = path.toLowerCase();
    const resolvers = createValidationWorkspaceResolvers(config, checkout, { fileSystem: fs });
    await expect(resolvers.resolveExecutable("./build/app.exe", signal())).resolves.toBe(path);
  });

  it.each([
    "leaf symlink",
    "leaf reparse",
    "leaf hardlink",
    "ancestor symlink",
    "ancestor reparse",
    "canonical escape",
    "ancestor alias",
  ])("rejects generated executable %s", async (scenario) => {
    const { config, fs } = fixture();
    const path = win32.join(checkout, "build", "app.exe");
    const entry = fs.file(path);
    const parent = fs.entry(win32.dirname(path));
    if (scenario === "leaf symlink") entry.symbolicLink = true;
    if (scenario === "leaf reparse") entry.reparsePoint = true;
    if (scenario === "leaf hardlink") entry.nlink = 2n;
    if (scenario === "ancestor symlink") parent.symbolicLink = true;
    if (scenario === "ancestor reparse") parent.reparsePoint = true;
    if (scenario === "canonical escape") entry.canonical = "C:\\Outside\\app.exe";
    if (scenario === "ancestor alias") parent.canonical = "C:\\Outside";
    await expect(
      createValidationWorkspaceResolvers(config, checkout, { fileSystem: fs }).resolveExecutable(
        "./build/app.exe",
        signal(),
      ),
    ).rejects.toMatchObject({ code: "EXECUTABLE_UNAVAILABLE" });
  });

  it("does not trust a configured alias pointing into the current checkout even without mutable-root hints", async () => {
    const { config, fs } = fixture(
      {
        WORKER_VALIDATION_COMMANDS_JSON: JSON.stringify([
          { name: "app", path: win32.join(checkout, "app.exe") },
        ]),
      },
      defaults({ untrustedDirectories: [] }),
    );
    await expect(
      createValidationWorkspaceResolvers(config, checkout, { fileSystem: fs }).resolveExecutable(
        "app",
        signal(),
      ),
    ).rejects.toMatchObject({ code: "EXECUTABLE_UNAVAILABLE" });
    expect(fs.opened).toHaveLength(0);
  });
});

describe("protected validation secret resolution", () => {
  const secretFixture = () => {
    const { config, fs } = fixture({
      WORKER_VALIDATION_SECRET_FILES_JSON: JSON.stringify({ "test:token": secretPath }),
    });
    const entry = fs.file(secretPath, Buffer.from("exact secret\r\n"));
    return {
      config,
      fs,
      entry,
      resolver: createValidationWorkspaceResolvers(config, checkout, { fileSystem: fs }),
    };
  };

  it("reads exact strict UTF-8 through a stable handle and closes it", async () => {
    const { fs, resolver } = secretFixture();
    await expect(resolver.resolveSecret("test:token", signal())).resolves.toBe("exact secret\r\n");
    expect(fs.opened).toStrictEqual([secretPath]);
    expect(fs.closeCount).toBe(1);
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("secret\u0000suffix"),
    Buffer.from("\ufeffsecret"),
    Buffer.alloc(65_537, 0x73),
    Buffer.alloc(32_768, 0x73),
  ])("rejects malformed or oversized secret payload %#", async (content) => {
    const { entry, resolver } = secretFixture();
    entry.content = content;
    await expect(resolver.resolveSecret("test:token", signal())).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "The validation secret could not be read securely.",
    });
  });

  it.each(["symbolic link", "reparse", "hard link", "canonical alias", "ancestor link"])(
    "rejects a secret %s",
    async (scenario) => {
      const { fs, entry, resolver } = secretFixture();
      if (scenario === "symbolic link") entry.symbolicLink = true;
      if (scenario === "reparse") entry.reparsePoint = true;
      if (scenario === "hard link") entry.nlink = 2n;
      if (scenario === "canonical alias") entry.canonical = "C:\\Outside\\secret.txt";
      if (scenario === "ancestor link") fs.entry(win32.dirname(secretPath)).symbolicLink = true;
      await expect(resolver.resolveSecret("test:token", signal())).rejects.toMatchObject({
        code: "SECRET_UNAVAILABLE",
      });
      expect(fs.opened).toHaveLength(0);
    },
  );

  it.each([
    "opened replacement",
    "same-size mutation",
    "named replacement",
    "ancestor replacement",
    "short read",
    "extra byte",
    "close failure",
  ])("fails closed on %s without leaking bytes or filesystem errors", async (scenario) => {
    const { fs, entry, resolver } = secretFixture();
    if (scenario === "opened replacement")
      fs.onOpen = (opened) => {
        opened.ctimeNs += 1n;
      };
    if (scenario === "same-size mutation")
      fs.onRead = (opened) => {
        opened.mtimeNs += 1n;
      };
    if (scenario === "named replacement")
      fs.onRead = () => {
        fs.file(secretPath, entry.content);
      };
    if (scenario === "ancestor replacement")
      fs.onRead = () => {
        fs.entry(win32.dirname(secretPath)).mode = 0o40750n;
      };
    if (scenario === "short read") fs.readOverride = () => 0;
    if (scenario === "extra byte")
      fs.readOverride = (_opened, buffer, length) => {
        buffer.fill(0x73);
        return length;
      };
    if (scenario === "close failure")
      fs.onClose = () => {
        throw new Error("SECRET-DO-NOT-EXPOSE");
      };
    await expect(resolver.resolveSecret("test:token", signal())).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
      message: "The validation secret could not be read securely.",
    });
    expect(fs.closeCount).toBeGreaterThan(0);
  });

  it("rejects unknown references and files inside the checkout", async () => {
    const { fs, resolver } = secretFixture();
    await expect(resolver.resolveSecret("unknown", signal())).rejects.toMatchObject({
      code: "SECRET_UNAVAILABLE",
    });
    expect(fs.opened).toHaveLength(0);
    const config = loadValidationRuntimeConfig(
      {
        WORKER_VALIDATION_SECRET_FILES_JSON: JSON.stringify({
          token: win32.join(checkout, "token.txt"),
        }),
      },
      defaults({ untrustedDirectories: [] }),
    );
    await expect(
      createValidationWorkspaceResolvers(config, checkout, { fileSystem: fs }).resolveSecret(
        "token",
        signal(),
      ),
    ).rejects.toMatchObject({ code: "SECRET_UNAVAILABLE" });
  });

  it("honors cancellation before opening or after a read without exposing its reason", async () => {
    const { fs, resolver } = secretFixture();
    const controller = new AbortController();
    controller.abort(new Error("SECRET-DO-NOT-EXPOSE"));
    await expect(resolver.resolveSecret("test:token", controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
      message: "Validation runtime preparation was cancelled.",
    });
    expect(fs.opened).toHaveLength(0);
    const duringRead = new AbortController();
    fs.onRead = () => duringRead.abort("SECRET-DO-NOT-EXPOSE");
    await expect(resolver.resolveSecret("test:token", duringRead.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(fs.closeCount).toBe(1);
  });

  it("does not return secret bytes when cancellation arrives during handle close", async () => {
    const { fs, resolver } = secretFixture();
    const controller = new AbortController();
    fs.onClose = () => controller.abort("SECRET-DO-NOT-EXPOSE");

    await expect(resolver.resolveSecret("test:token", controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(fs.closeCount).toBe(1);
  });
});

describe("native Windows validation file checks", () => {
  it.runIf(process.platform === "win32")(
    "opens real synthetic files without launching a process",
    async () => {
      // Windows runner TEMP can use a short-name or redirected directory alias.
      const temporaryRoot = await realpath(tmpdir());
      const directory = await mkdtemp(
        win32.join(temporaryRoot, "agentic-review-validation-runtime-"),
      );
      if (
        !win32.basename(directory).startsWith("agentic-review-validation-runtime-") ||
        win32.dirname(directory).toLowerCase() !== win32.resolve(temporaryRoot).toLowerCase()
      )
        throw new Error("Unexpected validation fixture cleanup path.");
      try {
        const workspace = win32.join(directory, "checkout");
        const executable = win32.join(directory, "tool.exe");
        const secret = win32.join(directory, "token.txt");
        await mkdir(workspace);
        await Promise.all([
          writeFile(executable, "Synthetic binary fixture; never launched."),
          writeFile(win32.join(workspace, "app.exe"), "Synthetic build output; never launched."),
          writeFile(secret, "native UTF-8 secret fixture"),
        ]);
        const config = loadValidationRuntimeConfig(
          { WORKER_VALIDATION_SECRET_FILES_JSON: JSON.stringify({ token: secret }) },
          defaults({
            bundleDirectory: win32.join(directory, "bundle"),
            executables: [{ name: "node", path: executable }],
            untrustedDirectories: [workspace],
          }),
        );
        await expect(prepareValidationRuntime(config)).resolves.toBe(config);
        const resolver = createValidationWorkspaceResolvers(config, workspace);
        await expect(resolver.resolveExecutable("./app.exe", signal())).resolves.toBe(
          win32.join(workspace, "app.exe"),
        );
        await expect(resolver.resolveSecret("token", signal())).resolves.toBe(
          "native UTF-8 secret fixture",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
