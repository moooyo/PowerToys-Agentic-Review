import { assertWindowsLocalAbsolutePath } from "../execution/process-host-protocol.js";

export interface PinnedGitSubmodule {
  readonly path: string;
  readonly repository: string;
  readonly commitSha: string;
}

export class SubmoduleManifestError extends Error {
  public readonly code = "SOURCE_SUBMODULE_UNSUPPORTED";

  public constructor() {
    super("The pinned Git submodule declarations are unsupported or unsafe.");
    this.name = "SubmoduleManifestError";
  }
}

interface SubmoduleDeclaration {
  path?: string;
  url?: string;
}

const maximumConfigurationBytes = 64 * 1_024;
const maximumConfigurationRecords = 256;

/** Parse only Git's NUL-delimited, non-including config output, never raw INI or commands. */
export function parsePinnedGitSubmodules(
  config: Uint8Array,
  gitlinks: readonly { path: string; commitSha: string }[],
): readonly PinnedGitSubmodule[] {
  if (
    config.byteLength > maximumConfigurationBytes ||
    gitlinks.length > maximumConfigurationRecords / 2
  )
    throw new SubmoduleManifestError();

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(config);
  } catch {
    throw new SubmoduleManifestError();
  }
  if (text !== "" && !text.endsWith("\0")) throw new SubmoduleManifestError();
  const records = text === "" ? [] : text.slice(0, -1).split("\0");
  if (records.length > maximumConfigurationRecords) throw new SubmoduleManifestError();

  const declarations = new Map<string, SubmoduleDeclaration>();
  for (const record of records) {
    const delimiter = record.indexOf("\n");
    const key = delimiter < 0 ? record : record.slice(0, delimiter);
    const value = delimiter < 0 ? undefined : record.slice(delimiter + 1);
    if (/[\r\n\0]/u.test(key)) throw new SubmoduleManifestError();
    // --no-includes prevents interpretation; rejecting all other sections also keeps this
    // format limited to declarative submodule metadata if a caller supplies incorrect output.
    const match = /^submodule\.([^\r\n\0]+)\.([a-z][a-z0-9-]*)$/u.exec(key);
    if (match === null) throw new SubmoduleManifestError();
    const name = match[1]!;
    const field = match[2]!;
    const declaration = declarations.get(name) ?? {};
    declarations.set(name, declaration);
    // Optional metadata, including valueless booleans and update commands, has no
    // execution semantics here. Required path and URL fields must carry a value.
    if (field !== "path" && field !== "url") continue;
    if (
      declaration[field] !== undefined ||
      value === undefined ||
      value === "" ||
      /[\r\n\0]/u.test(value)
    )
      throw new SubmoduleManifestError();
    declaration[field] = value;
  }

  const registered = new Map<
    string,
    { path: string; repository: string; components: readonly string[] }
  >();
  for (const declaration of declarations.values()) {
    if (declaration.path === undefined || declaration.url === undefined)
      throw new SubmoduleManifestError();
    const path = declaration.path;
    assertSafeRelativePath(path);
    const key = path.toLowerCase();
    const components = path.split("/");
    if (registered.has(key)) throw new SubmoduleManifestError();
    for (const [previousKey, previous] of registered) {
      if (key.startsWith(`${previousKey}/`) || previousKey.startsWith(`${key}/`))
        throw new SubmoduleManifestError();
      // Compare components instead of retaining every path prefix, which would use
      // quadratic memory for a declaration containing many short path components.
      const sharedLength = Math.min(components.length, previous.components.length);
      for (let index = 0; index < sharedLength; index += 1) {
        const component = components[index]!;
        const previousComponent = previous.components[index]!;
        if (component.toLowerCase() !== previousComponent.toLowerCase()) break;
        if (component !== previousComponent) throw new SubmoduleManifestError();
      }
    }
    registered.set(key, {
      path,
      repository: parseGitHubRepository(declaration.url),
      components,
    });
  }

  const seen = new Set<string>();
  return gitlinks.map(({ path, commitSha }) => {
    assertSafeRelativePath(path);
    if (commitSha.length !== 40 || !/^[a-f0-9]{40}$/u.test(commitSha))
      throw new SubmoduleManifestError();
    const key = path.toLowerCase();
    const declaration = registered.get(key);
    if (seen.has(key) || declaration === undefined || declaration.path !== path)
      throw new SubmoduleManifestError();
    seen.add(key);
    return { path, repository: declaration.repository, commitSha };
  });
}

function assertSafeRelativePath(path: string): void {
  const components = path.split("/");
  if (
    path === "" ||
    /[\\:\r\n\0]/u.test(path) ||
    components.some(
      (component) =>
        component === "" ||
        component === "." ||
        component === ".." ||
        component.toLowerCase() === ".git" ||
        /^(?:COM|LPT)[¹²³](?:\.|$)/iu.test(component),
    )
  )
    throw new SubmoduleManifestError();
  try {
    assertWindowsLocalAbsolutePath(
      `C:\\source\\${components.join("\\")}`,
      "Git submodule path",
      false,
    );
  } catch {
    throw new SubmoduleManifestError();
  }
}

function parseGitHubRepository(url: string): string {
  // A literal match avoids URL normalization, credentials, redirects and transport helpers.
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(
      url,
    );
  if (match === null) throw new SubmoduleManifestError();
  const owner = match[1]!;
  const rawRepository = match[2]!;
  const repository = rawRepository.endsWith(".git") ? rawRepository.slice(0, -4) : rawRepository;
  const canonical = `${owner}/${repository}`;
  if (
    canonical.length > 256 ||
    repository === "" ||
    [owner, repository].some((segment) => segment.endsWith(".") || /\.git$/iu.test(segment))
  )
    throw new SubmoduleManifestError();
  return canonical;
}
