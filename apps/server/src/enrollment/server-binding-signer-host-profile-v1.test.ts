import { describe, expect, it } from "vitest";

import * as profileModule from "./server-binding-signer-host-profile-v1.js";

describe("dormant Server binding signer-host production profile v1", () => {
  it("exposes only one frozen unavailable loader", async () => {
    expect(Object.keys(profileModule)).toEqual(["loadProductionServerBindingSignerHostProfileV1"]);
    expect(profileModule.loadProductionServerBindingSignerHostProfileV1.length).toBe(0);
    expect(Object.isFrozen(profileModule.loadProductionServerBindingSignerHostProfileV1)).toBe(
      true,
    );
    await expect(profileModule.loadProductionServerBindingSignerHostProfileV1()).rejects.toThrow(
      "The production Server binding signer-host profile is unavailable.",
    );
  });
});
