/** The task allowance available to one invocation, before any of its usage is charged. */
export interface ModelInvocationBudget {
  readonly deadlineAtMs: number;
}

export class ModelBudgetExceededError extends Error {
  public readonly code = "MODEL_BUDGET_EXCEEDED";

  public constructor(public readonly kind: "duration") {
    super("The remaining task execution duration was exhausted.");
    this.name = "ModelBudgetExceededError";
  }
}

/** Accounting and cleanup can wrap the original stop without changing its budget identity. */
export function findModelBudgetExceeded(error: unknown): ModelBudgetExceededError | null {
  const visited = new Set<object>();
  const find = (value: unknown): ModelBudgetExceededError | null => {
    if (typeof value !== "object" || value === null || visited.has(value)) return null;
    visited.add(value);
    if (value instanceof ModelBudgetExceededError) return value;
    if ("cause" in value) {
      const cause = find(value.cause);
      if (cause !== null) return cause;
    }
    if (value instanceof AggregateError) {
      for (const nested of value.errors) {
        const found = find(nested);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return find(error);
}
