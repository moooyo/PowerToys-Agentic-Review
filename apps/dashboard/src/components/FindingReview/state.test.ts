import { describe, expect, it, vi } from "vitest";
import { ReviewControlHttpError } from "../../services/review-control/errors";
import { context, event, occurrence, principal, result } from "./fixtures.testing";
import {
  acceptReviewedFinding,
  createFindingEditor,
  findingAccessDenied,
  findingActionDescription,
  findingActionLabel,
  findingBindingMatches,
  findingContextMatchesResult,
  findingEditorUnavailable,
  findingPollingInterval,
  findingQueryKey,
  findingReceiptSummary,
  findingStateLabel,
  prepareFindingSubmission,
  receiveFindingFailure,
  reviewFindingCandidate,
} from "./state";

const error = (status: number) =>
  new ReviewControlHttpError("Request rejected", {
    status,
    operation: "change finding",
    retryable: false,
  });
const draft = () => ({
  ...createFindingEditor(context, occurrence, "accept"),
  reason: "  First paragraph.\n\nSecond paragraph.\t  ",
});

describe("finding scope and session identity", () => {
  it("matches immutable result identity while allowing a live historical context", () => {
    expect(findingContextMatchesResult(context, result)).toBe(true);
    expect(
      findingContextMatchesResult(
        { ...context, sourceCurrent: false, latestForRequest: false, historical: true },
        result,
      ),
    ).toBe(true);
    expect(findingContextMatchesResult(undefined, result)).toBe(false);
  });
  it.each([
    "repositoryId",
    "reviewRunId",
    "requestId",
    "jobId",
    "workItemId",
    "workItemKind",
    "resultId",
    "resultDigest",
    "revisionKey",
    "planDigest",
    "profileVersionId",
    "promptVersionId",
    "activationNumber",
  ] as const)("rejects a different %s", (field) => {
    expect(
      findingContextMatchesResult(
        { ...context, [field]: field === "activationNumber" ? 99 : "different" },
        result,
      ),
    ).toBe(false);
  });
  it("isolates the exact principal, mode, result, and repository", () => {
    const first = findingQueryKey("connected", result, principal);
    expect(findingQueryKey("connected", result, { ...principal, subject: "reviewer" })).not.toEqual(
      first,
    );
    expect(
      findingQueryKey("connected", result, { ...principal, issuer: "https://other.example" }),
    ).not.toEqual(first);
    expect(findingQueryKey("sample", result, principal)).not.toEqual(first);
    for (const field of [
      "id",
      "resultDigest",
      "repositoryId",
      "reviewRunId",
      "requestId",
      "jobId",
    ] as const)
      expect(
        findingQueryKey("connected", { ...result, [field]: "different" }, principal),
      ).not.toEqual(first);
  });
});

describe("finding disposition intent", () => {
  it("uses the immutable occurrence's original ordinal and exact multiline reason", () => {
    const prepared = prepareFindingSubmission(draft(), () => "intent-one");
    expect(prepared.request).toEqual({
      changeId: "intent-one",
      expectedVersion: 0,
      expectedResultDigest: result.resultDigest,
      expectedContextDigest: context.contextDigest,
      kind: "pr_finding",
      ordinal: 37,
      action: "accept",
      reason: draft().reason,
    });
    expect(JSON.stringify(prepared.request)).not.toContain(occurrence.modelId);
  });
  it("snapshots the original result and finding independently of refreshed objects", () => {
    const mutableContext = structuredClone(context),
      mutableFinding = structuredClone(occurrence);
    const editor = createFindingEditor(mutableContext, mutableFinding, "resolve");
    mutableContext.contextDigest = "0".repeat(64);
    mutableFinding.body = "Rewritten";
    mutableFinding.disposition.version = 5;
    expect(editor.context).toEqual(context);
    expect(editor.occurrence).toEqual(occurrence);
  });
  it("rejects an occurrence from another immutable result", () => {
    expect(() =>
      createFindingEditor(context, { ...occurrence, resultId: "other" }, "dismiss"),
    ).toThrow("does not belong");
  });
  it.each(["", " \n\t ", "x".repeat(2049), "invalid\0", "invalid\u007f", "invalid\ud800"])(
    "rejects an invalid reason",
    (reason) => {
      expect(() => prepareFindingSubmission({ ...draft(), reason })).toThrow("Enter a reason");
    },
  );
  it("retains an uncertain request exactly even when current result context changed", () => {
    const prepared = prepareFindingSubmission(draft(), () => "intent-one");
    const failed = receiveFindingFailure(prepared, new Error("Connection reset"));
    const create = vi.fn();
    expect(prepareFindingSubmission(failed, create)).toBe(failed);
    expect(create).not.toHaveBeenCalled();
    expect(
      findingEditorUnavailable(failed, { ...context, contextDigest: "new" }, occurrence, true),
    ).toBeNull();
    expect(findingEditorUnavailable(failed, undefined, undefined, false)).toContain(
      "Reviewer access",
    );
  });
  it("locks a 409 rejected intent until an explicit reviewed replacement is accepted", () => {
    const original = prepareFindingSubmission(draft(), () => "original");
    const rejected = receiveFindingFailure(original, error(409));
    expect(rejected.reason).toBe(original.reason);
    expect(rejected.request).toBe(original.request);
    expect(() => prepareFindingSubmission(rejected)).toThrow("explicitly use");
    const updated = {
      ...occurrence,
      disposition: {
        ...occurrence.disposition,
        state: "dismissed" as const,
        version: 1,
        lastEventId: "changed",
      },
    };
    const candidate = reviewFindingCandidate(
      rejected,
      { ...context, contextDigest: "b".repeat(64), sourceCurrent: false, historical: true },
      updated,
    );
    expect(candidate.context).toEqual(context);
    expect(candidate.request).toBe(original.request);
    expect(candidate.conflict).toBe(true);
    const accepted = acceptReviewedFinding(candidate);
    expect(accepted.context.sourceCurrent).toBe(false);
    expect(accepted.reason).toBe(original.reason);
    expect(accepted.request).toBeNull();
    expect(accepted.conflict).toBe(false);
    const next = prepareFindingSubmission(accepted, () => "replacement");
    expect(next.request?.changeId).toBe("replacement");
    expect(next.request?.expectedVersion).toBe(1);
    expect(next.request?.expectedContextDigest).toBe("b".repeat(64));
  });
  it("never substitutes a rerun finding even with identical model IDs or title", () => {
    expect(() =>
      reviewFindingCandidate(
        draft(),
        { ...context, resultId: "rerun" },
        { ...occurrence, resultId: "rerun" },
      ),
    ).toThrow("different immutable result");
    expect(() =>
      reviewFindingCandidate(draft(), context, { ...occurrence, key: "other", ordinal: 0 }),
    ).toThrow("different immutable result");
    expect(() => acceptReviewedFinding(draft())).toThrow("Load and review");
  });
  it.each([
    { contextDigest: "new" },
    { sourceCurrent: false },
    { latestForRequest: false },
    { resultDigest: "different" },
  ])("requires another review when execution context changes", (changed) => {
    expect(
      findingEditorUnavailable(draft(), { ...context, ...changed }, occurrence, true),
    ).toContain("context changed");
  });
  it("requires a fresh review when the disposition stream changed", () => {
    expect(
      findingBindingMatches(draft(), context, {
        ...occurrence,
        disposition: { ...occurrence.disposition, version: 2 },
      }),
    ).toBe(false);
  });
  it("permits explicitly viewed historical dispositions without pretending they apply to the latest run", () => {
    const historical = {
      ...context,
      sourceCurrent: false,
      latestForRequest: false,
      historical: true,
    };
    const editor = createFindingEditor(historical, occurrence, "dismiss");
    expect(findingEditorUnavailable(editor, historical, occurrence, true)).toBeNull();
  });
});

describe("finding semantics and live refresh", () => {
  it("keeps confirmed findings unresolved and resolution a human record", () => {
    expect(findingActionLabel("accept")).toBe("Confirm issue");
    expect(findingStateLabel("accepted")).toContain("unresolved");
    expect(findingActionDescription("accept")).toContain("remains unresolved");
    expect(findingActionDescription("resolve")).toContain("does not change checks");
    expect(findingActionDescription("dismiss")).toContain(
      "original model finding remains unchanged",
    );
    expect(findingActionDescription("reopen")).toContain("unresolved again");
    expect(findingReceiptSummary(event)).toContain("historical change");
  });
  it.each([401, 403, 404])("recognizes sensitive read denial %s", (status) =>
    expect(findingAccessDenied(error(status))).toBe(true),
  );
  it.each([409, 500])("does not mistake %s for access denial", (status) =>
    expect(findingAccessDenied(error(status))).toBe(false),
  );
  it("bounds polling to visible, authorized, successful connected reads", () => {
    const input = { mode: "connected" as const, visible: true, canRead: true, hasError: false };
    expect(findingPollingInterval(input)).toBe(30_000);
    expect(findingPollingInterval({ ...input, mode: "sample" })).toBe(false);
    expect(findingPollingInterval({ ...input, visible: false })).toBe(false);
    expect(findingPollingInterval({ ...input, canRead: false })).toBe(false);
    expect(findingPollingInterval({ ...input, hasError: true })).toBe(false);
  });
});
