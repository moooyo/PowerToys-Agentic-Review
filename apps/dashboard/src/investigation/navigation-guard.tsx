import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useBlocker } from "react-router-dom";
import { activeGuardEntries, blocksNavigation } from "./navigation-guard-state";

export { activeGuardEntries } from "./navigation-guard-state";

interface GuardOptions {
  scope?: string;
  busy?: boolean;
  description?: string;
  onDiscard?: () => void;
  allowPresentationNavigation?: boolean;
  presentationParameters?: readonly string[];
}
interface GuardEntry extends GuardOptions {
  dirty: boolean;
}
interface GuardContextValue {
  register: (id: string, entry: GuardEntry) => () => void;
  request: (action: () => void, scope?: string) => void;
}
const GuardContext = createContext<GuardContextValue | null>(null);

/** Protects navigation without requiring isolated component tests to mount a router. */
export function useUnsavedChanges(dirty: boolean, options: GuardOptions = {}) {
  const context = useContext(GuardContext);
  const id = useId();
  const latest = useRef(options);
  latest.current = options;
  const register = context?.register;
  const presentationKey = options.presentationParameters?.join("\0");
  useEffect(
    () =>
      register?.(id, {
        dirty,
        scope: options.scope,
        busy: options.busy,
        description: options.description,
        allowPresentationNavigation: options.allowPresentationNavigation,
        presentationParameters: presentationKey?.split("\0"),
        onDiscard: () => latest.current.onDiscard?.(),
      }),
    [
      register,
      id,
      dirty,
      options.scope,
      options.busy,
      options.description,
      options.allowPresentationNavigation,
      presentationKey,
    ],
  );
}

export function useGuardedAction(scope?: string) {
  const context = useContext(GuardContext);
  const request = context?.request;
  return useCallback(
    (action: () => void) => (request ? request(action, scope) : action()),
    [request, scope],
  );
}

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, GuardEntry>());
  const [, refresh] = useState(0);
  const [pending, setPending] = useState<{ action: () => void; scope?: string } | null>(null);
  const [error, setError] = useState<string>();
  const bypass = useRef(false);
  const active = useCallback(
    (scope?: string) => activeGuardEntries([...entries.current.values()], scope),
    [],
  );
  const register = useCallback((id: string, entry: GuardEntry) => {
    entries.current.set(id, entry);
    refresh((value) => value + 1);
    return () => {
      entries.current.delete(id);
      refresh((value) => value + 1);
    };
  }, []);
  const shouldBlock = useCallback(
    ({
      currentLocation,
      nextLocation,
    }: {
      currentLocation: { pathname: string; search: string };
      nextLocation: { pathname: string; search: string };
    }) => {
      if (
        currentLocation.pathname === nextLocation.pathname &&
        currentLocation.search === nextLocation.search
      )
        return false;
      if (bypass.current) {
        bypass.current = false;
        return false;
      }
      return blocksNavigation(active(), currentLocation, nextLocation);
    },
    [active],
  );
  const blocker = useBlocker(shouldBlock);
  const request = useCallback(
    (action: () => void, scope?: string) => {
      if (active(scope).length) {
        setError(undefined);
        setPending({ action, scope });
      } else action();
    },
    [active],
  );
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!active().length) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [active]);
  const selectedScope = blocker.state === "blocked" ? undefined : pending?.scope;
  const busy = active(selectedScope).some((entry) => entry.busy);
  const dirty = active(selectedScope).some((entry) => entry.dirty);
  const open = blocker.state === "blocked" || pending !== null;
  const dismiss = () => {
    setPending(null);
    setError(undefined);
    if (blocker.state === "blocked") blocker.reset();
  };
  const discard = () => {
    if (active(selectedScope).some((entry) => entry.busy)) return;
    try {
      for (const entry of active(selectedScope)) if (entry.dirty) entry.onDiscard?.();
      const approved = pending;
      setPending(null);
      setError(undefined);
      if (blocker.state === "blocked") blocker.proceed();
      else if (approved) {
        bypass.current = approved.scope === undefined;
        try {
          approved.action();
        } finally {
          queueMicrotask(() => {
            bypass.current = false;
          });
        }
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Changes could not be discarded. Keep editing and try again.",
      );
    }
  };
  const context = { register, request };
  return (
    <GuardContext.Provider value={context}>
      {children}
      <Dialog open={open} onClose={dismiss} maxWidth="xs" aria-labelledby="navigation-guard-title">
        <DialogTitle id="navigation-guard-title">
          {busy
            ? "An operation is still in progress"
            : dirty
              ? "Discard unsaved changes?"
              : "Continue navigation?"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {busy
              ? "Wait for its result before leaving this view. You can keep working here while the request finishes."
              : dirty
                ? (active(selectedScope).find((entry) => entry.description)?.description ??
                  "Your unsaved edits will be lost. Submitted requests and their saved outcomes will remain available.")
                : "The operation has finished. You can now continue to the selected view."}
          </DialogContentText>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={dismiss}>Keep editing</Button>
          {!busy && (
            <Button variant="contained" onClick={discard}>
              {dirty ? "Discard changes" : "Continue"}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </GuardContext.Provider>
  );
}
