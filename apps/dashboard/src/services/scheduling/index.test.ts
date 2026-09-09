import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlUnsupportedOperationError,
} from "../review-control/errors";
import { repositoryScope } from "./fixtures.testing";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
describe("scheduling adapter selection", () => {
  it("keeps development Sample mode explicitly unavailable", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { scheduling } = await import("./index");
    expect(scheduling.mode).toBe("sample");
    await expect(scheduling.get(repositoryScope)).rejects.toMatchObject({
      code: new ReviewControlUnsupportedOperationError("sample").code,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps production transport failures as failures instead of using sample data", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const fetch = vi.fn(
      async () =>
        new Response('{"code":"unavailable","message":"Unavailable."}', {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { scheduling } = await import("./index");
    expect(scheduling.mode).toBe("connected");
    await expect(scheduling.get(repositoryScope)).rejects.toMatchObject({
      code: new ReviewControlHttpError("Unavailable", {
        status: 503,
        operation: "read",
        retryable: true,
      }).code,
      status: 503,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
