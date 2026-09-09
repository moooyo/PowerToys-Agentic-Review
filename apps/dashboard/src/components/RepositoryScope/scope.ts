import { clearNotificationTargetParameters } from "../NotificationTarget/targets";

export type RepositoryScopeSelection =
  | { kind: "all"; key: "all" }
  | { kind: "repository"; key: string; repositoryId: string }
  | { kind: "invalid"; key: string; message: string };

export function parseRepositoryScope(search: string): RepositoryScopeSelection {
  const values = new URLSearchParams(search).getAll("repositoryId");
  if (values.length === 0) return { kind: "all", key: "all" };
  const key = JSON.stringify(values);
  const repositoryId = values[0];
  if (
    values.length !== 1 ||
    repositoryId === undefined ||
    repositoryId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/u.test(repositoryId)
  ) {
    return {
      kind: "invalid",
      key,
      message: "This URL does not identify one valid repository. Choose a repository to continue.",
    };
  }
  return { kind: "repository", key, repositoryId };
}

export function pathWithRepositoryScope(path: string, currentSearch: string): string {
  const hashIndex = path.indexOf("#");
  const hash = hashIndex < 0 ? "" : path.slice(hashIndex);
  const target = hashIndex < 0 ? path : path.slice(0, hashIndex);
  const queryIndex = target.indexOf("?");
  const pathname = queryIndex < 0 ? target : target.slice(0, queryIndex);
  const parameters = new URLSearchParams(queryIndex < 0 ? "" : target.slice(queryIndex + 1));
  parameters.delete("repositoryId");
  // Invalid or unknown selections survive navigation until the operator changes them explicitly.
  for (const value of new URLSearchParams(currentSearch).getAll("repositoryId")) {
    parameters.append("repositoryId", value);
  }
  const query = parameters.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

export function searchWithRepositoryScope(search: string, repositoryId?: string): string {
  const parameters = new URLSearchParams(clearNotificationTargetParameters(search));
  parameters.delete("repositoryId");
  if (repositoryId !== undefined) parameters.set("repositoryId", repositoryId);
  const query = parameters.toString();
  return query ? `?${query}` : "";
}
