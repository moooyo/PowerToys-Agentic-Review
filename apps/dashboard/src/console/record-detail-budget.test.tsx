import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "../investigation/api";
import { createSampleInvestigationApi } from "../investigation/sample-adapter";
import { mapReviewTask } from "./model";
import RecordDetail from "./record-detail";

const session = vi.hoisted(() => ({
  authenticated: true as const,
  authMode: "password" as const,
  loginPath: "/api/auth/login" as const,
  expiresAt: "2099-01-01T00:00:00Z",
  user: {
    id: "budget-viewer",
    username: "budget-viewer",
    displayName: "Budget viewer",
    email: null,
    isAdmin: false,
    permissions: ["task:create"],
    repositoryIds: ["repo-powertoys-fork"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  },
}));

vi.mock("../investigation/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../investigation/session")>()),
  useInvestigationSession: () => ({ session }),
}));

describe("review console execution recovery", () => {
  it.each([7_199_999, 7_200_000, 7_200_001])(
    "uses the cumulative execution duration boundary at %s ms",
    async (durationMs) => {
      const original = await createSampleInvestigationApi().task("sample-pr-partial-task");
      if (!original.checkpoint) throw new Error("A checkpoint fixture is required.");
      const detail: TaskDetail = {
        ...original,
        task: {
          ...original.task,
          state: "cancelled",
          budget: { ...original.task.budget, maxDurationMs: 1, maxTokens: 1, maxRounds: 1 },
        },
        checkpoint: {
          ...original.checkpoint,
          stopReason: "cancelled",
          consumed: {
            ...original.checkpoint.consumed,
            durationMs,
            rounds: 100,
            tokens: 5_000_000,
          },
        },
        latestReport: null,
      };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordDetail
              record={mapReviewTask(detail.task, detail)}
              onRefresh={vi.fn()}
              onSettings={vi.fn()}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      const primary = html.match(/<button\b[^>]*rc-detail-button-filled[^>]*>/u)?.[0];
      expect(primary).toBeDefined();
      expect(primary?.includes("disabled")).toBe(durationMs >= 7_200_000);
      expect(html.includes("cannot be reset or extended")).toBe(durationMs >= 7_200_000);
    },
  );
});
