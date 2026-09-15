export type WorkspaceDirectoryNameFormat = "legacy" | "compact-v1";

const digestPattern = /^[a-f0-9]{64}(?![\s\S])/u;
const legacyNamePattern = /^attempt-[a-f0-9]{64}(?![\s\S])/u;
const compactNamePattern = /^a1-[0-9a-z]{50}(?![\s\S])/u;
const digestExclusiveUpperBound = 1n << 256n;
const compactAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

export function resolveWorkspaceDirectoryNameFormat(
  value: unknown = "legacy",
): WorkspaceDirectoryNameFormat {
  if (value !== "legacy" && value !== "compact-v1")
    throw new TypeError("Workspace directory name format must be legacy or compact-v1.");
  return value;
}

/** Encodes all 256 digest bits using a canonical alphabet without Windows case aliases. */
export function encodeAttemptDirectoryName(
  digestHex: string,
  format: WorkspaceDirectoryNameFormat = "legacy",
): string {
  if (typeof digestHex !== "string" || !digestPattern.test(digestHex))
    throw new TypeError("The workspace identity must be a 64-character lowercase SHA-256 digest.");
  const selectedFormat = resolveWorkspaceDirectoryNameFormat(format);
  if (selectedFormat === "legacy") return `attempt-${digestHex}`;
  return `a1-${BigInt(`0x${digestHex}`).toString(36).padStart(50, "0")}`;
}

/** Returns the full digest only for names the Worker can create without normalization. */
export function decodeAttemptDirectoryName(name: string): string | null {
  if (typeof name !== "string") return null;
  if (legacyNamePattern.test(name)) return name.slice("attempt-".length);
  if (!compactNamePattern.test(name)) return null;
  const encoded = name.slice("a1-".length);
  let value = 0n;
  for (const character of encoded) {
    value = value * 36n + BigInt(compactAlphabet.indexOf(character));
    if (value >= digestExclusiveUpperBound) return null;
  }
  if (value.toString(36).padStart(50, "0") !== encoded) return null;
  return value.toString(16).padStart(64, "0");
}

export function isStrictAttemptDirectoryName(name: string): boolean {
  return decodeAttemptDirectoryName(name) !== null;
}
