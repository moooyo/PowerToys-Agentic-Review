import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient } from "./http-client";

const root = "/api/v1/operator/repositories/repo-a/evaluations/evaluation-a";
const list = `${root}/assessments`;
const detail = `${list}/report-a`;
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
};
describe("evaluation assessment transport boundary", () => {
  it.each([
    `${root}/score-preview`,
    list,
    `${list}?page=1&pageSize=20`,
    `${list}?page=2&pageSize=50`,
    detail,
    `${detail}/cases/case-a`,
  ])("permits an exact bounded report read %s", async (path) => {
    const { client, fetch } = setup();
    await expect(client.get(path, "read report")).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("permits POST only to save a new immutable assessment", async () => {
    const { client, fetch } = setup();
    await expect(client.post(list, "save report", {})).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    `${root}/score-preview?observations=claimed`,
    `${detail}?page=1&pageSize=20`,
    `${list}/`,
    `${list}?pageSize=20&page=1`,
    `${list}?page=1&pageSize=51`,
    `${list}?page=01&pageSize=20`,
    `${list}?page=1&pageSize=20&page=2`,
    `${list}?page=1&pageSize=20&actor=forged`,
    `${list}?page=9007199254740991&pageSize=50`,
    `${list}?page=1%0A&pageSize=20`,
    `${detail}/cases`,
    `${detail}/cases/case-a?`,
    `${detail}/observations`,
    `${detail}/cases/../case-a`,
    `${detail}/cases/case%2Da`,
    `${detail}#fragment`,
  ])("rejects an ambiguous or unsupported read %s before transport", async (path) => {
    const { client, fetch } = setup();
    await expect(client.get(path, "read report")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    `${root}/score-preview`,
    detail,
    `${detail}/cases/case-a`,
    `${list}?page=1&pageSize=20`,
  ])("rejects POST on %s", async (path) => {
    const { client, fetch } = setup();
    await expect(client.post(path, "save report", {})).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["put", "patch"] as const)("does not grant %s to overwrite reports", async (method) => {
    const { client, fetch } = setup();
    await expect(client[method](detail, "replace report", {})).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
});
