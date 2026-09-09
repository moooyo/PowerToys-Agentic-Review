import { describe, expect, it, vi } from "vitest";
import { DashboardHttpClient, MAX_DASHBOARD_RESPONSE_BYTES } from "./http-client";

const root = "/api/v1/operator/repositories/repository:one";
const batches = `${root}/evaluations`;
const batch = `${batches}/batch-one`;
const prompts = `${root}/evaluation-prompt-options`;
function fixture(body = "{}") {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(body, { headers: { "content-type": "application/json" } }),
  );
  return { fetch, client: new DashboardHttpClient({ fetch }) };
}

describe("evaluation batch transport boundaries", () => {
  it.each([
    batches,
    batch,
    `${batch}/matrix`,
    `${batches}?page=1&pageSize=20`,
    `${batches}?page=9007199254740991&pageSize=1`,
    `${batches}?page=1&pageSize=50&suiteId=suite%3Aone`,
    `${batches}?page=1&pageSize=20&workflowKind=pr_ui`,
    `${batches}?page=1&pageSize=20&suiteId=suite-one&workflowKind=issue_validation`,
    `${prompts}?page=1&pageSize=20&workflowKind=pr_static_build`,
    `${prompts}?page=2&pageSize=50&workflowKind=issue_triage`,
  ])("allows the exact scoped GET %s", async (path) => {
    const { fetch, client } = fixture();
    await expect(client.get(path, "evaluation batch read")).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([batches, `${batch}/cancel`])("allows only POST for the mutation %s", async (path) => {
    const { fetch, client } = fixture();
    await expect(
      client.post(path, "evaluation mutation", { changeId: "original-request" }),
    ).resolves.toEqual({});
    await expect(client.put(path, "evaluation mutation", {})).rejects.toThrow("allowlisted");
    await expect(client.patch(path, "evaluation mutation", {})).rejects.toThrow("allowlisted");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"changeId":"original-request"}');
  });

  it.each([
    `${batch}/cancel`,
    `${batch}/result`,
    `${batch}/cells/cell-one`,
    `${batch}/matrix?page=1&pageSize=20`,
    `${batch}?page=1&pageSize=20`,
    `${batches}?`,
    `${batches}?page=1`,
    `${batches}?page=0&pageSize=20`,
    `${batches}?page=01&pageSize=20`,
    `${batches}?page=1&pageSize=51`,
    `${batches}?page=9007199254740991&pageSize=50`,
    `${batches}?pageSize=20&page=1`,
    `${batches}?page=1&pageSize=20&actor=other`,
    `${batches}?page=1&pageSize=20&suiteId=`,
    `${batches}?page=1&pageSize=20&suiteId=..`,
    `${batches}?page=1&pageSize=20&suiteId=suite%0A`,
    `${batches}?page=1&pageSize=20&suiteId=suite-one&suiteId=suite-two`,
    `${batches}?page=1&pageSize=20&workflowKind=pr_ui&suiteId=suite-one`,
    `${batches}?page=1&pageSize=20&workflowKind=pull_request`,
    `${batches}?page=1&pageSize=20&workflowKind=pr_ui%0A`,
    `${batches}/batch-one/../batch-two`,
    `${batches}/batch%3Aone`,
    `${batch}/matrix#fragment`,
    prompts,
    `${prompts}?page=1&pageSize=20`,
    `${prompts}?workflowKind=issue_validation`,
    `${prompts}?page=1&pageSize=20&workflowKind=pr_ui&suiteId=suite-one`,
    `/api/v1/operator/evaluations/batch-one`,
  ])("refuses unrelated or ambiguous GET %s before fetching", async (path) => {
    const { fetch, client } = fixture();
    await expect(client.get(path, "evaluation boundary")).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    batch,
    `${batch}/matrix`,
    `${batch}/dispatch`,
    `${batch}/cancel?replayOnly=true`,
    prompts,
  ])("does not authorize a POST merely because a related read exists at %s", async (path) => {
    const { fetch, client } = fixture();
    await expect(client.post(path, "evaluation boundary", {})).rejects.toThrow("allowlisted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([batches, batch, `${batch}/matrix`, `${prompts}?page=1&pageSize=20&workflowKind=pr_ui`])(
    "keeps summary responses within the existing 2 MiB ceiling at %s",
    async (path) => {
      const { fetch, client } = fixture();
      await expect(
        client.get(path, "evaluation size", { maxResponseBytes: MAX_DASHBOARD_RESPONSE_BYTES + 1 }),
      ).rejects.toThrow("response byte limit");
      expect(fetch).not.toHaveBeenCalled();
      const oversized = fixture(
        JSON.stringify({ value: "x".repeat(MAX_DASHBOARD_RESPONSE_BYTES) }),
      );
      await expect(oversized.client.get(path, "evaluation size")).rejects.toThrow();
    },
  );
});
