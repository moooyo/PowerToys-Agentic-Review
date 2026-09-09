import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type TrustedBinaryFileHandle,
  type TrustedBinaryFileIO,
  type TrustedBinaryFileStat,
  TrustedBinaryVerificationError,
  type VerifyTrustedExecutionBinariesOptions,
  verifyTrustedExecutionBinaries,
} from "./trusted-binary.js";

const trustedRoot = "C:\\Trusted\\bin";
const processHostPath = `${trustedRoot}\\AgenticReview.ProcessHost.exe`;
const cliPath = `${trustedRoot}\\cli.exe`;
const gitPath = `${trustedRoot}\\git.exe`;

type FakeNodeKind = "directory" | "file";

class FakeNode {
  public readonly path: string;
  public realPath: string;
  public readonly kind: FakeNodeKind;
  public content: Buffer;
  public dev: number;
  public ino: number;
  public size: number;
  public mtimeMs: number;
  public ctimeMs: number;
  public symbolicLink = false;
  public reparsePoint = false;
  public statOverrides: Partial<
    Pick<TrustedBinaryFileStat, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">
  > = {};

  public constructor(options: {
    readonly path: string;
    readonly kind: FakeNodeKind;
    readonly content?: Buffer;
    readonly dev: number;
    readonly ino: number;
  }) {
    this.path = options.path;
    this.realPath = options.path;
    this.kind = options.kind;
    this.content = options.content ?? Buffer.alloc(0);
    this.dev = options.dev;
    this.ino = options.ino;
    this.size = this.content.byteLength;
    this.mtimeMs = 1000;
    this.ctimeMs = 1000;
  }

  public snapshot(): TrustedBinaryFileStat {
    const directory = this.kind === "directory";
    const file = this.kind === "file";
    const symbolicLink = this.symbolicLink;
    const reparsePoint = this.reparsePoint;
    return {
      dev: this.dev,
      ino: this.ino,
      size: this.size,
      mtimeMs: this.mtimeMs,
      ctimeMs: this.ctimeMs,
      ...this.statOverrides,
      isDirectory: () => directory,
      isFile: () => file,
      isSymbolicLink: () => symbolicLink,
      isReparsePoint: () => reparsePoint,
    };
  }
}

class FakeHandle implements TrustedBinaryFileHandle {
  readonly #fileIO: FakeFileIO;
  readonly #openedPath: string;
  readonly #node: FakeNode;
  #firstRead = true;

  public constructor(fileIO: FakeFileIO, openedPath: string, node: FakeNode) {
    this.#fileIO = fileIO;
    this.#openedPath = openedPath;
    this.#node = node;
  }

  public async stat(): Promise<TrustedBinaryFileStat> {
    return this.#node.snapshot();
  }

  public async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }> {
    this.#fileIO.maximumRequestedReadBytes = Math.max(
      this.#fileIO.maximumRequestedReadBytes,
      length,
    );
    if (this.#firstRead) {
      this.#firstRead = false;
      this.#fileIO.onFirstRead?.(this.#openedPath, this.#node);
    }
    const available = Math.max(0, Math.min(length, this.#node.content.byteLength - position));
    this.#node.content.copy(buffer, offset, position, position + available);
    const key = pathKey(this.#openedPath);
    this.#fileIO.readBytes.set(key, (this.#fileIO.readBytes.get(key) ?? 0) + available);
    return { bytesRead: available };
  }

  public async close(): Promise<void> {
    await Promise.resolve();
    this.#fileIO.closedPaths.push(this.#openedPath);
  }
}

class FakeFileIO implements TrustedBinaryFileIO {
  readonly #nodes = new Map<string, FakeNode>();
  public readonly openOverrides = new Map<string, FakeNode>();
  public onFirstRead: ((path: string, node: FakeNode) => void) | undefined;
  public maximumRequestedReadBytes = 0;
  public readonly openedPaths: string[] = [];
  public readonly closedPaths: string[] = [];
  public readonly lstatPaths: string[] = [];
  public readonly readBytes = new Map<string, number>();

  public add(node: FakeNode): FakeNode {
    this.#nodes.set(pathKey(node.path), node);
    return node;
  }

  public replace(path: string, node: FakeNode): void {
    this.#nodes.set(pathKey(path), node);
  }

  public node(path: string): FakeNode {
    const node = this.#nodes.get(pathKey(path));
    if (node === undefined) throw new Error("fake path not found");
    return node;
  }

  public async lstat(path: string): Promise<TrustedBinaryFileStat> {
    this.lstatPaths.push(path);
    return this.node(path).snapshot();
  }

  public async stat(path: string): Promise<TrustedBinaryFileStat> {
    return this.node(path).snapshot();
  }

  public async realpath(path: string): Promise<string> {
    return this.node(path).realPath;
  }

  public async open(path: string): Promise<TrustedBinaryFileHandle> {
    this.openedPaths.push(path);
    const node = this.openOverrides.get(pathKey(path)) ?? this.node(path);
    return new FakeHandle(this, path, node);
  }
}

function createFixture(): {
  readonly fileIO: FakeFileIO;
  readonly options: VerifyTrustedExecutionBinariesOptions;
} {
  const fileIO = new FakeFileIO();
  fileIO.add(new FakeNode({ path: trustedRoot, kind: "directory", dev: 1, ino: 1 }));
  const processHost = fileIO.add(
    new FakeNode({
      path: processHostPath,
      kind: "file",
      content: Buffer.alloc(130 * 1024, 0x41),
      dev: 1,
      ino: 10,
    }),
  );
  const cli = fileIO.add(
    new FakeNode({
      path: cliPath,
      kind: "file",
      content: Buffer.from("trusted cli executable"),
      dev: 1,
      ino: 11,
    }),
  );
  const git = fileIO.add(
    new FakeNode({
      path: gitPath,
      kind: "file",
      content: Buffer.from("trusted git executable"),
      dev: 1,
      ino: 12,
    }),
  );
  return {
    fileIO,
    options: {
      trustedExecutableRoot: trustedRoot,
      processHost: { path: processHostPath, expectedSha256: digest(processHost.content) },
      cli: { path: cliPath, expectedSha256: digest(cli.content) },
      git: { path: gitPath, expectedSha256: digest(git.content) },
      fileIO,
    },
  };
}

describe("verifyTrustedExecutionBinaries", () => {
  it.each([false, true])("uses an external CLI installation with digest pin %s", async (pin) => {
    const { fileIO, options } = createFixture();
    const installedCli = fileIO.add(
      new FakeNode({
        path: "C:\\Users\\Worker\\AppData\\Local\\Programs\\Codex\\codex.exe",
        kind: "file",
        content: Buffer.from("existing CLI installation"),
        dev: 2,
        ino: 30,
      }),
    );
    const verified = await verifyTrustedExecutionBinaries({
      ...options,
      cli: {
        path: installedCli.path,
        ...(pin ? { expectedSha256: digest(installedCli.content) } : {}),
      },
    });
    expect(verified.cliPath).toBe(installedCli.path);
    expect(verified.measurements.cli.sha256).toBe(digest(installedCli.content));
    expect(fileIO.openedPaths).toEqual([processHostPath, installedCli.path, gitPath]);
    expect(fileIO.closedPaths).toEqual(fileIO.openedPaths);
  });

  it("resolves a WinGet installation link and returns its measured target", async () => {
    const { fileIO, options } = createFixture();
    const installedCli = fileIO.add(
      new FakeNode({
        path: "C:\\Users\\Worker\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Codex\\codex.exe",
        kind: "file",
        content: Buffer.from("installed CLI target"),
        dev: 2,
        ino: 30,
      }),
    );
    const link = fileIO.add(
      new FakeNode({
        path: "C:\\Users\\Worker\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe",
        kind: "file",
        dev: 2,
        ino: 31,
      }),
    );
    link.symbolicLink = true;
    link.realPath = installedCli.path;
    fileIO.onFirstRead = (path) => {
      if (windowsPathsEqual(path, installedCli.path)) link.realPath = "C:\\Changed\\codex.exe";
    };
    const verified = await verifyTrustedExecutionBinaries({ ...options, cli: { path: link.path } });
    expect(verified.cliPath).toBe(installedCli.path);
    expect(verified.measurements.cli.sha256).toBe(digest(installedCli.content));
    expect(fileIO.openedPaths).toEqual([processHostPath, installedCli.path, gitPath]);
    expect(fileIO.lstatPaths).not.toContain(link.path);
  });

  it.each(["\\\\server\\share\\codex.exe", "C:\\Installed\\codex.cmd", "codex.exe"])(
    "rejects a CLI link whose resolved target is not a local absolute executable: %s",
    async (target) => {
      const { fileIO, options } = createFixture();
      fileIO.node(cliPath).realPath = target;
      await expect(
        verifyTrustedExecutionBinaries({ ...options, cli: { path: cliPath } }),
      ).rejects.toMatchObject({ code: "BINARY_PATH_UNSAFE" });
      expect(fileIO.openedPaths).toEqual([processHostPath]);
    },
  );

  it("rejects an empty or stale CLI digest pin when one is explicitly supplied", async () => {
    for (const expectedSha256 of ["", "0".repeat(64)]) {
      const { options } = createFixture();
      await expect(
        verifyTrustedExecutionBinaries({ ...options, cli: { path: cliPath, expectedSha256 } }),
      ).rejects.toMatchObject({ code: "BINARY_DIGEST_MISMATCH" });
    }
  });

  it.each(["processHost", "git"] as const)("still requires a digest pin for %s", async (role) => {
    const { fileIO, options } = createFixture();
    await expect(
      verifyTrustedExecutionBinaries({
        ...options,
        [role]: { ...options[role], expectedSha256: undefined as unknown as string },
      }),
    ).rejects.toMatchObject({ code: "BINARY_DIGEST_MISMATCH" });
    expect(fileIO.openedPaths).toEqual([]);
  });

  it("verifies only ProcessHost and Git for validation-only startup", async () => {
    const { fileIO, options } = createFixture();
    const { cli: _cli, ...validation } = options;
    const verified = await verifyTrustedExecutionBinaries(validation);
    expect(verified).not.toHaveProperty("cliPath");
    expect(verified.measurements).not.toHaveProperty("cli");
    expect(fileIO.openedPaths).toEqual([processHostPath, gitPath]);
    expect(fileIO.closedPaths).toEqual([processHostPath, gitPath]);
    expect(fileIO.lstatPaths).not.toContain(cliPath);
    expect(Object.isFrozen(verified.measurements)).toBe(true);
  });
  it("verifies three stable files with bounded streaming reads", async () => {
    const { fileIO, options } = createFixture();
    const verifiedAtISO = "2026-09-08T12:34:56.789Z";
    let clockCalls = 0;

    const verified = await verifyTrustedExecutionBinaries({
      ...options,
      now: () => {
        clockCalls++;
        expect(fileIO.closedPaths).toEqual([processHostPath, cliPath, gitPath]);
        expect(
          fileIO.lstatPaths.filter((path) => windowsPathsEqual(path, trustedRoot)),
        ).toHaveLength(2);
        return new Date(verifiedAtISO);
      },
    });

    expect(verified).toEqual({
      trustedExecutableRoot: trustedRoot,
      processHostPath,
      cliPath,
      gitPath,
      measurements: {
        processHost: {
          sha256: digest(fileIO.node(processHostPath).content),
          sizeBytes: 130 * 1024,
          fileIdentity: { dev: "1", ino: "10", mtimeMs: "1000", ctimeMs: "1000" },
          verifiedAtISO,
        },
        cli: {
          sha256: digest(fileIO.node(cliPath).content),
          sizeBytes: Buffer.byteLength("trusted cli executable"),
          fileIdentity: { dev: "1", ino: "11", mtimeMs: "1000", ctimeMs: "1000" },
          verifiedAtISO,
        },
        git: {
          sha256: digest(fileIO.node(gitPath).content),
          sizeBytes: Buffer.byteLength("trusted git executable"),
          fileIdentity: { dev: "1", ino: "12", mtimeMs: "1000", ctimeMs: "1000" },
          verifiedAtISO,
        },
      },
    });
    expect(clockCalls).toBe(1);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.measurements)).toBe(true);
    for (const measurement of Object.values(verified.measurements)) {
      expect(Object.isFrozen(measurement)).toBe(true);
      expect(Object.isFrozen(measurement.fileIdentity)).toBe(true);
    }
    expect(Reflect.set(verified.measurements.cli, "sha256", "changed")).toBe(false);
    expect(Reflect.set(verified.measurements.cli.fileIdentity, "ino", "changed")).toBe(false);
    expect(Reflect.set(verified.measurements, "cli", null)).toBe(false);
    expect(fileIO.openedPaths).toEqual([processHostPath, cliPath, gitPath]);
    for (const path of [processHostPath, cliPath, gitPath])
      expect(fileIO.readBytes.get(pathKey(path))).toBe(fileIO.node(path).content.byteLength);
    expect(fileIO.maximumRequestedReadBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("retains large bigint identities and fractional metadata as immutable JSON strings", async () => {
    const { fileIO, options } = createFixture();
    const processHost = fileIO.node(processHostPath);
    processHost.statOverrides = {
      dev: 9_007_199_254_740_993n,
      ino: 18_446_744_073_709_551_615n,
      size: BigInt(processHost.content.byteLength),
      mtimeMs: 17_000_000_000_000_001n,
      ctimeMs: 17_000_000_000_000_002n,
    };
    fileIO.node(cliPath).statOverrides = { mtimeMs: 1_700_000_000_000.125, ctimeMs: -0 };

    const verified = await verifyTrustedExecutionBinaries(options);
    const serialized = JSON.stringify(verified);
    expect(JSON.parse(serialized)).toEqual(verified);
    expect(verified.measurements.processHost.fileIdentity).toEqual({
      dev: "9007199254740993",
      ino: "18446744073709551615",
      mtimeMs: "17000000000000001",
      ctimeMs: "17000000000000002",
    });
    expect(verified.measurements.processHost.sizeBytes).toBe(processHost.content.byteLength);
    expect(verified.measurements.cli.fileIdentity).toMatchObject({
      mtimeMs: "1700000000000.125",
      ctimeMs: "-0",
    });
    processHost.statOverrides = { ...processHost.statOverrides, ino: 1n };
    fileIO.node(cliPath).content.fill(0);
    expect(JSON.stringify(verified)).toBe(serialized);
    for (const measurement of Object.values(verified.measurements))
      expect(new Date(measurement.verifiedAtISO).toISOString()).toBe(measurement.verifiedAtISO);
  });

  it.each([
    { label: "invalid date", now: () => new Date(Number.NaN) },
    {
      label: "throwing clock",
      now: () => {
        throw new Error("synthetic-private-clock-error");
      },
    },
    { label: "non-Date result", now: () => "synthetic-private-clock-error" as unknown as Date },
  ])(
    "rejects an $label without returning measurements or exposing clock details",
    async ({ now }) => {
      const { fileIO, options } = createFixture();
      await expect(verifyTrustedExecutionBinaries({ ...options, now })).rejects.toMatchObject({
        code: "INVALID_VERIFICATION_TIME",
        message: "Trusted binary verification time could not be captured.",
      });
      expect(fileIO.closedPaths).toEqual([processHostPath, cliPath, gitPath]);
    },
  );

  it("does not timestamp a batch whose final trusted root identity check fails", async () => {
    const { fileIO, options } = createFixture();
    fileIO.onFirstRead = (path) => {
      if (windowsPathsEqual(path, gitPath)) fileIO.node(trustedRoot).ino++;
    };
    let clockCalled = false;
    await expect(
      verifyTrustedExecutionBinaries({
        ...options,
        now: () => {
          clockCalled = true;
          return new Date("2026-09-08T12:34:56.789Z");
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRUSTED_ROOT" });
    expect(clockCalled).toBe(false);
    expect(fileIO.closedPaths).toEqual([processHostPath, cliPath, gitPath]);
  });

  it("rejects digest mismatch and malformed or non-lowercase digests", async () => {
    const mismatch = createFixture();
    await expect(
      verifyTrustedExecutionBinaries({
        ...mismatch.options,
        cli: { ...mismatch.options.cli, expectedSha256: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "BINARY_DIGEST_MISMATCH" });

    for (const expectedSha256 of ["bad", "A".repeat(64)]) {
      const malformed = createFixture();
      await expect(
        verifyTrustedExecutionBinaries({
          ...malformed.options,
          git: { ...malformed.options.git, expectedSha256 },
        }),
      ).rejects.toMatchObject({ code: "BINARY_DIGEST_MISMATCH" });
    }
  });

  it("rejects linked or reparse roots and files", async () => {
    const linkedRoot = createFixture();
    linkedRoot.fileIO.node(trustedRoot).symbolicLink = true;
    await expect(verifyTrustedExecutionBinaries(linkedRoot.options)).rejects.toMatchObject({
      code: "INVALID_TRUSTED_ROOT",
    });

    const reparseFile = createFixture();
    reparseFile.fileIO.node(cliPath).reparsePoint = true;
    await expect(verifyTrustedExecutionBinaries(reparseFile.options)).rejects.toMatchObject({
      code: "BINARY_NOT_REGULAR",
    });
  });

  it("rejects unsafe roots, lexical escapes, realpath escapes, and reserved devices", async () => {
    const filesystemRoot = createFixture();
    await expect(
      verifyTrustedExecutionBinaries({ ...filesystemRoot.options, trustedExecutableRoot: "C:\\" }),
    ).rejects.toMatchObject({ code: "INVALID_TRUSTED_ROOT" });

    const malformedUnicodeRoot = createFixture();
    await expect(
      verifyTrustedExecutionBinaries({
        ...malformedUnicodeRoot.options,
        trustedExecutableRoot: `${trustedRoot}\ud800`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRUSTED_ROOT" });

    const lexicalEscape = createFixture();
    await expect(
      verifyTrustedExecutionBinaries({
        ...lexicalEscape.options,
        git: { ...lexicalEscape.options.git, path: "C:\\Outside\\git.exe" },
      }),
    ).rejects.toMatchObject({ code: "BINARY_PATH_UNSAFE" });

    const realpathEscape = createFixture();
    realpathEscape.fileIO.node(gitPath).realPath = "C:\\Outside\\git.exe";
    await expect(verifyTrustedExecutionBinaries(realpathEscape.options)).rejects.toMatchObject({
      code: "BINARY_PATH_UNSAFE",
    });

    const reserved = createFixture();
    await expect(
      verifyTrustedExecutionBinaries({
        ...reserved.options,
        git: { ...reserved.options.git, path: `${trustedRoot}\\NUL.exe` },
      }),
    ).rejects.toMatchObject({ code: "BINARY_PATH_UNSAFE" });
  });

  it("detects a different object returned by open", async () => {
    const { fileIO, options } = createFixture();
    fileIO.openOverrides.set(
      pathKey(cliPath),
      new FakeNode({
        path: cliPath,
        kind: "file",
        content: fileIO.node(cliPath).content,
        dev: 1,
        ino: 999,
      }),
    );

    await expect(
      verifyTrustedExecutionBinaries({ ...options, cli: { path: cliPath } }),
    ).rejects.toMatchObject({
      code: "BINARY_IDENTITY_CHANGED",
    });
  });

  it("detects path replacement while hashing", async () => {
    const { fileIO, options } = createFixture();
    fileIO.onFirstRead = (path, node) => {
      if (!windowsPathsEqual(path, cliPath)) return;
      fileIO.replace(
        cliPath,
        new FakeNode({
          path: cliPath,
          kind: "file",
          content: node.content,
          dev: node.dev,
          ino: node.ino + 100,
        }),
      );
    };

    await expect(verifyTrustedExecutionBinaries(options)).rejects.toMatchObject({
      code: "BINARY_IDENTITY_CHANGED",
    });
  });

  it("detects size and timestamp changes while hashing", async () => {
    for (const mutation of ["size", "mtime", "ctime"] as const) {
      const { fileIO, options } = createFixture();
      fileIO.onFirstRead = (path, node) => {
        if (!windowsPathsEqual(path, gitPath)) return;
        if (mutation === "size") {
          node.content = Buffer.concat([node.content, Buffer.from("changed")]);
          node.size = node.content.byteLength;
        } else if (mutation === "mtime") {
          node.mtimeMs += 1;
        } else {
          node.ctimeMs += 1;
        }
      };

      await expect(verifyTrustedExecutionBinaries(options)).rejects.toMatchObject({
        code: "BINARY_IDENTITY_CHANGED",
      });
    }
  });

  it("rejects empty and oversized files without reading their contents", async () => {
    const empty = createFixture();
    empty.fileIO.node(gitPath).content = Buffer.alloc(0);
    empty.fileIO.node(gitPath).size = 0;
    await expect(verifyTrustedExecutionBinaries(empty.options)).rejects.toMatchObject({
      code: "BINARY_NOT_REGULAR",
    });

    const oversized = createFixture();
    oversized.fileIO.node(processHostPath).size = 1024 * 1024 * 1024 + 1;
    await expect(verifyTrustedExecutionBinaries(oversized.options)).rejects.toMatchObject({
      code: "BINARY_NOT_REGULAR",
    });
    expect(oversized.fileIO.maximumRequestedReadBytes).toBe(0);
  });

  it("rejects duplicate configured paths and inside-root realpath aliases", async () => {
    const configuredDuplicate = createFixture();
    await expect(
      verifyTrustedExecutionBinaries({
        ...configuredDuplicate.options,
        git: { ...configuredDuplicate.options.git, path: cliPath.toUpperCase() },
      }),
    ).rejects.toMatchObject({ code: "BINARY_PATH_UNSAFE" });

    const resolvedDuplicate = createFixture();
    const cli = resolvedDuplicate.fileIO.node(cliPath);
    const aliasPath = `${trustedRoot}\\cli-alias.exe`;
    const alias = resolvedDuplicate.fileIO.add(
      new FakeNode({
        path: aliasPath,
        kind: "file",
        content: cli.content,
        dev: cli.dev,
        ino: cli.ino,
      }),
    );
    alias.realPath = cliPath;
    await expect(
      verifyTrustedExecutionBinaries({
        ...resolvedDuplicate.options,
        git: { path: aliasPath, expectedSha256: digest(alias.content) },
      }),
    ).rejects.toMatchObject({ code: "BINARY_PATH_UNSAFE" });
  });

  it("rejects distinct paths that identify the same hardlink object", async () => {
    const hardlink = createFixture();
    const cli = hardlink.fileIO.node(cliPath);
    const git = hardlink.fileIO.node(gitPath);
    git.dev = cli.dev;
    git.ino = cli.ino;
    git.content = cli.content;
    git.size = cli.size;
    git.mtimeMs = cli.mtimeMs;
    git.ctimeMs = cli.ctimeMs;

    await expect(
      verifyTrustedExecutionBinaries({
        ...hardlink.options,
        git: { ...hardlink.options.git, expectedSha256: digest(git.content) },
      }),
    ).rejects.toMatchObject({ code: "BINARY_PATH_UNSAFE" });
  });

  it("uses stable error classes without exposing binary content", async () => {
    const { fileIO, options } = createFixture();
    const secretContent = "binary-secret-content";
    fileIO.node(gitPath).content = Buffer.from(secretContent);
    fileIO.node(gitPath).size = Buffer.byteLength(secretContent);

    try {
      await verifyTrustedExecutionBinaries(options);
      throw new Error("expected verification failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TrustedBinaryVerificationError);
      expect((error as TrustedBinaryVerificationError).message).not.toContain(secretContent);
    }
  });
});

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function pathKey(path: string): string {
  return win32.normalize(path).toLowerCase();
}

function windowsPathsEqual(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}
