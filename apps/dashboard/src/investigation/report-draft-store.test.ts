import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  acceptPreparedAction,
  actionDraftIsDirty,
  beginActionPreparation,
  createActionDraft,
  discardActionDraft,
} from "./action-draft-store";
import { activeGuardEntries } from "./navigation-guard-state";
import {
  createReportDraft,
  isReportDraftDirty,
  type PrivateReportDraft,
  reportDraftKey,
  reportDraftReducer,
  retainReportDraft,
} from "./report-draft-store";
import { selectionContext } from "./report-state";
import { createSampleInvestigationApi } from "./sample-adapter";

describe("private report feedback", () => {
  it("closes an unchanged action form without requiring a discard of report feedback", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const context = await api.actionContext(header.context.workItem.id, header.report.id);
    const feedback = reportDraftReducer(createReportDraft(selectionContext(context)), {
      type: "edit",
      draftId: "private-finding-draft",
      body: "Keep this finding feedback",
    });
    const scope = `report-action:${header.report.id}`;
    const entries = [
      { dirty: isReportDraftDirty(feedback) },
      { scope, dirty: actionDraftIsDirty(createActionDraft()) },
    ];
    expect(activeGuardEntries(entries, scope)).toEqual([]);
    expect(activeGuardEntries(entries)).toHaveLength(1);
    expect(feedback.current.editedBodies["private-finding-draft"]).toBe(
      "Keep this finding feedback",
    );
  });

  it("discards only the local action form while retaining report edits and an unknown submission", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const context = await api.actionContext(header.context.workItem.id, header.report.id);
    let feedback = reportDraftReducer(createReportDraft(selectionContext(context)), {
      type: "edit",
      draftId: "private-finding-draft",
      body: "Uncommitted finding feedback",
    });
    feedback = reportDraftReducer(feedback, {
      type: "selection",
      event: { type: "set-action", action: "request-changes" },
    });
    const beforeClose = feedback;
    const request = {
      workItemId: context.workItemId,
      action: "comment" as const,
      subjectRef: header.context.task.subjectRef,
      reportRef: context.reportRef,
      expectedRevisionKey: context.target.revisionKey,
      expectedHeadSha: context.target.headSha,
      idempotencyKey: "retained-request",
      payload: { kind: "feedback" as const, body: "Submitted content", findingIds: [], drafts: [] },
    };
    let action = acceptPreparedAction(beginActionPreparation(createActionDraft(), request), {
      ...request,
      schemaVersion: "InvestigationActionIntentV1",
      id: "retained-intent",
      version: 1,
      actorId: context.actor.id,
      repositoryId: context.repositoryId,
      payloadDigest: "d".repeat(64),
      state: "unknown",
      guards: [],
      createdAt: "2026-09-20T00:00:00.000Z",
      confirmedAt: null,
      result: null,
    });
    action = { ...action, fields: { ...action.fields, body: "Unsaved action form" } };
    const scope = `report-action:${header.report.id}`;
    const entries = [
      {
        dirty: isReportDraftDirty(feedback),
        onDiscard: () => {
          feedback = reportDraftReducer(feedback, { type: "discard" });
        },
      },
      {
        scope,
        dirty: actionDraftIsDirty(action),
        onDiscard: () => {
          action = discardActionDraft(action);
        },
      },
    ];
    expect(activeGuardEntries(entries)).toHaveLength(2);
    const local = activeGuardEntries(entries, scope);
    expect(local).toHaveLength(1);
    for (const entry of local) entry.onDiscard?.();
    expect(feedback).toBe(beforeClose);
    expect(isReportDraftDirty(feedback)).toBe(true);
    expect(feedback.current.selection.action).toBe("request-changes");
    expect(action.fields.body).toBe("");
    expect(action.intent?.id).toBe("retained-intent");
    expect(action.intent?.state).toBe("unknown");
    expect(action.prepareRequest?.idempotencyKey).toBe("retained-request");
  });

  it("retains saved selections, edited bodies, and a manual decision across navigation", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const context = await api.actionContext(header.context.workItem.id, header.report.id);
    let record = createReportDraft(selectionContext(context));
    record = reportDraftReducer(record, {
      type: "edit",
      draftId: "draft",
      body: "Private comment",
    });
    record = reportDraftReducer(record, {
      type: "selection",
      event: { type: "set-action", action: "approve" },
    });
    expect(isReportDraftDirty(record)).toBe(true);
    record = reportDraftReducer(record, { type: "save" });
    const client = new QueryClient();
    const key = reportDraftKey("account-a", header);
    retainReportDraft(client, key, record);
    const restored = client.getQueryData<PrivateReportDraft>(key)!;
    expect(restored.current.editedBodies.draft).toBe("Private comment");
    expect(restored.current.selection.action).toBe("approve");
    expect(restored.current.selection.explicitAction).toBe(true);
    expect(isReportDraftDirty(restored)).toBe(false);
    client.clear();
  });

  it("isolates account, report version, and digest and clears private data with session revocation", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const context = await api.actionContext(header.context.workItem.id, header.report.id);
    const client = new QueryClient();
    const key = reportDraftKey("account-a", header);
    retainReportDraft(client, key, createReportDraft(selectionContext(context)));
    expect(client.getQueryData(reportDraftKey("account-b", header))).toBeUndefined();
    expect(
      client.getQueryData(
        reportDraftKey("account-a", {
          ...header,
          report: { ...header.report, version: header.report.version + 1 },
        }),
      ),
    ).toBeUndefined();
    const changedDigest = `${header.report.logicalContentDigest[0] === "a" ? "b" : "a"}${header.report.logicalContentDigest.slice(1)}`;
    expect(
      client.getQueryData(
        reportDraftKey("account-a", {
          ...header,
          report: { ...header.report, logicalContentDigest: changedDigest },
        }),
      ),
    ).toBeUndefined();
    client.clear();
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it("discards only unsaved feedback and cannot erase a submitted server intent", async () => {
    const api = createSampleInvestigationApi();
    const header = await api.report("sample-pr-p1-report");
    const context = await api.actionContext(header.context.workItem.id, header.report.id);
    let record = createReportDraft(selectionContext(context));
    record = reportDraftReducer(record, { type: "edit", draftId: "draft", body: "Saved" });
    record = reportDraftReducer(record, { type: "save" });
    record = reportDraftReducer(record, { type: "edit", draftId: "draft", body: "Unsaved" });
    const client = new QueryClient();
    const intentKey = ["investigation-private-action", "account-a", header.report.id];
    client.setQueryData(intentKey, {
      id: "submitted-intent",
      state: "unknown",
      version: 3,
      payloadDigest: "digest",
    });
    retainReportDraft(
      client,
      reportDraftKey("account-a", header),
      reportDraftReducer(record, { type: "discard" }),
    );
    expect(
      client.getQueryData<PrivateReportDraft>(reportDraftKey("account-a", header))?.current
        .editedBodies.draft,
    ).toBe("Saved");
    expect(client.getQueryData(intentKey)).toEqual({
      id: "submitted-intent",
      state: "unknown",
      version: 3,
      payloadDigest: "digest",
    });
    client.clear();
  });
});
