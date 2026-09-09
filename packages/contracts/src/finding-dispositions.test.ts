import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  type FindingComparisonResponse,
  FindingComparisonResponseSchema,
  type FindingComparisonRow,
  FindingComparisonRowSchema,
  type FindingComparisonSide,
  FindingComparisonSideSchema,
  type FindingDisposition,
  FindingDispositionActionSchema,
  type FindingDispositionChangeRequest,
  FindingDispositionChangeRequestSchema,
  FindingDispositionChangeResponseSchema,
  type FindingDispositionEvent,
  FindingDispositionEventSchema,
  type FindingDispositionHistoryResponse,
  FindingDispositionHistoryResponseSchema,
  FindingDispositionSchema,
  FindingDispositionStateSchema,
  type FindingListResponse,
  FindingListResponseSchema,
  FindingListSummarySchema,
  FindingModelAvailabilitySchema,
  type FindingOccurrence,
  FindingOccurrenceKindSchema,
  type FindingOccurrenceRef,
  FindingOccurrenceRefSchema,
  FindingOccurrenceSchema,
  type FindingResultContext,
  FindingResultContextSchema,
  maximumFindingComparisonRowCount,
  maximumFindingDispositionPageSize,
  maximumFindingDispositionReasonLength,
  maximumFindingDispositionRequestUtf8Bytes,
  maximumFindingDispositionResponseUtf8Bytes,
  maximumFindingResultOccurrenceCount,
} from "./finding-dispositions.js";

FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));

const digest = "a".repeat(64);
const timestamp = "2026-09-07T10:00:00.000Z";
const actor = { issuer: "https://identity.example.test", subject: "reviewer-1" };
const scope = {
  repositoryId: "repository-1",
  reviewRunId: "run-1",
  requestId: "request-1",
  jobId: "job-1",
};
const reference: FindingOccurrenceRef = {
  key: digest,
  resultId: "result-1",
  resultDigest: digest,
  kind: "pr_finding",
  ordinal: 0,
};
const disposition: FindingDisposition = {
  state: "open",
  version: 0,
  lastEventId: null,
  updatedAt: null,
  updatedBy: null,
};
const finding: FindingOccurrence = {
  ...reference,
  modelId: "model-finding-1",
  title: "A retry applies the operation twice",
  body: "A timeout after a successful write can cause the retry to repeat the mutation.",
  priority: 1,
  path: "src/operations.ts",
  line: 15,
  endLine: 20,
  confidence: 0.9,
  disposition,
};
const context: FindingResultContext = {
  ...scope,
  workItemId: "work-item-1",
  workItemKind: "pull_request",
  resultId: reference.resultId,
  resultDigest: digest,
  revisionKey: digest,
  planDigest: digest,
  profileVersionId: "profile-version-1",
  promptVersionId: "prompt-version-1",
  workflowKind: "pr_static_build",
  target: "headless",
  activationNumber: 1,
  createdAt: timestamp,
  contextDigest: digest,
  sourceCurrent: true,
  latestForRequest: true,
  historical: false,
  modelAvailability: "complete",
  findingCount: 1,
  dispositionDigest: digest,
};
const list: FindingListResponse = {
  context,
  items: [finding],
  total: 1,
  page: 1,
  pageSize: 20,
  summary: {
    open: 1,
    accepted: 0,
    dismissed: 0,
    resolved: 0,
    rawBlocking: 1,
    unresolvedBlocking: 1,
  },
};
const change: FindingDispositionChangeRequest = {
  changeId: "change-1",
  expectedVersion: 0,
  expectedResultDigest: digest,
  expectedContextDigest: digest,
  kind: reference.kind,
  ordinal: reference.ordinal,
  action: "accept",
  reason: "Confirmed the duplicated side effect. A fix is required.",
};
const event: FindingDispositionEvent = {
  id: "event-1",
  changeId: change.changeId,
  ...scope,
  workItemId: context.workItemId,
  workItemKind: context.workItemKind,
  occurrence: reference,
  revisionKey: digest,
  planDigest: digest,
  resultSetDigestAtChange: digest,
  contextDigestAtChange: change.expectedContextDigest,
  sourceCurrentAtChange: true,
  latestForRequestAtChange: true,
  previousState: "open",
  state: "accepted",
  previousVersion: 0,
  version: 1,
  action: change.action,
  reason: change.reason,
  actor,
  createdAt: timestamp,
};
const history: FindingDispositionHistoryResponse = {
  ...scope,
  occurrence: reference,
  page: 1,
  pageSize: 20,
  total: 1,
  items: [event],
};
const side: FindingComparisonSide = {
  ...reference,
  title: finding.title,
  priority: finding.priority,
  path: finding.path,
  line: finding.line,
};
const comparisonRow: FindingComparisonRow = {
  status: "persistent",
  before: side,
  after: { ...side, resultId: "result-2", resultDigest: "b".repeat(64), key: "c".repeat(64) },
  reason: null,
};
const comparison: FindingComparisonResponse = {
  algorithmVersion: "exact-content-v1",
  before: context,
  after: {
    ...context,
    jobId: "job-2",
    resultId: "result-2",
    resultDigest: "b".repeat(64),
    activationNumber: 2,
  },
  compatible: true,
  reasons: [],
  items: [comparisonRow],
  total: 1,
  page: 1,
  pageSize: 20,
};

describe("immutable finding occurrence identity", () => {
  it.each(["pr_finding", "validation_observation"])(
    "uses a complete result reference and original ordinal for %s",
    (kind) => {
      for (const ordinal of [0, 99]) {
        expect(Value.Check(FindingOccurrenceRefSchema, { ...reference, kind, ordinal })).toBe(true);
      }
      expect(Value.Check(FindingOccurrenceKindSchema, kind)).toBe(true);
    },
  );

  it.each([-1, 100, 0.5, "0", null])("rejects an invalid original ordinal %j", (ordinal) => {
    expect(Value.Check(FindingOccurrenceRefSchema, { ...reference, ordinal })).toBe(false);
    expect(Value.Check(FindingDispositionChangeRequestSchema, { ...change, ordinal })).toBe(false);
  });

  it.each(["key", "resultDigest"])("requires an exact SHA-256 for %s", (field) => {
    for (const value of ["", "a".repeat(40), "A".repeat(64), "g".repeat(64), `${digest}\n`, null]) {
      expect(Value.Check(FindingOccurrenceRefSchema, { ...reference, [field]: value })).toBe(false);
    }
  });

  it("cannot substitute a model identifier, preview position, or invented namespace", () => {
    const { key: _key, ...withoutKey } = reference;
    const { resultDigest: _resultDigest, ...withoutDigest } = reference;
    const { ordinal: _ordinal, ...withoutOrdinal } = reference;
    for (const invalid of [
      { ...withoutKey, modelId: finding.modelId },
      withoutDigest,
      { ...withoutOrdinal, previewIndex: 0 },
      { ...reference, resultId: "owner/result" },
      { ...reference, kind: "observation" },
    ]) {
      expect(Value.Check(FindingOccurrenceRefSchema, invalid)).toBe(false);
    }
  });

  it("retains complete finding text and explicit nullable locations", () => {
    expect(Value.Check(FindingOccurrenceSchema, finding)).toBe(true);
    expect(
      Value.Check(FindingOccurrenceSchema, {
        ...finding,
        kind: "validation_observation",
        path: null,
        line: null,
        endLine: null,
        confidence: null,
      }),
    ).toBe(true);
    const bounded = {
      ...finding,
      modelId: "m".repeat(128),
      title: "t".repeat(256),
      body: "b".repeat(8_192),
      path: "p".repeat(2_048),
    };
    expect(Value.Check(FindingOccurrenceSchema, bounded)).toBe(true);
    for (const [field, maximum] of [
      ["modelId", 128],
      ["title", 256],
      ["body", 8_192],
      ["path", 2_048],
    ] as const) {
      expect(
        Value.Check(FindingOccurrenceSchema, { ...bounded, [field]: "x".repeat(maximum + 1) }),
      ).toBe(false);
      expect(Value.Check(FindingOccurrenceSchema, { ...bounded, [field]: "" })).toBe(false);
    }
  });

  it.each([
    ["priority", -1],
    ["priority", 4],
    ["priority", 1.5],
    ["line", 0],
    ["endLine", 0],
    ["line", Number.MAX_SAFE_INTEGER + 1],
    ["confidence", -0.01],
    ["confidence", 1.01],
    ["confidence", "0.9"],
  ])("rejects invalid finding metadata %s=%j", (field, value) => {
    expect(Value.Check(FindingOccurrenceSchema, { ...finding, [field]: value })).toBe(false);
  });
});

describe("finding disposition intents and immutable receipts", () => {
  it.each([
    ["accept", "accepted"],
    ["dismiss", "dismissed"],
    ["resolve", "resolved"],
    ["reopen", "open"],
  ])("records %s as a human disposition action", (action, state) => {
    expect(Value.Check(FindingDispositionActionSchema, action)).toBe(true);
    expect(Value.Check(FindingDispositionStateSchema, state)).toBe(true);
    expect(Value.Check(FindingDispositionChangeRequestSchema, { ...change, action })).toBe(true);
    const committed = { ...event, action, state };
    expect(Value.Check(FindingDispositionEventSchema, committed)).toBe(true);
    expect(
      Value.Check(FindingDispositionSchema, {
        state,
        version: 1,
        lastEventId: event.id,
        updatedAt: timestamp,
        updatedBy: actor,
      }),
    ).toBe(true);
  });

  it.each(["approve", "ignore", "fixed", "comment", "not_observed_again", null])(
    "does not confuse an action or state with decision/comparison semantics %j",
    (value) => {
      expect(Value.Check(FindingDispositionActionSchema, value)).toBe(false);
      expect(Value.Check(FindingDispositionStateSchema, value)).toBe(false);
    },
  );

  it("allows an untouched state and accepted historical receipts without claiming current state", () => {
    expect(Value.Check(FindingDispositionSchema, disposition)).toBe(true);
    for (const replayed of [false, true]) {
      expect(Value.Check(FindingDispositionChangeResponseSchema, { change: event, replayed })).toBe(
        true,
      );
      expect(
        Value.Check(FindingDispositionChangeResponseSchema, {
          change: event,
          replayed,
          currentDisposition: disposition,
        }),
      ).toBe(false);
    }
  });

  it.each(["expectedResultDigest", "expectedContextDigest"])(
    "binds a change to the original %s",
    (field) => {
      const missing: Record<string, unknown> = { ...change };
      delete missing[field];
      expect(Value.Check(FindingDispositionChangeRequestSchema, missing)).toBe(false);
      for (const value of ["", "a".repeat(40), "A".repeat(64), null]) {
        expect(
          Value.Check(FindingDispositionChangeRequestSchema, { ...change, [field]: value }),
        ).toBe(false);
      }
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, "0", null])(
    "rejects invalid CAS or audit versions %j",
    (value) => {
      expect(
        Value.Check(FindingDispositionChangeRequestSchema, { ...change, expectedVersion: value }),
      ).toBe(false);
      expect(Value.Check(FindingDispositionSchema, { ...disposition, version: value })).toBe(false);
      expect(Value.Check(FindingDispositionEventSchema, { ...event, previousVersion: value })).toBe(
        false,
      );
      expect(Value.Check(FindingDispositionEventSchema, { ...event, version: value })).toBe(false);
    },
  );

  it("requires a positive version and exact actor identity for committed events", () => {
    expect(Value.Check(FindingDispositionEventSchema, { ...event, version: 0 })).toBe(false);
    for (const invalidActor of [
      { subject: actor.subject },
      { issuer: actor.issuer, email: actor.subject },
      { ...actor, displayName: "Reviewer" },
    ]) {
      expect(Value.Check(FindingDispositionEventSchema, { ...event, actor: invalidActor })).toBe(
        false,
      );
    }
  });

  it("preserves the exact submitted context binding separately from the Run result set", () => {
    const contextDigestAtChange = "c".repeat(64);
    expect(Value.Check(FindingDispositionEventSchema, { ...event, contextDigestAtChange })).toBe(
      true,
    );
    const { contextDigestAtChange: _binding, ...missing } = event;
    expect(Value.Check(FindingDispositionEventSchema, missing)).toBe(false);
    for (const invalid of ["", "a".repeat(40), "A".repeat(64), null]) {
      expect(
        Value.Check(FindingDispositionEventSchema, { ...event, contextDigestAtChange: invalid }),
      ).toBe(false);
    }
  });

  it.each([
    "",
    " ",
    "\r\n\t",
    "\u00a0\u3000",
    "x".repeat(2_049),
    "Before\u0000after",
    "\u001b[31m",
    "x\u007f",
    null,
  ])("rejects an empty, unsupported-control, or oversized reason %j", (reason) => {
    expect(Value.Check(FindingDispositionChangeRequestSchema, { ...change, reason })).toBe(false);
    expect(Value.Check(FindingDispositionEventSchema, { ...event, reason })).toBe(false);
  });

  it("preserves meaningful multiline reasons including CR, LF and TAB", () => {
    for (const reason of [
      "x".repeat(2_048),
      "First observation.\r\n\tAdditional detail.\n\nResolution.",
      "\nReviewed.\n",
    ]) {
      expect(Value.Check(FindingDispositionChangeRequestSchema, { ...change, reason })).toBe(true);
      expect(Value.Check(FindingDispositionEventSchema, { ...event, reason })).toBe(true);
    }
  });

  it.each(["actor", "repositoryId", "state", "resultSetDigestAtChange", "publishToGitHub"])(
    "rejects client authority or side effects in change field %s",
    (field) => {
      expect(
        Value.Check(FindingDispositionChangeRequestSchema, { ...change, [field]: "untrusted" }),
      ).toBe(false);
    },
  );
});

describe("bounded finding result lists and history", () => {
  it.each(["complete", "failed", "not_requested", "not_applicable"])(
    "retains explicit model availability %s independently from runner success",
    (modelAvailability) => {
      expect(Value.Check(FindingModelAvailabilitySchema, modelAvailability)).toBe(true);
      expect(Value.Check(FindingResultContextSchema, { ...context, modelAvailability })).toBe(true);
    },
  );

  it("distinguishes source freshness from latest activation without inventing authority", () => {
    expect(Value.Check(FindingResultContextSchema, context)).toBe(true);
    expect(
      Value.Check(FindingResultContextSchema, {
        ...context,
        sourceCurrent: true,
        latestForRequest: false,
        historical: true,
      }),
    ).toBe(true);
    expect(
      Value.Check(FindingResultContextSchema, {
        ...context,
        sourceCurrent: false,
        latestForRequest: true,
        historical: true,
      }),
    ).toBe(true);
    expect(Value.Check(FindingResultContextSchema, { ...context, authoritative: true })).toBe(
      false,
    );
  });

  it.each(["contextDigest", "dispositionDigest"])("requires the %s binding", (field) => {
    const missing: Record<string, unknown> = { ...context };
    delete missing[field];
    expect(Value.Check(FindingResultContextSchema, missing)).toBe(false);
    expect(Value.Check(FindingResultContextSchema, { ...context, [field]: "v1" })).toBe(false);
  });

  it("supports 200 findings across pages without truncating the selected finding body", () => {
    const fullPage = { ...list, total: 200, items: Array.from({ length: 20 }, () => finding) };
    expect(Value.Check(FindingListResponseSchema, fullPage)).toBe(true);
    expect(Value.Check(FindingListResponseSchema, { ...list, items: [], total: 0 })).toBe(true);
    expect(
      Value.Check(FindingListResponseSchema, { ...fullPage, items: [...fullPage.items, finding] }),
    ).toBe(false);
    expect(Value.Check(FindingListResponseSchema, { ...fullPage, total: 201 })).toBe(false);
    expect(Value.Check(FindingResultContextSchema, { ...context, findingCount: 201 })).toBe(false);
  });

  it("preserves raw blockers separately from unresolved blockers and human dispositions", () => {
    expect(
      Value.Check(FindingListSummarySchema, {
        open: 0,
        accepted: 0,
        dismissed: 1,
        resolved: 1,
        rawBlocking: 2,
        unresolvedBlocking: 0,
      }),
    ).toBe(true);
    for (const field of Object.keys(list.summary)) {
      for (const count of [-1, 201, 0.5, "0"]) {
        expect(Value.Check(FindingListSummarySchema, { ...list.summary, [field]: count })).toBe(
          false,
        );
      }
    }
  });

  it("allows long audit streams while limiting each response to 20 events", () => {
    expect(Value.Check(FindingDispositionHistoryResponseSchema, history)).toBe(true);
    const fullPage = { ...history, total: 300, items: Array.from({ length: 20 }, () => event) };
    expect(Value.Check(FindingDispositionHistoryResponseSchema, fullPage)).toBe(true);
    expect(
      Value.Check(FindingDispositionHistoryResponseSchema, {
        ...fullPage,
        items: [...fullPage.items, event],
      }),
    ).toBe(false);
    const { occurrence: _occurrence, ...unscoped } = history;
    expect(Value.Check(FindingDispositionHistoryResponseSchema, unscoped)).toBe(false);
  });

  it.each([0, -1, 1.5, 21, "20", null])("rejects invalid page sizes %j", (pageSize) => {
    for (const [schema, value] of [
      [FindingListResponseSchema, list],
      [FindingDispositionHistoryResponseSchema, history],
      [FindingComparisonResponseSchema, comparison],
    ] as const) {
      expect(Value.Check(schema, { ...value, pageSize })).toBe(false);
    }
  });
});

describe("conservative finding comparisons", () => {
  it("represents persistence without including mutable disposition or full body", () => {
    expect(Value.Check(FindingComparisonSideSchema, side)).toBe(true);
    expect(Value.Check(FindingComparisonRowSchema, comparisonRow)).toBe(true);
    expect(Value.Check(FindingComparisonResponseSchema, comparison)).toBe(true);
    expect(Value.Check(FindingComparisonSideSchema, { ...side, body: finding.body })).toBe(false);
    expect(Value.Check(FindingComparisonSideSchema, { ...side, disposition })).toBe(false);
  });

  it("keeps absence observations distinct from a human resolution", () => {
    for (const row of [
      { ...comparisonRow, status: "new", before: null },
      { ...comparisonRow, status: "not_observed_again", after: null },
    ]) {
      expect(Value.Check(FindingComparisonRowSchema, row)).toBe(true);
    }
    for (const status of ["resolved", "fixed", "dismissed", "regression"]) {
      expect(Value.Check(FindingComparisonRowSchema, { ...comparisonRow, status })).toBe(false);
    }
  });

  it.each(["ambiguous_match", "configuration_changed", "model_unavailable"])(
    "can explain an incomparable occurrence with %s",
    (reason) => {
      expect(
        Value.Check(FindingComparisonRowSchema, {
          ...comparisonRow,
          status: "incomparable",
          before: null,
          reason,
        }),
      ).toBe(true);
    },
  );

  it("bounds comparison reasons, rows, and the combined before/after inventory", () => {
    const bounded = {
      ...comparison,
      compatible: false,
      reasons: [
        "configuration_changed",
        "model_unavailable",
        "same_result",
        "baseline_not_earlier",
      ],
      total: 400,
      items: Array.from({ length: 20 }, () => comparisonRow),
    };
    expect(Value.Check(FindingComparisonResponseSchema, bounded)).toBe(true);
    for (const invalid of [
      { ...bounded, algorithmVersion: "fuzzy-v1" },
      { ...bounded, total: 401 },
      { ...bounded, items: [...bounded.items, comparisonRow] },
      { ...bounded, reasons: ["same_result", "same_result"] },
      { ...bounded, reasons: ["ambiguous_match"] },
      { ...bounded, reasons: ["secret"] },
    ]) {
      expect(Value.Check(FindingComparisonResponseSchema, invalid)).toBe(false);
    }
  });
});

describe("finding public response boundaries", () => {
  const cases: [string, TSchema, object][] = [
    ["reference", FindingOccurrenceRefSchema, reference],
    ["disposition", FindingDispositionSchema, disposition],
    ["finding", FindingOccurrenceSchema, finding],
    ["context", FindingResultContextSchema, context],
    ["summary", FindingListSummarySchema, list.summary],
    ["list", FindingListResponseSchema, list],
    ["event", FindingDispositionEventSchema, event],
    ["receipt", FindingDispositionChangeResponseSchema, { change: event, replayed: false }],
    ["history", FindingDispositionHistoryResponseSchema, history],
    ["comparison side", FindingComparisonSideSchema, side],
    ["comparison row", FindingComparisonRowSchema, comparisonRow],
    ["comparison", FindingComparisonResponseSchema, comparison],
  ];

  it.each(cases)("rejects extra private data in %s", (_name, schema, value) => {
    expect(Value.Check(schema, { ...value, privateMetadata: "private" })).toBe(false);
  });

  it("exports explicit transport limits independently from character and array limits", () => {
    expect(maximumFindingDispositionPageSize).toBe(20);
    expect(maximumFindingDispositionReasonLength).toBe(2_048);
    expect(maximumFindingDispositionRequestUtf8Bytes).toBe(16 * 1024);
    expect(maximumFindingDispositionResponseUtf8Bytes).toBe(2 * 1024 * 1024);
    expect(maximumFindingResultOccurrenceCount).toBe(200);
    expect(maximumFindingComparisonRowCount).toBe(400);
  });
});
