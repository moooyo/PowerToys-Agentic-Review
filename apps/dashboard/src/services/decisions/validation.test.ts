import type { ReviewRunDecisionContext, ReviewRunDecisionEvent } from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { ReviewControlProtocolError } from "../review-control/errors";
import {
  actor,
  context,
  event,
  history,
  input,
  repositoryId,
  reviewRunId,
} from "./fixtures.testing";
import { readDecisionChange, readDecisionContext, readDecisionHistory } from "./validation";

const dispositionDigest = "d".repeat(64);
const policyVersion = "required-checks-and-unresolved-p0-p1-v2" as const;
if (
  event.workItemKind !== "pull_request" ||
  event.action !== "approve" ||
  context.workItemKind !== "pull_request"
)
  throw new Error("Decision fixtures must describe a pull request approval.");
const eventV2: ReviewRunDecisionEvent = {
  ...event,
  policyAtDecision: {
    ...event.policyAtDecision,
    policyVersion,
    blockingFindingCount: 2,
    unresolvedBlockingFindingCount: 0,
    findingDispositionDigest: dispositionDigest,
  },
};
const contextV2: ReviewRunDecisionContext = {
  ...context,
  recordedDecision: eventV2,
  policy: {
    ...context.policy,
    policyVersion,
    blockingFindingCount: 2,
    unresolvedBlockingFindingCount: 0,
    findingDispositionDigest: dispositionDigest,
  },
};
const readContext = (value: unknown) =>
  readDecisionContext(value, repositoryId, reviewRunId, "read test decision context");
const readReceipt = (value: unknown) =>
  readDecisionChange(
    { change: value, replayed: true },
    repositoryId,
    reviewRunId,
    input,
    actor,
    "read test decision receipt",
  );

describe("versioned decision disposition policies", () => {
  it("accepts V2 approval while preserving the raw model blocker count", () => {
    expect(readContext(contextV2)).toEqual(contextV2);
    expect(readReceipt(eventV2)).toEqual({ change: eventV2, replayed: true });
  });

  it("preserves V1 approval rules in current contexts and historical receipts", () => {
    expect(readContext(context)).toEqual(context);
    expect(readReceipt(event)).toEqual({ change: event, replayed: true });
    expect(() =>
      readContext({ ...context, policy: { ...context.policy, blockingFindingCount: 1 } }),
    ).toThrow(ReviewControlProtocolError);
    expect(() =>
      readReceipt({
        ...event,
        policyAtDecision: { ...event.policyAtDecision, blockingFindingCount: 1 },
      }),
    ).toThrow(ReviewControlProtocolError);
  });

  it.each([
    { unresolvedBlockingFindingCount: 1 },
    { unresolvedBlockingFindingCount: 3, eligible: false },
    { unresolvedBlockingFindingCount: -1 },
    { unresolvedBlockingFindingCount: 0.5 },
    { unresolvedBlockingFindingCount: Number.MAX_SAFE_INTEGER + 1 },
    { unresolvedBlockingFindingCount: "0" },
    { unresolvedBlockingFindingCount: undefined },
    { findingDispositionDigest: "D".repeat(64) },
    { findingDispositionDigest: "d".repeat(63) },
    { findingDispositionDigest: `${dispositionDigest}\n` },
    { findingDispositionDigest: undefined },
  ])("rejects invalid V2 counts or bindings %j", (mutation) => {
    expect(() =>
      readContext({ ...contextV2, policy: { ...contextV2.policy, ...mutation } }),
    ).toThrow(ReviewControlProtocolError);
    expect(() =>
      readReceipt({ ...eventV2, policyAtDecision: { ...eventV2.policyAtDecision, ...mutation } }),
    ).toThrow(ReviewControlProtocolError);
  });

  it("rejects impossible unresolved totals even in a nonapproval Issue policy", () => {
    const value = {
      ...contextV2,
      workItemKind: "issue",
      recordedDecision: null,
      recordedDecisionState: "none",
      canApprove: false,
      policy: {
        ...contextV2.policy,
        applicable: false,
        eligible: null,
        unresolvedBlockingFindingCount: 3,
      },
    };
    expect(() => readContext(value)).toThrow(ReviewControlProtocolError);
    value.policy.unresolvedBlockingFindingCount = 2;
    expect(readContext(value)).toEqual(value);
  });

  it("rejects a changed policy version or disposition digest under an unchanged result-set binding", () => {
    expect(() => readContext({ ...contextV2, recordedDecision: event })).toThrow(
      ReviewControlProtocolError,
    );
    expect(() =>
      readContext({
        ...contextV2,
        recordedDecision: {
          ...eventV2,
          policyAtDecision: {
            ...eventV2.policyAtDecision,
            findingDispositionDigest: "e".repeat(64),
          },
        },
      }),
    ).toThrow(ReviewControlProtocolError);
  });

  it("retains historical V1 and V2 events without replacing their original bindings", () => {
    for (const recordedDecision of [event, eventV2]) {
      const value = {
        ...contextV2,
        resultSetDigest: "e".repeat(64),
        recordedDecision,
        recordedDecisionState: "stale",
        stateReasons: ["result_set_changed"],
        policy: { ...contextV2.policy, findingDispositionDigest: "f".repeat(64) },
      };
      expect(readContext(value)).toEqual(value);
      expect(readReceipt(recordedDecision).change).toEqual(recordedDecision);
    }
    expect(event.policyAtDecision).not.toHaveProperty("findingDispositionDigest");
  });

  it("accepts mixed-version history but does not upgrade old accepted receipts", () => {
    const second = {
      ...eventV2,
      id: "decision-two",
      changeId: "change-two",
      version: 2,
      previousVersion: 1,
      supersedesDecisionId: event.id,
    };
    const value = { ...history, total: 2, items: [second, event] };
    expect(
      readDecisionHistory(
        value,
        repositoryId,
        reviewRunId,
        { page: 1, pageSize: 20 },
        "read mixed history",
      ),
    ).toEqual(value);
    const serialized = JSON.stringify(event);
    expect(JSON.stringify(readReceipt(event).change)).toBe(serialized);
  });

  it("keeps source, policy reasons, and work item applicability as independent approval gates", () => {
    for (const value of [
      { ...contextV2, sourceCurrent: false },
      {
        ...contextV2,
        policy: { ...contextV2.policy, reasonCount: 1, reasons: [{ code: "evidence_missing" }] },
      },
      { ...contextV2, workItemKind: "issue" },
      { ...contextV2, policy: { ...contextV2.policy, eligible: false } },
    ])
      expect(() => readContext(value)).toThrow(ReviewControlProtocolError);
    const sourceStale = {
      ...contextV2,
      sourceCurrent: false,
      canApprove: false,
      recordedDecisionState: "stale",
      stateReasons: ["source_not_current"],
    };
    expect(readContext(sourceStale)).toEqual(sourceStale);
  });
});
