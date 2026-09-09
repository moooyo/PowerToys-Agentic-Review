import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleReviewRuns } from "../../services/runs/fixtures";
import {
  createEvidencePollingController,
  evidencePollingViewVisible,
  evidenceVerificationLabel,
  pendingEvidenceRequests,
  reproductionRefreshInterval,
} from "./evidence-verification";

afterEach(() => vi.unstubAllGlobals());

describe("current reproduction refresh", () => {
  const settled = {
    verificationInterval: false as const,
    mapped: true,
    pending: false,
    visible: true,
    hasError: false,
  };
  it("refreshes settled mapped evidence while retaining the original proof backoff", () => {
    expect(reproductionRefreshInterval(settled)).toBe(30_000);
    expect(
      reproductionRefreshInterval({ ...settled, pending: true, verificationInterval: 10_000 }),
    ).toBe(10_000);
  });
  it("never extends an exhausted pending window or polls unbound, hidden, or rejected reads", () => {
    expect(reproductionRefreshInterval({ ...settled, pending: true })).toBe(false);
    expect(reproductionRefreshInterval({ ...settled, mapped: false })).toBe(false);
    expect(reproductionRefreshInterval({ ...settled, visible: false })).toBe(false);
    expect(
      reproductionRefreshInterval({ ...settled, hasError: true, verificationInterval: 5_000 }),
    ).toBe(false);
  });
});

describe("evidence verification status", () => {
  it("distinguishes pending verification from unavailable evidence without changing sample meaning", () => {
    const pending = { evidenceComplete: false, evidenceVerificationPending: true as const };
    expect(evidenceVerificationLabel(pending)).toBe("Evidence verification pending");
    expect(evidenceVerificationLabel({ evidenceComplete: false })).toBe("Not fully available");
    expect(evidenceVerificationLabel({ evidenceComplete: true })).toBe("Verified available");
    expect(evidenceVerificationLabel(pending, true)).toBe("Sample references only");
  });

  it("separates optional pending requests from required ones", () => {
    const run = structuredClone(sampleReviewRuns[0]);
    if (!run) throw new Error("A sample run is required.");
    for (const request of run.requests) request.blockers = [];
    const request = run.requests[0];
    if (!request?.latestResult) throw new Error("A completed request is required.");
    request.latestResult.evidenceVerificationPending = true;
    request.latestResult.evidenceComplete = false;
    request.required = false;
    expect(pendingEvidenceRequests(run)).toEqual({ required: 0, optional: 1 });
    request.required = true;
    expect(pendingEvidenceRequests(run)).toEqual({ required: 1, optional: 0 });
  });

  it("recognizes the explicit pending blocker even before a preview is available", () => {
    const run = structuredClone(sampleReviewRuns[0]);
    if (!run) throw new Error("A sample run is required.");
    for (const request of run.requests) request.blockers = [];
    const request = run.requests[0];
    if (!request) throw new Error("A request is required.");
    request.latestResult = null;
    request.blockers = ["evidence_verification_pending"];
    expect(pendingEvidenceRequests(run)).toEqual({ required: 1, optional: 0 });
  });
});

describe("bounded foreground verification refresh", () => {
  const input = {
    scope: "run-one",
    pending: true,
    completedReads: 1,
    visible: true,
    hasError: false,
  };

  it("backs off and stops after six completed refreshes", () => {
    const controller = createEvidencePollingController();
    expect(
      Array.from({ length: 8 }, (_, index) =>
        controller.next({ ...input, completedReads: index + 1 }),
      ),
    ).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000, false, false]);
  });

  it("does not count repeated observer updates as additional network reads", () => {
    const controller = createEvidencePollingController();
    for (let update = 0; update < 20; update++) expect(controller.next(input)).toBe(5_000);
    expect(controller.next({ ...input, completedReads: 2 })).toBe(10_000);
  });

  it("does not poll a hidden view, on errors, or after verification settles", () => {
    const controller = createEvidencePollingController();
    expect(controller.next({ ...input, visible: false })).toBe(false);
    expect(controller.next(input)).toBe(5_000);
    expect(controller.next({ ...input, completedReads: 2, visible: false })).toBe(false);
    expect(controller.next({ ...input, completedReads: 2, hasError: true })).toBe(false);
    expect(controller.next({ ...input, completedReads: 2 })).toBe(10_000);
    expect(controller.next({ ...input, completedReads: 3, pending: false })).toBe(false);
  });

  it("allows manual refresh or another selected run to start a fresh bounded window", () => {
    const controller = createEvidencePollingController();
    controller.next(input);
    expect(controller.next({ ...input, completedReads: 20 })).toBe(false);
    controller.reset();
    expect(controller.next({ ...input, completedReads: 21 })).toBe(5_000);
    expect(controller.next({ ...input, scope: "run-two", completedReads: 1 })).toBe(5_000);
  });

  it("treats a hidden document or server rendering as not visible", () => {
    vi.stubGlobal("document", undefined);
    expect(evidencePollingViewVisible()).toBe(false);
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(evidencePollingViewVisible()).toBe(false);
    vi.stubGlobal("document", { visibilityState: "visible" });
    expect(evidencePollingViewVisible()).toBe(true);
  });
});
