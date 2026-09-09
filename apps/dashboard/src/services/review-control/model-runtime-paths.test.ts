import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient } from "./http-client";

const root = "/api/v1/operator/model-runtimes";
const registration = `${root}/runtime:one`;
const options = "/api/v1/operator/repositories/repository:one/evaluation-model-runtime-options";
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
}
describe("Model runtime registry transport paths", () => {
  it.each([
    registration,
    `${root}?page=1&pageSize=20`,
    `${root}?page=2&pageSize=50&enabled=true`,
    `${root}?page=1&pageSize=20&enabled=false`,
    `${registration}/history?page=1&pageSize=50`,
    `${options}?page=1&pageSize=20`,
    `${options}?page=9007199254740991&pageSize=1`,
  ])("accepts the canonical registry read %s", async (path) => {
    const f = fixture();
    await expect(f.client.get(path, "read model runtime registry")).resolves.toEqual({});
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
  });
  it("allows registration POST and control PATCH without admitting other write routes", async () => {
    const f = fixture();
    await f.client.post(root, "register expected runtime", { changeId: "register" });
    await f.client.patch(registration, "change runtime selection", { changeId: "control" });
    await expect(f.client.put(registration, "replace runtime", {})).rejects.toThrow("allowlisted");
    await expect(f.client.patch(root, "replace registry", {})).rejects.toThrow("allowlisted");
    await expect(f.client.post(registration, "change runtime", {})).rejects.toThrow("allowlisted");
    await expect(f.client.post(`${registration}/history`, "create audit", {})).rejects.toThrow(
      "allowlisted",
    );
    await expect(f.client.post(options, "write options", {})).rejects.toThrow("allowlisted");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    `${root}?`,
    `${root}?page=1`,
    `${root}?page=01&pageSize=20`,
    `${root}?page=0&pageSize=20`,
    `${root}?page=1&pageSize=51`,
    `${root}?pageSize=20&page=1`,
    `${root}?page=1&pageSize=20&enabled=1`,
    `${root}?page=1&pageSize=20&enabled=true&enabled=false`,
    `${root}?page=1&pageSize=20&actor=admin`,
    `${root}?page=9007199254740991&pageSize=50`,
    `${registration}?page=1&pageSize=20`,
    `${registration}/history?page=1&pageSize=20&enabled=true`,
    `${options}?page=1&pageSize=20&enabled=true`,
    `${registration}/../runtime-two`,
    `${root}/runtime%3Aone`,
    `${registration}#fragment`,
    `${registration}\n`,
    `${root}/runtime-one/credentials`,
    `${options}?page=1&pageSize=20&registrationId=runtime-one`,
  ])("rejects ambiguous or unsupported reads before fetch: %s", async (path) => {
    const f = fixture();
    await expect(f.client.get(path, "read registry")).rejects.toThrow("allowlisted");
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
