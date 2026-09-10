import { Alert, AlertTitle, Button, Skeleton } from "@mui/material";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { useOperatorSession } from "@/state/session";
import { publicationAccessRefreshVerified } from "./access-refresh";
import { PublicationReadGuard } from "./read-guard";

export { publicationAccessDenied } from "./read-guard";

const PublicationGuardOwners = createContext<Set<PublicationReadGuard> | null>(null);

export function publicationError(error: unknown) {
  return error instanceof Error ? error.message : "The publication request could not be completed.";
}
export function usePublicationReadGuard(prefixes: readonly QueryKey[]) {
  const client = useQueryClient();
  const owners = useContext(PublicationGuardOwners);
  const identity = JSON.stringify(prefixes);
  const guard = useMemo(
    () => new PublicationReadGuard(client, JSON.parse(identity) as QueryKey[]),
    [client, identity],
  );
  const denied = useSyncExternalStore(guard.subscribe, guard.snapshot, guard.snapshot);
  useEffect(() => {
    guard.activate();
    owners?.add(guard);
    return () => {
      owners?.delete(guard);
      guard.dispose();
    };
  }, [guard, owners]);
  return { guard, denied };
}
export function PublicationAccess({
  repositoryId,
  children,
}: {
  repositoryId: string;
  children: (session: string, access: ReturnType<typeof useOperatorAccess>) => ReactNode;
}) {
  const access = useOperatorAccess(repositoryId);
  const client = useQueryClient();
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const guards = useRef(new Set<PublicationReadGuard>());
  const { initialState } = useOperatorSession();
  const session = JSON.stringify([
    repositoryId,
    access.identityKey,
    initialState?.authenticationEpoch ?? 0,
    access.context?.platformAdministrator,
    access.context?.repository,
    refreshEpoch,
  ]);
  const currentSession = useRef<string | null>(session);
  currentSession.current = session;
  useEffect(() => {
    currentSession.current = session;
    return () => {
      if (currentSession.current === session) currentSession.current = null;
    };
  }, [session]);
  const refresh = async () => {
    const expectedSession = session;
    const resetDenied = [...guards.current].some((guard) => guard.snapshot());
    await access.refresh();
    if (currentSession.current !== expectedSession) return;
    if (
      resetDenied &&
      publicationAccessRefreshVerified(client, {
        repositoryId,
        principal: access.principal,
        identityKey: access.identityKey,
        authenticationEpoch: initialState?.authenticationEpoch ?? 0,
      })
    )
      setRefreshEpoch((previous) => previous + 1);
  };
  if (access.pending && !access.ready) return <Skeleton variant="rounded" height={120} />;
  if (!access.ready || access.error || !access.allows("read"))
    return (
      <Alert
        severity="info"
        action={<Button onClick={() => void access.refresh()}>Refresh access</Button>}
      >
        <AlertTitle>Publication access is unavailable</AlertTitle>
        Repository read access is required. Previous publication content is hidden.
      </Alert>
    );
  if (access.identityKey[0] === "sample")
    return (
      <Alert severity="info">
        <AlertTitle>A connected server is required</AlertTitle>
        Sample mode does not create publication previews, policies, or delivery records.
      </Alert>
    );
  return (
    <div key={session}>
      {access.checking ? <Skeleton variant="rounded" height={120} /> : null}
      <div hidden={access.checking} inert={access.checking} aria-hidden={access.checking}>
        <PublicationGuardOwners.Provider value={guards.current}>
          {children(session, {
            ...access,
            refresh,
          })}
        </PublicationGuardOwners.Provider>
      </div>
    </div>
  );
}
