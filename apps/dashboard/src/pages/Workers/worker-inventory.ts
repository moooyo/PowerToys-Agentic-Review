import type { WorkerState } from "@agentic-review/contracts";
import type {
  WorkerCredential,
  WorkerCredentialAuthState,
  WorkerNode,
} from "@/services/review-control";

export type WorkerInventoryAuthState = WorkerCredentialAuthState | "unknown";
export type WorkerInventoryRuntimeState = WorkerState | "not_connected";

export const DEFAULT_WORKER_INVENTORY_PAGE_SIZE = 50;
export const MAX_WORKER_INVENTORY_PAGE_SIZE = 200;

export interface WorkerInventoryRow {
  workerNodeId: string;
  displayName: string;
  authState: WorkerInventoryAuthState;
  runtimeState: WorkerInventoryRuntimeState;
  credential?: WorkerCredential;
  runtime?: WorkerNode;
}

export interface WorkerInventoryFilter {
  search?: string;
  authState?: string | string[];
  runtimeState?: string | string[];
}

export interface WorkerInventoryPage {
  items: WorkerInventoryRow[];
  total: number;
}

export interface WorkerInventorySnapshotCache {
  invalidate(): void;
  load(): Promise<WorkerInventoryRow[]>;
}

const canonicalWorkerNodeIdPattern =
  /^worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const isCanonicalWorkerNodeId = (workerNodeId: string): boolean =>
  canonicalWorkerNodeIdPattern.test(workerNodeId);

const selected = (actual: string, expected: string | string[] | undefined): boolean => {
  if (expected === undefined) {
    return true;
  }
  return Array.isArray(expected)
    ? expected.length === 0 || expected.includes(actual)
    : expected === actual;
};

export const mergeWorkerInventory = (
  credentials: readonly WorkerCredential[],
  workers: readonly WorkerNode[],
): WorkerInventoryRow[] => {
  const rows = new Map<string, WorkerInventoryRow>();

  for (const credential of credentials) {
    rows.set(credential.workerNodeId, {
      workerNodeId: credential.workerNodeId,
      displayName: credential.displayName,
      authState: credential.authState,
      runtimeState: "not_connected",
      credential,
    });
  }

  for (const worker of workers) {
    const existing = rows.get(worker.id);
    rows.set(worker.id, {
      workerNodeId: worker.id,
      displayName: existing?.displayName ?? worker.displayName,
      authState: existing?.authState ?? "unknown",
      runtimeState: worker.status,
      ...(existing?.credential === undefined ? {} : { credential: existing.credential }),
      runtime: worker,
    });
  }

  return [...rows.values()];
};

export const filterWorkerInventory = (
  rows: readonly WorkerInventoryRow[],
  filter: WorkerInventoryFilter,
): WorkerInventoryRow[] => {
  const search = filter.search?.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (
      !selected(row.authState, filter.authState) ||
      !selected(row.runtimeState, filter.runtimeState)
    ) {
      return false;
    }
    if (!search) {
      return true;
    }
    const values = [
      row.workerNodeId,
      row.displayName,
      row.runtime?.instanceId,
      row.runtime?.location,
      row.runtime?.version,
      ...(row.runtime?.capabilities ?? []),
      ...(row.runtime?.currentJobs ?? []),
    ];
    return values.some((value) => value?.toLocaleLowerCase().includes(search));
  });
};

export const paginateWorkerInventory = (
  rows: readonly WorkerInventoryRow[],
  current: number | undefined,
  pageSize: number | undefined,
): WorkerInventoryPage => {
  const normalizedCurrent =
    Number.isSafeInteger(current) && (current ?? 0) > 0 ? (current ?? 1) : 1;
  const requestedPageSize =
    Number.isSafeInteger(pageSize) && (pageSize ?? 0) > 0
      ? (pageSize ?? DEFAULT_WORKER_INVENTORY_PAGE_SIZE)
      : DEFAULT_WORKER_INVENTORY_PAGE_SIZE;
  const normalizedPageSize = Math.min(requestedPageSize, MAX_WORKER_INVENTORY_PAGE_SIZE);
  const offset = (normalizedCurrent - 1) * normalizedPageSize;
  return {
    items: Number.isSafeInteger(offset) ? rows.slice(offset, offset + normalizedPageSize) : [],
    total: rows.length,
  };
};

export const createWorkerInventorySnapshotCache = (
  loadSnapshot: () => Promise<WorkerInventoryRow[]>,
): WorkerInventorySnapshotCache => {
  let cached: Promise<WorkerInventoryRow[]> | undefined;
  return {
    invalidate: () => {
      cached = undefined;
    },
    load: () => {
      if (cached !== undefined) {
        return cached;
      }
      const pending = loadSnapshot();
      cached = pending;
      void pending.catch(() => {
        if (cached === pending) {
          cached = undefined;
        }
      });
      return pending;
    },
  };
};
