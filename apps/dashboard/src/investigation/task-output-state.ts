import type {
  InvestigationAttemptV1,
  InvestigationModelInvocationReceipt,
  InvestigationOutputEvent,
  InvestigationOutputPage,
} from "@agentic-review/contracts";

/** Never select an attempt belonging to another task, regardless of response order. */
export function orderedTaskAttempts(
  taskId: string,
  attempts: readonly InvestigationAttemptV1[],
): InvestigationAttemptV1[] {
  return attempts
    .filter((attempt) => attempt.taskId === taskId)
    .sort((left, right) => right.number - left.number || right.id.localeCompare(left.id));
}

export function selectedTaskAttempt(
  taskId: string,
  attempts: readonly InvestigationAttemptV1[],
  requestedId?: string | null,
): InvestigationAttemptV1 | undefined {
  const ordered = orderedTaskAttempts(taskId, attempts);
  return ordered.find((attempt) => attempt.id === requestedId) ?? ordered[0];
}

export interface OutputItem extends InvestigationOutputEvent {
  firstSequence: number;
  updates: number;
}

export interface TaskOutputView {
  search: string;
  type: "all" | InvestigationOutputEvent["kind"];
}

/** Only visible-output controls belong in a copied view; unknown event kinds fall back to all. */
export function normalizeTaskOutputView(view?: {
  search?: unknown;
  type?: unknown;
}): TaskOutputView {
  const type = view?.type;
  return {
    search:
      typeof view?.search === "string"
        ? view.search
            .split("")
            .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
            .join("")
            .slice(0, 160)
        : "",
    type:
      type === "assistant" || type === "tool" || type === "system" || type === "gap" ? type : "all",
  };
}

export interface TaskOutputState {
  taskId: string;
  attemptId: string;
  items: OutputItem[];
  lastSequence: number;
  eventCount: number;
  cursor: string | undefined;
  hasMore: boolean;
  retentionGap: boolean;
  localGap: boolean;
  earliestAvailableCursor: string | null;
  highWaterCursor: string | null;
}

export const maximumLoadedOutputItems = 2_000;
const maximumItemCharacters = 65_536;
const maximumLoadedCharacters = 2_000_000;

export function emptyTaskOutput(taskId: string, attemptId: string): TaskOutputState {
  return {
    taskId,
    attemptId,
    items: [],
    lastSequence: 0,
    eventCount: 0,
    cursor: undefined,
    hasMore: false,
    retentionGap: false,
    localGap: false,
    earliestAvailableCursor: null,
    highWaterCursor: null,
  };
}

function itemKey(event: InvestigationOutputEvent): string {
  return JSON.stringify([event.attemptId, event.invocationId, event.kind, event.itemId]);
}

/** Apply only new, ordered events from the selected attempt. Replacement snapshots do not duplicate deltas. */
export function mergeTaskOutput(
  state: TaskOutputState,
  page: InvestigationOutputPage,
): TaskOutputState {
  if (page.taskId !== state.taskId || page.attemptId !== state.attemptId) {
    throw new Error("Output belongs to a different task or attempt.");
  }
  const items = new Map(state.items.map((item) => [itemKey(item), item]));
  let lastSequence = state.lastSequence;
  let eventCount = state.eventCount;
  let localGap = state.localGap;
  for (const event of page.items) {
    if (event.taskId !== state.taskId || event.attemptId !== state.attemptId) {
      throw new Error("Output contains an event from a different task or attempt.");
    }
    if (event.producerSequence <= lastSequence) continue;
    const key = itemKey(event);
    const previous = items.get(key);
    const append = event.operation === "append" && previous !== undefined;
    const text = append ? previous.text + event.text : event.text;
    const result =
      append && event.result !== undefined
        ? (previous.result ?? "") + event.result
        : (event.result ?? (append ? previous.result : undefined));
    localGap ||=
      text.length > maximumItemCharacters || (result?.length ?? 0) > maximumItemCharacters;
    items.set(key, {
      ...event,
      text: text.slice(-maximumItemCharacters),
      command: event.command ?? (append ? previous.command : undefined),
      ...(result === undefined ? {} : { result: result.slice(-maximumItemCharacters) }),
      firstSequence: previous?.firstSequence ?? event.producerSequence,
      updates: (previous?.updates ?? 0) + 1,
    });
    lastSequence = event.producerSequence;
    eventCount += 1;
  }
  let ordered = [...items.values()].sort((left, right) => left.firstSequence - right.firstSequence);
  localGap ||= ordered.length > maximumLoadedOutputItems;
  ordered = ordered.slice(-maximumLoadedOutputItems);
  let characters = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index]!;
    characters += item.text.length + (item.result?.length ?? 0) + (item.command?.length ?? 0);
    if (characters > maximumLoadedCharacters) {
      localGap = true;
      ordered = ordered.slice(index + 1);
      break;
    }
  }
  return {
    ...state,
    items: ordered,
    lastSequence,
    eventCount,
    localGap,
    cursor: page.nextCursor ?? page.highWaterCursor ?? state.cursor,
    hasMore: page.nextCursor !== null,
    retentionGap: state.retentionGap || page.truncated || page.cursorExpired,
    earliestAvailableCursor: page.earliestAvailableCursor,
    highWaterCursor: page.highWaterCursor,
  };
}

export function latestAttemptInvocation(
  invocations: InvestigationModelInvocationReceipt[] | undefined,
  attemptId: string | undefined,
): InvestigationModelInvocationReceipt | undefined {
  if (!attemptId) return undefined;
  return invocations
    ?.filter((call) => call.attemptId === attemptId)
    .sort(
      (left, right) =>
        Date.parse(right.startedAt) - Date.parse(left.startedAt) ||
        right.invocationId.localeCompare(left.invocationId) ||
        right.revision - left.revision,
    )[0];
}

export function outputMatches(item: OutputItem, search: string, kind: string): boolean {
  return (
    (kind === "all" || item.kind === kind) &&
    [item.text, item.command, item.result]
      .join("\n")
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase())
  );
}

export function exportLoadedOutput(state: TaskOutputState): string {
  return [
    `Task: ${state.taskId}`,
    `Attempt: ${state.attemptId}`,
    "Scope: loaded normalized output only; filters are not applied. This is not a complete history guarantee.",
    `Retention gap: ${state.retentionGap ? "yes" : "not reported"}`,
    `Local display limit reached: ${state.localGap ? "yes" : "no"}`,
    `More retained pages available: ${state.hasMore ? "yes" : "no"}`,
    `High-water cursor: ${state.highWaterCursor ?? "none"}`,
    "",
    ...state.items.map((item) =>
      [
        `[${item.observedAt}] ${item.kind.toUpperCase()}${item.status ? ` · ${item.status}` : ""}`,
        `Item: ${item.itemId} · Invocation: ${item.invocationId ?? "none"}`,
        item.text,
        item.command,
        item.result,
      ]
        .filter((value) => value !== undefined && value !== "")
        .join("\n"),
    ),
  ].join("\n\n");
}
