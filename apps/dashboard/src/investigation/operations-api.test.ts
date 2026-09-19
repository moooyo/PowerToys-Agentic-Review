import {
  InvestigationWebhookDeliveryListSchema,
  InvestigationWorkerControlListSchema,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createInvestigationApi } from "./api";
import { createSampleOperationsApi } from "./sample-operations";
import { createHttpTransport } from "./transport";

describe("worker and webhook operations", () => {
  it("preserves task restrictions when a static worker's E2E switch is enabled", async () => {
    const api = createSampleOperationsApi();
    const original = await api.workers();
    expect(Value.Check(InvestigationWorkerControlListSchema, original)).toBe(true);
    const worker = original.items.find((item) => item.id === "sample-static-worker")!;
    const enabled = await api.updateWorkerE2e(worker.id, {
      version: worker.version,
      e2eEnabled: true,
    });
    expect(enabled.e2eEnabled).toBe(true);
    expect(enabled.effectiveKinds).toEqual(["pr-review", "issue-investigate"]);
    expect(enabled.status).toBe("static_only");
    await expect(
      api.updateWorkerE2e(worker.id, { version: worker.version, e2eEnabled: false }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await api.workers()).items.find((item) => item.id === worker.id)).toEqual(enabled);
  });

  it("retains failed attempt history while a retry is queued and deduplicates ambiguous resubmission", async () => {
    const api = createSampleOperationsApi();
    const original = await api.webhookDelivery("sample-webhook-task-failed");
    const input = { version: original.version, idempotencyKey: "sample-retry" };
    const queued = await api.retryWebhookDelivery(original.deliveryId, input);
    expect(queued).toMatchObject({
      state: "accepted",
      attempts: 0,
      totalAttempts: 3,
      taskId: null,
      availableActions: [],
      attemptHistory: original.attemptHistory,
    });
    expect(await api.retryWebhookDelivery(original.deliveryId, input)).toEqual(queued);
    await expect(
      api.retryWebhookDelivery(original.deliveryId, {
        ...input,
        idempotencyKey: "different-retry",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const completed = await api.webhookDelivery("sample-webhook-completed");
    await expect(
      api.retryWebhookDelivery(completed.deliveryId, {
        version: completed.version,
        idempotencyKey: "must-not-rerun-task",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await api.webhookDelivery(completed.deliveryId)).taskId).toBe("sample-pr-p1-task");
  });

  it("binds pagination to its filters and exposes only matching events", async () => {
    const api = createSampleOperationsApi();
    const first = await api.webhookDeliveries({ state: "failed", limit: 1 });
    expect(Value.Check(InvestigationWebhookDeliveryListSchema, first)).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await api.webhookDeliveries({
      state: "failed",
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.deliveryId).not.toBe(first.items[0]?.deliveryId);
    expect(second.nextCursor).toBeNull();
    await expect(
      api.webhookDeliveries({ state: "completed", cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await api.webhookDeliveries({ mode: "e2e", number: 2102 })).items).toHaveLength(1);
  });

  it("uses the production worker routes and rejects malformed capability responses", async () => {
    const sample = createSampleOperationsApi();
    const workers = await sample.workers();
    const worker = workers.items[0]!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(workers));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    expect(await api.workers()).toEqual(workers);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/workers",
      expect.objectContaining({ method: "GET" }),
    );
    fetcher.mockResolvedValueOnce(Response.json(worker));
    await api.updateWorkerE2e("worker:one", { version: 1, e2eEnabled: false });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/workers/worker%3Aone/e2e",
      expect.objectContaining({ method: "POST", body: '{"version":1,"e2eEnabled":false}' }),
    );
    fetcher.mockResolvedValueOnce(
      Response.json({ items: [{ ...worker, effectiveKinds: ["anything"] }] }),
    );
    await expect(api.workers()).rejects.toThrow("invalid structured response");
  });

  it("encodes event identities and submits only the chosen versioned retry", async () => {
    const sample = createSampleOperationsApi();
    const deliveries = await sample.webhookDeliveries();
    const delivery = await sample.webhookDelivery("sample-webhook-task-failed");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(deliveries));
    const api = createInvestigationApi(createHttpTransport(fetcher));
    await api.webhookDeliveries({
      repositoryId: "repo:one",
      number: 3,
      state: "failed",
      mode: "e2e",
      limit: 25,
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/github/webhook-deliveries?repositoryId=repo%3Aone&number=3&state=failed&mode=e2e&limit=25",
      expect.objectContaining({ method: "GET" }),
    );
    fetcher.mockResolvedValueOnce(Response.json(delivery));
    await api.webhookDelivery("delivery/one");
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/github/webhook-deliveries/delivery%2Fone",
      expect.anything(),
    );
    fetcher.mockResolvedValueOnce(Response.json(delivery));
    const input = { version: delivery.version, idempotencyKey: "selected-event" };
    await api.retryWebhookDelivery("delivery/one", input);
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/github/webhook-deliveries/delivery%2Fone/retry",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
    fetcher.mockResolvedValueOnce(Response.json({ ...delivery, totalAttempts: -1 }));
    await expect(api.webhookDelivery(delivery.deliveryId)).rejects.toThrow(
      "invalid structured response",
    );
  });
});
