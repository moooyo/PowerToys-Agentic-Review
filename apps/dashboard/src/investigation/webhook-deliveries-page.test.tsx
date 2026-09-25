import type {
  InvestigationSessionUser,
  InvestigationWebhookDelivery,
} from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { investigationApi } from "./api";
import { createSampleInvestigationApi } from "./sample-adapter";
import { InvestigationHttpError } from "./transport";
import WebhookDeliveriesPage, {
  createWebhookRecoveryRequest,
  refreshWebhookRecoveryRequest,
  submitWebhookRecoveryRequest,
  WebhookAttemptHistory,
  WebhookDeliveryDetails,
  WebhookDeliveryHistory,
  WebhookDeliveryHistoryPanel,
  type WebhookRecoveryRequest,
  WebhookRetryControls,
  webhookCanStartRecovery,
  webhookDeliveriesQueryKey,
  webhookDeliveryFilters,
  webhookDeliveryQueryKey,
  webhookDetailsUrl,
  webhookFilterUrl,
  webhookPollingInterval,
  webhookRecoveryGrantProblem,
  webhookRecoveryQueryKey,
  webhookReportMatches,
  webhookRetryErrorMessage,
  webhookTaskMatches,
} from "./webhook-deliveries-page";
import { unknownWebhookReasonDescription, webhookReasonDescription } from "./webhook-reason";

const timestamp = "2026-09-19T02:00:00.000Z";

function withoutDiagnosticDisclosures(html: string): string {
  return html.replace(
    /<section\b[^>]*data-webhook-disclosure-content="true"[^>]*>[\s\S]*?<\/section>/gu,
    "",
  );
}
const operator: InvestigationSessionUser = {
  id: "operator-1",
  username: "operator",
  displayName: "Operator",
  email: null,
  isAdmin: false,
  repositoryIds: ["repo-1"],
  permissions: ["repository:manage", "task:create"],
  actionCapabilities: [],
  allowRepositoryExecution: true,
};

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    useInvestigationSession: () => ({ session: { authenticated: true, user: operator } }),
  };
});

afterEach(() => vi.restoreAllMocks());

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
    reason: "source_read_failed",
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
  it("keeps additional filters visible and removes only the selected URL filter", () => {
    const filters = webhookDeliveryFilters(
      "?repositoryId=repo-1&number=22&mode=e2e&kind=pull_request&state=failed",
    );
    expect(webhookDeliveryFilters(webhookFilterUrl(filters, "number").split("?")[1] ?? "")).toEqual(
      { repositoryId: "repo-1", mode: "e2e", kind: "pull_request", state: "failed" },
    );
    expect(webhookDeliveryFilters(webhookFilterUrl(filters, "mode").split("?")[1] ?? "")).toEqual({
      repositoryId: "repo-1",
      number: 22,
      kind: "pull_request",
      state: "failed",
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/webhooks?repositoryId=repo-1&number=22&mode=e2e"]}>
        <QueryClientProvider client={client}>
          <WebhookDeliveriesPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("More filters (2)");
    expect(html).toContain("Work item: #22");
    expect(html).toContain("Mode: E2E");
    expect(html).toContain('aria-label="Remove work item number 22 filter"');
    client.clear();
  });
  it("explains known source, authorization, and duplicate reasons without adding retry conclusions", () => {
    expect(webhookReasonDescription("source_read_failed")).toBe(
      "The complete source could not be read from GitHub.",
    );
    expect(webhookReasonDescription("source_assignment_missing")).toBe(
      "The configured reviewer is no longer assigned to this work item.",
    );
    expect(webhookReasonDescription("webhook_authorization_revoked")).toBe(
      "Repository intake settings no longer authorize this assignment.",
    );
    expect(webhookReasonDescription("duplicate_assignment")).toBe(
      "The canonical event already represents this assignment.",
    );
    expect(webhookReasonDescription("e2e_revision_changed")).toBe(
      "The pull request revision changed after this E2E request was accepted.",
    );
    expect(webhookReasonDescription("webhook_attempts_exhausted")).not.toMatch(
      /no task|retry|exhausted/iu,
    );
    expect(webhookReasonDescription(null)).toBeNull();
  });

  it("uses a neutral description for unknown reasons instead of inventing an explanation", () => {
    for (const reason of [
      "fixture_task_commit_response_lost",
      "future_source_policy_error",
      "constructor",
      "Task creation exhausted its retry limit.",
      "<script>unsafe()</script>",
    ]) {
      expect(webhookReasonDescription(reason)).toBe(unknownWebhookReasonDescription);
      expect(webhookReasonDescription(reason)).not.toContain(reason.replaceAll("_", " "));
    }
  });

  it("keeps the original known and unknown attempt reasons inside their diagnostic disclosures", () => {
    const records = ["source_read_failed", "fixture_task_commit_response_lost"];
    const html = renderToStaticMarkup(
      <WebhookAttemptHistory
        delivery={delivery({
          attempts: 1,
          totalAttempts: 2,
          attemptHistory: records.map((reason, index) => ({
            id: `reason-attempt-${index}`,
            number: index + 1,
            cycleAttempt: 1,
            startedAt: timestamp,
            finishedAt: timestamp,
            state: "failed" as const,
            phase: index === 0 ? ("source" as const) : ("task" as const),
            reason,
            taskId: null,
          })),
        })}
      />,
    );
    const primary = withoutDiagnosticDisclosures(html);
    expect(primary).toContain("The complete source could not be read from GitHub.");
    expect(primary).toContain(unknownWebhookReasonDescription);
    expect(primary).toContain("Attempts: 1 this cycle · 2 total");
    for (const reason of records) {
      expect(primary).not.toContain(reason);
      expect(html).toContain(`<code>${reason}</code>`);
    }
    expect(primary).not.toMatch(/No task (?:was )?created|retries (?:are )?exhausted/iu);
  });

  it("shows a readable event reason while preserving a post-commit failure code without claiming no task exists", () => {
    const queryClient = client();
    const reason = "fixture_task_commit_response_lost";
    queryClient.setQueryData(
      webhookDeliveryQueryKey("delivery-1"),
      delivery({ reason, taskId: null, attempts: 1, totalAttempts: 1 }),
    );
    queryClient.setQueryData(["investigation-repositories"], { items: [] });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/webhooks?repositoryId=repo-1&deliveryId=delivery-1"]}>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveryDetails deliveryId="delivery-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const primary = withoutDiagnosticDisclosures(html);
    expect(primary).toContain(unknownWebhookReasonDescription);
    expect(primary).toContain("No task linked");
    expect(primary).toContain("Retry event");
    expect(primary).not.toContain(reason);
    expect(primary).not.toContain("fixture task commit response lost");
    expect(primary).not.toMatch(/No task (?:was )?created|retries (?:are )?exhausted/iu);
    expect(html).toContain("Diagnostic details");
    expect(html).toContain(`<code>${reason}</code>`);
    expect(html).not.toContain("<details");
    expect(html).toMatch(
      /<button\b[^>]*aria-expanded="false"[^>]*>[\s\S]*?Diagnostic details[\s\S]*?<\/button>/u,
    );
    queryClient.clear();
  });

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
    expect(html).not.toContain("The complete source could not be read from GitHub.");
    expect(html).not.toContain("source_read_failed");
    expect(html).not.toContain("No task was created");
    expect(html).not.toContain("exhausted");
    expect(html).toContain('data-label="Task"');
    expect(html).toContain("Failed");
    expect(html).toContain("Processed");
    expect(html).toContain("taskId=task-2");
    expect(html).toContain("deliveryId=delivery-1");
    expect(html).not.toContain("Task succeeded");
    expect(html).not.toContain("opaque-version");
    expect(renderToStaticMarkup(<WebhookDeliveryHistory items={[]} />)).toContain(
      "No events match",
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
    expect(html).toContain("Attempts: 1 this cycle · 4 total");
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
          <WebhookRetryControls delivery={record} user={operator} />
        </QueryClientProvider>,
      );
    expect(renderControls(delivery())).toContain("Retry event");
    expect(renderControls(delivery())).toContain("Refresh status");
    expect(renderControls(delivery({ availableActions: [] }))).not.toContain("Retry event");
    expect(renderControls(delivery({ state: "completed", availableActions: [] }))).not.toContain(
      "Retry event",
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
    expect(html).toContain("Related work");
    expect(html).toContain("Event history");
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
    expect(html).toContain('href="/webhooks?repositoryId=another-repo"');
    expect(html).toContain("Back to webhook events");
    expect(html).not.toContain("The complete source could not be read from GitHub.");
    expect(html).not.toContain("Retry event");
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
    expect(html).toContain("No events match");
    queryClient.clear();
  });

  it("offers all repositories when the selected repository has no events", () => {
    const queryClient = client();
    queryClient.setQueryData(
      webhookDeliveriesQueryKey({ repositoryId: "repo-1", cursor: undefined, limit: 25 }),
      { items: [], nextCursor: null },
    );
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/webhooks?repositoryId=repo-1"]}>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveriesPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("No webhook events");
    expect(html).toContain("Show all repositories");
    expect(html).toContain('href="/webhooks"');
    expect(html).not.toContain("Clear filters");
    queryClient.clear();
  });

  it("requires current repository grants even for administrators and rejects unavailable intake states", () => {
    expect(webhookRecoveryGrantProblem(delivery(), operator)).toBeNull();
    expect(webhookRecoveryGrantProblem(delivery(), null)).toContain("access");
    expect(
      webhookRecoveryGrantProblem(delivery(), { ...operator, isAdmin: true, repositoryIds: [] }),
    ).toContain("access");
    expect(
      webhookRecoveryGrantProblem(delivery(), { ...operator, permissions: ["task:create"] }),
    ).toContain("management");
    expect(
      webhookRecoveryGrantProblem(delivery(), { ...operator, permissions: ["repository:manage"] }),
    ).toContain("task creation");
    expect(
      webhookRecoveryGrantProblem(delivery(), { ...operator, allowRepositoryExecution: false }),
    ).toContain("execution");
    expect(
      webhookRecoveryGrantProblem(delivery({ mode: "static" }), {
        ...operator,
        allowRepositoryExecution: false,
      }),
    ).toBeNull();
    expect(webhookCanStartRecovery(delivery())).toBe(true);
    for (const record of [
      delivery({ state: "completed" }),
      delivery({ state: "accepted" }),
      delivery({ nextAttemptAt: timestamp }),
      delivery({ canonicalDeliveryId: "canonical" }),
      delivery({ availableActions: [] }),
    ])
      expect(webhookCanStartRecovery(record)).toBe(false);
  });

  it("retains a lost response across detail and list mounts and resends only the original command", async () => {
    const queryClient = client();
    const key = webhookRecoveryQueryKey("delivery-1");
    queryClient.setQueryData(key, null);
    const command = createWebhookRecoveryRequest(delivery(), "saved-command", timestamp);
    const send = vi
      .spyOn(investigationApi, "retryWebhookDelivery")
      .mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce(
        delivery({
          state: "completed",
          version: "latest-version",
          availableActions: [],
          taskId: "task-existing",
        }),
      );
    await submitWebhookRecoveryRequest(queryClient, command);
    expect(queryClient.getQueryData(key)).toMatchObject({
      state: "unknown",
      version: "opaque-version",
      idempotencyKey: "saved-command",
      transmissions: 1,
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WebhookRetryControls delivery={delivery()} user={operator} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Recovery request unconfirmed");
    expect(html).toContain("Refresh event status");
    expect(html).toContain("Retry saved request");
    expect(html).not.toContain(">Retry event</button>");
    expect(html).toContain("Recovery request details");
    expect(html).toContain("saved-command");
    expect(html).toContain("opaque-version");
    expect(withoutDiagnosticDisclosures(html)).not.toContain("saved-command");
    expect(withoutDiagnosticDisclosures(html)).not.toContain("opaque-version");
    const list = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveryHistory items={[delivery()]} showRecoveryRequests />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(list).toContain("Recovery request unconfirmed");
    const read = vi
      .spyOn(investigationApi, "webhookDelivery")
      .mockResolvedValue(
        delivery({ state: "completed", version: "latest-version", availableActions: [] }),
      );
    await refreshWebhookRecoveryRequest(queryClient, "delivery-1");
    expect(read).toHaveBeenCalledWith("delivery-1");
    expect(queryClient.getQueryData(key)).toMatchObject({
      state: "unknown",
      version: "opaque-version",
      idempotencyKey: "saved-command",
    });
    await submitWebhookRecoveryRequest(
      queryClient,
      createWebhookRecoveryRequest(
        delivery({ version: "latest-version" }),
        "different-command",
        timestamp,
      ),
    );
    expect(send).toHaveBeenCalledTimes(1);
    await submitWebhookRecoveryRequest(
      queryClient,
      queryClient.getQueryData<WebhookRecoveryRequest>(key)!,
    );
    expect(send.mock.calls).toEqual([
      ["delivery-1", { version: "opaque-version", idempotencyKey: "saved-command" }],
      ["delivery-1", { version: "opaque-version", idempotencyKey: "saved-command" }],
    ]);
    expect(queryClient.getQueryData(key)).toMatchObject({ state: "accepted", transmissions: 2 });
    expect(queryClient.getQueryData(webhookDeliveryQueryKey("delivery-1"))).toMatchObject({
      taskId: "task-existing",
    });
    await submitWebhookRecoveryRequest(queryClient, command);
    expect(send).toHaveBeenCalledTimes(2);
    queryClient.clear();
  });

  it("requires a latest-status read after a conflict and retains a separate review gate", async () => {
    const queryClient = client();
    const key = webhookRecoveryQueryKey("delivery-1");
    queryClient.setQueryData(key, null);
    const send = vi
      .spyOn(investigationApi, "retryWebhookDelivery")
      .mockRejectedValue(new InvestigationHttpError(409, "stale receipt"));
    await submitWebhookRecoveryRequest(
      queryClient,
      createWebhookRecoveryRequest(delivery(), "rejected-command", timestamp),
    );
    expect(queryClient.getQueryData(key)).toMatchObject({ state: "conflict" });
    const controls = () =>
      renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <WebhookRetryControls delivery={delivery()} user={operator} />
        </QueryClientProvider>,
      );
    expect(controls()).toContain("Load latest status");
    await submitWebhookRecoveryRequest(
      queryClient,
      createWebhookRecoveryRequest(delivery(), "premature-command", timestamp),
    );
    expect(send).toHaveBeenCalledTimes(1);
    vi.spyOn(investigationApi, "webhookDelivery").mockResolvedValue(
      delivery({ version: "new-version" }),
    );
    await refreshWebhookRecoveryRequest(queryClient, "delivery-1");
    expect(queryClient.getQueryData(key)).toMatchObject({
      state: "refreshed",
      idempotencyKey: "rejected-command",
    });
    expect(controls()).toContain("Review recovery before submitting another request");
    expect(send).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });

  it("does not restore a previous session's data when a pending request completes", async () => {
    const queryClient = client();
    const key = webhookRecoveryQueryKey("delivery-1");
    queryClient.setQueryData(key, null);
    let resolveRequest!: (value: InvestigationWebhookDelivery) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.spyOn(investigationApi, "retryWebhookDelivery").mockImplementation(() => {
      markStarted();
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    });
    const submitting = submitWebhookRecoveryRequest(
      queryClient,
      createWebhookRecoveryRequest(delivery(), "old-session", timestamp),
    );
    await started;
    queryClient.clear();
    queryClient.setQueryData(key, null);
    resolveRequest(delivery({ state: "completed", taskId: "private-task" }));
    await submitting;
    expect(queryClient.getQueryData(key)).toBeNull();
    expect(queryClient.getQueryData(webhookDeliveryQueryKey("delivery-1"))).toBeUndefined();
    queryClient.clear();
  });

  it("does not erase uncertainty when the response identifies another receipt", async () => {
    const queryClient = client();
    const key = webhookRecoveryQueryKey("delivery-1");
    queryClient.setQueryData(key, null);
    vi.spyOn(investigationApi, "retryWebhookDelivery").mockResolvedValue(
      delivery({ deliveryId: "another-event", repositoryId: "another-repo" }),
    );
    await submitWebhookRecoveryRequest(
      queryClient,
      createWebhookRecoveryRequest(delivery(), "retained-command", timestamp),
    );
    expect(queryClient.getQueryData(key)).toMatchObject({
      state: "unknown",
      idempotencyKey: "retained-command",
    });
    expect(queryClient.getQueryData(webhookDeliveryQueryKey("delivery-1"))).toBeUndefined();
    queryClient.clear();
  });

  it("keeps one in-flight command when controls remount or submission is repeated", async () => {
    const queryClient = client();
    const key = webhookRecoveryQueryKey("delivery-1");
    queryClient.setQueryData(key, null);
    let finish!: (value: InvestigationWebhookDelivery) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const send = vi.spyOn(investigationApi, "retryWebhookDelivery").mockImplementation(() => {
      notifyStarted();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const command = createWebhookRecoveryRequest(delivery(), "one-in-flight-command", timestamp);
    const pending = submitWebhookRecoveryRequest(queryClient, command);
    await started;
    await submitWebhookRecoveryRequest(queryClient, command);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WebhookRetryControls delivery={delivery()} user={operator} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Recovery request in progress");
    expect(send).toHaveBeenCalledTimes(1);
    finish(delivery({ state: "accepted", availableActions: [] }));
    await pending;
    expect(queryClient.getQueryData(key)).toMatchObject({ state: "accepted", transmissions: 1 });
    queryClient.clear();
  });

  it("does not let a slow status read replace a newer command response", async () => {
    const queryClient = client();
    const key = webhookRecoveryQueryKey("delivery-1");
    queryClient.setQueryData(key, null);
    let finishRead!: (value: InvestigationWebhookDelivery) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    vi.spyOn(investigationApi, "webhookDelivery").mockImplementation(() => {
      notifyStarted();
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    });
    const reading = refreshWebhookRecoveryRequest(queryClient, "delivery-1");
    await started;
    vi.spyOn(investigationApi, "retryWebhookDelivery").mockResolvedValue(
      delivery({ state: "completed", version: "confirmed-version", taskId: "recovered-task" }),
    );
    await submitWebhookRecoveryRequest(
      queryClient,
      createWebhookRecoveryRequest(delivery(), "new-command", timestamp),
    );
    finishRead(delivery());
    await reading;
    expect(queryClient.getQueryData(webhookDeliveryQueryKey("delivery-1"))).toMatchObject({
      version: "confirmed-version",
      taskId: "recovered-task",
    });
    expect(queryClient.getQueryData(key)).toMatchObject({ state: "accepted" });
    queryClient.clear();
  });

  it("links a report only when its task, source, version, and digest match the recorded association", async () => {
    const api = createSampleInvestigationApi();
    const report = await api.report("sample-pr-p1-report");
    const detail = await api.task(report.context.task.id);
    const { task } = detail;
    const record = delivery({
      mode: "static",
      taskId: task.id,
      repositoryId: task.repository.id,
      kind: task.workItem.kind,
      number: task.workItem.number,
    });
    expect(webhookTaskMatches(record, task)).toBe(true);
    expect(webhookTaskMatches({ ...record, number: record.number + 1 }, task)).toBe(false);
    expect(webhookTaskMatches({ ...record, repositoryId: "different-repository" }, task)).toBe(
      false,
    );
    expect(webhookTaskMatches({ ...record, mode: "e2e" }, task)).toBe(false);
    expect(webhookReportMatches(record, task, report)).toBe(true);
    expect(
      webhookReportMatches(record, task, {
        ...report,
        context: { ...report.context, task: { ...report.context.task, id: "other-task" } },
      }),
    ).toBe(false);
    expect(
      webhookReportMatches(record, task, {
        ...report,
        context: {
          ...report.context,
          workItem: { ...report.context.workItem, id: "other-source" },
        },
      }),
    ).toBe(false);
    expect(
      webhookReportMatches(record, task, {
        ...report,
        report: { ...report.report, version: report.report.version + 1 },
      }),
    ).toBe(false);
    expect(
      webhookReportMatches(record, task, {
        ...report,
        report: { ...report.report, logicalContentDigest: "b".repeat(64) },
      }),
    ).toBe(false);
    const queryClient = client();
    queryClient.setQueryData(webhookDeliveryQueryKey(record.deliveryId), record);
    queryClient.setQueryData(["investigation-repositories"], { items: [] });
    queryClient.setQueryData(
      ["investigation-webhook-linked-task", record.repositoryId, task.id],
      detail,
    );
    const renderDetails = () =>
      renderToStaticMarkup(
        <MemoryRouter initialEntries={[webhookDetailsUrl(record.deliveryId, record.repositoryId)]}>
          <QueryClientProvider client={queryClient}>
            <WebhookDeliveryDetails deliveryId={record.deliveryId} />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    const html = renderDetails();
    expect(html).toContain(
      `/comments?repositoryId=${encodeURIComponent(record.repositoryId)}&amp;taskId=${encodeURIComponent(task.id)}`,
    );
    expect(html).toContain(
      `/pull-requests?repositoryId=${encodeURIComponent(record.repositoryId)}&amp;workItemId=${encodeURIComponent(task.workItem.id)}`,
    );
    expect(html).toContain("Open task report");
    queryClient.setQueryData(["investigation-webhook-linked-task", record.repositoryId, task.id], {
      ...detail,
      task: { ...task, workItem: { ...task.workItem, number: task.workItem.number + 1 } },
    });
    const mismatched = renderDetails();
    expect(mismatched).not.toContain("Open task report");
    expect(mismatched).not.toContain("Open comment publications");
    expect(mismatched).not.toContain("Open review source");
    expect(mismatched).toContain("Refresh task");
    queryClient.clear();
  });

  it("keeps history and canonical task associations readable while assignment intake is paused", () => {
    const queryClient = client();
    queryClient.setQueryData(
      webhookDeliveryQueryKey("delivery-1"),
      delivery({ state: "completed", taskId: "existing-task", availableActions: [] }),
    );
    queryClient.setQueryData(["investigation-repositories"], { items: [] });
    queryClient.setQueryData(["investigation-webhook-intake-settings", "repo-1"], {
      repositoryId: "repo-1",
      enabled: false,
    });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/webhooks?repositoryId=repo-1"]}>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveryDetails deliveryId="delivery-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("Assignment intake is paused");
    expect(html).toContain("Event history");
    expect(html).toContain("taskId=existing-task");
    expect(html).toMatch(/datetime="2026-09-19T02:00:00\.000Z"/i);
    expect(html).not.toContain("Retry event");
    queryClient.clear();
  });

  it("keeps the recorded GitHub source visible after a read failure and blocks a new recovery", async () => {
    const queryClient = client();
    queryClient.setQueryData(webhookDeliveryQueryKey("delivery-1"), delivery());
    queryClient.setQueryData(["investigation-repositories"], { items: [] });
    await queryClient.prefetchQuery({
      queryKey: webhookDeliveryQueryKey("delivery-1"),
      queryFn: () => Promise.reject(new Error("Event refresh unavailable")),
    });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[webhookDetailsUrl("delivery-1", "repo-1")]}>
        <QueryClientProvider client={queryClient}>
          <WebhookDeliveryDetails deliveryId="delivery-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("Event refresh unavailable");
    expect(html).toContain("Refresh before retrying");
    expect(html).toContain('href="https://github.com/owner/repository/pull/7"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/<button\b[^>]*disabled=""[^>]*>Retry event<\/button>/u);
    queryClient.clear();
  });
});
