import { describe, expect, it } from "vitest";
import { parseInvestigationWebhookConfig } from "../../dist/investigation/webhook-config.js";

const secret = "Synthetic webhook secret with 32 bytes";
const maximumPayloadBytes = 2 * 1_024 * 1_024;
const binding = { repositoryId: "repo-1", reviewerUserId: 200, allowedActorUserIds: [100, 101] };

describe("investigation webhook configuration", () => {
  it("enables an empty receiver with its secret while requiring a secret for bindings", () => {
    expect(
      parseInvestigationWebhookConfig(undefined, undefined, maximumPayloadBytes),
    ).toBeUndefined();
    expect(parseInvestigationWebhookConfig(secret, undefined, maximumPayloadBytes)).toEqual({
      secret,
      maximumPayloadBytes,
      bindings: [],
    });
    expect(parseInvestigationWebhookConfig(secret, [], maximumPayloadBytes)?.bindings).toEqual([]);
    expect(() =>
      parseInvestigationWebhookConfig(undefined, [binding], maximumPayloadBytes),
    ).toThrow("require a configured secret");
    expect(() => parseInvestigationWebhookConfig(undefined, [], maximumPayloadBytes)).toThrow(
      "require a configured secret",
    );
  });

  it("preserves numeric identities and freezes a detached configuration", () => {
    const input = [{ ...binding, allowedActorUserIds: [...binding.allowedActorUserIds] }];
    const config = parseInvestigationWebhookConfig(secret, input, maximumPayloadBytes);
    expect(config).toEqual({ secret, maximumPayloadBytes, bindings: [binding] });
    input[0]!.repositoryId = "changed";
    input[0]!.allowedActorUserIds.push(999);
    expect(config?.bindings).toEqual([binding]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config?.bindings)).toBe(true);
    expect(Object.isFrozen(config?.bindings[0])).toBe(true);
    expect(Object.isFrozen(config?.bindings[0]?.allowedActorUserIds)).toBe(true);
  });

  it.each(["", "x".repeat(31), "x".repeat(4_097), ` ${secret}`, `${secret}\n`])(
    "rejects a short, oversized, or inexact secret",
    (value) => {
      expect(() => parseInvestigationWebhookConfig(value, [binding], maximumPayloadBytes)).toThrow(
        "32 to 4096 UTF-8 bytes",
      );
    },
  );

  it("measures the secret in UTF-8 bytes", () => {
    const value = "é".repeat(16);
    expect(parseInvestigationWebhookConfig(value, [binding], maximumPayloadBytes)?.secret).toBe(
      value,
    );
    expect(() =>
      parseInvestigationWebhookConfig("é".repeat(15), [binding], maximumPayloadBytes),
    ).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 33_554_433, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid payload bound %s",
    (value) => {
      expect(() => parseInvestigationWebhookConfig(secret, [binding], value)).toThrow(
        "payload limit",
      );
    },
  );

  it.each([null, {}, [null], ["repo-1"], [[binding]], Array(1_025).fill(binding), Array(1)])(
    "requires a bounded list of binding objects",
    (value) => {
      expect(() => parseInvestigationWebhookConfig(secret, value, maximumPayloadBytes)).toThrow();
    },
  );

  it("rejects duplicate repository bindings and unexpected identity fields", () => {
    expect(() =>
      parseInvestigationWebhookConfig(secret, [binding, binding], maximumPayloadBytes),
    ).toThrow("unique repository IDs");
    for (const value of [
      { ...binding, reviewerLogin: "reviewer" },
      { ...binding, allowedActors: ["trusted"] },
      { repositoryId: binding.repositoryId, reviewerUserId: binding.reviewerUserId },
    ]) {
      expect(() => parseInvestigationWebhookConfig(secret, [value], maximumPayloadBytes)).toThrow(
        "contain exactly",
      );
    }
  });

  it.each(["", "*", " repo-1", "repo-1 ", "owner/repo", "x".repeat(129), 12])(
    "rejects an invalid repository ID %s",
    (repositoryId) => {
      expect(() =>
        parseInvestigationWebhookConfig(
          secret,
          [{ ...binding, repositoryId }],
          maximumPayloadBytes,
        ),
      ).toThrow("valid exact entity ID");
    },
  );

  it.each([
    0,
    -1,
    1.2,
    "200",
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects an unsafe or nonnumeric identity %s", (id) => {
    expect(() =>
      parseInvestigationWebhookConfig(
        secret,
        [{ ...binding, reviewerUserId: id }],
        maximumPayloadBytes,
      ),
    ).toThrow("positive safe numeric");
    expect(() =>
      parseInvestigationWebhookConfig(
        secret,
        [{ ...binding, allowedActorUserIds: [id] }],
        maximumPayloadBytes,
      ),
    ).toThrow("positive safe numeric");
  });

  it.each([[], [100, 100], "100", null, Array(1_025).fill(100), Array(1)])(
    "requires bounded unique actor identities",
    (allowedActorUserIds) => {
      expect(() =>
        parseInvestigationWebhookConfig(
          secret,
          [{ ...binding, allowedActorUserIds }],
          maximumPayloadBytes,
        ),
      ).toThrow("allowedActorUserIds");
    },
  );

  it("accepts the configured bounds without silently truncating identities", () => {
    const actors = Array.from({ length: 1_024 }, (_, index) => index + 1);
    const input = Array.from({ length: 1_024 }, (_, index) => ({
      repositoryId: `repo-${index}`,
      reviewerUserId: Number.MAX_SAFE_INTEGER,
      allowedActorUserIds: index === 0 ? actors : [1],
    }));
    const config = parseInvestigationWebhookConfig("x".repeat(32), input, 33_554_432);
    expect(config?.bindings).toHaveLength(1_024);
    expect(config?.bindings[0]?.allowedActorUserIds).toHaveLength(1_024);
    expect(config?.bindings[0]?.reviewerUserId).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseInvestigationWebhookConfig(secret, [binding], 1)?.maximumPayloadBytes).toBe(1);
  });
});
