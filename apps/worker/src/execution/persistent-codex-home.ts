import { lstat as nodeLstat, realpath as nodeRealpath } from "node:fs/promises";
import { win32 } from "node:path";

export interface CodexHomeDirectoryStat {
  readonly dev: bigint;
  readonly ino: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface CodexHomeDirectoryFileSystem {
  lstat(path: string): Promise<CodexHomeDirectoryStat>;
  realpath(path: string): Promise<string>;
}

export interface VerifyPersistentCodexHomeOptions {
  readonly profileDirectory: string;
  readonly workspaceRootDirectory: string;
  readonly tempDirectory: string;
  readonly gitSharedRootDirectory: string;
  readonly gitWorkingDirectory: string;
  readonly trustedExecutableRoot: string;
  readonly fileSystem?: CodexHomeDirectoryFileSystem;
}

interface DirectoryIdentity {
  readonly name: string;
  readonly path: string;
  readonly canonicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

const defaultFileSystem: CodexHomeDirectoryFileSystem = {
  lstat: async (path) => nodeLstat(path, { bigint: true }),
  realpath: async (path) => nodeRealpath(path),
};

// Deployment must keep runtime directory topology stable after this read-only startup check.
export async function verifyPersistentCodexHome(
  options: VerifyPersistentCodexHomeOptions,
): Promise<string> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const directories = (
    [
      ["profileDirectory", options.profileDirectory],
      ["workspaceRootDirectory", options.workspaceRootDirectory],
      ["tempDirectory", options.tempDirectory],
      ["gitSharedRootDirectory", options.gitSharedRootDirectory],
      ["gitWorkingDirectory", options.gitWorkingDirectory],
      ["trustedExecutableRoot", options.trustedExecutableRoot],
    ] as const
  ).map(([name, path]) => ({ name, path: normalizeDirectory(path) }));

  const identities: DirectoryIdentity[] = [];
  for (const directory of directories) {
    identities.push(await readIdentity(fileSystem, directory.name, directory.path));
  }
  const profile = identities[0];
  if (profile === undefined) throw new Error("The persistent Codex home is missing.");
  for (const other of identities.slice(1)) {
    if (
      pathsOverlap(profile.canonicalPath, other.canonicalPath) ||
      (profile.dev === other.dev && profile.ino === other.ino)
    ) {
      throw new Error(`The persistent Codex home overlaps ${other.name}.`);
    }
  }

  for (const identity of identities) {
    const current = await readIdentity(fileSystem, identity.name, identity.path);
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      pathKey(current.canonicalPath) !== pathKey(identity.canonicalPath)
    ) {
      throw new Error(`${identity.name} changed identity during Codex home verification.`);
    }
  }
  return profile.canonicalPath;
}

async function readIdentity(
  fileSystem: CodexHomeDirectoryFileSystem,
  name: string,
  path: string,
): Promise<DirectoryIdentity> {
  const stat = await fileSystem.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.isReparsePoint?.() === true) {
    throw new Error(`${name} must be a directory without a link or reparse point.`);
  }
  const canonicalPath = normalizeDirectory(await fileSystem.realpath(path));
  if (pathKey(path) !== pathKey(canonicalPath)) {
    throw new Error(`${name} must resolve to its configured path without aliases.`);
  }
  return { name, path, canonicalPath, dev: stat.dev, ino: stat.ino };
}

function normalizeDirectory(path: string): string {
  if (
    typeof path !== "string" ||
    path.length > 32_767 ||
    !/^[A-Za-z]:[\\/]/u.test(path) ||
    path.slice(2).includes(":")
  ) {
    throw new TypeError("Codex runtime directories must be absolute local Windows paths.");
  }
  for (const component of path.slice(3).split(/[\\/]/u)) {
    if (
      component === "." ||
      component === ".." ||
      component.endsWith(".") ||
      component.endsWith(" ") ||
      /[<>:"|?*]/u.test(component) ||
      [...component].some((character) => character.charCodeAt(0) <= 0x1f)
    ) {
      throw new TypeError("A Codex runtime directory contains an unsafe Windows path component.");
    }
  }
  const normalized = win32.normalize(path.replaceAll("/", "\\"));
  if (normalized === win32.parse(normalized).root) {
    throw new TypeError("Codex runtime directories must not be filesystem roots.");
  }
  return normalized.replace(/[\\]+$/u, "");
}

function pathsOverlap(first: string, second: string): boolean {
  const left = pathKey(first);
  const right = pathKey(second);
  return left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`);
}

function pathKey(path: string): string {
  return path.toLowerCase();
}
