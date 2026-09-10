import type { OperatorAccessContext, OperatorPrincipal } from "@agentic-review/contracts";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { samePrincipal } from "@/components/OperatorAccess/state";
import { access } from "@/services/access";

export interface InitialState {
  apiConnected: boolean;
  sessionEpoch: number;
  authenticationEpoch: number;
  authenticated: boolean;
  operatorAccess: OperatorAccessContext | null;
  accessResolvedAt: number;
  currentUser: { displayName: string; principal: OperatorPrincipal | null };
  settings: Record<string, unknown>;
}

let sessionEpoch = 0;
let authenticationEpoch = 0;
let resolvedSessionIdentity: string | undefined;

function resolveSessionEpoch(principal: OperatorPrincipal | null): number {
  const identity = JSON.stringify(
    principal === null ? null : [principal.issuer, principal.subject],
  );
  if (identity !== resolvedSessionIdentity) {
    resolvedSessionIdentity = identity;
    sessionEpoch += 1;
  }
  return sessionEpoch;
}

export async function getInitialState(): Promise<InitialState> {
  const currentAuthenticationEpoch = ++authenticationEpoch;
  const developmentMode = process.env.NODE_ENV === "development";
  if (developmentMode) {
    const context = await access.context();
    return {
      apiConnected: true,
      sessionEpoch: resolveSessionEpoch(context.principal),
      authenticationEpoch: currentAuthenticationEpoch,
      authenticated: true,
      operatorAccess: context,
      accessResolvedAt: Date.now(),
      currentUser: {
        displayName: "Development Operator",
        principal: context.principal,
      },
      settings: {},
    };
  }

  try {
    const response = await fetch("/api/v1/auth/session", {
      cache: "no-store",
      credentials: "include",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Operator session endpoint returned ${response.status}.`);
    }
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Operator session endpoint returned an invalid payload.");
    }
    const session = value as Record<string, unknown>;
    if (session.authenticated !== true) {
      if (globalThis.location?.pathname !== "/signed-out") {
        globalThis.location?.assign("/signed-out");
      }
      return {
        apiConnected: true,
        sessionEpoch: resolveSessionEpoch(null),
        authenticationEpoch: currentAuthenticationEpoch,
        authenticated: false,
        operatorAccess: null,
        accessResolvedAt: 0,
        currentUser: { displayName: "Signing in", principal: null },
        settings: {},
      };
    }
    const operator = session.operator;
    if (typeof operator !== "object" || operator === null || Array.isArray(operator)) {
      throw new Error("Operator session endpoint omitted the operator identity.");
    }
    const identity = operator as Record<string, unknown>;
    const displayName =
      (typeof identity.displayName === "string" && identity.displayName) ||
      (typeof identity.email === "string" && identity.email) ||
      (typeof identity.subject === "string" && identity.subject);
    if (
      !displayName ||
      typeof identity.issuer !== "string" ||
      !identity.issuer ||
      typeof identity.subject !== "string" ||
      !identity.subject
    ) {
      throw new Error("Operator session endpoint returned an invalid identity.");
    }
    const principal = { issuer: identity.issuer, subject: identity.subject };
    let context: OperatorAccessContext | null = null;
    try {
      const response = await access.context();
      if (!samePrincipal(response.principal, principal))
        throw new Error("The access identity does not match the session.");
      context = response;
    } catch {
      // A permissions failure must not sign out an otherwise authenticated operator.
    }
    return {
      apiConnected: true,
      sessionEpoch: resolveSessionEpoch(principal),
      authenticationEpoch: currentAuthenticationEpoch,
      authenticated: true,
      operatorAccess: context,
      accessResolvedAt: context ? Date.now() : 0,
      currentUser: { displayName, principal },
      settings: {},
    };
  } catch {
    return {
      apiConnected: false,
      sessionEpoch,
      authenticationEpoch: currentAuthenticationEpoch,
      authenticated: false,
      operatorAccess: null,
      accessResolvedAt: 0,
      currentUser: { displayName: "Unavailable", principal: null },
      settings: {},
    };
  }
}

interface OperatorSessionValue {
  initialState: InitialState | undefined;
  setInitialState: Dispatch<SetStateAction<InitialState | undefined>>;
  loading: boolean;
  refresh: () => Promise<void>;
}
const OperatorSessionContext = createContext<OperatorSessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [initialState, setInitialState] = useState<InitialState>();
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await getInitialState();
      if (generation.current === current) setInitialState(next);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  const value = useMemo(
    () => ({ initialState, setInitialState, loading, refresh }),
    [initialState, loading, refresh],
  );
  return (
    <OperatorSessionContext.Provider value={value}>{children}</OperatorSessionContext.Provider>
  );
}

export function useOperatorSession(): OperatorSessionValue {
  const context = useContext(OperatorSessionContext);
  if (context === null) throw new Error("An operator session provider is required.");
  return context;
}
