import type {
  InvestigationResourceLease,
  InvestigationSession,
  InvestigationWorkerControl,
} from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "./api";
import { sampleWorkers } from "./sample-operations";
import { InvestigationHttpError } from "./transport";
import WorkersPage, {
  filterWorkers,
  WorkerControlCard,
  WorkerDisableSummary,
  WorkerStaticOwnership,
  workerAdmissionInput,
  workerContactLabel,
  workerControlError,
  workerHasE2eOwnership,
  workersQueryKey,
} from "./workers-page";

const context = vi.hoisted(() => ({ session: {} as InvestigationSession }));
vi.mock("./session", () => ({ useInvestigationSession: () => ({ session: context.session }) }));
vi.mock("./navigation-guard", () => ({
  useUnsavedChanges: vi.fn(),
  useGuardedAction: () => (action: () => void) => action(),
}));

const now = Date.parse("2026-09-19T03:02:00.000Z");
const repository: Repository = {
  id: "repo-powertoys-fork",
  fullName: "example/PowerToys",
  githubRepositoryId: 123,
};

function worker(overrides: Partial<InvestigationWorkerControl> = {}): InvestigationWorkerControl {
  return { ...sampleWorkers("2026-09-19T03:01:00.000Z")[0]!, ...overrides };
}

function renderWorker(
  overrides: Partial<InvestigationWorkerControl> = {},
  props: Partial<Omit<ComponentProps<typeof WorkerControlCard>, "worker">> = {},
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WorkerControlCard
        worker={worker(overrides)}
        canEdit
        expanded
        now={now}
        onSave={async () => {}}
        {...props}
      />
    </MemoryRouter>,
  );
}

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: Infinity } },
  });
}

function renderPage(client: QueryClient, path = "/workers") {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <WorkersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  context.session = {
    authenticated: true,
    authMode: "password",
    loginPath: "/api/auth/login",
    expiresAt: "2099-01-01T00:00:00Z",
    user: {
      id: "administrator",
      username: "administrator",
      displayName: "Administrator",
      email: null,
      isAdmin: true,
      repositoryIds: [],
      permissions: [],
      actionCapabilities: [],
      allowRepositoryExecution: false,
    },
  };
});

describe("worker admission and repository permissions", () => {
  it("does not mount an administrator query for a non-administrator", () => {
    if (!context.session.authenticated) throw new Error("An authenticated fixture is required.");
    context.session.user.isAdmin = false;
    expect(renderToStaticMarkup(<WorkersPage />)).toContain("Administrator access is required");
  });

  it("keeps administration available without repository or business grants", () => {
    const client = queryClient();
    client.setQueryData(workersQueryKey, {
      items: [worker({ activeE2eTaskIds: ["private-task"] })],
    });
    client.setQueryData(["investigation-repositories"], { items: [repository] });
    const html = renderPage(client, "/workers?workerId=sample-static-worker");
    expect(html).toContain("Allow E2E work");
    expect(html).toContain("private-task");
    expect(html).not.toContain("example/PowerToys");
    expect(html).not.toContain("taskId=private-task");
    expect(html).not.toContain("repositories?repositoryId=");
    expect(html).not.toContain("Administrator access is required");
  });

  it("requires exact repository grants before displaying a name and detail link", () => {
    const restricted = renderWorker(
      {},
      { repositories: [repository], readableRepositoryIds: ["*", "example/PowerToys"] },
    );
    expect(restricted).toContain("repo-powertoys-fork");
    expect(restricted).not.toContain("example/PowerToys");
    expect(restricted).not.toContain("repositories?repositoryId=");
    const allowed = renderWorker(
      {},
      { repositories: [repository], readableRepositoryIds: [repository.id] },
    );
    expect(allowed).toContain("example/PowerToys");
    expect(allowed).toContain("repositories?repositoryId=repo-powertoys-fork");
  });

  it("does not infer task repository access from a worker's assigned repositories", () => {
    const html = renderWorker(
      { activeE2eTaskIds: ["unmapped-task"] },
      {
        repositories: [repository],
        readableRepositoryIds: [repository.id],
      },
    );
    expect(html).toContain("unmapped-task");
    expect(html).not.toContain("taskId=unmapped-task");
    expect(html).toContain("Owned E2E tasks");
  });

  it("shows one admission action and keeps capabilities inside the disclosure", () => {
    const html = renderWorker({}, { expanded: false });
    expect(html.match(/>Allow E2E work<\/button>/gu)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Advertised task types");
    expect(html).not.toContain("Saved policy record");
    expect(html).not.toContain("Cleanup complete");
  });

  it("omits the collapse control on the dedicated worker detail route", () => {
    const html = renderWorker({}, { expanded: true, onExpandedChange: vi.fn() });
    expect(html).toContain("Advertised task types");
    expect(html).not.toContain("Hide details");
    expect(html).not.toContain("workers-detail-toggle");
  });

  it("keeps stopping available while admission is on and prevents enabling during cleanup", () => {
    const active = renderWorker({
      e2eEnabled: true,
      activeE2eTaskIds: ["owned-task"],
      cleanupPendingAttemptIds: ["owned-attempt"],
    });
    expect(active).toMatch(/<button[^>]*>Stop E2E work<\/button>/u);
    const paused = renderWorker({ e2eEnabled: false, cleanupPendingAttemptIds: ["owned-attempt"] });
    expect(paused).toMatch(/<button[^>]*disabled=""[^>]*>Allow E2E work<\/button>/u);
    expect(paused).toContain("owned-attempt");
  });

  it("shows static admission without restricting local capture", () => {
    const html = renderWorker({}, { canEdit: false });
    expect(html).toContain("Admission off");
    expect(html).toContain("PR review");
    expect(html).toContain("Issue analysis");
    expect(html).toContain("Only workspace administrators");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Local screenshots are disabled");
  });

  it("distinguishes enabled policy from a worker advertising only static tasks", () => {
    const html = renderWorker({ e2eEnabled: true });
    expect(html).toContain("No E2E task types");
    expect(html).toContain("Waiting for the worker to report E2E support");
    expect(html).not.toContain(">Admission on<");
  });
});

describe("worker ownership and observed contact", () => {
  it("retains cleanup references after contact becomes stale", () => {
    const html = renderWorker({
      status: "disabling",
      lastSeenAt: "2026-09-18T03:01:00.000Z",
      activeE2eTaskIds: ["task-with-resources"],
      cleanupPendingAttemptIds: ["attempt-pending-cleanup"],
    });
    expect(html).toContain("Disabling E2E");
    expect(html).toContain("No recent contact");
    expect(html).toContain("being cancelled and cleaned up");
    expect(html).toContain("task-with-resources");
    expect(html).toContain("attempt-pending-cleanup");
    expect(html).toContain("Resources stay reserved until the worker confirms cleanup");
    expect(html).not.toContain("taskId=task-with-resources");
    expect(html).not.toContain("taskId=attempt-pending-cleanup");
  });

  it("does not report an uncontacted worker as a cleanup failure", () => {
    const html = renderWorker({
      e2eEnabled: true,
      status: "awaiting_confirmation",
      lastSeenAt: null,
      advertisedKinds: null,
      effectiveKinds: [],
    });
    expect(html).toContain("Awaiting worker contact");
    expect(html).toContain("Never contacted");
    expect(html).toContain("No confirmed task capabilities");
    expect(html).toContain("Not reported");
    expect(html).not.toContain("has not confirmed cleanup");
  });

  it("distinguishes never contacted from stale contact at the recent-contact boundary", () => {
    expect(workerContactLabel(worker({ lastSeenAt: null }), now)).toBe("Never contacted");
    expect(workerContactLabel(worker({ lastSeenAt: "2026-09-19T03:00:00.001Z" }), now)).toBe(
      "Recent contact",
    );
    expect(workerContactLabel(worker({ lastSeenAt: "2026-09-19T03:00:00.000Z" }), now)).toBe(
      "No recent contact",
    );
  });

  it("shows the outstanding ownership in the disable confirmation without promising release", () => {
    const value = worker({
      e2eEnabled: true,
      activeE2eTaskIds: ["owned-task"],
      cleanupPendingAttemptIds: ["owned-attempt"],
    });
    const html = renderToStaticMarkup(<WorkerDisableSummary worker={value} />);
    expect(workerHasE2eOwnership(value)).toBe(true);
    expect(html).toContain("owned-task");
    expect(html).toContain("owned-attempt");
    expect(html).toContain("Resources stay occupied until the worker confirms release");
    expect(html).toContain("All repositories assigned to this worker");
    expect(html).not.toContain("Local screenshots");
  });
});

describe("worker policy versions and explicit review", () => {
  it("keeps the reviewed numeric version and requires a disable confirmation", () => {
    const value = worker({ version: 7, e2eEnabled: true, activeE2eTaskIds: ["owned-task"] });
    expect(() => workerAdmissionInput(value, false, 7)).toThrow("Confirm turning off");
    expect(workerAdmissionInput(value, false, 7, true)).toEqual({ version: 7, e2eEnabled: false });
    expect(workerAdmissionInput(worker({ version: 9 }), true, 9)).toEqual({
      version: 9,
      e2eEnabled: true,
    });
  });

  it("does not silently adopt a policy version changed while confirmation was open", () => {
    const value = worker({ version: 8, e2eEnabled: true });
    expect(() => workerAdmissionInput(value, false, 7, true)).toThrow(InvestigationHttpError);
    expect(() => workerAdmissionInput(value, false, 7, true)).toThrow(
      "changed while you were reviewing",
    );
  });

  it("keeps a conflicted switch locked when polling changes the version", () => {
    const html = renderWorker(
      { version: 8 },
      {
        review: { refreshGeneration: 1 },
        refreshGeneration: 1,
        onReviewChange: vi.fn(),
      },
    );
    expect(html).toContain("The save was not confirmed");
    expect(html).toContain("disabled");
    expect(html).not.toContain("I reviewed the latest policy");
    expect(html).not.toContain("Worker admission policy saved");
  });

  it("requires explicit review of the policy after a successful manual refresh", () => {
    const html = renderWorker(
      { version: 8 },
      {
        review: { refreshGeneration: 1 },
        refreshGeneration: 2,
        onReviewChange: vi.fn(),
      },
    );
    expect(html).toContain("Latest saved policy: admission off · version 8");
    expect(html).toContain("I reviewed the latest policy");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Worker admission policy saved");
  });

  it("explains conflicts and preserves permission errors", () => {
    expect(workerControlError(new InvestigationHttpError(409, "conflict"))).toContain(
      "Refresh workers and review the saved policy",
    );
    expect(workerControlError(new InvestigationHttpError(403, "Access revoked"))).toBe(
      "Access revoked",
    );
  });
});

describe("static resource ownership from scheduler leases", () => {
  const lease: InvestigationResourceLease = {
    attemptId: "static-attempt",
    taskId: "static-task",
    workerId: "sample-static-worker",
    fence: 2,
    pool: "static",
    state: "held",
    acquiredAt: "2026-09-19T03:00:00Z",
    updatedAt: "2026-09-19T03:00:00Z",
    releasedAt: null,
    reason: null,
  };

  it("shows only unreleased static leases belonging to the selected worker", () => {
    const html = renderToStaticMarkup(
      <WorkerStaticOwnership
        workerId={lease.workerId}
        leases={[
          lease,
          {
            ...lease,
            attemptId: "static-cleanup",
            taskId: "cleanup-task",
            state: "needs_cleanup",
            reason: "awaiting_process_cleanup",
          },
          { ...lease, attemptId: "e2e-attempt", taskId: "e2e-task", pool: "e2e" },
          {
            ...lease,
            attemptId: "other-attempt",
            taskId: "other-worker-task",
            workerId: "other-worker",
          },
          {
            ...lease,
            attemptId: "released-attempt",
            taskId: "released-task",
            state: "released",
            releasedAt: "2026-09-19T03:01:00Z",
          },
        ]}
      />,
    );
    expect(html).toContain("static-task");
    expect(html).toContain("static-attempt");
    expect(html).toContain("Slot held");
    expect(html).toContain("cleanup-task");
    expect(html).toContain("Needs cleanup");
    expect(html).toContain("awaiting_process_cleanup");
    expect(html).not.toContain("e2e-attempt");
    expect(html).not.toContain("other-worker-task");
    expect(html).not.toContain("released-task");
    expect(html).not.toContain("Running");
    expect(html).not.toContain("taskId=");
  });

  it("does not mistake an empty scoped lease list for an idle worker", () => {
    const html = renderToStaticMarkup(
      <WorkerStaticOwnership workerId={lease.workerId} leases={[]} />,
    );
    expect(html).toContain("within your repository access");
    expect(html).toContain("This does not confirm that the worker is idle");
    expect(html).not.toContain("worker is available");
  });

  it("retains scheduler ownership and a retry when refreshing fails", () => {
    const html = renderToStaticMarkup(
      <WorkerStaticOwnership
        workerId={lease.workerId}
        leases={[lease]}
        error="Scheduler unavailable."
        onRetry={vi.fn()}
      />,
    );
    expect(html).toContain("Scheduler unavailable.");
    expect(html).toContain("release is unconfirmed");
    expect(html).toContain("static-attempt");
    expect(html).toContain("Retry static ownership");
  });
});

describe("worker directory", () => {
  it("searches worker, repository, task and cleanup references while applying the contact filter", () => {
    const values = [
      worker({
        id: "Windows-Alpha",
        cleanupPendingAttemptIds: ["attempt-cleanup"],
        activeE2eTaskIds: ["task-retained"],
      }),
      worker({ id: "new-worker", lastSeenAt: null }),
    ];
    expect(filterWorkers(values, " WINDOWS ", "recent", [], now).map((item) => item.id)).toEqual([
      "Windows-Alpha",
    ]);
    expect(
      filterWorkers(values, "example/powertoys", "cleanup", [repository], now).map(
        (item) => item.id,
      ),
    ).toEqual(["Windows-Alpha"]);
    expect(filterWorkers(values, "task-retained", "all", [], now).map((item) => item.id)).toEqual([
      "Windows-Alpha",
    ]);
    expect(filterWorkers(values, "attempt-cleanup", "never", [], now)).toEqual([]);
    expect(filterWorkers(values, "", "never", [], now).map((item) => item.id)).toEqual([
      "new-worker",
    ]);
  });

  it("does not treat a never-contacted worker as a previously contacted offline worker", () => {
    const values = [
      worker({ id: "offline-worker", lastSeenAt: "2026-09-18T03:00:00Z" }),
      worker({ id: "new-worker", lastSeenAt: null }),
    ];
    expect(filterWorkers(values, "", "not-recent", [], now).map((item) => item.id)).toEqual([
      "offline-worker",
    ]);
  });

  it("includes retained E2E ownership in the cleanup filter while awaiting offline confirmation", () => {
    const value = worker({
      status: "awaiting_confirmation",
      lastSeenAt: null,
      activeE2eTaskIds: ["retained-task"],
    });
    expect(filterWorkers([value], "", "cleanup", [], now)).toEqual([value]);
    expect(value.activeE2eTaskIds).toEqual(["retained-task"]);
  });

  it("opens worker details from its stable workerId link", () => {
    const client = queryClient();
    client.setQueryData(workersQueryKey, { items: [worker()] });
    const html = renderPage(client, "/workers?workerId=sample-static-worker");
    expect(html).toContain("Back to workers");
    expect(html).not.toContain("Hide details");
    expect(html).not.toContain("workers-detail-toggle");
    expect(html).toContain("Saved policy record");
    expect(html).toContain("Policy version");
  });

  it("distinguishes an empty directory from a filtered view with no matches", () => {
    const empty = queryClient();
    empty.setQueryData(workersQueryKey, { items: [] });
    expect(renderPage(empty)).toContain("No workers registered");
    const populated = queryClient();
    populated.setQueryData(workersQueryKey, { items: [worker()] });
    const html = renderPage(populated, "/workers?q=no-such-worker");
    expect(html).toContain("No workers match this view");
    expect(html).toContain("Show all workers");
    expect(html).not.toContain("No workers registered");
  });

  it("retains ownership after a failed refresh and marks the record unconfirmed", async () => {
    const client = queryClient();
    client.setQueryData(workersQueryKey, {
      items: [worker({ status: "disabling", cleanupPendingAttemptIds: ["still-owned-attempt"] })],
    });
    await client.prefetchQuery({
      queryKey: workersQueryKey,
      queryFn: () => Promise.reject(new Error("Worker refresh failed.")),
    });
    const html = renderPage(client, "/workers?workerId=sample-static-worker");
    expect(html).toContain("Worker refresh failed.");
    expect(html).toContain("current state is unconfirmed");
    expect(html).toContain("still-owned-attempt");
    expect(html).toContain("disabled");
  });
});
