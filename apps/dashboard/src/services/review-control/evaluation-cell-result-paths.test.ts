import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient, MAX_DASHBOARD_RESPONSE_BYTES } from "./http-client";

const path =
  "/api/v1/operator/repositories/repository:one/evaluations/batch-one/cells/cell-one/results/result-one";
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
}
describe("evaluation cell result path boundary", () => {
  it("allows only the exact no-query GET", async () => {
    const { fetch, client } = fixture();
    await expect(client.get(path, "read evaluation result")).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    `${path}?`,
    `${path}?page=1&pageSize=20`,
    `${path}?actor=one`,
    `${path}/`,
    `${path}/content`,
    path.replace("/results/", "/result/"),
    path.replace("/cells/cell-one", "/cells"),
    path.replace("/evaluations/", "/review-runs/"),
    path.replace("cell-one", "cell%3Aone"),
    `${path}#fragment`,
  ])("rejects ambiguous or unrelated path %s", async (candidate) => {
    const { fetch, client } = fixture();
    await expect(client.get(candidate, "read evaluation result")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["post", "put", "patch"] as const)(
    "never grants %s to a result read path",
    async (method) => {
      const { fetch, client } = fixture();
      await expect(client[method](path, "result mutation", {})).rejects.toThrow("allowlisted");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("does not widen the response byte ceiling", async () => {
    const { fetch, client } = fixture();
    await expect(
      client.get(path, "read evaluation result", {
        maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES + 1,
      }),
    ).rejects.toThrow("response byte limit");
    expect(fetch).not.toHaveBeenCalled();
  });
});
