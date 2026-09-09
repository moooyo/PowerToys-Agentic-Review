import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { DashboardValidationPolicy } from "./dashboard-runs.js";
import {
  maximumReviewRunDecisionPageSize,
  maximumReviewRunDecisionReasonLength,
  maximumReviewRunDecisionRequestUtf8Bytes,
  maximumReviewRunDecisionResponseUtf8Bytes,
  type ReviewRunDecisionChangeRequest,
  ReviewRunDecisionChangeRequestSchema,
  ReviewRunDecisionChangeResponseSchema,
  type ReviewRunDecisionContext,
  ReviewRunDecisionContextSchema,
  type ReviewRunDecisionEvent,
  ReviewRunDecisionEventSchema,
  ReviewRunDecisionHistoryResponseSchema,
  type ReviewRunDecisionPolicySnapshot,
  ReviewRunDecisionPolicySnapshotSchema,
} from "./review-run-decisions.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const digest = "a".repeat(64);
const policy: DashboardValidationPolicy = {
  applicable: true,
  eligible: true,
  policyVersion: "required-checks-and-p0-p1-v1",
  blockingFindingCount: 0,
  reasonCount: 0,
  reasons: [],
  reasonsTruncated: false,
};
const policySnapshot: ReviewRunDecisionPolicySnapshot = {
  applicable: true,
  eligible: true,
  policyVersion: "required-checks-and-p0-p1-v1",
  blockingFindingCount: 0,
  reasonCount: 0,
  reasonCodes: [],
  reasonCodesTruncated: false,
};
const change: ReviewRunDecisionChangeRequest = {
  changeId: "change-1",
  expectedVersion: 0,
  expectedRevisionKey: digest,
  expectedPlanDigest: digest,
  expectedResultSetDigest: digest,
  action: "approve",
  reason: "Reviewed the current revision, findings and required evidence.",
};
const event: ReviewRunDecisionEvent = {
  repositoryId: "repository-1",
  reviewRunId: "run-1",
  workItemId: "work-item-1",
  workItemKind: "pull_request",
  id: "decision-1",
  changeId: change.changeId,
  actor: { issuer: "https://identity.example.test", subject: "operator-1" },
  previousVersion: 0,
  version: 1,
  createdAt: "2026-09-07T10:00:00.000Z",
  action: "approve",
  reason: change.reason,
  revisionKey: digest,
  planDigest: digest,
  resultSetDigest: digest,
  targetDecisionId: null,
  supersedesDecisionId: null,
  policyAtDecision: policySnapshot,
};
const context: ReviewRunDecisionContext = {
  repositoryId: event.repositoryId,
  reviewRunId: event.reviewRunId,
  workItemId: event.workItemId,
  workItemKind: "pull_request",
  revisionKey: digest,
  currentRevisionKey: digest,
  planDigest: digest,
  resultSetDigest: digest,
  version: 1,
  sourceCurrent: true,
  policy,
  recordedDecision: event,
  recordedDecisionState: "current",
  stateReasons: [],
  canApprove: true,
};
const issueEvent: ReviewRunDecisionEvent = {
  ...event,
  workItemKind: "issue",
  action: "request_changes",
  reason: "Please include the expected behavior and a reproducible scenario.",
  policyAtDecision: { ...policySnapshot, applicable: false, eligible: null },
};
const issueContext: ReviewRunDecisionContext = {
  ...context,
  workItemKind: "issue",
  policy: { ...policy, applicable: false, eligible: null },
  recordedDecision: issueEvent,
  canApprove: false,
};

describe("review run decision change requests", () => {
  it.each(["approve", "request_changes", "comment", "override_approve"])(
    "accepts a result-bound %s intent without a withdrawal target",
    (action) => {
      expect(Value.Check(ReviewRunDecisionChangeRequestSchema, { ...change, action })).toBe(true);
      for (const targetDecisionId of ["decision-1", null, undefined]) {
        expect(
          Value.Check(ReviewRunDecisionChangeRequestSchema, {
            ...change,
            action,
            targetDecisionId,
          }),
        ).toBe(false);
      }
    },
  );

  it("requires a specific prior decision only when withdrawing", () => {
    const withdrawal = { ...change, action: "withdraw", targetDecisionId: "decision-1" };
    expect(Value.Check(ReviewRunDecisionChangeRequestSchema, withdrawal)).toBe(true);
    for (const targetDecisionId of [null, undefined, "", "owner/decision", "x".repeat(129)]) {
      expect(
        Value.Check(ReviewRunDecisionChangeRequestSchema, { ...withdrawal, targetDecisionId }),
      ).toBe(false);
    }
    expect(
      Value.Check(ReviewRunDecisionChangeRequestSchema, { ...change, action: "withdraw" }),
    ).toBe(false);
  });

  it.each(Object.keys(change))("requires the complete intent field %s", (field) => {
    const missing: Record<string, unknown> = { ...change };
    delete missing[field];
    expect(Value.Check(ReviewRunDecisionChangeRequestSchema, missing)).toBe(false);
  });

  it.each(["expectedRevisionKey", "expectedPlanDigest", "expectedResultSetDigest"])(
    "requires an exact SHA-256 for %s",
    (field) => {
      for (const invalid of ["", "main", "a".repeat(40), "A".repeat(64), `${digest}\n`, null]) {
        expect(
          Value.Check(ReviewRunDecisionChangeRequestSchema, { ...change, [field]: invalid }),
        ).toBe(false);
      }
    },
  );

  it.each(["", " ", "\r\n\t", "\u00a0\u3000", "x".repeat(2_049), null])(
    "rejects an empty, whitespace-only, or oversized reason %j",
    (reason) => {
      expect(Value.Check(ReviewRunDecisionChangeRequestSchema, { ...change, reason })).toBe(false);
    },
  );

  it("allows bounded explanatory paragraphs without transforming their intent", () => {
    for (const reason of [
      "x".repeat(2_048),
      "First observation.\n\nSecond observation.",
      "\nValid.\n",
    ]) {
      expect(Value.Check(ReviewRunDecisionChangeRequestSchema, { ...change, reason })).toBe(true);
    }
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, "0", null])(
    "rejects invalid expected versions %j",
    (expectedVersion) => {
      expect(
        Value.Check(ReviewRunDecisionChangeRequestSchema, { ...change, expectedVersion }),
      ).toBe(false);
    },
  );

  it.each([
    "actor",
    "repositoryId",
    "reviewRunId",
    "eligible",
    "policyAtDecision",
    "reproductionConclusion",
    "publishToGitHub",
  ])("rejects caller-supplied authority or side-effect field %s", (field) => {
    expect(
      Value.Check(ReviewRunDecisionChangeRequestSchema, { ...change, [field]: "untrusted" }),
    ).toBe(false);
  });

  it.each(["acknowledge", "confirmed", "merge", "", null])(
    "rejects unsupported action %j",
    (action) => {
      expect(Value.Check(ReviewRunDecisionChangeRequestSchema, { ...change, action })).toBe(false);
    },
  );
});

describe("immutable human decision events and receipts", () => {
  it.each(["approve", "request_changes", "comment", "override_approve"])(
    "accepts a PR %s event with an explicit null target",
    (action) => {
      expect(Value.Check(ReviewRunDecisionEventSchema, { ...event, action })).toBe(true);
      expect(
        Value.Check(ReviewRunDecisionEventSchema, {
          ...event,
          action,
          targetDecisionId: "decision-0",
        }),
      ).toBe(false);
    },
  );

  it.each([event, issueEvent])("retains a withdrawal target for $workItemKind history", (value) => {
    const withdrawal = { ...value, action: "withdraw", targetDecisionId: value.id };
    expect(Value.Check(ReviewRunDecisionEventSchema, withdrawal)).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionEventSchema, { ...withdrawal, targetDecisionId: null }),
    ).toBe(false);
  });

  it.each(["comment", "request_changes"])("allows an Issue handling event %s", (action) => {
    expect(Value.Check(ReviewRunDecisionEventSchema, { ...issueEvent, action })).toBe(true);
  });

  it.each(["approve", "override_approve", "confirmed", "not_reproduced"])(
    "rejects approval or reproduction semantics %s on Issue events",
    (action) => {
      expect(Value.Check(ReviewRunDecisionEventSchema, { ...issueEvent, action })).toBe(false);
    },
  );

  it("requires policy applicability to agree with the event work item kind", () => {
    expect(
      Value.Check(ReviewRunDecisionEventSchema, {
        ...issueEvent,
        policyAtDecision: policySnapshot,
      }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunDecisionEventSchema, {
        ...event,
        policyAtDecision: issueEvent.policyAtDecision,
      }),
    ).toBe(false);
  });

  it.each(Object.keys(event))("requires the recorded event field %s", (field) => {
    const missing: Record<string, unknown> = { ...event };
    delete missing[field];
    expect(Value.Check(ReviewRunDecisionEventSchema, missing)).toBe(false);
  });

  it("does not allow identity substitution or private audit fields in public events", () => {
    expect(
      Value.Check(ReviewRunDecisionEventSchema, { ...event, actor: { subject: "operator-1" } }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunDecisionEventSchema, {
        ...event,
        actor: { ...event.actor, displayName: "Administrator" },
      }),
    ).toBe(false);
    for (const field of ["snapshot", "snapshotJson", "policyJson", "intentDigest", "published"]) {
      expect(Value.Check(ReviewRunDecisionEventSchema, { ...event, [field]: "private" })).toBe(
        false,
      );
    }
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null])(
    "bounds committed event versions %j",
    (version) => {
      expect(Value.Check(ReviewRunDecisionEventSchema, { ...event, version })).toBe(false);
    },
  );

  it.each([true, false])("returns an immutable accepted receipt with replayed=%s", (replayed) => {
    const receipt = { change: event, replayed };
    expect(Value.Check(ReviewRunDecisionChangeResponseSchema, receipt)).toBe(true);
    expect(Value.Check(ReviewRunDecisionChangeResponseSchema, { change: event })).toBe(false);
    expect(
      Value.Check(ReviewRunDecisionChangeResponseSchema, { ...receipt, currentDecision: event }),
    ).toBe(false);
  });
});

describe("compact decision policy snapshots", () => {
  it("keeps applicable PR eligibility and Issue null eligibility distinct", () => {
    expect(Value.Check(ReviewRunDecisionPolicySnapshotSchema, policySnapshot)).toBe(true);
    expect(Value.Check(ReviewRunDecisionPolicySnapshotSchema, issueEvent.policyAtDecision)).toBe(
      true,
    );
    expect(
      Value.Check(ReviewRunDecisionPolicySnapshotSchema, { ...policySnapshot, eligible: null }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunDecisionPolicySnapshotSchema, {
        ...issueEvent.policyAtDecision,
        eligible: false,
      }),
    ).toBe(false);
  });

  it("bounds distinct reason codes while retaining the full reason count and truncation flag", () => {
    const bounded = {
      ...policySnapshot,
      eligible: false,
      reasonCount: 300,
      reasonCodes: Array.from({ length: 128 }, (_, index) => `reason_${index}`),
      reasonCodesTruncated: true,
    };
    expect(Value.Check(ReviewRunDecisionPolicySnapshotSchema, bounded)).toBe(true);
    for (const reasonCodes of [
      [...bounded.reasonCodes, "reason_129"],
      ["same", "same"],
      [""],
      ["x".repeat(129)],
      [null],
    ]) {
      expect(Value.Check(ReviewRunDecisionPolicySnapshotSchema, { ...bounded, reasonCodes })).toBe(
        false,
      );
    }
    expect(
      Value.Check(ReviewRunDecisionPolicySnapshotSchema, {
        ...bounded,
        reasonCodes: ["x".repeat(128)],
      }),
    ).toBe(true);
  });

  it.each(["reasons", "fullPolicy", "sourceAuthorization", "snapshotDigest"])(
    "excludes private or verbose snapshot field %s",
    (field) => {
      expect(
        Value.Check(ReviewRunDecisionPolicySnapshotSchema, { ...policySnapshot, [field]: [] }),
      ).toBe(false);
    },
  );
});

describe("current human decision context", () => {
  it("represents an untouched stream and a populated decision independently", () => {
    expect(Value.Check(ReviewRunDecisionContextSchema, context)).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionContextSchema, {
        ...context,
        version: 0,
        recordedDecision: null,
        recordedDecisionState: "none",
      }),
    ).toBe(true);
  });

  it("preserves a historical approval when current evidence no longer satisfies policy", () => {
    expect(
      Value.Check(ReviewRunDecisionContextSchema, {
        ...context,
        policy: {
          ...policy,
          eligible: false,
          reasons: [{ code: "incomplete_evidence" }],
          reasonCount: 1,
        },
        recordedDecisionState: "ineligible",
        stateReasons: ["approval_policy_not_satisfied"],
        canApprove: false,
      }),
    ).toBe(true);
    expect(event.policyAtDecision.eligible).toBe(true);
  });

  it("represents a superseding source and result set without rewriting the original event", () => {
    expect(
      Value.Check(ReviewRunDecisionContextSchema, {
        ...context,
        currentRevisionKey: "b".repeat(64),
        resultSetDigest: "c".repeat(64),
        sourceCurrent: false,
        recordedDecisionState: "stale",
        stateReasons: ["result_set_changed", "source_not_current"],
        canApprove: false,
      }),
    ).toBe(true);
  });

  it("keeps a withdrawal as the latest non-comment event", () => {
    expect(
      Value.Check(ReviewRunDecisionContextSchema, {
        ...context,
        version: 2,
        recordedDecision: {
          ...event,
          id: "decision-2",
          changeId: "change-2",
          previousVersion: 1,
          version: 2,
          action: "withdraw",
          targetDecisionId: event.id,
          supersedesDecisionId: event.id,
        },
        recordedDecisionState: "withdrawn",
      }),
    ).toBe(true);
  });

  it("cannot expose Issue approval or a PR event inside an Issue context", () => {
    expect(Value.Check(ReviewRunDecisionContextSchema, issueContext)).toBe(true);
    expect(Value.Check(ReviewRunDecisionContextSchema, { ...issueContext, canApprove: true })).toBe(
      false,
    );
    expect(
      Value.Check(ReviewRunDecisionContextSchema, { ...issueContext, recordedDecision: event }),
    ).toBe(false);
    expect(Value.Check(ReviewRunDecisionContextSchema, { ...issueContext, policy })).toBe(false);
  });

  it.each([
    ["unknown"],
    ["result_set_changed", "result_set_changed"],
    [null],
    "source_not_current",
    null,
  ])("rejects ambiguous state reasons %j", (stateReasons) => {
    expect(Value.Check(ReviewRunDecisionContextSchema, { ...context, stateReasons })).toBe(false);
  });

  it.each(Object.keys(context))("requires the current context field %s", (field) => {
    const missing: Record<string, unknown> = { ...context };
    delete missing[field];
    expect(Value.Check(ReviewRunDecisionContextSchema, missing)).toBe(false);
  });

  it("rejects invented state and unrecognized context authority", () => {
    expect(
      Value.Check(ReviewRunDecisionContextSchema, {
        ...context,
        recordedDecisionState: "published",
      }),
    ).toBe(false);
    expect(Value.Check(ReviewRunDecisionContextSchema, { ...context, canMerge: true })).toBe(false);
  });
});

describe("bounded review run decision history", () => {
  const history = {
    repositoryId: event.repositoryId,
    reviewRunId: event.reviewRunId,
    page: 1,
    pageSize: 20,
    total: 1,
    items: [event],
  };

  it("supports empty and at most 20 immutable event rows per page", () => {
    expect(Value.Check(ReviewRunDecisionHistoryResponseSchema, history)).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionHistoryResponseSchema, { ...history, total: 0, items: [] }),
    ).toBe(true);
    const items = Array.from({ length: 20 }, (_, index) => ({ ...event, id: `decision-${index}` }));
    expect(
      Value.Check(ReviewRunDecisionHistoryResponseSchema, { ...history, total: 20, items }),
    ).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionHistoryResponseSchema, {
        ...history,
        total: 21,
        items: [...items, event],
      }),
    ).toBe(false);
  });

  it.each([0, -1, 1.5, 21, "20", null])("rejects an invalid history page size %j", (pageSize) => {
    expect(Value.Check(ReviewRunDecisionHistoryResponseSchema, { ...history, pageSize })).toBe(
      false,
    );
  });

  it.each(["repositoryId", "reviewRunId", "page", "pageSize", "total", "items"])(
    "requires history field %s",
    (field) => {
      const missing: Record<string, unknown> = { ...history };
      delete missing[field];
      expect(Value.Check(ReviewRunDecisionHistoryResponseSchema, missing)).toBe(false);
    },
  );

  it("rejects unscoped, malformed or extended history rows", () => {
    expect(Value.Check(ReviewRunDecisionHistoryResponseSchema, { ...history, page: 0 })).toBe(
      false,
    );
    expect(Value.Check(ReviewRunDecisionHistoryResponseSchema, { ...history, total: -1 })).toBe(
      false,
    );
    expect(Value.Check(ReviewRunDecisionHistoryResponseSchema, { ...history, items: [null] })).toBe(
      false,
    );
    expect(
      Value.Check(ReviewRunDecisionHistoryResponseSchema, { ...history, nextToken: "token" }),
    ).toBe(false);
  });

  it("exports explicit byte budgets for transport enforcement without modifying schema data", () => {
    expect(maximumReviewRunDecisionPageSize).toBe(20);
    expect(maximumReviewRunDecisionReasonLength).toBe(2_048);
    expect(maximumReviewRunDecisionRequestUtf8Bytes).toBe(16 * 1024);
    expect(maximumReviewRunDecisionResponseUtf8Bytes).toBe(1024 * 1024);
  });
});

describe("decision compatibility across disposition policy versions", () => {
  const policyV2 = {
    ...policy,
    policyVersion: "required-checks-and-unresolved-p0-p1-v2",
    blockingFindingCount: 2,
    unresolvedBlockingFindingCount: 0,
    findingDispositionDigest: digest,
  } as const;
  const snapshotV2 = {
    ...policySnapshot,
    policyVersion: "required-checks-and-unresolved-p0-p1-v2",
    blockingFindingCount: 2,
    unresolvedBlockingFindingCount: 0,
    findingDispositionDigest: digest,
  } as const;
  const eventV2 = { ...event, id: "decision-v2", policyAtDecision: snapshotV2 };

  it.each([policySnapshot, snapshotV2])(
    "keeps PR and Issue snapshots distinct under $policyVersion",
    (value) => {
      expect(Value.Check(ReviewRunDecisionPolicySnapshotSchema, value)).toBe(true);
      expect(
        Value.Check(ReviewRunDecisionPolicySnapshotSchema, {
          ...value,
          applicable: false,
          eligible: null,
        }),
      ).toBe(true);
      expect(Value.Check(ReviewRunDecisionPolicySnapshotSchema, { ...value, eligible: null })).toBe(
        false,
      );
      expect(
        Value.Check(ReviewRunDecisionPolicySnapshotSchema, {
          ...value,
          applicable: false,
          eligible: false,
        }),
      ).toBe(false);
    },
  );

  it("requires V2 disposition fields and rejects those fields on an original V1 snapshot", () => {
    for (const field of ["unresolvedBlockingFindingCount", "findingDispositionDigest"] as const) {
      const missing: Record<string, unknown> = { ...snapshotV2 };
      delete missing[field];
      expect(Value.Check(ReviewRunDecisionPolicySnapshotSchema, missing)).toBe(false);
      expect(
        Value.Check(ReviewRunDecisionPolicySnapshotSchema, {
          ...policySnapshot,
          [field]: snapshotV2[field],
        }),
      ).toBe(false);
    }
    expect(
      Value.Check(ReviewRunDecisionPolicySnapshotSchema, {
        ...snapshotV2,
        policyVersion: "required-checks-and-p0-p1-v1",
      }),
    ).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, "0", null])(
    "rejects an invalid V2 snapshot count %j",
    (unresolvedBlockingFindingCount) => {
      expect(
        Value.Check(ReviewRunDecisionPolicySnapshotSchema, {
          ...snapshotV2,
          unresolvedBlockingFindingCount,
        }),
      ).toBe(false);
    },
  );

  it.each(["", "a".repeat(40), "A".repeat(64), "g".repeat(64), `${digest}\n`, null])(
    "rejects an invalid V2 snapshot digest %j",
    (findingDispositionDigest) => {
      expect(
        Value.Check(ReviewRunDecisionPolicySnapshotSchema, {
          ...snapshotV2,
          findingDispositionDigest,
        }),
      ).toBe(false);
    },
  );

  it("reads a current V2 policy alongside an unchanged historical V1 decision", () => {
    const serializedLegacyEvent = JSON.stringify(event);
    expect(
      Value.Check(ReviewRunDecisionContextSchema, {
        ...context,
        policy: policyV2,
        recordedDecision: event,
        recordedDecisionState: "stale",
        stateReasons: ["result_set_changed"],
        canApprove: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionChangeResponseSchema, { change: event, replayed: true }),
    ).toBe(true);
    expect(JSON.stringify(event)).toBe(serializedLegacyEvent);
    expect(event.policyAtDecision).not.toHaveProperty("findingDispositionDigest");
  });

  it("supports mixed version history and new receipts without changing applicability", () => {
    expect(Value.Check(ReviewRunDecisionEventSchema, eventV2)).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionChangeResponseSchema, { change: eventV2, replayed: false }),
    ).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionHistoryResponseSchema, {
        repositoryId: event.repositoryId,
        reviewRunId: event.reviewRunId,
        page: 1,
        pageSize: 20,
        total: 2,
        items: [event, eventV2],
      }),
    ).toBe(true);
    const issueV2 = {
      ...issueEvent,
      policyAtDecision: { ...snapshotV2, applicable: false, eligible: null },
    };
    expect(Value.Check(ReviewRunDecisionEventSchema, issueV2)).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionEventSchema, { ...issueV2, policyAtDecision: snapshotV2 }),
    ).toBe(false);
    expect(
      Value.Check(ReviewRunDecisionContextSchema, {
        ...context,
        policy: policyV2,
        recordedDecision: eventV2,
      }),
    ).toBe(true);
    expect(
      Value.Check(ReviewRunDecisionContextSchema, { ...issueContext, recordedDecision: eventV2 }),
    ).toBe(false);
  });

  it("narrows the public types by applicability and explicit policy version", () => {
    const inspect = (value: ReviewRunDecisionContext) => {
      if (value.workItemKind === "pull_request") {
        expectTypeOf(value.policy.applicable).toEqualTypeOf<true>();
        expectTypeOf(value.policy.eligible).toEqualTypeOf<boolean>();
        if (value.recordedDecision !== null) {
          expectTypeOf(value.recordedDecision.workItemKind).toEqualTypeOf<"pull_request">();
          expectTypeOf(value.recordedDecision.policyAtDecision.applicable).toEqualTypeOf<true>();
        }
      } else {
        expectTypeOf(value.policy.applicable).toEqualTypeOf<false>();
        expectTypeOf(value.policy.eligible).toEqualTypeOf<null>();
      }
      if (value.policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2") {
        expectTypeOf(value.policy.unresolvedBlockingFindingCount).toEqualTypeOf<number>();
        expectTypeOf(value.policy.findingDispositionDigest).toEqualTypeOf<string>();
      } else {
        // @ts-expect-error Original V1 policies never carry a disposition binding.
        void value.policy.findingDispositionDigest;
      }
      const snapshot = value.recordedDecision?.policyAtDecision;
      if (snapshot?.policyVersion === "required-checks-and-unresolved-p0-p1-v2") {
        expectTypeOf(snapshot.unresolvedBlockingFindingCount).toEqualTypeOf<number>();
        expectTypeOf(snapshot.findingDispositionDigest).toEqualTypeOf<string>();
      }
    };
    inspect(context);
    inspect(issueContext);
  });
});
