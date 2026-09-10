import type {
  DashboardReviewRunDetail,
  OperatorPrincipal,
  OperatorRepositoryPermission,
  ReviewRunDecisionContext,
  ReviewRunDecisionEvent,
} from "@agentic-review/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import { ReviewRunDecisions } from "./index";
import { runDecisionRefreshKey } from "./state";

type QueryOptions = {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
  retry: boolean;
  refetchOnMount: string;
  refetchInterval?: unknown;
  refetchIntervalInBackground?: boolean;
};
type CachedQuery = { data?: unknown; error?: Error; fetching?: boolean; dataUpdatedAt?: number };
const state = vi.hoisted(() => ({
  principal: { issuer: "https://issuer.example", subject: "Reviewer" } as OperatorPrincipal | null,
  permissions: ["read", "review"] as OperatorRepositoryPermission[],
  ready: true,
  checking: false,
  mode: "connected" as "connected" | "sample",
  accessScopes: [] as string[],
  queries: [] as QueryOptions[],
  cache: new Map<string, CachedQuery>(),
  buttons: new Map<string, boolean>(),
  getContext: vi.fn(),
  listHistory: vi.fn(),
  change: vi.fn(),
}));

vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: (repositoryId: string) => {
    state.accessScopes.push(repositoryId);
    return {
      principal: state.principal,
      ready: state.ready,
      checking: state.checking,
      can: (permission: OperatorRepositoryPermission) => state.permissions.includes(permission),
    };
  },
}));
vi.mock("@/services/decisions", () => ({
  decisions: {
    get mode() {
      return state.mode;
    },
    getContext: state.getContext,
    listHistory: state.listHistory,
    change: state.change,
  },
}));
vi.mock("@/components/PublicationPreview", () => ({
  PublicationPreview: () => <span>Selected publication preview</span>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: QueryOptions) => {
    state.queries.push(options);
    const cached = state.cache.get(JSON.stringify(options.queryKey));
    return {
      data: cached?.data,
      error: cached?.error ?? null,
      isSuccess: cached?.data !== undefined && !cached.error,
      isError: Boolean(cached?.error),
      isPending: cached === undefined,
      isFetching: cached?.fetching ?? false,
      dataUpdatedAt: cached?.dataUpdatedAt ?? 0,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@mui/material", async () => {
  const { materialComponents } = await import("../FindingReview/material.testing");
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
    Skeleton: () => <span>Loading decision data</span>,
  };
});
vi.mock(
  "@/components/ui",
  async () => (await import("../FindingReview/material.testing")).materialUiHelpers,
);
vi.mock("@mui/icons-material/ExpandMore", () => ({ default: () => null }));
vi.mock("@mui/icons-material/ContentCopy", () => ({ default: () => null }));

const principal = { issuer: "https://issuer.example", subject: "Reviewer" };
const selected = sampleReviewRuns.find((item) => item.workItemKind === "pull_request");
const issue = sampleReviewRuns.find((item) => item.workItemKind === "issue");
if (!selected?.policy.applicable || !issue || issue.policy.applicable) {
  throw new Error("Pull request and Issue fixtures are required.");
}
const run = selected;
const context: ReviewRunDecisionContext = {
  repositoryId: run.repositoryId,
  reviewRunId: run.id,
  workItemId: run.workItemId,
  workItemKind: "pull_request",
  revisionKey: run.revisionKey,
  currentRevisionKey: run.currentRevisionKey,
  planDigest: run.planDigest,
  resultSetDigest: "c".repeat(64),
  sourceCurrent: true,
  version: 1,
  policy: {
    ...selected.policy,
    eligible: true,
    reasons: [],
    reasonCount: 0,
    reasonsTruncated: false,
    blockingFindingCount: 0,
  },
  canApprove: true,
  recordedDecision: null,
  recordedDecisionState: "none",
  stateReasons: [],
};
const event: ReviewRunDecisionEvent = {
  repositoryId: context.repositoryId,
  reviewRunId: context.reviewRunId,
  workItemId: context.workItemId,
  workItemKind: "pull_request",
  revisionKey: context.revisionKey,
  planDigest: context.planDigest,
  resultSetDigest: context.resultSetDigest,
  id: "private-decision-one",
  changeId: "change-one",
  actor: principal,
  previousVersion: 0,
  version: 1,
  createdAt: "2026-09-07T01:00:00.000Z",
  reason: "Private decision with reviewed build evidence.",
  action: "approve",
  targetDecisionId: null,
  supersedesDecisionId: null,
  policyAtDecision: {
    applicable: true,
    eligible: true,
    policyVersion: "required-checks-and-p0-p1-v1",
    blockingFindingCount: 0,
    reasonCount: 0,
    reasonCodes: [],
    reasonCodesTruncated: false,
  },
};
const recorded = {
  ...context,
  recordedDecision: event,
  recordedDecisionState: "current",
} satisfies ReviewRunDecisionContext;
const checkedAt = Date.parse("2026-09-07T02:30:00.000Z");

function prefix(
  target: DashboardReviewRunDetail = run,
  actor = principal,
  mode: "connected" | "sample" = "connected",
) {
  return [
    "review-run-decisions",
    mode,
    target.repositoryId,
    target.id,
    actor.issuer,
    actor.subject,
  ];
}
function seed(
  value: ReviewRunDecisionContext = recorded,
  target: DashboardReviewRunDetail = run,
  actor = principal,
  mode: "connected" | "sample" = "connected",
) {
  state.cache.set(
    JSON.stringify([...prefix(target, actor, mode), "state", runDecisionRefreshKey(target)]),
    { data: value, dataUpdatedAt: checkedAt },
  );
  state.cache.set(JSON.stringify([...prefix(target, actor, mode), "history", 1, value.version]), {
    data: {
      repositoryId: target.repositoryId,
      reviewRunId: target.id,
      page: 1,
      pageSize: 20,
      total: target.id === run.id ? 1 : 0,
      items: target.id === run.id ? [event] : [],
    },
  });
}
function render(target: DashboardReviewRunDetail = run) {
  state.queries = [];
  state.buttons.clear();
  return renderToStaticMarkup(<ReviewRunDecisions run={target} />);
}
function setQueryError(kind: "state" | "history", error: Error) {
  const entry = [...state.cache.entries()].find(([key]) => JSON.parse(key).includes(kind));
  if (!entry) throw new Error("A seeded query is required.");
  state.cache.set(entry[0], { ...entry[1], error });
}

beforeEach(() => {
  state.principal = principal;
  state.permissions = ["read", "review"];
  state.ready = true;
  state.checking = false;
  state.mode = "connected";
  state.accessScopes = [];
  state.queries = [];
  state.cache.clear();
  state.buttons.clear();
  vi.clearAllMocks();
});

describe("decision panel read isolation", () => {
  it("uses the selected run's repository and exact actor for both query families", async () => {
    seed();
    expect(render()).toContain(event.reason);
    expect(state.accessScopes).toEqual([run.repositoryId]);
    expect(state.queries.map((query) => query.queryKey.slice(0, 6))).toEqual([prefix(), prefix()]);
    expect(state.queries.map((query) => query.enabled)).toEqual([true, false]);
    expect(state.queries[0]?.refetchIntervalInBackground).toBe(false);
    expect(typeof state.queries[0]?.refetchInterval).toBe("function");
    expect(state.queries[1]?.queryKey).toEqual([...prefix(), "history", 1, recorded.version]);
    expect(
      state.queries.every((query) => query.retry === false && query.refetchOnMount === "always"),
    ).toBe(true);
    await state.queries[0]?.queryFn();
    await state.queries[1]?.queryFn();
    expect(state.getContext).toHaveBeenCalledWith(run.repositoryId, run.id);
    expect(state.listHistory).toHaveBeenCalledWith(run.repositoryId, run.id, {
      page: 1,
      pageSize: 20,
    });
    expect(state.change).not.toHaveBeenCalled();
  });

  it.each([
    { name: "issuer", actor: { ...principal, issuer: "https://other-issuer.example" } },
    { name: "subject", actor: { ...principal, subject: "another-reviewer" } },
    { name: "subject casing", actor: { ...principal, subject: "reviewer" } },
  ])("does not reuse cached records after changing $name", ({ actor }) => {
    seed();
    expect(render()).toContain(event.reason);
    state.principal = actor;
    const html = render();
    expect(html).not.toContain(event.reason);
    expect(html).not.toContain(event.id);
    expect(
      state.queries.every(
        (query) => query.queryKey[4] === actor.issuer && query.queryKey[5] === actor.subject,
      ),
    ).toBe(true);
  });

  it.each(["repositoryId", "id"] as const)("does not reuse a previous %s selection", (field) => {
    seed();
    const changed = { ...run, [field]: `another-${field}` };
    expect(render(changed)).not.toContain(event.reason);
    expect(
      state.queries.every(
        (query) => query.queryKey[2] === changed.repositoryId && query.queryKey[3] === changed.id,
      ),
    ).toBe(true);
  });

  it("does not reuse connected decision records in sample mode", () => {
    seed();
    state.mode = "sample";
    const html = render();
    expect(html).toContain("Sample decision records");
    expect(html).not.toContain(event.reason);
    expect(state.queries.every((query) => query.queryKey[1] === "sample")).toBe(true);
  });

  it("does not start decision queries before the operator identity is available", () => {
    seed();
    state.principal = null;
    expect(render()).not.toContain(event.reason);
    expect(state.queries).toEqual([]);
  });

  it.each(["denied", "unresolved", "checking"] as const)(
    "withholds cached records while access is %s",
    (access) => {
      seed();
      if (access === "denied") state.permissions = [];
      if (access === "unresolved") state.ready = false;
      if (access === "checking") state.checking = true;
      const html = render();
      expect(html).not.toContain(event.reason);
      expect(html).not.toContain(event.id);
      expect(state.buttons.has("Approve")).toBe(false);
      if (access !== "checking") expect(state.queries.every((query) => !query.enabled)).toBe(true);
    },
  );

  it.each([401, 403, 404])("hides both cached queries after state HTTP %i", (status) => {
    seed();
    setQueryError(
      "state",
      new ReviewControlHttpError("Access unavailable", {
        operation: "get decision context",
        status,
        retryable: false,
      }),
    );
    const html = render();
    expect(html).toContain("Decision records unavailable");
    expect(html).not.toContain(event.reason);
    expect(html).not.toContain(event.id);
    expect(html).not.toContain("Last checked:");
    expect(state.buttons.has("Approve")).toBe(false);
  });

  it.each([401, 403, 404])("hides current records after history HTTP %i", (status) => {
    seed();
    setQueryError(
      "history",
      new ReviewControlHttpError("Access unavailable", {
        operation: "list decisions",
        status,
        retryable: false,
      }),
    );
    const html = render();
    expect(html).toContain("Decision records unavailable");
    expect(html).not.toContain(event.reason);
    expect(html).not.toContain(event.id);
  });

  it("does not display a cached current decision as valid after a non-access refresh error", () => {
    seed();
    state.cache.delete(JSON.stringify([...prefix(), "history", 1, recorded.version]));
    setQueryError("state", new Error("Temporary decision service outage"));
    const html = render();
    expect(html).toContain("Could not load decision state");
    expect(html).not.toContain(event.reason);
    expect(state.buttons.has("Approve")).toBe(false);
  });

  it("does not render old history after a failed history refresh while keeping the independently loaded current decision", () => {
    seed();
    state.cache.set(JSON.stringify([...prefix(), "history", 1, recorded.version]), {
      data: {
        repositoryId: run.repositoryId,
        reviewRunId: run.id,
        page: 1,
        pageSize: 20,
        total: 1,
        items: [
          {
            ...event,
            id: "old-history-row",
            reason: "An earlier private comment.",
            action: "comment",
          },
        ],
      },
      error: new Error("History service outage"),
    });
    const html = render();
    expect(html).toContain("Could not load decision history");
    expect(html).toContain(event.reason);
    expect(html).not.toContain("An earlier private comment.");
    expect(html).not.toContain("old-history-row");
  });

  it.each([
    "repositoryId",
    "reviewRunId",
    "workItemId",
    "workItemKind",
    "revisionKey",
    "planDigest",
  ] as const)("rejects a history row with a mismatched %s", (field) => {
    seed();
    state.cache.set(JSON.stringify([...prefix(), "history", 1, recorded.version]), {
      data: {
        repositoryId: run.repositoryId,
        reviewRunId: run.id,
        page: 1,
        pageSize: 20,
        total: 1,
        items: [
          {
            ...event,
            id: "misbound-history-row",
            reason: "History from a different run.",
            [field]: field === "workItemKind" ? "issue" : "mismatched-state",
          },
        ],
      },
    });
    const html = render();
    expect(html).toContain("The decision history does not match the selected run");
    expect(html).not.toContain("misbound-history-row");
    expect(html).not.toContain("History from a different run.");
    expect(html).toContain(event.reason);
  });

  it.each(["repositoryId", "reviewRunId", "workItemId", "revisionKey", "planDigest"] as const)(
    "rejects a successful state with a mismatched %s",
    (field) => {
      seed({ ...recorded, [field]: "mismatched-state" });
      state.cache.delete(JSON.stringify([...prefix(), "history", 1, recorded.version]));
      const html = render();
      expect(html).toContain("does not match the selected run");
      expect(html).not.toContain(event.reason);
      expect(state.buttons.has("Approve")).toBe(false);
    },
  );

  it("keeps a refreshed query's cached snapshot readable while disabling new decisions until the refresh finishes", () => {
    seed();
    state.cache.set(JSON.stringify([...prefix(), "state", runDecisionRefreshKey(run)]), {
      data: recorded,
      fetching: true,
    });
    expect(render()).toContain(event.reason);
    for (const action of [
      "Approve",
      "Request changes",
      "Comment",
      "Record approval with exception",
      "Withdraw decision",
    ])
      expect(state.buttons.get(action)).toBe(true);
  });

  it("shows the successful data timestamp and advances it only when a newer snapshot is loaded", () => {
    seed();
    const first = render();
    expect(first).toContain(`Last checked: ${new Date(checkedAt).toLocaleString("en-US")}`);
    expect(first).toContain("Refreshes every 30 seconds while this page is visible");
    const refreshedAt = checkedAt + 60_000;
    state.cache.set(JSON.stringify([...prefix(), "state", runDecisionRefreshKey(run)]), {
      data: recorded,
      dataUpdatedAt: refreshedAt,
    });
    const refreshed = render();
    expect(refreshed).toContain(`Last checked: ${new Date(refreshedAt).toLocaleString("en-US")}`);
    expect(refreshed).not.toContain(`Last checked: ${new Date(checkedAt).toLocaleString("en-US")}`);
  });

  it("does not invent a last-checked timestamp when no successful update time is available", () => {
    seed();
    state.cache.set(JSON.stringify([...prefix(), "state", runDecisionRefreshKey(run)]), {
      data: recorded,
      dataUpdatedAt: 0,
    });
    expect(render()).not.toContain("Last checked:");
  });

  it("does not present an old success timestamp after a failed refresh", () => {
    seed();
    setQueryError("state", new Error("Decision service unavailable"));
    const html = render();
    expect(html).toContain("Could not load decision state");
    expect(html).not.toContain("Last checked:");
  });

  it("labels sample snapshots as refreshed on request rather than promising live polling", () => {
    state.mode = "sample";
    seed(recorded, run, principal, "sample");
    const html = render();
    expect(html).toContain("Last checked:");
    expect(html).toContain("Sample records are refreshed on request");
    expect(html).not.toContain("Refreshes every 30 seconds");
  });

  it("loads history under the newly observed stream version instead of reusing an older history page", () => {
    seed();
    const oldHistory = {
      repositoryId: run.repositoryId,
      reviewRunId: run.id,
      page: 1,
      pageSize: 20,
      total: 1,
      items: [
        {
          ...event,
          id: "old-history-comment",
          reason: "Comment cached under version one.",
          action: "comment",
        },
      ],
    };
    state.cache.set(JSON.stringify([...prefix(), "history", 1, 1]), { data: oldHistory });
    expect(render()).toContain("Comment cached under version one.");

    state.cache.set(JSON.stringify([...prefix(), "state", runDecisionRefreshKey(run)]), {
      data: { ...recorded, version: 2 },
      dataUpdatedAt: checkedAt + 30_000,
    });
    const pending = render();
    expect(state.queries[1]?.queryKey).toEqual([...prefix(), "history", 1, 2]);
    expect(pending).not.toContain("Comment cached under version one.");
    expect(pending).toContain(event.reason);

    state.cache.set(JSON.stringify([...prefix(), "history", 1, 2]), {
      data: {
        ...oldHistory,
        total: 2,
        items: [
          {
            ...event,
            id: "new-history-comment",
            previousVersion: 1,
            version: 2,
            reason: "New comment from the refreshed stream.",
            action: "comment",
          },
          event,
        ],
      },
    });
    const refreshed = render();
    expect(refreshed).toContain("New comment from the refreshed stream.");
    expect(refreshed).not.toContain("Comment cached under version one.");
  });
});

describe("decision action presentation", () => {
  it("lets viewers read history while disabling review and override actions", () => {
    seed();
    state.principal = { ...principal, subject: "Viewer" };
    state.permissions = ["read"];
    seed(recorded, run, state.principal);
    const html = render();
    expect(html).toContain(event.reason);
    for (const action of [
      "Approve",
      "Request changes",
      "Comment",
      "Record approval with exception",
      "Withdraw decision",
    ])
      expect(state.buttons.get(action)).toBe(true);
  });

  it("disables withdrawal when the original author is downgraded to viewer", () => {
    seed();
    state.permissions = ["read"];
    render();
    expect(state.buttons.get("Withdraw decision")).toBe(true);
    expect(state.buttons.get("Approve")).toBe(true);
  });

  it("lets a reviewer withdraw their own recorded decision", () => {
    seed();
    state.permissions = ["read", "review"];
    render();
    expect(state.buttons.get("Withdraw decision")).toBe(false);
  });

  it("does not let another reviewer withdraw the author's decision", () => {
    state.principal = { ...principal, subject: "Another reviewer" };
    seed(recorded, run, state.principal);
    state.permissions = ["read", "review"];
    render();
    expect(state.buttons.get("Withdraw decision")).toBe(true);
  });

  it("lets a maintainer with review access withdraw another author's decision", () => {
    state.principal = { ...principal, subject: "Maintainer" };
    seed(recorded, run, state.principal);
    state.permissions = ["read", "review", "configure"];
    render();
    expect(state.buttons.get("Withdraw decision")).toBe(false);
  });

  it("presents ordinary review actions to reviewers without granting override", () => {
    seed();
    const html = render();
    for (const action of ["Approve", "Request changes", "Comment"])
      expect(state.buttons.get(action)).toBe(false);
    expect(state.buttons.get("Record approval with exception")).toBe(true);
    expect(html).toContain("Publication requires a separate preview and confirmation");
    expect(html).not.toContain("Sample decision records");
  });

  it("keeps failed policy visible while allowing a maintainer's explicit exception", () => {
    seed({ ...recorded, policy: { ...recorded.policy, eligible: false }, canApprove: false });
    state.permissions = ["read", "review", "configure"];
    const html = render();
    expect(html).toContain("Not eligible");
    expect(state.buttons.get("Approve")).toBe(true);
    expect(state.buttons.get("Record approval with exception")).toBe(false);
  });

  it("shows Issue information requests and comments without PR approval controls", () => {
    const issueContext: ReviewRunDecisionContext = {
      ...context,
      repositoryId: issue.repositoryId,
      reviewRunId: issue.id,
      workItemId: issue.workItemId,
      workItemKind: "issue",
      revisionKey: issue.revisionKey,
      currentRevisionKey: issue.currentRevisionKey,
      planDigest: issue.planDigest,
      policy: issue.policy,
      canApprove: false,
      recordedDecision: null,
    };
    seed(issueContext, issue);
    const html = render(issue);
    expect(state.buttons.get("Request more information")).toBe(false);
    expect(state.buttons.get("Comment")).toBe(false);
    expect(state.buttons.has("Approve")).toBe(false);
    expect(state.buttons.has("Record approval with exception")).toBe(false);
    expect(state.buttons.has("Request changes")).toBe(false);
    expect(html).toContain("Not applicable to Issue approval");
  });
});
