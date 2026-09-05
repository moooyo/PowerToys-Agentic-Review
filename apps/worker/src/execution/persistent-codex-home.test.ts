import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CodexHomeDirectoryFileSystem,
  type CodexHomeDirectoryStat,
  type VerifyPersistentCodexHomeOptions,
  verifyPersistentCodexHome,
} from "./persistent-codex-home.js";

const directories = {
  profileDirectory: "C:\\AgenticReview\\Profile",
  workspaceRootDirectory: "C:\\AgenticReview\\Workspaces",
  tempDirectory: "C:\\AgenticReview\\Temp",
  gitSharedRootDirectory: "C:\\AgenticReview\\Repositories",
  gitWorkingDirectory: "C:\\AgenticReview\\GitRuntime",
  trustedExecutableRoot: "C:\\AgenticReviewBin",
} as const;

interface FakeDirectory {
  realPath: string;
  dev: bigint;
  ino: bigint;
  directory: boolean;
  symbolicLink: boolean;
  reparsePoint: boolean;
  reads: number;
}

class FakeFileSystem implements CodexHomeDirectoryFileSystem {
  readonly entries = new Map<string, FakeDirectory>();
  public readCalls = 0;
  public onRead: ((path: string, entry: FakeDirectory) => void) | undefined;

  public constructor(paths: Readonly<Record<string, string>> = directories) {
    for (const path of Object.values(paths)) this.add(path);
  }

  public add(path: string): FakeDirectory {
    const entry: FakeDirectory = {
      realPath: path,
      dev: 1n,
      ino: BigInt(this.entries.size + 1),
      directory: true,
      symbolicLink: false,
      reparsePoint: false,
      reads: 0,
    };
    this.entries.set(this.key(path), entry);
    return entry;
  }

  public entry(path: string): FakeDirectory {
    const entry = this.entries.get(this.key(path));
    if (entry === undefined)
      throw Object.assign(new Error("Directory missing."), { code: "ENOENT" });
    return entry;
  }

  public async lstat(path: string): Promise<CodexHomeDirectoryStat> {
    this.readCalls += 1;
    const entry = this.entry(path);
    entry.reads += 1;
    this.onRead?.(path, entry);
    return {
      dev: entry.dev,
      ino: entry.ino,
      isDirectory: () => entry.directory,
      isSymbolicLink: () => entry.symbolicLink,
      isReparsePoint: () => entry.reparsePoint,
    };
  }

  public async realpath(path: string): Promise<string> {
    this.readCalls += 1;
    return this.entry(path).realPath;
  }

  private key(path: string): string {
    return win32.normalize(path).toLowerCase();
  }
}

describe("verifyPersistentCodexHome", () => {
  it("accepts separate directory identities and preserves the canonical profile path", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.entry(directories.profileDirectory).realPath = "c:\\agenticreview\\profile";

    await expect(verifyPersistentCodexHome({ ...directories, fileSystem })).resolves.toBe(
      "c:\\agenticreview\\profile",
    );
    expect(fileSystem.entries.size).toBe(Object.keys(directories).length);
  });

  it.each(["symbolicLink", "reparsePoint"] as const)(
    "rejects a persistent profile that is a %s",
    async (property) => {
      const fileSystem = new FakeFileSystem();
      fileSystem.entry(directories.profileDirectory)[property] = true;

      await expect(verifyPersistentCodexHome({ ...directories, fileSystem })).rejects.toThrow(
        /link or reparse point/u,
      );
    },
  );

  it("rejects a parent-directory alias into an attempt before cleanup can use the profile", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.entry(directories.profileDirectory).realPath =
      `${directories.workspaceRootDirectory}\\attempt-old`;

    await expect(verifyPersistentCodexHome({ ...directories, fileSystem })).rejects.toThrow(
      /profileDirectory.*without aliases/u,
    );
  });

  it.each([
    "workspaceRootDirectory",
    "tempDirectory",
    "gitSharedRootDirectory",
    "gitWorkingDirectory",
    "trustedExecutableRoot",
  ] as const)("rejects an alias from %s into the persistent profile", async (name) => {
    const fileSystem = new FakeFileSystem();
    fileSystem.entry(directories[name]).realPath = directories.profileDirectory;

    await expect(verifyPersistentCodexHome({ ...directories, fileSystem })).rejects.toThrow(
      /without aliases/u,
    );
  });

  it.each([
    directories.workspaceRootDirectory,
    `${directories.workspaceRootDirectory}\\PersistentProfile`,
    "C:\\AgenticReview",
  ])("rejects equal, descendant, and ancestor workspace overlap: %s", async (profileDirectory) => {
    const options = { ...directories, profileDirectory };
    const fileSystem = new FakeFileSystem(options);

    await expect(verifyPersistentCodexHome({ ...options, fileSystem })).rejects.toThrow(
      /overlaps/u,
    );
  });

  it("rejects different paths that identify the same filesystem object", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.entry(directories.tempDirectory).ino = fileSystem.entry(
      directories.profileDirectory,
    ).ino;

    await expect(verifyPersistentCodexHome({ ...directories, fileSystem })).rejects.toThrow(
      /overlaps tempDirectory/u,
    );
  });

  it("rejects identity changes observed while checking the runtime roots", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.onRead = (path, entry) => {
      if (path === directories.profileDirectory && entry.reads === 2) entry.ino += 10n;
    };

    await expect(verifyPersistentCodexHome({ ...directories, fileSystem })).rejects.toThrow(
      /changed identity/u,
    );
  });

  it("fails on missing directories without creating them", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.entries.clear();

    await expect(verifyPersistentCodexHome({ ...directories, fileSystem })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(fileSystem.entries.size).toBe(0);
  });

  it.each([
    "relative\\profile",
    "C:\\",
    "C:\\data\\..\\profile",
    "\\\\server\\profile",
    "C:\\data\\profile\n",
  ])("rejects unsafe paths before filesystem reads: %s", async (profileDirectory) => {
    const fileSystem = new FakeFileSystem();
    const options: VerifyPersistentCodexHomeOptions = {
      ...directories,
      profileDirectory,
      fileSystem,
    };

    await expect(verifyPersistentCodexHome(options)).rejects.toThrow(TypeError);
    expect(fileSystem.readCalls).toBe(0);
  });
});
