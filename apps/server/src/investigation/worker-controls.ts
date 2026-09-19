import {
  DateTimeSchema,
  EntityIdSchema,
  type InvestigationTaskKind,
  InvestigationTaskKindSchema,
  type InvestigationWorkerControl,
  type InvestigationWorkerControlUpdate,
  InvestigationWorkerControlUpdateSchema,
  type InvestigationWorkerPolicy,
  type InvestigationWorkerPolicyRequest,
  InvestigationWorkerPolicyRequestSchema,
  isInvestigationStaticTaskKind,
  PositiveIntegerSchema,
} from "@agentic-review/contracts";
import { FormatRegistry, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { requireCondition } from "./errors.js";
import type { InvestigationResourceLease } from "./resource-scheduler.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal, InvestigationWorkerPrincipal } from "./types.js";

const controlPrefix = "worker-control:v1:";
const auditPrefix = "worker-control-audit:v1:";
const StoredControlSchema = Type.Object(
  {
    recordType: Type.Literal("InvestigationWorkerControlV1"),
    id: EntityIdSchema,
    repositoryIds: Type.Array(EntityIdSchema, { uniqueItems: true }),
    e2eEnabled: Type.Boolean(),
    version: PositiveIntegerSchema,
    updatedAt: DateTimeSchema,
    updatedBy: Type.Union([EntityIdSchema, Type.Null()]),
    lastSeenAt: Type.Union([DateTimeSchema, Type.Null()]),
    advertisedKinds: Type.Union([
      Type.Array(InvestigationTaskKindSchema, { minItems: 1, uniqueItems: true }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
type StoredControl = Omit<
  InvestigationWorkerControl,
  "effectiveKinds" | "status" | "activeE2eTaskIds" | "cleanupPendingAttemptIds"
> & { recordType: "InvestigationWorkerControlV1" };

export interface InvestigationWorkerControlAudit {
  readonly workerId: string;
  readonly version: number;
  readonly actorId: string;
  readonly recordedAt: string;
  readonly previousE2eEnabled: boolean;
  readonly e2eEnabled: boolean;
}

/** Durable task admission policy; authenticated observations never grant E2E permission. */
export class InvestigationWorkerControls {
  constructor(
    private readonly store: InvestigationStore,
    private readonly now: () => Date = () => new Date(),
    private readonly onlineWindowMs = 120_000,
  ) {
    if (!FormatRegistry.Has("date-time"))
      FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  }

  initialize(workers: readonly InvestigationWorkerPrincipal[]): void {
    this.atomic(() => {
      for (const worker of workers) this.ensure(worker);
    });
  }

  list(actor: InvestigationOperatorPrincipal): { items: InvestigationWorkerControl[] } {
    this.requireAdmin(actor);
    const records: StoredControl[] = [];
    let afterId: string | undefined;
    for (;;) {
      const page = this.store.pagePrefix<StoredControl>(
        "idempotency",
        controlPrefix,
        1_000,
        false,
        afterId,
      );
      for (const entry of page) this.validate(entry);
      records.push(...page);
      if (page.length < 1_000) break;
      afterId = controlKey(page.at(-1)!.id);
    }
    return { items: records.map((entry) => this.project(entry)) };
  }

  get(workerId: string): InvestigationWorkerControl | undefined {
    const record = this.read(workerId);
    return record === undefined ? undefined : this.project(record);
  }

  /** Only authenticated requests update lastSeenAt. Claims can pass their advertised kinds. */
  observe(
    worker: InvestigationWorkerPrincipal,
    supportedKinds?: readonly InvestigationTaskKind[],
  ): InvestigationWorkerPolicy {
    return this.atomic(() => {
      const previous = this.ensure(worker);
      if (supportedKinds !== undefined) this.validateKinds(supportedKinds);
      const next: StoredControl = {
        ...previous,
        lastSeenAt: this.now().toISOString(),
        advertisedKinds:
          supportedKinds === undefined ? previous.advertisedKinds : [...supportedKinds],
      };
      this.store.put("idempotency", controlKey(worker.id), next);
      return this.policyResponse(next);
    });
  }

  policy(
    worker: InvestigationWorkerPrincipal,
    request: InvestigationWorkerPolicyRequest,
  ): InvestigationWorkerPolicy {
    requireCondition(
      Value.Check(InvestigationWorkerPolicyRequestSchema, request),
      400,
      "invalid_worker_policy_request",
      "Worker policy requests require supported task kinds.",
    );
    return this.observe(worker, request.supportedKinds);
  }

  allowsE2e(worker: InvestigationWorkerPrincipal): boolean {
    return this.atomic(() => this.ensure(worker).e2eEnabled);
  }

  /** The cancellation callback participates in the same transaction as the policy change. */
  update(
    actor: InvestigationOperatorPrincipal,
    workerId: string,
    request: InvestigationWorkerControlUpdate,
    onDisabled: () => void,
  ): InvestigationWorkerControl {
    this.requireAdmin(actor);
    requireCondition(
      Value.Check(InvestigationWorkerControlUpdateSchema, request),
      400,
      "invalid_worker_control_update",
      "Worker control updates require an exact version and E2E setting.",
    );
    return this.atomic(() => {
      const previous = this.read(workerId);
      requireCondition(
        previous !== undefined,
        404,
        "worker_not_found",
        "The worker is not registered.",
      );
      requireCondition(
        previous.version === request.version,
        409,
        "worker_control_version_conflict",
        "The worker control changed; refresh before trying again.",
      );
      const next: StoredControl = {
        ...previous,
        e2eEnabled: request.e2eEnabled,
        version: previous.version + 1,
        updatedAt: this.now().toISOString(),
        updatedBy: actor.id,
      };
      this.validate(next);
      this.store.put("idempotency", controlKey(workerId), next);
      this.store.insert(
        "idempotency",
        `${auditPrefix}${workerId}:${String(next.version).padStart(16, "0")}`,
        {
          workerId,
          version: next.version,
          actorId: actor.id,
          recordedAt: next.updatedAt,
          previousE2eEnabled: previous.e2eEnabled,
          e2eEnabled: next.e2eEnabled,
        } satisfies InvestigationWorkerControlAudit,
      );
      if (!next.e2eEnabled) onDisabled();
      return this.project(next);
    });
  }

  private ensure(worker: InvestigationWorkerPrincipal): StoredControl {
    const previous = this.read(worker.id);
    const next: StoredControl =
      previous === undefined
        ? {
            recordType: "InvestigationWorkerControlV1",
            id: worker.id,
            repositoryIds: [...worker.repositoryIds],
            e2eEnabled: false,
            version: 1,
            updatedAt: this.now().toISOString(),
            updatedBy: null,
            lastSeenAt: null,
            advertisedKinds: null,
          }
        : { ...previous, repositoryIds: [...worker.repositoryIds] };
    this.validate(next);
    if (
      previous === undefined ||
      JSON.stringify(previous.repositoryIds) !== JSON.stringify(next.repositoryIds)
    )
      this.store.put("idempotency", controlKey(worker.id), next);
    return next;
  }

  private read(workerId: string): StoredControl | undefined {
    const record = this.store.get<StoredControl>("idempotency", controlKey(workerId));
    if (record !== undefined) {
      this.validate(record);
      requireCondition(
        record.id === workerId,
        500,
        "invalid_worker_control",
        "The worker control identity is inconsistent.",
      );
    }
    return record;
  }

  private validate(record: unknown): asserts record is StoredControl {
    requireCondition(
      Value.Check(StoredControlSchema, record),
      500,
      "invalid_worker_control",
      "The stored worker control is invalid.",
    );
  }

  private validateKinds(supportedKinds: readonly InvestigationTaskKind[]): void {
    requireCondition(
      Value.Check(InvestigationWorkerPolicyRequestSchema, { supportedKinds }),
      400,
      "invalid_worker_policy_request",
      "Worker policy requests require supported task kinds.",
    );
  }

  private policyResponse(record: StoredControl): InvestigationWorkerPolicy {
    return {
      workerId: record.id,
      version: record.version,
      e2eEnabled: record.e2eEnabled,
      effectiveKinds: (record.advertisedKinds ?? []).filter(
        (kind) => record.e2eEnabled || isInvestigationStaticTaskKind(kind),
      ),
    };
  }

  private project(record: StoredControl): InvestigationWorkerControl {
    const outstanding = this.store.list<InvestigationResourceLease>(
      "resourceLeases",
      (lease) => lease.workerId === record.id && lease.pool === "e2e" && lease.state !== "released",
    );
    const effectiveKinds = this.policyResponse(record).effectiveKinds;
    const online =
      record.lastSeenAt !== null &&
      this.now().getTime() - Date.parse(record.lastSeenAt) < this.onlineWindowMs;
    const status =
      !record.e2eEnabled && outstanding.length > 0
        ? online
          ? "disabling"
          : "awaiting_confirmation"
        : record.e2eEnabled && (record.advertisedKinds === null || !online)
          ? "awaiting_confirmation"
          : effectiveKinds.some((kind) => !isInvestigationStaticTaskKind(kind))
            ? "e2e_enabled"
            : "static_only";
    const { recordType: _recordType, ...control } = record;
    return {
      ...control,
      effectiveKinds,
      status,
      activeE2eTaskIds: [...new Set(outstanding.map((lease) => lease.taskId))],
      cleanupPendingAttemptIds: outstanding
        .filter((lease) => lease.state === "needs_cleanup")
        .map((lease) => lease.attemptId),
    };
  }

  private requireAdmin(actor: InvestigationOperatorPrincipal): void {
    requireCondition(
      actor.isAdmin === true,
      403,
      "administrator_required",
      "Worker controls require an administrator.",
    );
  }

  private atomic<T>(operation: () => T): T {
    return this.store.inTransaction ? operation() : this.store.transaction(operation);
  }
}

function controlKey(workerId: string): string {
  return `${controlPrefix}${workerId}`;
}
