import type {
  InvestigationArtifactMetadataV1,
  InvestigationE2eResult,
  InvestigationSession,
  InvestigationTaskArtifactsPage,
} from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceAccessQueryKey } from "./artifact-panel";
import { createSampleInvestigationApi } from "./sample-adapter";
import { sessionIdentity } from "./session";
import {
  assertTaskArtifactPage,
  TaskEvidencePanel,
  taskArtifactRecords,
  taskArtifactsQueryKey,
  taskCheckpointE2e,
} from "./task-evidence";

const context = vi.hoisted(() => ({ session: undefined as InvestigationSession | undefined }));
vi.mock("./session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session")>()),
  useInvestigationSession: () => ({ session: context.session }),
}));

const result: InvestigationE2eResult = {
  headSha: "a".repeat(40),
  buildIdentity: "Task-owned build",
  features: [
    {
      id: "recovery",
      title: "Recorded recovery assertion",
      paths: [],
      scenario: "Restore the previous settings.",
      userVisible: true,
      outcome: "passed",
      assertions: [
        {
          id: "restore",
          expected: "The previous settings are restored.",
          observed: "The saved settings were displayed after reload.",
          outcome: "passed",
          evidenceRefs: ["evidence:restored"],
        },
      ],
      artifactRefs: [],
      limitations: [],
    },
  ],
  cleanup: {
    confirmed: true,
    summary: "Owned windows were closed.",
    recordedAt: "2026-09-20T00:00:00Z",
  },
};

async function fixture() {
  const api = createSampleInvestigationApi();
  const detail = await api.task("sample-pr-partial-task");
  const artifact = detail.checkpoint?.runtime.artifacts[0];
  if (!artifact || !detail.checkpoint)
    throw new Error("The artifact checkpoint fixture is missing.");
  const metadata = await api.artifact(artifact.id);
  context.session = {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00Z",
    user: {
      id: "viewer",
      username: "viewer",
      displayName: "Workspace Viewer",
      email: null,
      isAdmin: false,
      repositoryIds: [detail.task.repository.id],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    },
  };
  return { detail, metadata, checkpoint: detail.checkpoint };
}

const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
  clients.push(value);
  return value;
}

function cacheFiles(
  queryClient: QueryClient,
  taskId: string,
  records: InvestigationArtifactMetadataV1[],
  attemptId?: string,
  nextCursor: string | null = null,
) {
  queryClient.setQueryData(
    taskArtifactsQueryKey(sessionIdentity(context.session), taskId, attemptId),
    {
      pages: [{ taskId, items: records, nextCursor }],
      pageParams: [undefined],
    },
  );
}

afterEach(() => {
  for (const value of clients.splice(0)) value.clear();
  context.session = undefined;
  vi.restoreAllMocks();
});

describe("task artifact scope", () => {
  it("rejects another task or producer attempt before displaying its file records", async () => {
    const { detail, metadata } = await fixture();
    const page: InvestigationTaskArtifactsPage = {
      taskId: detail.task.id,
      items: [metadata],
      nextCursor: null,
    };
    expect(assertTaskArtifactPage(page, detail.task.id, metadata.artifact.attemptId)).toBe(page);
    expect(() => assertTaskArtifactPage(page, "another-task")).toThrow("does not belong");
    expect(() => assertTaskArtifactPage(page, detail.task.id, "another-attempt")).toThrow(
      "does not belong",
    );
    expect(() =>
      assertTaskArtifactPage(
        {
          ...page,
          items: [{ ...metadata, artifact: { ...metadata.artifact, taskId: "foreign" } }],
        },
        detail.task.id,
      ),
    ).toThrow("does not belong");
  });

  it("deduplicates page boundaries without accepting a changed artifact identity", async () => {
    const { detail, metadata } = await fixture();
    const page = { taskId: detail.task.id, items: [metadata], nextCursor: null };
    expect(taskArtifactRecords([page, page])).toEqual([metadata]);
    expect(() =>
      taskArtifactRecords([
        page,
        {
          ...page,
          items: [{ ...metadata, artifact: { ...metadata.artifact, digest: "f".repeat(64) } }],
        },
      ]),
    ).toThrow("does not match");
  });

  it("separates task, attempt, and account access in the query cache", async () => {
    const { detail } = await fixture();
    const identity = sessionIdentity(context.session);
    const current = taskArtifactsQueryKey(identity, detail.task.id, "attempt-one");
    expect(current).not.toEqual(taskArtifactsQueryKey(identity, detail.task.id, "attempt-two"));
    expect(current).not.toEqual(taskArtifactsQueryKey(identity, "another-task", "attempt-one"));
    if (!context.session?.authenticated) throw new Error("The fixture is signed out.");
    const revoked = { ...context.session, user: { ...context.session.user, repositoryIds: [] } };
    expect(current).not.toEqual(
      taskArtifactsQueryKey(sessionIdentity(revoked), detail.task.id, "attempt-one"),
    );
  });
});

describe("task evidence presentation", () => {
  it.each(["pr-review", "issue-investigate"] as const)(
    "identifies %s files as static workspace evidence",
    async (kind) => {
      const { detail, metadata, checkpoint } = await fixture();
      const queryClient = client();
      cacheFiles(queryClient, detail.task.id, [metadata]);
      const html = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <TaskEvidencePanel
            task={{ ...detail.task, kind }}
            checkpoint={checkpoint}
            active={false}
          />
        </QueryClientProvider>,
      );
      expect(html).toContain("Static review captures are not application test results");
      expect(html).not.toContain("retained execution evidence");
      expect(html).not.toContain("Recorded test results");
    },
  );

  it.each([
    "pr-verify",
    "issue-verify",
    "reproduction-setup",
    "issue-fix",
    "feature-implement",
  ] as const)(
    "identifies %s files as execution evidence without claiming a verification pass",
    async (kind) => {
      const { detail, metadata, checkpoint } = await fixture();
      const queryClient = client();
      cacheFiles(queryClient, detail.task.id, [metadata]);
      const html = renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <TaskEvidencePanel
            task={{ ...detail.task, kind, state: "completed" }}
            checkpoint={checkpoint}
            active={false}
          />
        </QueryClientProvider>,
      );
      expect(html).toContain(metadata.artifact.name);
      expect(html).toContain("retained execution evidence");
      expect(html).toContain("Uploaded files alone do not establish passing verification");
      expect(html).toContain("requires eligible evidence from an independent E2E task");
      expect(html).not.toContain("Static review captures");
      expect(html).not.toContain("Recorded test results");
    },
  );

  it("shows only uploaded records and keeps final tasks paged and refreshable", async () => {
    const { detail, metadata, checkpoint } = await fixture();
    const queryClient = client();
    cacheFiles(queryClient, detail.task.id, [metadata], undefined, "next-page");
    checkpoint.runtime.artifacts.push({
      ...metadata.artifact,
      id: "unregistered-recording",
      name: "Pending recording.mp4",
      mediaType: "video/mp4",
      kind: "video",
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TaskEvidencePanel
          task={{ ...detail.task, state: "completed" }}
          checkpoint={checkpoint}
          active={false}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain(metadata.artifact.name);
    expect(html).toContain("Load more files");
    expect(html).toContain('aria-label="Refresh files"');
    expect(html).toContain("Availability recorded in workspace");
    expect(html).toContain("internal workspace evidence");
    expect(html).not.toContain("Pending recording.mp4");
    expect(html).not.toContain("<video");
  });

  it("does not reinterpret a stored image or completed status as an E2E pass", async () => {
    const { detail, metadata, checkpoint } = await fixture();
    const queryClient = client();
    cacheFiles(queryClient, detail.task.id, [metadata]);
    delete checkpoint.runtime.e2e;
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TaskEvidencePanel
          task={{ ...detail.task, kind: "pr-e2e", state: "completed" }}
          checkpoint={checkpoint}
          active={false}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("No E2E feature results are recorded");
    expect(html).toContain("do not establish passing tests");
    expect(html).toContain("Workspace storage and GitHub delivery are separate");
    expect(html).not.toContain("Static review captures");
    expect(html).not.toContain("retained execution evidence");
    expect(html).not.toContain("Recorded test results");
  });

  it("reads E2E assertions only from the matching accepted checkpoint", async () => {
    const { detail, checkpoint } = await fixture();
    const task = { ...detail.task, kind: "pr-e2e" as const };
    checkpoint.runtime.e2e = result;
    expect(taskCheckpointE2e(task, checkpoint, checkpoint.attemptId)).toBe(result);
    expect(taskCheckpointE2e(task, checkpoint, "new-attempt")).toBeUndefined();
    expect(taskCheckpointE2e({ ...task, id: "another-task" }, checkpoint)).toBeUndefined();
    expect(taskCheckpointE2e({ ...task, kind: "pr-review" }, checkpoint)).toBeUndefined();
    const queryClient = client();
    cacheFiles(queryClient, task.id, []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TaskEvidencePanel task={task} checkpoint={checkpoint} active={false} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Recorded recovery assertion");
    expect(html).toContain("1 passed");
    expect(html).toContain(checkpoint.id);
    expect(html).toContain("No stored files");
  });

  it("does not expose cached file metadata after repository access is removed", async () => {
    const { detail, metadata, checkpoint } = await fixture();
    const queryClient = client();
    cacheFiles(queryClient, detail.task.id, [metadata]);
    if (!context.session?.authenticated) throw new Error("The fixture is signed out.");
    context.session = {
      ...context.session,
      user: { ...context.session.user, repositoryIds: [] },
    };
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TaskEvidencePanel task={detail.task} checkpoint={checkpoint} active={false} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Evidence is unavailable for the current account");
    expect(html).not.toContain(metadata.artifact.name);
    expect(html).not.toContain(metadata.artifact.digest);
  });

  it("keeps a denied reader locked across remounts even when old files remain in the cache", async () => {
    const { detail, metadata, checkpoint } = await fixture();
    const queryClient = client();
    cacheFiles(queryClient, detail.task.id, [metadata]);
    queryClient.setQueryData(
      evidenceAccessQueryKey(sessionIdentity(context.session), "task", detail.task.id),
      true,
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TaskEvidencePanel task={detail.task} checkpoint={checkpoint} active />
      </QueryClientProvider>,
    );
    expect(html).toContain("Check access");
    expect(html).toContain("Evidence is unavailable for the current account");
    expect(html).not.toContain(metadata.artifact.name);
    expect(html).not.toContain(metadata.artifact.digest);
    expect(html).not.toContain('aria-label="Refresh files"');
    expect(html).not.toContain("Load more files");
  });
});
