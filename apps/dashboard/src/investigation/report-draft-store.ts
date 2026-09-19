import type {
  InvestigationActionKind,
  InvestigationReportHeaderV1,
} from "@agentic-review/contracts";
import type { QueryClient } from "@tanstack/react-query";
import {
  createFeedbackSelection,
  type FeedbackSelectionContext,
  type FeedbackSelectionEvent,
  type FeedbackSelectionState,
  feedbackSelectionReducer,
} from "./feedback-selection";

export interface ReportFeedbackDraft {
  selection: FeedbackSelectionState<InvestigationActionKind>;
  editedBodies: Record<string, string>;
}

export interface PrivateReportDraft {
  current: ReportFeedbackDraft;
  saved: ReportFeedbackDraft;
}

export function reportDraftKey(identity: string, header: InvestigationReportHeaderV1) {
  return [
    "investigation-private-report-draft",
    identity,
    header.report.id,
    header.report.version,
    header.report.logicalContentDigest,
  ] as const;
}

export function createReportDraft(
  context: FeedbackSelectionContext<InvestigationActionKind>,
): PrivateReportDraft {
  const draft = { selection: createFeedbackSelection(context), editedBodies: {} };
  return { current: draft, saved: draft };
}

export type ReportDraftEvent =
  | { type: "selection"; event: FeedbackSelectionEvent<InvestigationActionKind> }
  | { type: "edit"; draftId: string; body: string }
  | { type: "save" }
  | { type: "discard" };

export function reportDraftReducer(
  record: PrivateReportDraft,
  event: ReportDraftEvent,
): PrivateReportDraft {
  switch (event.type) {
    case "selection": {
      const current = {
        ...record.current,
        selection: feedbackSelectionReducer(record.current.selection, event.event),
      };
      // Server refreshes update both baselines. Availability changes are not private edits.
      return event.event.type === "refresh"
        ? {
            current,
            saved: {
              ...record.saved,
              selection: feedbackSelectionReducer(record.saved.selection, event.event),
            },
          }
        : { ...record, current };
    }
    case "edit":
      return {
        ...record,
        current: {
          ...record.current,
          editedBodies: { ...record.current.editedBodies, [event.draftId]: event.body },
        },
      };
    case "save":
      return { current: record.current, saved: record.current };
    case "discard":
      return { current: record.saved, saved: record.saved };
  }
}

export function isReportDraftDirty(record: PrivateReportDraft): boolean {
  return JSON.stringify(record.current) !== JSON.stringify(record.saved);
}

export function retainReportDraft(
  client: QueryClient,
  key: ReturnType<typeof reportDraftKey>,
  draft: PrivateReportDraft,
): void {
  // In-memory query data is cleared by the session provider on logout, expiry, or grant changes.
  // Never use persistent browser storage for private feedback or sealed report evidence.
  client.setQueryDefaults(key, { gcTime: Infinity });
  client.setQueryData(key, draft);
}
