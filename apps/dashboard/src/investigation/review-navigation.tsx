import ArrowBackRounded from "@mui/icons-material/ArrowBackRounded";
import ArrowForwardRounded from "@mui/icons-material/ArrowForwardRounded";
import { Box, Button, Typography } from "@mui/material";
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  type LinkProps,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import { useGuardedAction } from "./navigation-guard";
import {
  bindReviewRecord,
  createReviewQueue,
  type ReviewNavigationMarker,
  type ReviewQueue,
  type ReviewQueueSelection,
  type ReviewRecord,
  readReviewNavigationMarker,
  reviewOpenerId,
  reviewQueueIndex,
  reviewQueueScopeChanged,
  reviewRecordKey,
  reviewRecordMatchesLocation,
} from "./review-navigation-state";
import { sessionIdentity, useInvestigationSession } from "./session";

export type { ReviewRecord } from "./review-navigation-state";

type ReviewLinkProps = Pick<LinkProps, "to" | "onClick" | "state"> & { id: string };
interface ReviewNavigationContextValue {
  identity: string;
  selection: ReviewQueueSelection | null;
  start: (queue: ReviewQueue, record: ReviewRecord) => void;
  register: (record: ReviewRecord) => void;
  move: (selection: ReviewQueueSelection, direction: -1 | 1) => void;
  back: (selection: ReviewQueueSelection) => void;
}
const ReviewNavigationContext = createContext<ReviewNavigationContextValue | null>(null);

function sameSelection(left: ReviewQueueSelection | null, right: ReviewQueueSelection | null) {
  return left?.queue.id === right?.queue.id && left?.originMemberId === right?.originMemberId;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V) {
  map.set(key, value);
  if (map.size > 100) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
}

function followsInCurrentTab(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!event.currentTarget.target || event.currentTarget.target === "_self")
  );
}

/** Restore after the shell's layout effect and after an asynchronously loaded list mounts. */
function restoreOrigin(queue: ReviewQueue): () => void {
  const main = document.getElementById("workspace-main");
  if (!main) return () => {};
  let stopped = false;
  let frame = 0;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.clearTimeout(timeout);
    document.removeEventListener("pointerdown", stop, true);
    document.removeEventListener("keydown", stop, true);
  };
  const attempt = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (stopped) return;
      main.scrollTop = queue.scrollTop;
      const opener = document.getElementById(queue.openerId);
      if (opener && main.contains(opener)) {
        opener.focus({ preventScroll: true });
        stop();
      }
    });
  };
  const observer = new MutationObserver(attempt);
  observer.observe(main, { childList: true, subtree: true });
  const timeout = window.setTimeout(() => {
    if (document.activeElement === document.body || main.contains(document.activeElement))
      main.focus({ preventScroll: true });
    stop();
  }, 2_000);
  document.addEventListener("pointerdown", stop, true);
  document.addEventListener("keydown", stop, true);
  attempt();
  return stop;
}

/** Mount inside the Router, session boundary and NavigationGuardProvider. No queue enters the URL. */
export function ReviewNavigationProvider({ children }: { children: ReactNode }) {
  const { session } = useInvestigationSession();
  const identity = sessionIdentity(session);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const previousIdentity = useRef(identity);
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const guarded = useGuardedAction();
  const queues = useRef(new Map<string, ReviewQueue>());
  const visits = useRef(new Map<string, ReviewNavigationMarker | null>());
  const active = useRef<ReviewQueueSelection | null>(null);
  const [, update] = useState(0);
  const setActive = useCallback((next: ReviewQueueSelection | null) => {
    if (sameSelection(active.current, next)) return;
    active.current = next;
    update((value) => value + 1);
  }, []);
  const lookup = useCallback((): ReviewQueueSelection | null => {
    const marker = readReviewNavigationMarker(location.state) ?? visits.current.get(location.key);
    // An older unbound/deep-link entry must not acquire the current queue retroactively on Back.
    if (!marker && (visits.current.has(location.key) || navigationType === "POP")) return null;
    const selection = marker
      ? (() => {
          const queue = queues.current.get(marker.queueId);
          return queue ? { queue, originMemberId: marker.originMemberId } : null;
        })()
      : active.current;
    return selection?.queue.identity === identity && reviewQueueIndex(selection) >= 0
      ? selection
      : null;
  }, [identity, location.key, location.state, navigationType]);
  const candidate = lookup();
  const selection = candidate && !reviewQueueScopeChanged(candidate, location) ? candidate : null;

  useLayoutEffect(() => {
    const scopeChanged = candidate && reviewQueueScopeChanged(candidate, location);
    if (previousIdentity.current !== identity || scopeChanged) {
      previousIdentity.current = identity;
      queues.current.clear();
      visits.current.clear();
      setActive(null);
    }
  }, [candidate, identity, location, setActive]);

  const route = useCallback(
    (next: ReviewQueueSelection, destination: "origin" | "detail", href: string) => {
      if (next.queue.identity !== identityRef.current || !queues.current.has(next.queue.id)) return;
      setActive(next);
      const marker: ReviewNavigationMarker = {
        queueId: next.queue.id,
        originMemberId: next.originMemberId,
        destination,
      };
      navigate(href, { state: { reviewNavigation: marker } });
    },
    [navigate, setActive],
  );
  const start = useCallback(
    (queue: ReviewQueue, record: ReviewRecord) => {
      guarded(() => {
        if (queue.identity !== identityRef.current) return;
        const next = { queue, originMemberId: reviewRecordKey(record) };
        if (reviewQueueIndex(next) < 0) return;
        remember(queues.current, queue.id, queue);
        remember(visits.current, queue.originKey, {
          queueId: queue.id,
          originMemberId: next.originMemberId,
          destination: "origin",
        });
        route(next, "detail", record.href);
      });
    },
    [guarded, route],
  );
  const register = useCallback(
    (record: ReviewRecord) => {
      if (!reviewRecordMatchesLocation(record, location)) return;
      const next = lookup();
      const bound =
        next && !reviewQueueScopeChanged(next, location)
          ? bindReviewRecord(next, record, identity)
          : null;
      if (bound)
        remember(visits.current, location.key, {
          queueId: bound.queue.id,
          originMemberId: bound.originMemberId,
          destination: "detail",
        });
      else remember(visits.current, location.key, null);
      setActive(bound);
    },
    [identity, location, lookup, setActive],
  );
  const move = useCallback(
    (current: ReviewQueueSelection, direction: -1 | 1) => {
      const member = current.queue.members[reviewQueueIndex(current) + direction];
      if (!member) return;
      guarded(() =>
        route(
          { queue: current.queue, originMemberId: reviewRecordKey(member) },
          "detail",
          member.href,
        ),
      );
    },
    [guarded, route],
  );
  const back = useCallback(
    (current: ReviewQueueSelection) =>
      guarded(() => route(current, "origin", current.queue.originHref)),
    [guarded, route],
  );

  useEffect(() => {
    const marker = readReviewNavigationMarker(location.state) ?? visits.current.get(location.key);
    const current = lookup();
    if (
      !current ||
      reviewQueueScopeChanged(current, location) ||
      marker?.destination !== "origin" ||
      (navigationType !== "POP" && !readReviewNavigationMarker(location.state)) ||
      `${location.pathname}${location.search}${location.hash}` !== current.queue.originHref
    )
      return;
    return restoreOrigin(current.queue);
  }, [location, lookup, navigationType]);

  const value = useMemo(
    () => ({ identity, selection, start, register, move, back }),
    [identity, selection, start, register, move, back],
  );
  return (
    <ReviewNavigationContext.Provider value={value}>{children}</ReviewNavigationContext.Provider>
  );
}

/** Spread these props onto the row's single primary Router Link. Modified clicks remain ordinary links. */
export function useReviewListNavigation({
  label,
  records,
  complete = true,
}: {
  label: string;
  records: readonly ReviewRecord[];
  complete?: boolean;
}) {
  const context = useContext(ReviewNavigationContext);
  const location = useLocation();
  const getLinkProps = useCallback(
    (record: ReviewRecord): ReviewLinkProps => {
      const id = reviewOpenerId(record);
      if (!context) return { to: record.href, id };
      return {
        to: record.href,
        id,
        onClick: (event) => {
          if (!followsInCurrentTab(event)) return;
          const queue = createReviewQueue({
            id: crypto.randomUUID(),
            identity: context.identity,
            repositoryScope: new URLSearchParams(location.search).get("repositoryId") || null,
            originHref: `${location.pathname}${location.search}${location.hash}`,
            originKey: location.key,
            scrollTop: document.getElementById("workspace-main")?.scrollTop ?? 0,
            openerId: id,
            label,
            records,
            complete,
          });
          if (!queue?.members.some((member) => reviewRecordKey(member) === reviewRecordKey(record)))
            return;
          event.preventDefault();
          context.start(queue, record);
        },
      };
    },
    [context, location, label, records, complete],
  );
  return { getLinkProps };
}

export function ReviewQueueBar({
  record,
  fallbackTo,
  fallbackLabel,
}: {
  record: ReviewRecord;
  fallbackTo: LinkProps["to"];
  fallbackLabel: string;
}) {
  const context = useContext(ReviewNavigationContext);
  const location = useLocation();
  const register = context?.register;
  const binding = useMemo(
    () => ({
      kind: record.kind,
      id: record.id,
      workItemId: record.workItemId,
      repositoryId: record.repositoryId,
      href: record.href,
    }),
    [record.kind, record.id, record.workItemId, record.repositoryId, record.href],
  );
  useLayoutEffect(() => {
    register?.(binding);
  }, [register, binding]);
  const selection =
    context && reviewRecordMatchesLocation(record, location)
      ? bindReviewRecord(context.selection, record, context.identity)
      : null;
  if (!context || !selection)
    return (
      <Box>
        <Button component={Link} to={fallbackTo} size="small" startIcon={<ArrowBackRounded />}>
          {fallbackLabel}
        </Button>
      </Box>
    );
  const index = reviewQueueIndex(selection);
  const previous = selection.queue.members[index - 1];
  const next = selection.queue.members[index + 1];
  const label = `Back to ${selection.queue.label.toLocaleLowerCase()} results`;
  return (
    <Box
      component="nav"
      aria-label="Review result queue"
      sx={{
        display: "flex",
        flexWrap: "wrap",
        gap: 1,
        alignItems: "center",
        bgcolor: "var(--app-surface-low)",
        borderRadius: "12px",
        p: 1,
        minWidth: 0,
      }}
    >
      <Button
        component={Link}
        to={selection.queue.originHref}
        size="small"
        startIcon={<ArrowBackRounded />}
        onClick={(event) => {
          if (!followsInCurrentTab(event)) return;
          event.preventDefault();
          context.back(selection);
        }}
      >
        {label}
      </Button>
      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 100 }}>
        {selection.queue.label} · {selection.queue.complete ? "" : "This page · "}
        {index + 1} of {selection.queue.members.length}
      </Typography>
      <Box sx={{ display: "flex", gap: 0.5 }}>
        <Button
          component={Link}
          to={previous?.href ?? record.href}
          size="small"
          disabled={!previous}
          aria-label="Previous result"
          startIcon={<ArrowBackRounded />}
          onClick={(event) => {
            if (!followsInCurrentTab(event)) return;
            event.preventDefault();
            context.move(selection, -1);
          }}
        >
          Previous
        </Button>
        <Button
          component={Link}
          to={next?.href ?? record.href}
          size="small"
          disabled={!next}
          aria-label="Next result"
          endIcon={<ArrowForwardRounded />}
          onClick={(event) => {
            if (!followsInCurrentTab(event)) return;
            event.preventDefault();
            context.move(selection, 1);
          }}
        >
          Next
        </Button>
      </Box>
    </Box>
  );
}
