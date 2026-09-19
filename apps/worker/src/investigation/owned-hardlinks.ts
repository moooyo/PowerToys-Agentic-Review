/** A closed inode group proves that every current hardlink name was observed in the owned tree. */
export interface OwnedHardlinkEntry {
  readonly path: string;
  readonly state: {
    readonly kind: "file" | "directory" | "other";
    readonly identity: string;
    readonly linkCount: number;
  };
}

export class OwnedHardlinkError extends Error {}

export function validateOwnedHardlinkGroups(
  entries: readonly OwnedHardlinkEntry[],
  eligible: (path: string) => boolean,
): ReadonlyMap<string, readonly string[]> {
  const files = new Map<string, OwnedHardlinkEntry[]>();
  for (const entry of entries) {
    if (entry.state.kind !== "file") continue;
    if (!Number.isSafeInteger(entry.state.linkCount) || entry.state.linkCount < 1)
      throw new OwnedHardlinkError("A file has an invalid hardlink count.");
    const group = files.get(entry.state.identity) ?? [];
    group.push(entry);
    files.set(entry.state.identity, group);
  }
  const result = new Map<string, readonly string[]>();
  for (const [identity, group] of files) {
    const count = group[0]!.state.linkCount;
    if (
      group.length !== count ||
      group.some((entry) => entry.state.linkCount !== count) ||
      new Set(group.map((entry) => entry.path.toLowerCase())).size !== count
    )
      throw new OwnedHardlinkError(
        "A file has hardlinks outside the observed owned tree or its links changed during enumeration.",
      );
    if (count === 1) continue;
    // Revalidation before each unlink is intentionally bounded, including adversarial trees.
    if (count > 1_024 || group.some((entry) => !eligible(entry.path)))
      throw new OwnedHardlinkError(
        "A hardlink group includes protected files or exceeds its supported bound.",
      );
    result.set(
      identity,
      group.map((entry) => entry.path),
    );
  }
  return result;
}
