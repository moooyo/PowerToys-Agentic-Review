import { createHash } from "node:crypto";
import type {
  FindingComparisonResponse,
  FindingComparisonSide,
  FindingDispositionChangeRequest,
  FindingDispositionEvent,
  FindingDispositionHistoryResponse,
  FindingListResponse,
  FindingOccurrence,
  FindingOccurrenceRef,
  FindingResultContext,
  OperatorPrincipal,
} from "@agentic-review/contracts";
import type { FindingScope } from "./adapter";

export const scope: FindingScope = {
  repositoryId: "repository-one",
  reviewRunId: "run-two",
  requestId: "request-two",
  jobId: "job-two",
};
export const beforeScope: FindingScope = {
  ...scope,
  reviewRunId: "run-one",
  requestId: "request-one",
  jobId: "job-one",
};
export const actor: OperatorPrincipal = {
  issuer: "https://Identity.example/Issuer",
  subject: "Operator-A",
};

export function makeRef(
  overrides: Partial<Omit<FindingOccurrenceRef, "key">> = {},
): FindingOccurrenceRef {
  const ref = {
    resultId: "result-two",
    resultDigest: "a".repeat(64),
    kind: "pr_finding" as const,
    ordinal: 0,
    ...overrides,
  };
  const content = { schemaVersion: "FindingOccurrenceV1", ...ref };
  const canonical = `{${Object.keys(content)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(content[key as keyof typeof content])}`)
    .join(",")}}`;
  return { ...ref, key: createHash("sha256").update(canonical).digest("hex") };
}

export const ref = makeRef();
export const context: FindingResultContext = {
  ...scope,
  workItemId: "work-item-one",
  workItemKind: "pull_request",
  resultId: ref.resultId,
  resultDigest: ref.resultDigest,
  revisionKey: "b".repeat(64),
  planDigest: "c".repeat(64),
  profileVersionId: "profile-version-one",
  promptVersionId: "prompt-version-one",
  workflowKind: "pr_static_build",
  target: "headless",
  activationNumber: 1,
  createdAt: "2026-09-07T10:00:00.000Z",
  contextDigest: "d".repeat(64),
  sourceCurrent: true,
  latestForRequest: true,
  historical: false,
  modelAvailability: "complete",
  findingCount: 1,
  dispositionDigest: "e".repeat(64),
};
export const occurrence: FindingOccurrence = {
  ...ref,
  modelId: "model-id-one",
  title: "Handle the empty input",
  body: "The missing guard throws on the documented empty input.",
  priority: 1,
  path: "src/input.ts",
  line: 10,
  endLine: 12,
  confidence: 0.92,
  disposition: { state: "open", version: 0, lastEventId: null, updatedAt: null, updatedBy: null },
};
export const list: FindingListResponse = {
  context,
  items: [occurrence],
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
export const input: FindingDispositionChangeRequest = {
  changeId: "change-one",
  expectedVersion: 0,
  expectedResultDigest: ref.resultDigest,
  expectedContextDigest: context.contextDigest,
  kind: ref.kind,
  ordinal: ref.ordinal,
  action: "accept",
  reason: "Confirmed against the recorded input and stack trace.",
};
export const event: FindingDispositionEvent = {
  ...scope,
  id: "event-one",
  changeId: input.changeId,
  workItemId: context.workItemId,
  workItemKind: context.workItemKind,
  occurrence: ref,
  revisionKey: context.revisionKey,
  planDigest: context.planDigest,
  resultSetDigestAtChange: "f".repeat(64),
  contextDigestAtChange: input.expectedContextDigest,
  sourceCurrentAtChange: true,
  latestForRequestAtChange: true,
  previousState: "open",
  state: "accepted",
  previousVersion: 0,
  version: 1,
  action: "accept",
  reason: input.reason,
  actor,
  createdAt: "2026-09-07T10:10:00.000Z",
};
export const history: FindingDispositionHistoryResponse = {
  ...scope,
  occurrence: ref,
  page: 1,
  pageSize: 20,
  total: 1,
  items: [event],
};
export const beforeRef = makeRef({ resultId: "result-one", resultDigest: "1".repeat(64) });
export const beforeContext: FindingResultContext = {
  ...context,
  ...beforeScope,
  resultId: beforeRef.resultId,
  resultDigest: beforeRef.resultDigest,
  revisionKey: "2".repeat(64),
  planDigest: "3".repeat(64),
  contextDigest: "4".repeat(64),
  createdAt: "2026-09-07T09:00:00.000Z",
  sourceCurrent: false,
  historical: true,
};
export const beforeSide: FindingComparisonSide = {
  ...beforeRef,
  title: occurrence.title,
  priority: 2,
  path: occurrence.path,
  line: 7,
};
export const afterSide: FindingComparisonSide = {
  ...ref,
  title: occurrence.title,
  priority: occurrence.priority,
  path: occurrence.path,
  line: occurrence.line,
};
export const comparison: FindingComparisonResponse = {
  algorithmVersion: "exact-content-v1",
  before: beforeContext,
  after: context,
  compatible: true,
  reasons: [],
  items: [{ status: "persistent", before: beforeSide, after: afterSide, reason: null }],
  total: 1,
  page: 1,
  pageSize: 20,
};

export function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
