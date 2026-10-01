import type { InvestigationWorkerControl } from "@agentic-review/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sampleWorkers } from "../investigation/sample-operations";
import {
  ConsoleWorkerControlCard,
  workerActivityLabel,
  workerAdmissionUpdateAllowed,
  workerDisplayName,
  workerPrimaryTaskId,
} from "./settings-workers";

const english = (_zh: string, en: string) => en;
const chinese = (zh: string) => zh;

function worker(overrides: Partial<InvestigationWorkerControl> = {}): InvestigationWorkerControl {
  return { ...sampleWorkers()[0]!, ...overrides };
}

function renderCard(overrides: Partial<InvestigationWorkerControl> = {}, stateUnconfirmed = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConsoleWorkerControlCard
        worker={worker(overrides)}
        busy={false}
        locked={false}
        stateUnconfirmed={stateUnconfirmed}
        onEnable={() => {}}
        onDisable={() => {}}
      />
    </QueryClientProvider>,
  );
  client.clear();
  return markup;
}

describe("console worker state and friendly names", () => {
  it("revokes an open disable confirmation when polling fails or is still refreshing", () => {
    const selected = worker({ e2eEnabled: true });
    const available = {
      isAdmin: true,
      locked: false,
      isPending: false,
      isError: false,
      isFetching: false,
    };
    expect(workerAdmissionUpdateAllowed(selected, false, available)).toBe(true);
    expect(
      workerAdmissionUpdateAllowed(
        { ...selected, version: selected.version + 1 },
        false,
        available,
        selected.version,
      ),
    ).toBe(false);
    expect(workerAdmissionUpdateAllowed(undefined, false, available, selected.version)).toBe(false);
    expect(workerAdmissionUpdateAllowed(selected, false, { ...available, isError: true })).toBe(
      false,
    );
    expect(workerAdmissionUpdateAllowed(selected, false, { ...available, isFetching: true })).toBe(
      false,
    );
    expect(workerAdmissionUpdateAllowed(selected, false, { ...available, isPending: true })).toBe(
      false,
    );
    expect(workerAdmissionUpdateAllowed(selected, false, { ...available, locked: true })).toBe(
      false,
    );
    expect(workerAdmissionUpdateAllowed(selected, false, { ...available, isAdmin: false })).toBe(
      false,
    );
    expect(workerAdmissionUpdateAllowed(selected, false, available)).toBe(true);
  });

  it("applies the same cleanup and policy grant when enabling from any update entry point", () => {
    const available = {
      isAdmin: true,
      locked: false,
      isPending: false,
      isError: false,
      isFetching: false,
    };
    expect(workerAdmissionUpdateAllowed(worker(), true, available)).toBe(true);
    for (const selected of [
      worker({ cleanupPendingAttemptIds: ["retained-attempt"] }),
      worker({ status: "awaiting_confirmation" }),
      worker({ status: "disabling" }),
      worker({ e2eEnabled: true }),
    ])
      expect(workerAdmissionUpdateAllowed(selected, true, available)).toBe(false);
  });

  it("uses configured names while retaining stable IDs and named admission controls", () => {
    const markup = renderCard({ displayName: "Windows Review Worker" });
    expect(markup).toContain("<strong>Windows Review Worker</strong>");
    expect(markup).toContain("sample-static-worker</code>");
    expect(markup).toContain('aria-label="Allow Windows Review Worker to run E2E"');
    expect(workerDisplayName(worker({ displayName: undefined }))).toBe("sample-static-worker");
  });

  it("renders the server state even when the browser contact timestamp appears fresh", () => {
    const markup = renderCard({ activityStatus: "offline", contactStatus: "stale" });
    expect(markup).toContain("console-settings-worker-state offline");
    expect(markup).toContain("Offline</span>");
    expect(markup).not.toContain("Online</span>");
  });

  it("leaves older payload state unconfirmed instead of inferring availability", () => {
    const markup = renderCard({ activityStatus: undefined, contactStatus: undefined });
    expect(markup).toContain("Status unconfirmed</span>");
    expect(markup).not.toContain("Online</span>");
  });

  it("marks cached online state unconfirmed after a polling failure and preserves recorded ownership", () => {
    const online = renderCard({}, true);
    expect(online).toContain("Status unconfirmed</span>");
    expect(online).not.toContain("Online</span>");
    expect(online).toContain("disabled=");
    const busy = renderCard({ activityStatus: "busy", activeTaskIds: ["owned-task"] }, true);
    expect(busy).toContain("Recorded ownership · State unavailable");
    expect(busy).toContain("owned-task");
  });

  it("keeps stale task ownership visible without claiming active execution", () => {
    const markup = renderCard({
      activityStatus: "busy",
      contactStatus: "stale",
      activeTaskIds: ["static-owned-task"],
      lastSeenAt: "2026-09-01T00:00:00.000Z",
    });
    expect(markup).toContain("Ownership retained · Contact expired");
    expect(markup).toContain("static-owned-task");
    expect(markup).not.toContain("Working");
  });

  it("shows pending cleanup and selects its E2E task before other owned tasks", () => {
    const value = worker({
      activityStatus: "cleaning",
      contactStatus: "stale",
      activeTaskIds: ["static-owned-task", "e2e-owned-task"],
      activeE2eTaskIds: ["e2e-owned-task"],
      cleanupPendingAttemptIds: ["e2e-attempt"],
    });
    expect(workerPrimaryTaskId(value)).toBe("e2e-owned-task");
    const markup = renderCard(value);
    expect(markup).toContain("Cleanup pending · Contact expired");
    expect(markup).toContain("e2e-owned-task");
    expect(markup).toContain("Awaiting cleanup");
    expect(markup).toContain("2 tasks remain owned");
    expect(markup).toContain("disabled=");
  });

  it("keeps ambiguous cleanup at worker level when multiple execution tasks remain owned", () => {
    const value = worker({
      activityStatus: "cleaning",
      activeTaskIds: ["running-task", "cleanup-task"],
      activeE2eTaskIds: ["running-task", "cleanup-task"],
      cleanupPendingAttemptIds: ["cleanup-attempt"],
    });
    expect(workerPrimaryTaskId(value)).toBe("running-task");
    const markup = renderCard(value);
    expect(markup).toContain("1 attempt awaits worker cleanup confirmation");
    expect(markup).not.toContain("Awaiting cleanup</span>");
  });

  it("provides equivalent Chinese and English state labels", () => {
    expect(workerActivityLabel("online", chinese)).toBe("在线");
    expect(workerActivityLabel("busy", chinese, "stale")).toBe("仍占用 · 联系超时");
    expect(workerActivityLabel("cleaning", chinese, "stale")).toBe("待清理 · 联系超时");
    expect(workerActivityLabel("busy", english, "recent")).toBe("Busy");
    expect(workerActivityLabel("cleaning", english, "recent")).toBe("Cleanup pending");
  });
});
