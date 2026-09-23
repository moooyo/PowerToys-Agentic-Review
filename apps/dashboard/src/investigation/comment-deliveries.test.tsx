import type {
  InvestigationCommentDelivery,
  InvestigationCommentPublicationSummary,
} from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  CommentContextLinks,
  CommentDeliveryHistory,
  CommentDeliveryHistoryPanel,
  CommentPublicationControls,
  commentDeliveriesQueryKey,
  commentPollingInterval,
  commentQueryKey,
  publicationKindLabel,
  publicationsQueryKey,
  safeCommentUrl,
  TaskComments,
} from "./comment-deliveries";
import CommentsPage, {
  CommentDetails,
  commentHistoryFilters,
  commentPublicationFilters,
  commentPublicationFilterUrl,
} from "./comments-page";

vi.mock("./session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    useInvestigationSession: () => ({
      session: {
        authenticated: true,
        user: {
          id: "reader",
          username: "reader",
          displayName: "Reader",
          email: null,
          isAdmin: false,
          repositoryIds: ["repo-1"],
          permissions: [],
          actionCapabilities: [],
          allowRepositoryExecution: false,
        },
      },
    }),
  };
});

const timestamp = "2026-09-19T02:00:00.000Z";
function summary(
  overrides: Partial<InvestigationCommentPublicationSummary> = {},
): InvestigationCommentPublicationSummary {
  return {
    id: "comment-1",
    version: "publication-version",
    mode: "progress",
    repositoryId: "repo-1",
    repositoryFullName: "owner/repository",
    workItemId: "item-1",
    workItemKind: "pull_request",
    workItemNumber: 7,
    taskId: "task-1",
    reportId: null,
    state: "synced",
    reasonCode: null,
    reason: null,
    requiresAttention: false,
    nextAttemptAt: null,
    lastAttemptAt: timestamp,
    lastConfirmedAt: timestamp,
    externalId: "9876543210123456789",
    commentUrl: "https://github.com/owner/repository/pull/7#issuecomment-9876543210123456789",
    availableActions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
function delivery(
  overrides: Partial<InvestigationCommentDelivery> = {},
): InvestigationCommentDelivery {
  return {
    id: "attempt-1",
    commentId: "comment-1",
    mode: "progress",
    repositoryId: "repo-1",
    repositoryFullName: "owner/repository",
    workItemId: "item-1",
    workItemKind: "pull_request",
    workItemNumber: 7,
    taskId: "task-1",
    reportId: null,
    operation: "create",
    state: "succeeded",
    body: "Received the assignment.",
    externalId: "9876543210123456789",
    startedAt: timestamp,
    finishedAt: timestamp,
    reason: null,
    effect: "applied",
    attemptNumber: 1,
    settingsVersion: 2,
    templateVersion: 1,
    legacy: false,
    observations: [],
    ...overrides,
  };
}
function renderHistory(items: InvestigationCommentDelivery[]) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CommentDeliveryHistory items={items} />
    </MemoryRouter>,
  );
}

describe("comment delivery history", () => {
  it("retains each create and update body with its own status and safe failure explanation", () => {
    const html = renderHistory([
      delivery(),
      delivery({
        id: "attempt-2",
        operation: "update",
        state: "failed",
        effect: "rejected",
        body: "Completed\n<script>unsafe()</script>",
        reason: "GitHub rejected the update.",
      }),
      delivery({
        id: "attempt-3",
        operation: "update",
        state: "unknown",
        effect: "unknown",
        body: "Another attempted completion.",
      }),
    ]);
    expect(html).toContain("Create");
    expect(html.match(/View delivery details/gu)).toHaveLength(3);
    expect(html).toContain("Received the assignment.");
    expect(html).toContain("GitHub rejected the update.");
    expect(html).toContain("Unconfirmed");
    expect(html).toContain("may have reached GitHub");
    expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Target body");
    expect(html).not.toContain("Confirmed body");
    expect(html).not.toContain("publication-version");
  });

  it("keeps reconciliation evidence on the same write row and trusts the server delivery outcome", () => {
    const record = delivery({
      state: "succeeded",
      effect: "applied",
      observations: [
        { at: timestamp, state: "unknown", reason: "The earlier body is still visible." },
        {
          at: "2026-09-19T02:01:00.000Z",
          state: "succeeded",
          reason: "The exact attempted body was found.",
        },
        { at: "2026-09-19T02:02:00.000Z", state: "failed", reason: "A later read was rejected." },
      ],
    });
    const html = renderHistory([record]);
    expect(html.match(/View delivery details/gu)).toHaveLength(1);
    expect(html).toContain("Delivered");
    expect(html).not.toContain("Original outcome");
    expect(html).toContain("The exact attempted body was found.");
    expect(record.state).toBe("succeeded");
    const unresolved = renderHistory([
      delivery({
        state: "unknown",
        observations: [{ at: timestamp, state: "failed", reason: "The read failed." }],
      }),
    ]);
    expect(unresolved).toContain("may have reached GitHub");
  });

  it("shows superseded deliveries as neutral cancellations and retains genuine failures", () => {
    const html = renderHistory([
      delivery({
        operation: "update",
        state: "cancelled",
        effect: "not_sent",
        reason: "A newer task update superseded this prepared comment before it was sent.",
      }),
    ]);
    expect(html).toContain("Cancelled");
    expect(html).toContain("MuiChip-colorDefault");
    expect(html).not.toContain("MuiChip-colorError");
    expect(html).not.toContain(">Failed<");
    expect(html).toContain("A newer task update superseded this prepared comment");
    for (const effect of ["not_sent", "rejected"] as const) {
      const failed = renderHistory([
        delivery({ state: "failed", effect, reason: "Comment preparation or delivery failed." }),
      ]);
      expect(failed).toContain("Failed");
      expect(failed).toContain("MuiChip-colorError");
      expect(failed).not.toContain("Cancelled");
    }
  });

  it("shows preparation and retained legacy evidence without inventing a Task or earlier attempts", () => {
    const html = renderHistory([
      delivery({ taskId: null, workItemId: null, legacy: true, body: null }),
    ]);
    expect(html).toContain("Assignment preparation");
    expect(html).not.toContain("Open task");
    expect(html).toContain("Earlier delivery history is unavailable");
    expect(html).toContain("No prepared comment body was retained");
    expect(renderHistory([])).toContain("No comment deliveries recorded yet");
  });

  it("continues polling unresolved comment delivery after task execution completes", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const queryInput = { taskId: "task-1", cursor: undefined, limit: 25 };
    client.setQueryData(publicationsQueryKey(queryInput), {
      items: [
        summary({ state: "unconfirmed", requiresAttention: true, availableActions: ["reconcile"] }),
      ],
      nextCursor: null,
    });
    client.setQueryData(
      commentDeliveriesQueryKey({ taskId: "task-1", cursor: undefined, limit: 25 }),
      { items: [delivery({ state: "unknown" })], nextCursor: null },
    );
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TaskComments taskId="task-1" active={false} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("Unconfirmed");
    expect(html).toContain("commentId=comment-1");
    expect(html).not.toContain("Sync latest progress");
    const saved = client.getQueryCache().find({ queryKey: publicationsQueryKey(queryInput) });
    const interval: unknown = saved && Reflect.get(saved.options, "refetchInterval");
    expect(typeof interval).toBe("function");
    if (typeof interval === "function" && saved) expect(interval(saved)).toBe(30_000);
    client.clear();
  });

  it("uses only available server actions and validated GitHub links", () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CommentPublicationControls
          comment={summary({ state: "unconfirmed", availableActions: [] })}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("No delivery check is currently available");
    expect(html).not.toMatch(/<button[^>]*>Check delivery<\/button>/u);
    expect(html).not.toContain("Sync latest progress");
    expect(html).toContain("View GitHub comment");
    expect(safeCommentUrl(summary())).toContain("9876543210123456789");
    expect(safeCommentUrl(summary({ commentUrl: "javascript:alert(1)" }))).toBeUndefined();
    expect(safeCommentUrl(summary({ externalId: "another-comment" }))).toBeUndefined();
    expect(safeCommentUrl(summary({ workItemNumber: 8 }))).toBeUndefined();
    client.clear();
  });

  it("keeps synchronization polling bounded and stops dense polling for stable comments", () => {
    expect(commentPollingInterval([summary()])).toBe(false);
    expect(commentPollingInterval([summary({ state: "pending" })])).toBe(5_000);
    expect(commentPollingInterval([summary({ state: "sending" })])).toBe(5_000);
    expect(
      commentPollingInterval(
        [summary({ state: "retrying", nextAttemptAt: "2026-09-19T02:00:10.000Z" })],
        Date.parse(timestamp),
      ),
    ).toBe(11_000);
    expect(
      commentPollingInterval(
        [summary({ state: "retrying", nextAttemptAt: "2026-09-20T02:00:00.000Z" })],
        Date.parse(timestamp),
      ),
    ).toBe(30_000);
    expect(
      commentPollingInterval([summary({ state: "needs_attention", requiresAttention: true })]),
    ).toBe(30_000);
  });

  it("keeps server history filters in shareable URLs and rejects invalid positive numbers", () => {
    expect(
      commentHistoryFilters("?repositoryId=repo-1&taskId=task-1&workItemNumber=7&state=failed"),
    ).toEqual({ repositoryId: "repo-1", taskId: "task-1", workItemNumber: 7, state: "failed" });
    expect(commentHistoryFilters("?state=cancelled")).toEqual({ state: "cancelled" });
    for (const number of ["0", "-1", "7.5", "9007199254740992", "one"])
      expect(commentHistoryFilters(`?workItemNumber=${number}`)).toEqual({});
    expect(commentHistoryFilters("?state=completed")).toEqual({});
  });

  it("keeps publication filters separate from attempt outcomes and uses real producer kinds", () => {
    expect(
      commentPublicationFilters(
        "?repositoryId=repo-1&taskId=task-1&workItemNumber=7&state=needs_attention&mode=result&taskKind=pr-e2e&search=%20focus%20",
      ),
    ).toEqual({
      repositoryId: "repo-1",
      taskId: "task-1",
      workItemNumber: 7,
      state: "needs_attention",
      mode: "result",
      taskKind: "pr-e2e",
      search: "focus",
    });
    expect(
      commentPublicationFilters("?state=failed&mode=e2e&taskKind=invented&workItemNumber=-1"),
    ).toEqual({});
    expect(publicationKindLabel(summary({ mode: "result", producerTaskKind: "pr-e2e" }))).toBe(
      "E2E result",
    );
    expect(publicationKindLabel(summary({ producerTaskKind: "pr-e2e" }))).toBe("E2E progress");
    expect(
      publicationKindLabel(summary({ taskId: "e2e-looking-name", producerTaskKind: null })),
    ).toBe("Progress update");
  });

  it("links only recorded source, task, and report identities", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentContextLinks comment={summary({ reportId: "report-exact" })} />
      </MemoryRouter>,
    );
    expect(html).toContain("workItemId=item-1");
    expect(html).toContain("taskId=task-1");
    expect(html).toContain("reportId=report-exact");
    const preparation = renderToStaticMarkup(
      <MemoryRouter>
        <CommentContextLinks
          comment={summary({ workItemId: null, taskId: null, reportId: null })}
        />
      </MemoryRouter>,
    );
    expect(preparation).toContain('href="https://github.com/owner/repository/pull/7"');
    expect(preparation).toContain('target="_blank"');
    expect(preparation).toContain('rel="noopener noreferrer"');
    expect(preparation).not.toContain("workItemId=");
    expect(preparation).not.toContain("taskId=");
    expect(preparation).not.toContain("reportId=");
  });

  it("removes only the selected publication filter while retaining exact scope and other filters", () => {
    const filters = commentPublicationFilters(
      "?repositoryId=repo-1&workItemId=item-1&taskId=task-1&state=needs_attention&search=focus",
    );
    const withoutTask = commentPublicationFilters(
      commentPublicationFilterUrl(filters, "taskId").split("?")[1] ?? "",
    );
    expect(withoutTask).toEqual({
      repositoryId: "repo-1",
      workItemId: "item-1",
      state: "needs_attention",
      search: "focus",
    });
  });

  it("always offers additional publication filters and exposes individually removable exact filters", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={["/comments?repositoryId=repo-1&taskId=task-1&workItemNumber=7"]}
      >
        <QueryClientProvider client={queryClient}>
          <CommentsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("comments-more-filters");
    expect(html).not.toContain("comments-mobile-filter");
    expect(html).toContain("More filters");
    expect(html).toContain('aria-label="Remove Task ID: task-1"');
    expect(html).toContain('aria-label="Remove Source: #7"');
    queryClient.clear();
  });

  it("retains the last publication body and GitHub source when a later status read fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
    });
    queryClient.setQueryData(commentQueryKey("comment-1"), summary());
    queryClient.setQueryData(
      commentDeliveriesQueryKey({ commentId: "comment-1", cursor: undefined, limit: 25 }),
      {
        items: [delivery({ body: "Retained body from the recorded delivery." })],
        nextCursor: null,
      },
    );
    await queryClient.prefetchQuery({
      queryKey: commentQueryKey("comment-1"),
      queryFn: () => Promise.reject(new Error("Refresh unavailable")),
    });
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/comments?repositoryId=repo-1&commentId=comment-1"]}>
        <QueryClientProvider client={queryClient}>
          <CommentDetails commentId="comment-1" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("Refresh unavailable");
    expect(html).toContain("last loaded publication");
    expect(html).toContain("Retained body from the recorded delivery.");
    expect(html).toContain('href="https://github.com/owner/repository/pull/7"');
    queryClient.clear();
  });

  it("shows every returned publication for a task without collapsing result into progress", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(publicationsQueryKey({ taskId: "task-1", cursor: undefined, limit: 25 }), {
      items: [summary(), summary({ id: "comment-result", mode: "result", reportId: "report-1" })],
      nextCursor: "next-page",
    });
    client.setQueryData(
      commentDeliveriesQueryKey({ taskId: "task-1", cursor: undefined, limit: 25 }),
      { items: [], nextCursor: null },
    );
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <TaskComments taskId="task-1" active={false} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("commentId=comment-1");
    expect(html).toContain("commentId=comment-result");
    expect(html).toContain("Next publications");
    client.clear();
  });

  it("does not show history returned for a different task", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(
      commentDeliveriesQueryKey({ taskId: "task-1", cursor: undefined, limit: 25 }),
      {
        items: [delivery({ taskId: "another-task", body: "Another task's private body" })],
        nextCursor: null,
      },
    );
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <CommentDeliveryHistoryPanel filters={{ taskId: "task-1" }} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(html).toContain("does not match the selected publication or task");
    expect(html).not.toContain("Another task&#x27;s private body");
    client.clear();
  });
});
