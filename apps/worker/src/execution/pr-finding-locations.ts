export interface PrFindingLocation {
  readonly path: string;
  readonly line: number;
  readonly endLine: number | null;
}

export interface PrFindingLocationInput {
  readonly baseSha: string;
  readonly headSha: string;
  readonly findings: readonly PrFindingLocation[];
}

export interface FrozenPrFindingSource {
  readonly baseSha: string;
  readonly headSha: string;
  /** Captured by trusted workspace preparation, before any model process starts. */
  readonly mergeBases?: readonly string[];
}

export type PrFindingLocationValidation =
  | { readonly status: "verified"; readonly mergeBase: string }
  | {
      readonly status: "invalid" | "unverified";
      readonly reason: string;
      readonly findingIndex?: number;
    };

/** The implementation executes only bounded, read-only Git commands in the owned object store. */
export type PrFindingGitReader = (
  argumentsList: readonly string[],
  signal: AbortSignal,
) => Promise<string>;

export const prFindingLocationLimits = Object.freeze({
  maximumFindings: 100,
  maximumGitOutputBytes: 1024 * 1024,
  maximumTotalOutputBytes: 8 * 1024 * 1024,
  maximumDurationMs: 30_000,
  contextLines: 3,
  renameLimit: 1000,
});

const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const zeroObjectId = /^0+$/u;
interface Change {
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldObject: string;
  readonly newObject: string;
  readonly path: string;
}
interface Hunk {
  readonly start: number;
  readonly end: number;
}
class Unverified extends Error {}

function parseChanges(output: string, objectIdLength: number): ReadonlyMap<string, Change> {
  if (output === "") return new Map();
  if (!output.endsWith("\0")) throw new Unverified("incomplete_raw_diff");
  const fields = output.split("\0");
  fields.pop();
  const changes = new Map<string, Change>();
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++];
    const match =
      /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([ACDMRTUX][0-9]*)$/u.exec(
        header ?? "",
      );
    if (!match) throw new Unverified("invalid_raw_diff");
    const [, oldMode = "", newMode = "", oldObject = "", newObject = "", status = ""] = match;
    const renamed = /^[RC][0-9]{1,3}$/u.test(status) && Number(status.slice(1)) <= 100;
    const oldAbsent = oldMode === "000000" && zeroObjectId.test(oldObject);
    const newAbsent = newMode === "000000" && zeroObjectId.test(newObject);
    if (
      oldObject.length !== objectIdLength ||
      newObject.length !== objectIdLength ||
      (oldMode === "000000") !== zeroObjectId.test(oldObject) ||
      (newMode === "000000") !== zeroObjectId.test(newObject) ||
      !(["A", "D", "M", "T"].includes(status) || renamed) ||
      (status === "A"
        ? !oldAbsent || newAbsent
        : status === "D"
          ? oldAbsent || !newAbsent
          : oldAbsent || newAbsent)
    )
      throw new Unverified("invalid_raw_diff_metadata");
    const oldPath = fields[index++];
    const path = renamed ? fields[index++] : oldPath;
    if (!oldPath || !path || changes.has(path) || (renamed && oldPath === path))
      throw new Unverified("ambiguous_diff_path");
    changes.set(path, {
      oldMode,
      newMode,
      oldObject,
      newObject,
      path,
    });
  }
  return changes;
}

function hunkNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 10_000_000)
    throw new Unverified("invalid_hunk_range");
  return number;
}

function parseHunks(output: string, lineCount: number): readonly Hunk[] {
  const hunks: Hunk[] = [];
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("@@")) {
      if (oldRemaining !== 0 || newRemaining !== 0) throw new Unverified("incomplete_diff_hunk");
      const match = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?$/u.exec(line);
      if (!match) throw new Unverified("invalid_diff_hunk");
      hunkNumber(match[1] ?? "");
      oldRemaining = hunkNumber(match[2] ?? "1");
      const start = hunkNumber(match[3] ?? "");
      newRemaining = hunkNumber(match[4] ?? "1");
      if (newRemaining > 0) {
        const end = start + newRemaining - 1;
        if (start < 1 || end > lineCount || end < start)
          throw new Unverified("hunk_outside_head_blob");
        hunks.push({ start, end });
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") continue;
    if (oldRemaining === 0 && newRemaining === 0) {
      if (line !== "") throw new Unverified("unexpected_diff_content");
      continue;
    }
    const prefix = line[0];
    if (prefix === " ") {
      oldRemaining--;
      newRemaining--;
    } else if (prefix === "-") oldRemaining--;
    else if (prefix === "+") newRemaining--;
    else throw new Unverified("incomplete_diff_hunk");
    if (oldRemaining < 0 || newRemaining < 0) throw new Unverified("invalid_diff_hunk_counts");
  }
  if (oldRemaining !== 0 || newRemaining !== 0) throw new Unverified("incomplete_diff_hunk");
  return hunks;
}

function normalizedPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.isWellFormed() &&
    !path.includes("\\") &&
    !path.includes(":") &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !path.startsWith("/") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Head-side ranges must exist in the frozen text blob and overlap its PR hunk, including three
 * context lines. The full range need not consist only of additions. No working-tree file is read. */
export async function validatePrFindingLocations(
  suppliedInput: PrFindingLocationInput,
  suppliedSource: FrozenPrFindingSource,
  readGit: PrFindingGitReader,
  signal: AbortSignal,
): Promise<PrFindingLocationValidation> {
  signal.throwIfAborted();
  const input = structuredClone(suppliedInput);
  const source = structuredClone(suppliedSource);
  if (
    !objectId.test(input.baseSha) ||
    !objectId.test(input.headSha) ||
    input.baseSha !== source.baseSha ||
    input.headSha !== source.headSha
  )
    return { status: "unverified", reason: "frozen_source_mismatch" };
  if (input.findings.length > prFindingLocationLimits.maximumFindings)
    return { status: "unverified", reason: "finding_count_limit" };
  for (const [findingIndex, finding] of input.findings.entries()) {
    if (!normalizedPath(finding.path))
      return { status: "invalid", reason: "invalid_path", findingIndex };
    const end = finding.endLine ?? finding.line;
    if (
      !Number.isSafeInteger(finding.line) ||
      !Number.isSafeInteger(end) ||
      finding.line < 1 ||
      end < finding.line ||
      end > 10_000_000
    )
      return { status: "invalid", reason: "invalid_line_range", findingIndex };
  }
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Unverified("verification_timeout")),
    prFindingLocationLimits.maximumDurationMs,
  );
  const active = AbortSignal.any([signal, deadline.signal]);
  let totalBytes = 0;
  const read = async (args: readonly string[]): Promise<string> => {
    active.throwIfAborted();
    const output = await readGit(["--no-replace-objects", "--literal-pathspecs", ...args], active);
    active.throwIfAborted();
    const bytes = Buffer.byteLength(output, "utf8");
    totalBytes += bytes;
    if (
      bytes > prFindingLocationLimits.maximumGitOutputBytes ||
      totalBytes > prFindingLocationLimits.maximumTotalOutputBytes
    )
      throw new Unverified("git_output_limit");
    return output;
  };
  try {
    const mergeBases =
      source.mergeBases ??
      (await read(["merge-base", "--all", source.baseSha, source.headSha])).trim().split(/\r?\n/u);
    const mergeBase = mergeBases[0];
    if (mergeBases.length !== 1 || mergeBase === undefined || !objectId.test(mergeBase))
      return { status: "unverified", reason: "ambiguous_merge_base" };
    if (input.findings.length === 0) return { status: "verified", mergeBase };
    const changes = parseChanges(
      await read([
        "diff",
        "--raw",
        "-z",
        "--no-abbrev",
        "--find-renames=50%",
        `-l${prFindingLocationLimits.renameLimit}`,
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--ignore-submodules=none",
        mergeBase,
        source.headSha,
        "--",
      ]),
      source.headSha.length,
    );
    const checked = new Map<string, { lineCount: number; hunks: readonly Hunk[] }>();
    for (const [findingIndex, finding] of input.findings.entries()) {
      active.throwIfAborted();
      const change = changes.get(finding.path);
      if (!change) return { status: "invalid", reason: "file_not_in_pr_diff", findingIndex };
      if (change.newMode === "000000" || zeroObjectId.test(change.newObject))
        return { status: "invalid", reason: "file_absent_from_head", findingIndex };
      if (change.newMode !== "100644" && change.newMode !== "100755")
        return { status: "invalid", reason: "head_file_is_not_regular_text", findingIndex };
      let file = checked.get(finding.path);
      if (!file) {
        const content = await read(["cat-file", "blob", change.newObject]);
        if (content.includes("\0"))
          return { status: "invalid", reason: "binary_head_file", findingIndex };
        const lineCount =
          content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
        const hunks = zeroObjectId.test(change.oldObject)
          ? lineCount === 0
            ? []
            : [{ start: 1, end: lineCount }]
          : parseHunks(
              await read([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--text",
                "--no-renames",
                "--diff-algorithm=myers",
                "--no-indent-heuristic",
                "--unified=3",
                "--inter-hunk-context=0",
                change.oldObject,
                change.newObject,
                "--",
              ]),
              lineCount,
            );
        file = { lineCount, hunks };
        checked.set(finding.path, file);
      }
      const end = finding.endLine ?? finding.line;
      if (end > file.lineCount)
        return { status: "invalid", reason: "line_outside_head_blob", findingIndex };
      if (!file.hunks.some((hunk) => finding.line <= hunk.end && end >= hunk.start))
        return { status: "invalid", reason: "range_outside_pr_hunks", findingIndex };
    }
    return { status: "verified", mergeBase };
  } catch (error) {
    signal.throwIfAborted();
    return {
      status: "unverified",
      reason: deadline.signal.aborted
        ? "verification_timeout"
        : error instanceof Unverified
          ? error.message
          : "git_read_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
