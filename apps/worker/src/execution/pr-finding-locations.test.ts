import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type FrozenPrFindingSource,
  type PrFindingGitReader,
  type PrFindingLocation,
  type PrFindingLocationInput,
  prFindingLocationLimits,
  validatePrFindingLocations,
} from "./pr-finding-locations.js";

const fixturePrefix = "agentic-review-pr-findings-";
const ownedRoots = new Map<string, string>();
let retainFixtures = false;

interface GitFixture {
  readonly root: string;
  readonly repository: string;
  git(argumentsList: readonly string[], signal?: AbortSignal): Promise<string>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  commit(message: string): Promise<string>;
  readonly reader: PrFindingGitReader;
}

function ownedPath(root: string, path: string): string {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("The fixture path escapes its owned root.");
  }
  return target;
}

async function createGitFixture(): Promise<GitFixture> {
  const parent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(parent, fixturePrefix)));
  ownedRoots.set(root, parent);
  const repository = join(root, "repository");
  const home = join(root, "home");
  const temporary = join(root, "temp");
  await Promise.all([mkdir(repository), mkdir(home), mkdir(temporary)]);
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    TMP: temporary,
    TEMP: temporary,
    TMPDIR: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "empty.gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Finding Fixture",
    GIT_AUTHOR_EMAIL: "finding-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Finding Fixture",
    GIT_COMMITTER_EMAIL: "finding-fixture@example.invalid",
    GIT_AUTHOR_DATE: "2026-09-10T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-09-10T00:00:00Z",
    LC_ALL: "C",
  };
  for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  await writeFile(environment.GIT_CONFIG_GLOBAL!, "");
  const git = (argumentsList: readonly string[], signal?: AbortSignal): Promise<string> =>
    new Promise((resolveOutput, reject) => {
      execFile(
        "git",
        [
          "--no-pager",
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.quotePath=true",
          "-c",
          "core.hooksPath=",
          "-c",
          "commit.gpgSign=false",
          ...argumentsList,
        ],
        {
          cwd: repository,
          env: environment,
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: prFindingLocationLimits.maximumGitOutputBytes,
          encoding: "buffer",
          ...(signal === undefined ? {} : { signal }),
        },
        (error, stdout) => {
          if (error !== null) {
            reject(error);
            return;
          }
          try {
            resolveOutput(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
          } catch (error) {
            reject(error);
          }
        },
      );
    });
  try {
    await git(["init", "--quiet", "--initial-branch=fixture"]);
  } catch (error) {
    retainFixtures = true;
    throw error;
  }
  return {
    root,
    repository,
    git,
    write: async (path, content) => {
      const target = ownedPath(repository, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    commit: async (message) => {
      await git(["commit", "--quiet", "--no-verify", "-m", message]);
      return (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    },
    reader: (argumentsList, signal) => git(argumentsList, signal),
  };
}

afterEach((context) => {
  if (context.task.result?.state === "fail") retainFixtures = true;
  vi.useRealTimers();
});

afterAll(async () => {
  for (const [root, parent] of ownedRoots) {
    if (retainFixtures) {
      console.warn(`Retained finding-location fixture: ${root}`);
      continue;
    }
    const target = resolve(root);
    const state = await lstat(target);
    if (
      dirname(target) !== parent ||
      !basename(target).startsWith(fixturePrefix) ||
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      (await realpath(target)) !== target
    ) {
      throw new Error(`Refusing to remove an unexpected fixture root: ${target}`);
    }
    await rm(target, { recursive: true, force: false });
  }
});

function location(path: string, line = 1, endLine: number | null = null): PrFindingLocation {
  return { path, line, endLine };
}

function lines(count: number, changedLine?: number): string {
  return (
    Array.from(
      { length: count },
      (_, index) => `line ${index + 1}: ${index + 1 === changedLine ? "changed" : "original"}`,
    ).join("\n") + "\n"
  );
}

describe("PR finding locations in real immutable Git objects", () => {
  let fixture: GitFixture;
  let source: FrozenPrFindingSource;
  const unicodePath = "src/naïve 文件 with spaces.ts";
  const verify = (findings: readonly PrFindingLocation[]) =>
    validatePrFindingLocations(
      { baseSha: source.baseSha, headSha: source.headSha, findings },
      source,
      fixture.reader,
      new AbortController().signal,
    );

  beforeAll(async () => {
    try {
      fixture = await createGitFixture();
      await Promise.all([
        fixture.write("changed.ts", lines(30)),
        fixture.write("unchanged.ts", lines(30)),
        fixture.write("rename-old.ts", lines(40)),
        fixture.write("pure-old.ts", "Pure rename content.\n"),
        fixture.write("deleted.ts", "This file will be deleted.\n"),
        fixture.write("delete-line.ts", lines(20)),
        fixture.write("mode-only.sh", "echo unchanged\n"),
        fixture.write("binary.bin", Buffer.from([0, 1, 2, 3])),
        fixture.write("no-newline.ts", "before"),
        fixture.write("not-utf8.txt", "before\n"),
        fixture.write(unicodePath, lines(20)),
      ]);
      await fixture.git(["add", "--all"]);
      const baseSha = await fixture.commit("Create immutable finding-location base");
      await Promise.all([
        fixture.write("changed.ts", lines(30, 15)),
        fixture.write(
          "delete-line.ts",
          lines(20)
            .split("\n")
            .filter((_, index) => index !== 9)
            .join("\n"),
        ),
        fixture.write("binary.bin", Buffer.from([0, 4, 5, 6])),
        fixture.write("no-newline.ts", "after"),
        fixture.write("not-utf8.txt", Buffer.from([0xff, 0x0a])),
        fixture.write("empty.ts", ""),
        fixture.write("added.ts", "new first line\nnew second line\n"),
        fixture.write(unicodePath, lines(20, 10)),
      ]);
      await fixture.git(["mv", "rename-old.ts", "rename-new.ts"]);
      await fixture.write("rename-new.ts", lines(40, 20));
      await fixture.git(["mv", "pure-old.ts", "pure-new.ts"]);
      await fixture.git(["rm", "--", "deleted.ts"]);
      await fixture.git(["add", "--all"]);
      await fixture.git(["update-index", "--chmod=+x", "mode-only.sh"]);
      await fixture.write("symlink-target.txt", "changed.ts");
      const symlinkBlob = (await fixture.git(["hash-object", "-w", "symlink-target.txt"])).trim();
      await fixture.git(["update-index", "--add", "--cacheinfo", `120000,${symlinkBlob},link.ts`]);
      await fixture.git(["update-index", "--add", "--cacheinfo", `160000,${baseSha},submodule`]);
      const headSha = await fixture.commit("Create immutable finding-location head");
      source = { baseSha, headSha };
    } catch (error) {
      retainFixtures = true;
      throw error;
    }
  }, 60_000);

  it("accepts the changed line and unchanged lines inside the fixed three-line context", async () => {
    expect(
      await verify([
        location("changed.ts", 12),
        location("changed.ts", 15),
        location("changed.ts", 18),
      ]),
    ).toEqual({ status: "verified", mergeBase: source.baseSha });
  });

  it("accepts a complete head range that overlaps a hunk and extends beyond its context", async () => {
    expect(await verify([location("changed.ts", 1, 12), location("changed.ts", 18, 30)])).toEqual({
      status: "verified",
      mergeBase: source.baseSha,
    });
  });

  it.each([11, 19, 30])("rejects unchanged line %i outside the PR hunk", async (line) => {
    expect(await verify([location("changed.ts", line)])).toEqual({
      status: "invalid",
      reason: "range_outside_pr_hunks",
      findingIndex: 0,
    });
  });

  it.each(["missing.ts", "unchanged.ts"])(
    "rejects a path without a PR change: %s",
    async (path) => {
      expect(await verify([location(path)])).toEqual({
        status: "invalid",
        reason: "file_not_in_pr_diff",
        findingIndex: 0,
      });
    },
  );

  it("rejects the full range when its end exceeds the frozen head line count", async () => {
    expect(await verify([location("changed.ts", 15, 31)])).toEqual({
      status: "invalid",
      reason: "line_outside_head_blob",
      findingIndex: 0,
    });
  });

  it("uses the new path and edited hunk of a rename", async () => {
    expect(await verify([location("rename-new.ts", 20)])).toEqual({
      status: "verified",
      mergeBase: source.baseSha,
    });
    expect(await verify([location("rename-new.ts", 1)])).toEqual({
      status: "invalid",
      reason: "range_outside_pr_hunks",
      findingIndex: 0,
    });
  });

  it("rejects the old path of a rename", async () => {
    expect(await verify([location("rename-old.ts", 20)])).toEqual({
      status: "invalid",
      reason: "file_not_in_pr_diff",
      findingIndex: 0,
    });
  });

  it("rejects a pure rename without a text hunk", async () => {
    expect(await verify([location("pure-new.ts")])).toEqual({
      status: "invalid",
      reason: "range_outside_pr_hunks",
      findingIndex: 0,
    });
  });

  it("rejects a file deleted from head", async () => {
    expect(await verify([location("deleted.ts")])).toEqual({
      status: "invalid",
      reason: "file_absent_from_head",
      findingIndex: 0,
    });
  });

  it("allows an existing head context line next to a deletion", async () => {
    expect(await verify([location("delete-line.ts", 10)])).toEqual({
      status: "verified",
      mergeBase: source.baseSha,
    });
  });

  it("rejects a file mode change without a text hunk", async () => {
    expect(await verify([location("mode-only.sh")])).toEqual({
      status: "invalid",
      reason: "range_outside_pr_hunks",
      findingIndex: 0,
    });
  });

  it("rejects a binary head blob", async () => {
    expect(await verify([location("binary.bin")])).toEqual({
      status: "invalid",
      reason: "binary_head_file",
      findingIndex: 0,
    });
  });

  it.each(["link.ts", "submodule"])("rejects non-regular head entry %s", async (path) => {
    expect(await verify([location(path)])).toEqual({
      status: "invalid",
      reason: "head_file_is_not_regular_text",
      findingIndex: 0,
    });
  });

  it("cannot verify non-UTF-8 head content", async () => {
    expect(await verify([location("not-utf8.txt")])).toEqual({
      status: "unverified",
      reason: "git_read_failed",
    });
  });

  it("does not invent a line in an empty head blob", async () => {
    expect(await verify([location("empty.ts")])).toEqual({
      status: "invalid",
      reason: "line_outside_head_blob",
      findingIndex: 0,
    });
  });

  it("counts the final line when the text has no trailing newline", async () => {
    expect(await verify([location("no-newline.ts")])).toEqual({
      status: "verified",
      mergeBase: source.baseSha,
    });
    expect(await verify([location("no-newline.ts", 2)])).toEqual({
      status: "invalid",
      reason: "line_outside_head_blob",
      findingIndex: 0,
    });
  });

  it("accepts a new file while rejecting a line after its trailing newline", async () => {
    expect(await verify([location("added.ts", 1, 2)])).toEqual({
      status: "verified",
      mergeBase: source.baseSha,
    });
    expect(await verify([location("added.ts", 3)])).toEqual({
      status: "invalid",
      reason: "line_outside_head_blob",
      findingIndex: 0,
    });
  });

  it("preserves a Unicode path that Git quotes in ordinary text output", async () => {
    expect(await verify([location(unicodePath, 10)])).toEqual({
      status: "verified",
      mergeBase: source.baseSha,
    });
  });

  it("uses the unique merge base when the target branch has diverged", async () => {
    const branch = await createGitFixture();
    await branch.write("shared.ts", lines(20));
    await branch.git(["add", "--all"]);
    const ancestor = await branch.commit("Common ancestor");
    await branch.write("base-only.ts", "Only the target branch contains this.\n");
    await branch.git(["add", "--all"]);
    const baseSha = await branch.commit("Target branch advance");
    await branch.git(["checkout", "--quiet", "--detach", ancestor]);
    await branch.write("shared.ts", lines(20, 10));
    await branch.git(["add", "--all"]);
    const headSha = await branch.commit("PR branch advance");
    const frozen = { baseSha, headSha };
    expect(
      await validatePrFindingLocations(
        { ...frozen, findings: [location("shared.ts", 10)] },
        frozen,
        branch.reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "verified", mergeBase: ancestor });
    expect(
      await validatePrFindingLocations(
        { ...frozen, findings: [location("base-only.ts")] },
        frozen,
        branch.reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "invalid", reason: "file_not_in_pr_diff", findingIndex: 0 });
  }, 30_000);

  it("ignores subsequent working-tree edits, a different HEAD and replacement refs", async () => {
    const branch = await createGitFixture();
    await branch.write("file.ts", lines(20));
    await branch.git(["add", "--all"]);
    const baseSha = await branch.commit("Frozen base");
    await branch.write("file.ts", lines(20, 10));
    await branch.git(["add", "--all"]);
    const headSha = await branch.commit("Frozen head");
    await branch.write("file.ts", "Replacement content\n");
    await branch.git(["add", "--all"]);
    const replacement = await branch.commit("Unrelated later checkout");
    await branch.git(["replace", headSha, replacement]);
    await branch.write("file.ts", "Dirty worktree content\n");
    const reader = vi.fn(branch.reader);
    const frozen = { baseSha, headSha, mergeBases: [baseSha] };
    expect(
      await validatePrFindingLocations(
        { baseSha, headSha, findings: [location("file.ts", 10)] },
        frozen,
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "verified", mergeBase: baseSha });
    for (const [argumentsList] of reader.mock.calls) {
      expect(argumentsList[0]).toBe("--no-replace-objects");
      expect(argumentsList).not.toContain("HEAD");
    }
  }, 30_000);
});

const mockBase = "a".repeat(40);
const mockHead = "b".repeat(40);
const mockOldBlob = "c".repeat(40);
const mockNewBlob = "d".repeat(40);
const mockPath = "src/file.ts";
const mockContent = "first\nchanged\nthird\n";
const mockPatch =
  "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1,3 +1,3 @@\n first\n-before\n+changed\n third\n";
const rawChange = (path = mockPath) => `:100644 100644 ${mockOldBlob} ${mockNewBlob} M\0${path}\0`;
const mockInput = (): PrFindingLocationInput => ({
  baseSha: mockBase,
  headSha: mockHead,
  findings: [location(mockPath, 2)],
});
const mockSource = (): FrozenPrFindingSource => ({
  baseSha: mockBase,
  headSha: mockHead,
  mergeBases: [mockBase],
});
function mockReader(
  overrides: { readonly raw?: string; readonly content?: string; readonly patch?: string } = {},
) {
  return vi.fn<PrFindingGitReader>(async (argumentsList) => {
    if (argumentsList.includes("merge-base")) return `${mockBase}\n`;
    if (argumentsList.includes("--raw")) return overrides.raw ?? rawChange();
    if (argumentsList.includes("cat-file")) return overrides.content ?? mockContent;
    if (argumentsList.includes("diff")) return overrides.patch ?? mockPatch;
    throw new Error("Unexpected test Git operation.");
  });
}

describe("PR finding location refusal and resource boundaries", () => {
  it("does not query Git for a mismatched frozen revision", async () => {
    const reader = mockReader();
    expect(
      await validatePrFindingLocations(
        mockInput(),
        { ...mockSource(), headSha: "e".repeat(40) },
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "unverified", reason: "frozen_source_mismatch" });
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    { mergeBases: [] },
    { mergeBases: [mockBase, mockHead] },
    { mergeBases: ["not-an-object-id"] },
  ])("rejects ambiguous or invalid captured merge bases $mergeBases", async ({ mergeBases }) => {
    const reader = mockReader();
    expect(
      await validatePrFindingLocations(
        mockInput(),
        { ...mockSource(), mergeBases },
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "unverified", reason: "ambiguous_merge_base" });
    expect(reader).not.toHaveBeenCalled();
  });

  it("supports canonical SHA-256 object identities without shortening them", async () => {
    const baseSha = "a".repeat(64);
    const headSha = "b".repeat(64);
    const reader = mockReader({
      raw: `:100644 100644 ${"c".repeat(64)} ${"d".repeat(64)} M\0${mockPath}\0`,
    });
    expect(
      await validatePrFindingLocations(
        { baseSha, headSha, findings: [location(mockPath, 2)] },
        { baseSha, headSha, mergeBases: [baseSha] },
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "verified", mergeBase: baseSha });
    expect(reader.mock.calls.some(([args]) => args.includes(headSha))).toBe(true);
  });

  it("does not launch Git when no findings need checking and the merge base was captured", async () => {
    const reader = mockReader();
    expect(
      await validatePrFindingLocations(
        { ...mockInput(), findings: [] },
        mockSource(),
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "verified", mergeBase: mockBase });
    expect(reader).not.toHaveBeenCalled();
  });

  it("rejects more than one hundred findings before launching Git", async () => {
    const reader = mockReader();
    expect(
      await validatePrFindingLocations(
        { ...mockInput(), findings: Array.from({ length: 101 }, () => location(mockPath)) },
        mockSource(),
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "unverified", reason: "finding_count_limit" });
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    "/file.ts",
    "C:/file.ts",
    "C:file.ts",
    "\\\\server\\file.ts",
    "src\\file.ts",
    "../file.ts",
    "src/../file.ts",
    "src//file.ts",
    "src/./file.ts",
    "src/",
    "src/\u0000file.ts",
    "src/\ud800.ts",
  ])("rejects non-canonical repository path %j before Git", async (path) => {
    const reader = mockReader();
    expect(
      await validatePrFindingLocations(
        { ...mockInput(), findings: [location(path)] },
        mockSource(),
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "invalid", reason: "invalid_path", findingIndex: 0 });
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    location(mockPath, 0),
    location(mockPath, 2, 1),
    location(mockPath, 1.5),
    location(mockPath, 1, 10_000_001),
    location(mockPath, Number.NaN),
  ])("rejects invalid line range %j before Git", async (finding) => {
    const reader = mockReader();
    expect(
      await validatePrFindingLocations(
        { ...mockInput(), findings: [finding] },
        mockSource(),
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "invalid", reason: "invalid_line_range", findingIndex: 0 });
    expect(reader).not.toHaveBeenCalled();
  });

  it("returns the original finding ordinal for a later invalid location", async () => {
    expect(
      await validatePrFindingLocations(
        { ...mockInput(), findings: [location(mockPath, 2), location("missing.ts")] },
        mockSource(),
        mockReader(),
        new AbortController().signal,
      ),
    ).toEqual({ status: "invalid", reason: "file_not_in_pr_diff", findingIndex: 1 });
  });

  it("reuses a frozen blob and patch for multiple locations in the same path", async () => {
    const reader = mockReader();
    expect(
      await validatePrFindingLocations(
        {
          ...mockInput(),
          findings: [location(mockPath, 1), location(mockPath, 2), location(mockPath, 3)],
        },
        mockSource(),
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "verified", mergeBase: mockBase });
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it.each([
    { name: "missing final NUL", raw: rawChange().slice(0, -1), reason: "incomplete_raw_diff" },
    {
      name: "invalid raw header",
      raw: `not a raw header\0${mockPath}\0`,
      reason: "invalid_raw_diff",
    },
    {
      name: "duplicate destination",
      raw: rawChange() + rawChange(),
      reason: "ambiguous_diff_path",
    },
    {
      name: "missing rename destination",
      raw: `:100644 100644 ${mockOldBlob} ${mockNewBlob} R090\0old.ts\0`,
      reason: "ambiguous_diff_path",
    },
  ])("does not trust $name", async ({ raw, reason }) => {
    expect(
      await validatePrFindingLocations(
        mockInput(),
        mockSource(),
        mockReader({ raw }),
        new AbortController().signal,
      ),
    ).toEqual({ status: "unverified", reason });
  });

  it.each([
    `:000000 100644 ${"0".repeat(40)} ${mockNewBlob} M\0${mockPath}\0`,
    `:100644 100644 ${mockOldBlob} ${mockNewBlob} U\0${mockPath}\0`,
    `:100644 100644 ${mockOldBlob} ${mockNewBlob} R101\0old.ts\0${mockPath}\0`,
  ])("refuses inconsistent or unsupported raw metadata %j", async (raw) => {
    expect(
      await validatePrFindingLocations(
        mockInput(),
        mockSource(),
        mockReader({ raw }),
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "unverified" });
  });

  it.each([
    { name: "truncated body", patch: "@@ -1,3 +1,3 @@\n first\n", reason: "incomplete_diff_hunk" },
    { name: "invalid header", patch: "@@ broken @@\n", reason: "invalid_diff_hunk" },
    {
      name: "head overflow",
      patch: "@@ -1 +4 @@\n-before\n+changed\n",
      reason: "hunk_outside_head_blob",
    },
    {
      name: "unsafe header integer",
      patch: "@@ -9007199254740992 +1 @@\n-before\n+changed\n",
      reason: "invalid_hunk_range",
    },
    {
      name: "impossible line counts",
      patch: "@@ -1,0 +1 @@\n unchanged\n",
      reason: "invalid_diff_hunk_counts",
    },
    {
      name: "content after a completed hunk",
      patch: "@@ -1 +1 @@\n-before\n+changed\n+extra\n",
      reason: "unexpected_diff_content",
    },
  ])("does not partially accept a patch with $name", async ({ patch, reason }) => {
    expect(
      await validatePrFindingLocations(
        mockInput(),
        mockSource(),
        mockReader({ patch }),
        new AbortController().signal,
      ),
    ).toEqual({ status: "unverified", reason });
  });

  it("counts UTF-8 bytes rather than JavaScript code units against the per-command limit", async () => {
    const reader = mockReader({
      content: "é".repeat(prFindingLocationLimits.maximumGitOutputBytes / 2 + 1),
    });
    expect(
      await validatePrFindingLocations(
        mockInput(),
        mockSource(),
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "unverified", reason: "git_output_limit" });
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("stops reading further files when the cumulative output budget is exhausted", async () => {
    const paths = Array.from({ length: 9 }, (_, index) => `file-${index}.ts`);
    const raw = paths
      .map((path) => `:000000 100644 ${"0".repeat(40)} ${mockNewBlob} A\0${path}\0`)
      .join("");
    const reader = mockReader({
      raw,
      content: "x".repeat(prFindingLocationLimits.maximumGitOutputBytes),
    });
    expect(
      await validatePrFindingLocations(
        { ...mockInput(), findings: paths.map((path) => location(path)) },
        mockSource(),
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "unverified", reason: "git_output_limit" });
    expect(reader.mock.calls.filter(([args]) => args.includes("cat-file"))).toHaveLength(8);
  });

  it("does not expose a reader's raw failure text or mistake it for an invalid model location", async () => {
    const reader = vi.fn<PrFindingGitReader>(async () => {
      throw new Error("Private Git diagnostic");
    });
    expect(
      await validatePrFindingLocations(
        mockInput(),
        mockSource(),
        reader,
        new AbortController().signal,
      ),
    ).toEqual({ status: "unverified", reason: "git_read_failed" });
  });

  it("propagates cancellation that arrived before verification without launching Git", async () => {
    const controller = new AbortController();
    const reason = new Error("Canceled before validation");
    controller.abort(reason);
    const reader = mockReader();
    await expect(
      validatePrFindingLocations(mockInput(), mockSource(), reader, controller.signal),
    ).rejects.toBe(reason);
    expect(reader).not.toHaveBeenCalled();
  });

  it("propagates cancellation through a pending Git read and does not run later commands", async () => {
    const controller = new AbortController();
    const reason = new Error("Canceled while reading Git");
    let startRead!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      startRead = resolveStarted;
    });
    const reader = vi.fn<PrFindingGitReader>(
      (_args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          startRead();
        }),
    );
    const result = validatePrFindingLocations(mockInput(), mockSource(), reader, controller.signal);
    const rejection = expect(result).rejects.toBe(reason);
    await started;
    controller.abort(reason);
    await rejection;
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending Git read when the shared validation deadline expires", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const reader = vi.fn<PrFindingGitReader>(
      (_args, signal) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const result = validatePrFindingLocations(
      mockInput(),
      mockSource(),
      reader,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(prFindingLocationLimits.maximumDurationMs);
    expect(await result).toEqual({ status: "unverified", reason: "verification_timeout" });
    expect(observedSignal?.aborted).toBe(true);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("snapshots the input and captured source before asynchronous Git reads", async () => {
    const input = {
      baseSha: mockBase,
      headSha: mockHead,
      findings: [{ path: mockPath, line: 2, endLine: null }],
    };
    const source = { baseSha: mockBase, headSha: mockHead, mergeBases: [mockBase] };
    const normal = mockReader();
    const reader = vi.fn<PrFindingGitReader>(async (args, signal) => {
      input.findings[0]!.path = "missing.ts";
      source.headSha = "e".repeat(40);
      source.mergeBases[0] = "f".repeat(40);
      return normal(args, signal);
    });
    expect(
      await validatePrFindingLocations(input, source, reader, new AbortController().signal),
    ).toEqual({ status: "verified", mergeBase: mockBase });
  });
});
