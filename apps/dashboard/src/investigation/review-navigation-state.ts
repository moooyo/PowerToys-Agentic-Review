export interface ReviewRecord {
  kind: "work-item" | "task" | "report";
  id: string;
  workItemId: string;
  repositoryId: string;
  href: string;
  label?: string;
}

export interface ReviewQueue {
  readonly id: string;
  readonly identity: string;
  readonly repositoryScope: string | null;
  readonly label: string;
  readonly complete: boolean;
  readonly originHref: string;
  readonly originKey: string;
  readonly scrollTop: number;
  readonly openerId: string;
  readonly members: readonly Readonly<ReviewRecord>[];
}

export interface ReviewQueueSelection {
  readonly queue: ReviewQueue;
  readonly originMemberId: string;
}

export interface ReviewNavigationMarker {
  readonly queueId: string;
  readonly originMemberId: string;
  readonly destination: "origin" | "detail";
}

const recordParameters: Readonly<Record<string, string>> = {
  "/pull-requests": "workItemId",
  "/issues": "workItemId",
  "/tasks": "taskId",
  "/reports": "reportId",
};

export function reviewRecordKey(record: Pick<ReviewRecord, "kind" | "repositoryId" | "id">) {
  return JSON.stringify([record.kind, record.repositoryId, record.id]);
}

export function reviewOpenerId(record: ReviewRecord): string {
  return `review-result-${encodeURIComponent(reviewRecordKey(record))}`;
}

function localUrl(href: string): URL | null {
  const invalidCharacter = Array.from(href).some(
    (character) =>
      character === "\\" || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
  if (!href.startsWith("/") || href.startsWith("//") || invalidCharacter) return null;
  try {
    const url = new URL(href, "https://review.invalid");
    return url.origin === "https://review.invalid" ? url : null;
  } catch {
    return null;
  }
}

/** A detail binding is accepted only after its loaded identity matches the route. */
export function reviewRecordMatchesLocation(
  record: ReviewRecord,
  location: { pathname: string; search: string },
): boolean {
  const expectedPaths =
    record.kind === "work-item"
      ? ["/pull-requests", "/issues"]
      : [record.kind === "task" ? "/tasks" : "/reports"];
  const parameter = recordParameters[location.pathname];
  if (!parameter || !expectedPaths.includes(location.pathname)) return false;
  const parameters = new URLSearchParams(location.search);
  return (
    (record.kind !== "work-item" || record.id === record.workItemId) &&
    parameters.get(parameter) === record.id &&
    (!parameters.get("repositoryId") || parameters.get("repositoryId") === record.repositoryId)
  );
}

/** A list shortcut can open a related detail while retaining its original source member. */
export function relatedReviewTarget(origin: ReviewRecord, target: ReviewRecord): boolean {
  const url = localUrl(target.href);
  return Boolean(
    url &&
      origin.repositoryId === target.repositoryId &&
      origin.workItemId === target.workItemId &&
      reviewRecordMatchesLocation(target, url),
  );
}

export function createReviewQueue(
  input: Omit<ReviewQueue, "members" | "complete"> & {
    records: readonly ReviewRecord[];
    complete?: boolean;
  },
): ReviewQueue | null {
  const origin = localUrl(input.originHref);
  if (!origin) return null;
  const parameter = recordParameters[origin.pathname];
  if (!parameter || origin.searchParams.get(parameter)) return null;
  if ((origin.searchParams.get("repositoryId") || null) !== input.repositoryScope) return null;
  const keys = new Set<string>();
  const members: Readonly<ReviewRecord>[] = [];
  for (const record of input.records) {
    const target = localUrl(record.href);
    if (
      !record.id ||
      !record.workItemId ||
      !record.repositoryId ||
      !target ||
      !reviewRecordMatchesLocation(record, target) ||
      (input.repositoryScope !== null && record.repositoryId !== input.repositoryScope)
    )
      continue;
    const key = reviewRecordKey(record);
    if (keys.has(key)) continue;
    keys.add(key);
    members.push(Object.freeze({ ...record }));
  }
  if (!members.length) return null;
  return Object.freeze({
    id: input.id,
    identity: input.identity,
    repositoryScope: input.repositoryScope,
    label: input.label,
    complete: input.complete !== false,
    originHref: input.originHref,
    originKey: input.originKey,
    scrollTop: Number.isFinite(input.scrollTop) ? Math.max(0, input.scrollTop) : 0,
    openerId: input.openerId,
    members: Object.freeze(members),
  });
}

export function reviewQueueIndex(selection: ReviewQueueSelection): number {
  return selection.queue.members.findIndex(
    (member) => reviewRecordKey(member) === selection.originMemberId,
  );
}

/** Related Tasks/reports keep the selected origin member, including multiple reports per source. */
export function bindReviewRecord(
  selection: ReviewQueueSelection | null,
  record: ReviewRecord,
  identity: string,
): ReviewQueueSelection | null {
  if (!selection || selection.queue.identity !== identity) return null;
  const member = selection.queue.members[reviewQueueIndex(selection)];
  return member &&
    member.repositoryId === record.repositoryId &&
    member.workItemId === record.workItemId
    ? selection
    : null;
}

/** Explicit scope changes invalidate history tokens as well as the currently visible queue. */
export function reviewQueueScopeChanged(
  selection: ReviewQueueSelection,
  location: { pathname: string; search: string },
): boolean {
  const member = selection.queue.members[reviewQueueIndex(selection)];
  if (!member) return true;
  const parameters = new URLSearchParams(location.search);
  const scope = parameters.get("repositoryId") || null;
  const detailParameter = recordParameters[location.pathname];
  if (detailParameter && !parameters.get(detailParameter))
    return scope !== selection.queue.repositoryScope;
  if (!detailParameter) return scope !== selection.queue.repositoryScope;
  return scope !== null && scope !== member.repositoryId;
}

export function readReviewNavigationMarker(value: unknown): ReviewNavigationMarker | null {
  if (!value || typeof value !== "object" || !("reviewNavigation" in value)) return null;
  const marker = value.reviewNavigation;
  if (!marker || typeof marker !== "object") return null;
  if (
    !("queueId" in marker) ||
    typeof marker.queueId !== "string" ||
    !("originMemberId" in marker) ||
    typeof marker.originMemberId !== "string" ||
    !("destination" in marker) ||
    (marker.destination !== "origin" && marker.destination !== "detail")
  )
    return null;
  return {
    queueId: marker.queueId,
    originMemberId: marker.originMemberId,
    destination: marker.destination,
  };
}
