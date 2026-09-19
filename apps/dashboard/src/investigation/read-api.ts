import {
  InvestigationMediaPublicationSchema,
  InvestigationOutputPageSchema,
  type InvestigationOutputQuery,
  InvestigationPublicationDirectoryPageSchema,
  type InvestigationPublicationDirectoryQuery,
  InvestigationReportDirectoryPageSchema,
  type InvestigationReportDirectoryQuery,
  InvestigationTaskArtifactsPageSchema,
  type InvestigationTaskArtifactsQuery,
  InvestigationTaskDefaultsSchema,
  type InvestigationWorkItemDiscussionQuery,
  InvestigationWorkItemDiscussionSchema,
  type InvestigationWorkspaceSearchQuery,
  InvestigationWorkspaceSearchResultSchema,
} from "@agentic-review/contracts";
import { type InvestigationTransport, queryString } from "./transport";

export type {
  InvestigationMediaPublication,
  InvestigationOutputEvent,
  InvestigationOutputPage,
  InvestigationOutputQuery,
  InvestigationPublicationDirectoryPage,
  InvestigationPublicationDirectoryQuery,
  InvestigationReportDirectoryPage,
  InvestigationReportDirectoryQuery,
  InvestigationTaskArtifactsPage,
  InvestigationTaskArtifactsQuery,
  InvestigationTaskDefaults,
  InvestigationWorkItemDiscussion,
  InvestigationWorkItemDiscussionQuery,
  InvestigationWorkspaceSearchQuery,
  InvestigationWorkspaceSearchResult,
} from "@agentic-review/contracts";

function requireReadBinding(valid: boolean): asserts valid {
  if (!valid) {
    throw new Error(
      "The investigation service returned an invalid structured response for the selected resource.",
    );
  }
}

/** Production readers use only authenticated HTTP responses; unavailable routes remain errors. */
export function createInvestigationReadApi(transport: InvestigationTransport) {
  const publications = (query: InvestigationPublicationDirectoryQuery = {}, signal?: AbortSignal) =>
    transport(
      `/api/publications${queryString(query)}`,
      InvestigationPublicationDirectoryPageSchema,
      { signal },
    );
  const workItemSnapshot = async (
    id: string,
    query: InvestigationWorkItemDiscussionQuery = {},
    signal?: AbortSignal,
  ) => {
    const revisionKey = query.revisionKey;
    const value = await transport(
      `/api/work-items/${encodeURIComponent(id)}/discussion${queryString(query)}`,
      InvestigationWorkItemDiscussionSchema,
      { signal },
    );
    requireReadBinding(
      value.workItemId === id &&
        (revisionKey === undefined || value.revisionKey === revisionKey) &&
        (value.availability === "available"
          ? value.inputSnapshot !== null &&
            value.snapshotRef !== null &&
            value.inputSnapshot.workItemId === id &&
            value.inputSnapshot.repositoryId === value.repositoryId &&
            value.inputSnapshot.subjectRevisionKey === value.revisionKey
          : value.inputSnapshot === null && value.snapshotRef === null),
    );
    return value;
  };

  return {
    taskDefaults: (signal?: AbortSignal) =>
      transport("/api/investigation/task-defaults", InvestigationTaskDefaultsSchema, { signal }),
    async taskOutput(id: string, query: InvestigationOutputQuery, signal?: AbortSignal) {
      const attemptId = query.attemptId;
      const page = await transport(
        `/api/tasks/${encodeURIComponent(id)}/output-events${queryString(query)}`,
        InvestigationOutputPageSchema,
        { signal },
      );
      requireReadBinding(
        page.taskId === id &&
          page.attemptId === attemptId &&
          page.items.every((event) => event.taskId === id && event.attemptId === attemptId),
      );
      return page;
    },
    async taskArtifacts(
      id: string,
      query: InvestigationTaskArtifactsQuery = {},
      signal?: AbortSignal,
    ) {
      const attemptId = query.attemptId;
      const page = await transport(
        `/api/tasks/${encodeURIComponent(id)}/artifacts${queryString(query)}`,
        InvestigationTaskArtifactsPageSchema,
        { signal },
      );
      requireReadBinding(
        page.taskId === id &&
          page.items.every(
            ({ artifact }) =>
              artifact.taskId === id &&
              (attemptId === undefined || artifact.attemptId === attemptId),
          ),
      );
      return page;
    },
    reports: (query: InvestigationReportDirectoryQuery = {}, signal?: AbortSignal) =>
      transport(`/api/reports${queryString(query)}`, InvestigationReportDirectoryPageSchema, {
        signal,
      }),
    publications,
    publicationDirectory: publications,
    workItemSnapshot,
    workItemDiscussion: workItemSnapshot,
    workspaceSearch: (query: InvestigationWorkspaceSearchQuery, signal?: AbortSignal) =>
      transport(
        `/api/workspace/search${queryString(query)}`,
        InvestigationWorkspaceSearchResultSchema,
        { signal },
      ),
    async reportMediaPublication(id: string, signal?: AbortSignal) {
      const value = await transport(
        `/api/reports/${encodeURIComponent(id)}/media-publication`,
        InvestigationMediaPublicationSchema,
        { signal },
      );
      requireReadBinding(value.reportId === id);
      return value;
    },
  };
}

export type InvestigationReadApi = ReturnType<typeof createInvestigationReadApi>;
