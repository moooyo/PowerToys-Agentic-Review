import type { InvestigationWebhookDelivery } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { InvestigationHttpError } from "./transport";
import WebhookDeliveriesPage, {
  WebhookAttemptHistory,
  WebhookDeliveryDetails,
  WebhookDeliveryHistory,
  WebhookDeliveryHistoryPanel,
  WebhookRetryControls,
  webhookDeliveriesQueryKey,
  webhookDeliveryFilters,
  webhookDeliveryQueryKey,
  webhookDetailsUrl,
  webhookPollingInterval,
  webhookRetryErrorMessage,
} from "./webhook-deliveries-page";

const timestamp = "2026-09-19T02:00:00.000Z";

function delivery(
  overrides: Partial<InvestigationWebhookDelivery> = {},
): InvestigationWebhookDelivery {
  return {
    deliveryId: "delivery-1",
    version: "opaque-version",
    mode: "e2e",
    eventName: "issue_comment",
    repositoryId: "repo-1",
    repositoryFullName: "owner/repository",
    kind: "pull_request",
    number: 7,
    actorUserId: 101,
    assigneeUserId: 102,
    receivedAt: timestamp,
    state: "failed",
    attempts: 3,
    totalAttempts: 3,
    reason: "Task creation exhausted its retry limit.",
    taskId: null,
    canonicalDeliveryId: "delivery-1",
    snapshotRef: { id: "snapshot-1", digest: "a".repeat(64) },
    nextAttemptAt: null,
    availableActions: ["retry"],
    attemptHistory: [],
    ...overrides,
  };
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
}

describe("webhook event management", () => {
  it("keeps repository, target, mode, and event status filters in shareable URLs", () => {
    expect(
      webhookDeliveryFilters(
        "?repositoryId=repo-1&kind=pull_request&number=7&mode=e2e&state=failed",
      ),
    ).toEqual({
      repositoryId: "repo-1",
      kind: "pull_request",
      number: 7,
      mode: "e2e",
      state: "failed",
    });
    expect(webhookDeliveryFilters("?kind=issue&mode=static&state=completed")).toEqual({
      kind: "issue",
      mode: "static",
      state: "completed",
    });
    expect(webhookDeliveryFilters("?kind=task&mode=execute&state=succeeded")).toEqual({});
    for (const number of ["0", "-1", "7.5", "9007199254740992", "one"])
      expect(webhookDeliveryFilters(`?number=${number}`)).toEqual({});
    expect(webhookDetailsUrl("delivery:one/two", "repo&other")).toBe(
      "/webhooks?repositoryId=repo%26other&deliveryId=delivery%3Aone%2Ftwo",
    );
  });

  it("shows failed intake without a task and never equates processed intake with task success", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WebhookDeliveryHistory
          items={[
            delivery(),
            delivery({
              deliveryId: "delivery-2",
              state: "completed",
              reason: null,
              taskId: "task-2",
              availableActions: [],
            }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Task creation exhausted its retry limit.");
    expect(html).toContain("No task linked");
    expect(html).toContain("Processed");
    expect(html).toContain("taskId=task-2");
    expect(html).toContain("deliveryId=delivery-1");
    expect(html).not.toContain("Task succeeded");
    expect(html).not.toContain("opaque-version");
    expect(renderToStaticMarkup(<WebhookDeliveryHistory items={[]} />)).toContain(
      "No webhook events match these filters.",
    );
  });

  it("retains earlier failed attempts alongside recovery and existing task associations", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <WebhookAttemptHistory
          delivery={delivery({
            attempts: 1,
            totalAttempts: 4,
            attemptHistory: [
              {
                id: "attempt-3",
                number: 3,
                cycleAttempt: 3,
                startedAt: timestamp,
                finishedAt: timestamp,
                state: "failed",
                phase: "task",
                reason: "<script>unsafe()</script> Task transaction failed.",
                taskId: null,
              },
              {
                id: "attempt-4",
                number: 4,
                cycleAttempt: 1,
                startedAt: timestamp,
                finishedAt: timestamp,
                state: "completed",
                phase: "recovery",
                reason: "Linked the already committed task.",
                taskId: "task-recovered",
              },
            ],
          })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Current cycle attempts: 1; total recorded: 4");
    expect(html).toContain("Attempt 3");
    expect(html).toContain("Attempt 4");
    expect(html).toContain("Task creation");
    expect(html).toContain("Recovery");
    expect(html).toContain("Linked the already committed task.");
    expect(html).toContain("taskId=task-recovered");
    expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("offers retry only when the server grants that action and explains its execution boundary", () => {
    const queryClient = client();
    const renderControls = (record: InvestigationWebhookDelivery) =>
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <WebhookRetryControls delivery={record} />
        </QueryClientProvider>,
      );
    expect(renderControls(delivery())).toContain("Retry event handling");
    expect(renderControls(delivery())).toContain(
      "does not rerun an existing task or retry a GitHub comment delivery",
    );
    expect(renderControls(delivery({ availableActions: [] }))).not.toContain(
      "Retry event handling",
    );
    expect(renderControls(delivery({ state: "completed", availableActions: [] }))).not.toContain(
      "Retry event handling",
    );
    expect(webhookRetryErrorMessage(new InvestigationHttpError(409, "version mismatch"))).toBe(
      "This event changed. Refresh its status before retrying event handling.",
    );
    expect(webhookRetryErrorMessage(new InvestigationHttpError(403, "Permission denied."))).toBe(
      "Permission denied.",
    );
    expect(webhookRetryErrorMessage(null)).toBe("Event handling could not be scheduled.");
    queryClient.clear();
  });

  it("shows canonical delivery and task links without losing the selected repository", () => {
    const queryClient = client();
    queryClient.setQueryData(
      webhookDeliveryQueryKey("delivery-1"),
      delivery({
        state: "completed",
        reason: null,
        taskId: "task-1",
        canonicalDeliveryId: "delivery-canonical",
        availableActions: [],
      }),
    );
    queryClient.setQueryData(["investigation-repositories"], { items: [] });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/webhooks?repositoryId=repo-1&deliveryId=delivery-1"]}>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveryDetails deliveryId="delivery-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("Open canonical event");
    expect(html).toContain("repositoryId=repo-1&amp;deliveryId=delivery-canonical");
    expect(html).toContain("repositoryId=repo-1&amp;taskId=task-1");
    expect(html).toContain("Processed means event handling finished");
    expect(html).toContain("Task execution and GitHub comment delivery have separate outcomes");
    queryClient.clear();
  });

  it("does not expose a cached detail from another repository scope", () => {
    const queryClient = client();
    queryClient.setQueryData(webhookDeliveryQueryKey("delivery-1"), delivery());
    queryClient.setQueryData(["investigation-repositories"], { items: [] });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/webhooks?repositoryId=another-repo&deliveryId=delivery-1"]}>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveryDetails deliveryId="delivery-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("This event does not belong to the selected repository.");
    expect(html).not.toContain("Task creation exhausted its retry limit.");
    expect(html).not.toContain("Retry event handling");
    queryClient.clear();
  });

  it("polls pending intake with bounded retries and stops polling terminal events", () => {
    expect(webhookPollingInterval([delivery()])).toBe(false);
    expect(webhookPollingInterval([delivery({ state: "completed" })])).toBe(false);
    expect(webhookPollingInterval([delivery({ state: "accepted" })])).toBe(5_000);
    expect(webhookPollingInterval([delivery({ state: "source_ready" })])).toBe(5_000);
    expect(
      webhookPollingInterval(
        [delivery({ state: "accepted", nextAttemptAt: "2026-09-19T02:00:10.000Z" })],
        Date.parse(timestamp),
      ),
    ).toBe(11_000);
    expect(
      webhookPollingInterval(
        [delivery({ state: "accepted", nextAttemptAt: "2026-09-20T02:00:00.000Z" })],
        Date.parse(timestamp),
      ),
    ).toBe(30_000);
    const queryClient = client();
    const input = { repositoryId: "repo-1", cursor: undefined, limit: 25 };
    queryClient.setQueryData(webhookDeliveriesQueryKey(input), {
      items: [delivery({ state: "accepted" })],
      nextCursor: "next-page",
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveryHistoryPanel filters={{ repositoryId: "repo-1" }} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("Page 1");
    expect(html).toContain("Next");
    const saved = queryClient.getQueryCache().find({ queryKey: webhookDeliveriesQueryKey(input) });
    const interval: unknown = saved && Reflect.get(saved.options, "refetchInterval");
    expect(typeof interval).toBe("function");
    if (typeof interval === "function" && saved) expect(interval(saved)).toBe(5_000);
    queryClient.clear();
  });

  it("keeps repository scope when clearing list filters", () => {
    const queryClient = client();
    queryClient.setQueryData(
      webhookDeliveriesQueryKey({
        repositoryId: "repo-1",
        state: "failed",
        cursor: undefined,
        limit: 25,
      }),
      {
        items: [],
        nextCursor: null,
      },
    );
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/webhooks?repositoryId=repo-1&state=failed"]}>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveriesPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('href="/webhooks?repositoryId=repo-1"');
    expect(html).toContain("No webhook events match these filters.");
    queryClient.clear();
  });
});
