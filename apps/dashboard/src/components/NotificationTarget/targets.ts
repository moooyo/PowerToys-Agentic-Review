const targetParameters = [
  "workItemId",
  "reviewRunId",
  "requestId",
  "jobId",
  "publicationId",
] as const;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;

export type NotificationTarget =
  | {
      kind: "validation";
      repositoryId: string;
      workItemKind: "pull_request" | "issue";
      workItemId: string;
      reviewRunId: string;
      requestId?: string;
      jobId?: string;
    }
  | { kind: "job"; repositoryId: string; jobId: string }
  | { kind: "publication"; repositoryId: string; publicationId: string };

export type NotificationTargetSelection =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "target"; target: NotificationTarget };

export function clearNotificationTargetParameters(search: string): string {
  const parameters = new URLSearchParams(search);
  for (const name of targetParameters) parameters.delete(name);
  const query = parameters.toString();
  return query ? `?${query}` : "";
}

export function parseNotificationTarget(
  pathname: string,
  search: string,
): NotificationTargetSelection {
  const parameters = new URLSearchParams(search);
  if (!targetParameters.some((name) => parameters.has(name))) return { kind: "none" };
  const invalid: NotificationTargetSelection = {
    kind: "invalid",
    message: "This URL does not identify one complete target in the selected repository.",
  };
  for (const name of ["repositoryId", ...targetParameters]) {
    const values = parameters.getAll(name);
    if (values.length > 1 || (values.length === 1 && !identifierPattern.test(values[0] ?? "")))
      return invalid;
  }
  const repositoryId = parameters.get("repositoryId");
  if (!repositoryId) return invalid;
  const hasOnly = (names: readonly string[]) =>
    targetParameters.every((name) => !parameters.has(name) || names.includes(name));
  const publicationId = parameters.get("publicationId");
  if (pathname === "/publications" && publicationId && hasOnly(["publicationId"]))
    return { kind: "target", target: { kind: "publication", repositoryId, publicationId } };
  const jobId = parameters.get("jobId");
  if (pathname === "/jobs" && jobId && hasOnly(["jobId"]))
    return { kind: "target", target: { kind: "job", repositoryId, jobId } };
  const workItemId = parameters.get("workItemId"),
    reviewRunId = parameters.get("reviewRunId"),
    requestId = parameters.get("requestId");
  if (
    (pathname === "/pull-requests" || pathname === "/issues") &&
    workItemId &&
    reviewRunId &&
    hasOnly(["workItemId", "reviewRunId", "requestId", "jobId"]) &&
    (requestId === null) === (jobId === null)
  ) {
    return {
      kind: "target",
      target: {
        kind: "validation",
        repositoryId,
        workItemKind: pathname === "/pull-requests" ? "pull_request" : "issue",
        workItemId,
        reviewRunId,
        ...(requestId !== null && jobId !== null ? { requestId, jobId } : {}),
      },
    };
  }
  return invalid;
}

export function notificationTargetPath(target: NotificationTarget): string {
  const parameters = new URLSearchParams({ repositoryId: target.repositoryId });
  let pathname: string;
  if (target.kind === "publication") {
    pathname = "/publications";
    parameters.set("publicationId", target.publicationId);
  } else if (target.kind === "job") {
    pathname = "/jobs";
    parameters.set("jobId", target.jobId);
  } else if (target.kind === "validation") {
    if (target.workItemKind !== "pull_request" && target.workItemKind !== "issue")
      throw new Error("The notification target has an unsupported work item kind.");
    pathname = target.workItemKind === "pull_request" ? "/pull-requests" : "/issues";
    parameters.set("workItemId", target.workItemId);
    parameters.set("reviewRunId", target.reviewRunId);
    if (target.requestId !== undefined) parameters.set("requestId", target.requestId);
    if (target.jobId !== undefined) parameters.set("jobId", target.jobId);
  } else {
    throw new Error("The notification target is unsupported.");
  }
  const search = `?${parameters}`;
  if (parseNotificationTarget(pathname, search).kind !== "target")
    throw new Error("The notification target is incomplete or invalid.");
  return `${pathname}${search}`;
}
