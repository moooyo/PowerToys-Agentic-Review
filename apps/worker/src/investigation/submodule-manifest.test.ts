import { describe, expect, it } from "vitest";
import { parsePinnedGitSubmodules, SubmoduleManifestError } from "./submodule-manifest.js";

const firstSha = "a".repeat(40);
const secondSha = "b".repeat(40);
const config = (...records: string[]) =>
  Buffer.from(records.map((record) => `${record}\0`).join(""));
const declaration = (
  name = "expected-lite",
  path = "deps/expected-lite",
  url = "https://github.com/martinmoene/expected-lite.git",
) => [`submodule.${name}.path\n${path}`, `submodule.${name}.url\n${url}`];
const gitlink = (path = "deps/expected-lite", commitSha = firstSha) => ({ path, commitSha });

function expectUnsupported(bytes: Uint8Array, links = [gitlink()]): void {
  expect(() => parsePinnedGitSubmodules(bytes, links)).toThrow(SubmoduleManifestError);
  try {
    parsePinnedGitSubmodules(bytes, links);
  } catch (error) {
    expect(error).toMatchObject({
      code: "SOURCE_SUBMODULE_UNSUPPORTED",
      message: "The pinned Git submodule declarations are unsupported or unsafe.",
    });
  }
}

describe("parsePinnedGitSubmodules", () => {
  it("binds the two pinned dependencies in gitlink order", () => {
    const bytes = config(
      ...declaration(),
      ...declaration("spdlog", "deps/spdlog", "https://github.com/gabime/spdlog"),
    );
    expect(parsePinnedGitSubmodules(bytes, [gitlink("deps/spdlog", secondSha), gitlink()])).toEqual(
      [
        { path: "deps/spdlog", repository: "gabime/spdlog", commitSha: secondSha },
        {
          path: "deps/expected-lite",
          repository: "martinmoene/expected-lite",
          commitSha: firstSha,
        },
      ],
    );
  });

  it("preserves subsection case and dots while accepting nested relative paths", () => {
    const bytes = config(
      ...declaration("Build.Dependency.v1", "vendor/native/expected-lite"),
      ...declaration(
        "build.Dependency.v1",
        "vendor/native/spdlog",
        "https://github.com/Gabime/spdlog.git",
      ),
    );
    expect(
      parsePinnedGitSubmodules(bytes, [
        gitlink("vendor/native/expected-lite"),
        gitlink("vendor/native/spdlog"),
      ]),
    ).toEqual([
      {
        path: "vendor/native/expected-lite",
        repository: "martinmoene/expected-lite",
        commitSha: firstSha,
      },
      { path: "vendor/native/spdlog", repository: "Gabime/spdlog", commitSha: firstSha },
    ]);
  });

  it("ignores optional metadata and never returns an unused declaration", () => {
    const bytes = config(
      ...declaration(),
      "submodule.expected-lite.branch\nmain",
      "submodule.expected-lite.ignore\nall",
      "submodule.expected-lite.update\n!run-untrusted-command\nwith a second line",
      ...declaration("unused", "unused/module", "https://github.com/owner/unused.git"),
    );
    expect(parsePinnedGitSubmodules(bytes, [gitlink()])).toEqual([
      { path: "deps/expected-lite", repository: "martinmoene/expected-lite", commitSha: firstSha },
    ]);
  });

  it.each(["shallow", "fetchrecursesubmodules"])(
    "ignores a valueless optional boolean: %s",
    (field) => {
      const bytes = config(...declaration(), `submodule.expected-lite.${field}`);
      expect(parsePinnedGitSubmodules(bytes, [gitlink()])).toEqual([
        {
          path: "deps/expected-lite",
          repository: "martinmoene/expected-lite",
          commitSha: firstSha,
        },
      ]);
    },
  );

  it.each(["path", "url"])("rejects a valueless required field: %s", (field) => {
    const records = declaration();
    records[field === "path" ? 0 : 1] = `submodule.expected-lite.${field}`;
    expectUnsupported(config(...records));
  });

  it("accepts an empty tree and ignores complete unused declarations", () => {
    expect(parsePinnedGitSubmodules(new Uint8Array(), [])).toEqual([]);
    expect(parsePinnedGitSubmodules(config(...declaration()), [])).toEqual([]);
  });

  it.each([
    "http://github.com/owner/repo",
    "HTTPS://github.com/owner/repo",
    "https://GitHub.com/owner/repo",
    "https://github.com.evil.test/owner/repo",
    "https://gitlab.com/owner/repo",
    "https://user@github.com/owner/repo",
    "https://user:password@github.com/owner/repo",
    "https://github.com:443/owner/repo",
    "https://github.com/owner/repo?option=value",
    "https://github.com/owner/repo#fragment",
    "https://github.com/owner/repo/",
    "https://github.com/owner/repo/extra",
    "https://github%2ecom/owner/repo",
    "https://github.com/owner/%72epo",
    "https://github.com/owner/../repo",
    "https://github.com/owner./repo",
    "https://github.com/owner/repo.",
    "https://github.com/owner.git/repo",
    "https://github.com/owner/repo.git.git",
    "https://github.com/owner/repo.GIT",
    "https://github.com/-owner/repo",
    "https://github.com/owner/_repo",
    "ssh://git@github.com/owner/repo",
    "git@github.com:owner/repo.git",
    "file:///C:/repo",
    "ext::command",
    "../repo.git",
    "C:/repo.git",
    "https://github.com/owner/repo\nhttps://github.com/other/repo",
    "https://github.com/owner/repo\r",
    "",
  ])("rejects an unsupported repository URL: %s", (url) => {
    expectUnsupported(config(...declaration("dependency", "deps/expected-lite", url)));
  });

  it("bounds the canonical repository name", () => {
    expectUnsupported(
      config(
        ...declaration(
          "dependency",
          "deps/expected-lite",
          `https://github.com/owner/${"r".repeat(251)}`,
        ),
      ),
    );
  });

  it.each([
    "",
    "/absolute",
    "//server/share",
    "C:/absolute",
    "C:relative",
    "deps\\module",
    "deps//module",
    "deps/module/",
    "../module",
    "deps/../module",
    "deps/./module",
    ".git/module",
    "deps/.GIT/module",
    "deps/module:stream",
    "deps/module.",
    "deps/module ",
    "deps/NUL",
    "deps/con.txt",
    "deps/LPT1",
    "deps/COM2.txt",
    "deps/COM¹.txt",
    "deps/LPT²",
    "deps/CONIN$",
    "deps/CONOUT$",
    "deps/CLOCK$",
    "deps/mod?ule",
    "deps/mod*ule",
    "deps/mod|ule",
    "deps/mod<ule",
    "deps/mod>ule",
    'deps/mod"ule',
    "deps/mod\tule",
    "deps/mod\nule",
    "deps/mod\rule",
    "deps/mod\0ule",
  ])("rejects an unsafe declaration path: %s", (path) => {
    expectUnsupported(config(...declaration("dependency", path)), [gitlink(path)]);
  });

  it("rejects duplicate and case-alias declarations and ancestor casing aliases", () => {
    for (const otherPath of ["deps/expected-lite", "deps/Expected-Lite", "DEPS/spdlog"]) {
      expectUnsupported(
        config(
          ...declaration(),
          ...declaration("second", otherPath, "https://github.com/owner/second"),
        ),
      );
    }
  });

  it("rejects overlapping direct mounts in either declaration order", () => {
    const ancestor = declaration("ancestor", "deps", "https://github.com/owner/ancestor");
    expectUnsupported(config(...declaration(), ...ancestor));
    expectUnsupported(config(...ancestor, ...declaration()));
  });

  it("requires one complete declaration for each exact gitlink path", () => {
    expectUnsupported(config(...declaration()), [gitlink("deps/missing")]);
    expectUnsupported(config(...declaration()), [gitlink("deps/Expected-Lite")]);
    expectUnsupported(new Uint8Array());
    expectUnsupported(config("submodule.expected-lite.path\ndeps/expected-lite"));
    expectUnsupported(config("submodule.expected-lite.url\nhttps://github.com/owner/repo"));
    expectUnsupported(config(...declaration(), "submodule.unused.branch\nmain"));
  });

  it("rejects duplicate path or URL fields without accepting last-value overrides", () => {
    expectUnsupported(config(...declaration(), "submodule.expected-lite.path\ndeps/expected-lite"));
    expectUnsupported(config(...declaration(), "submodule.expected-lite.path\ndeps/other"));
    expectUnsupported(
      config(...declaration(), "submodule.expected-lite.url\nhttps://github.com/owner/other"),
    );
  });

  it.each([
    "include.path\nC:/untrusted/config",
    "includeif.gitdir:C:/repo.path\nC:/untrusted/config",
    "core.hooksPath\nC:/untrusted/hooks",
    "credential.helper\n!command",
    "submodule.path\ndeps/expected-lite",
    "submodule..path\ndeps/expected-lite",
    "submodule.expected-lite.URL\nhttps://github.com/owner/other",
    "submodule.expected-lite.\nignored",
    '[submodule "expected-lite"]\npath = deps/expected-lite',
  ])("rejects noncanonical or out-of-scope configuration records: %s", (record) => {
    expectUnsupported(config(...declaration(), record));
  });

  it("rejects malformed UTF-8, a BOM, missing terminators and empty records", () => {
    expectUnsupported(Uint8Array.from([0xc3, 0x28, 0]));
    expectUnsupported(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), config(...declaration())]));
    expectUnsupported(Buffer.from(declaration().join("\0")));
    expectUnsupported(Buffer.from("\0"));
    expectUnsupported(Buffer.concat([config(...declaration()), Buffer.from("\0")]));
  });

  it("bounds bytes, record count and gitlink count before processing", () => {
    expectUnsupported(new Uint8Array(64 * 1_024 + 1));
    expectUnsupported(
      config(
        ...declaration(),
        ...Array.from({ length: 255 }, () => "submodule.expected-lite.branch\nmain"),
      ),
    );
    expectUnsupported(
      config(...declaration()),
      Array.from({ length: 129 }, () => gitlink()),
    );
  });

  it.each([
    "a".repeat(39),
    "a".repeat(41),
    "A".repeat(40),
    "g".repeat(40),
    `${firstSha}\n`,
    "HEAD",
  ])("rejects an unpinned or noncanonical commit: %s", (commitSha) => {
    expectUnsupported(config(...declaration()), [gitlink("deps/expected-lite", commitSha)]);
  });

  it("rejects repeated gitlinks and unsafe gitlink paths", () => {
    expectUnsupported(config(...declaration()), [gitlink(), gitlink()]);
    expectUnsupported(config(...declaration()), [gitlink("deps/../expected-lite")]);
  });

  it("does not mutate inputs or share returned records between calls", () => {
    const bytes = config(...declaration());
    const links = Object.freeze([Object.freeze(gitlink())]);
    const before = Buffer.from(bytes);
    const first = parsePinnedGitSubmodules(bytes, links);
    expect(parsePinnedGitSubmodules(bytes, links)).toEqual(first);
    expect(parsePinnedGitSubmodules(bytes, links)[0]).not.toBe(first[0]);
    expect(bytes).toEqual(before);
  });
});
