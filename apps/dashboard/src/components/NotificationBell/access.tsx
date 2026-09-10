import { Alert, AlertTitle, Button, Skeleton } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOperatorAccess } from "@/components/OperatorAccess";
import { notificationQueryRoot, notifications } from "@/services/notifications";
import { ReviewControlHttpError } from "@/services/review-control/errors";
import { OPERATOR_ACCESS_DENIED_EVENT } from "@/services/review-control/http-client";
import { useOperatorSession } from "@/state/session";
import { discardNotificationQueries } from "./cache";

const NotificationSessionContext = createContext<{
  epoch: number;
  blocked: boolean;
  permissionsChecking: boolean;
  invalidate: () => void;
  recover: () => Promise<void>;
} | null>(null);

export function notificationAccessDenied(error: unknown): boolean {
  return error instanceof ReviewControlHttpError && [401, 403, 404].includes(error.status);
}

export function NotificationSession({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [state, setState] = useState({ epoch: 0, blocked: false, permissionsChecking: false });
  const blocked = useRef(false);
  const invalidate = useCallback(() => {
    if (blocked.current) return;
    blocked.current = true;
    setState((previous) => ({ ...previous, epoch: previous.epoch + 1, blocked: true }));
    discardNotificationQueries(client);
  }, [client]);
  const recover = useCallback(async () => {
    try {
      await client.refetchQueries(
        { queryKey: ["operator-access"], type: "active" },
        { throwOnError: true },
      );
      if (
        client
          .getQueryCache()
          .findAll({ queryKey: ["operator-access"], type: "active" })
          .some((query) => query.state.status === "error" || query.state.fetchStatus !== "idle")
      )
        return;
      blocked.current = false;
      setState((previous) => ({ ...previous, epoch: previous.epoch + 1, blocked: false }));
    } catch {
      invalidate();
    }
  }, [client, invalidate]);
  useEffect(() => {
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryKey[0] !== "operator-access") return;
      if (event.query.state.status === "error") invalidate();
      if (event.action.type === "fetch") {
        discardNotificationQueries(client);
        setState((previous) => ({
          ...previous,
          epoch: previous.epoch + 1,
          permissionsChecking: true,
        }));
      } else {
        const permissionsChecking = client
          .getQueryCache()
          .findAll({ queryKey: ["operator-access"] })
          .some((query) => query.state.fetchStatus === "fetching");
        setState((previous) =>
          previous.permissionsChecking === permissionsChecking
            ? previous
            : { ...previous, permissionsChecking },
        );
      }
    });
    globalThis.addEventListener(OPERATOR_ACCESS_DENIED_EVENT, invalidate);
    return () => {
      unsubscribe();
      globalThis.removeEventListener(OPERATOR_ACCESS_DENIED_EVENT, invalidate);
      discardNotificationQueries(client);
    };
  }, [client, invalidate]);
  const value = useMemo(() => ({ ...state, invalidate, recover }), [state, invalidate, recover]);
  return (
    <NotificationSessionContext.Provider value={value}>
      {children}
    </NotificationSessionContext.Provider>
  );
}

export function useNotificationAccess(repositoryId?: string) {
  const shared = useContext(NotificationSessionContext);
  if (shared === null) throw new Error("Notifications require an operator session boundary.");
  const access = useOperatorAccess(repositoryId);
  const { initialState } = useOperatorSession();
  const bindingSession = JSON.stringify([
    repositoryId ?? null,
    access.identityKey,
    initialState?.authenticationEpoch ?? 0,
    access.context?.platformAdministrator,
    access.context?.repository,
  ]);
  const session = JSON.stringify([bindingSession, shared.epoch]);
  const checking = access.checking || shared.permissionsChecking;
  const sample = access.identityKey[0] === "sample";
  const readable =
    !sample &&
    !shared.blocked &&
    access.ready &&
    !checking &&
    !access.error &&
    access.allows("read");
  useEffect(() => {
    if (access.error) shared.invalidate();
  }, [access.error, shared.invalidate]);
  return {
    ...access,
    ...shared,
    sample,
    readable,
    session,
    bindingSession,
    checking,
    refreshAccess: async () => {
      await shared.recover();
    },
  };
}
export type NotificationAccessState = ReturnType<typeof useNotificationAccess>;

export function NotificationAccess({
  access,
  children,
}: {
  access: NotificationAccessState;
  children: ReactNode;
}) {
  if (access.sample)
    return (
      <Alert severity="info">
        <AlertTitle>A connected server is required</AlertTitle>
        Personal notifications are unavailable in sample mode. Connect to a server to read events
        and manage your inbox.
      </Alert>
    );
  if (access.blocked || access.error || (!access.readable && !access.pending && !access.checking))
    return (
      <Alert
        severity="info"
        action={<Button onClick={() => void access.refreshAccess()}>Refresh access</Button>}
      >
        <AlertTitle>Notification access is unavailable</AlertTitle>
        Previous notification counts, events and selections are hidden until access is verified.
      </Alert>
    );
  const checking = access.pending || access.checking;
  // Keep an in-flight or uncertain personal change while the same scope is being verified.
  // Read queries use a separate epoch and are disabled and emptied during this interval.
  return (
    <div key={access.bindingSession}>
      {checking ? <Skeleton variant="rounded" height={160} /> : null}
      <div hidden={checking} inert={checking} aria-hidden={checking}>
        {children}
      </div>
    </div>
  );
}

export function useNotificationFailure(access: NotificationAccessState, error: unknown) {
  useEffect(() => {
    if (notificationAccessDenied(error)) access.invalidate();
  }, [access.invalidate, error]);
}

export function useNotificationSummary(
  repositoryId: string | undefined,
  access: NotificationAccessState,
) {
  const query = useQuery({
    queryKey: [...notificationQueryRoot, access.session, "summary", repositoryId ?? null],
    queryFn: ({ signal }) => {
      if (!access.principal) throw new Error("A verified operator is required.");
      return notifications.summary(repositoryId, access.principal, signal);
    },
    enabled: access.readable,
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
    gcTime: 0,
  });
  useNotificationFailure(access, query.error);
  return { ...query, data: access.readable && !query.isError ? query.data : undefined };
}
