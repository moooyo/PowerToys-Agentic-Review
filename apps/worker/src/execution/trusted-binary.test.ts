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
const codexPath = `${trustedRoot}\\codex.exe`;
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
    return { bytesRead: available };
  }

  public async close(): Promise<void> {
    await Promise.resolve();
  }
}

class FakeFileIO implements TrustedBinaryFileIO {
  readonly #nodes = new Map<string, FakeNode>();
  public readonly openOverrides = new Map<string, FakeNode>();
  public onFirstRead: ((path: string, node: FakeNode) => void) | undefined;
  public maximumRequestedReadBytes = 0;

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
    return this.node(path).snapshot();
  }

  public async stat(path: string): Promise<TrustedBinaryFileStat> {
    return this.node(path).snapshot();
  }

  public async realpath(path: string): Promise<string> {
    return this.node(path).realPath;
  }

  public async open(path: string): Promise<TrustedBinaryFileHandle> {
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
  const codex = fileIO.add(
    new FakeNode({
      path: codexPath,
      kind: "file",
      content: Buffer.from("trusted codex executable"),
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
      codex: { path: codexPath, expectedSha256: digest(codex.content) },
      git: { path: gitPath, expectedSha256: digest(git.content) },
      fileIO,
    },
  };
}

describe("verifyTrustedExecutionBinaries", () => {
  it("verifies three stable files with bounded streaming reads", async () => {
    const { fileIO, options } = createFixture();

    const verified = await verifyTrustedExecutionBinaries(options);

    expect(verified).toEqual({
      trustedExecutableRoot: trustedRoot,
      processHostPath,
      codexPath,
      gitPath,
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(fileIO.maximumRequestedReadBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("rejects digest mismatch and malformed or non-lowercase digests", async () => {
    const mismatch = createFixture();
    await expect(
      verifyTrustedExecutionBinaries({
        ...mismatch.options,
        codex: { ...mismatch.options.codex, expectedSha256: "0".repeat(64) },
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
    reparseFile.fileIO.node(codexPath).reparsePoint = true;
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
      pathKey(codexPath),
      new FakeNode({
        path: codexPath,
        kind: "file",
        content: fileIO.node(codexPath).content,
        dev: 1,
        ino: 999,
      }),
    );

    await expect(verifyTrustedExecutionBinaries(options)).rejects.toMatchObject({
      code: "BINARY_IDENTITY_CHANGED",
    });
  });

  it("detects path replacement while hashing", async () => {
    const { fileIO, options } = createFixture();
    fileIO.onFirstRead = (path, node) => {
      if (!windowsPathsEqual(path, codexPath)) return;
      fileIO.replace(
        codexPath,
        new FakeNode({
          path: codexPath,
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
        git: { ...configuredDuplicate.options.git, path: codexPath.toUpperCase() },
      }),
    ).rejects.toMatchObject({ code: "BINARY_PATH_UNSAFE" });

    const resolvedDuplicate = createFixture();
    const codex = resolvedDuplicate.fileIO.node(codexPath);
    const aliasPath = `${trustedRoot}\\codex-alias.exe`;
    const alias = resolvedDuplicate.fileIO.add(
      new FakeNode({
        path: aliasPath,
        kind: "file",
        content: codex.content,
        dev: codex.dev,
        ino: codex.ino,
      }),
    );
    alias.realPath = codexPath;
    await expect(
      verifyTrustedExecutionBinaries({
        ...resolvedDuplicate.options,
        git: { path: aliasPath, expectedSha256: digest(alias.content) },
      }),
    ).rejects.toMatchObject({ code: "BINARY_PATH_UNSAFE" });
  });

  it("rejects distinct paths that identify the same hardlink object", async () => {
    const hardlink = createFixture();
    const codex = hardlink.fileIO.node(codexPath);
    const git = hardlink.fileIO.node(gitPath);
    git.dev = codex.dev;
    git.ino = codex.ino;
    git.content = codex.content;
    git.size = codex.size;
    git.mtimeMs = codex.mtimeMs;
    git.ctimeMs = codex.ctimeMs;

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
