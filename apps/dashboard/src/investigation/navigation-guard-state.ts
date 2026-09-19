import { workspaceRecordKey } from "./workspace-navigation";

export interface NavigationProtection {
  dirty: boolean;
  busy?: boolean;
  scope?: string;
  allowPresentationNavigation?: boolean;
}

export function activeGuardEntries<T extends NavigationProtection>(
  entries: readonly T[],
  scope?: string,
): T[] {
  return entries.filter(
    (entry) => (entry.dirty || entry.busy) && (scope === undefined || entry.scope === scope),
  );
}

export function blocksNavigation(
  entries: readonly NavigationProtection[],
  current: { pathname: string; search: string },
  next: { pathname: string; search: string },
): boolean {
  if (current.pathname === next.pathname && current.search === next.search) return false;
  const presentationOnly =
    workspaceRecordKey(current.pathname, current.search) ===
    workspaceRecordKey(next.pathname, next.search);
  return activeGuardEntries(entries).some(
    (entry) =>
      entry.busy || (entry.dirty && !(presentationOnly && entry.allowPresentationNavigation)),
  );
}
