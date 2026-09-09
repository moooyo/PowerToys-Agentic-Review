import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { SelfOrAllowlistPolicySchema } from "./scheduling.js";

const policy = {
  kind: "self_or_allowlist",
  policyVersion: 1,
  schedulingTargetGithubUserId: 100,
  allowlistedActorGithubUserIds: [200],
  unknownActorPolicy: "deny",
};

describe("revision authorization policy snapshots", () => {
  it.each(["require_new_authorization", "inherit_authorized_epoch"])(
    "accepts the explicit %s scope",
    (newRevisionPolicy) => {
      expect(Value.Check(SelfOrAllowlistPolicySchema, { ...policy, newRevisionPolicy })).toBe(true);
    },
  );

  it("keeps legacy snapshots readable without fabricating an inheritance scope", () => {
    expect(Value.Check(SelfOrAllowlistPolicySchema, policy)).toBe(true);
    expect(policy).not.toHaveProperty("newRevisionPolicy");
  });

  it.each([null, true, "", "inherit", " inherit_authorized_epoch "])(
    "rejects unsupported serialized scope %s",
    (newRevisionPolicy) => {
      expect(Value.Check(SelfOrAllowlistPolicySchema, { ...policy, newRevisionPolicy })).toBe(
        false,
      );
    },
  );
});
