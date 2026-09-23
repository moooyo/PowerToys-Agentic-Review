import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createSampleInvestigationApi } from "./sample-adapter";
import { sessionIdentity } from "./session";
import {
  activeSourceReportTask,
  readableSourceData,
  readableSourceReport,
  sourceActionContextMatches,
  sourceActionKey,
  sourceReportKey,
} from "./source-result";
import { InvestigationHttpError } from "./transport";
import { WorkItemDetails } from "./work-item-details";

const session = vi.hoisted(() => ({
  authenticated: true as const,
  authMode: "password" as const,
  loginPath: "/api/auth/login" as const,
  expiresAt: "2099-01-01T00:00:00Z",
  user: {
    id: "sample-operator",
    username: "reviewer",
    displayName: "Reviewer",
    email: null,
    isAdmin: false,
    permissions: [],
    repositoryIds: ["repo-powertoys-fork"],
    actionCapabilities: [],
    allowRepositoryExecution: false,
  },
}));
vi.mock("./session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session")>()),
  useInvestigationSession: () => ({ session }),
}));

async function fixture() {
  const api = createSampleInvestigationApi();
  const detail = await api.task("sample-pr-p1-task");
  const source = await api.workItem(detail.task.workItem.id);
  const header = detail.latestReport;
  if (!header) throw new Error("A saved report fixture is required.");
  const context = await api.actionContext(source.id, header.report.id);
  const identity = sessionIdentity(session);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  client.setQueryData(["investigation-repositories"], { items: [detail.task.repository] });
  client.setQueryData(
    ["investigation-work-item", identity, source.id, source.repositoryId],
    source,
  );
  client.setQueryData(["investigation-tasks", identity, source.id], { items: [detail.task] });
  client.setQueryData(sourceReportKey(identity, source.id, detail.task), header);
  client.setQueryData(sourceActionKey(identity, source, header), context);
  return { api, detail, source, header, context, identity, client };
}

function renderSource(client: QueryClient, source: { id: string; repositoryId: string }) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[
          `/pull-requests?workItemId=${source.id}&repositoryId=${source.repositoryId}`,
        ]}
      >
        <WorkItemDetails id={source.id} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("source result and current action binding", () => {
  it("changes the action cache key with the source revision and rejects stale target bindings", async () => {
    const { source, header, context, identity } = await fixture();
    expect(sourceActionContextMatches(source, header, context, session.user.id)).toBe(true);
    const changed = { ...source, subject: { ...source.subject, revisionKey: "f".repeat(64) } };
    expect(sourceActionKey(identity, changed, header)).not.toEqual(
      sourceActionKey(identity, source, header),
    );
    expect(sourceActionContextMatches(changed, header, context, session.user.id)).toBe(false);
    expect(sourceActionContextMatches(source, header, context, "another-actor")).toBe(false);
    expect(
      sourceActionContextMatches(
        source,
        header,
        { ...context, target: { ...context.target, state: "closed" } },
        session.user.id,
      ),
    ).toBe(false);
    expect(
      sourceActionContextMatches(
        source,
        header,
        {
          ...context,
          target: {
            ...context.target,
            headSha: context.target.headSha === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40),
          },
        },
        session.user.id,
      ),
    ).toBe(false);
  });

  it("does not reuse an old recommendation after source refresh while retaining the sealed report", async () => {
    const { source, header, context, identity, client } = await fixture();
    client.setQueryData(sourceActionKey(identity, source, header), {
      ...context,
      recommendation: { ...context.recommendation, reason: "OLD_CONTEXT_RECOMMENDATION" },
    });
    const changed = { ...source, subject: { ...source.subject, revisionKey: "f".repeat(64) } };
    client.setQueryData(
      ["investigation-work-item", identity, source.id, source.repositoryId],
      changed,
    );
    const html = renderSource(client, changed);
    expect(html).toContain("earlier saved source");
    expect(html).toContain("Read saved report");
    expect(html).toContain("Loading current next actions");
    expect(html).not.toContain("OLD_CONTEXT_RECOMMENDATION");
  });

  it("validates a cached context again before displaying its recommendation", async () => {
    const { source, header, context, identity, client } = await fixture();
    client.setQueryData(sourceActionKey(identity, source, header), {
      ...context,
      target: { ...context.target, revisionKey: "f".repeat(64) },
      recommendation: { ...context.recommendation, reason: "MISMATCHED_RECOMMENDATION" },
    });
    const html = renderSource(client, source);
    expect(html).toContain("cached action context does not match");
    expect(html).not.toContain("MISMATCHED_RECOMMENDATION");
  });

  it("keeps inspection available for an unresolved submission without preparation permission", async () => {
    const { source, header, context, identity, client } = await fixture();
    client.setQueryData(sourceActionKey(identity, source, header), {
      ...context,
      recommendation: { action: null, reason: "Inspect the existing unresolved request." },
      recommendedActionId: null,
      fixedActions: context.fixedActions.map((action) => ({ ...action, allowed: false })),
      nextActions: context.nextActions.map((action) => ({ ...action, canPrepare: false })),
      pendingSubmission: {
        intentId: "retained-intent",
        state: "unknown",
        message: "Unresolved receipt",
      },
    });
    const html = renderSource(client, source);
    const inspectButton = html.match(/<button\b[^>]*>Inspect pending submission/u)?.[0];
    expect(inspectButton).toBeDefined();
    expect(inspectButton).not.toContain("disabled");
  });

  it("hides denied retained data but permits readable snapshots after a network failure", async () => {
    const { source, detail, header } = await fixture();
    const snapshot = { inputSnapshot: { body: "retained snapshot" } };
    for (const status of [401, 403, 404]) {
      expect(
        readableSourceData(snapshot, new InvestigationHttpError(status, "Unavailable")),
      ).toBeUndefined();
      expect(
        readableSourceReport(
          source,
          detail.task,
          header,
          new InvestigationHttpError(status, "Unavailable"),
        ),
      ).toBeUndefined();
    }
    expect(
      readableSourceData(snapshot, new InvestigationHttpError(503, "Network unavailable")),
    ).toBe(snapshot);
    expect(
      readableSourceReport(
        source,
        detail.task,
        header,
        new InvestigationHttpError(503, "Network unavailable"),
      ),
    ).toBe(header);
  });

  it("does not derive visible task or report links from a forbidden tasks cache", async () => {
    const { source, header, identity, client, detail } = await fixture();
    const query = client
      .getQueryCache()
      .find({ queryKey: ["investigation-tasks", identity, source.id], exact: true });
    if (!query) throw new Error("A cached task query is required.");
    query.setState({
      status: "error",
      error: new InvestigationHttpError(403, "Task access denied"),
      errorUpdatedAt: Date.now(),
      fetchStatus: "idle",
    });
    const html = renderSource(client, source);
    expect(html).toContain("Cached tasks and their saved conclusions are hidden");
    expect(html).not.toContain(`reportId=${header.report.id}`);
    expect(html).not.toContain(`taskId=${detail.task.id}`);
  });

  it("only prioritizes active children bound to the displayed parent report", async () => {
    const { source, detail, header } = await fixture();
    const child = {
      ...detail.task,
      id: "current-child",
      kind: "pr-verify" as const,
      state: "queued" as const,
      parentTaskId: detail.task.id,
      parentReportRef: {
        id: header.report.id,
        version: header.report.version,
        digest: header.report.logicalContentDigest,
      },
    };
    const previousReportChild = {
      ...child,
      id: "previous-child",
      createdAt: "2099-01-01T00:00:00Z",
      parentReportRef: { ...child.parentReportRef, id: "previous-report" },
    };
    expect(activeSourceReportTask(source, header, [previousReportChild])).toBeUndefined();
    expect(activeSourceReportTask(source, header, [previousReportChild, child])).toBe(child);
    expect(
      activeSourceReportTask(source, header, [{ ...child, parentTaskId: "another-parent" }]),
    ).toBeUndefined();
    expect(
      activeSourceReportTask(source, header, [{ ...child, state: "completed" }]),
    ).toBeUndefined();
  });
});
