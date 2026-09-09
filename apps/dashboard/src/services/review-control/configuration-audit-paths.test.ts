import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient } from "./http-client";

const repository = "/api/v1/operator/repositories/repo-one/configuration-audit";
const global = "/api/v1/operator/configuration-audit";

describe("configuration audit read allowlist", () => {
  it.each([
    `${repository}?page=1&pageSize=20`,
    `${repository}?page=10000000&pageSize=1`,
    `${repository}/repository/event:one`,
    `${repository}/prompt/event:one`,
    `${global}?page=2&pageSize=10`,
    `${global}?page=1&pageSize=20&templateId=prompt%3Aone`,
    `${global}/event:one`,
  ])("allows the canonical bounded read %s", async (path) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { headers: { "Content-Type": "application/json" } }));
    const client = new DashboardHttpClient({ fetch });
    await expect(client.get(path, "audit test")).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(path);
  });

  it.each([
    repository,
    global,
    `${repository}?page=1&pageSize=21`,
    `${global}?page=1&pageSize=21`,
    `${global}?page=10000001&pageSize=1`,
    `${global}?page=0&pageSize=20`,
    `${global}?page=01&pageSize=20`,
    `${global}?page=1&pageSize=0`,
    `${global}?page=1&pageSize=20&templateId=`,
    `${global}?page=1&pageSize=20&templateId=prompt%0A`,
    `${global}?page=1&pageSize=20&templateId=prompt%2Fone`,
    `${global}?page=1&pageSize=20&templateId=prompt%253Aone`,
    `${global}?page=1&pageSize=20&templateId=prompt:one`,
    `${global}?page=1&pageSize=20&templateId=prompt&templateId=other`,
    `${global}?page=1&pageSize=20&repositoryId=repo-one`,
    `${global}?pageSize=20&page=1`,
    `${global}?page=1&pageSize=20&page=2`,
    `${global}?page=1&pageSize=20&source=prompt`,
    `${repository}?page=1&pageSize=20&templateId=prompt`,
    `${repository}/access/event-one`,
    `${repository}/repository/event-one?page=1&pageSize=20`,
    `${repository}/prompt/event%3Aone`,
    `${repository}/prompt/../event-one`,
    `${global}/event-one?templateId=prompt`,
    `${global}/prompt/event-one`,
    `${global}/event-one#snapshot`,
    `${global}/event-one\n`,
  ])("rejects a noncanonical or widened read before fetch: %s", async (path) => {
    const fetch = vi.fn();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.get(path, "audit test")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([repository, `${repository}/prompt/event-one`, global, `${global}/event-one`])(
    "never permits audit writes at %s",
    async (path) => {
      const fetch = vi.fn();
      const client = new DashboardHttpClient({ fetch });
      await expect(client.post(path, "audit test", {})).rejects.toThrow("allowlisted");
      await expect(client.patch(path, "audit test", {})).rejects.toThrow("allowlisted");
      await expect(client.put(path, "audit test", {})).rejects.toThrow("allowlisted");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
