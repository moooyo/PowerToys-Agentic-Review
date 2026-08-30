import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  serializeTrustedInstallationManifest,
  type TrustedInstallationDirectoryHandle,
  type TrustedInstallationFileHandle,
  type TrustedInstallationFileIO,
  type TrustedInstallationFileRole,
  type TrustedInstallationFileStat,
  type TrustedInstallationManifest,
  type TrustedInstallationSecurityBoundary,
  TrustedInstallationVerificationError,
  type VerifyTrustedInstallationOptions,
  verifyTrustedInstallation,
} from "./trusted-installation-manifest.js";

const installationRoot = "C:\\Program Files\\AgenticReview";
const manifestPath = `${installationRoot}\\trusted-installation.manifest.json`;

type FakeNodeKind = "directory" | "file";

class FakeNode {
  public readonly path: string;
  public readonly kind: FakeNodeKind;
  public realPath: string;
  public content: Buffer;
  public dev: bigint;
  public ino: bigint;
  public nlink = 1n;
  public size: bigint;
  public mtimeNs = 1_000_000_000n;
  public ctimeNs = 1_000_000_000n;
  public symbolicLink = false;
  public reparsePoint = false;

  public constructor(options: {
    readonly path: string;
    readonly kind: FakeNodeKind;
    readonly ino: bigint;
    readonly content?: Buffer;
  }) {
    this.path = options.path;
    this.kind = options.kind;
    this.realPath = options.path;
    this.content = options.content ?? Buffer.alloc(0);
    this.dev = 1n;
    this.ino = options.ino;
    this.size = BigInt(this.content.byteLength);
  }

  public snapshot(): TrustedInstallationFileStat {
    const directory = this.kind === "directory";
    const file = this.kind === "file";
    const symbolicLink = this.symbolicLink;
    const reparsePoint = this.reparsePoint;
    return {
      dev: this.dev,
      ino: this.ino,
      nlink: this.nlink,
      size: this.size,
      mtimeNs: this.mtimeNs,
      ctimeNs: this.ctimeNs,
      isDirectory: () => directory,
      isFile: () => file,
      isSymbolicLink: () => symbolicLink,
      isReparsePoint: () => reparsePoint,
    };
  }
}

class FakeFileHandle implements TrustedInstallationFileHandle {
  #firstRead = true;

  public constructor(
    private readonly fileIO: FakeFileIO,
    private readonly openedPath: string,
    private readonly node: FakeNode,
  ) {}

  public async stat(): Promise<TrustedInstallationFileStat> {
    return this.node.snapshot();
  }

  public async finalPath(): Promise<string> {
    return this.node.realPath;
  }

  public async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }> {
    this.fileIO.maximumRequestedReadBytes = Math.max(this.fileIO.maximumRequestedReadBytes, length);
    if (this.#firstRead) {
      this.#firstRead = false;
      this.fileIO.onFirstRead?.(this.openedPath, this.node);
    }
    const available = Math.max(0, Math.min(length, this.node.content.byteLength - position));
    this.node.content.copy(buffer, offset, position, position + available);
    return { bytesRead: available };
  }

  public async close(): Promise<void> {
    await Promise.resolve();
  }
}

class FakeDirectoryHandle implements TrustedInstallationDirectoryHandle {
  #position = 0;

  public constructor(
    private readonly node: FakeNode,
    private readonly names: readonly string[],
  ) {}

  public async stat(): Promise<TrustedInstallationFileStat> {
    return this.node.snapshot();
  }

  public async finalPath(): Promise<string> {
    return this.node.realPath;
  }

  public async read(): Promise<{ readonly name: string } | null> {
    const name = this.names[this.#position];
    this.#position += 1;
    return name === undefined ? null : { name };
  }

  public async close(): Promise<void> {
    await Promise.resolve();
  }
}

class FakeFileIO implements TrustedInstallationFileIO {
  readonly #nodes = new Map<string, FakeNode>();
  public readonly openOverrides = new Map<string, FakeNode>();
  public readonly directoryOpenOverrides = new Map<string, FakeNode>();
  public securityBoundaryResult: unknown = secureBoundary();
  public onFirstRead: ((path: string, node: FakeNode) => void) | undefined;
  public onOpenDirectory: ((path: string) => void) | undefined;
  public maximumRequestedReadBytes = 0;

  public async inspectSecurityBoundary(
    _path: string,
  ): Promise<TrustedInstallationSecurityBoundary> {
    return this.securityBoundaryResult as TrustedInstallationSecurityBoundary;
  }

  public add(node: FakeNode): FakeNode {
    this.#nodes.set(pathKey(node.path), node);
    return node;
  }

  public remove(path: string): void {
    this.#nodes.delete(pathKey(path));
  }

  public node(path: string): FakeNode {
    const node = this.#nodes.get(pathKey(path));
    if (node === undefined) throw new Error(`Fake path not found: ${path}`);
    return node;
  }

  public async lstat(path: string): Promise<TrustedInstallationFileStat> {
    return this.node(path).snapshot();
  }

  public async stat(path: string): Promise<TrustedInstallationFileStat> {
    return this.node(path).snapshot();
  }

  public async realpath(path: string): Promise<string> {
    return this.node(path).realPath;
  }

  public async open(path: string): Promise<TrustedInstallationFileHandle> {
    return new FakeFileHandle(this, path, this.openOverrides.get(pathKey(path)) ?? this.node(path));
  }

  public async openDirectory(path: string): Promise<TrustedInstallationDirectoryHandle> {
    const directory = this.directoryOpenOverrides.get(pathKey(path)) ?? this.node(path);
    if (directory.kind !== "directory") throw new Error("Not a directory");
    this.onOpenDirectory?.(path);
    const names = [...this.#nodes.values()]
      .filter((node) => pathKey(win32.dirname(node.path)) === pathKey(path))
      .map((node) => win32.basename(node.path))
      .sort((left, right) => left.localeCompare(right, "en"));
    return new FakeDirectoryHandle(directory, names);
  }
}

interface FixtureFile {
  readonly path: string;
  readonly role: TrustedInstallationFileRole;
  readonly content: Buffer;
}

interface Fixture {
  readonly fileIO: FakeFileIO;
  readonly files: readonly FixtureFile[];
  readonly manifest: TrustedInstallationManifest;
  readonly options: VerifyTrustedInstallationOptions;
}

function createFixture(): Fixture {
  const files: FixtureFile[] = [
    file("AgenticReview.Worker.exe", "service-wrapper", "winsw"),
    file("app\\dist\\worker.mjs", "worker-bundle", "worker bundle"),
    file("codex\\codex.exe", "codex-cli", "codex executable"),
    file("codex\\runtime\\codex-runtime.dll", "native-library", "codex runtime"),
    file("git\\cmd\\git.exe", "git-cli", "git executable"),
    file("git\\mingw64\\bin\\git-remote-https.exe", "git-helper", "git helper"),
    file("git\\mingw64\\bin\\libcurl.dll", "native-library", "curl library"),
    file("git\\mingw64\\ssl\\cert.pem", "ca-bundle", "certificate bundle"),
    file("native\\AgenticReview.ProcessHost.exe", "process-host", "process host"),
    file("runtime\\node.exe", "node-runtime", "node executable"),
  ];
  const manifest: TrustedInstallationManifest = {
    files: files.map((item) => ({
      path: item.path,
      role: item.role,
      sha256: digest(item.content),
      size: item.content.byteLength.toString(),
    })),
    publisherPolicy: "authenticode-required-at-install",
    releaseId: "2026.08.31-test.1",
    schemaVersion: 1,
  };
  const manifestBytes = Buffer.from(serializeTrustedInstallationManifest(manifest), "utf8");
  const fileIO = new FakeFileIO();
  let ino = 1n;
  fileIO.add(new FakeNode({ path: installationRoot, kind: "directory", ino }));
  for (const directory of collectDirectories(files.map((item) => item.path))) {
    ino += 1n;
    fileIO.add(
      new FakeNode({ path: win32.join(installationRoot, directory), kind: "directory", ino }),
    );
  }
  for (const item of files) {
    ino += 1n;
    fileIO.add(
      new FakeNode({
        path: win32.join(installationRoot, item.path),
        kind: "file",
        ino,
        content: item.content,
      }),
    );
  }
  ino += 1n;
  fileIO.add(new FakeNode({ path: manifestPath, kind: "file", ino, content: manifestBytes }));
  return {
    fileIO,
    files,
    manifest,
    options: {
      installationRoot,
      manifestPath,
      expectedManifestSha256: digest(manifestBytes),
      fileIO,
    },
  };
}

describe("verifyTrustedInstallation", () => {
  it("verifies a closed installation tree with bounded streaming reads", async () => {
    const fixture = createFixture();

    const verified = await verifyTrustedInstallation(fixture.options);

    expect(verified.installationRoot).toBe(installationRoot);
    expect(verified.releaseId).toBe("2026.08.31-test.1");
    expect(verified.files).toHaveLength(fixture.files.length);
    expect(verified.files.find((entry) => entry.role === "git-cli")).toMatchObject({
      path: "git\\cmd\\git.exe",
      size: BigInt(Buffer.byteLength("git executable")),
    });
    expect(verified.securityBoundary).toEqual(secureBoundary());
    expect(verified.publisherVerification).toEqual({
      authenticodeRequired: true,
      performedByThisVerifier: false,
      responsibility: "installer-and-release-pipeline",
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.files)).toBe(true);
    expect(fixture.fileIO.maximumRequestedReadBytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("checks the pinned manifest digest before parsing its contents", async () => {
    const fixture = createFixture();
    setFileContent(fixture.fileIO.node(manifestPath), Buffer.from("not-json", "utf8"));

    await expect(verifyTrustedInstallation(fixture.options)).rejects.toMatchObject({
      code: "MANIFEST_DIGEST_MISMATCH",
    });

    await expect(
      verifyTrustedInstallation({ ...fixture.options, expectedManifestSha256: "A".repeat(64) }),
    ).rejects.toMatchObject({ code: "MANIFEST_DIGEST_MISMATCH" });
  });

  it("fails closed without a complete native Windows security adapter", async () => {
    const missingAdapter = createFixture();
    await expect(
      verifyTrustedInstallation({
        installationRoot,
        manifestPath,
        expectedManifestSha256: missingAdapter.options.expectedManifestSha256,
      } as VerifyTrustedInstallationOptions),
    ).rejects.toMatchObject({ code: "INSTALLATION_SECURITY_BOUNDARY_INVALID" });

    const incompleteBoundary = createFixture();
    incompleteBoundary.fileIO.securityBoundaryResult = {
      ...secureBoundary(),
      installationTreeDaclWriteProtected: false,
    };
    await expect(verifyTrustedInstallation(incompleteBoundary.options)).rejects.toMatchObject({
      code: "INSTALLATION_SECURITY_BOUNDARY_INVALID",
    });

    const impreciseTimestamps = createFixture();
    impreciseTimestamps.fileIO.node(installationRoot).mtimeNs = 1_000 as unknown as bigint;
    await expect(verifyTrustedInstallation(impreciseTimestamps.options)).rejects.toMatchObject({
      code: "INSTALLATION_ROOT_INVALID",
    });
  });

  it("requires exact canonical UTF-8 JSON without BOM, whitespace, or unknown fields", async () => {
    const whitespace = createFixture();
    const canonical = serializeTrustedInstallationManifest(whitespace.manifest);
    const whitespaceOptions = replaceManifest(whitespace, Buffer.from(`${canonical}\n`, "utf8"));
    await expect(verifyTrustedInstallation(whitespaceOptions)).rejects.toMatchObject({
      code: "MANIFEST_NOT_CANONICAL",
    });

    const bom = createFixture();
    const bomOptions = replaceManifest(
      bom,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical, "utf8")]),
    );
    await expect(verifyTrustedInstallation(bomOptions)).rejects.toMatchObject({
      code: "MANIFEST_FORMAT_INVALID",
    });

    const unknown = createFixture();
    const unknownValue = { ...unknown.manifest, comment: "not allowed" };
    const unknownOptions = replaceManifest(
      unknown,
      Buffer.from(JSON.stringify(unknownValue), "utf8"),
    );
    await expect(verifyTrustedInstallation(unknownOptions)).rejects.toMatchObject({
      code: "MANIFEST_FORMAT_INVALID",
    });
  });

  it("rejects unsafe, duplicate, and non-canonical manifest paths", async () => {
    for (const unsafePath of [
      "git\\..\\codex.exe",
      "git\\NUL.exe",
      "git\\git.exe:payload",
      "\\\\server\\share\\git.exe",
      "git//git.exe",
      "git\\bad.\\git.exe",
      "git\\caf\u00e9.exe",
    ]) {
      const fixture = createFixture();
      const raw = cloneManifest(fixture.manifest);
      raw.files[0] = { ...requiredFile(raw.files[0]), path: unsafePath };
      await expect(
        verifyTrustedInstallation(replaceManifest(fixture, Buffer.from(JSON.stringify(raw)))),
      ).rejects.toMatchObject({ code: "INSTALLATION_FILE_UNSAFE" });
    }

    const duplicate = createFixture();
    const rawDuplicate = cloneManifest(duplicate.manifest);
    rawDuplicate.files[1] = {
      ...requiredFile(rawDuplicate.files[1]),
      path: requiredFile(rawDuplicate.files[0]).path.toUpperCase(),
    };
    await expect(
      verifyTrustedInstallation(
        replaceManifest(duplicate, Buffer.from(JSON.stringify(rawDuplicate))),
      ),
    ).rejects.toMatchObject({ code: "MANIFEST_FORMAT_INVALID" });
  });

  it("requires the complete singleton runtime role set and role-appropriate extensions", async () => {
    const missing = createFixture();
    const missingValue = cloneManifest(missing.manifest);
    missingValue.files = missingValue.files.filter((entry) => entry.role !== "process-host");
    await expect(
      verifyTrustedInstallation(
        replaceManifest(missing, Buffer.from(JSON.stringify(missingValue))),
      ),
    ).rejects.toMatchObject({ code: "MANIFEST_FORMAT_INVALID" });

    const wrongExtension = createFixture();
    const wrongValue = cloneManifest(wrongExtension.manifest);
    const nodeIndex = wrongValue.files.findIndex((entry) => entry.role === "node-runtime");
    wrongValue.files[nodeIndex] = {
      ...requiredFile(wrongValue.files[nodeIndex]),
      path: "runtime\\node.cmd",
    };
    await expect(
      verifyTrustedInstallation(
        replaceManifest(wrongExtension, Buffer.from(JSON.stringify(wrongValue))),
      ),
    ).rejects.toMatchObject({ code: "MANIFEST_FORMAT_INVALID" });
  });

  it("uses lowercase digests and exact decimal bigint sizes", async () => {
    const uppercase = createFixture();
    const uppercaseValue = cloneManifest(uppercase.manifest);
    uppercaseValue.files[0] = {
      ...requiredFile(uppercaseValue.files[0]),
      sha256: requiredFile(uppercaseValue.files[0]).sha256.toUpperCase(),
    };
    await expect(
      verifyTrustedInstallation(
        replaceManifest(uppercase, Buffer.from(JSON.stringify(uppercaseValue))),
      ),
    ).rejects.toMatchObject({ code: "MANIFEST_FORMAT_INVALID" });

    for (const invalidSize of [1, "01", "1.0", "9007199254740993.0"]) {
      const fixture = createFixture();
      const value = cloneManifest(fixture.manifest) as {
        files: Array<Record<string, unknown>>;
        publisherPolicy: string;
        releaseId: string;
        schemaVersion: number;
      };
      value.files[0] = { ...requiredFile(value.files[0]), size: invalidSize };
      await expect(
        verifyTrustedInstallation(replaceManifest(fixture, Buffer.from(JSON.stringify(value)))),
      ).rejects.toMatchObject({ code: "MANIFEST_FORMAT_INVALID" });
    }
  });

  it("detects manifest-declared size and digest mismatches", async () => {
    const sizeMismatch = createFixture();
    const sizeValue = cloneManifest(sizeMismatch.manifest);
    sizeValue.files[0] = { ...requiredFile(sizeValue.files[0]), size: "999" };
    const canonicalSize = serializeTrustedInstallationManifest(sizeValue);
    await expect(
      verifyTrustedInstallation(replaceManifest(sizeMismatch, Buffer.from(canonicalSize, "utf8"))),
    ).rejects.toMatchObject({ code: "INSTALLATION_FILE_SIZE_MISMATCH" });

    const digestMismatch = createFixture();
    const target = win32.join(installationRoot, digestMismatch.files[0]?.path ?? "missing");
    const targetNode = digestMismatch.fileIO.node(target);
    setFileContent(targetNode, Buffer.alloc(Number(targetNode.size), 0x61));
    await expect(verifyTrustedInstallation(digestMismatch.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_DIGEST_MISMATCH",
    });
  });

  it("rejects links, reparse points, realpath aliases, and open-time replacement", async () => {
    const reparse = createFixture();
    reparse.fileIO.node(win32.join(installationRoot, "git\\cmd\\git.exe")).reparsePoint = true;
    await expect(verifyTrustedInstallation(reparse.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_NOT_REGULAR",
    });

    const alias = createFixture();
    alias.fileIO.node(win32.join(installationRoot, "codex\\codex.exe")).realPath =
      "C:\\Outside\\codex.exe";
    await expect(verifyTrustedInstallation(alias.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_UNSAFE",
    });

    const replacement = createFixture();
    const path = win32.join(installationRoot, "runtime\\node.exe");
    const original = replacement.fileIO.node(path);
    replacement.fileIO.openOverrides.set(
      pathKey(path),
      new FakeNode({
        path,
        kind: "file",
        ino: 99_999n,
        content: original.content,
      }),
    );
    await expect(verifyTrustedInstallation(replacement.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_IDENTITY_CHANGED",
    });
  });

  it("detects a file changing while its contents are hashed", async () => {
    const fixture = createFixture();
    const target = win32.join(installationRoot, "git\\mingw64\\bin\\libcurl.dll");
    fixture.fileIO.onFirstRead = (path, node) => {
      if (pathKey(path) === pathKey(target)) node.mtimeNs += 1n;
    };

    await expect(verifyTrustedInstallation(fixture.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_IDENTITY_CHANGED",
    });
  });

  it("rechecks files after the complete directory traversal", async () => {
    const fixture = createFixture();
    const earlyFile = fixture.fileIO.node(win32.join(installationRoot, "AgenticReview.Worker.exe"));
    const lateDirectory = win32.join(installationRoot, "runtime");
    fixture.fileIO.onOpenDirectory = (path) => {
      if (pathKey(path) === pathKey(lateDirectory)) earlyFile.ctimeNs += 1n;
    };

    await expect(verifyTrustedInstallation(fixture.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_IDENTITY_CHANGED",
    });
  });

  it("rejects hardlink identity reuse across manifest and runtime files", async () => {
    const runtimeHardlink = createFixture();
    const codex = runtimeHardlink.fileIO.node(
      win32.join(installationRoot, "codex\\runtime\\codex-runtime.dll"),
    );
    const curl = runtimeHardlink.fileIO.node(
      win32.join(installationRoot, "git\\mingw64\\bin\\libcurl.dll"),
    );
    curl.dev = codex.dev;
    curl.ino = codex.ino;
    await expect(verifyTrustedInstallation(runtimeHardlink.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_UNSAFE",
    });

    const manifestHardlink = createFixture();
    const manifest = manifestHardlink.fileIO.node(manifestPath);
    const worker = manifestHardlink.fileIO.node(
      win32.join(installationRoot, "app\\dist\\worker.mjs"),
    );
    worker.dev = manifest.dev;
    worker.ino = manifest.ino;
    await expect(verifyTrustedInstallation(manifestHardlink.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_UNSAFE",
    });

    const outsideHardlink = createFixture();
    outsideHardlink.fileIO.node(win32.join(installationRoot, "git\\cmd\\git.exe")).nlink = 2n;
    await expect(verifyTrustedInstallation(outsideHardlink.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_UNSAFE",
    });
  });

  it("binds directory enumeration to a stable native directory handle", async () => {
    const fixture = createFixture();
    const directoryPath = win32.join(installationRoot, "git");
    fixture.fileIO.directoryOpenOverrides.set(
      pathKey(directoryPath),
      new FakeNode({ path: directoryPath, kind: "directory", ino: 999_999n }),
    );

    await expect(verifyTrustedInstallation(fixture.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_IDENTITY_CHANGED",
    });

    const aliasFixture = createFixture();
    const original = aliasFixture.fileIO.node(directoryPath);
    const alias = new FakeNode({
      path: directoryPath,
      kind: "directory",
      ino: original.ino,
    });
    alias.dev = original.dev;
    alias.nlink = original.nlink;
    alias.size = original.size;
    alias.mtimeNs = original.mtimeNs;
    alias.ctimeNs = original.ctimeNs;
    alias.realPath = "C:\\Outside\\git";
    aliasFixture.fileIO.directoryOpenOverrides.set(pathKey(directoryPath), alias);
    await expect(verifyTrustedInstallation(aliasFixture.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_IDENTITY_CHANGED",
    });
  });

  it("rejects every unexpected file or directory in the trusted root", async () => {
    const extraFile = createFixture();
    extraFile.fileIO.add(
      new FakeNode({
        path: win32.join(installationRoot, "surprise.exe"),
        kind: "file",
        ino: 90_001n,
        content: Buffer.from("unexpected"),
      }),
    );
    await expect(verifyTrustedInstallation(extraFile.options)).rejects.toMatchObject({
      code: "INSTALLATION_CONTENT_MISMATCH",
    });

    const extraDirectory = createFixture();
    extraDirectory.fileIO.add(
      new FakeNode({
        path: win32.join(installationRoot, "scratch"),
        kind: "directory",
        ino: 90_002n,
      }),
    );
    await expect(verifyTrustedInstallation(extraDirectory.options)).rejects.toMatchObject({
      code: "INSTALLATION_CONTENT_MISMATCH",
    });

    const reparseDirectory = createFixture();
    reparseDirectory.fileIO.node(win32.join(installationRoot, "git")).reparsePoint = true;
    await expect(verifyTrustedInstallation(reparseDirectory.options)).rejects.toMatchObject({
      code: "INSTALLATION_FILE_UNSAFE",
    });
  });

  it("does not accept legacy mutable-file exceptions", async () => {
    const fixture = createFixture();
    const serviceConfigPath = win32.join(installationRoot, "AgenticReview.Worker.xml");
    fixture.fileIO.add(
      new FakeNode({
        path: serviceConfigPath,
        kind: "file",
        ino: 90_003n,
        content: Buffer.from("<service />", "utf8"),
      }),
    );
    const legacyOptions = {
      ...fixture.options,
      allowedMutableFiles: ["AgenticReview.Worker.xml"],
    } as unknown as VerifyTrustedInstallationOptions;

    await expect(verifyTrustedInstallation(legacyOptions)).rejects.toMatchObject({
      code: "INSTALLATION_CONTENT_MISMATCH",
    });
  });

  it("rejects oversized manifest totals before opening installation files", async () => {
    const fixture = createFixture();
    const value = cloneManifest(fixture.manifest);
    for (let index = 0; index < 5; index += 1) {
      value.files[index] = {
        ...requiredFile(value.files[index]),
        size: (8n * 1024n * 1024n * 1024n).toString(),
      };
    }

    await expect(
      verifyTrustedInstallation(replaceManifest(fixture, Buffer.from(JSON.stringify(value)))),
    ).rejects.toMatchObject({ code: "MANIFEST_LIMIT_EXCEEDED" });
  });

  it("uses stable typed errors without exposing file contents", async () => {
    const fixture = createFixture();
    const secret = "private-runtime-content";
    const target = fixture.fileIO.node(win32.join(installationRoot, "runtime\\node.exe"));
    setFileContent(target, Buffer.from(secret));

    try {
      await verifyTrustedInstallation(fixture.options);
      throw new Error("expected verification failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TrustedInstallationVerificationError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

function file(path: string, role: TrustedInstallationFileRole, content: string): FixtureFile {
  return { path, role, content: Buffer.from(content, "utf8") };
}

function collectDirectories(relativePaths: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const relativePath of relativePaths) {
    let directory = win32.dirname(relativePath);
    while (directory !== ".") {
      directories.add(directory);
      directory = win32.dirname(directory);
    }
  }
  return [...directories].sort((left, right) => {
    const depthDifference = left.split("\\").length - right.split("\\").length;
    return depthDifference === 0 ? left.localeCompare(right, "en") : depthDifference;
  });
}

function replaceManifest(fixture: Fixture, content: Buffer): VerifyTrustedInstallationOptions {
  setFileContent(fixture.fileIO.node(manifestPath), content);
  return { ...fixture.options, expectedManifestSha256: digest(content) };
}

function setFileContent(node: FakeNode, content: Buffer): void {
  node.content = content;
  node.size = BigInt(content.byteLength);
}

type MutableManifest = {
  files: Array<{
    path: string;
    role: TrustedInstallationFileRole;
    sha256: string;
    size: string;
  }>;
  publisherPolicy: "authenticode-required-at-install";
  releaseId: string;
  schemaVersion: 1;
};

function cloneManifest(manifest: TrustedInstallationManifest): MutableManifest {
  return {
    files: manifest.files.map((entry) => ({ ...entry })),
    publisherPolicy: manifest.publisherPolicy,
    releaseId: manifest.releaseId,
    schemaVersion: manifest.schemaVersion,
  };
}

function requiredFile<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Test manifest file is missing");
  return value;
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function pathKey(path: string): string {
  return win32.normalize(path).toLowerCase();
}

function secureBoundary(): TrustedInstallationSecurityBoundary {
  return {
    adapterProtocolVersion: 1,
    implementation: "native-win32",
    filesystem: "NTFS",
    volume: "fixed-local",
    rootAndAncestorsReparseFree: true,
    genericReparsePointInspection: true,
    directoryHandleIdentity: true,
    installationTreeDaclWriteProtected: true,
    workerTokenWriteDenied: true,
    unprivilegedWriteDenied: true,
  };
}
