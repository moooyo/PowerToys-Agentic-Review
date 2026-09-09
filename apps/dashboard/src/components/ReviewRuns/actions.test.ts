import type { DashboardReviewRunRequest, JobState } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import {
  cancelUnavailableReason,
  rerunUnavailableReason,
  reviewPermissionUnavailableReason,
  reviewReadOnlyMessage,
} from "./actions";

const run = sampleReviewRuns[0];
if (!run) throw new Error("A sample run is required.");
const request = run.requests.find((entry) => entry.latestJob !== null);
if (!request?.latestJob) throw new Error("An executed sample request is required.");
const ready = {
  ...request,
  readiness: "ready",
  blockers: [],
  latestJob: { ...request.latestJob, status: "succeeded" },
} satisfies DashboardReviewRunRequest;

describe("review action access", () => {
  it("withholds review controls while access is being checked", () => {
    const can = vi.fn(() => true);
    expect(reviewPermissionUnavailableReason({ ready: true, checking: true, can })).toContain(
      "Checking review permissions",
    );
    expect(can).not.toHaveBeenCalled();
  });

  it("does not reuse an earlier grant when the current scope is unavailable", () => {
    const can = vi.fn(() => true);
    expect(reviewPermissionUnavailableReason({ ready: false, checking: false, can })).toContain(
      "permissions are unavailable",
    );
    expect(can).not.toHaveBeenCalled();
  });

  it("explains read-only access when the repository does not grant review permission", () => {
    const can = vi.fn(() => false);
    expect(reviewPermissionUnavailableReason({ ready: true, checking: false, can })).toBe(
      reviewReadOnlyMessage,
    );
    expect(can).toHaveBeenCalledWith("review");
  });

  it("permits review controls only after the selected repository grants review permission", () => {
    const can = vi.fn(() => true);
    expect(reviewPermissionUnavailableReason({ ready: true, checking: false, can })).toBeNull();
    expect(can).toHaveBeenCalledWith("review");
  });
});

describe("profile execution controls", () => {
  it("reruns a completed request only against its current ready frozen plan", () => {
    expect(rerunUnavailableReason({ ...run, freshness: "current" }, ready)).toBeNull();
    expect(rerunUnavailableReason({ ...run, freshness: "superseded" }, ready)).toContain(
      "current revision",
    );
    expect(rerunUnavailableReason(run, { ...ready, readiness: "blocked" })).toBeTruthy();
    expect(rerunUnavailableReason(run, { ...ready, prompt: null })).toBeTruthy();
    expect(rerunUnavailableReason(run, { ...ready, latestJob: null })).toBeTruthy();
  });

  it.each([
    "queued",
    "leased",
    "running",
    "retry_waiting",
    "cancel_requested",
  ] satisfies JobState[])("does not offer rerun while %s", (status) => {
    expect(
      rerunUnavailableReason(run, { ...ready, latestJob: { ...ready.latestJob, status } }),
    ).toBeTruthy();
  });

  it.each(["queued", "leased", "running", "retry_waiting"] satisfies JobState[])(
    "allows cancellation while %s",
    (status) => {
      expect(
        cancelUnavailableReason({ ...ready, latestJob: { ...ready.latestJob, status } }),
      ).toBeNull();
    },
  );

  it.each([
    "cancel_requested",
    "succeeded",
    "failed",
    "cancelled",
    "dead_letter",
    "stale",
  ] satisfies JobState[])("does not submit duplicate cancellation for %s", (status) => {
    expect(
      cancelUnavailableReason({ ...ready, latestJob: { ...ready.latestJob, status } }),
    ).toBeTruthy();
  });
});
