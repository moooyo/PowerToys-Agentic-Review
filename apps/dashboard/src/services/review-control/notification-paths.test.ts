import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient } from "./http-client";

const globalPath = "/api/v1/operator/notifications";
const repository = "/api/v1/operator/repositories/repository-a/notifications";
const jobs = "/api/v1/operator/repositories/repository-a/review-runs/run-a/requests/request-a/jobs";
const create = () => {
  const fetch = vi.fn(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
};
describe("notification and exact job route allowlist", () => {
  it.each([
    `${globalPath}/overview?page=1&pageSize=20`,
    `${globalPath}/overview?page=10000000&pageSize=50`,
    `${globalPath}/summary`,
    `${globalPath}/summary?repositoryId=repository%3Aa`,
    `${repository}?limit=20&state=all&workItemKind=all`,
    `${repository}?limit=50&state=archived&workItemKind=issue&cursor=9007199254740991`,
    `${repository}?limit=1&state=read&workItemKind=pull_request&cursor=1`,
    `${jobs}?page=1&pageSize=20&jobId=job%3Aa`,
  ])("allows only the bounded canonical GET %s", async (path) => {
    const { fetch, client } = create();
    await expect(client.get(path, "notifications test")).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    globalPath,
    `${globalPath}/overview`,
    repository,
    `${globalPath}/state`,
    `${globalPath}/summary?`,
    `${globalPath}/summary?repositoryId=repo&repositoryId=other`,
    `${globalPath}/summary?repositoryId=repo%0A`,
    `${globalPath}/summary?repositoryId=repo%2Fa`,
    `${globalPath}/summary?repositoryId=repo:a`,
    `${globalPath}/overview?page=1&pageSize=51`,
    `${globalPath}/overview?page=10000001&pageSize=20`,
    `${globalPath}/overview?page=01&pageSize=20`,
    `${globalPath}/overview?page=1&pageSize=20&actor=other`,
    `${repository}?limit=20&state=all&workItemKind=all&cursor=0`,
    `${repository}?limit=20&state=all&workItemKind=all&cursor=01`,
    `${repository}?limit=20&state=all&workItemKind=all&cursor=9007199254740992`,
    `${repository}?limit=20&state=all&workItemKind=all&cursor=1&cursor=2`,
    `${repository}?limit=0&state=all&workItemKind=all`,
    `${repository}?limit=51&state=all&workItemKind=all`,
    `${repository}?limit=20&state=new&workItemKind=all`,
    `${repository}?limit=20&state=all&workItemKind=pr`,
    `${repository}?limit=20&workItemKind=all&state=all`,
    `${repository}?limit=20&state=all&workItemKind=all&page=1`,
    `${repository}?limit=20&state=all&workItemKind=all&repositoryId=other`,
    `${repository}/state`,
    `${repository}/../other/state`,
    `${repository}%2Fstate`,
    `${jobs}?page=1&pageSize=20&jobId=job%0A`,
    `${jobs}?page=1&pageSize=20&jobId=job%2Ftwo`,
    `${jobs}?page=1&pageSize=20&jobId=job&jobId=other`,
    `${jobs}?page=1&pageSize=20&workItemId=work`,
    `${jobs.replace("/run-a/requests/request-a/jobs", "")}?page=1&pageSize=20&jobId=job-a`,
    `https://example.com${repository}?limit=20&state=all&workItemKind=all`,
  ])("rejects widened or noncanonical GET %s before fetch", async (path) => {
    const { client, fetch } = create();
    await expect(client.get(path, "notifications test")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("permits exactly the repository state POST and no generic notification mutations", async () => {
    const { client, fetch } = create();
    await client.post(`${repository}/state`, "update state", {});
    for (const path of [
      repository,
      `${globalPath}/state`,
      `${globalPath}/summary`,
      `${repository}/state?actor=other`,
      `${repository}/event-a/state`,
    ])
      await expect(client.post(path, "update state", {})).rejects.toThrow("allowlisted");
    await expect(client.put(`${repository}/state`, "update state", {})).rejects.toThrow(
      "allowlisted",
    );
    await expect(client.patch(`${repository}/state`, "update state", {})).rejects.toThrow(
      "allowlisted",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});
