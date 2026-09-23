import { presentationParameters } from "./workspace-view";

const detailParameters: Readonly<Record<string, string>> = {
  "/pull-requests": "workItemId",
  "/issues": "workItemId",
  "/tasks": "taskId",
  "/reports": "reportId",
  "/comments": "commentId",
  "/webhooks": "deliveryId",
  "/repositories": "repositoryId",
};
const scopedLists = new Set(["/pull-requests", "/issues", "/tasks", "/comments", "/webhooks"]);

export function workspaceRecordKey(pathname: string, search: string): string {
  const parameters = new URLSearchParams(search);
  for (const key of presentationParameters) parameters.delete(key);
  if (pathname === "/workers") parameters.delete("workerId");
  parameters.sort();
  return `${pathname}?${parameters.toString()}`;
}

export function isWorkspaceDetail(pathname: string, search: string): boolean {
  const key = detailParameters[pathname];
  return Boolean(key && new URLSearchParams(search).get(key));
}

export function hasAppliedRepositoryFilter(pathname: string, search: string): boolean {
  return (
    scopedLists.has(pathname) &&
    !isWorkspaceDetail(pathname, search) &&
    Boolean(new URLSearchParams(search).get("repositoryId"))
  );
}

export function withoutRepositoryFilter(search: string): string {
  const parameters = new URLSearchParams(search);
  for (const key of ["repositoryId", "page", "cursor"]) parameters.delete(key);
  return parameters.toString();
}
