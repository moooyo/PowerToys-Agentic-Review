import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { ReviewControlHttpError } from "@/services/review-control/errors";

export function publicationAccessDenied(error: unknown): boolean {
  return error instanceof ReviewControlHttpError && [401, 403, 404].includes(error.status);
}

// A missing object and a concealed access denial have the same terminal read behavior.
// Retain active error records: removing an observed query makes React Query recreate it.
export class PublicationReadGuard {
  private error: unknown;
  private blocked = false;
  private active = true;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly client: QueryClient,
    private readonly prefixes: readonly QueryKey[],
  ) {}

  readonly snapshot = () => this.blocked;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  activate(): void {
    this.active = true;
  }

  deny(error: unknown): void {
    if (!this.active || this.blocked || !publicationAccessDenied(error)) return;
    this.error = error;
    this.blocked = true;
    for (const listener of this.listeners) listener();
    for (const queryKey of this.prefixes) {
      void this.client.cancelQueries({ queryKey });
      for (const query of this.client.getQueryCache().findAll({ queryKey })) {
        query.setState({
          data: undefined,
          error: error as Error,
          status: "error",
          fetchStatus: "idle",
        });
      }
      this.client.removeQueries({
        queryKey,
        predicate: (query) => query.getObserversCount() === 0,
      });
    }
  }

  async read<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.active) throw new Error("The publication read scope is no longer active.");
    if (this.blocked) throw this.error;
    const generation = this.generation;
    try {
      const value = await operation();
      if (!this.active || generation !== this.generation)
        throw new Error("The publication read scope is no longer active.");
      if (this.blocked) throw this.error;
      return value;
    } catch (error) {
      if (this.active && generation === this.generation) this.deny(error);
      throw error;
    }
  }

  dispose(): void {
    this.active = false;
    this.generation += 1;
    this.listeners.clear();
    // Query observers consume AbortSignal and cancel their own unmounted reads. A sibling
    // observer can still own the same prefix, so unmount must never evict its active query.
    for (const queryKey of this.prefixes)
      this.client.removeQueries({
        queryKey,
        predicate: (query) => query.getObserversCount() === 0,
      });
  }
}
