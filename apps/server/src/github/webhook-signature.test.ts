import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubWebhookSignature } from "../../dist/github/webhook-signature.js";

describe("verifyGitHubWebhookSignature", () => {
  const secret = "secret";
  const body = Buffer.from('{"action":"assigned"}', "utf8");
  const digest = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts the exact HMAC-SHA256 digest", () => {
    expect(verifyGitHubWebhookSignature(body, `sha256=${digest}`, secret)).toBe(true);
  });

  it.each([
    undefined,
    "",
    digest,
    "sha1=0000000000000000000000000000000000000000",
    "sha256=not-hex",
    `sha256=${"0".repeat(64)}`,
  ])("rejects a missing or malformed signature: %s", (signature) => {
    expect(verifyGitHubWebhookSignature(body, signature, secret)).toBe(false);
  });
});
