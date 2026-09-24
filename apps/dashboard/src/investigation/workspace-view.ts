const ids = new Set([
  "repositoryId",
  "workItemId",
  "taskId",
  "reportId",
  "commentId",
  "deliveryId",
  "workerId",
  "findingId",
  "attemptId",
]);
const common = ["repositoryId", "tab", "section"];
const allowed: Record<string, readonly string[]> = {
  "/pull-requests": [...common, "workItemId", "q", "state", "investigation", "rows", "page"],
  "/issues": [...common, "workItemId", "q", "state", "investigation", "rows", "page"],
  "/tasks": [...common, "taskId", "attemptId", "q", "status", "page", "outputSearch", "outputType"],
  "/reports": [
    ...common,
    "reportId",
    "search",
    "kind",
    "completeness",
    "delivery",
    "cursor",
    "findingId",
    "findingSearch",
    "findingPriority",
    "findingAssessment",
    "findingPage",
  ],
  "/comments": [
    ...common,
    "commentId",
    "workItemId",
    "taskId",
    "workItemNumber",
    "workItemKind",
    "search",
    "state",
    "mode",
    "taskKind",
    "view",
    "cursor",
    "limit",
  ],
  "/webhooks": [
    ...common,
    "deliveryId",
    "workItemId",
    "number",
    "state",
    "kind",
    "mode",
    "cursor",
    "limit",
  ],
  "/workers": ["workerId", "q", "contact"],
  "/repositories": ["repositoryId", "q", "tab", "replyTemplate"],
  "/accounts": ["q", "status"],
  "/account": [],
};
const integerKeys = new Set(["page", "rows", "limit", "number", "workItemNumber", "findingPage"]);
const enumValues: Record<string, readonly string[]> = {
  tab: [
    "overview",
    "investigations",
    "discussion",
    "progress",
    "evidence",
    "details",
    "usage",
    "intake",
    "replies",
    "scheduling",
  ],
  section: [
    "findings",
    "evidence",
    "details",
    "validation",
    "changes",
    "coverage",
    "plans",
    "diagnostics",
    "usage",
  ],
  state: [
    "all",
    "open",
    "closed",
    "merged",
    "pending",
    "sending",
    "synced",
    "retrying",
    "unconfirmed",
    "paused",
    "needs_attention",
    "conflict",
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
    "accepted",
    "source_ready",
    "completed",
    "ignored",
  ],
  status: ["all", "active", "attention", "enabled", "disabled"],
  investigation: ["all", "not_started", "running", "queued", "blocked", "paused", "completed"],
  kind: [
    "pull_request",
    "issue",
    "pr-review",
    "issue-investigate",
    "pr-e2e",
    "pr-verify",
    "issue-verify",
    "reproduction-setup",
    "issue-fix",
    "feature-implement",
  ],
  taskKind: ["pr-e2e"],
  workItemKind: ["pull_request", "issue"],
  completeness: ["complete", "partial"],
  delivery: ["final", "checkpoint"],
  mode: ["static", "e2e", "progress", "result"],
  view: ["attempts", "publications"],
  findingPriority: ["all", "P0", "P1", "P2", "P3"],
  findingAssessment: ["all", "confirmed", "hypothesis"],
  outputType: ["all", "assistant", "tool", "system", "gap"],
  contact: ["all", "recent", "not-recent", "never", "cleanup"],
  replyTemplate: ["pullRequest", "issue", "received", "started", "failed", "completed"],
};
const presentationParameters = [
  "tab",
  "section",
  "findingId",
  "attemptId",
  "findingSearch",
  "findingPriority",
  "findingAssessment",
  "findingPage",
  "outputSearch",
  "outputType",
  "replyTemplate",
];

/** Share only view state, never arbitrary query parameters, private drafts or prepared payloads. */
export function publicWorkspaceSearch(pathname: string, search: string): string {
  const input = new URLSearchParams(search);
  const result = new URLSearchParams();
  for (const key of allowed[pathname] ?? []) {
    const value = input.get(key);
    if (
      !value ||
      [...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      continue;
    if (enumValues[key] && !enumValues[key].includes(value)) continue;
    if (ids.has(key) && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) continue;
    if (integerKeys.has(key) && (!/^[1-9]\d{0,6}$/u.test(value) || Number(value) > 1_000_000))
      continue;
    if (value.length > (key === "cursor" ? 2048 : 200)) continue;
    result.set(key, value);
  }
  return result.toString();
}

export function publicWorkspaceHref(pathname: string, search: string): string {
  const path = Object.hasOwn(allowed, pathname) ? pathname : "/pull-requests";
  const query = publicWorkspaceSearch(path, search);
  return path + (query ? `?${query}` : "");
}

export const repositoryScopedPaths = new Set([
  "/pull-requests",
  "/issues",
  "/tasks",
  "/reports",
  "/comments",
  "/webhooks",
]);

export function scopedWorkspaceHref(pathname: string, repositoryId?: string): string {
  return repositoryId && repositoryScopedPaths.has(pathname)
    ? `${pathname}?${new URLSearchParams({ repositoryId })}`
    : pathname;
}

export function changeRepositorySearch(search: string, repositoryId: string): string {
  const next = new URLSearchParams(search);
  for (const key of [...ids, ...presentationParameters, "page", "cursor"]) next.delete(key);
  if (repositoryId) next.set("repositoryId", repositoryId);
  return next.toString();
}

export { presentationParameters };
