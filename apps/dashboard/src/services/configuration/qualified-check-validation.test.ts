import { ReproductionPreconditionSchema } from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { ReviewControlRequestError } from "../review-control/errors";
import { validateRequest } from "./validation";

describe("configuration wire qualified check identities", () => {
  it("accepts a maximum-length qualified check ID", () => {
    const value = { kind: "check_passed", checkId: `${"p".repeat(128)}:${"s".repeat(128)}` };
    expect(value.checkId.length).toBe(257);
    expect(validateRequest(ReproductionPreconditionSchema, value, "validate reproduction")).toEqual(
      value,
    );
  });

  it.each([
    "unqualified",
    "profile:check\n",
    "profile:check\r",
    `${"p".repeat(128)}:${"s".repeat(129)}`,
    "profile:/path",
  ])("rejects invalid qualified check IDs: %j", (checkId) => {
    expect(() =>
      validateRequest(
        ReproductionPreconditionSchema,
        { kind: "check_passed", checkId },
        "validate reproduction",
      ),
    ).toThrow(ReviewControlRequestError);
  });

  it.each(["id", "profileId", "secretRef"])("preserves the 128-character bound for %s", (key) => {
    const schema = Type.Object({ [key]: Type.String() });
    expect(() =>
      validateRequest(schema, { [key]: "p".repeat(129) }, "validate configuration"),
    ).toThrow(ReviewControlRequestError);
    expect(validateRequest(schema, { [key]: "p".repeat(128) }, "validate configuration")).toEqual({
      [key]: "p".repeat(128),
    });
  });
});
