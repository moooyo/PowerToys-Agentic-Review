import type {
  InvestigationActionIntentV1,
  InvestigationCreateActionIntentRequest,
} from "@agentic-review/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  acceptPreparedAction,
  actionDraftIsDirty,
  actionDraftKey,
  actionDraftLease,
  beginActionConfirmation,
  beginActionPreparation,
  createActionDraft,
  discardActionDraft,
  hasUnresolvedActionPreparation,
  hasUnresolvedActionSubmission,
  inspectActionIntent,
  retainActionIntent,
  saveActionDraft,
  switchActionDraft,
} from "./action-draft-store";

const reportRef = { id: "report-1", version: 2, digest: "a".repeat(64) };
function request(key = "request-1"): InvestigationCreateActionIntentRequest {
  return {
    idempotencyKey: key,
    workItemId: "work-1",
    action: "comment",
    subjectRef: "subject-1",
    expectedRevisionKey: "b".repeat(64),
    expectedHeadSha: "c".repeat(40),
    reportRef: { ...reportRef },
    payload: { kind: "feedback", body: "Exact original body", findingIds: [], drafts: [] },
  };
}
function intent(input = request()): InvestigationActionIntentV1 {
  return {
    ...input,
    schemaVersion: "InvestigationActionIntentV1",
    id: "intent-1",
    version: 1,
    repositoryId: "repository-1",
    actorId: "actor-1",
    payloadDigest: "d".repeat(64),
    state: "prepared",
    guards: [],
    createdAt: "2026-09-20T00:00:00Z",
    confirmedAt: null,
    result: null,
  };
}

describe("private action drafts", () => {
  it("keeps selection, summary and execution fields independent for each action", () => {
    let record = switchActionDraft(createActionDraft(), "request-changes");
    record = {
      ...record,
      fields: { ...record.fields, body: "Request changes summary" },
      publication: { ...record.publication, selectedFindingIds: ["finding-1"] },
    };
    record = saveActionDraft(record);
    record = switchActionDraft(record, "approve");
    expect(record.fields.body).toBe("");
    expect(record.publication.selectedFindingIds).toEqual([]);
    record = saveActionDraft(record);
    record = switchActionDraft(record, "trigger-ci");
    record = {
      ...record,
      fields: { ...record.fields, workflowId: "checks.yml", workflowRef: "reviewed-head" },
    };
    record = switchActionDraft(record, "request-changes");
    expect(record.fields.body).toBe("Request changes summary");
    expect(record.fields.workflowId).toBe("");
    expect(record.publication.selectedFindingIds).toEqual(["finding-1"]);
    expect(actionDraftIsDirty(record)).toBe(true);
    record = discardActionDraft(record);
    record = switchActionDraft(record, "trigger-ci");
    expect(record.fields.workflowId).toBe("");
    expect(record.publication.selectedFindingIds).toEqual([]);
    expect(actionDraftIsDirty(record)).toBe(false);
  });

  it("does not partition unresolved submission identities when the form action changes", () => {
    const pending = beginActionPreparation(
      switchActionDraft(createActionDraft(), "comment"),
      request(),
    );
    const otherForm = switchActionDraft(pending, "approve");
    expect(otherForm.prepareRequest).toBe(pending.prepareRequest);
    expect(beginActionPreparation(otherForm, request("another-key")).prepareRequest).toBe(
      pending.prepareRequest,
    );
    const prepared = acceptPreparedAction(otherForm, intent());
    const unknown = retainActionIntent(prepared, { ...intent(), version: 2, state: "unknown" });
    const thirdForm = switchActionDraft(unknown, "merge");
    expect(() => beginActionPreparation(thirdForm, request("third-key"))).toThrow(
      "Check the saved submission",
    );
    expect(discardActionDraft(thirdForm).intent?.id).toBe("intent-1");
  });

  it("retains an independent receipt snapshot while preparing another action", () => {
    const prepared = acceptPreparedAction(
      beginActionPreparation(createActionDraft(), request()),
      intent(),
    );
    const receipt = {
      ...intent(),
      version: 2,
      state: "succeeded" as const,
      result: { message: "Recorded", externalId: "review-42", taskId: null },
    };
    const complete = retainActionIntent(prepared, receipt);
    if (receipt.payload.kind === "feedback") receipt.payload.body = "Caller mutation";
    const next = beginActionPreparation(complete, request("next-key"));
    expect(next.intent).toBeNull();
    expect(next.receipts).toHaveLength(1);
    expect(next.receipts[0]?.payload).toMatchObject({ body: "Exact original body" });
    expect(next.receipts[0]?.result?.externalId).toBe("review-42");
  });
  it("separates accounts, grants, repositories, work items, and exact report versions", () => {
    const key = actionDraftKey("actor-1:execute", "repository-1", "work-1", reportRef);
    const different = [
      actionDraftKey("actor-2:execute", "repository-1", "work-1", reportRef),
      actionDraftKey("actor-1:read", "repository-1", "work-1", reportRef),
      actionDraftKey("actor-1:execute", "repository-2", "work-1", reportRef),
      actionDraftKey("actor-1:execute", "repository-1", "work-2", reportRef),
      actionDraftKey("actor-1:execute", "repository-1", "work-1", { ...reportRef, version: 3 }),
      actionDraftKey("actor-1:execute", "repository-1", "work-1", {
        ...reportRef,
        digest: "e".repeat(64),
      }),
    ];
    for (const candidate of different) expect(candidate).not.toEqual(key);
  });

  it("does not let a late response recreate a cleared session cache", () => {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const key = actionDraftKey("actor-1", "repository-1", "work-1", reportRef);
    client.setQueryData(key, createActionDraft());
    const lease = actionDraftLease(client, key);
    expect(lease.isCurrent()).toBe(true);
    client.clear();
    expect(lease.update((record) => ({ ...record, intent: intent() }))).toBe(false);
    expect(client.getQueryData(key)).toBeUndefined();
    client.setQueryData(key, createActionDraft());
    expect(lease.isCurrent()).toBe(false);
    expect(lease.update((record) => ({ ...record, intent: intent() }))).toBe(false);
    client.clear();
  });

  it("reuses the frozen preparation request after response loss despite later form edits", () => {
    const input = request();
    const pending = beginActionPreparation(createActionDraft(), input);
    if (input.payload.kind !== "feedback") throw new Error("Expected feedback fixture.");
    input.payload.body = "Mutated caller data";
    input.reportRef!.version = 99;
    expect(pending.prepareRequest?.payload).toMatchObject({ body: "Exact original body" });
    expect(pending.prepareRequest?.reportRef?.version).toBe(2);
    const edited = { ...pending, fields: { ...pending.fields, body: "Later form edit" } };
    const retry = beginActionPreparation(edited, request("different-request"));
    expect(retry.prepareRequest).toBe(pending.prepareRequest);
    expect(retry.prepareRequest?.idempotencyKey).toBe("request-1");
    expect(hasUnresolvedActionSubmission(retry)).toBe(true);
  });

  it("discards only form edits while retaining uncertain preparation and confirmation identities", () => {
    let record = createActionDraft();
    record = saveActionDraft({ ...record, fields: { ...record.fields, body: "Saved draft" } });
    record = beginActionPreparation(
      { ...record, fields: { ...record.fields, body: "Unsaved edit" } },
      request(),
    );
    expect(actionDraftIsDirty(record)).toBe(true);
    const discardedRequest = discardActionDraft(record);
    expect(discardedRequest.fields.body).toBe("Saved draft");
    expect(discardedRequest.prepareRequest).toBe(record.prepareRequest);
    expect(hasUnresolvedActionSubmission(discardedRequest)).toBe(true);
    const prepared = acceptPreparedAction(record, intent());
    const discardedIntent = discardActionDraft({ ...prepared, confirmationUncertain: true });
    expect(discardedIntent.intent?.id).toBe("intent-1");
    expect(discardedIntent.confirmationUncertain).toBe(true);
    expect(actionDraftIsDirty(discardedIntent)).toBe(false);
  });

  it("requires reconciliation before a new operation and permits a new attempt after completion", () => {
    const prepared = acceptPreparedAction(
      beginActionPreparation(createActionDraft(), request()),
      intent(),
    );
    for (const state of ["confirmed", "executing", "unknown"] as const) {
      const unresolved = { ...prepared, intent: { ...intent(), state } };
      expect(() => beginActionPreparation(unresolved, request("new-request"))).toThrow(
        "Check the saved submission",
      );
    }
    const completed = retainActionIntent(prepared, { ...intent(), version: 2, state: "succeeded" });
    const next = beginActionPreparation(completed, request("new-request"));
    expect(next.prepareRequest?.idempotencyKey).toBe("new-request");
    expect(next.intent).toBeNull();
  });

  it("rejects a response with another request identity and an older or reassigned intent", () => {
    const pending = beginActionPreparation(createActionDraft(), request());
    expect(() => acceptPreparedAction(pending, intent(request("different-request")))).toThrow(
      "does not match",
    );
    const prepared = acceptPreparedAction(pending, { ...intent(), version: 2 });
    expect(() => retainActionIntent(prepared, intent())).toThrow("does not match");
    expect(() =>
      retainActionIntent(prepared, { ...intent(), version: 3, repositoryId: "other-repository" }),
    ).toThrow("does not match");
  });

  it("inspects a different pending intent without reviving an already resolved preparation", () => {
    const prepared = acceptPreparedAction(
      beginActionPreparation(createActionDraft(), request()),
      intent(),
    );
    const pending = { ...intent(request("request-2")), id: "intent-2", state: "unknown" as const };
    const inspected = inspectActionIntent(prepared, pending);
    expect(inspected.prepareRequest?.idempotencyKey).toBe("request-1");
    expect(inspected.intent?.id).toBe("intent-2");
    expect(hasUnresolvedActionPreparation(inspected)).toBe(false);
    expect(hasUnresolvedActionSubmission(inspected)).toBe(true);
    expect(() =>
      inspectActionIntent({ ...prepared, confirmationUncertain: true }, pending),
    ).toThrow("Resolve the saved request");
  });

  it("retains confirmation uncertainty and prevents duplicate or stale confirmation", () => {
    const prepared = acceptPreparedAction(
      beginActionPreparation(createActionDraft(), request()),
      intent(),
    );
    const confirming = beginActionConfirmation(prepared, intent());
    expect(confirming.confirmationUncertain).toBe(true);
    expect(acceptPreparedAction(confirming, intent()).confirmationUncertain).toBe(true);
    expect(() => beginActionConfirmation(confirming, intent())).toThrow("saved preview changed");
    expect(() => beginActionConfirmation(prepared, { ...intent(), version: 2 })).toThrow(
      "saved preview changed",
    );
    expect(() =>
      beginActionConfirmation({ ...prepared, contextRefreshRequired: true }, intent()),
    ).toThrow("saved preview changed");
    expect(() => beginActionPreparation(confirming, request("another-request"))).toThrow(
      "Check the saved submission",
    );
    const refreshed = retainActionIntent(confirming, intent());
    expect(beginActionConfirmation(refreshed, intent()).confirmationUncertain).toBe(true);
    expect(refreshed.intent?.idempotencyKey).toBe("request-1");
  });

  it("requires a successful context refresh after a rejected stale preparation", () => {
    const pending = beginActionPreparation(createActionDraft(), request());
    const rejected = { ...pending, preparationRejected: true, contextRefreshRequired: true };
    expect(hasUnresolvedActionSubmission(rejected)).toBe(false);
    expect(discardActionDraft(rejected).contextRefreshRequired).toBe(true);
    expect(() => beginActionPreparation(rejected, request("replacement-request"))).toThrow(
      "Refresh the action context",
    );
    const refreshed = { ...rejected, contextRefreshRequired: false };
    expect(
      beginActionPreparation(refreshed, request("replacement-request")).prepareRequest
        ?.idempotencyKey,
    ).toBe("replacement-request");
  });
});
