import type { InvestigationSession, InvestigationWorkerControl } from "@agentic-review/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { sampleWorkers } from "./sample-operations";
import { InvestigationHttpError } from "./transport";
import WorkersPage, { WorkerControlCard, workerControlError } from "./workers-page";

const context = vi.hoisted(() => ({
  session: { authenticated: true, user: { isAdmin: false } } as InvestigationSession,
}));
vi.mock("./session", () => ({ useInvestigationSession: () => ({ session: context.session }) }));

function renderWorker(overrides: Partial<InvestigationWorkerControl> = {}, canEdit = true) {
  const worker = { ...sampleWorkers("2026-09-19T03:01:00.000Z")[0]!, ...overrides };
  return renderToStaticMarkup(
    <MemoryRouter>
      <WorkerControlCard
        worker={worker}
        canEdit={canEdit}
        now={Date.parse("2026-09-19T03:02:00.000Z")}
        onSave={async () => {}}
      />
    </MemoryRouter>,
  );
}

describe("worker task permissions", () => {
  it("does not mount an administrator query for a non-administrator", () => {
    expect(renderToStaticMarkup(<WorkersPage />)).toContain("Administrator access is required");
  });

  it("shows static-only task assignment without restricting local capture", () => {
    const html = renderWorker({}, false);
    expect(html).toContain("Static only");
    expect(html).toContain("PR review");
    expect(html).toContain("Issue analysis");
    expect(html).toContain("Only workspace administrators");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Local screenshots are disabled");
  });

  it("distinguishes an enabled server switch from a worker that advertises only static tasks", () => {
    const html = renderWorker({ e2eEnabled: true });
    expect(html).toContain("Static capability");
    expect(html).toContain("must also advertise the required task type");
    expect(html).not.toContain(">E2E allowed<");
  });

  it("keeps owned cleanup visible until the backend confirms disablement", () => {
    const html = renderWorker({
      status: "disabling",
      activeE2eTaskIds: ["task-with-resources"],
      cleanupPendingAttemptIds: ["attempt-pending-cleanup"],
    });
    expect(html).toContain("Disabling E2E");
    expect(html).toContain("being cancelled and cleaned up");
    expect(html).toContain("taskId=task-with-resources");
    expect(html).toContain("attempt-pending-cleanup");
    expect(html).not.toContain(">Static only<");
  });

  it("does not misreport an uncontacted worker as a desktop cleanup failure", () => {
    const html = renderWorker({
      e2eEnabled: true,
      status: "awaiting_confirmation",
      lastSeenAt: null,
      advertisedKinds: null,
      effectiveKinds: [],
    });
    expect(html).toContain("Awaiting worker contact");
    expect(html).toContain("No confirmed task capabilities");
    expect(html).not.toContain("has not confirmed desktop cleanup");
  });

  it("explains a version conflict instead of claiming the switch was saved", () => {
    expect(workerControlError(new InvestigationHttpError(409, "conflict"))).toContain(
      "Refresh workers before changing the switch again",
    );
    expect(workerControlError(new InvestigationHttpError(403, "Access revoked"))).toBe(
      "Access revoked",
    );
  });
});
