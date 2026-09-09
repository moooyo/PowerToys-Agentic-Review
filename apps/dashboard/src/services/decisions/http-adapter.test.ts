import type { ReviewRunDecisionChangeRequest } from "@agentic-review/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewControlHttpError,
  ReviewControlNetworkError,
  ReviewControlProtocolError,
  ReviewControlRequestError,
} from "../review-control/errors";
import { DashboardHttpClient } from "../review-control/http-client";
import type { DecisionPageQuery } from "./adapter";
import {
  actor,
  context,
  event,
  history,
  input,
  jsonResponse,
  repositoryId,
  reviewRunId,
} from "./fixtures.testing";
import { HttpDecisionAdapter } from "./http-adapter";

const path = `/api/v1/operator/repositories/${repositoryId}/review-runs/${reviewRunId}/decisions`;
function adapterWith(value: unknown, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(value, status));
  return { adapter: new HttpDecisionAdapter({ fetch }), fetch };
}

describe("decision HTTP path and transport", () => {
  it("uses only canonical same-origin operator endpoints and leaves actor authentication to the server", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(context))
      .mockResolvedValueOnce(jsonResponse(history))
      .mockResolvedValueOnce(jsonResponse({ change: event, replayed: false }, 201));
    const adapter = new HttpDecisionAdapter({ fetch });
    expect(adapter.mode).toBe("connected");
    await expect(adapter.getContext(repositoryId, reviewRunId)).resolves.toEqual(context);
    await expect(adapter.listHistory(repositoryId, reviewRunId)).resolves.toEqual(history);
    await expect(adapter.change(repositoryId, reviewRunId, input, actor)).resolves.toEqual({
      change: event,
      replayed: false,
    });
    expect(fetch.mock.calls.map(([url, options]) => [url, options?.method, options?.body])).toEqual(
      [
        [path, "GET", undefined],
        [`${path}/history?page=1&pageSize=20`, "GET", undefined],
        [path, "POST", JSON.stringify(input)],
      ],
    );
    for (const [, options] of fetch.mock.calls)
      expect(options).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
  });

  it.each([
    `${path}?`,
    `${path}?page=1&pageSize=20`,
    `${path}/`,
    `${path}\n`,
    `${path}#section`,
    `${path}/history`,
    `${path}/history?`,
    `${path}/history?page=1`,
    `${path}/history?pageSize=20&page=1`,
    `${path}/history?page=01&pageSize=20`,
    `${path}/history?page=0&pageSize=20`,
    `${path}/history?page=1.0&pageSize=20`,
    `${path}/history?page=1&pageSize=21`,
    `${path}/history?page=1&pageSize=0`,
    `${path}/history?page=1&pageSize=020`,
    `${path}/history?page=1&pageSize=20&page=1`,
    `${path}/history?page=1&pageSize=20&actor=admin`,
    `${path}/history?page=9007199254740991&pageSize=20`,
    `${path}/history?page=1&pageSize=20\n`,
    path.replace(repositoryId, "repo%2Fother"),
    path.replace(reviewRunId, ".."),
    path.replace(reviewRunId, "run\\other"),
    `https://outside.example${path}`,
    `//outside.example${path}`,
  ])("blocks a noncanonical decision read before network: %s", async (unsafe) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(new DashboardHttpClient({ fetch }).get(unsafe, "read decision")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    `${path}/history`,
    `${path}/history?page=1&pageSize=20`,
    `${path}?`,
    `${path}?actor=admin`,
    `${path}/`,
    `${path}#fragment`,
    `${path}\n`,
  ])("blocks a noncanonical mutation before network: %s", async (unsafe) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.post(unsafe, "change decision", input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unadvertised PUT and PATCH methods", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new DashboardHttpClient({ fetch });
    await expect(client.put(path, "decision", input)).rejects.toThrow();
    await expect(client.patch(path, "decision", input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 429, 503])(
    "propagates HTTP %i without sample fallback or implicit mutation retries",
    async (status) => {
      const { adapter, fetch } = adapterWith(
        { code: "DECISION_REJECTED", message: "The decision is unavailable." },
        status,
      );
      await expect(adapter.getContext(repositoryId, reviewRunId)).rejects.toMatchObject({ status });
      await expect(adapter.listHistory(repositoryId, reviewRunId)).rejects.toBeInstanceOf(
        ReviewControlHttpError,
      );
      await expect(adapter.change(repositoryId, reviewRunId, input, actor)).rejects.toMatchObject({
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it("propagates network failure without changing adapters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline"));
    const adapter = new HttpDecisionAdapter({ fetch });
    await expect(adapter.getContext(repositoryId, reviewRunId)).rejects.toBeInstanceOf(
      ReviewControlNetworkError,
    );
    expect(adapter.mode).toBe("connected");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("decision input bounds", () => {
  it.each(["", "../other", "owner/repo", "a\n", "a\0", "a\\b", "a".repeat(129)])(
    "rejects malformed run and repository identity %j",
    async (id) => {
      const { adapter, fetch } = adapterWith(context);
      await expect(adapter.getContext(id, reviewRunId)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      await expect(adapter.listHistory(repositoryId, id)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      await expect(adapter.change(id, reviewRunId, input, actor)).rejects.toBeInstanceOf(
        ReviewControlRequestError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { page: 0 },
    { page: 1.5 },
    { page: Number.MAX_SAFE_INTEGER + 1 },
    { page: Number.MAX_SAFE_INTEGER, pageSize: 20 },
    { pageSize: 21 },
    { pageSize: 0 },
    { page: undefined },
    { actor: "admin" },
    null,
  ])("rejects malformed history page %j", async (query) => {
    const { adapter, fetch } = adapterWith(history);
    await expect(
      adapter.listHistory(repositoryId, reviewRunId, query as DecisionPageQuery),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "" },
    { reason: " \u00a0 " },
    { reason: "valid\0text" },
    { reason: "valid\u000btext" },
    { reason: "x\u0085y" },
    { reason: "valid\u007f" },
    { reason: "x\ud800" },
    { reason: "x".repeat(2049) },
    { expectedVersion: Number.MAX_SAFE_INTEGER },
    { expectedVersion: -1 },
    { expectedVersion: 0.5 },
    { expectedRevisionKey: `${"a".repeat(64)}\n` },
    { expectedPlanDigest: "A".repeat(64) },
    { expectedResultSetDigest: "main" },
    { action: "merge" },
    { targetDecisionId: null },
    { actor },
    { publishToGitHub: true },
  ])("rejects invalid or side-effect-bearing intent %j", async (mutation) => {
    const { adapter, fetch } = adapterWith({ change: event, replayed: false });
    await expect(
      adapter.change(
        repositoryId,
        reviewRunId,
        { ...input, ...mutation } as ReviewRunDecisionChangeRequest,
        actor,
      ),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { issuer: " x" },
    { subject: "x\n" },
    { subject: "x\u0085" },
    { subject: "x\ud800" },
    { subject: "" },
    { role: "admin" },
  ])("rejects invalid expected actor %j", async (change) => {
    const { adapter, fetch } = adapterWith({ change: event, replayed: false });
    await expect(
      adapter.change(repositoryId, reviewRunId, input, { ...actor, ...change }),
    ).rejects.toBeInstanceOf(ReviewControlRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes reason without mutating the caller and captures actor and intent across await", async () => {
    const request = { ...input, reason: `  ${input.reason}  ` };
    const expectedActor = { ...actor };
    let resolve: ((value: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    const adapter = new HttpDecisionAdapter({ fetch });
    const pending = adapter.change(repositoryId, reviewRunId, request, expectedActor);
    expect(request.reason).toBe(`  ${input.reason}  `);
    request.reason = "Changed while pending";
    expectedActor.subject = "Someone-Else";
    resolve?.(jsonResponse({ change: event, replayed: false }));
    await expect(pending).resolves.toMatchObject({ change: { reason: input.reason, actor } });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
  });
});

describe("canonical decision paragraphs and compact policy", () => {
  it("retains ordinary paragraphs and tabs in the canonical decision reason", async () => {
    const reason = "First observation.\n\nSecond observation.\r\n\tEvidence checked.";
    const { adapter, fetch } = adapterWith({ change: { ...event, reason }, replayed: false });
    await expect(
      adapter.change(repositoryId, reviewRunId, { ...input, reason: `\n ${reason} \n` }, actor),
    ).resolves.toMatchObject({ change: { reason } });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).reason).toBe(reason);
  });

  it("rejects malformed compact policy count and truncation claims", async () => {
    for (const policyAtDecision of [
      { ...event.policyAtDecision, eligible: false, reasonCount: 1, reasonCodes: ["one", "two"] },
      {
        ...event.policyAtDecision,
        eligible: false,
        reasonCount: 300,
        reasonCodes: ["one"],
        reasonCodesTruncated: true,
      },
      {
        ...event.policyAtDecision,
        eligible: false,
        reasonCount: 128,
        reasonCodes: Array.from({ length: 128 }, (_, index) => `reason_${index}`),
        reasonCodesTruncated: true,
      },
      { ...event.policyAtDecision, eligible: false, reasonCount: 2, reasonCodes: ["one", "one"] },
    ])
      await expect(
        adapterWith({
          ...history,
          items: [{ ...event, action: "request_changes", policyAtDecision }],
        }).adapter.listHistory(repositoryId, reviewRunId),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
});

describe("decision context semantic boundary", () => {
  it.each([
    { repositoryId: "other" },
    { reviewRunId: "other" },
    { workItemId: "other" },
    { workItemKind: "issue" },
    { canApprove: false },
    { sourceCurrent: false },
    { currentRevisionKey: "d".repeat(64) },
    { revisionKey: "d".repeat(64) },
    { planDigest: "d".repeat(64) },
    { resultSetDigest: "d".repeat(64) },
    { version: 0 },
    { version: 1.5 },
    { recordedDecisionState: "stale" },
    { stateReasons: ["result_set_changed"] },
    { recordedDecision: null },
    { policy: { ...context.policy, applicable: false, eligible: null } },
    { policy: { ...context.policy, eligible: true, blockingFindingCount: 1 } },
    { policy: { ...context.policy, reasonCount: 1 } },
    { policy: { ...context.policy, reasonsTruncated: true } },
    { unexpected: true },
  ])("rejects inconsistent context %j", async (mutation) => {
    const { adapter } = adapterWith({ ...context, ...mutation });
    await expect(adapter.getContext(repositoryId, reviewRunId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it.each([
    { repositoryId: "other" },
    { reviewRunId: "other" },
    { workItemId: "other" },
    { revisionKey: "d".repeat(64) },
    { planDigest: "d".repeat(64) },
    { previousVersion: 1 },
    { version: 2, previousVersion: 1 },
    { action: "comment" },
    { targetDecisionId: "target" },
    { supersedesDecisionId: "decision-one" },
    { supersedesDecisionId: "other" },
    { createdAt: "2026-02-30T10:00:00.000Z" },
    { createdAt: "2026-09-07T25:00:00.000Z" },
    { reason: "reason\u000bcontinued" },
    { reason: " leading" },
    { actor: { ...actor, subject: "other\ud800" } },
    { policyAtDecision: { ...event.policyAtDecision, eligible: false } },
    {
      policyAtDecision: {
        ...event.policyAtDecision,
        reasonCount: 1,
        reasonCodes: ["blocked"],
        eligible: true,
      },
    },
  ])("rejects inconsistent recorded event %j", async (mutation) => {
    const { adapter } = adapterWith({ ...context, recordedDecision: { ...event, ...mutation } });
    await expect(adapter.getContext(repositoryId, reviewRunId)).rejects.toBeInstanceOf(
      ReviewControlProtocolError,
    );
  });

  it("keeps comment-only and later-comment versions distinct from the recorded decision", async () => {
    for (const value of [
      { ...context, version: 4 },
      { ...context, version: 4, recordedDecision: null, recordedDecisionState: "none" },
      { ...context, version: 0, recordedDecision: null, recordedDecisionState: "none" },
    ])
      await expect(
        adapterWith(value).adapter.getContext(repositoryId, reviewRunId),
      ).resolves.toEqual(value);
  });

  it("accepts A-to-B-to-A source invalidation and returns all stale reasons", async () => {
    const value = {
      ...context,
      sourceCurrent: false,
      canApprove: false,
      resultSetDigest: "d".repeat(64),
      policy: {
        ...context.policy,
        eligible: false,
        reasonCount: 1,
        reasons: [{ code: "check_failed" }],
      },
      recordedDecisionState: "stale",
      stateReasons: ["source_not_current", "approval_policy_not_satisfied", "result_set_changed"],
    };
    await expect(adapterWith(value).adapter.getContext(repositoryId, reviewRunId)).resolves.toEqual(
      value,
    );
  });

  it("distinguishes ineligible approval from an explicit override without changing policy", async () => {
    const base = {
      ...context,
      canApprove: false,
      policy: {
        ...context.policy,
        eligible: false,
        reasonCount: 1,
        reasons: [{ code: "evidence_missing", reason: "One evidence file\nis unavailable." }],
      },
    };
    await expect(
      adapterWith({
        ...base,
        recordedDecisionState: "ineligible",
        stateReasons: ["approval_policy_not_satisfied"],
      }).adapter.getContext(repositoryId, reviewRunId),
    ).resolves.toMatchObject({ recordedDecisionState: "ineligible" });
    await expect(
      adapterWith({
        ...base,
        recordedDecision: { ...event, action: "override_approve" },
      }).adapter.getContext(repositoryId, reviewRunId),
    ).resolves.toMatchObject({ recordedDecisionState: "current", canApprove: false });
  });

  it("allows a withdrawal tombstone to survive newer results and noncurrent source", async () => {
    const value = {
      ...context,
      version: 2,
      sourceCurrent: false,
      canApprove: false,
      resultSetDigest: "d".repeat(64),
      recordedDecisionState: "withdrawn",
      recordedDecision: {
        ...event,
        id: "withdrawal-two",
        action: "withdraw",
        previousVersion: 1,
        version: 2,
        targetDecisionId: event.id,
        supersedesDecisionId: event.id,
      },
    };
    await expect(adapterWith(value).adapter.getContext(repositoryId, reviewRunId)).resolves.toEqual(
      value,
    );
  });

  it("accepts Issue request-changes while denying approval semantics", async () => {
    const value = {
      ...context,
      workItemKind: "issue",
      canApprove: false,
      policy: { ...context.policy, applicable: false, eligible: null },
      recordedDecision: {
        ...event,
        workItemKind: "issue",
        action: "request_changes",
        policyAtDecision: { ...event.policyAtDecision, applicable: false, eligible: null },
      },
    };
    await expect(adapterWith(value).adapter.getContext(repositoryId, reviewRunId)).resolves.toEqual(
      value,
    );
  });
});

describe("decision history and immutable receipts", () => {
  it.each([
    { repositoryId: "other" },
    { reviewRunId: "other" },
    { page: 2 },
    { pageSize: 19 },
    { total: 2 },
    { items: [] },
    { total: 0 },
    { items: [{ ...event, version: 2, previousVersion: 1 }] },
    { items: [{ ...event, repositoryId: "other" }] },
  ])("rejects mismatched page or history scope %j", async (mutation) => {
    await expect(
      adapterWith({ ...history, ...mutation }).adapter.listHistory(repositoryId, reviewRunId),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("requires all-event descending contiguous versions and one immutable run identity", async () => {
    const second = {
      ...event,
      id: "decision-two",
      changeId: "change-two",
      previousVersion: 1,
      version: 2,
      action: "comment",
    };
    const valid = { ...history, total: 2, items: [second, event] };
    await expect(
      adapterWith(valid).adapter.listHistory(repositoryId, reviewRunId),
    ).resolves.toEqual(valid);
    for (const items of [
      [event, second],
      [{ ...second, id: event.id }, event],
      [{ ...second, changeId: event.changeId }, event],
      [second, { ...event, workItemId: "other" }],
      [second, { ...event, planDigest: "d".repeat(64) }],
    ]) {
      await expect(
        adapterWith({ ...valid, items }).adapter.listHistory(repositoryId, reviewRunId),
      ).rejects.toBeInstanceOf(ReviewControlProtocolError);
    }
    await expect(
      adapterWith({ ...history, page: 3, pageSize: 1, total: 2, items: [] }).adapter.listHistory(
        repositoryId,
        reviewRunId,
        { page: 3, pageSize: 1 },
      ),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      adapterWith({ ...history, page: 2, pageSize: 1, total: 2 }).adapter.listHistory(
        repositoryId,
        reviewRunId,
        { page: 2, pageSize: 1 },
      ),
    ).resolves.toMatchObject({ items: [event] });
  });

  it("accepts deduplicated and truncated reason code summaries", async () => {
    for (const policyAtDecision of [
      { ...event.policyAtDecision, eligible: false, reasonCount: 3, reasonCodes: ["check_failed"] },
      {
        ...event.policyAtDecision,
        eligible: false,
        reasonCount: 300,
        reasonCodes: Array.from({ length: 128 }, (_, index) => `check_failed_${index}`),
        reasonCodesTruncated: true,
      },
    ]) {
      const value = {
        ...history,
        items: [{ ...event, action: "request_changes", policyAtDecision }],
      };
      await expect(
        adapterWith(value).adapter.listHistory(repositoryId, reviewRunId),
      ).resolves.toEqual(value);
    }
  });

  it.each([
    { repositoryId: "other" },
    { reviewRunId: "other" },
    { changeId: "other" },
    { actor: { ...actor, subject: "operator-a" } },
    { actor: { ...actor, issuer: actor.issuer.toLowerCase() } },
    { action: "request_changes" },
    { reason: "Another intent" },
    { revisionKey: "d".repeat(64) },
    { planDigest: "d".repeat(64) },
    { resultSetDigest: "d".repeat(64) },
    { previousVersion: 1, version: 2 },
    { targetDecisionId: "decision-one" },
  ])("rejects a receipt for another intent or actor %j", async (mutation) => {
    await expect(
      adapterWith({ change: { ...event, ...mutation }, replayed: true }).adapter.change(
        repositoryId,
        reviewRunId,
        input,
        actor,
      ),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });

  it("accepts historical replay without replacing it with live context", async () => {
    const { adapter, fetch } = adapterWith({ change: event, replayed: true });
    await expect(adapter.change(repositoryId, reviewRunId, input, actor)).resolves.toEqual({
      change: event,
      replayed: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("matches withdrawal targets exactly", async () => {
    const request = {
      ...input,
      changeId: "withdraw-two",
      action: "withdraw",
      expectedVersion: 1,
      targetDecisionId: event.id,
    } as const;
    const withdrawal = {
      ...event,
      id: "withdrawal-two",
      changeId: request.changeId,
      action: "withdraw",
      previousVersion: 1,
      version: 2,
      targetDecisionId: event.id,
      supersedesDecisionId: event.id,
    };
    await expect(
      adapterWith({ change: withdrawal, replayed: false }).adapter.change(
        repositoryId,
        reviewRunId,
        request,
        actor,
      ),
    ).resolves.toMatchObject({ change: withdrawal });
    await expect(
      adapterWith({
        change: { ...withdrawal, targetDecisionId: "another", supersedesDecisionId: "another" },
        replayed: false,
      }).adapter.change(repositoryId, reviewRunId, request, actor),
    ).rejects.toBeInstanceOf(ReviewControlProtocolError);
  });
});
