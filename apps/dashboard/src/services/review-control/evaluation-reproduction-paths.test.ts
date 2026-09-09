import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient, MAX_DASHBOARD_RESPONSE_BYTES } from "./http-client";

const root = "/api/v1/operator/repositories/repository-a";
const source = `${root}/evaluation-sources/source-a/reproduction`;
const plan = `${root}/evaluations/evaluation-a/reproduction`;
const cell = `${root}/evaluations/evaluation-a/cells/cell-a/reproduction`;
const preview = `${root}/evaluation-reproduction/preview`;
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
}
describe("evaluation reproduction path boundary", () => {
  it.each([source, plan, cell])("allows only the exact scoped read %s", async (path) => {
    const { fetch, client } = fixture();
    await expect(client.get(path, "read reproduction")).resolves.toEqual({});
    await expect(client.post(path, "write reproduction", {})).rejects.toThrow("allowlisted");
    await expect(client.put(path, "write reproduction", {})).rejects.toThrow("allowlisted");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("allows only POST for the read-only mapping preview", async () => {
    const { fetch, client } = fixture();
    await expect(client.post(preview, "preview reproduction", {})).resolves.toEqual({});
    await expect(client.get(preview, "preview reproduction")).rejects.toThrow("allowlisted");
    await expect(client.patch(preview, "preview reproduction", {})).rejects.toThrow("allowlisted");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    `${source}?page=1`,
    `${plan}?`,
    `${cell}/execute`,
    `${cell}#fragment`,
    `${root}/evaluations/evaluation-a/cells/../reproduction`,
    `${root}/evaluation-sources/source%3Aa/reproduction`,
  ])("rejects ambiguous or execution paths %s before fetching", async (path) => {
    const { fetch, client } = fixture();
    await expect(client.get(path, "reproduction boundary")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([source, cell])("limits the document envelope extension to %s", async (path) => {
    const { fetch, client } = fixture();
    await expect(
      client.get(path, "source size", {
        maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES + 40 * 1024,
      }),
    ).resolves.toEqual({});
    await expect(
      client.get(plan, "plan size", { maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES + 1 }),
    ).rejects.toThrow("response byte limit");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
