import { createHash } from "node:crypto";

const gitObjectIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;

/**
 * Identifies the reviewed comparison, not only the contributor's head commit.
 * A base branch advance changes the diff even when headSha remains unchanged.
 */
export const createPullRequestRevisionKey = (baseSha: string, headSha: string): string => {
  const normalizedBaseSha = baseSha.toLowerCase();
  const normalizedHeadSha = headSha.toLowerCase();
  if (!gitObjectIdPattern.test(normalizedBaseSha) || !gitObjectIdPattern.test(normalizedHeadSha)) {
    throw new TypeError(
      "Pull request revision object IDs must be 40 or 64 hexadecimal characters.",
    );
  }
  return createHash("sha256")
    .update(normalizedBaseSha)
    .update("\0")
    .update(normalizedHeadSha)
    .digest("hex");
};
