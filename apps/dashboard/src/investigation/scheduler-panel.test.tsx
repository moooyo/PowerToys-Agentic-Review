import type { InvestigationSchedulerStatus, InvestigationSession } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSchedulerDraft,
  isSchedulerDraftDirty,
  parseStaticConcurrency,
  SchedulerForm,
  SchedulerPanel,
  schedulerDraftReducer,
  schedulerQueryKey,
  submitStaticConcurrency,
} from "./scheduler-panel";

const context = vi.hoisted(() => ({
  session: { user: { isAdmin: false } } as InvestigationSession,
}));
vi.mock("./session", () => ({ useInvestigationSession: () => ({ session: context.session }) }));

const status: InvestigationSchedulerStatus = {
  staticConcurrency: 4,
  e2eConcurrency: 1,
  occupiedStatic: 2,
  occupiedE2e: 1,
  leases: [
    {
      taskId: "task-e2e",
      attemptId: "attempt-e2e",
      workerId: "desktop-worker",
      fence: 2,
      pool: "e2e",
      state: "needs_cleanup",
      acquiredAt: "2026-09-19T01:00:00.000Z",
      updatedAt: "2026-09-19T01:02:00.000Z",
      releasedAt: null,
      reason: "cancel_requested",
    },
  ],
};

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
}

function renderPanel(client: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SchedulerPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderStatus(value: InvestigationSchedulerStatus = status) {
  const client = queryClient();
  client.setQueryData(schedulerQueryKey, value);
  return renderPanel(client);
}

beforeEach(() => {
  context.session = {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00Z",
    user: {
      id: "operator",
      username: "operator",
      displayName: "Operator",
      email: null,
      isAdmin: false,
      repositoryIds: ["repo-selected"],
      permissions: ["repository:manage"],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    },
  };
});

describe("global task concurrency controls", () => {
  it("updates only the static limit and rejects invalid input before a mutation", async () => {
    const update = vi.fn(async (input: { staticConcurrency: number }) => ({ ...status, ...input }));
    expect(await submitStaticConcurrency("6", update)).toMatchObject({
      staticConcurrency: 6,
      e2eConcurrency: 1,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ staticConcurrency: 6 });
    for (const invalid of ["0", "17", "1.5", "-1", "1e1", "0x10", "04", "", "NaN"])
      await expect(submitStaticConcurrency(invalid, update)).rejects.toThrow("between 1 and 16");
    expect(update).toHaveBeenCalledTimes(1);
    expect(parseStaticConcurrency(" 1 ")).toBe(1);
    expect(parseStaticConcurrency("16")).toBe(16);
  });

  it("keeps the global setting read-only for repository managers who are not administrators", () => {
    const html = renderStatus();
    expect(html).toContain("Only workspace administrators");
    expect(html).toContain("All repositories");
    expect(html).not.toContain("Save changes");
  });

  it("uses administrator status independently from repository grants or business permissions", () => {
    if (!context.session.authenticated) throw new Error("An authenticated fixture is required.");
    context.session.user.isAdmin = true;
    context.session.user.repositoryIds = [];
    context.session.user.permissions = [];
    const html = renderStatus();
    expect(html).toContain("Save changes");
    expect(html).toContain("Reload");
    expect(html).toContain("Discard changes");
  });

  it("shows backend cleanup ownership independently of static capacity", () => {
    const html = renderStatus();
    expect(html).toContain("2 of 4 static slots occupied");
    expect(html).toContain("1 / 1 occupied");
    expect(html).toContain("Needs cleanup");
    expect(html).toContain("Cleanup pending");
    expect(html).toContain("The next E2E task waits until cleanup finishes");
    expect(html).toContain("Waiting for worker cleanup confirmation");
    expect(html).toContain("taskId=task-e2e");
    expect(html).toContain("attempt-e2e");
    expect(html).toContain("desktop-worker");
  });

  it("retains global occupancy when all resource owners are outside the account's access", () => {
    const html = renderStatus({ ...status, leases: [] });
    expect(html).toContain("2 of 4 static slots occupied");
    expect(html).toContain("1 / 1 occupied");
    expect(html).toContain("Reserved until cleanup is confirmed");
    expect(html).toContain("No resource owners within your repository access");
    expect(html).not.toContain("No E2E slot is occupied");
  });

  it("does not report static cleanup as ownership of the exclusive E2E slot", () => {
    const html = renderStatus({
      ...status,
      occupiedE2e: 0,
      occupiedStatic: 1,
      leases: status.leases.map((lease) => ({ ...lease, pool: "static" })),
    });
    expect(html).toContain("0 / 1 occupied");
    expect(html).toContain("Needs cleanup");
    expect(html).not.toContain("The next E2E task waits until cleanup finishes");
    expect(html).not.toContain("Waiting for worker cleanup confirmation");
  });

  it("shows held leases as ownership without inventing a running task state", () => {
    const html = renderStatus({
      ...status,
      leases: status.leases.map((lease) => ({ ...lease, state: "held", reason: null })),
    });
    expect(html).toContain("Slot held");
    expect(html).not.toContain("Running");
    expect(html).not.toContain("Needs cleanup");
  });

  it("does not show released leases as current resource owners", () => {
    const html = renderStatus({
      ...status,
      occupiedE2e: 0,
      occupiedStatic: 0,
      leases: status.leases.map((lease) => ({
        ...lease,
        state: "released",
        releasedAt: "2026-09-19T01:03:00.000Z",
      })),
    });
    expect(html).toContain("No resource owners within your repository access");
    expect(html).not.toContain("taskId=task-e2e");
    expect(html).not.toContain("Cleanup pending");
  });

  it("shows real occupancy above a reduced limit without cancelling existing work", () => {
    const html = renderToStaticMarkup(
      <SchedulerForm
        status={{ ...status, staticConcurrency: 1, occupiedStatic: 3 }}
        canEdit
        onSave={async () => {}}
      />,
    );
    expect(html).toContain("3 of 1 static slots occupied");
    expect(html).toContain("Occupied slots exceed the limit");
    expect(html).toContain("Existing slots stay reserved until released");
    expect(html).toContain("Lowering the limit lets running work finish");
  });

  it("provides a loading state and a retryable read failure", async () => {
    expect(renderPanel(queryClient())).toContain("Loading global scheduler");
    const client = queryClient();
    await client.prefetchQuery({
      queryKey: schedulerQueryKey,
      queryFn: () => Promise.reject(new Error("Scheduler is unavailable.")),
    });
    const html = renderPanel(client);
    expect(html).toContain("Scheduler is unavailable.");
    expect(html).toContain("Retry scheduler");
    expect(html).not.toContain("Unoccupied");
  });

  it("retains the last known occupancy after a failed background refresh", async () => {
    const client = queryClient();
    client.setQueryData(schedulerQueryKey, status);
    await client.prefetchQuery({
      queryKey: schedulerQueryKey,
      queryFn: () => Promise.reject(new Error("Refresh failed.")),
    });
    const html = renderPanel(client);
    expect(html).toContain("Refresh failed.");
    expect(html).toContain("last received occupancy remains visible");
    expect(html).toContain("1 / 1 occupied");
    expect(html).toContain("Needs cleanup");
  });
});

describe("scheduler draft and concurrent refreshes", () => {
  it("accepts a changed saved value when no draft is pending", () => {
    const draft = schedulerDraftReducer(createSchedulerDraft(4), { type: "receive", value: 8 });
    expect(draft).toEqual({ value: "8", baseline: 8, latest: 8 });
    expect(isSchedulerDraftDirty(draft)).toBe(false);
  });

  it("keeps an edited value and its original baseline when another administrator changes the limit", () => {
    const edited = schedulerDraftReducer(createSchedulerDraft(4), { type: "edit", value: "6" });
    const refreshed = schedulerDraftReducer(edited, { type: "receive", value: 8 });
    const refreshedAgain = schedulerDraftReducer(refreshed, { type: "receive", value: 10 });
    expect(refreshedAgain).toEqual({ value: "6", baseline: 4, latest: 10 });
    expect(isSchedulerDraftDirty(refreshedAgain)).toBe(true);
  });

  it("does not overwrite an invalid draft during polling", () => {
    const edited = schedulerDraftReducer(createSchedulerDraft(4), { type: "edit", value: "1.5" });
    expect(schedulerDraftReducer(edited, { type: "receive", value: 4 })).toBe(edited);
    const refreshed = schedulerDraftReducer(edited, { type: "receive", value: 8 });
    expect(refreshed.value).toBe("1.5");
    expect(isSchedulerDraftDirty(refreshed)).toBe(true);
  });

  it("recognizes a matching remote save without leaving a false unsaved-change guard", () => {
    const edited = schedulerDraftReducer(createSchedulerDraft(4), { type: "edit", value: "6" });
    const refreshed = schedulerDraftReducer(edited, { type: "receive", value: 6 });
    expect(refreshed).toEqual(createSchedulerDraft(6));
    expect(isSchedulerDraftDirty(refreshed)).toBe(false);
  });

  it("keeps an edit back to the original value dirty after the saved value changed", () => {
    const edited = schedulerDraftReducer(createSchedulerDraft(4), { type: "edit", value: "6" });
    const refreshed = schedulerDraftReducer(edited, { type: "receive", value: 8 });
    const reverted = schedulerDraftReducer(refreshed, { type: "edit", value: "4" });
    expect(isSchedulerDraftDirty(reverted)).toBe(true);
    expect(reverted).toEqual({ value: "4", baseline: 4, latest: 8 });
  });

  it("discards to the latest received value even if polling continued during confirmation", () => {
    const edited = schedulerDraftReducer(createSchedulerDraft(4), { type: "edit", value: "6" });
    const refreshed = schedulerDraftReducer(edited, { type: "receive", value: 8 });
    const refreshedAgain = schedulerDraftReducer(refreshed, { type: "receive", value: 10 });
    const discarded = schedulerDraftReducer(refreshedAgain, { type: "discard" });
    expect(discarded).toEqual(createSchedulerDraft(10));
    expect(isSchedulerDraftDirty(discarded)).toBe(false);
  });

  it("rebases on the saved value returned by an explicit reload", () => {
    const edited = schedulerDraftReducer(createSchedulerDraft(4), { type: "edit", value: "6" });
    const refreshed = schedulerDraftReducer(edited, { type: "receive", value: 8 });
    const reset = schedulerDraftReducer(refreshed, { type: "reset", value: 8 });
    expect(reset).toEqual(createSchedulerDraft(8));
    expect(isSchedulerDraftDirty(reset)).toBe(false);
  });

  it("accepts the actual save response as the new baseline", () => {
    const edited = schedulerDraftReducer(createSchedulerDraft(4), { type: "edit", value: "6" });
    const saved = schedulerDraftReducer(edited, { type: "saved", value: 7 });
    expect(saved).toEqual(createSchedulerDraft(7));
    expect(isSchedulerDraftDirty(saved)).toBe(false);
  });
});
