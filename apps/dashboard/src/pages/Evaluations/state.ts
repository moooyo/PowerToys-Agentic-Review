import type * as C from "@agentic-review/contracts";
import {
  ReviewControlHttpError,
  ReviewControlRequestError,
} from "@/services/review-control/errors";

export const evaluationQueryRoot = ["evaluation-management"] as const;
export const workflowLabels: Record<C.WorkflowKind, string> = {
  pr_static_build: "Static review and build",
  pr_ui: "PR UI validation",
  issue_triage: "Issue triage",
  issue_validation: "Issue validation",
};
export const targetLabels: Record<C.ValidationTarget, string> = {
  headless: "Headless",
  windows_desktop: "Windows desktop",
  web: "Web",
};
export type SampleKind = "pull_request" | "issue";
export const workflowKind = (workflow: C.WorkflowKind): SampleKind =>
  workflow === "pr_static_build" || workflow === "pr_ui" ? "pull_request" : "issue";
export const newIdentity = () => crypto.randomUUID();
export function newCase(
  source: C.EvaluationSourceSummaryV1,
  id: string = newIdentity(),
): C.EvaluationSuiteDraftCase {
  return {
    caseId: id,
    title: Array.from(source.title).slice(0, 256).join("") || `Example #${source.number}`,
    sourceId: source.id,
    applicability: { state: "applicable" },
    criteria: [],
    findings: { annotation: "unlabeled", expected: [] },
  };
}
export function newCriterion(
  id: string = newIdentity(),
): C.EvaluationSuiteDraftCase["criteria"][number] {
  return {
    criterionId: id,
    description: "",
    applicability: { state: "applicable" },
    expectedOutcome: "passed",
  };
}
export function changeAnnotation(
  findings: C.EvaluationSuiteDraftCase["findings"],
  annotation: C.EvaluationSuiteDraftCase["findings"]["annotation"],
): C.EvaluationSuiteDraftCase["findings"] {
  if (annotation === "unlabeled") {
    if (findings.expected.length)
      throw new Error("Remove expected findings before marking an example unlabeled.");
    return { annotation, expected: [] };
  }
  return { annotation, expected: structuredClone(findings.expected) };
}
export function accessDenied(error: unknown): boolean {
  return error instanceof ReviewControlHttpError && [401, 403, 404].includes(error.status);
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "The request could not be completed.";

export interface AccessBinding {
  readonly identity: string;
  readonly permissions: string | null;
}
export function permissionSignature(context: C.OperatorAccessContext | undefined): string | null {
  if (!context) return null;
  return JSON.stringify({
    platform: context.platformAdministrator,
    repository: context.repository
      ? {
          repositoryId: context.repository.repositoryId,
          role: context.repository.role,
          source: context.repository.source,
          permissions: [...context.repository.permissions].sort(),
        }
      : null,
  });
}
export function nextAccessBinding(
  previous: AccessBinding,
  identity: string,
  verifiedPermissions: string | null,
): AccessBinding {
  if (previous.identity !== identity) return { identity, permissions: verifiedPermissions };
  if (verifiedPermissions !== null && previous.permissions !== verifiedPermissions)
    return { identity, permissions: verifiedPermissions };
  return previous;
}

export function bindingAllowsConfigure(binding: AccessBinding): boolean {
  if (binding.permissions === null) return false;
  const authority = JSON.parse(binding.permissions) as {
    platform: boolean;
    repository: { permissions: string[] } | null;
  };
  return authority.platform || authority.repository?.permissions.includes("configure") === true;
}

/** The API is paged globally; load a bounded complete catalog before separating PR and Issue views. */
export async function collectCatalog<T extends { id: string }>(
  load: (page: number) => Promise<{ items: T[]; total: number }>,
): Promise<T[]> {
  const items: T[] = [],
    ids = new Set<string>();
  let total: number | undefined,
    bytes = 0;
  for (let page = 1; ; page += 1) {
    const result = await load(page);
    total ??= result.total;
    if (result.total !== total || total > 10_000 || result.items.length > 50)
      throw new Error(
        "The catalog changed or exceeds this view's limit. Refresh before continuing.",
      );
    for (const item of result.items) {
      if (ids.has(item.id))
        throw new Error("The catalog changed while loading. Refresh to try again.");
      ids.add(item.id);
      bytes += new TextEncoder().encode(JSON.stringify(item)).byteLength;
      if (bytes > 32 * 1024 * 1024)
        throw new Error("The catalog exceeds the dashboard byte limit.");
      items.push(item);
    }
    if (items.length === total) return items;
    if (items.length > total || result.items.length < 50)
      throw new Error("The catalog ended before all records were available. Refresh to try again.");
  }
}

export interface MutationState<T> {
  readonly request: T | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly conflict: boolean;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** An uncertain response retains the original request. Permission checking does not reset this owner. */
export class OriginalMutation<T> {
  #state: MutationState<T> = { request: null, busy: false, error: null, conflict: false };
  #listeners = new Set<() => void>();
  #generation = 0;
  #disposed = false;
  readonly snapshot = () => this.#state;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #set(state: MutationState<T>) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  reset() {
    this.#generation += 1;
    this.#set({ request: null, busy: false, error: null, conflict: false });
  }
  activate() {
    this.#disposed = false;
  }
  dispose() {
    this.#disposed = true;
    this.reset();
    this.#listeners.clear();
  }
  async run<R>(
    input: T,
    execute: (request: T) => Promise<R>,
    success: (result: R) => void,
    denied: () => void,
  ): Promise<void> {
    if (this.#disposed || this.#state.busy) return;
    const request = this.#state.request ?? freeze(structuredClone(input));
    const generation = this.#generation;
    this.#set({ request, busy: true, error: null, conflict: false });
    let result: R;
    try {
      result = await execute(request);
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return;
      if (accessDenied(error)) {
        this.reset();
        denied();
        return;
      }
      const rejected =
        error instanceof ReviewControlRequestError ||
        (error instanceof ReviewControlHttpError && [400, 409, 422].includes(error.status));
      this.#set({
        request: rejected ? null : request,
        busy: false,
        error: errorMessage(error),
        conflict: error instanceof ReviewControlHttpError && error.status === 409,
      });
      return;
    }
    if (this.#disposed || generation !== this.#generation) return;
    this.#set({ request: null, busy: false, error: null, conflict: false });
    success(result);
  }
}
