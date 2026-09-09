import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../runs");
  vi.doUnmock("../access");
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("default decision service mode selection", () => {
  it.each(["production", "test", "staging"])(
    "selects connected mode in %s without reading sample data",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      const get = vi.fn();
      const context = vi.fn();
      vi.doMock("../runs", () => ({ runs: { mode: "sample", get } }));
      vi.doMock("../access", () => ({ access: { mode: "sample", context } }));
      const { decisions } = await import("./index");
      expect(decisions.mode).toBe("connected");
      expect(get).not.toHaveBeenCalled();
      expect(context).not.toHaveBeenCalled();
    },
  );

  it("uses the shared sample run adapter rather than a disconnected static catalog", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { MockReviewRunAdapter } = await import("../runs/mock-adapter");
    const { MockAccessAdapter } = await import("../access/mock-adapter");
    const runs = new MockReviewRunAdapter();
    const get = vi.spyOn(runs, "get");
    vi.doMock("../runs", () => ({ runs }));
    vi.doMock("../access", () => ({ access: new MockAccessAdapter() }));
    const { decisions } = await import("./index");
    expect(decisions.mode).toBe("sample");
    await expect(
      decisions.getContext("repo-powertoys", "sample-run-pr-41982"),
    ).resolves.toMatchObject({ version: 0 });
    expect(get).toHaveBeenCalledWith("repo-powertoys", "sample-run-pr-41982");
  });
});
