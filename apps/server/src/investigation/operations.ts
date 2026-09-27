import { realpath, stat, statfs } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import type { InvestigationEvidencePolicy } from "./evidence-store.js";
import { type InvestigationStore, investigationSchemaVersion } from "./store.js";
import type { InvestigationOperatorAuthenticator } from "./types.js";

export const investigationOperationsSchemaVersion = "InvestigationOperationsStatusV1";

type TaskState =
  | "queued"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";
type ResourcePool = "static" | "e2e" | "unknown";
type ResourceState = "held" | "needs_cleanup" | "released" | "unknown";

export interface InvestigationOperationsFile {
  readonly status: "present" | "missing" | "unavailable" | "in_memory";
  /** Decimal bytes preserve the exact file length beyond JavaScript's safe integer range. */
  readonly byteLength: string | null;
}

export interface InvestigationOperationsFileSystem {
  readonly status: "available" | "unavailable" | "in_memory";
  readonly totalBytes: string | null;
  readonly freeBytes: string | null;
  readonly availableBytes: string | null;
}

export interface InvestigationOperationsDatabase {
  readonly files: {
    readonly database: InvestigationOperationsFile;
    readonly wal: InvestigationOperationsFile;
    readonly sharedMemory: InvestigationOperationsFile;
  };
  readonly fileSystem: InvestigationOperationsFileSystem;
}

export interface InvestigationOperationsStatus {
  readonly schemaVersion: typeof investigationOperationsSchemaVersion;
  readonly sampleStartedAt: string;
  readonly sampledAt: string;
  readonly runtime: {
    readonly processUptimeSeconds: number;
    readonly processStartedAt: string;
    readonly nodeVersion: string;
  };
  readonly storage: {
    readonly investigation: InvestigationOperationsDatabase & {
      readonly schemaVersion: typeof investigationSchemaVersion;
      readonly sqlite: {
        readonly pageSizeBytes: number;
        readonly pageCount: number;
        readonly freePageCount: number;
        readonly logicalBytes: string;
        readonly reusableBytes: string;
        readonly journalMode: string;
      };
    };
    readonly authentication: InvestigationOperationsDatabase;
  };
  readonly tasks: { readonly total: number; readonly byState: Record<TaskState, number> };
  readonly resourceLeases: {
    readonly total: number;
    readonly byPoolAndState: Record<ResourcePool, Record<ResourceState, number>>;
  };
  readonly evidence: InvestigationEvidencePolicy & {
    readonly retainedBytes: number;
    readonly count: number;
  };
}

export interface InvestigationOperationsDependencies {
  readonly now?: () => Date;
  readonly uptime?: () => number;
  readonly realpath?: (path: string) => Promise<string>;
  readonly stat?: (path: string) => Promise<{ readonly size: bigint; isFile(): boolean }>;
  readonly statfs?: (path: string) => Promise<{
    readonly bsize: bigint;
    readonly blocks: bigint;
    readonly bfree: bigint;
    readonly bavail: bigint;
  }>;
}

/** Administrator-only, read-only measurements; sampling never checkpoints or deletes data. */
export class InvestigationOperations {
  private readonly now: () => Date;
  private readonly uptime: () => number;
  private readonly resolvePath: NonNullable<InvestigationOperationsDependencies["realpath"]>;
  private readonly fileStat: NonNullable<InvestigationOperationsDependencies["stat"]>;
  private readonly fileSystemStat: NonNullable<InvestigationOperationsDependencies["statfs"]>;
  private readonly processStartedAt: string;
  private cached: InvestigationOperationsStatus | undefined;
  private pending: Promise<InvestigationOperationsStatus> | undefined;
  private cachedAtUptime = 0;

  constructor(
    private readonly options: {
      readonly store: InvestigationStore;
      readonly databasePath: string;
      readonly authDatabasePath: string;
      readonly evidencePolicy: InvestigationEvidencePolicy;
    },
    dependencies: InvestigationOperationsDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.uptime = dependencies.uptime ?? (() => process.uptime());
    this.resolvePath = dependencies.realpath ?? realpath;
    this.processStartedAt = new Date(this.now().getTime() - this.uptime() * 1_000).toISOString();
    this.fileStat = dependencies.stat ?? ((path) => stat(path, { bigint: true }));
    this.fileSystemStat = dependencies.statfs ?? ((path) => statfs(path, { bigint: true }));
  }

  /** The route authenticates every request, including cache hits and shared in-flight samples. */
  read(): Promise<InvestigationOperationsStatus> {
    const elapsed = this.uptime() - this.cachedAtUptime;
    if (this.cached !== undefined && elapsed >= 0 && elapsed < 5)
      return Promise.resolve(this.cached);
    this.pending ??= this.sample().then(
      (snapshot) => {
        this.cached = snapshot;
        this.cachedAtUptime = snapshot.runtime.processUptimeSeconds;
        this.pending = undefined;
        return snapshot;
      },
      () => {
        this.pending = undefined;
        throw new InvestigationRequestError(
          503,
          "operations_snapshot_unavailable",
          "The operations snapshot is temporarily unavailable.",
        );
      },
    );
    return this.pending;
  }

  private async sample(): Promise<InvestigationOperationsStatus> {
    const sampleStartedAt = this.now().toISOString();
    const statistics = this.options.store.operationsStatistics();
    const byState: Record<TaskState, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      unknown: 0,
    };
    const byPoolAndState: Record<ResourcePool, Record<ResourceState, number>> = {
      static: { held: 0, needs_cleanup: 0, released: 0, unknown: 0 },
      e2e: { held: 0, needs_cleanup: 0, released: 0, unknown: 0 },
      unknown: { held: 0, needs_cleanup: 0, released: 0, unknown: 0 },
    };
    for (const entry of statistics.taskStates) {
      const state = Object.hasOwn(byState, entry.state) ? (entry.state as TaskState) : "unknown";
      byState[state] += nonNegativeInteger(entry.count);
    }
    for (const entry of statistics.resourceLeaseStates) {
      const pool = Object.hasOwn(byPoolAndState, entry.pool)
        ? (entry.pool as ResourcePool)
        : "unknown";
      const state = Object.hasOwn(byPoolAndState[pool], entry.state)
        ? (entry.state as ResourceState)
        : "unknown";
      byPoolAndState[pool][state] += nonNegativeInteger(entry.count);
    }
    const pageSizeBytes = nonNegativeInteger(statistics.pageSizeBytes);
    const pageCount = nonNegativeInteger(statistics.pageCount);
    const freePageCount = nonNegativeInteger(statistics.freePageCount);
    requireCondition(
      pageSizeBytes > 0 && freePageCount <= pageCount,
      503,
      "operations_snapshot_unavailable",
      "The operations snapshot is temporarily unavailable.",
    );
    const [investigation, authentication] = await Promise.all([
      this.databaseFiles(this.options.databasePath),
      this.databaseFiles(this.options.authDatabasePath),
    ]);
    return {
      schemaVersion: investigationOperationsSchemaVersion,
      sampleStartedAt,
      sampledAt: this.now().toISOString(),
      runtime: {
        processUptimeSeconds: this.uptime(),
        processStartedAt: this.processStartedAt,
        nodeVersion: process.versions.node,
      },
      storage: {
        investigation: {
          ...investigation,
          schemaVersion: investigationSchemaVersion,
          sqlite: {
            pageSizeBytes,
            pageCount,
            freePageCount,
            logicalBytes: (BigInt(pageSizeBytes) * BigInt(pageCount)).toString(),
            reusableBytes: (BigInt(pageSizeBytes) * BigInt(freePageCount)).toString(),
            journalMode: statistics.journalMode,
          },
        },
        authentication,
      },
      tasks: { total: Object.values(byState).reduce(sum, 0), byState },
      resourceLeases: {
        total: Object.values(byPoolAndState)
          .flatMap((pool) => Object.values(pool))
          .reduce(sum, 0),
        byPoolAndState,
      },
      evidence: {
        maximumBytes: this.options.evidencePolicy.maximumBytes,
        maximumCount: this.options.evidencePolicy.maximumCount,
        retentionSeconds: this.options.evidencePolicy.retentionSeconds,
        cleanupIntervalSeconds: this.options.evidencePolicy.cleanupIntervalSeconds,
        cleanupBatchSize: this.options.evidencePolicy.cleanupBatchSize,
        retainedBytes: nonNegativeInteger(statistics.evidenceUsage.bytes),
        count: nonNegativeInteger(statistics.evidenceUsage.count),
      },
    };
  }

  private async databaseFiles(path: string): Promise<InvestigationOperationsDatabase> {
    if (path === ":memory:") {
      return {
        files: {
          database: { status: "in_memory", byteLength: null },
          wal: { status: "in_memory", byteLength: null },
          sharedMemory: { status: "in_memory", byteLength: null },
        },
        fileSystem: {
          status: "in_memory",
          totalBytes: null,
          freeBytes: null,
          availableBytes: null,
        },
      };
    }
    const [database, wal, sharedMemory, fileSystem] = await Promise.all([
      this.file(path),
      this.file(`${path}-wal`),
      this.file(`${path}-shm`),
      this.fileSystem(path),
    ]);
    return { files: { database, wal, sharedMemory }, fileSystem };
  }

  private async file(path: string): Promise<InvestigationOperationsFile> {
    try {
      const entry = await this.fileStat(path);
      if (entry.isFile() && entry.size >= 0n)
        return { status: "present", byteLength: entry.size.toString() };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return { status: "missing", byteLength: null };
    }
    return { status: "unavailable", byteLength: null };
  }

  private async fileSystem(path: string): Promise<InvestigationOperationsFileSystem> {
    try {
      const entry = await this.fileSystemStat(await this.resolvePath(path));
      if (entry.bsize > 0n && entry.blocks >= 0n && entry.bfree >= 0n && entry.bavail >= 0n)
        return {
          status: "available",
          totalBytes: (entry.bsize * entry.blocks).toString(),
          freeBytes: (entry.bsize * entry.bfree).toString(),
          availableBytes: (entry.bsize * entry.bavail).toString(),
        };
    } catch {
      // Unsupported filesystems and permission failures are unavailable measurements, not zeros.
    }
    return { status: "unavailable", totalBytes: null, freeBytes: null, availableBytes: null };
  }
}

function nonNegativeInteger(value: number): number {
  requireCondition(
    Number.isSafeInteger(value) && value >= 0,
    503,
    "operations_snapshot_unavailable",
    "The operations snapshot is temporarily unavailable.",
  );
  return value;
}

function sum(total: number, value: number): number {
  return nonNegativeInteger(total + value);
}

export function registerInvestigationOperationsRoute(
  app: FastifyInstance,
  dependencies: {
    readonly authenticateOperator: InvestigationOperatorAuthenticator;
    readonly operations: InvestigationOperations;
  },
): void {
  app.get("/api/operations/status", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const actor = await dependencies.authenticateOperator(request);
    requireCondition(
      actor !== null,
      401,
      "operator_authentication_required",
      "Operator authentication is required.",
    );
    requireCondition(
      actor.isAdmin === true,
      403,
      "administrator_required",
      "Operations status requires an administrator.",
    );
    return dependencies.operations.read();
  });
}
