import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubWebhookSecret = string | Buffer;

const signaturePattern = /^sha256=([0-9a-fA-F]{64})$/;
const invalidSignatureDigest = Buffer.alloc(32);

export const verifyGitHubWebhookSignature = (
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: GitHubWebhookSecret,
): boolean => {
  const expectedDigest = createHmac("sha256", secret).update(rawBody).digest();
  const match = signatureHeader === undefined ? null : signaturePattern.exec(signatureHeader);
  const suppliedDigest =
    match === null ? invalidSignatureDigest : Buffer.from(match[1] ?? "", "hex");
  const digestMatches = timingSafeEqual(expectedDigest, suppliedDigest);

  return match !== null && digestMatches;
};
