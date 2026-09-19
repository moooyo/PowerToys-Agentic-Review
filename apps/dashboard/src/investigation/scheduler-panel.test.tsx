import type { InvestigationSchedulerStatus, InvestigationSession } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  SchedulerForm,
  SchedulerPanel,
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

describe("global task concurrency controls", () => {
  it("updates only the static limit and rejects invalid input before a mutation", async () => {
    const update = vi.fn(async (input: { staticConcurrency: number }) => ({ ...status, ...input }));
    expect(await submitStaticConcurrency("6", update)).toMatchObject({
      staticConcurrency: 6,
      e2eConcurrency: 1,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ staticConcurrency: 6 });
    for (const invalid of ["0", "17", "1.5", "-1", "1e1", "", "NaN"])
      await expect(submitStaticConcurrency(invalid, update)).rejects.toThrow("between 1 and 16");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("keeps global settings read-only for non-administrators", () => {
    const html = renderToStaticMarkup(
      <SchedulerForm status={status} canEdit={false} onSave={async () => {}} />,
    );
    expect(html).toContain("Only workspace administrators");
    expect(html).toContain("E2E: 1 / 1 occupied");
    expect(html).not.toContain("Save concurrency");
  });

  it("shows cleanup blocking independently of static capacity", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    client.setQueryData(schedulerQueryKey, status);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SchedulerPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Static: 2 / 4 occupied");
    expect(html).toContain("Needs cleanup");
    expect(html).toContain("The next E2E task is blocked");
    expect(html).toContain("taskId=task-e2e");
  });
});
