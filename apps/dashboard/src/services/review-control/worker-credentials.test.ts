import { describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError, ReviewControlProtocolError } from "./errors";
import { HttpReviewControlAdapter } from "./http-adapter";
import { DashboardHttpClient, OPERATOR_WORKER_NODES_PATH } from "./http-client";
import {
  mapCreatedWorkerCredentialResponse,
  mapRevokedWorkerCredentialResponse,
  mapRotatedWorkerCredentialResponse,
  mapWorkerCredentialListResponse,
} from "./http-mappers";

const workerNodeId = "worker:11111111-1111-4111-8111-111111111111";
const otherWorkerNodeId = "worker:22222222-2222-4222-8222-222222222222";
const workerToken = `arw1_${"A".repeat(43)}`;
const expectedUpdatedAt = "2026-09-04T01:02:00.000Z";

const credentialItem = (index: number) => ({
  workerNodeId: `worker:00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  displayName: `Worker ${index}`,
  authState: "active",
  createdAt: "2026-09-04T01:00:00.000Z",
  activatedAt: "2026-09-04T01:01:00.000Z",
  rotatedAt: null,
  revokedAt: null,
  updatedAt: expectedUpdatedAt,
});

const workerItem = (index: number) => ({
  id: `worker-record-${index}`,
  workerNodeId: `worker:00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
  instanceId: `instance-${index}`,
  displayName: `Runtime worker ${index}`,
  status: "online",
  version: "0.1.0",
  location: null,
  activeSlots: 0,
  maxSlots: 1,
  capabilities: ["static-review"],
  currentJobIds: [],
  lastHeartbeatAt: expectedUpdatedAt,
  diskFreeBytes: 1_073_741_824,
});

const jsonResponse = (
  value: unknown,
  status = 200,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Response =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...additionalHeaders },
    status,
  });

describe("worker credential response mapping", () => {
  it("maps the strict credential roster without exposing secret fields", () => {
    expect(
      mapWorkerCredentialListResponse({
        items: [
          {
            workerNodeId,
            displayName: "Seattle worker",
            authState: "pending",
            createdAt: "2026-09-04T01:00:00.000Z",
            activatedAt: null,
            rotatedAt: null,
            revokedAt: null,
            updatedAt: "2026-09-04T01:00:00.000Z",
          },
        ],
        total: 1,
      }),
    ).toEqual({
      items: [
        {
          workerNodeId,
          displayName: "Seattle worker",
          authState: "pending",
          createdAt: "2026-09-04T01:00:00.000Z",
          activatedAt: null,
          rotatedAt: null,
          revokedAt: null,
          updatedAt: "2026-09-04T01:00:00.000Z",
        },
      ],
      total: 1,
    });
  });

  it("accepts stored legacy node identifiers for read-only roster visibility", () => {
    expect(
      mapWorkerCredentialListResponse({
        items: [
          {
            workerNodeId: "legacy-worker-01",
            displayName: "Legacy worker",
            authState: "active",
            createdAt: "2026-09-04T01:00:00.000Z",
            activatedAt: "2026-09-04T01:01:00.000Z",
            rotatedAt: null,
            revokedAt: null,
            updatedAt: "2026-09-04T01:01:00.000Z",
          },
        ],
        total: 1,
      }).items[0]?.workerNodeId,
    ).toBe("legacy-worker-01");
  });

  it("maps create, rotate, and revoke responses with exact states", () => {
    expect(
      mapCreatedWorkerCredentialResponse({
        workerNodeId,
        authState: "pending",
        token: workerToken,
      }),
    ).toEqual({ workerNodeId, authState: "pending", token: workerToken });
    expect(
      mapRotatedWorkerCredentialResponse({ workerNodeId, authState: "active", token: workerToken }),
    ).toEqual({ workerNodeId, authState: "active", token: workerToken });
    expect(mapRevokedWorkerCredentialResponse({ workerNodeId, authState: "revoked" })).toEqual({
      workerNodeId,
      authState: "revoked",
    });
  });

  it("rejects additional roster fields and invalid lifecycle states", () => {
    expect(() =>
      mapWorkerCredentialListResponse({
        items: [
          {
            workerNodeId,
            displayName: "Seattle worker",
            authState: "pending",
            createdAt: "2026-09-04T01:00:00.000Z",
            activatedAt: null,
            rotatedAt: null,
            revokedAt: null,
            updatedAt: "2026-09-04T01:00:00.000Z",
            token: workerToken,
          },
        ],
        total: 1,
      }),
    ).toThrow(ReviewControlProtocolError);
    expect(() =>
      mapCreatedWorkerCredentialResponse({ workerNodeId, authState: "active", token: workerToken }),
    ).toThrow(ReviewControlProtocolError);
  });

  it("does not copy an invalid token into protocol error text", () => {
    const reflectedValue = `${workerToken}!`;
    let error: unknown;
    try {
      mapCreatedWorkerCredentialResponse({
        workerNodeId,
        authState: "pending",
        token: reflectedValue,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ReviewControlProtocolError);
    expect((error as Error).message).not.toContain(reflectedValue);
  });

  it("does not echo a token-shaped unexpected JSON key into the error object", () => {
    let error: unknown;
    try {
      mapCreatedWorkerCredentialResponse({
        workerNodeId,
        authState: "pending",
        token: workerToken,
        [workerToken]: "unexpected",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ReviewControlProtocolError);
    expect((error as Error).message).not.toContain(workerToken);
    expect(JSON.stringify(error)).not.toContain(workerToken);
  });
});

describe("worker credential HTTP adapter", () => {
  it("uses the exact no-store same-origin create request", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ workerNodeId, authState: "pending", token: workerToken }, 201),
    );
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.createWorkerCredential("Seattle worker")).resolves.toEqual({
      workerNodeId,
      authState: "pending",
      token: workerToken,
    });
    expect(fetch).toHaveBeenCalledWith(
      OPERATOR_WORKER_NODES_PATH,
      expect.objectContaining({
        body: JSON.stringify({ displayName: "Seattle worker" }),
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("uses empty JSON bodies for canonical rotate and revoke paths", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ workerNodeId, authState: "active", token: workerToken }),
      )
      .mockResolvedValueOnce(jsonResponse({ workerNodeId, authState: "revoked" }));
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await adapter.rotateWorkerToken(workerNodeId, expectedUpdatedAt);
    await adapter.revokeWorkerToken(workerNodeId);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/v1/operator/worker-nodes/${workerNodeId}/token/rotate`,
    );
    expect(fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ expectedUpdatedAt }),
        method: "POST",
      }),
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/operator/worker-nodes/${workerNodeId}/revoke`);
    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ body: "{}", method: "POST" }),
    );
  });

  it("rejects a response bound to a different worker without exposing its token", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ workerNodeId: otherWorkerNodeId, authState: "active", token: workerToken }),
    );
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    let error: unknown;
    try {
      await adapter.rotateWorkerToken(workerNodeId, expectedUpdatedAt);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ReviewControlProtocolError);
    expect((error as Error).message).not.toContain(workerToken);
  });

  it("rejects token-shaped display names before fetch", async () => {
    const fetch = vi.fn();
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.createWorkerCredential(`Worker ${workerToken}`)).rejects.toThrow(
      "invalid displayName",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("collects the complete credential roster through strict pagination", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => credentialItem(index));
    const finalItem = credentialItem(200);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: firstPage, total: 201 }))
      .mockResolvedValueOnce(jsonResponse({ items: [finalItem], total: 201 }));
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.listWorkerCredentials()).resolves.toMatchObject({ total: 201 });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      `${OPERATOR_WORKER_NODES_PATH}?page=1&pageSize=200&sort=identity`,
      `${OPERATOR_WORKER_NODES_PATH}?page=2&pageSize=200&sort=identity`,
    ]);
  });

  it("rejects credential pagination total changes, duplicates, and no progress", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => credentialItem(index));
    const scenarios = [
      { second: { items: [credentialItem(200)], total: 202 }, message: "changed total" },
      { second: { items: [credentialItem(0)], total: 201 }, message: "repeated a worker" },
      { second: { items: [], total: 201 }, message: "no valid pagination progress" },
    ];

    for (const scenario of scenarios) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ items: firstPage, total: 201 }))
        .mockResolvedValueOnce(jsonResponse(scenario.second));
      const adapter = new HttpReviewControlAdapter({
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      await expect(adapter.listWorkerCredentials()).rejects.toThrow(scenario.message);
    }
  });

  it("rejects an oversized credential roster before requesting another page", async () => {
    const fetch = vi.fn(async () => jsonResponse({ items: [], total: 10_001 }));
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.listWorkerCredentials()).rejects.toThrow("exceeds the dashboard roster");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("worker runtime HTTP adapter", () => {
  it("collects the complete runtime roster through strict pagination", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => workerItem(index));
    const finalItem = workerItem(200);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: firstPage, total: 201 }))
      .mockResolvedValueOnce(jsonResponse({ items: [finalItem], total: 201 }));
    const adapter = new HttpReviewControlAdapter({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(adapter.listAllWorkers()).resolves.toMatchObject({ total: 201 });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/dashboard/workers?page=1&pageSize=200&sort=identity",
      "/api/v1/dashboard/workers?page=2&pageSize=200&sort=identity",
    ]);
  });

  it("rejects runtime pagination total changes, duplicate IDs, and no progress", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => workerItem(index));
    const scenarios = [
      { second: { items: [workerItem(200)], total: 202 }, message: "changed total" },
      { second: { items: [workerItem(0)], total: 201 }, message: "repeated a worker" },
      { second: { items: [], total: 201 }, message: "no valid pagination progress" },
    ];

    for (const scenario of scenarios) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ items: firstPage, total: 201 }))
        .mockResolvedValueOnce(jsonResponse(scenario.second));
      const adapter = new HttpReviewControlAdapter({
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      await expect(adapter.listAllWorkers()).rejects.toThrow(scenario.message);
    }
  });

  it("rejects oversized runtime rosters and pages", async () => {
    const oversizedRosterFetch = vi.fn(async () => jsonResponse({ items: [], total: 10_001 }));
    const oversizedRosterAdapter = new HttpReviewControlAdapter({
      fetch: oversizedRosterFetch as unknown as typeof globalThis.fetch,
    });

    await expect(oversizedRosterAdapter.listAllWorkers()).rejects.toThrow(
      "exceeds the dashboard roster",
    );
    expect(oversizedRosterFetch).toHaveBeenCalledTimes(1);

    const oversizedPage = Array.from({ length: 201 }, (_, index) => workerItem(index));
    const oversizedPageAdapter = new HttpReviewControlAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({ items: oversizedPage, total: 201 }),
      ) as unknown as typeof globalThis.fetch,
    });
    await expect(oversizedPageAdapter.listAllWorkers()).rejects.toThrow(
      "exceeded the requested page size",
    );
  });
});

describe("worker credential HTTP boundary", () => {
  it("rejects non-allowlisted operator paths and non-canonical worker ids", async () => {
    const client = new DashboardHttpClient({
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });

    await expect(client.get("/api/v1/operator/sessions", "invalidRead")).rejects.toThrow(
      "outside its allowlisted control-plane API",
    );
    await expect(
      client.post("/api/v1/operator/worker-nodes/worker:legacy/token/rotate", "invalidRotate", {}),
    ).rejects.toThrow("outside its allowlisted control-plane API");
    await expect(client.get(OPERATOR_WORKER_NODES_PATH, "invalidList")).rejects.toThrow(
      "outside its allowlisted control-plane API",
    );
  });

  it.each([
    "/api/v1/dashboard/../operator/worker-nodes",
    "/api/v1/dashboard/%2e%2e/operator/worker-nodes",
    "/api/v1/dashboard/%2E%2E/operator/worker-nodes",
    "/api/v1/dashboard\\workers",
    "/api/v1/dashboard/workers/./status",
  ])("rejects non-canonical path syntax before fetch: %s", async (path) => {
    const fetch = vi.fn();
    const client = new DashboardHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(client.get(path, "invalidPath")).rejects.toThrow(
      "outside its allowlisted control-plane API",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    `${OPERATOR_WORKER_NODES_PATH}?page=1&pageSize=200`,
    `${OPERATOR_WORKER_NODES_PATH}?page=01&pageSize=200&sort=identity`,
    `${OPERATOR_WORKER_NODES_PATH}?page=1&pageSize=%32%30%30&sort=identity`,
    `${OPERATOR_WORKER_NODES_PATH}?pageSize=200&page=1&sort=identity`,
    `${OPERATOR_WORKER_NODES_PATH}?page=1&pageSize=200&sort=updated`,
    `${OPERATOR_WORKER_NODES_PATH}?page=1&sort=identity&pageSize=200`,
    `${OPERATOR_WORKER_NODES_PATH}?page=1&pageSize=200&sort=identity&extra=1`,
    `${OPERATOR_WORKER_NODES_PATH}?page=1&pageSize=201&sort=identity`,
  ])("rejects non-canonical worker roster pagination: %s", async (path) => {
    const fetch = vi.fn();
    const client = new DashboardHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(client.get(path, "listWorkerCredentials")).rejects.toThrow(
      "outside its allowlisted control-plane API",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows a canonical adapter-style dashboard query", async () => {
    const fetch = vi.fn(async () => jsonResponse({ items: [], total: 0 }));
    const client = new DashboardHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(
      client.get("/api/v1/dashboard/workers?search=Seattle+worker", "listWorkers"),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  it("removes reflected worker tokens from generic HTTP errors", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          code: "worker_credential_store_unavailable",
          message: `Storage failed while handling ${workerToken}.`,
          retryable: true,
        },
        503,
      ),
    );
    const client = new DashboardHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    let error: unknown;
    try {
      await client.post(OPERATOR_WORKER_NODES_PATH, "createWorkerCredential", {
        displayName: "Seattle worker",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(workerToken);
    expect(JSON.stringify(error)).not.toContain(workerToken);
  });

  it("drops unsafe request identifiers and server codes from HTTP errors", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          code: workerToken,
          message: "Credential storage is unavailable.",
          retryable: true,
        },
        503,
        { "x-request-id": workerToken },
      ),
    );
    const client = new DashboardHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    let error: unknown;
    try {
      await client.post(OPERATOR_WORKER_NODES_PATH, "createWorkerCredential", {
        displayName: "Seattle worker",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ReviewControlHttpError);
    expect((error as ReviewControlHttpError).requestId).toBeUndefined();
    expect((error as ReviewControlHttpError).serverCode).toBeUndefined();
    expect((error as Error).message).not.toContain(workerToken);
    expect(JSON.stringify(error)).not.toContain(workerToken);
  });

  it("does not retain malformed JSON text or parser causes in protocol errors", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(`{"credential":"${workerToken}"`, {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    const client = new DashboardHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    let error: unknown;
    try {
      await client.get("/api/v1/dashboard/system", "getSystemSnapshot");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ReviewControlProtocolError);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((error as Error).message).not.toContain(workerToken);
    expect(JSON.stringify(error)).not.toContain(workerToken);
  });

  it("does not retain token-bearing network causes", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`Network rejected ${workerToken}.`);
    });
    const client = new DashboardHttpClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    let error: unknown;
    try {
      await client.get("/api/v1/dashboard/system", "getSystemSnapshot");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((error as Error).message).not.toContain(workerToken);
    expect(JSON.stringify(error)).not.toContain(workerToken);
  });
});
