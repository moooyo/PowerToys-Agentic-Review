import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient } from "./http-client";

const path =
  "/api/v1/operator/repositories/repo-one/evaluations/eval-one/cells/cell-one/results/result-one/adjudications";
const occurrence = "a".repeat(64);
const change = `${path}/${occurrence}`;
const history = `${change}/history`;
const setup = () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
};

describe("evaluation adjudication transport paths", () => {
  it.each([path, `${history}?page=1&pageSize=20`, `${history}?page=2&pageSize=50`])(
    "allows exact context and paginated history GET %s",
    async (candidate) => {
      const { client, fetch } = setup();
      await expect(client.get(candidate, "read judgments")).resolves.toEqual({});
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("allows PUT only for one exact result occurrence", async () => {
    const { client, fetch } = setup();
    await expect(client.put(change, "save judgment", {})).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    `${path}?page=1&pageSize=20`,
    `${path}/`,
    change,
    history,
    `${history}?pageSize=20&page=1`,
    `${history}?page=01&pageSize=20`,
    `${history}?page=1&pageSize=51`,
    `${history}?page=1&pageSize=0`,
    `${history}?page=1&pageSize=20&page=2`,
    `${history}?page=1&pageSize=20&actor=forged`,
    `${history}?page=1&pageSize=20#fragment`,
    `${history}?page=9007199254740991&pageSize=50`,
    `${history}?page=1%0A&pageSize=20`,
    `${path.replace("repo-one", "repo%2Done")}/${occurrence}/history?page=1&pageSize=20`,
    `${path}/${occurrence.toUpperCase()}/history?page=1&pageSize=20`,
    `${path}/${occurrence.slice(1)}/history?page=1&pageSize=20`,
  ])("rejects ambiguous or unsupported reads %s before transport", async (candidate) => {
    const { client, fetch } = setup();
    await expect(client.get(candidate, "read judgments")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([path, history, `${change}?replayOnly=true`, `${change}/`, `${path}/invalid`])(
    "rejects unsupported PUT %s before transport",
    async (candidate) => {
      const { client, fetch } = setup();
      await expect(client.put(candidate, "save judgment", {})).rejects.toThrow("allowlisted");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["post", "patch"] as const)("never grants %s on judgments", async (method) => {
    const { client, fetch } = setup();
    await expect(client[method](change, "save judgment", {})).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });
});
