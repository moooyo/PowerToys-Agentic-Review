import type { InvestigationBudget, InvestigationTaskV1 } from "@agentic-review/contracts";
import type { CreateTaskInput, WorkItem } from "./api";
import { InvestigationHttpError } from "./transport";

export interface InvestigationInputs {
  mode: "snapshot_only" | "source_read";
  sourceCommit: string;
  customBudget: boolean;
  tokens: string;
  rounds: string;
  minutes: string;
}
export type InvestigationInputErrors = Partial<
  Record<"sourceCommit" | "tokens" | "rounds" | "minutes" | "budget" | "mode", string>
>;
export function initialInvestigationInputs(
  item: WorkItem,
  budget?: InvestigationBudget,
): InvestigationInputs {
  return {
    mode: item.kind === "issue" ? "snapshot_only" : "source_read",
    sourceCommit: "",
    customBudget: false,
    tokens: budget ? String(budget.maxTokens) : "",
    rounds: budget ? String(budget.maxRounds) : "",
    minutes: budget ? String(budget.maxDurationMs / 60_000) : "",
  };
}

export function investigationInputErrors(
  item: WorkItem,
  inputs: InvestigationInputs,
  defaults?: InvestigationBudget,
): InvestigationInputErrors {
  const errors: InvestigationInputErrors = {};
  if (item.kind === "pull_request" && inputs.mode === "snapshot_only")
    errors.mode =
      "Pull request reviews require exact source access. Snapshot-only investigation is reserved for Issue analysis.";
  if (
    inputs.mode === "source_read" &&
    item.kind === "pull_request" &&
    item.subject.kind !== "original_pr"
  )
    errors.mode =
      "This pull request has no registered source commit. Import the current source before starting a review.";
  if (
    inputs.mode === "source_read" &&
    item.kind === "issue" &&
    !/^[a-f0-9]{40,64}$/iu.test(inputs.sourceCommit.trim())
  )
    errors.sourceCommit = "Enter the full 40–64 character hexadecimal commit SHA.";
  if (inputs.customBudget) {
    if (!defaults) errors.budget = "Load the configured budget before choosing custom limits.";
    if (!Number.isSafeInteger(Number(inputs.tokens)) || Number(inputs.tokens) < 1)
      errors.tokens = "Enter a positive whole number of tokens.";
    if (!Number.isSafeInteger(Number(inputs.rounds)) || Number(inputs.rounds) < 1)
      errors.rounds = "Enter a positive whole number of rounds.";
    if (
      !Number.isSafeInteger(Number(inputs.minutes) * 60_000) ||
      Number(inputs.minutes) <= 0 ||
      Number(inputs.minutes) * 60_000 > 2_147_483_647
    )
      errors.minutes = "Enter a positive duration no longer than 35,791 minutes.";
  }
  return errors;
}

export function investigationRequest(
  item: WorkItem,
  inputs: InvestigationInputs,
  key: string,
  defaults?: InvestigationBudget,
): CreateTaskInput {
  const errors = investigationInputErrors(item, inputs, defaults);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  return {
    workItemId: item.id,
    kind: item.kind === "pull_request" ? "pr-review" : "issue-investigate",
    idempotencyKey: key,
    executionMode: inputs.mode,
    expectedSubjectRevisionKey: item.subject.revisionKey,
    ...(inputs.mode === "source_read" && item.kind === "issue"
      ? { sourceCommit: inputs.sourceCommit.trim().toLowerCase() }
      : {}),
    ...(inputs.customBudget && defaults
      ? {
          budget: {
            ...defaults,
            maxTokens: Number(inputs.tokens),
            maxRounds: Number(inputs.rounds),
            maxDurationMs: Number(inputs.minutes) * 60_000,
          },
        }
      : {}),
  };
}

export interface RetainedInvestigationRequest {
  input: CreateTaskInput;
  inputs: InvestigationInputs;
  source: WorkItem;
  state: "pending" | "unknown" | "confirmed" | "mismatch";
  task?: InvestigationTaskV1;
}

/** Account-scoped request receipts outlive a dialog without exposing them to another account. */
const retainedRequests = new Map<string, RetainedInvestigationRequest>();
const inFlightRequests = new Map<string, Promise<InvestigationTaskV1>>();
const requestListeners = new Map<string, Set<() => void>>();
export const investigationRequestScope = (identity: string, workItemId: string) =>
  JSON.stringify([identity, workItemId]);
export function retainedInvestigationRequest(
  scope: string,
): RetainedInvestigationRequest | undefined {
  return retainedRequests.get(scope);
}
export function subscribeInvestigationRequest(scope: string, listener: () => void): () => void {
  const listeners = requestListeners.get(scope) ?? new Set<() => void>();
  listeners.add(listener);
  requestListeners.set(scope, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) requestListeners.delete(scope);
  };
}
function notifyRequest(scope: string): void {
  for (const listener of requestListeners.get(scope) ?? []) listener();
}
export function retainInvestigationRequest(
  scope: string,
  request: RetainedInvestigationRequest,
): void {
  retainedRequests.set(scope, request);
  notifyRequest(scope);
}
export function clearInvestigationRequest(scope: string): void {
  retainedRequests.delete(scope);
  notifyRequest(scope);
}

export function createdTaskMatches(
  input: CreateTaskInput,
  source: WorkItem,
  task: InvestigationTaskV1,
): boolean {
  return (
    task.workItem.id === source.id &&
    task.repository.id === source.repositoryId &&
    task.workItem.kind === source.kind &&
    task.workItem.number === source.number &&
    task.kind === input.kind &&
    task.executionPolicy.mode === input.executionMode &&
    task.subjects.some(
      (subject) =>
        subject.id === source.subject.id &&
        subject.repositoryId === source.repositoryId &&
        subject.workItemId === source.id &&
        subject.revisionKey === source.subject.revisionKey,
    ) &&
    (input.sourceCommit !== undefined || task.subjectRef === source.subject.id) &&
    (!input.sourceCommit ||
      task.subjects.some(
        (subject) =>
          subject.id === task.subjectRef &&
          subject.kind === "source_commit" &&
          subject.commitSha === input.sourceCommit,
      ))
  );
}

class InvestigationTaskBindingError extends Error {
  constructor() {
    super(
      "The returned task does not match the reviewed source or request. The task receipt is retained; review that task before continuing.",
    );
  }
}

/** Replays an uncertain submission with its original payload and never runs concurrent copies. */
export function submitInvestigationRequest(
  scope: string,
  candidate: RetainedInvestigationRequest,
  send: (input: CreateTaskInput) => Promise<InvestigationTaskV1>,
): Promise<InvestigationTaskV1> {
  const inFlight = inFlightRequests.get(scope);
  if (inFlight) return inFlight;
  const saved = retainedRequests.get(scope);
  if (saved?.state === "confirmed" && saved.task) return Promise.resolve(saved.task);
  if (saved?.state === "mismatch") return Promise.reject(new InvestigationTaskBindingError());
  const request = { ...(saved ?? candidate), state: "pending" as const };
  if (
    (request.source.kind === "pull_request" || request.input.kind === "pr-review") &&
    request.input.executionMode === "snapshot_only"
  )
    return Promise.reject(
      new Error(
        "Pull request reviews require exact source access. Snapshot-only investigation is reserved for Issue analysis.",
      ),
    );
  retainInvestigationRequest(scope, request);
  const promise = Promise.resolve().then(async () => {
    try {
      const task = await send(request.input);
      if (!createdTaskMatches(request.input, request.source, task)) {
        retainInvestigationRequest(scope, { ...request, state: "mismatch", task });
        throw new InvestigationTaskBindingError();
      }
      retainInvestigationRequest(scope, { ...request, state: "confirmed", task });
      return task;
    } catch (cause) {
      const definitive =
        cause instanceof InvestigationHttpError && cause.status >= 400 && cause.status < 500;
      if (!(cause instanceof InvestigationTaskBindingError)) {
        if (definitive && !saved) clearInvestigationRequest(scope);
        else retainInvestigationRequest(scope, { ...request, state: "unknown" });
      }
      throw cause;
    } finally {
      inFlightRequests.delete(scope);
    }
  });
  inFlightRequests.set(scope, promise);
  return promise;
}
