import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient, MAX_DASHBOARD_RESPONSE_BYTES } from "./http-client";

const root =
  "/api/v1/operator/repositories/repository:one/evaluations/batch-one/cells/cell-one/model-invocations";
const path = `${root}?page=1&pageSize=10`;
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
}

describe("evaluation model invocation diagnostic paths", () => {
  it.each([path, `${root}?page=2&pageSize=5`, `${root}?page=9007199254740991&pageSize=1`])(
    "allows the canonical scoped read %s",
    async (candidate) => {
      const { fetch, client } = fixture();
      await expect(client.get(candidate, "read model invocation diagnostics")).resolves.toEqual({});
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        method: "GET",
      });
    },
  );

  it.each([
    root,
    `${root}?`,
    `${root}?page=1`,
    `${root}?page=1&pageSize=11`,
    `${root}?page=1&pageSize=0`,
    `${root}?page=0&pageSize=10`,
    `${root}?page=01&pageSize=10`,
    `${root}?page=1&pageSize=01`,
    `${root}?page=1e1&pageSize=10`,
    `${root}?page=1.0&pageSize=10`,
    `${root}?page=9007199254740991&pageSize=10`,
    `${root}?pageSize=10&page=1`,
    `${path}&page=2`,
    `${path}&pageSize=1`,
    `${path}&actor=admin`,
    `${path}&repositoryId=other`,
    `${path}&attemptId=attempt-one`,
    `${path}&state=matched`,
    `${path}&include=receipts`,
    `${path}#fragment`,
    `${path}\n`,
    `${root}/?page=1&pageSize=10`,
    `${root}/invocation-one?page=1&pageSize=10`,
    path.replace("/model-invocations?", "/model-invocations/receipts?"),
    path.replace("/evaluations/", "/evaluation-batches/"),
    path.replace("/cells/cell-one", "/cells"),
    path.replace("cell-one", "cell%3Aone"),
    path.replace("cell-one", "cell-one/../cell-two"),
    path.replace("repository:one", "repository%3Aone"),
    path.replace("batch-one", "batch%2Done"),
  ])("rejects ambiguous or unrelated reads before fetch: %s", async (candidate) => {
    const { fetch, client } = fixture();
    await expect(client.get(candidate, "read model invocation diagnostics")).rejects.toThrow(
      "allowlisted",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["post", "put", "patch"] as const)(
    "does not authorize %s diagnostics mutations",
    async (method) => {
      const { fetch, client } = fixture();
      await expect(client[method](path, "write diagnostics", {})).rejects.toThrow("allowlisted");
      await expect(client[method](root, "write diagnostics", {})).rejects.toThrow("allowlisted");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves the Dashboard 2 MiB response ceiling", async () => {
    const { fetch, client } = fixture();
    await expect(
      client.get(path, "read diagnostics", {
        maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES + 1,
      }),
    ).rejects.toThrow("response byte limit");
    expect(fetch).not.toHaveBeenCalled();
  });
});
