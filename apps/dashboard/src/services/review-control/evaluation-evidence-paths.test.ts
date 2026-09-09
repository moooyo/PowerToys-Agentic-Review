import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient, MAX_DASHBOARD_RESPONSE_BYTES } from "./http-client";

const path =
  "/api/v1/operator/repositories/repo-one/evaluations/eval-one/cells/cell-one/results/result-one/evidence";
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
};
describe("evaluation evidence JSON paths", () => {
  it.each([path, `${path}/asset:one`])(
    "allows only exact list and manifest GET %s",
    async (candidate) => {
      const { client, fetch } = setup();
      await expect(client.get(candidate, "read evidence")).resolves.toEqual({});
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([
    `${path}?`,
    `${path}?page=1`,
    `${path}/asset/content`,
    `${path}/asset?download=true`,
    `${path}/asset/`,
    `${path}/bad%3Aid`,
    `${path}/../asset`,
    `${path}/asset#fragment`,
  ])("does not admit content or ambiguous paths %s through the JSON client", async (candidate) => {
    const { client, fetch } = setup();
    await expect(client.get(candidate, "read evidence")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["post", "put", "patch"] as const)("does not grant %s on evidence", async (method) => {
    const { client, fetch } = setup();
    await expect(client[method](path, "change evidence", {})).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps JSON projections within two MiB", async () => {
    const { client, fetch } = setup();
    await expect(
      client.get(path, "read evidence", { maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES + 1 }),
    ).rejects.toThrow("response byte limit");
    expect(fetch).not.toHaveBeenCalled();
  });
});
