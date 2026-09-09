import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient, MAX_DASHBOARD_RESPONSE_BYTES } from "./http-client";

const base = "/api/v1/operator/repositories/repository:one";
const sources = `${base}/evaluation-sources`;
const suites = `${base}/evaluation-suites`;
const suite = `${suites}/suite-one`;
const versions = `${suite}/versions`;
const version = `${versions}/version-one`;
const details = [`${sources}/source-one`, suite, `${version}/cases/case-one`];
const create = (body = "{}") => {
  const fetch = vi.fn(
    async () => new Response(body, { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
};

describe("evaluation management path and response limits", () => {
  it.each([
    sources,
    suites,
    versions,
    ...details,
    version,
    `${version}/cases`,
    `${sources}?page=1&pageSize=20`,
    `${suites}?page=2&pageSize=50`,
    `${versions}?page=9007199254740991&pageSize=1`,
  ])("allows the exact GET %s", async (path) => {
    const { fetch, client } = create();
    await expect(client.get(path, "evaluation path")).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([sources, suites, versions])("allows only POST writes on %s", async (path) => {
    const { fetch, client } = create();
    await expect(client.post(path, "evaluation write", {})).resolves.toEqual({});
    await expect(client.put(path, "evaluation write", {})).rejects.toThrow("allowlisted");
    await expect(client.patch(path, "evaluation write", {})).rejects.toThrow("allowlisted");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("allows PUT only for the suite draft", async () => {
    const { fetch, client } = create();
    await expect(client.put(`${suite}/draft`, "evaluation draft", {})).resolves.toEqual({});
    await expect(client.post(`${suite}/draft`, "evaluation draft", {})).rejects.toThrow(
      "allowlisted",
    );
    await expect(client.get(`${suite}/draft`, "evaluation draft")).rejects.toThrow("allowlisted");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    `${sources}?page=0&pageSize=20`,
    `${sources}?page=01&pageSize=20`,
    `${sources}?page=1&pageSize=51`,
    `${sources}?pageSize=20&page=1`,
    `${sources}?page=1&pageSize=20&actor=other`,
    `${sources}?page=1&page=2&pageSize=20`,
    `${sources}?page=9007199254740991&pageSize=50`,
    `${sources}?page=1`,
    `${sources}?`,
    `${sources}/source-one?`,
    `${version}?page=1&pageSize=20`,
    `${version}/cases?page=1&pageSize=20`,
    `${version}/cases/case-one?sourceId=other`,
    `${suite}/versions/../version-one`,
    `${suites}/suite%3Aone`,
    `${sources}/source-one#fragment`,
    `${version}/cases/case-one/jobs`,
    `/api/v1/operator/evaluation-sources`,
  ])("rejects noncanonical or unrelated GET %s", async (path) => {
    const { fetch, client } = create();
    await expect(client.get(path, "evaluation path")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(details)("reads a permitted detail body above 2 MiB on %s", async (path) => {
    const value = "x".repeat(MAX_DASHBOARD_RESPONSE_BYTES + 4096);
    const { client } = create(JSON.stringify({ value }));
    await expect(client.get(path, "evaluation detail")).resolves.toEqual({ value });
  });

  it.each([
    sources,
    `${sources}?page=1&pageSize=20`,
    suites,
    versions,
    version,
    `${version}/cases`,
    "/api/v1/dashboard/system",
  ])("does not raise the response budget for other reads at %s", async (path) => {
    const { fetch, client } = create();
    await expect(
      client.get(path, "evaluation budget", { maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES + 1 }),
    ).rejects.toThrow("response byte limit");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(details)("enforces the exact detail ceiling on %s", async (path) => {
    const { fetch, client } = create();
    await expect(
      client.get(path, "evaluation budget", {
        maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES + 65_537,
      }),
    ).rejects.toThrow("response byte limit");
    expect(fetch).not.toHaveBeenCalled();
    const large = create(
      JSON.stringify({ value: "x".repeat(MAX_DASHBOARD_RESPONSE_BYTES + 65_536) }),
    );
    await expect(large.client.get(path, "evaluation budget")).rejects.toThrow();
  });
});
