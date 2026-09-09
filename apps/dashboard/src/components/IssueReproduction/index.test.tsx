import type { DashboardReviewRunDetail, DashboardReviewRunResult } from "@agentic-review/contracts";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import { assessment, detail, principal, result } from "./fixtures.testing";
import { IssueReproductionResult, IssueReproductionSummary } from "./index";

interface QueryOptions {
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
  enabled: boolean;
  retry: boolean;
  refetchIntervalInBackground: boolean;
  refetchInterval: (query: { state: { status: string } }) => number | false;
}
const state = vi.hoisted(() => ({
  canRead: true,
  pending: false,
  checking: false,
  epoch: 1,
  role: "viewer",
  principal: { issuer: "", subject: "" },
  selectedKey: null as string | null,
  openEvidence: false,
  queries: [] as QueryOptions[],
  cache: undefined as unknown,
  error: null as Error | null,
  getCase: vi.fn(),
  getResult: vi.fn(),
  evidence: [] as unknown[],
  scopes: [] as string[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [
      initial === null
        ? state.selectedKey
        : Array.isArray(initial) && state.openEvidence
          ? ["evidence"]
          : initial,
      vi.fn(),
    ],
  };
});
vi.mock("@umijs/max", () => ({
  useModel: () => ({ initialState: { authenticationEpoch: state.epoch } }),
}));
vi.mock("@/components/OperatorAccess", () => ({
  useOperatorAccess: (repositoryId: string) => {
    state.scopes.push(repositoryId);
    return {
      principal: state.principal,
      pending: state.pending,
      ready: !state.pending && state.canRead,
      checking: state.checking,
      identityKey: ["connected", state.principal.issuer, state.principal.subject],
      context: {
        platformAdministrator: false,
        repository: { repositoryId, role: state.role, permissions: state.canRead ? ["read"] : [] },
      },
      allows: () => state.canRead,
      can: () => state.canRead && !state.checking,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("@/services/runs", () => ({
  runs: { mode: "connected", getReproductionCase: state.getCase, getResult: state.getResult },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    state.queries.push(options);
    return {
      data: state.cache,
      isError: state.error !== null,
      error: state.error,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("../ReviewRuns/EvidenceView", () => ({
  EvidenceView: ({ scope }: { scope: unknown }) => {
    state.evidence.push(scope);
    return <div>Exact attempt evidence</div>;
  },
}));
vi.mock("./presentation", () => ({
  AssessmentSummary: () => <div>Scoped reproduction assessment</div>,
  CaseState: () => <span>Case state</span>,
  ReproductionCaseFacts: ({ detail: value }: { detail: typeof detail }) => (
    <div>{value.case.context}</div>
  ),
}));
vi.mock("antd", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: ({
      title,
      description,
      action,
    }: {
      title?: ReactNode;
      description?: ReactNode;
      action?: ReactNode;
    }) => (
      <aside>
        {title}
        {description}
        {action}
      </aside>
    ),
    Button: ({ children, disabled }: { children?: ReactNode; disabled?: boolean }) => (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    ),
    Collapse: ({ items }: { items: { key: string; label: ReactNode; children?: ReactNode }[] }) => (
      <div>
        {items.map((entry) => (
          <section key={entry.key}>
            {entry.label}
            {entry.children}
          </section>
        ))}
      </div>
    ),
    Descriptions: ({
      items,
    }: {
      items: { key: string; label: ReactNode; children: ReactNode }[];
    }) => (
      <dl>
        {items.map((entry) => (
          <div key={entry.key}>
            <dt>{entry.label}</dt>
            <dd>{entry.children}</dd>
          </div>
        ))}
      </dl>
    ),
    Divider: Content,
    Skeleton: () => <span>Loading reproduction</span>,
    Space: Content,
    Table: ({
      dataSource,
      columns,
    }: {
      dataSource: { caseId: string }[];
      columns: { title: string; render: (value: unknown, row: unknown) => ReactNode }[];
    }) => (
      <div>
        {dataSource.map((entry) => (
          <article key={entry.caseId}>
            {columns.map((column) => (
              <div key={column.title}>{column.render(null, entry)}</div>
            ))}
          </article>
        ))}
      </div>
    ),
    Typography: { Text: Content, Paragraph: Content, Title: Content },
  };
});

const sampleRun = sampleReviewRuns.find((entry) => entry.workItemKind === "issue");
if (!sampleRun) throw new Error("An issue sample run is required.");
const run: DashboardReviewRunDetail = {
  ...sampleRun,
  reproduction: {
    bindingDigest: assessment.bindingDigest,
    claim: detail.binding.claim,
    caseCount: 1,
    cases: [
      {
        caseId: detail.caseId,
        requestId: detail.requestId,
        profileVersionId: detail.case.profileVersionId,
        target: detail.case.target,
        context: detail.case.context,
      },
    ],
    assessment,
  },
};
const renderResult = (value = result) =>
  renderToStaticMarkup(<IssueReproductionResult result={value} />);
const selectedQuery = () => {
  const query = state.queries.at(-1);
  if (!query) throw new Error("Expected a selected case query.");
  return query;
};
function sessionKey(value = result) {
  const gate = IssueReproductionResult({ result: value });
  if (!gate) throw new Error("Expected reproduction access boundary.");
  const renderGate = gate.type as (props: unknown) => ReactElement;
  return renderGate(gate.props).key;
}

beforeEach(() => {
  state.canRead = true;
  state.pending = false;
  state.checking = false;
  state.epoch = 1;
  state.role = "viewer";
  state.principal = principal;
  state.selectedKey = null;
  state.openEvidence = false;
  state.queries = [];
  state.cache = undefined;
  state.error = null;
  state.evidence = [];
  state.scopes = [];
  vi.clearAllMocks();
  state.getCase.mockResolvedValue(detail);
  state.getResult.mockResolvedValue(result);
});

describe("reproduction read boundary and selection reset", () => {
  it("allows viewers to read and waits for explicit case selection", () => {
    expect(renderResult()).toContain("Scoped reproduction assessment");
    expect(state.scopes).toEqual([result.repositoryId]);
    expect(state.queries).toHaveLength(0);
    expect(renderToStaticMarkup(<IssueReproductionSummary run={run} />)).toContain(
      detail.binding.claim,
    );
  });

  it.each(["denied", "pending"])(
    "withholds cached reproduction data when access is %s",
    (access) => {
      state.canRead = access !== "denied";
      state.pending = access === "pending";
      state.selectedKey = JSON.stringify([detail.requestId, detail.caseId]);
      state.cache = { detail, savedResult: result };
      const html = renderResult();
      expect(html).not.toContain("Scoped reproduction assessment");
      expect(html).not.toContain(detail.case.context);
      expect(state.queries).toHaveLength(0);
      expect(state.evidence).toHaveLength(0);
    },
  );

  it("resets selection, pages and evidence panels through React session keys on scope and login changes", () => {
    const key = sessionKey();
    expect(sessionKey({ ...result, repositoryId: "other-repository" })).not.toBe(key);
    expect(sessionKey({ ...result, workItemId: "other-item" })).not.toBe(key);
    expect(sessionKey({ ...result, reviewRunId: "other-run" })).not.toBe(key);
    expect(sessionKey({ ...result, jobId: "other-job" })).not.toBe(key);
    expect(sessionKey({ ...result, id: "other-result" })).not.toBe(key);
    state.epoch += 1;
    expect(sessionKey()).not.toBe(key);
    state.epoch = 1;
    state.role = "reviewer";
    expect(sessionKey()).not.toBe(key);
    state.role = "viewer";
    state.principal = { ...principal, subject: "AnotherViewer" };
    expect(sessionKey()).not.toBe(key);
  });

  it("rekeys selected details when the parent observes a current assessment change", () => {
    state.selectedKey = JSON.stringify([detail.requestId, detail.caseId]);
    renderResult();
    const previous = selectedQuery().queryKey;
    const next = structuredClone(result);
    if (!next.reproduction) throw new Error("Expected reproduction fixture.");
    next.reproduction.currentAssessment.cases[0] = {
      ...detail.current,
      state: "blocked",
      reasons: ["evidence_unavailable"],
    };
    renderResult(next);
    expect(selectedQuery().queryKey).not.toEqual(previous);
  });
});

describe("selected case reads and exact evidence", () => {
  beforeEach(() => {
    state.selectedKey = JSON.stringify([detail.requestId, detail.caseId]);
  });

  it("reads the selected saved job and reuses only its matching immutable result", async () => {
    renderResult();
    const query = selectedQuery();
    expect(query.enabled).toBe(true);
    expect(query.retry).toBe(false);
    expect(query.refetchIntervalInBackground).toBe(false);
    await expect(query.queryFn({ signal: new AbortController().signal })).resolves.toEqual({
      detail,
      savedResult: result,
    });
    expect(state.getCase).toHaveBeenCalledWith({
      repositoryId: result.repositoryId,
      reviewRunId: result.reviewRunId,
      requestId: result.requestId,
      caseId: detail.caseId,
      jobId: result.jobId,
    });
    expect(state.getResult).not.toHaveBeenCalled();
  });

  it("resolves the latest run case to an exact saved job before opening evidence", async () => {
    renderToStaticMarkup(<IssueReproductionSummary run={run} />);
    await selectedQuery().queryFn({ signal: new AbortController().signal });
    expect(state.getCase).toHaveBeenCalledWith({
      repositoryId: run.repositoryId,
      reviewRunId: run.id,
      requestId: detail.requestId,
      caseId: detail.caseId,
    });
    expect(state.getResult).toHaveBeenCalledWith(
      detail.repositoryId,
      detail.reviewRunId,
      detail.requestId,
      detail.jobId,
    );
    state.cache = { detail, savedResult: result };
    state.openEvidence = true;
    expect(renderResult()).toContain("Exact attempt evidence");
    expect(state.evidence).toEqual([
      {
        repositoryId: result.repositoryId,
        runId: result.reviewRunId,
        requestId: result.requestId,
        jobId: result.jobId,
        runAttemptId: result.runAttemptId,
        profileVersionId: result.profileVersionId,
        revisionKey: result.revisionKey,
        planDigest: result.planDigest,
      },
    ]);
  });

  it("discards an aborted case response before resolving any execution evidence", async () => {
    renderResult();
    const controller = new AbortController();
    const pending = selectedQuery().queryFn({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(state.getResult).not.toHaveBeenCalled();
  });

  it("rejects cross-scope responses and cached stale data", async () => {
    const wrong = { ...detail, repositoryId: "other-repository" };
    state.getCase.mockResolvedValue(wrong);
    state.cache = { detail: wrong, savedResult: result };
    expect(renderResult()).not.toContain(detail.case.context);
    await expect(selectedQuery().queryFn({ signal: new AbortController().signal })).rejects.toThrow(
      "selected frozen run and case",
    );
    expect(state.getResult).not.toHaveBeenCalled();
  });

  it("withholds previously cached evidence after a failed read or access refresh", () => {
    state.cache = { detail, savedResult: result };
    state.openEvidence = true;
    state.error = new Error("Read failed");
    expect(renderResult()).toContain("Could not load reproduction case");
    expect(state.evidence).toHaveLength(0);
    state.error = null;
    state.checking = true;
    expect(renderResult()).toContain("Repository read access is required");
    expect(selectedQuery().enabled).toBe(false);
    expect(state.evidence).toHaveLength(0);
  });

  it("rejects a result outside the case execution before exposing evidence", async () => {
    const wrong: DashboardReviewRunResult = { ...result, profileVersionId: "other-profile" };
    renderResult(wrong);
    await expect(selectedQuery().queryFn({ signal: new AbortController().signal })).rejects.toThrow(
      "exact execution",
    );
  });
});
