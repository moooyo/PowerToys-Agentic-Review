import type { OperatorPrincipal, OperatorRepositoryPermission } from "@agentic-review/contracts";
import type { EffectCallback, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import { context, listResponse, occurrence, principal, result } from "./fixtures.testing";
import { FindingReview } from "./index";
import { findingQueryKey } from "./state";

interface QueryOptions {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled?: boolean;
  retry?: boolean;
  refetchIntervalInBackground?: boolean;
  refetchInterval?: (query: { state: { status: string } }) => number | false;
}
const state = vi.hoisted(() => ({
  principal: null as OperatorPrincipal | null,
  ready: true,
  checking: false,
  permissions: [] as OperatorRepositoryPermission[],
  mode: "connected" as "connected" | "sample",
  queries: [] as QueryOptions[],
  cache: new Map<
    string,
    { data?: unknown; error?: unknown; fetching?: boolean; updatedAt?: number }
  >(),
  buttons: new Map<string, boolean>(),
  scopes: [] as string[],
  list: vi.fn(),
  history: vi.fn(),
  change: vi.fn(),
  effects: [] as EffectCallback[],
  invalidateQueries: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: EffectCallback) => {
      state.effects.push(effect);
    },
  };
});
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: (scope: string) => {
    state.scopes.push(scope);
    return {
      principal: state.principal,
      ready: state.ready,
      checking: state.checking,
      can: (permission: OperatorRepositoryPermission) => state.permissions.includes(permission),
      refresh: vi.fn(),
    };
  },
}));
vi.mock("@/services/findings", () => ({
  findings: {
    get mode() {
      return state.mode;
    },
    list: state.list,
    history: state.history,
    change: state.change,
  },
}));
vi.mock("./Comparison", () => ({
  FindingComparison: () => <div>Explicit baseline comparison</div>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidateQueries }),
  useQuery: (options: QueryOptions) => {
    state.queries.push(options);
    const value = state.cache.get(JSON.stringify(options.queryKey));
    return {
      data: value?.data,
      error: value?.error,
      isError: Boolean(value?.error),
      isPending: value === undefined,
      isFetching: value?.fetching ?? false,
      dataUpdatedAt: value?.updatedAt ?? 0,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@mui/material", async () => {
  const { materialComponents } = await import("./material.testing");
  return {
    ...materialComponents,
    Button: ({ children, disabled = false }: { children?: ReactNode; disabled?: boolean }) => {
      if (typeof children === "string") state.buttons.set(children, disabled);
      return (
        <button type="button" disabled={disabled}>
          {children}
        </button>
      );
    },
    Skeleton: () => <span>Loading findings</span>,
  };
});
vi.mock("@/components/ui", async () => (await import("./material.testing")).materialUiHelpers);
vi.mock("@mui/icons-material/ExpandMore", () => ({ default: () => null }));
vi.mock("@mui/icons-material/ContentCopy", () => ({ default: () => null }));

const key = () => [...findingQueryKey(state.mode, result, state.principal ?? principal), "list", 1];
const seed = (response = listResponse) =>
  state.cache.set(JSON.stringify(key()), {
    data: response,
    updatedAt: Date.parse("2026-09-07T01:00:00.000Z"),
  });
const render = () => renderToStaticMarkup(<FindingReview result={result} />);
beforeEach(() => {
  state.principal = principal;
  state.permissions = ["read", "review"];
  state.ready = true;
  state.checking = false;
  state.mode = "connected";
  state.queries = [];
  state.effects = [];
  state.scopes = [];
  state.cache.clear();
  state.buttons.clear();
  vi.clearAllMocks();
});

describe("finding read and action boundary", () => {
  it("refreshes run policy and decision eligibility when a successful finding snapshot is observed", () => {
    seed();
    render();
    for (const effect of state.effects) effect();
    expect(state.invalidateQueries).toHaveBeenCalledWith({
      queryKey: [
        "review-runs",
        result.repositoryId,
        result.workItemId,
        result.reviewRunId,
        "detail",
      ],
      exact: true,
    });
    expect(state.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["review-run-decisions", "connected", result.repositoryId, result.reviewRunId],
    });
  });
  it("does not use a failed finding read to refresh derived policy", () => {
    seed();
    state.cache.set(JSON.stringify(key()), { data: listResponse, error: new Error("Read failed") });
    render();
    for (const effect of state.effects) effect();
    expect(state.invalidateQueries).not.toHaveBeenCalled();
  });
  it("loads one paginated full finding list and requests history only after selection", async () => {
    seed();
    const html = render();
    expect(html).toContain(occurrence.title);
    expect(html).toContain(occurrence.body);
    expect(html).toContain("Original array index");
    expect(html).toContain("37");
    expect(state.scopes).toEqual([result.repositoryId]);
    expect(state.queries).toHaveLength(2);
    expect(state.queries[0]?.enabled).toBe(true);
    expect(state.queries[1]?.enabled).toBe(false);
    state.list.mockResolvedValue(listResponse);
    await state.queries[0]?.queryFn();
    expect(state.list).toHaveBeenCalledExactlyOnceWith(
      {
        repositoryId: result.repositoryId,
        reviewRunId: result.reviewRunId,
        requestId: result.requestId,
        jobId: result.jobId,
      },
      { page: 1, pageSize: 20 },
    );
    expect(state.change).not.toHaveBeenCalled();
    expect(state.history).not.toHaveBeenCalled();
  });
  it("shows the independent blocking counts and explains internal-only writes", () => {
    seed();
    const html = render();
    expect(html).toContain("Reported P0 / P1 findings");
    expect(html).toContain("Unresolved P0 / P1 findings");
    expect(html).toContain("Confirming an issue keeps it unresolved");
    expect(html).toContain("No GitHub comment, review, or issue update is published");
    for (const label of [
      "Confirm issue",
      "Dismiss finding",
      "Record as resolved",
      "Reopen finding",
    ])
      expect(state.buttons.get(label)).toBe(false);
  });
  it("lets a viewer read original findings while disabling dispositions", () => {
    state.permissions = ["read"];
    seed();
    const html = render();
    expect(html).toContain(occurrence.body);
    for (const label of [
      "Confirm issue",
      "Dismiss finding",
      "Record as resolved",
      "Reopen finding",
    ])
      expect(state.buttons.get(label)).toBe(true);
    expect(state.buttons.get("History")).toBe(false);
  });
  it("hides cached records while access is rechecked", () => {
    seed();
    state.checking = true;
    const html = render();
    expect(html).toContain("Loading findings");
    expect(html).not.toContain(occurrence.title);
    expect(html).not.toContain(occurrence.body);
  });
  it("hides cached records when repository read permission disappears", () => {
    seed();
    state.permissions = [];
    const html = render();
    expect(html).toContain("Finding records unavailable");
    expect(html).not.toContain(occurrence.body);
    expect(state.queries[0]?.enabled).toBe(false);
  });
  it.each([401, 403, 404])("hides earlier successful data after HTTP %s", (status) => {
    seed();
    state.cache.set(JSON.stringify(key()), {
      data: listResponse,
      error: new ReviewControlHttpError("Denied", {
        status,
        operation: "findings",
        retryable: false,
      }),
    });
    const html = render();
    expect(html).toContain("Finding records unavailable");
    expect(html).not.toContain(occurrence.body);
    expect(html).not.toContain(occurrence.title);
  });
  it("does not reuse another operator's cached findings", () => {
    seed();
    state.principal = { ...principal, subject: "Other" };
    const html = render();
    expect(html).not.toContain(occurrence.body);
    expect(state.queries[0]?.queryKey).toContain("Other");
  });
  it("does not render findings for a mismatched immutable result", async () => {
    const bad = { ...listResponse, context: { ...context, resultDigest: "0".repeat(64) } };
    seed(bad);
    expect(render()).not.toContain(occurrence.body);
    expect(render()).toContain("does not match");
    state.list.mockResolvedValue(bad);
    await expect(state.queries[0]?.queryFn()).rejects.toThrow("does not match");
  });
  it("keeps historical result mutations explicit and available to reviewers", () => {
    seed({
      ...listResponse,
      context: { ...context, historical: true, latestForRequest: false, sourceCurrent: false },
    });
    const html = render();
    expect(html).toContain("Historical result findings");
    expect(html).toContain("They do not carry over");
    expect(state.buttons.get("Dismiss finding")).toBe(false);
  });
  it.each(["failed", "not_requested", "not_applicable"] as const)(
    "does not present unavailable %s output as a clean result",
    (modelAvailability) => {
      seed({
        ...listResponse,
        context: { ...context, modelAvailability, findingCount: 0 },
        items: [],
        total: 0,
        summary: {
          open: 0,
          accepted: 0,
          dismissed: 0,
          resolved: 0,
          rawBlocking: 0,
          unresolvedBlocking: 0,
        },
      });
      const html = render();
      expect(html).toContain("Missing output does not establish");
      expect(html).not.toContain("No findings were reported in this complete");
    },
  );
  it("does not invent disposition data or eligibility changes in sample mode", () => {
    state.mode = "sample";
    const html = render();
    expect(html).toContain("Sample finding preview");
    expect(html).toContain("does not simulate those records");
    expect(state.queries).toHaveLength(0);
    expect(state.list).not.toHaveBeenCalled();
  });
  it("does not invent a successful read timestamp", () => {
    seed();
    state.cache.set(JSON.stringify(key()), { data: listResponse, updatedAt: 0 });
    expect(render()).not.toContain("Last checked:");
  });
  it("stops automatic refresh on an error and disables background refresh", () => {
    seed();
    render();
    const query = state.queries[0];
    expect(query?.retry).toBe(false);
    expect(query?.refetchIntervalInBackground).toBe(false);
    expect(query?.refetchInterval?.({ state: { status: "error" } })).toBe(false);
  });
});
