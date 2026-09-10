import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationAdapter } from "@/services/evaluations";
import {
  evaluationTestActor,
  sourceSummaryFixture,
  suiteCaseListFixture,
  suiteDraftFixture,
  suiteSummaryFixture,
  suiteVersionFixture,
} from "@/services/evaluations/fixtures.testing";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import routes from "../../../config/routes";
import { CaseEditor } from "./CaseEditor";
import { EvaluationContext } from "./context";
import EvaluationsPage from "./index";
import { PublishedVersion } from "./PublishedVersion";
import { FrozenSourceLabel } from "./Sources";

const state = vi.hoisted(() => ({
  mode: "connected",
  read: true,
  configure: true,
  checking: false,
  pending: false,
  authenticated: true,
  repositoryError: null as unknown,
  queryKeys: [] as (readonly unknown[])[],
  groups: [] as { kind: string; suites: { name: string }[]; sources: { title: string }[] }[],
  api: {
    captureSource: vi.fn(),
    createSuite: vi.fn(),
    saveSuiteDraft: vi.fn(),
    publishSuite: vi.fn(),
  },
}));
vi.mock("@/state/session", () => ({
  useOperatorSession: () => ({ initialState: { authenticationEpoch: 1 } }),
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: () => ({
    ready: true,
    checking: state.checking,
    pending: state.pending,
    authenticated: state.authenticated,
    error: null,
    principal: evaluationTestActor,
    identityKey: [state.mode, evaluationTestActor.issuer, evaluationTestActor.subject],
    context: {
      platformAdministrator: false,
      repository: {
        repositoryId: "repository-a",
        role: state.configure ? "maintainer" : "viewer",
        source: "repository",
        permissions: state.configure ? ["read", "configure"] : ["read"],
      },
    },
    allows: (permission: string) => (permission === "configure" ? state.configure : state.read),
    can: (permission: string) =>
      !state.checking &&
      !state.pending &&
      (permission === "configure" ? state.configure : state.read),
    refresh: vi.fn(async () => undefined),
  }),
}));
vi.mock("@/components/RepositoryScope", () => ({
  useRepositoryScope: () => ({
    key: "repository-a",
    repositoryId: "repository-a",
    label: "Example repository",
    ready: true,
    error: null,
    refresh: vi.fn(async () => undefined),
  }),
  RepositoryScopeUnavailable: () => <span>Repository unavailable</span>,
}));
vi.mock("@/components/ConfigurationScopeGuard", () => ({
  ConfigurationScopeGuard: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/services/evaluations", () => ({ createHttpEvaluationAdapter: () => state.api }));
vi.mock("./SuiteWorkspace", () => ({
  SuiteWorkspace: (props: {
    kind: string;
    suites: { name: string }[];
    sources: { title: string }[];
  }) => {
    state.groups.push(props);
    return (
      <section data-kind={props.kind}>
        {props.suites.map((suite) => (
          <span key={suite.name}>{suite.name}</span>
        ))}
        {props.sources.map((source) => (
          <span key={source.title}>{source.title}</span>
        ))}
      </section>
    );
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    cancelQueries: vi.fn(async () => undefined),
    removeQueries: vi.fn(),
    invalidateQueries: vi.fn(async () => undefined),
    getQueryState: () => ({ error: state.repositoryError }),
  }),
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    state.queryKeys = [...state.queryKeys, queryKey];
    const data = queryKey.includes("suites")
      ? [
          { ...suiteSummaryFixture(), name: "PR examples", workflowKind: "pr_static_build" },
          {
            ...suiteSummaryFixture(),
            id: "suite-issue",
            name: "Issue examples",
            workflowKind: "issue_validation",
          },
        ]
      : queryKey.includes("sources")
        ? [
            { ...sourceSummaryFixture(), title: "PR frozen source" },
            {
              ...sourceSummaryFixture(),
              id: "source-issue",
              title: "Issue frozen source",
              workItemKind: "issue",
            },
          ]
        : queryKey.includes("cases")
          ? suiteCaseListFixture()
          : queryKey.includes("versions")
            ? [suiteVersionFixture()]
            : queryKey.includes("version")
              ? suiteVersionFixture()
              : undefined;
    return {
      data,
      error: null,
      isError: false,
      isPending: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));

beforeEach(() => {
  state.mode = "connected";
  state.read = true;
  state.configure = true;
  state.checking = false;
  state.pending = false;
  state.authenticated = true;
  state.repositoryError = null;
  state.queryKeys = [];
  state.groups = [];
  vi.clearAllMocks();
});

describe("evaluation management page scope and information architecture", () => {
  it("registers a repository-readable management entry", () => {
    expect(routes.find((route) => route.path === "/evaluations")).toMatchObject({
      access: "canRead",
      component: "./Evaluations",
    });
  });
  it("shows separate PR and Issue groups containing only their real item kind", () => {
    const html = renderToStaticMarkup(<EvaluationsPage />);
    expect(html).toContain("Evaluations");
    expect(html).toContain("Pull requests");
    expect(html).toContain("Issues");
    expect(state.groups.find((group) => group.kind === "pull_request")).toMatchObject({
      suites: [{ name: "PR examples" }],
      sources: [{ title: "PR frozen source" }],
    });
    expect(state.groups.find((group) => group.kind === "issue")).toMatchObject({
      suites: [{ name: "Issue examples" }],
      sources: [{ title: "Issue frozen source" }],
    });
    expect(html).not.toContain("Start evaluation");
    expect(Object.values(state.api).every((method) => method.mock.calls.length === 0)).toBe(true);
  });
  it("does not query or simulate management writes in sample mode", () => {
    state.mode = "sample";
    const html = renderToStaticMarkup(<EvaluationsPage />);
    expect(html).toContain("A connected server is required");
    expect(html).toContain("Sources, drafts, publications, and batches are not simulated");
    expect(state.queryKeys).toEqual([]);
    expect(state.groups).toEqual([]);
    expect(Object.values(state.api).every((method) => method.mock.calls.length === 0)).toBe(true);
  });
  it.each([401, 403, 404])(
    "clears the protected workspace after a repository HTTP %s",
    (status) => {
      state.repositoryError = new ReviewControlHttpError("Access changed.", {
        operation: "repository",
        retryable: false,
        status,
      });
      const html = renderToStaticMarkup(<EvaluationsPage />);
      expect(html).toContain("Evaluation access is unavailable");
      expect(state.groups).toEqual([]);
      expect(html).not.toContain("PR frozen source");
    },
  );
  it("shows read-only access without advertising configuration actions", () => {
    state.configure = false;
    expect(renderToStaticMarkup(<EvaluationsPage />)).toContain("Read-only access");
  });
  it("does not expose a workspace before initial permission checking finishes", () => {
    state.checking = true;
    state.pending = true;
    const html = renderToStaticMarkup(<EvaluationsPage />);
    expect(state.groups).toEqual([]);
    expect(html).not.toContain("PR frozen source");
  });
});

describe("frozen source and expectation rendering", () => {
  it("shows the frozen item and revision for each published case without loading its full body", () => {
    const source = sourceSummaryFixture();
    const html = renderToStaticMarkup(
      <EvaluationContext.Provider
        value={{
          api: state.api as unknown as EvaluationAdapter,
          session: "session-a",
          repositoryId: "repository-a",
          principal: evaluationTestActor,
          readable: true,
          canConfigure: false,
          allowsConfigure: false,
          invalidateAccess: vi.fn(),
        }}
      >
        <PublishedVersion
          suiteId="suite-a"
          preferredVersionId="version-a"
          active
          sources={[source]}
        />
      </EvaluationContext.Provider>,
    );
    expect(html).toContain("Published versions are immutable");
    expect(html).toContain(suiteCaseListFixture().items[0]?.title);
    expect(html).toContain(`PR #${source.number}`);
    expect(html).toContain(`Frozen revision ${source.revisionKey.slice(0, 12)}`);
    expect(html).not.toContain("Captured source");
  });
  it("uses the real PR or Issue number and frozen revision in the source signature", () => {
    const source = sourceSummaryFixture();
    const pr = renderToStaticMarkup(<FrozenSourceLabel source={source} />);
    expect(pr).toContain(`PR #${source.number}`);
    expect(pr).toContain(`Frozen revision ${source.revisionKey.slice(0, 12)}`);
    expect(
      renderToStaticMarkup(<FrozenSourceLabel source={{ ...source, workItemKind: "issue" }} />),
    ).toContain(`Issue #${source.number}`);
  });
  it.each(["unlabeled", "partial", "complete"] as const)(
    "renders %s annotation semantics with stable IDs",
    (annotation) => {
      const draft = suiteDraftFixture(),
        entry = draft.cases[0];
      if (!entry) throw new Error("The fixture requires a case.");
      entry.findings = { annotation, expected: [] };
      const html = renderToStaticMarkup(
        <EvaluationContext.Provider
          value={{
            api: state.api as unknown as EvaluationAdapter,
            session: "session-a",
            repositoryId: "repository-a",
            principal: evaluationTestActor,
            readable: true,
            canConfigure: false,
            allowsConfigure: false,
            invalidateAccess: vi.fn(),
          }}
        >
          <CaseEditor
            value={draft}
            sources={[sourceSummaryFixture()]}
            disabled
            onChange={vi.fn()}
          />
        </EvaluationContext.Provider>,
      );
      expect(html).toContain(entry.caseId);
      expect(html).toContain("criterion-1");
      expect(html).toContain("disabled");
      expect(html).toContain(
        annotation === "complete"
          ? "explicit negative example"
          : annotation === "partial"
            ? "known positives"
            : "No finding-quality expectation",
      );
    },
  );
});
