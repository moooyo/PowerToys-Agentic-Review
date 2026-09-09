import {
  type FindingComparisonResponse,
  type FindingDispositionEvent,
  maximumFindingDispositionResponseUtf8Bytes,
} from "@agentic-review/contracts";
import { describe, expect, it } from "vitest";
import { ReviewControlProtocolError } from "../review-control/errors";
import {
  actor,
  afterSide,
  beforeContext,
  beforeRef,
  beforeScope,
  beforeSide,
  comparison,
  context,
  event,
  history,
  input,
  list,
  makeRef,
  occurrence,
  ref,
  scope,
} from "./fixtures.testing";
import {
  findingOccurrenceKey,
  readFindingChange,
  readFindingComparison,
  readFindingHistory,
  readFindingList,
} from "./validation";

const page = { page: 1, pageSize: 20 };
const readList = (value: unknown) => readFindingList(value, scope, page, "list findings");
const readHistory = (value: unknown) =>
  readFindingHistory(value, scope, ref, page, "finding history");
const readComparison = (value: unknown) =>
  readFindingComparison(value, scope, beforeScope, page, "compare findings");
const readChange = (value: unknown) =>
  readFindingChange(value, scope, ref.key, input, actor, "change disposition");

describe("immutable finding list identities", () => {
  it("validates original ordinals independently from arbitrary model identifiers", async () => {
    const value = { ...list, items: [{ ...occurrence, modelId: "a model-specific label" }] };
    await expect(readList(value)).resolves.toEqual(value);
    await expect(findingOccurrenceKey(ref)).resolves.toBe(ref.key);
    expect(await findingOccurrenceKey({ ...ref, kind: "validation_observation" })).not.toBe(
      ref.key,
    );
    expect(await findingOccurrenceKey({ ...ref, ordinal: 1 })).not.toBe(ref.key);
  });

  it.each([
    { repositoryId: "other" },
    { reviewRunId: "other" },
    { requestId: "other" },
    { jobId: "other" },
    { historical: true },
    { sourceCurrent: false },
    { latestForRequest: false },
    { findingCount: 2 },
    { workItemKind: "issue" },
    { target: "web" },
    { modelAvailability: "not_requested" },
    { resultId: "other" },
    { resultDigest: "0".repeat(64) },
    { contextDigest: "x".repeat(64) },
    { createdAt: "2026-02-30T10:00:00.000Z" },
    { createdAt: "2026-09-07T25:00:00.000Z" },
    { activationNumber: 1.5 },
    { unexpected: true },
  ])("rejects inconsistent result context %j", async (mutation) => {
    await expect(
      readList({ ...list, context: { ...context, ...mutation } }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { key: "0".repeat(64) },
    { resultId: "other" },
    { resultDigest: "0".repeat(64) },
    { kind: "validation_observation" },
    { ordinal: 1 },
    { ordinal: 0.5 },
    { path: null },
    { path: "../secret" },
    { path: "/absolute" },
    { path: "C:/secret" },
    { path: "src//file.ts" },
    { path: "src/./file.ts" },
    { path: "src\\file.ts" },
    { path: "src/file\n.ts" },
    { line: null },
    { endLine: 9 },
    { confidence: null },
    { confidence: 1.1 },
    { confidence: -1 },
    { title: "\ud800" },
    { priority: 4 },
    { unexpected: true },
  ])("rejects unsafe or mismatched occurrence %j", async (mutation) => {
    await expect(
      readList({ ...list, items: [{ ...occurrence, ...mutation }] }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { state: "accepted" },
    { version: 1 },
    { lastEventId: "event-one" },
    { updatedAt: event.createdAt },
    { updatedBy: actor },
    { state: "resolved", version: 2, lastEventId: "event-two", updatedAt: event.createdAt },
  ])("rejects invalid mutable projection %j", async (mutation) => {
    await expect(
      readList({
        ...list,
        items: [{ ...occurrence, disposition: { ...occurrence.disposition, ...mutation } }],
      }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("accepts reopened history and retains the original blocker count after resolution", async () => {
    for (const state of ["open", "accepted", "dismissed", "resolved"] as const) {
      const value = {
        ...list,
        items: [
          {
            ...occurrence,
            disposition: {
              state,
              version: 3,
              lastEventId: "event-three",
              updatedAt: event.createdAt,
              updatedBy: actor,
            },
          },
        ],
        summary: {
          open: 0,
          accepted: 0,
          dismissed: 0,
          resolved: 0,
          [state]: 1,
          rawBlocking: 1,
          unresolvedBlocking: ["open", "accepted"].includes(state) ? 1 : 0,
        },
      };
      await expect(readList(value)).resolves.toEqual(value);
    }
  });

  it.each([
    { total: 2 },
    { total: 0 },
    { page: 2 },
    { pageSize: 19 },
    { items: [] },
    { summary: { ...list.summary, open: 0 } },
    { summary: { ...list.summary, accepted: 1 } },
    { summary: { ...list.summary, rawBlocking: 0 } },
    { summary: { ...list.summary, unresolvedBlocking: 0 } },
    { summary: { ...list.summary, rawBlocking: 2 } },
  ])("rejects inconsistent list counts or pages %j", async (mutation) => {
    await expect(readList({ ...list, ...mutation })).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("uses full-array ordinals on subsequent pages, including empty pages", async () => {
    const value = {
      ...list,
      context: { ...context, findingCount: 3 },
      total: 3,
      page: 2,
      pageSize: 1,
      summary: { ...list.summary, open: 3, rawBlocking: 3, unresolvedBlocking: 3 },
      items: [{ ...occurrence, ...makeRef({ ordinal: 1 }) }],
    };
    await expect(
      readFindingList(value, scope, { page: 2, pageSize: 1 }, "list findings"),
    ).resolves.toEqual(value);
    await expect(
      readFindingList(
        { ...value, items: [occurrence] },
        scope,
        { page: 2, pageSize: 1 },
        "list findings",
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      readFindingList(
        { ...value, page: 4, items: [] },
        scope,
        { page: 4, pageSize: 1 },
        "list findings",
      ),
    ).resolves.toMatchObject({ items: [] });
  });

  it("distinguishes empty complete findings from unavailable model output", async () => {
    for (const modelAvailability of [
      "complete",
      "failed",
      "not_requested",
      "not_applicable",
    ] as const) {
      const value = {
        ...list,
        context: { ...context, modelAvailability, findingCount: 0 },
        items: [],
        total: 0,
        summary: {
          open: 0,
          accepted: 0,
          dismissed: 0,
          resolved: 0,
          rawBlocking: 0,
          unresolvedBlocking: 0,
        },
      };
      await expect(readList(value)).resolves.toEqual(value);
    }
  });

  it("rejects blocker totals that cannot fit in the undisplayed findings", async () => {
    const value = {
      ...list,
      context: { ...context, findingCount: 3 },
      total: 3,
      pageSize: 1,
      items: [{ ...occurrence, priority: 2 }],
      summary: { ...list.summary, open: 3, rawBlocking: 3, unresolvedBlocking: 3 },
    };
    await expect(
      readFindingList(value, scope, { page: 1, pageSize: 1 }, "list findings"),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("accepts a full legal page larger than 1 MiB without truncating original model text", async () => {
    const value = {
      ...list,
      context: { ...context, findingCount: 20 },
      total: 20,
      items: Array.from({ length: 20 }, (_, ordinal) => ({
        ...occurrence,
        ...makeRef({ ordinal }),
        body: "\u0000".repeat(8192),
        title: "\u0000".repeat(256),
        path: "p".repeat(2048),
      })),
      summary: { ...list.summary, open: 20, rawBlocking: 20, unresolvedBlocking: 20 },
    };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(1024 * 1024);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThan(
      maximumFindingDispositionResponseUtf8Bytes,
    );
    await expect(readList(value)).resolves.toEqual(value);
  });

  it("supports Web and Windows validation observations and Issue results without fabricated PR locations", async () => {
    for (const [workflowKind, workItemKind, target] of [
      ["pr_ui", "pull_request", "web"],
      ["pr_ui", "pull_request", "windows_desktop"],
      ["issue_validation", "issue", "headless"],
      ["issue_validation", "issue", "web"],
    ] as const) {
      const value = {
        ...list,
        context: { ...context, workflowKind, workItemKind, target },
        items: [
          {
            ...occurrence,
            ...makeRef({ kind: "validation_observation" }),
            path: null,
            line: null,
            endLine: null,
            confidence: null,
          },
        ],
      };
      await expect(readList(value)).resolves.toEqual(value);
      await expect(
        readList({ ...value, items: [{ ...value.items[0], line: 1 }] }),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
  });
});

describe("finding disposition immutable receipts", () => {
  it("binds contextDigest separately from the run resultSetDigest and preserves historical replay", async () => {
    const value = {
      change: { ...event, sourceCurrentAtChange: false, latestForRequestAtChange: false },
      replayed: true,
    };
    expect(event.contextDigestAtChange).not.toBe(event.resultSetDigestAtChange);
    await expect(readChange(value)).resolves.toEqual(value);
    await expect(
      readChange({
        ...value,
        change: { ...value.change, contextDigestAtChange: event.resultSetDigestAtChange },
      }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      readChange({
        ...value,
        change: { ...value.change, resultSetDigestAtChange: "9".repeat(64) },
      }),
    ).resolves.toMatchObject({ replayed: true });
  });

  it.each([
    { repositoryId: "other" },
    { reviewRunId: "other" },
    { requestId: "other" },
    { jobId: "other" },
    { changeId: "other" },
    { actor: { ...actor, subject: "operator-a" } },
    { actor: { ...actor, issuer: actor.issuer.toLowerCase() } },
    { actor: { ...actor, subject: " Operator-A" } },
    { actor: { ...actor, subject: "Operator-A\ud800" } },
    { contextDigestAtChange: "9".repeat(64) },
    { resultSetDigestAtChange: "x".repeat(64) },
    { reason: "Another intent" },
    { reason: ` ${event.reason}` },
    { reason: "Invalid\u0085reason" },
    { action: "dismiss" },
    { state: "dismissed" },
    { previousState: "accepted" },
    { previousVersion: 1, version: 2 },
    { version: 2 },
    { createdAt: "2026-09-07T10:10:00+00:00" },
    { unexpected: true },
  ])("rejects a receipt with mismatched identity or invalid transition %j", async (mutation) => {
    await expect(
      readChange({ change: { ...event, ...mutation }, replayed: true }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it.each([
    { key: "0".repeat(64) },
    { resultId: "other" },
    { resultDigest: "0".repeat(64) },
    { ordinal: 1 },
    { kind: "validation_observation" },
  ])("rejects a receipt for a different immutable occurrence %j", async (mutation) => {
    await expect(
      readChange({ change: { ...event, occurrence: { ...ref, ...mutation } }, replayed: false }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("requires a real state transition and validates all supported actions", async () => {
    for (const [action, state] of [
      ["accept", "accepted"],
      ["dismiss", "dismissed"],
      ["resolve", "resolved"],
      ["reopen", "open"],
    ] as const) {
      const previousState = action === "reopen" ? "resolved" : "open";
      const value = {
        change: { ...event, action, state, previousState, previousVersion: 1, version: 2 },
        replayed: false,
      };
      await expect(
        readFindingChange(
          value,
          scope,
          ref.key,
          { ...input, action, expectedVersion: 1 },
          actor,
          "change disposition",
        ),
      ).resolves.toEqual(value);
      await expect(
        readFindingChange(
          { ...value, change: { ...value.change, previousState: state } },
          scope,
          ref.key,
          { ...input, action, expectedVersion: 1 },
          actor,
          "change disposition",
        ),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
  });
});

describe("finding history scope and projection", () => {
  it.each([
    { repositoryId: "other" },
    { reviewRunId: "other" },
    { requestId: "other" },
    { jobId: "other" },
    { page: 2 },
    { pageSize: 19 },
    { total: 2 },
    { total: 0 },
    { items: [] },
    { occurrence: makeRef({ ordinal: 1 }) },
    { items: [{ ...event, requestId: "other" }] },
  ])("rejects scope and paging mismatches %j", async (mutation) => {
    await expect(readHistory({ ...history, ...mutation })).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("requires a contiguous descending history and matching previous state without freezing authority", async () => {
    const second: FindingDispositionEvent = {
      ...event,
      id: "event-two",
      changeId: "change-two",
      previousVersion: 1,
      version: 2,
      previousState: "accepted",
      state: "resolved",
      action: "resolve",
      contextDigestAtChange: "8".repeat(64),
      resultSetDigestAtChange: "9".repeat(64),
      sourceCurrentAtChange: false,
    };
    const value = { ...history, total: 2, items: [second, event] };
    await expect(readHistory(value)).resolves.toEqual(value);
    for (const items of [
      [event, second],
      [{ ...second, id: event.id }, event],
      [{ ...second, changeId: event.changeId }, event],
      [{ ...second, previousState: "dismissed" }, event],
      [second, { ...event, workItemId: "other" }],
      [second, { ...event, revisionKey: "9".repeat(64) }],
      [second, { ...event, planDigest: "9".repeat(64) }],
      [second, { ...event, createdAt: "2026-09-07T10:11:00.000Z" }],
    ])
      await expect(readHistory({ ...value, items })).rejects.toBeInstanceOf(
        ReviewControlProtocolError,
      );
    await expect(
      readFindingHistory(
        { ...value, page: 2, pageSize: 1, items: [event] },
        scope,
        ref,
        { page: 2, pageSize: 1 },
        "history",
      ),
    ).resolves.toMatchObject({ items: [event] });
    await expect(
      readFindingHistory(
        { ...value, page: 3, pageSize: 1, items: [] },
        scope,
        ref,
        { page: 3, pageSize: 1 },
        "history",
      ),
    ).resolves.toMatchObject({ items: [] });
  });

  it("allows an empty event stream only for the requested immutable occurrence", async () => {
    await expect(readHistory({ ...history, total: 0, items: [] })).resolves.toMatchObject({
      total: 0,
    });
    await expect(
      readHistory({
        ...history,
        total: 0,
        items: [],
        occurrence: { ...ref, resultDigest: "9".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
});

describe("finding comparison boundaries", () => {
  it("accepts identical content across different revisions and plans without treating priority or lines as identity", async () => {
    expect(beforeContext.revisionKey).not.toBe(context.revisionKey);
    expect(beforeContext.planDigest).not.toBe(context.planDigest);
    await expect(readComparison(comparison)).resolves.toEqual(comparison);
  });

  it.each([
    { compatible: false },
    { reasons: ["configuration_changed"] },
    { total: 0 },
    { total: 2 },
    { page: 2 },
    { pageSize: 19 },
    { algorithmVersion: "unsafe-title-only-v1" },
    { before: { ...beforeContext, workItemId: "other" } },
    { after: { ...context, jobId: "other" } },
    { before: { ...beforeContext, createdAt: context.createdAt } },
    { before: { ...beforeContext, promptVersionId: "another-version" } },
    { before: { ...beforeContext, profileVersionId: "another-version" } },
  ])("rejects inconsistent comparison context %j", async (mutation) => {
    await expect(readComparison({ ...comparison, ...mutation })).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each([
    { before: null },
    { after: null },
    { reason: "ambiguous_match" },
    { status: "new" },
    { status: "not_observed_again" },
    { status: "incomparable" },
    { before: { ...beforeSide, resultId: ref.resultId } },
    { before: { ...beforeSide, key: ref.key } },
    { before: { ...beforeSide, title: "Other content" } },
    { before: { ...beforeSide, path: "src/other.ts" } },
    { before: { ...beforeSide, ordinal: 1 } },
  ])("rejects malformed or swapped comparison rows %j", async (mutation) => {
    await expect(
      readComparison({ ...comparison, items: [{ ...comparison.items[0], ...mutation }] }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("keeps missing findings as not observed again and treats duplicate matches as incomparable", async () => {
    const unmatched: FindingComparisonResponse = {
      ...comparison,
      total: 2,
      items: [
        { status: "not_observed_again", before: beforeSide, after: null, reason: null },
        { status: "new", before: null, after: afterSide, reason: null },
      ],
    };
    await expect(readComparison(unmatched)).resolves.toEqual(unmatched);
    const ambiguous: FindingComparisonResponse = {
      ...comparison,
      before: { ...beforeContext, findingCount: 2 },
      total: 3,
      items: [
        { status: "incomparable", before: beforeSide, after: null, reason: "ambiguous_match" },
        {
          status: "incomparable",
          before: {
            ...beforeSide,
            ...makeRef({
              resultId: beforeRef.resultId,
              resultDigest: beforeRef.resultDigest,
              ordinal: 1,
            }),
          },
          after: null,
          reason: "ambiguous_match",
        },
        { status: "incomparable", before: null, after: afterSide, reason: "ambiguous_match" },
      ],
    };
    await expect(readComparison(ambiguous)).resolves.toEqual(ambiguous);
    await expect(
      readComparison({
        ...ambiguous,
        items: [ambiguous.items[0], ambiguous.items[0], ambiguous.items[2]],
      }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("requires incompatible results to expose individual sides with the highest-precedence reason", async () => {
    const value: FindingComparisonResponse = {
      ...comparison,
      before: { ...beforeContext, promptVersionId: "other" },
      compatible: false,
      reasons: ["configuration_changed"],
      total: 2,
      items: [
        {
          status: "incomparable",
          before: beforeSide,
          after: null,
          reason: "configuration_changed",
        },
        { status: "incomparable", before: null, after: afterSide, reason: "configuration_changed" },
      ],
    };
    await expect(readComparison(value)).resolves.toEqual(value);
    await expect(
      readComparison({
        ...value,
        items: value.items.map((row) => ({ ...row, reason: "model_unavailable" })),
      }),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    const missing: FindingComparisonResponse = {
      ...comparison,
      before: { ...beforeContext, modelAvailability: "not_requested", findingCount: 0 },
      compatible: false,
      reasons: ["model_unavailable"],
      items: [
        { status: "incomparable", before: null, after: afterSide, reason: "model_unavailable" },
      ],
    };
    await expect(readComparison(missing)).resolves.toEqual(missing);
    const changed = {
      ...missing,
      before: { ...missing.before, promptVersionId: "other" },
      reasons: ["configuration_changed", "model_unavailable"],
      items: [{ ...missing.items[0], reason: "configuration_changed" }],
    };
    await expect(readComparison(changed)).resolves.toEqual(changed);
  });

  it("treats the same result or a later baseline as incomparable without fabricated model failures", async () => {
    const same: FindingComparisonResponse = {
      ...comparison,
      before: context,
      compatible: false,
      reasons: ["same_result", "baseline_not_earlier"],
      total: 2,
      items: [
        { status: "incomparable", before: afterSide, after: null, reason: null },
        { status: "incomparable", before: null, after: afterSide, reason: null },
      ],
    };
    await expect(
      readFindingComparison(same, scope, scope, page, "compare findings"),
    ).resolves.toEqual(same);
    const later: FindingComparisonResponse = {
      ...comparison,
      before: { ...beforeContext, createdAt: context.createdAt },
      compatible: false,
      reasons: ["baseline_not_earlier"],
      total: 2,
      items: [
        { status: "incomparable", before: beforeSide, after: null, reason: null },
        { status: "incomparable", before: null, after: afterSide, reason: null },
      ],
    };
    await expect(readComparison(later)).resolves.toEqual(later);
  });

  it("checks partial page sides against full result counts without requiring both sides on every page", async () => {
    const value = {
      ...comparison,
      total: 2,
      pageSize: 1,
      items: [{ status: "not_observed_again", before: beforeSide, after: null, reason: null }],
    };
    await expect(
      readFindingComparison(value, scope, beforeScope, { page: 1, pageSize: 1 }, "comparison"),
    ).resolves.toEqual(value);
    await expect(
      readFindingComparison(
        {
          ...value,
          page: 2,
          items: [{ status: "new", before: null, after: afterSide, reason: null }],
        },
        scope,
        beforeScope,
        { page: 2, pageSize: 1 },
        "comparison",
      ),
    ).resolves.toMatchObject({ page: 2 });
  });

  it("rejects incompatible snapshots of the same immutable result or job", async () => {
    const same: FindingComparisonResponse = {
      ...comparison,
      before: { ...context, dispositionDigest: "9".repeat(64) },
      compatible: false,
      reasons: ["same_result", "baseline_not_earlier"],
      total: 2,
      items: [
        { status: "incomparable", before: afterSide, after: null, reason: null },
        { status: "incomparable", before: null, after: afterSide, reason: null },
      ],
    };
    await expect(
      readFindingComparison(same, scope, scope, page, "comparison"),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    await expect(
      readFindingComparison(
        { ...comparison, before: { ...beforeContext, ...scope } },
        scope,
        scope,
        page,
        "comparison",
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("rejects page totals that cannot account for remaining comparison sides", async () => {
    const value: FindingComparisonResponse = {
      ...comparison,
      before: { ...beforeContext, findingCount: 3 },
      total: 3,
      pageSize: 2,
      items: [
        { status: "not_observed_again", before: beforeSide, after: null, reason: null },
        { status: "new", before: null, after: afterSide, reason: null },
      ],
    };
    await expect(
      readFindingComparison(value, scope, beforeScope, { page: 1, pageSize: 2 }, "comparison"),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
});
