import type * as C from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
  ReviewControlResponseTooLargeError,
} from "../review-control/errors";
import {
  controlRequest,
  identityDigest,
  registrationRequest,
  registryActor,
  registryId,
  runtimeHistory,
  runtimeList,
  runtimeOptions,
  runtimeStatus,
} from "./fixtures.testing";
import {
  createHttpModelRuntimeRegistrationAdapter,
  type ModelRuntimeRegistrationAdapter,
} from "./index";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function fixture(value: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json(value));
  return { fetch, adapter: createHttpModelRuntimeRegistrationAdapter({ fetch }) };
}
const reads = [
  {
    name: "list",
    value: runtimeList,
    run: (a: ModelRuntimeRegistrationAdapter, signal?: AbortSignal) => a.list({}, signal),
  },
  {
    name: "detail",
    value: runtimeStatus,
    run: (a: ModelRuntimeRegistrationAdapter, signal?: AbortSignal) => a.get(registryId, signal),
  },
  {
    name: "history",
    value: runtimeHistory,
    run: (a: ModelRuntimeRegistrationAdapter, signal?: AbortSignal) =>
      a.history(registryId, {}, signal),
  },
  {
    name: "options",
    value: runtimeOptions,
    run: (a: ModelRuntimeRegistrationAdapter, signal?: AbortSignal) =>
      a.options("repo-a", {}, signal),
  },
];
describe("model runtime registration HTTP adapter", () => {
  it("uses all six authenticated endpoints, canonical queries and actor-free mutation bodies", async () => {
    const responses = [
      runtimeStatus(),
      runtimeStatus(false, 2),
      runtimeList(false),
      runtimeStatus(),
      runtimeHistory(),
      runtimeOptions(),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const value of responses) fetch.mockResolvedValueOnce(json(value));
    const api = createHttpModelRuntimeRegistrationAdapter({ fetch });
    expect(api.mode).toBe("connected");
    expect(await api.register(registrationRequest(), registryActor)).toEqual(responses[0]);
    expect(await api.changeControl(registryId, controlRequest(), registryActor)).toEqual(
      responses[1],
    );
    expect(await api.list({ enabled: false })).toEqual(responses[2]);
    expect(await api.get(registryId)).toEqual(responses[3]);
    expect(await api.history(registryId)).toEqual(responses[4]);
    expect(await api.options("repo-a")).toEqual(responses[5]);
    expect(fetch.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
      ["/api/v1/operator/model-runtimes", "POST"],
      ["/api/v1/operator/model-runtimes/runtime-a", "PATCH"],
      ["/api/v1/operator/model-runtimes?page=1&pageSize=20&enabled=false", "GET"],
      ["/api/v1/operator/model-runtimes/runtime-a", "GET"],
      ["/api/v1/operator/model-runtimes/runtime-a/history?page=1&pageSize=20", "GET"],
      [
        "/api/v1/operator/repositories/repo-a/evaluation-model-runtime-options?page=1&pageSize=20",
        "GET",
      ],
    ]);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(registrationRequest()));
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(controlRequest()));
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({ credentials: "include", redirect: "error" });
  });
  it("snapshots the original payload and actor before awaiting a response", async () => {
    let complete: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const api = createHttpModelRuntimeRegistrationAdapter({ fetch });
    const request = registrationRequest(),
      actor = { ...registryActor },
      original = structuredClone(request);
    const pending = api.register(request, actor);
    request.name = "Changed";
    request.identity.modelId = "Changed";
    actor.subject = "Changed";
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(original));
    complete?.(json(runtimeStatus()));
    await expect(pending).resolves.toEqual(runtimeStatus());
  });
  it("resends the original caller-owned change ID and bytes after an uncertain response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(json(runtimeStatus()));
    const api = createHttpModelRuntimeRegistrationAdapter({ fetch }),
      request = registrationRequest();
    await expect(api.register(request, registryActor)).rejects.toBeInstanceOf(
      ReviewControlNetworkError,
    );
    await expect(api.register(request, registryActor)).resolves.toEqual(runtimeStatus());
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
  });
  it.each(["name", "requestedModel", "identity", "actor", "control"])(
    "rejects a register response with changed %s",
    async (part) => {
      const value = runtimeStatus();
      if (part === "name") value.registration.name = "Changed";
      if (part === "requestedModel") value.registration.requestedModel = "Changed";
      if (part === "identity") {
        value.registration.identity.modelId = "Changed";
        value.registration.identitySha256 = identityDigest(value.registration.identity);
      }
      if (part === "actor") {
        value.registration.createdBy.subject = "other";
        value.control.updatedBy.subject = "other";
      }
      if (part === "control") value.control.enabled = false;
      await expect(
        fixture(value).adapter.register(registrationRequest(), registryActor),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );
  it.each(["id", "version", "enabled", "actor"])(
    "rejects a control response with changed %s",
    async (part) => {
      const value = runtimeStatus(false, 2);
      if (part === "id") {
        value.registration.id = "other";
        value.control.registrationId = "other";
      }
      if (part === "version") value.control.version = 3;
      if (part === "enabled") value.control.enabled = true;
      if (part === "actor") value.control.updatedBy.subject = "other";
      await expect(
        fixture(value).adapter.changeControl(registryId, controlRequest(), registryActor),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    },
  );
  it.each(reads)(
    "rejects malformed $name responses and never supplies sample data",
    async ({ value, run }) => {
      for (const response of [
        null,
        { ...value(), secret: "not allowed" },
        { ...value(), schemaVersion: "unknown" },
      ]) {
        await expect(run(fixture(response).adapter)).rejects.toBeInstanceOf(
          ReviewControlProtocolError,
        );
      }
    },
  );
  it("checks identity digests for detail, list and options", async () => {
    const status = runtimeStatus();
    status.registration.identitySha256 = "f".repeat(64);
    const list = runtimeList();
    list.items = [status];
    const options = runtimeOptions();
    options.items = [status.registration];
    await expect(fixture(status).adapter.get(registryId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(fixture(list).adapter.list()).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(fixture(options).adapter.options("repo-a")).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it("checks read scope, pagination, filter and continuous audit versions", async () => {
    await expect(fixture(runtimeStatus()).adapter.get("other")).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(fixture(runtimeOptions()).adapter.options("other")).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(fixture(runtimeHistory()).adapter.history("other")).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(fixture(runtimeList()).adapter.list({ page: 2 })).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    await expect(fixture(runtimeList()).adapter.list({ enabled: false })).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
    const value = runtimeHistory();
    const event = value.items[0];
    if (!event) throw new Error("The fixture must include an audit event.");
    event.version = 3;
    await expect(fixture(value).adapter.history(registryId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });
  it.each(["../other", "runtime-a\n", "runtime-a?x=1", "", "a/b", "a%2fb"])(
    "rejects invalid path ID %j before fetch",
    async (id) => {
      const f = fixture(runtimeStatus());
      for (const run of [
        () => f.adapter.get(id),
        () => f.adapter.history(id),
        () => f.adapter.options(id),
        () => f.adapter.changeControl(id, controlRequest(), registryActor),
      ])
        await expect(run()).rejects.toBeInstanceOf(ReviewControlRequestError);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { page: 0 },
    { pageSize: 51 },
    { page: 1.5 },
    { enabled: "true" },
    { page: undefined },
    { unknown: true },
  ])("rejects invalid list query %j before fetch", async (query) => {
    const f = fixture(runtimeList());
    await expect(f.adapter.list(query as C.ModelRuntimeListQuery)).rejects.toBeInstanceOf(
      ReviewControlRequestError,
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("rejects extra body fields, getters, invalid actor and options filters before fetch", async () => {
    const f = fixture(runtimeStatus()),
      getter = vi.fn(() => "name");
    const accessor = registrationRequest();
    Object.defineProperty(accessor, "name", { enumerable: true, get: getter });
    for (const request of [
      { ...registrationRequest(), actor: registryActor },
      { ...registrationRequest(), replayOnly: true },
      { ...registrationRequest(), name: "界".repeat(33000) },
      accessor,
    ]) {
      await expect(f.adapter.register(request, registryActor)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
    }
    await expect(
      f.adapter.register(registrationRequest(), { ...registryActor, subject: " user " }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    await expect(
      f.adapter.options("repo-a", { enabled: true } as C.ModelRuntimeOptionsQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(getter).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(reads)("propagates cancellation for $name", async ({ value, run }) => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture(value());
    await expect(run(f.adapter, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(reads)("bounds $name responses and preserves server errors", async ({ run }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": "2097153" },
        }),
    );
    await expect(run(createHttpModelRuntimeRegistrationAdapter({ fetch }))).rejects.toBeInstanceOf(
      ReviewControlResponseTooLargeError,
    );
    fetch.mockResolvedValueOnce(json({ error: "forbidden", message: "Denied" }, 403));
    await expect(run(createHttpModelRuntimeRegistrationAdapter({ fetch }))).rejects.toBeInstanceOf(
      ReviewControlHttpError,
    );
  });
});
