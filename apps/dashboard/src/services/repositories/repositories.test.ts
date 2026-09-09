import type { RepositoryCreateRequest, RepositoryUpdateRequest } from "@agentic-review/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import {
  DashboardHttpClient,
  MAX_DASHBOARD_RESPONSE_BYTES,
  OPERATOR_REPOSITORIES_PATH,
  OPERATOR_WORKER_NODES_PATH,
} from "../review-control/http-client";
import type { RepositoryListQuery } from "./adapter";
import { HttpRepositoryAdapter } from "./http-adapter";
import { MockRepositoryAdapter, sampleRepositories } from "./mock-adapter";

const [firstSample, secondSample] = sampleRepositories;
if (firstSample === undefined || secondSample === undefined) {
  throw new Error("The repository tests require the two fixed sample repositories.");
}
const repository = structuredClone(firstSample);
const otherRepository = structuredClone(secondSample);
const { authorizationPolicy: _policy, ...summary } = repository;
const path = `${OPERATOR_REPOSITORIES_PATH}/${repository.id}`;
const createRequest: RepositoryCreateRequest = {
  githubRepositoryId: repository.githubRepositoryId,
  fullName: repository.fullName,
  enabled: false,
};
const metadata = {
  githubRepositoryId: repository.githubRepositoryId,
  githubNodeId: "sample-repository-184456251",
  ownerLogin: "microsoft",
  name: "PowerToys",
  fullName: repository.fullName,
  htmlUrl: `https://github.com/${repository.fullName}`,
  defaultBranch: "main",
  isPrivate: false,
};
const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
const adapterWith = (value: unknown) => {
  const fetch = vi.fn(async () => jsonResponse(value));
  return { fetch, adapter: new HttpRepositoryAdapter({ fetch }) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("repository HTTP adapter", () => {
  it("sends every repository operation through the authenticated same-origin client", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [summary], total: 1 }))
      .mockResolvedValueOnce(jsonResponse(repository))
      .mockResolvedValueOnce(jsonResponse(metadata))
      .mockResolvedValueOnce(jsonResponse(repository, 201))
      .mockResolvedValueOnce(jsonResponse({ ...repository, enabled: false, version: 2 }))
      .mockResolvedValueOnce(jsonResponse(repository));
    const adapter = new HttpRepositoryAdapter({ fetch });

    await expect(adapter.list()).resolves.toEqual({ items: [summary], total: 1 });
    await expect(adapter.get(repository.id)).resolves.toEqual(repository);
    await expect(adapter.resolve(repository.fullName)).resolves.toEqual(metadata);
    await expect(adapter.create(createRequest)).resolves.toEqual(repository);
    await expect(
      adapter.update(repository.id, { expectedVersion: 1, enabled: false }),
    ).resolves.toMatchObject({ enabled: false, version: 2 });
    await expect(adapter.checkConnection(repository.id)).resolves.toEqual(repository);

    expect(fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body])).toEqual(
      [
        [`${OPERATOR_REPOSITORIES_PATH}?page=1&pageSize=50&search=`, "GET", undefined],
        [path, "GET", undefined],
        [
          `${OPERATOR_REPOSITORIES_PATH}/resolve`,
          "POST",
          JSON.stringify({ fullName: repository.fullName }),
        ],
        [OPERATOR_REPOSITORIES_PATH, "POST", JSON.stringify(createRequest)],
        [path, "PATCH", JSON.stringify({ expectedVersion: 1, enabled: false })],
        [`${path}/check-connection`, "POST", "{}"],
      ],
    );
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({
        cache: "no-store",
        credentials: "include",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("encodes search as a value without adding authority or query parameters", async () => {
    const { adapter, fetch } = adapterWith({ items: [], total: 0 });
    await adapter.list({
      page: 2,
      pageSize: 20,
      search: "microsoft/PowerToys &enabled=true#fragment",
    });
    expect(fetch).toHaveBeenCalledWith(
      `${OPERATOR_REPOSITORIES_PATH}?page=2&pageSize=20&search=microsoft%2FPowerToys+%26enabled%3Dtrue%23fragment`,
      expect.anything(),
    );
  });

  it.each([
    "",
    "../worker-nodes",
    "repo/other",
    "repo%2Fother",
    "repo?enabled=true",
    "repo#fragment",
    "repo\n",
    "a".repeat(129),
  ])("rejects invalid IDs before any read or mutation: %j", async (id) => {
    const { adapter, fetch } = adapterWith(repository);
    await expect(adapter.get(id)).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.update(id, { expectedVersion: 1, enabled: false })).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    await expect(adapter.checkConnection(id)).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 50 },
    { pageSize: 51 },
    { pageSize: 200 },
    { search: "a".repeat(513) },
    { enabled: true },
    { page: undefined },
  ])("rejects malformed list queries before fetch: %j", async (query) => {
    const { adapter, fetch } = adapterWith({ items: [], total: 0 });
    await expect(adapter.list(query as RepositoryListQuery)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { fullName: "microsoft/PowerToys", githubRepositoryId: 0 },
    { fullName: "https://github.com/microsoft/PowerToys", githubRepositoryId: 1 },
    { fullName: "microsoft/PowerToys\n", githubRepositoryId: 1 },
    { ...createRequest, connectionStatus: "ready" },
    { ...createRequest, enabled: undefined },
  ])("rejects invalid or server-owned create fields: %j", async (input) => {
    const { adapter, fetch } = adapterWith(repository);
    await expect(adapter.create(input as RepositoryCreateRequest)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { expectedVersion: 1 },
    { expectedVersion: 0, enabled: true },
    { expectedVersion: 1, enabled: undefined },
    { expectedVersion: 1, fullName: "owner/other" },
    { expectedVersion: 1, githubRepositoryId: 2 },
    { expectedVersion: 1, connectionStatus: "ready" },
    { expectedVersion: 1, authorizationPolicy: {} },
  ])("rejects invalid updates before fetch: %j", async (input) => {
    const { adapter, fetch } = adapterWith(repository);
    await expect(
      adapter.update(repository.id, input as RepositoryUpdateRequest),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid repository names before metadata resolution", async () => {
    const { adapter, fetch } = adapterWith(metadata);
    for (const name of ["PowerToys", "owner/..", "owner/repo?query", "owner/repo\n"]) {
      await expect(adapter.resolve(name)).rejects.toBeInstanceOf(ReviewControlRequestError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["get", "update", "checkConnection"] as const)(
    "rejects a different repository returned by %s",
    async (operation) => {
      const { adapter } = adapterWith(otherRepository);
      const promise =
        operation === "update"
          ? adapter.update(repository.id, { expectedVersion: 1, enabled: false })
          : adapter[operation](repository.id);
      await expect(promise).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );

  it.each([
    null,
    {},
    { ...repository, unexpected: true },
    { ...repository, updatedAt: "yesterday" },
    { ...repository, version: 0 },
    { ...repository, reviewerGithubLogin: "reviewer" },
  ])("rejects malformed repository responses: %j", async (value) => {
    const { adapter } = adapterWith(value);
    await expect(adapter.get(repository.id)).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { items: [repository], total: 1 },
    { items: [summary], total: 0 },
    { items: [summary, summary], total: 2 },
    { items: [], total: -1 },
    { items: [], total: 0, nextPage: 2 },
    { items: [{ ...summary, id: "repo\n" }], total: 1 },
  ])("rejects invalid repository lists: %j", async (value) => {
    const { adapter } = adapterWith(value);
    await expect(adapter.list()).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("rejects responses that exceed the requested page size or total", async () => {
    const { authorizationPolicy: _otherPolicy, ...otherSummary } = otherRepository;
    await expect(
      adapterWith({ items: [summary, otherSummary], total: 2 }).adapter.list({ pageSize: 1 }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      adapterWith({ items: [summary], total: 1 }).adapter.list({ page: 2 }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("accepts exactly 50 repositories and rejects a 51-item response", async () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      ...summary,
      id: `repo-${index + 1}`,
      githubRepositoryId: index + 1,
      fullName: `owner/repository-${index + 1}`,
    }));
    await expect(
      adapterWith({ items: items.slice(0, 50), total: 51 }).adapter.list({ pageSize: 50 }),
    ).resolves.toMatchObject({ total: 51, items: items.slice(0, 50) });
    await expect(adapterWith({ items, total: 51 }).adapter.list()).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each([
    { ...metadata, fullName: "owner/other" },
    { ...metadata, ownerLogin: "other" },
    { ...metadata, htmlUrl: "not a uri" },
    { ...metadata, token: "hidden" },
  ])("rejects inconsistent or malformed GitHub metadata: %j", async (value) => {
    await expect(adapterWith(value).adapter.resolve(repository.fullName)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("rejects a different identity after creation", async () => {
    await expect(adapterWith(otherRepository).adapter.create(createRequest)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(
      adapterWith({ ...repository, githubRepositoryId: 2 }).adapter.create(createRequest),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("preserves HTTP conflicts and never substitutes sample data on failed production requests", async () => {
    const conflictAdapter = new HttpRepositoryAdapter({
      fetch: vi.fn(async () =>
        jsonResponse(
          { code: "PLATFORM_CONFLICT", message: "Reload before saving.", retryable: false },
          409,
        ),
      ),
    });
    await expect(
      conflictAdapter.update(repository.id, { expectedVersion: 1, enabled: false }),
    ).rejects.toMatchObject({ status: 409, serverCode: "PLATFORM_CONFLICT", retryable: false });
    const unavailableAdapter = new HttpRepositoryAdapter({
      fetch: vi.fn(async () => {
        throw new TypeError("Offline");
      }),
    });
    await expect(unavailableAdapter.list()).rejects.toBeInstanceOf(ReviewControlNetworkError);
  });

  it("preserves response-size limits on repository calls", async () => {
    const adapter = new HttpRepositoryAdapter({
      fetch: vi.fn(
        async () =>
          new Response("{}", {
            headers: {
              "content-type": "application/json",
              "content-length": String(MAX_DASHBOARD_RESPONSE_BYTES + 1),
            },
          }),
      ),
    });
    await expect(adapter.get(repository.id)).rejects.toBeInstanceOf(
      ReviewControlResponseTooLargeError,
    );
  });
});

describe("repository HTTP path boundaries", () => {
  it.each([
    `https://elsewhere.example${path}`,
    `//elsewhere.example${path}`,
    `${path}?enabled=true`,
    `${path}/../repo-terminal`,
    `${OPERATOR_REPOSITORIES_PATH}/%2e%2e/worker-nodes`,
    `${OPERATOR_REPOSITORIES_PATH}\\repo-powertoys`,
    `${path}#fragment`,
    `${path}/`,
    `${OPERATOR_REPOSITORIES_PATH}?page=01&pageSize=50&search=`,
    `${OPERATOR_REPOSITORIES_PATH}?page=1&pageSize=51&search=`,
    `${OPERATOR_REPOSITORIES_PATH}?page=1&pageSize=200&search=`,
    `${OPERATOR_REPOSITORIES_PATH}?page=1&pageSize=50&search=&extra=true`,
    `${OPERATOR_REPOSITORIES_PATH}?page=1&pageSize=50&search=&search=other`,
    `${OPERATOR_REPOSITORIES_PATH}?pageSize=50&page=1&search=`,
    `${OPERATOR_REPOSITORIES_PATH}?page=1&pageSize=50&search=a%20b`,
    `${OPERATOR_REPOSITORIES_PATH}?page=${Number.MAX_SAFE_INTEGER}&pageSize=50&search=`,
  ])("rejects noncanonical reads before fetch: %s", async (url) => {
    const fetch = vi.fn();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.get(url, "invalid repository path")).rejects.toThrow(
      "outside its allowlisted control-plane API",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not grant PATCH access to worker credentials or repository actions", async () => {
    const fetch = vi.fn();
    const client = new DashboardHttpClient({ fetch });
    for (const url of [
      OPERATOR_WORKER_NODES_PATH,
      `${OPERATOR_WORKER_NODES_PATH}/worker:11111111-1111-4111-8111-111111111111/token/rotate`,
      OPERATOR_REPOSITORIES_PATH,
      `${path}/check-connection`,
      "/api/v1/dashboard/jobs/job-1",
    ]) {
      await expect(client.patch(url, "invalid patch", {})).rejects.toThrow(
        "outside its allowlisted control-plane API",
      );
    }
    await expect(client.post(path, "invalid post", {})).rejects.toThrow(
      "outside its allowlisted control-plane API",
    );
    await expect(client.get(`${path}/check-connection`, "invalid read")).rejects.toThrow(
      "outside its allowlisted control-plane API",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("sample repository adapter", () => {
  it("uses the same 50-item page limit as the repository API", async () => {
    const adapter = new MockRepositoryAdapter();
    await expect(adapter.list({ pageSize: 50 })).resolves.toMatchObject({ total: 2 });
    await expect(adapter.list({ pageSize: 51 })).rejects.toBeInstanceOf(ReviewControlRequestError);
  });

  it("keeps a fixed roster and returns policy-free independently paginated summaries", async () => {
    const adapter = new MockRepositoryAdapter();
    const first = await adapter.list({ pageSize: 1 });
    const second = await adapter.list({ pageSize: 1, page: 2 });
    expect(first.total).toBe(2);
    expect(first.items[0]?.id).toBe("repo-powertoys");
    expect(second.items[0]?.id).toBe("repo-terminal");
    expect(first.items[0]).not.toHaveProperty("authorizationPolicy");
    await expect(adapter.list({ search: "POWERTOYS" })).resolves.toMatchObject({
      total: 1,
      items: [{ id: "repo-powertoys" }],
    });
    await expect(adapter.list({ page: 3, pageSize: 1 })).resolves.toEqual({ items: [], total: 2 });
  });

  it("only resolves fixed sample metadata without pretending unknown repositories were checked", async () => {
    const adapter = new MockRepositoryAdapter();
    await expect(adapter.resolve("MICROSOFT/powertoys")).resolves.toMatchObject(metadata);
    await expect(adapter.resolve("owner/unknown")).rejects.toMatchObject({ status: 404 });
    await expect(adapter.checkConnection("repo-unknown")).rejects.toMatchObject({ status: 404 });
    const checked = await adapter.checkConnection("repo-terminal");
    expect(checked.connectionStatus).toBe("ready");
    expect(checked.connectionMessage).toContain("No GitHub connection was checked");
    expect(checked.version).toBe(otherRepository.version);
  });

  it("creates sample repositories with fixed IDs and rejects duplicates or mismatched metadata", async () => {
    const adapter = new MockRepositoryAdapter({ initialRepositories: [] });
    await expect(
      adapter.create({ ...createRequest, githubRepositoryId: 2 }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    const created = await adapter.create(createRequest);
    expect(created).toMatchObject({
      id: "repo-powertoys",
      enabled: false,
      version: 1,
      connectionStatus: "ready",
    });
    await expect(adapter.create(createRequest)).rejects.toMatchObject({ status: 409 });
    await expect(
      adapter.create({ githubRepositoryId: 2, fullName: "owner/unknown" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("enforces compare-and-swap and preserves the successful edit on stale saves", async () => {
    const adapter = new MockRepositoryAdapter();
    const original = await adapter.get(repository.id);
    const updated = await adapter.update(repository.id, {
      expectedVersion: original.version,
      enabled: false,
    });
    expect(updated.version).toBe(original.version + 1);
    expect(updated.enabled).toBe(false);
    await expect(
      adapter.update(repository.id, { expectedVersion: original.version, enabled: true }),
    ).rejects.toBeInstanceOf(ReviewControlHttpError);
    await expect(adapter.get(repository.id)).resolves.toMatchObject({
      enabled: false,
      version: updated.version,
    });
  });

  it("validates reviewer consistency without partially committing invalid edits", async () => {
    const adapter = new MockRepositoryAdapter();
    await expect(
      adapter.update(repository.id, { expectedVersion: 1, reviewerGithubLogin: "reviewer" }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(adapter.get(repository.id)).resolves.toMatchObject({
      version: 1,
      reviewerGithubLogin: null,
    });
    await expect(
      adapter.update(repository.id, {
        expectedVersion: 1,
        reviewerGithubUserId: 12,
        reviewerGithubLogin: "reviewer",
      }),
    ).resolves.toMatchObject({ version: 2, reviewerGithubUserId: 12 });
  });

  it("isolates returned values, sample fixtures, and adapter instances from client edits", async () => {
    const first = new MockRepositoryAdapter();
    const second = new MockRepositoryAdapter();
    const read = await first.get(repository.id);
    read.enabled = false;
    await first.update(repository.id, { expectedVersion: 1, enabled: false });
    await expect(second.get(repository.id)).resolves.toMatchObject({ enabled: true, version: 1 });
    expect(sampleRepositories[0]).toEqual(repository);
  });
});
