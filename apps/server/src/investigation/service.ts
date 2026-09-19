import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  InvestigationActionGuard,
  InvestigationArtifactV1,
  InvestigationAttemptV1,
  InvestigationBudget,
  InvestigationCheckpointRequest,
  InvestigationClaimRequest,
  InvestigationClaimResponse,
  InvestigationCleanupRequest,
  InvestigationCreateTaskRequestV1,
  InvestigationFinalizeRequest,
  InvestigationFindingsPageV1,
  InvestigationHeartbeatRequest,
  InvestigationInputSnapshotV1,
  InvestigationLoopCheckpointV1,
  InvestigationModelInvocationReceipt,
  InvestigationPlanExecutionBinding,
  InvestigationPlanV1,
  InvestigationProgressRequest,
  InvestigationReportPartRequest,
  InvestigationReportPartV1,
  InvestigationResultV1,
  InvestigationSchedulerSettingsRequest,
  InvestigationSchedulerStatus,
  InvestigationSubjectV1,
  InvestigationTaskV1,
  InvestigationUsageSummary,
  InvestigationWorkerLease,
} from "@agentic-review/contracts";
import {
  EntityIdSchema,
  InvestigationCreateTaskRequestV1Schema,
  InvestigationInputSnapshotV1Schema,
  Sha256Schema,
  validateInvestigationAnalysisForTask,
  validateInvestigationTask,
} from "@agentic-review/contracts";
import {
  applyInvestigationLoopRound,
  applyInvestigationRuntimeCheckpoint,
  applyInvestigationSourceCoverage,
  createInvestigationCheckpoint,
  hasInvestigationSemanticProgress,
  increaseInvestigationBudget,
  interruptInvestigationLoop,
  investigationContentDigest,
  projectInvestigationTokenConsumption,
  projectRecordedE2eAnalysis,
  restoreCompletedInvestigationForDelivery,
  restoreInvestigationCheckpoint,
} from "@agentic-review/domain";
import { FormatRegistry, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { InvestigationActions } from "./actions.js";
import {
  attemptHasVerifiedNoModelInvocation,
  recordAttemptWithoutModelInvocation,
} from "./attempt-usage-coverage.js";
import { validateRootE2eRuntime } from "./e2e-runtime.js";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import { type InvestigationEvidencePolicy, InvestigationEvidenceStore } from "./evidence-store.js";
import { constantTimeEqual, encodeCursor, parseCursor } from "./integrity.js";
import {
  type InvestigationDirectoryQuery,
  type InvestigationFindingsQuery,
  InvestigationRepositoryRecordSchema,
  type InvestigationResumeTaskRequest,
  InvestigationWorkItemRecordSchema,
} from "./protocol.js";
import { assembleInvestigationReport, reportHeader } from "./report.js";
import { InvestigationResourceScheduler, investigationResourcePool } from "./resource-scheduler.js";
import type { InvestigationStore } from "./store.js";
import {
  beginInvestigationProgress,
  investigationTaskProgress,
  recordInvestigationActivity,
  recordInvestigationCleanup,
  recordInvestigationHeartbeat,
  recordMeaningfulInvestigationProgress,
} from "./task-progress.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
  InvestigationPrerequisiteResolver,
  InvestigationRepositoryRecord,
  InvestigationWorkerPrincipal,
  InvestigationWorkItemRecord,
} from "./types.js";
import {
  InvestigationUsageLedgerError,
  investigationUsageInvocations,
  investigationUsageSummary,
  recordInvestigationUsage,
} from "./usage-ledger.js";

interface AttemptRecord {
  attempt: InvestigationAttemptV1;
  leaseTokenDigest: string;
  leaseExpiresAt: string;
  reportId: string;
  cancelRequested: boolean;
}
interface FrozenTaskInput {
  inputSnapshot: InvestigationInputSnapshotV1;
  plan: InvestigationPlanV1 | null;
  execution: InvestigationPlanExecutionBinding | null;
}
export type InvestigationPreparedTaskInput = FrozenTaskInput;
export interface InvestigationImportedTaskSource {
  readonly workItem: InvestigationWorkItemRecord;
  readonly snapshotRef: { readonly id: string; readonly digest: string };
}
const importedTaskSourceSchema = Type.Object(
  {
    workItem: InvestigationWorkItemRecordSchema,
    snapshotRef: Type.Object(
      { id: EntityIdSchema, digest: Sha256Schema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const importedSnapshotSchema = Type.Object(
  {
    id: EntityIdSchema,
    digest: Sha256Schema,
    inputSnapshot: InvestigationInputSnapshotV1Schema,
  },
  { additionalProperties: false },
);
interface IdempotencyRecord {
  digest: string;
  entityId: string;
}
interface CheckpointAcceptanceRecord {
  digest: string;
  checkpoint: InvestigationLoopCheckpointV1;
  usageTokens?: number;
}
export interface InvestigationServiceOptions {
  store: InvestigationStore;
  actionTransport?: InvestigationActionTransport;
  enableExternalWrites?: boolean;
  now?: () => Date;
  idFactory?: () => string;
  leaseDurationMs?: number;
  staticConcurrency?: number;
  defaultTaskBudget?: Readonly<Omit<InvestigationBudget, "maxReportBytes">>;
  maxReportBytes?: number;
  evidencePolicy?: Partial<InvestigationEvidencePolicy>;
  resolvePlanPrerequisites?: InvestigationPrerequisiteResolver;
  onReportSealed?: (report: InvestigationResultV1, task: InvestigationTaskV1) => void;
  onTaskStateChanged?: (task: InvestigationTaskV1, report?: InvestigationResultV1) => void;
  onTaskUsageChanged?: (task: InvestigationTaskV1) => void;
  onTaskProgress?: (
    task: InvestigationTaskV1,
    checkpoint: InvestigationLoopCheckpointV1,
    attempt: InvestigationAttemptV1,
  ) => void;
  onRepositoryChanged?: (
    previous: InvestigationRepositoryRecord,
    next: InvestigationRepositoryRecord,
  ) => void;
  resolveTaskSource?: (
    repository: InvestigationRepositoryRecord,
    workItem: InvestigationWorkItemRecord,
    sourceCommit: string,
    actor: InvestigationOperatorPrincipal,
  ) => InvestigationSubjectV1 | Promise<InvestigationSubjectV1>;
  prepareTaskInput?: (
    task: InvestigationTaskV1,
    workItem: InvestigationWorkItemRecord,
    plan: InvestigationPlanV1 | null,
    actor: InvestigationOperatorPrincipal,
  ) => InvestigationPreparedTaskInput | Promise<InvestigationPreparedTaskInput>;
}

export class InvestigationService {
  readonly actions: InvestigationActions;
  readonly evidence: InvestigationEvidenceStore;
  private readonly store: InvestigationStore;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly leaseDurationMs: number;
  private readonly maxReportBytes: number;
  private readonly defaultTaskBudget: Readonly<InvestigationBudget>;
  private readonly resourceScheduler: InvestigationResourceScheduler;

  constructor(private readonly options: InvestigationServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.evidence = new InvestigationEvidenceStore(this.store, options.evidencePolicy, this.now);
    this.idFactory = options.idFactory ?? randomUUID;
    this.leaseDurationMs = options.leaseDurationMs ?? 120_000;
    this.resourceScheduler = new InvestigationResourceScheduler(
      this.store,
      this.now,
      options.staticConcurrency ?? 1,
    );
    this.store.transaction(() => {
      this.resourceScheduler.initialize();
      for (const record of this.store.list<AttemptRecord>(
        "attempts",
        (entry) => entry.attempt.state === "running",
      )) {
        const task = this.required<InvestigationTaskV1>("tasks", record.attempt.taskId);
        requireCondition(
          record.attempt.workerId !== null,
          500,
          "missing_running_attempt_owner",
          "A running attempt must retain its worker identity before resource scheduling starts.",
        );
        this.resourceScheduler.adopt({
          attemptId: record.attempt.id,
          taskId: task.id,
          workerId: record.attempt.workerId,
          fence: record.attempt.leaseVersion,
          pool: investigationResourcePool(task.kind),
        });
      }
    });
    this.maxReportBytes = options.maxReportBytes ?? 64 * 1024 * 1024;
    requireCondition(
      Number.isSafeInteger(this.maxReportBytes) &&
        this.maxReportBytes > 0 &&
        this.maxReportBytes <= 512 * 1024 * 1024,
      500,
      "invalid_report_resource_limit",
      "The configured report byte limit must be a positive safe integer no larger than 512 MiB.",
    );
    const budget =
      options.defaultTaskBudget === undefined
        ? { maxRounds: 24, maxDurationMs: 1_800_000, maxTokens: 120_000 }
        : options.defaultTaskBudget;
    requireCondition(
      budget !== null &&
        typeof budget === "object" &&
        !Array.isArray(budget) &&
        Object.keys(budget).length === 3 &&
        [budget.maxRounds, budget.maxDurationMs, budget.maxTokens].every(
          (value) => Number.isSafeInteger(value) && value > 0,
        ) &&
        budget.maxDurationMs <= 2_147_483_647,
      500,
      "invalid_default_task_budget",
      "Default task budgets require positive safe integer rounds, tokens, and duration no larger than 2147483647 milliseconds.",
    );
    // Deployment configuration affects only future Tasks and cannot be mutated after startup.
    this.defaultTaskBudget = Object.freeze({
      maxRounds: budget.maxRounds,
      maxDurationMs: budget.maxDurationMs,
      maxTokens: budget.maxTokens,
      maxReportBytes: this.maxReportBytes,
    });
    this.actions = new InvestigationActions({
      store: this.store,
      now: this.now,
      idFactory: this.idFactory,
      enableExternalWrites: options.enableExternalWrites ?? false,
      ...(options.actionTransport === undefined ? {} : { transport: options.actionTransport }),
      createTask: (actor, request) => this.createTask(actor, request),
      validateTaskAction: (actor, request) => this.validateTaskAction(actor, request),
      ...(options.resolvePlanPrerequisites === undefined
        ? {}
        : { resolvePlanPrerequisites: options.resolvePlanPrerequisites }),
    });
  }

  private time(): string {
    return this.now().toISOString();
  }
  private scope(principal: { repositoryIds: readonly string[] }, repositoryId: string): void {
    requireCondition(
      principal.repositoryIds.includes(repositoryId),
      403,
      "repository_forbidden",
      "This identity has no access to the repository.",
    );
  }
  private permit(
    actor: InvestigationOperatorPrincipal,
    permission: InvestigationOperatorPrincipal["permissions"][number],
  ): void {
    requireCondition(
      actor.permissions.includes(permission),
      403,
      "permission_denied",
      `The ${permission} permission is required.`,
    );
  }
  private required<T>(collection: Parameters<InvestigationStore["get"]>[0], id: string): T {
    const value = this.store.get<T>(collection, id);
    requireCondition(value !== undefined, 404, "not_found", "The requested object does not exist.");
    return value;
  }
  private task(principal: { repositoryIds: readonly string[] }, id: string): InvestigationTaskV1 {
    const task = this.required<InvestigationTaskV1>("tasks", id);
    this.scope(principal, task.repository.id);
    return task;
  }
  private attempts(taskId: string): AttemptRecord[] {
    return this.store
      .list<AttemptRecord>("attempts", (record) => record.attempt.taskId === taskId)
      .sort((a, b) => a.attempt.number - b.attempt.number);
  }

  listRepositories(actor: InvestigationOperatorPrincipal) {
    return {
      items: this.store.list<InvestigationRepositoryRecord>("repositories", (repository) =>
        actor.repositoryIds.includes(repository.id),
      ),
    };
  }
  registerRepository(
    actor: InvestigationOperatorPrincipal,
    repository: InvestigationRepositoryRecord,
  ) {
    this.permit(actor, "repository:manage");
    this.scope(actor, repository.id);
    requireCondition(
      !this.store
        .list<InvestigationRepositoryRecord>("repositories")
        .some(
          (entry) =>
            entry.id !== repository.id &&
            (entry.githubRepositoryId === repository.githubRepositoryId ||
              entry.fullName.toLowerCase() === repository.fullName.toLowerCase()),
        ),
      409,
      "repository_identity_conflict",
      "This upstream repository is already registered.",
    );
    const previous = this.store.get<InvestigationRepositoryRecord>("repositories", repository.id);
    requireCondition(
      previous === undefined || previous.githubRepositoryId === repository.githubRepositoryId,
      409,
      "repository_identity_conflict",
      "A repository registration cannot change its upstream identity.",
    );
    this.store.transaction(() => {
      if (
        previous !== undefined &&
        investigationContentDigest(previous) !== investigationContentDigest(repository)
      )
        this.options.onRepositoryChanged?.(previous, repository);
      this.store.put("repositories", repository.id, repository);
    });
    return repository;
  }
  listWorkItems(actor: InvestigationOperatorPrincipal, query: InvestigationDirectoryQuery) {
    if (query.repositoryId !== undefined) this.scope(actor, query.repositoryId);
    return {
      items: this.store.list<InvestigationWorkItemRecord>(
        "workItems",
        (item) =>
          actor.repositoryIds.includes(item.repositoryId) &&
          (query.repositoryId === undefined || item.repositoryId === query.repositoryId) &&
          (query.kind === undefined || item.kind === query.kind),
      ),
    };
  }
  registerWorkItem(actor: InvestigationOperatorPrincipal, item: InvestigationWorkItemRecord) {
    this.permit(actor, "repository:manage");
    this.scope(actor, item.repositoryId);
    this.required("repositories", item.repositoryId);
    requireCondition(
      item.subject.repositoryId === item.repositoryId && item.subject.workItemId === item.id,
      400,
      "subject_scope_mismatch",
      "The source subject must belong to this work item and repository.",
    );
    requireCondition(
      item.kind === "pull_request"
        ? item.subject.kind === "original_pr"
        : item.subject.kind === "issue_snapshot",
      400,
      "subject_kind_mismatch",
      "Registration requires the original upstream subject.",
    );
    const previous = this.store.get<InvestigationWorkItemRecord>("workItems", item.id);
    requireCondition(
      previous === undefined ||
        (previous.repositoryId === item.repositoryId &&
          previous.kind === item.kind &&
          previous.number === item.number),
      409,
      "work_item_identity_conflict",
      "An existing work item cannot change its upstream identity.",
    );
    this.store.put("workItems", item.id, item);
    return item;
  }
  getWorkItem(actor: InvestigationOperatorPrincipal, id: string): InvestigationWorkItemRecord {
    const item = this.required<InvestigationWorkItemRecord>("workItems", id);
    this.scope(actor, item.repositoryId);
    return item;
  }
  listTasks(actor: InvestigationOperatorPrincipal, query: InvestigationDirectoryQuery) {
    this.reapExpiredLeases();
    if (query.repositoryId !== undefined) this.scope(actor, query.repositoryId);
    const items = this.store
      .list<InvestigationTaskV1>(
        "tasks",
        (task) =>
          actor.repositoryIds.includes(task.repository.id) &&
          (query.repositoryId === undefined || task.repository.id === query.repositoryId) &&
          (query.workItemId === undefined || task.workItem.id === query.workItemId) &&
          (query.kind === undefined || task.kind === query.kind),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      items,
      usageByTaskId: Object.fromEntries(items.map((task) => [task.id, this.usageSummary(task.id)])),
    };
  }

  async createTask(
    actor: InvestigationOperatorPrincipal,
    request: InvestigationCreateTaskRequestV1,
    persist = true,
  ): Promise<InvestigationTaskV1> {
    return this.createTaskWithSource(actor, request, persist);
  }

  async createImportedTask(
    actor: InvestigationOperatorPrincipal,
    request: InvestigationCreateTaskRequestV1,
    source: InvestigationImportedTaskSource,
    beforePersist?: () => void,
    onPersisted?: (task: InvestigationTaskV1) => void,
  ): Promise<InvestigationTaskV1> {
    if (!FormatRegistry.Has("date-time"))
      FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
    requireCondition(
      Value.Check(InvestigationCreateTaskRequestV1Schema, request) &&
        (request.kind === "pr-review" ||
          request.kind === "issue-investigate" ||
          request.kind === "pr-e2e") &&
        (request.kind === "pr-e2e"
          ? request.executionMode === "execute"
          : request.executionMode !== "execute") &&
        request.parentReportRef === undefined &&
        request.planRef === undefined,
      400,
      "invalid_imported_task_request",
      "Imported tasks require a root investigation or authorized E2E without a parent plan.",
    );
    requireCondition(
      Value.Check(importedTaskSourceSchema, source),
      409,
      "imported_source_mismatch",
      "An imported task requires the complete frozen work item and exact saved snapshot reference.",
    );
    return this.createTaskWithSource(
      actor,
      structuredClone(request),
      true,
      structuredClone(source),
      beforePersist,
      onPersisted,
    );
  }

  private async createTaskWithSource(
    actor: InvestigationOperatorPrincipal,
    request: InvestigationCreateTaskRequestV1,
    persist: boolean,
    importedSource?: InvestigationImportedTaskSource,
    beforePersist?: () => void,
    onPersisted?: (task: InvestigationTaskV1) => void,
  ): Promise<InvestigationTaskV1> {
    this.permit(actor, "task:create");
    const registeredItem = this.getWorkItem(actor, request.workItemId);
    const repository = this.required<InvestigationRepositoryRecord>(
      "repositories",
      registeredItem.repositoryId,
    );
    requireCondition(
      request.budget === undefined || request.budget.maxReportBytes <= this.maxReportBytes,
      400,
      "report_budget_exceeds_server_limit",
      `The report budget exceeds the configured ${this.maxReportBytes}-byte server limit.`,
    );
    const key = `task:${actor.id}:${request.idempotencyKey}`;
    const digest = investigationContentDigest(request);
    const previous = this.store.get<IdempotencyRecord>("idempotency", key);
    if (previous !== undefined && persist) {
      requireCondition(
        previous.digest === digest,
        409,
        "idempotency_conflict",
        "This idempotency key was already used for another request.",
      );
      return this.task(actor, previous.entityId);
    }
    const importedInput =
      importedSource === undefined
        ? undefined
        : this.prepareImportedTaskSource(importedSource, registeredItem, repository);
    const item = importedSource?.workItem ?? registeredItem;
    if (this.options.actionTransport !== undefined) {
      const current = await this.options.actionTransport.readTarget(repository, item, actor);
      requireCondition(
        current.revisionKey === item.subject.revisionKey &&
          (importedSource === undefined || current.state === "open"),
        409,
        "stale_subject",
        "Refresh the work item before investigating its changed upstream revision.",
      );
    }
    let parent: InvestigationResultV1 | undefined;
    let plan: InvestigationPlanV1 | null = null;
    if (request.parentReportRef !== undefined) {
      parent = this.reportExport(actor, request.parentReportRef.id);
      requireCondition(
        parent.report.version === request.parentReportRef.version &&
          parent.report.logicalContentDigest === request.parentReportRef.digest &&
          parent.context.workItem.id === item.id,
        409,
        "parent_report_mismatch",
        "The parent report binding is stale or belongs to another target.",
      );
    }
    if (request.planRef !== undefined) {
      requireCondition(
        parent !== undefined,
        400,
        "parent_report_required",
        "A saved plan requires its exact parent report.",
      );
      plan =
        parent.plans.find(
          (entry) =>
            entry.id === request.planRef?.id &&
            entry.version === request.planRef.version &&
            entry.digest === request.planRef.digest,
        ) ?? null;
      requireCondition(
        plan !== null,
        409,
        "plan_not_saved",
        "The requested plan is not saved in the bound report.",
      );
    }
    const rootKind =
      request.kind === "pr-review" ||
      request.kind === "issue-investigate" ||
      request.kind === "pr-e2e";
    requireCondition(
      rootKind || plan !== null,
      400,
      "plan_required",
      "Follow-up tasks require a saved, bound plan.",
    );
    if (!rootKind && plan !== null) {
      const requiredKind =
        request.kind === "pr-verify" || request.kind === "issue-verify"
          ? "verification"
          : request.kind === "reproduction-setup"
            ? "reproduction"
            : request.kind === "issue-fix"
              ? "fix"
              : "implementation";
      requireCondition(
        plan.kind === requiredKind,
        400,
        "plan_kind_mismatch",
        "The saved plan kind does not support the requested follow-up task.",
      );
    }
    requireCondition(
      (request.kind !== "pr-review" && request.kind !== "pr-e2e") || item.kind === "pull_request",
      400,
      "task_kind_mismatch",
      "PR review requires a pull request.",
    );
    requireCondition(
      request.kind !== "issue-investigate" || item.kind === "issue",
      400,
      "task_kind_mismatch",
      "Issue investigation requires an issue.",
    );
    const planSubject =
      plan === null
        ? item.subject
        : parent?.context.subjects.find((entry) => entry.id === plan.subjectRef);
    requireCondition(
      planSubject !== undefined,
      409,
      "plan_subject_missing",
      "The saved plan subject is unavailable.",
    );
    const originalSubject =
      parent?.context.subjects.find((entry) => entry.kind === item.subject.kind) ?? item.subject;
    requireCondition(
      originalSubject.revisionKey === item.subject.revisionKey,
      409,
      "stale_subject",
      "The target changed since this source snapshot was frozen.",
    );
    const mode =
      request.executionMode ??
      (request.kind === "pr-e2e"
        ? "execute"
        : rootKind
          ? item.kind === "issue"
            ? "snapshot_only"
            : "source_read"
          : "execute");
    requireCondition(
      request.kind !== "pr-e2e" || mode === "execute",
      400,
      "execution_mode_required",
      "E2E tasks require repository execution.",
    );
    requireCondition(
      rootKind || mode === "execute",
      400,
      "execution_mode_required",
      "Saved verification and implementation tasks require explicit execution mode.",
    );
    requireCondition(
      mode !== "execute" || actor.allowRepositoryExecution,
      403,
      "execution_not_authorized",
      "This identity is not authorized to execute repository code.",
    );
    let subject = planSubject;
    if (request.sourceCommit !== undefined) {
      requireCondition(
        item.kind === "issue" && mode !== "snapshot_only",
        400,
        "source_selection_not_applicable",
        "Explicit source selection requires a source-aware Issue task.",
      );
      requireCondition(
        planSubject.kind === "issue_snapshot" ||
          (planSubject.kind === "source_commit" && planSubject.commitSha === request.sourceCommit),
        409,
        "saved_source_commit_changed",
        "A saved plan's frozen source commit cannot be replaced by a different revision.",
      );
      requireCondition(
        this.options.resolveTaskSource !== undefined,
        409,
        "source_resolver_unavailable",
        "The server cannot verify the selected source commit.",
      );
      subject = await this.options.resolveTaskSource(repository, item, request.sourceCommit, actor);
      requireCondition(
        subject.kind === "source_commit" &&
          subject.commitSha === request.sourceCommit &&
          subject.repositoryId === repository.id &&
          subject.workItemId === item.id,
        400,
        "resolved_source_mismatch",
        "The verified source must match the explicitly selected commit and target.",
      );
    }
    const subjects = [...(parent?.context.subjects ?? [item.subject])];
    const existingSubject = subjects.find((entry) => entry.id === subject.id);
    requireCondition(
      existingSubject === undefined ||
        investigationContentDigest(existingSubject) === investigationContentDigest(subject),
      400,
      "source_identity_conflict",
      "An explicit source cannot replace an existing frozen subject identity.",
    );
    if (existingSubject === undefined) subjects.push(subject);
    const parentArtifacts = new Map(
      [...(parent?.artifacts ?? []), ...(parent?.context.sourceArtifacts ?? [])].map(
        (artifact) => [artifact.id, artifact] as const,
      ),
    );
    const sourceArtifacts = subjects.flatMap((entry) => {
      if (entry.kind !== "local_patch") return [];
      const artifact = parentArtifacts.get(entry.artifactRef);
      requireCondition(
        artifact !== undefined &&
          artifact.kind === "patch" &&
          artifact.subjectRef === entry.id &&
          artifact.digest === entry.patchDigest,
        409,
        "parent_patch_binding_missing",
        "Every inherited patch must retain its exact artifact metadata from the saved parent report.",
      );
      return [artifact];
    });
    const id = this.idFactory();
    const units =
      plan === null
        ? [
            {
              id: "scope-original",
              subjectRef: subject.id,
              kind:
                request.kind === "pr-e2e"
                  ? "e2e_features"
                  : item.kind === "pull_request"
                    ? "full_diff"
                    : "issue_snapshot",
              paths: [],
              requiredWork:
                request.kind === "pr-e2e"
                  ? "Run each affected PR feature at the pinned revision with explicit assertions and successful-state screenshots or videos. Record missing coverage and confirm owned-process cleanup."
                  : item.kind === "pull_request"
                    ? "Review the pinned PR changes and affected behavior, including relevant callers and test source."
                    : "Statically investigate the recorded issue snapshot, supplied facts, and supported hypotheses.",
              status: "pending" as const,
              evidenceRefs: [],
            },
          ]
        : plan.steps.map((step) => ({
            id: step.id,
            subjectRef: subject.id,
            kind: plan.kind,
            paths: [],
            requiredWork: step.description,
            status: "pending" as const,
            evidenceRefs: [],
          }));
    if (request.sourceCommit !== undefined)
      units.push({
        id: "scope-issue-context",
        subjectRef: item.subject.id,
        kind: "issue_snapshot",
        paths: [],
        requiredWork:
          "Preserve the complete frozen Issue context while checking the explicitly selected source revision.",
        status: "pending",
        evidenceRefs: [],
      });
    const allowedSubjectRefs =
      request.sourceCommit === undefined ? [subject.id] : [subject.id, item.subject.id];
    const scope = request.scope ?? {
      scopeManifest: { id: `scope:${id}`, version: 1, digest: investigationContentDigest(units) },
      includedUnits: units,
      exclusions: [],
      completedUnitRefs: [],
      unresolvedUnitRefs: units.map((unit) => unit.id),
    };
    requireCondition(
      scope.includedUnits.length > 0 &&
        scope.includedUnits.every(
          (unit) => allowedSubjectRefs.includes(unit.subjectRef) && unit.status === "pending",
        ) &&
        scope.completedUnitRefs.length === 0,
      400,
      "invalid_initial_scope",
      "New scope must preserve pending work on the frozen subject.",
    );
    if (rootKind && request.scope !== undefined)
      requireCondition(
        scope.includedUnits.some(
          (unit) =>
            unit.kind ===
            (request.kind === "pr-e2e"
              ? "e2e_features"
              : item.kind === "pull_request"
                ? "full_diff"
                : "issue_snapshot"),
        ),
        400,
        "complete_scope_required",
        "The initial scope must include the complete original diff or issue snapshot.",
      );
    const now = this.time();
    const task: InvestigationTaskV1 = {
      schemaVersion: "InvestigationTaskV1",
      id,
      kind: request.kind,
      repository,
      workItem: { id: item.id, kind: item.kind, number: item.number, title: item.title },
      parentTaskId: parent?.context.task.id ?? null,
      parentReportRef: request.parentReportRef ?? null,
      planRef: request.planRef ?? null,
      subjectRef: subject.id,
      subjects,
      ...(sourceArtifacts.length === 0 ? {} : { sourceArtifacts }),
      scope,
      executionPolicy: {
        mode,
        allowedSubjectRefs,
        allowRepositoryExecution: mode === "execute",
        authorizationRef: mode === "execute" ? actor.id : null,
      },
      budget: structuredClone(request.budget ?? this.defaultTaskBudget),
      profileRef: request.profileRef ??
        parent?.context.profileRef ?? {
          id: "investigation-default",
          version: 1,
          digest: investigationContentDigest("investigation-default-v1"),
        },
      promptRef: request.promptRef ??
        parent?.context.promptRef ?? {
          id: request.kind === "pr-e2e" ? "investigation-e2e" : "investigation-loop",
          version: 1,
          digest: investigationContentDigest(
            request.kind === "pr-e2e" ? "investigation-e2e-v1" : "investigation-loop-v1",
          ),
        },
      state: "queued",
      latestReportRef: null,
      createdAt: now,
      updatedAt: now,
    };
    const taskValidation = validateInvestigationTask(task);
    requireCondition(
      taskValidation.valid,
      400,
      "invalid_task",
      taskValidation.errors.map((error) => error.message).join(" "),
    );
    const input: InvestigationPreparedTaskInput =
      importedInput !== undefined
        ? {
            inputSnapshot: {
              ...importedInput,
              subjectRef: subject.id,
              subjectRevisionKey: subject.revisionKey,
            },
            plan,
            execution: null,
          }
        : this.options.prepareTaskInput === undefined
          ? {
              inputSnapshot: {
                schemaVersion: "InvestigationInputSnapshotV1" as const,
                repositoryId: repository.id,
                workItemId: item.id,
                subjectRef: subject.id,
                subjectRevisionKey: subject.revisionKey,
                title: item.title,
                body: item.body,
                comments: [],
                source: null,
              },
              plan,
              execution: null,
            }
          : await this.options.prepareTaskInput(task, item, plan, actor);
    requireCondition(
      input.inputSnapshot.repositoryId === repository.id &&
        input.inputSnapshot.workItemId === item.id &&
        input.inputSnapshot.subjectRef === task.subjectRef &&
        input.inputSnapshot.subjectRevisionKey === subject.revisionKey,
      400,
      "input_snapshot_mismatch",
      "The prepared input does not match the frozen task subject.",
    );
    requireCondition(
      investigationContentDigest(input.plan) === investigationContentDigest(plan),
      400,
      "prepared_plan_changed",
      "Prepared task input must preserve the exact saved parent plan.",
    );
    requireCondition(
      plan === null || mode !== "execute" || input.execution !== null,
      409,
      "execution_binding_missing",
      "Configure the saved plan's trusted executable steps and prerequisites before dispatching it.",
    );
    if (input.execution !== null) {
      const execution = input.execution;
      requireCondition(
        mode === "execute" &&
          plan !== null &&
          task.planRef !== null &&
          investigationContentDigest(execution.planRef) ===
            investigationContentDigest(task.planRef) &&
          execution.subjectRef === subject.id &&
          execution.subjectRevisionKey === subject.revisionKey &&
          execution.authorizationRef === task.executionPolicy.authorizationRef &&
          execution.executionPolicyDigest === investigationContentDigest(task.executionPolicy) &&
          execution.steps.every((step) => plan.steps.some((entry) => entry.id === step.stepId)),
        400,
        "prepared_execution_mismatch",
        "Executable bindings must preserve the saved plan, explicit authorization, and frozen source.",
      );
    }
    this.evidence.requireTaskSources(task, parent ?? null);
    if (!persist) return task;
    return this.store.transaction(() => {
      const concurrent = this.store.get<IdempotencyRecord>("idempotency", key);
      if (concurrent !== undefined) {
        requireCondition(
          concurrent.digest === digest,
          409,
          "idempotency_conflict",
          "The request changed while task input was being prepared.",
        );
        return this.task(actor, concurrent.entityId);
      }
      if (importedSource !== undefined) this.requireImportedSourceCurrent(repository, item);
      this.evidence.requireTaskSources(task, parent ?? null);
      beforePersist?.();
      this.store.insert("tasks", task.id, task);
      this.evidence.pinParent(task);
      this.store.insert("idempotency", `input:${task.id}`, input);
      this.store.insert("idempotency", key, { digest, entityId: task.id });
      onPersisted?.(task);
      return task;
    });
  }

  private prepareImportedTaskSource(
    source: InvestigationImportedTaskSource,
    registeredItem: InvestigationWorkItemRecord,
    repository: InvestigationRepositoryRecord,
  ): InvestigationInputSnapshotV1 {
    requireCondition(
      Value.Check(importedTaskSourceSchema, source) &&
        source.workItem.id === registeredItem.id &&
        source.workItem.repositoryId === repository.id &&
        source.workItem.subject.repositoryId === repository.id &&
        source.workItem.subject.workItemId === source.workItem.id &&
        (source.workItem.kind === "pull_request"
          ? source.workItem.subject.kind === "original_pr"
          : source.workItem.subject.kind === "issue_snapshot"),
      409,
      "imported_source_mismatch",
      "The imported source must retain the registered work item and original subject identities.",
    );
    this.requireImportedSourceCurrent(repository, source.workItem);
    const snapshot = this.store.get<unknown>("sourceSnapshots", source.snapshotRef.id);
    requireCondition(
      Value.Check(importedSnapshotSchema, snapshot) &&
        snapshot.id === source.snapshotRef.id &&
        snapshot.id === `snapshot:${snapshot.digest}` &&
        snapshot.digest === source.snapshotRef.digest &&
        investigationContentDigest(snapshot.inputSnapshot) === snapshot.digest &&
        snapshot.inputSnapshot.repositoryId === repository.id &&
        snapshot.inputSnapshot.workItemId === source.workItem.id &&
        snapshot.inputSnapshot.subjectRef === source.workItem.subject.id &&
        snapshot.inputSnapshot.subjectRevisionKey === source.workItem.subject.revisionKey &&
        snapshot.inputSnapshot.title === source.workItem.title &&
        snapshot.inputSnapshot.body === source.workItem.body &&
        snapshot.inputSnapshot.source === null,
      409,
      "source_snapshot_missing",
      "The exact complete imported snapshot is missing or no longer matches its content binding.",
    );
    const subject = source.workItem.subject;
    requireCondition(
      subject.kind === "original_pr"
        ? subject.revisionKey ===
            createHash("sha256").update(`${subject.baseSha}\0${subject.headSha}`).digest("hex")
        : subject.kind === "issue_snapshot" &&
            subject.snapshotDigest ===
              investigationContentDigest({
                title: snapshot.inputSnapshot.title,
                body: snapshot.inputSnapshot.body,
                comments: snapshot.inputSnapshot.comments,
              }),
      409,
      "imported_subject_mismatch",
      "The imported subject revision does not match its frozen source content.",
    );
    return structuredClone(snapshot.inputSnapshot);
  }

  private requireImportedSourceCurrent(
    repository: InvestigationRepositoryRecord,
    item: InvestigationWorkItemRecord,
  ): void {
    const currentRepository = this.store.get<unknown>("repositories", repository.id);
    requireCondition(
      Value.Check(InvestigationRepositoryRecordSchema, currentRepository) &&
        investigationContentDigest(currentRepository) === investigationContentDigest(repository),
      409,
      "repository_changed",
      "The repository binding changed while the imported task was being prepared.",
    );
    const currentItem = this.store.get<unknown>("workItems", item.id);
    requireCondition(
      Value.Check(InvestigationWorkItemRecordSchema, currentItem) &&
        currentItem.id === item.id &&
        currentItem.repositoryId === repository.id &&
        currentItem.kind === item.kind &&
        currentItem.number === item.number &&
        currentItem.state === "open" &&
        item.state === "open" &&
        currentItem.subject.kind === item.subject.kind &&
        currentItem.subject.repositoryId === repository.id &&
        currentItem.subject.workItemId === item.id &&
        currentItem.subject.revisionKey === item.subject.revisionKey &&
        (currentItem.subject.kind !== "original_pr" ||
          (item.subject.kind === "original_pr" &&
            currentItem.subject.id === item.subject.id &&
            currentItem.subject.baseSha === item.subject.baseSha &&
            currentItem.subject.headSha === item.subject.headSha)),
      409,
      "stale_subject",
      "The registered work item identity, state, or revision changed after the source was imported.",
    );
    requireCondition(
      this.store.list<InvestigationWorkItemRecord>(
        "workItems",
        (entry) =>
          entry.repositoryId === repository.id &&
          entry.kind === item.kind &&
          entry.number === item.number,
      ).length === 1,
      409,
      "work_item_identity_conflict",
      "Multiple local records identify the imported upstream work item.",
    );
  }

  async validateTaskAction(
    actor: InvestigationOperatorPrincipal,
    request: InvestigationCreateTaskRequestV1,
  ): Promise<InvestigationActionGuard[]> {
    try {
      await this.createTask(actor, request, false);
      return [
        {
          code: "task_execution_binding",
          satisfied: true,
          message:
            "The exact saved plan, explicit source, execution authority, and trusted executable binding were verified.",
        },
      ];
    } catch (error) {
      return [
        {
          code: error instanceof InvestigationRequestError ? error.code : "task_preparation_failed",
          satisfied: false,
          message:
            error instanceof InvestigationRequestError
              ? error.message
              : "The saved task prerequisites could not be verified.",
        },
      ];
    }
  }

  getTask(actor: InvestigationOperatorPrincipal, id: string) {
    this.reapExpiredLeases();
    const task = this.task(actor, id);
    return {
      task,
      usage: this.usageSummary(id),
      invocations: investigationUsageInvocations(this.store, id),
      progress: investigationTaskProgress(this.store, id),
      attempts: this.attempts(id).map((record) => record.attempt),
      resourceLeases: this.resourceScheduler.leases().filter((lease) => lease.taskId === id),
      checkpoint: this.store.get<InvestigationLoopCheckpointV1>("checkpoints", id) ?? null,
      latestReport:
        task.latestReportRef === null ? null : this.reportHeader(actor, task.latestReportRef.id),
      children: this.store.list<InvestigationTaskV1>("tasks", (child) => child.parentTaskId === id),
    };
  }
  getTaskUsage(actor: InvestigationOperatorPrincipal, id: string) {
    this.task(actor, id);
    return {
      usage: this.usageSummary(id),
      invocations: investigationUsageInvocations(this.store, id),
    };
  }

  /** Trusted publishers and report finalization use the same ledger as the Dashboard. */
  usageSummary(taskId: string) {
    this.required<InvestigationTaskV1>("tasks", taskId);
    const checkpoint = this.store.get<InvestigationLoopCheckpointV1>("checkpoints", taskId);
    const unknown =
      this.hasUnaccountedAttempt(taskId) ||
      (checkpoint?.analysis.diagnostics.some(
        (diagnostic) => diagnostic.code === "MODEL_USAGE_UNAVAILABLE",
      ) ??
        false);
    const verifiedZeroAttempt =
      !unknown &&
      this.attempts(taskId).some((record) =>
        attemptHasVerifiedNoModelInvocation(
          this.store,
          taskId,
          record.attempt.id,
          record.attempt.leaseVersion,
        ),
      );
    return investigationUsageSummary(
      this.store,
      taskId,
      checkpoint?.consumed.tokens ?? 0,
      unknown,
      verifiedZeroAttempt,
    );
  }

  private hasUnaccountedAttempt(taskId: string, registeringAttemptId?: string): boolean {
    const covered = new Set(
      investigationUsageInvocations(this.store, taskId).map((receipt) => receipt.attemptId),
    );
    return this.attempts(taskId).some(
      (record) =>
        record.attempt.id !== registeringAttemptId &&
        !covered.has(record.attempt.id) &&
        !attemptHasVerifiedNoModelInvocation(
          this.store,
          taskId,
          record.attempt.id,
          record.attempt.leaseVersion,
        ),
    );
  }

  /** Late accounting is allowed for the original attempt lease, never for another Worker. */
  workerModelUsage(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: { lease: InvestigationWorkerLease; receipt: InvestigationModelInvocationReceipt },
  ) {
    const accepted = this.store.transaction(() => {
      const task = this.task(worker, taskId);
      const record = this.required<AttemptRecord>("attempts", request.lease.attemptId);
      requireCondition(
        request.receipt.taskId === taskId &&
          request.receipt.attemptId === request.lease.attemptId &&
          record.attempt.taskId === taskId &&
          record.attempt.workerId === worker.id &&
          record.attempt.leaseVersion === request.lease.fence &&
          constantTimeEqual(
            record.leaseTokenDigest,
            investigationContentDigest(request.lease.leaseToken),
          ),
        409,
        "usage_lease_mismatch",
        "The model usage receipt does not belong to the authenticated Worker's original attempt lease.",
      );
      const checkpoint = this.store.get<InvestigationLoopCheckpointV1>("checkpoints", taskId);
      const previousInvocation = investigationUsageInvocations(this.store, taskId).find(
        (receipt) => receipt.invocationId === request.receipt.invocationId,
      );
      const admissionKey = `model-usage-admission:${request.receipt.invocationId}`;
      const retainedAdmission = this.store.get<{ executionAllowed: boolean }>(
        "idempotency",
        admissionKey,
      );
      const executionAllowed =
        retainedAdmission?.executionAllowed ??
        (previousInvocation !== undefined ||
          (task.state === "running" &&
            record.attempt.state === "running" &&
            !record.cancelRequested &&
            checkpoint?.attemptId === record.attempt.id &&
            checkpoint.leaseVersion === request.lease.fence &&
            checkpoint.stopReason === "continuing" &&
            Date.parse(record.leaseExpiresAt) > this.now().getTime() &&
            this.usageSummary(taskId).reportedTokens < task.budget.maxTokens));
      if (!executionAllowed && request.receipt.revision > 1)
        requireCondition(
          ["failed", "cancelled"].includes(request.receipt.state) &&
            request.receipt.usage.totalTokens === 0 &&
            request.receipt.completeness === "complete" &&
            [
              request.receipt.usage.inputTokens,
              request.receipt.usage.outputTokens,
              request.receipt.usage.cachedReadTokens,
              request.receipt.usage.reasoningTokens,
              request.receipt.usage.cacheWriteTokens,
              ...Object.values(request.receipt.usage.providerCounters),
            ].every((count) => count === null || count === 0),
          409,
          "usage_execution_not_admitted",
          "A late or budget-rejected registration cannot authorize execution or report spent tokens.",
        );
      try {
        const recorded = recordInvestigationUsage(
          this.store,
          request.receipt,
          checkpoint?.consumed.tokens ?? 0,
          this.hasUnaccountedAttempt(
            taskId,
            executionAllowed ? request.receipt.attemptId : undefined,
          ) ||
            (checkpoint?.analysis.diagnostics.some(
              (diagnostic) => diagnostic.code === "MODEL_USAGE_UNAVAILABLE",
            ) ??
              false),
        );
        if (retainedAdmission === undefined)
          this.store.insert("idempotency", admissionKey, { executionAllowed });
        return {
          task,
          changed: !recorded.duplicate,
          response: {
            invocationId: recorded.receipt.invocationId,
            revision: recorded.receipt.revision,
            ...(request.receipt.state === "registered" && request.receipt.revision === 1
              ? { executionAllowed }
              : {}),
          },
        };
      } catch (error) {
        if (error instanceof InvestigationUsageLedgerError)
          throw new InvestigationRequestError(
            error.code === "INVALID_USAGE" ? 400 : 409,
            error.code.toLowerCase(),
            error.message,
          );
        throw error;
      }
    });
    if (accepted.changed) {
      try {
        this.options.onTaskUsageChanged?.(accepted.task);
      } catch {
        // Accounting is already committed. The durable publication wakeup survives a restart.
      }
    }
    return accepted.response;
  }

  workerReportUsage(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: { lease: InvestigationWorkerLease },
  ) {
    return this.store.transaction(() => {
      const { record } = this.lease(worker, taskId, request.lease);
      const key = `report-usage:${record.reportId}`;
      const previous = this.store.get<{ summary: InvestigationUsageSummary }>("idempotency", key);
      if (previous !== undefined) return structuredClone(previous);
      const snapshot = { summary: this.usageSummary(taskId) };
      this.store.insert("idempotency", key, snapshot);
      return structuredClone(snapshot);
    });
  }
  async resumeTask(
    actor: InvestigationOperatorPrincipal,
    id: string,
    request: InvestigationResumeTaskRequest,
  ) {
    this.permit(actor, "task:create");
    this.reapExpiredLeases();
    const key = `resume:${actor.id}:${request.idempotencyKey}`;
    const requestDigest = investigationContentDigest({ taskId: id, ...request });
    const previous = this.store.get<IdempotencyRecord>("idempotency", key);
    if (previous !== undefined) {
      requireCondition(
        previous.entityId === id && previous.digest === requestDigest,
        409,
        "idempotency_conflict",
        "This resume key belongs to different task or budget input.",
      );
      return this.task(actor, id);
    }
    const task = this.task(actor, id);
    requireCondition(
      ["blocked", "failed", "cancelled", "interrupted"].includes(task.state),
      409,
      "task_not_resumable",
      "Only an incomplete terminal task can be resumed.",
    );
    const item = this.getWorkItem(actor, task.workItem.id);
    if (this.options.actionTransport !== undefined) {
      const current = await this.options.actionTransport.readTarget(task.repository, item, actor);
      requireCondition(
        current.revisionKey === item.subject.revisionKey,
        409,
        "stale_subject",
        "Refresh the changed upstream target before attempting to resume.",
      );
    }
    const originalSubject = task.subjects.find((entry) => entry.kind === item.subject.kind);
    requireCondition(
      originalSubject?.revisionKey === item.subject.revisionKey,
      409,
      "stale_subject",
      "The upstream target changed; create a new investigation.",
    );
    requireCondition(
      task.executionPolicy.mode !== "execute" || actor.allowRepositoryExecution,
      403,
      "execution_not_authorized",
      "Resume requires the original execution permission.",
    );
    const checkpoint = this.store.get<InvestigationLoopCheckpointV1>("checkpoints", id);
    let resumeTask = task;
    let resumeCheckpoint = checkpoint;
    const budgetChanged =
      request.budget !== undefined &&
      investigationContentDigest(request.budget) !== investigationContentDigest(task.budget);
    if (request.budget !== undefined) {
      requireCondition(
        request.budget.maxReportBytes <= this.maxReportBytes,
        400,
        "report_budget_exceeds_server_limit",
        `The report budget exceeds the configured ${this.maxReportBytes}-byte server limit.`,
      );
      requireCondition(
        Object.entries(task.budget).every(
          ([key, value]) => request.budget![key as keyof typeof task.budget] >= value,
        ),
        400,
        "budget_cannot_decrease",
        "A resumed task may only increase its existing budget fields.",
      );
      if (budgetChanged) {
        if (checkpoint === undefined) resumeTask = { ...task, budget: request.budget };
        else {
          const increased = increaseInvestigationBudget(checkpoint, task, request.budget, {
            recordedAt: this.time(),
          });
          resumeTask = increased.task;
          resumeCheckpoint = increased.checkpoint;
        }
      }
    }
    if (resumeCheckpoint !== undefined) {
      const restore =
        resumeCheckpoint.stopReason === "complete"
          ? restoreCompletedInvestigationForDelivery
          : restoreInvestigationCheckpoint;
      restore({
        checkpoint: resumeCheckpoint,
        task: resumeTask,
        attemptId: this.idFactory(),
        leaseVersion: this.attempts(id).length + 1,
        recordedAt: this.time(),
      });
    }
    const resumed: InvestigationTaskV1 = { ...resumeTask, state: "queued", updatedAt: this.time() };
    return this.store.transaction(() => {
      const concurrent = this.store.get<IdempotencyRecord>("idempotency", key);
      if (concurrent !== undefined) {
        requireCondition(
          concurrent.entityId === id && concurrent.digest === requestDigest,
          409,
          "idempotency_conflict",
          "This resume key belongs to different task or budget input.",
        );
        return this.task(actor, id);
      }
      const current = this.task(actor, id);
      requireCondition(
        investigationContentDigest(current) === investigationContentDigest(task) &&
          !this.attempts(id).some((attempt) => attempt.attempt.state === "running"),
        409,
        "task_resume_conflict",
        "The task changed or another attempt started while resume was being checked.",
      );
      this.store.put("tasks", id, resumed);
      if (budgetChanged) {
        if (resumeCheckpoint !== undefined) this.store.put("checkpoints", id, resumeCheckpoint);
        this.store.insert(
          "idempotency",
          `budget-change:${investigationContentDigest([id, actor.id, request.idempotencyKey])}`,
          {
            actorId: actor.id,
            taskId: id,
            recordedAt: this.time(),
            previousBudget: task.budget,
            budget: resumed.budget,
            previousCheckpointRef:
              checkpoint === undefined
                ? null
                : { id: checkpoint.id, version: checkpoint.version, digest: checkpoint.digest },
            checkpointRef:
              resumeCheckpoint === undefined
                ? null
                : {
                    id: resumeCheckpoint.id,
                    version: resumeCheckpoint.version,
                    digest: resumeCheckpoint.digest,
                  },
          },
        );
      }
      this.store.insert("idempotency", key, { digest: requestDigest, entityId: id });
      this.options.onTaskStateChanged?.(resumed);
      return resumed;
    });
  }
  cancelTask(actor: InvestigationOperatorPrincipal, id: string) {
    this.permit(actor, "task:cancel");
    const task = this.task(actor, id);
    if (task.state !== "queued" && task.state !== "running") return task;
    const checkpoint = this.store.get<InvestigationLoopCheckpointV1>("checkpoints", id);
    requireCondition(
      task.state !== "running" ||
        checkpoint === undefined ||
        checkpoint.stopReason === "continuing",
      409,
      "terminal_analysis_accepted",
      "The accepted investigation has stopped and its immutable report is being delivered.",
    );
    const active = this.attempts(id).findLast((record) => record.attempt.state === "running");
    if (active !== undefined) {
      this.store.transaction(() => {
        this.store.put("attempts", active.attempt.id, { ...active, cancelRequested: true });
        this.resourceScheduler.requestCleanup(active.attempt.id, "cancellation_requested");
      });
      return task;
    }
    const cancelled: InvestigationTaskV1 = { ...task, state: "cancelled", updatedAt: this.time() };
    this.store.transaction(() => {
      this.store.put("tasks", id, cancelled);
      this.options.onTaskStateChanged?.(cancelled);
    });
    return cancelled;
  }

  schedulerStatus(actor: InvestigationOperatorPrincipal): InvestigationSchedulerStatus {
    this.reapExpiredLeases();
    const leases = this.resourceScheduler.leases().filter((lease) => lease.state !== "released");
    return {
      ...this.resourceScheduler.settings(),
      occupiedStatic: leases.filter((lease) => lease.pool === "static").length,
      occupiedE2e: leases.filter((lease) => lease.pool === "e2e").length,
      leases: leases.filter((lease) => {
        const task = this.store.get<InvestigationTaskV1>("tasks", lease.taskId);
        return task !== undefined && actor.repositoryIds.includes(task.repository.id);
      }),
    };
  }

  configureScheduler(
    actor: InvestigationOperatorPrincipal,
    request: InvestigationSchedulerSettingsRequest,
  ): InvestigationSchedulerStatus {
    requireCondition(
      actor.isAdmin === true,
      403,
      "administrator_required",
      "Only an administrator may change global task concurrency.",
    );
    this.store.transaction(() => this.resourceScheduler.configure(request.staticConcurrency));
    return this.schedulerStatus(actor);
  }

  workerCleanup(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: InvestigationCleanupRequest,
  ) {
    this.reapExpiredLeases();
    return this.store.transaction(() => {
      const task = this.task(worker, taskId);
      const record = this.required<AttemptRecord>("attempts", request.lease.attemptId);
      requireCondition(
        record.attempt.taskId === taskId &&
          record.attempt.workerId === worker.id &&
          record.attempt.leaseVersion === request.lease.fence &&
          constantTimeEqual(
            record.leaseTokenDigest,
            investigationContentDigest(request.lease.leaseToken),
          ),
        409,
        "cleanup_owner_mismatch",
        "Cleanup must be confirmed by the original worker and exact attempt lease.",
      );
      const checkpoint = this.store.get<InvestigationLoopCheckpointV1>("checkpoints", task.id);
      requireCondition(
        record.attempt.state !== "running" ||
          record.cancelRequested ||
          (checkpoint?.attemptId === record.attempt.id && checkpoint.stopReason !== "continuing"),
        409,
        "execution_still_active",
        "Cleanup cannot release a resource while the attempt can still execute work.",
      );
      requireCondition(
        request.ownedProcessesStopped === true && request.desktopRestored === true,
        409,
        "cleanup_not_confirmed",
        "Owned process termination and desktop restoration must both be confirmed.",
      );
      this.resourceScheduler.confirmCleanup({
        attemptId: record.attempt.id,
        taskId,
        workerId: worker.id,
        fence: request.lease.fence,
      });
      recordInvestigationCleanup(this.store, taskId, record.attempt.id, this.time());
      return { released: true as const, attemptId: record.attempt.id };
    });
  }

  reportExport(actor: InvestigationOperatorPrincipal, id: string): InvestigationResultV1 {
    const result = this.required<InvestigationResultV1>("reports", id);
    this.scope(actor, result.context.repository.id);
    return result;
  }
  reportHeader(actor: InvestigationOperatorPrincipal, id: string) {
    return reportHeader(this.reportExport(actor, id));
  }
  reportFindings(
    actor: InvestigationOperatorPrincipal,
    id: string,
    query: InvestigationFindingsQuery,
  ): InvestigationFindingsPageV1 {
    const report = this.reportExport(actor, id);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    requireCondition(
      Number.isSafeInteger(limit) && limit > 0 && limit <= 1000,
      400,
      "invalid_page_size",
      "The findings page size must be between 1 and 1000.",
    );
    const offset = parseCursor(query.cursor, report.report.id, report.report.logicalContentDigest);
    const items = report.findings.slice(offset, offset + limit);
    return {
      schemaVersion: "InvestigationFindingsPageV1",
      reportRef: { id, version: report.report.version, digest: report.report.logicalContentDigest },
      total: report.findings.length,
      offset,
      items,
      nextCursor:
        offset + items.length < report.findings.length
          ? encodeCursor(id, report.report.logicalContentDigest, offset + items.length)
          : null,
    };
  }

  private lease(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    lease: InvestigationWorkerLease,
  ): { task: InvestigationTaskV1; record: AttemptRecord } {
    const task = this.task(worker, taskId);
    const record = this.required<AttemptRecord>("attempts", lease.attemptId);
    const checkpoint = this.store.get<InvestigationLoopCheckpointV1>("checkpoints", taskId);
    requireCondition(
      task.state === "running" &&
        checkpoint?.attemptId === lease.attemptId &&
        checkpoint.leaseVersion === lease.fence &&
        record.attempt.taskId === taskId &&
        record.attempt.workerId === worker.id &&
        record.attempt.leaseVersion === lease.fence &&
        constantTimeEqual(record.leaseTokenDigest, investigationContentDigest(lease.leaseToken)) &&
        record.attempt.state === "running" &&
        Date.parse(record.leaseExpiresAt) > this.now().getTime(),
      409,
      "lease_lost",
      "The attempt lease expired or was superseded.",
    );
    return { task, record };
  }
  reapExpiredLeases(): void {
    const expired = this.store.list<AttemptRecord>(
      "attempts",
      (record) =>
        record.attempt.state === "running" &&
        Date.parse(record.leaseExpiresAt) <= this.now().getTime(),
    );
    for (const record of expired)
      this.store.transaction(() => {
        const task = this.required<InvestigationTaskV1>("tasks", record.attempt.taskId);
        const checkpoint = this.store.get<InvestigationLoopCheckpointV1>("checkpoints", task.id);
        if (
          checkpoint !== undefined &&
          checkpoint.attemptId === record.attempt.id &&
          checkpoint.stopReason !== "complete"
        ) {
          const reason = record.cancelRequested
            ? "cancelled"
            : checkpoint.stopReason === "continuing"
              ? "interrupted"
              : checkpoint.stopReason;
          const elapsed = Math.max(
            0,
            Date.parse(record.leaseExpiresAt) - Date.parse(checkpoint.recordedAt),
          );
          this.store.put(
            "checkpoints",
            task.id,
            interruptInvestigationLoop(
              checkpoint,
              reason,
              record.leaseExpiresAt,
              [
                {
                  id: `lease-expired:${record.attempt.id}`,
                  code: "LEASE_EXPIRED",
                  category: "recovery",
                  retryable: true,
                  message:
                    "The worker lease expired. The accepted checkpoint and completed execution receipts are retained for explicit recovery.",
                  evidenceRefs: [],
                  prerequisiteRefs: [],
                },
              ],
              elapsed,
            ),
          );
        }
        this.store.put("attempts", record.attempt.id, {
          ...record,
          attempt: {
            ...record.attempt,
            state: record.cancelRequested ? "cancelled" : "interrupted",
            finishedAt: this.time(),
            terminationReason: "lease_expired",
          },
        });
        this.resourceScheduler.terminate(record.attempt.id, "lease_expired");
        const interrupted: InvestigationTaskV1 = {
          ...task,
          state: record.cancelRequested ? "cancelled" : "interrupted",
          updatedAt: this.time(),
        };
        this.store.put("tasks", task.id, interrupted);
        this.options.onTaskStateChanged?.(interrupted);
      });
  }
  workerClaim(
    worker: InvestigationWorkerPrincipal,
    request: InvestigationClaimRequest,
  ): InvestigationClaimResponse {
    this.reapExpiredLeases();
    return this.store.transaction(() => {
      const availablePools = {
        static: this.resourceScheduler.available("static"),
        e2e: this.resourceScheduler.available("e2e"),
      };
      const task = this.store
        .list<InvestigationTaskV1>(
          "tasks",
          (entry) =>
            entry.state === "queued" &&
            worker.repositoryIds.includes(entry.repository.id) &&
            request.supportedKinds.includes(entry.kind),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .find((entry) => availablePools[investigationResourcePool(entry.kind)]);
      if (task === undefined) return { claim: null };
      const number = this.attempts(task.id).length + 1;
      const attempt: InvestigationAttemptV1 = {
        schemaVersion: "InvestigationAttemptV1",
        id: this.idFactory(),
        taskId: task.id,
        number,
        workerId: worker.id,
        leaseVersion: number,
        state: "running",
        startedAt: this.time(),
        finishedAt: null,
        terminationReason: null,
      };
      const previous = this.store.get<InvestigationLoopCheckpointV1>("checkpoints", task.id);
      const checkpoint =
        previous === undefined
          ? createInvestigationCheckpoint({
              task,
              attemptId: attempt.id,
              checkpointId: this.idFactory(),
              leaseVersion: number,
              recordedAt: this.time(),
            })
          : (previous.stopReason === "complete"
              ? restoreCompletedInvestigationForDelivery
              : restoreInvestigationCheckpoint)({
              checkpoint: previous,
              task,
              attemptId: attempt.id,
              leaseVersion: number,
              recordedAt: this.time(),
            });
      const leaseToken = randomBytes(32).toString("base64url");
      const record: AttemptRecord = {
        attempt,
        leaseTokenDigest: investigationContentDigest(leaseToken),
        leaseExpiresAt: new Date(this.now().getTime() + this.leaseDurationMs).toISOString(),
        reportId: this.idFactory(),
        cancelRequested: false,
      };
      const running: InvestigationTaskV1 = { ...task, state: "running", updatedAt: this.time() };
      this.resourceScheduler.acquire({
        attemptId: attempt.id,
        taskId: task.id,
        workerId: worker.id,
        fence: number,
        pool: investigationResourcePool(task.kind),
      });
      this.store.insert("attempts", attempt.id, record);
      this.store.put("tasks", task.id, running);
      this.store.put("checkpoints", task.id, checkpoint);
      beginInvestigationProgress(this.store, task.id, attempt.id);
      const input = this.required<FrozenTaskInput>("idempotency", `input:${task.id}`);
      this.options.onTaskStateChanged?.(running);
      return {
        claim: {
          task: running,
          attempt,
          lease: { attemptId: attempt.id, fence: number, leaseToken },
          checkpoint,
          reportId: record.reportId,
          ...input,
        },
      };
    });
  }
  workerHeartbeat(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: InvestigationHeartbeatRequest,
  ) {
    return this.store.transaction(() => {
      const { record } = this.lease(worker, taskId, request.lease);
      const serverTime = this.now();
      const leaseExpiresAt = new Date(serverTime.getTime() + this.leaseDurationMs).toISOString();
      this.store.put("attempts", record.attempt.id, { ...record, leaseExpiresAt });
      recordInvestigationHeartbeat(this.store, taskId, record.attempt.id, serverTime.toISOString());
      return {
        cancelRequested: record.cancelRequested,
        leaseExpiresAt,
        serverTime: serverTime.toISOString(),
      };
    });
  }

  workerProgress(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: InvestigationProgressRequest,
  ) {
    return this.store.transaction(() => {
      if (request.stage === "cleanup") {
        this.task(worker, taskId);
        const record = this.required<AttemptRecord>("attempts", request.lease.attemptId);
        const checkpoint = this.required<InvestigationLoopCheckpointV1>("checkpoints", taskId);
        requireCondition(
          checkpoint.attemptId === request.lease.attemptId &&
            checkpoint.leaseVersion === request.lease.fence &&
            record.attempt.taskId === taskId &&
            record.attempt.workerId === worker.id &&
            record.attempt.leaseVersion === request.lease.fence &&
            constantTimeEqual(
              record.leaseTokenDigest,
              investigationContentDigest(request.lease.leaseToken),
            ) &&
            (record.attempt.state !== "running" ||
              record.cancelRequested ||
              checkpoint.stopReason !== "continuing"),
          409,
          "lease_lost",
          "Cleanup progress requires the latest original attempt after execution has stopped.",
        );
      } else this.lease(worker, taskId, request.lease);
      return { progress: recordInvestigationActivity(this.store, taskId, request, this.time()) };
    });
  }

  workerCheckpoint(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: InvestigationCheckpointRequest,
  ) {
    const { task, record } = this.lease(worker, taskId, request.lease);
    const checkpoint = this.required<InvestigationLoopCheckpointV1>("checkpoints", taskId);
    const key = `checkpoint:${record.attempt.id}:${request.kind}:${request.kind === "analysis" ? request.round.round : investigationContentDigest(request)}`;
    const digest = investigationContentDigest(request);
    const accepted = this.store.get<CheckpointAcceptanceRecord>("idempotency", key);
    if (accepted !== undefined) {
      requireCondition(
        accepted.digest === digest,
        409,
        "idempotency_conflict",
        "This checkpoint identity already contains different content.",
      );
      return { checkpoint: accepted.checkpoint };
    }
    let next: InvestigationLoopCheckpointV1;
    const invocations = investigationUsageInvocations(this.store, taskId);
    const accountedTokens =
      invocations.length === 0 ? undefined : this.usageSummary(taskId).reportedTokens;
    const durationMs = Math.max(0, this.now().getTime() - Date.parse(checkpoint.recordedAt));
    if (request.kind === "analysis") {
      const execution = checkpoint.runtime.e2eExecution;
      const recordedE2eRecovery =
        task.kind === "pr-e2e" &&
        checkpoint.runtime.e2e !== undefined &&
        execution?.status === "completed" &&
        checkpoint.adoptedAttemptIds.includes(execution.attemptId) &&
        request.invocationId === undefined &&
        request.modelIdentity === undefined &&
        request.usage.tokens === 0 &&
        request.round.phase === "finalize" &&
        !request.round.continue &&
        (request.sourceUnitIds === undefined || request.sourceUnitIds.length === 0);
      if (recordedE2eRecovery) {
        // This is deterministic report reconstruction from immutable Worker receipts,
        // not a model call. Keep the original attempt's ledger charge unchanged.
        validateRootE2eRuntime(task, checkpoint, checkpoint.runtime);
        const expected = projectRecordedE2eAnalysis(task, checkpoint);
        requireCondition(
          investigationContentDigest(request.round.analysis) ===
            investigationContentDigest(expected.analysis),
          409,
          "e2e_recovery_analysis_mismatch",
          "E2E recovery must reproduce the exact analysis derived from its accepted execution receipts.",
        );
      }
      const invocation = invocations.find(
        (receipt) => receipt.invocationId === request.invocationId,
      );
      if (
        !recordedE2eRecovery &&
        (accountedTokens !== undefined || request.invocationId !== undefined)
      ) {
        requireCondition(
          invocation !== undefined &&
            invocation.taskId === taskId &&
            invocation.attemptId === record.attempt.id &&
            (task.kind === "pr-e2e"
              ? invocation.purpose === "e2e"
              : ["analysis", "recheck"].includes(invocation.purpose)) &&
            invocation.state === "completed" &&
            invocation.disposition !== "rejected" &&
            invocation.completeness === "complete" &&
            invocation.usage.totalTokens === request.usage.tokens &&
            (request.modelIdentity === undefined ||
              (request.modelIdentity.engine === invocation.engine &&
                request.modelIdentity.model === invocation.model)),
          409,
          "analysis_usage_mismatch",
          "Analysis must identify its exact completed model invocation and trusted usage receipt.",
        );
        const bound = this.store.get<{ attemptId: string; round: number }>(
          "idempotency",
          `model-usage-analysis:${request.invocationId}`,
        );
        requireCondition(
          bound === undefined ||
            (bound.attemptId === record.attempt.id && bound.round === request.round.round),
          409,
          "analysis_invocation_already_used",
          "A model invocation cannot be accepted as multiple analysis rounds.",
        );
      }
      requireCondition(
        !record.cancelRequested,
        409,
        "cancellation_requested",
        "This task must stop before starting further analysis.",
      );
      const validation = validateInvestigationAnalysisForTask(
        task,
        request.round.analysis,
        checkpoint.runtime,
      );
      requireCondition(
        validation.valid,
        400,
        "analysis_scope_violation",
        validation.errors.map((error) => error.message).join(" "),
      );
      next = applyInvestigationLoopRound(checkpoint, request.round, {
        recordedAt: this.time(),
        usage: { ...request.usage, durationMs },
        ...(accountedTokens === undefined ? {} : { accountedTokens }),
        ...(request.modelIdentity === undefined ? {} : { modelIdentity: request.modelIdentity }),
        ...(request.sourceUnitIds === undefined ? {} : { sourceUnitIds: request.sourceUnitIds }),
      });
    } else if (request.kind === "source") {
      requireCondition(
        !record.cancelRequested,
        409,
        "cancellation_requested",
        "Cancellation was accepted; no new source analysis may start.",
      );
      const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
      requireCondition(
        task.kind === "pr-review" &&
          subject?.kind === "original_pr" &&
          request.manifest.subjectRef === subject.id &&
          request.manifest.baseSha === subject.baseSha &&
          request.manifest.headSha === subject.headSha,
        400,
        "source_manifest_scope_mismatch",
        "The complete diff manifest must belong to this frozen original PR review.",
      );
      next = applyInvestigationSourceCoverage(checkpoint, request.manifest, {
        task,
        recordedAt: this.time(),
        durationMs,
      });
    } else if (request.kind === "interrupt") {
      if (request.modelInvocationState === "not_started") {
        const stage = investigationTaskProgress(this.store, taskId).stage;
        requireCondition(
          request.modelUsage === undefined &&
            (stage === null || stage === "prepare_source") &&
            !invocations.some((receipt) => receipt.attemptId === record.attempt.id) &&
            !this.store.hasPrefix("idempotency", `checkpoint:${record.attempt.id}:analysis:`) &&
            !(checkpoint.runtime.modelExecutions ?? []).some(
              (execution) => execution.attemptId === record.attempt.id,
            ) &&
            !(checkpoint.runtime.unacceptedModelUsage ?? []).some(
              (usage) => usage.attemptId === record.attempt.id,
            ) &&
            checkpoint.runtime.e2eExecution?.attemptId !== record.attempt.id &&
            !checkpoint.runtime.startedSteps.some((step) => step.attemptId === record.attempt.id),
          409,
          "model_dispatch_already_recorded",
          "A pre-dispatch declaration cannot replace a recorded model invocation or execution start.",
        );
      }
      const acceptedAnalysis =
        request.modelUsage === undefined
          ? undefined
          : this.store.get<CheckpointAcceptanceRecord>(
              "idempotency",
              `checkpoint:${record.attempt.id}:analysis:${request.modelUsage.round}`,
            );
      if (acceptedAnalysis !== undefined) {
        requireCondition(
          acceptedAnalysis.checkpoint.taskId === taskId &&
            acceptedAnalysis.checkpoint.attemptId === record.attempt.id &&
            acceptedAnalysis.checkpoint.round === request.modelUsage!.round,
          409,
          "model_usage_receipt_conflict",
          "Accepted model usage must identify this task, attempt, and analysis round.",
        );
        requireCondition(
          request.modelUsage!.tokens === null ||
            acceptedAnalysis.usageTokens === undefined ||
            acceptedAnalysis.usageTokens === request.modelUsage!.tokens,
          409,
          "model_usage_receipt_conflict",
          "This accepted analysis round already has a different token usage receipt.",
        );
      }
      // An accepted analysis response may have been lost after its atomic write. Its usage
      // is already charged, and a completed checkpoint remains available for delivery.
      next =
        acceptedAnalysis !== undefined && checkpoint.stopReason === "complete"
          ? checkpoint
          : interruptInvestigationLoop(
              checkpoint,
              request.reason,
              this.time(),
              request.diagnostics,
              durationMs,
              acceptedAnalysis === undefined ? request.modelUsage : undefined,
            );
    } else {
      requireCondition(
        task.executionPolicy.allowRepositoryExecution,
        403,
        "execution_not_authorized",
        "This task is not authorized for runtime execution.",
      );
      const runtime = request.execution;
      requireCondition(
        !record.cancelRequested ||
          runtime.startedSteps.every((step) =>
            checkpoint.runtime.startedSteps.some(
              (started) => investigationContentDigest(started) === investigationContentDigest(step),
            ),
          ),
        409,
        "cancellation_requested",
        "Cancellation was accepted. No new repository operation may start; existing operations may still publish their completion evidence.",
      );
      for (const artifact of runtime.artifacts) this.requireArtifact(artifact);
      const frozenInput = this.required<FrozenTaskInput>("idempotency", `input:${task.id}`);
      if (task.kind === "pr-e2e") {
        requireCondition(
          !record.cancelRequested || checkpoint.runtime.e2eExecution !== undefined,
          409,
          "cancellation_requested",
          "A cancelled E2E task cannot establish a new execution start.",
        );
        requireCondition(
          frozenInput.execution === null && frozenInput.plan === null,
          409,
          "e2e_saved_plan_unexpected",
          "Root E2E execution cannot inherit a saved executable plan.",
        );
        validateRootE2eRuntime(task, checkpoint, runtime);
      } else {
        requireCondition(
          frozenInput.execution !== null && frozenInput.plan !== null,
          409,
          "execution_binding_missing",
          "Runtime execution requires an explicitly saved executable plan binding.",
        );
        const execution = frozenInput.execution;
        requireCondition(
          runtime.startedSteps.every(
            (step) =>
              step.taskId === task.id &&
              checkpoint.adoptedAttemptIds.includes(step.attemptId) &&
              investigationContentDigest(step.planRef) ===
                investigationContentDigest(execution.planRef) &&
              step.subjectRef === execution.subjectRef &&
              step.subjectRevisionKey === execution.subjectRevisionKey &&
              execution.steps.some(
                (entry) => entry.stepId === step.stepId && entry.digest === step.stepDigest,
              ),
          ),
          400,
          "execution_binding_mismatch",
          "Every execution receipt must bind the exact frozen executable step and source.",
        );
      }
      requireCondition(
        runtime.evidence.every(
          (evidence) =>
            evidence.authority === "worker" &&
            evidence.provenance.taskId === task.id &&
            checkpoint.adoptedAttemptIds.includes(evidence.provenance.attemptId) &&
            [...task.subjects, ...runtime.subjects].some(
              (subject) => subject.id === evidence.subjectRef,
            ),
        ),
        400,
        "evidence_scope_violation",
        "Runtime observations must be produced by an adopted worker attempt for an authorized subject.",
      );
      requireCondition(
        runtime.subjects.every(
          (subject) =>
            subject.repositoryId === task.repository.id &&
            subject.workItemId === task.workItem.id &&
            subject.kind === "local_patch" &&
            task.subjects.some((base) => base.id === subject.baseSubjectRef) &&
            runtime.artifacts.some(
              (artifact) =>
                artifact.id === subject.artifactRef &&
                artifact.kind === "patch" &&
                artifact.digest === subject.patchDigest,
            ),
        ),
        400,
        "runtime_subject_invalid",
        "Runtime may only register an evidenced local patch based on an authorized subject.",
      );
      requireCondition(
        runtime.artifacts.every(
          (artifact) =>
            artifact.taskId === task.id &&
            checkpoint.adoptedAttemptIds.includes(artifact.attemptId) &&
            [...task.subjects, ...runtime.subjects].some(
              (subject) => subject.id === artifact.subjectRef,
            ),
        ),
        400,
        "artifact_scope_mismatch",
        "Accepted artifacts must refer to an authorized source or evidenced local patch.",
      );
      next = applyInvestigationRuntimeCheckpoint(checkpoint, runtime, {
        recordedAt: this.time(),
        durationMs,
        ...(accountedTokens === undefined ? {} : { accountedTokens }),
      });
    }
    if (accountedTokens !== undefined)
      next = projectInvestigationTokenConsumption(next, accountedTokens);
    this.store.transaction(() => {
      this.lease(worker, taskId, request.lease);
      const current = this.required<InvestigationLoopCheckpointV1>("checkpoints", taskId);
      requireCondition(
        current.version === checkpoint.version && current.digest === checkpoint.digest,
        409,
        "checkpoint_compare_and_swap_failed",
        "Another checkpoint was accepted before this write.",
      );
      this.store.put("checkpoints", taskId, next);
      if (request.kind === "interrupt" && request.modelInvocationState === "not_started")
        recordAttemptWithoutModelInvocation(this.store, next);
      if (request.kind === "analysis" && request.invocationId !== undefined)
        this.store.put("idempotency", `model-usage-analysis:${request.invocationId}`, {
          attemptId: record.attempt.id,
          round: request.round.round,
        });
      const meaningful =
        request.kind === "analysis"
          ? hasInvestigationSemanticProgress(checkpoint, next)
          : request.kind === "source"
            ? checkpoint.runtime.sourceCoverage === undefined
            : request.kind === "execution" &&
              (next.runtime.completedSteps.length > checkpoint.runtime.completedSteps.length ||
                next.runtime.evidence.length > checkpoint.runtime.evidence.length ||
                (checkpoint.runtime.e2e === undefined && next.runtime.e2e !== undefined));
      if (meaningful)
        recordMeaningfulInvestigationProgress(this.store, taskId, record.attempt.id, this.time());
      this.evidence.retainCheckpoint(next.runtime.artifacts);
      this.store.insert("idempotency", key, {
        digest,
        checkpoint: next,
        ...(request.kind === "analysis" ? { usageTokens: request.usage.tokens } : {}),
      });
      if (request.kind === "analysis" || request.kind === "source")
        this.options.onTaskProgress?.(task, next, record.attempt);
    });
    return { checkpoint: next };
  }

  workerPart(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: InvestigationReportPartRequest,
  ) {
    const { record } = this.lease(worker, taskId, request.lease);
    const part = request.part;
    requireCondition(
      part.taskId === taskId &&
        part.attemptId === record.attempt.id &&
        part.reportId === record.reportId &&
        part.reportVersion === 1,
      400,
      "part_scope_mismatch",
      "Report parts must belong to the active task, attempt, and report.",
    );
    const { digest: _digest, ...content } = part;
    requireCondition(
      part.digest === investigationContentDigest(content) && part.itemCount === part.items.length,
      400,
      "part_integrity_mismatch",
      "The part content, count, or digest is invalid.",
    );
    const previous = this.store.get<InvestigationReportPartV1>("reportParts", part.id);
    if (previous !== undefined) {
      requireCondition(
        investigationContentDigest(previous) === investigationContentDigest(part),
        409,
        "idempotency_conflict",
        "This report part identity already has different content.",
      );
      return { accepted: true as const };
    }
    requireCondition(
      !this.store.list<InvestigationReportPartV1>(
        "reportParts",
        (entry) => entry.reportId === part.reportId && entry.sequence === part.sequence,
      ).length,
      409,
      "part_sequence_conflict",
      "This sequence already contains a report part.",
    );
    this.store.transaction(() => {
      this.lease(worker, taskId, request.lease);
      this.store.insert("reportParts", part.id, part);
    });
    return { accepted: true as const };
  }
  workerFinalize(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: InvestigationFinalizeRequest,
  ) {
    const existing = this.store.get<InvestigationResultV1>("reports", request.header.report.id);
    if (existing !== undefined) {
      this.scope(worker, existing.context.repository.id);
      const record = this.required<AttemptRecord>("attempts", request.lease.attemptId);
      const finalization = this.store.get<{ digest: string }>(
        "idempotency",
        `finalize:${request.lease.attemptId}`,
      );
      requireCondition(
        existing.context.task.id === taskId &&
          existing.context.attempt.id === request.lease.attemptId &&
          record.attempt.workerId === worker.id &&
          record.attempt.leaseVersion === request.lease.fence &&
          constantTimeEqual(
            record.leaseTokenDigest,
            investigationContentDigest(request.lease.leaseToken),
          ) &&
          existing.report.logicalContentDigest === request.manifest.logicalContentDigest &&
          finalization?.digest === investigationContentDigest(request),
        409,
        "finalization_conflict",
        "The sealed report does not match this finalization retry.",
      );
      return {
        reportRef: {
          id: existing.report.id,
          version: existing.report.version,
          digest: existing.report.logicalContentDigest,
        },
      };
    }
    const { task, record } = this.lease(worker, taskId, request.lease);
    requireCondition(
      request.header.report.id === record.reportId && request.header.report.version === 1,
      400,
      "report_scope_mismatch",
      "The report identity must be allocated by the current attempt.",
    );
    const checkpoint = this.required<InvestigationLoopCheckpointV1>("checkpoints", taskId);
    requireCondition(
      !record.cancelRequested || request.header.outcome === "cancelled",
      409,
      "cancellation_requested",
      "An explicitly cancelled task cannot report successful completion.",
    );
    const parts = this.store
      .list<InvestigationReportPartV1>("reportParts", (part) => part.reportId === record.reportId)
      .sort((a, b) => a.sequence - b.sequence);
    const frozenInput = this.required<FrozenTaskInput>("idempotency", `input:${task.id}`);
    if (frozenInput.plan !== null) {
      const parent =
        task.parentReportRef === null
          ? undefined
          : this.store.get<InvestigationResultV1>("reports", task.parentReportRef.id);
      requireCondition(
        parent !== undefined &&
          parent.report.version === task.parentReportRef?.version &&
          parent.report.logicalContentDigest === task.parentReportRef.digest &&
          parent.plans.some(
            (plan) =>
              investigationContentDigest(plan) === investigationContentDigest(frozenInput.plan),
          ),
        409,
        "parent_plan_not_saved",
        "The inherited plan must still match its immutable stored parent report.",
      );
    }
    const result = assembleInvestigationReport({
      task,
      attempt: record.attempt,
      checkpoint,
      header: request.header,
      manifest: request.manifest,
      parts,
      parentPlan: frozenInput.plan,
    });
    const usageSnapshot = this.store.get<{ summary: InvestigationUsageSummary }>(
      "idempotency",
      `report-usage:${record.reportId}`,
    );
    requireCondition(
      usageSnapshot === undefined
        ? result.report.usage === undefined
        : result.report.usage !== undefined &&
            investigationContentDigest(result.report.usage) ===
              investigationContentDigest(usageSnapshot.summary),
      409,
      "report_usage_mismatch",
      "The report must preserve the Server's exact sealed usage snapshot.",
    );
    for (const artifact of result.artifacts) this.requireArtifact(artifact);
    const linkedRefs = [
      ...(result.assessment.kind === "pr"
        ? result.assessment.e2eAssessment.linkedValidationReportRefs
        : []),
      ...result.nextActions.flatMap((action) =>
        action.validationReportRef === null ? [] : [action.validationReportRef],
      ),
    ];
    for (const linked of linkedRefs) {
      const report = this.store.get<InvestigationResultV1>("reports", linked.id);
      requireCondition(
        report !== undefined &&
          report.report.version === linked.version &&
          report.report.logicalContentDigest === linked.digest &&
          report.context.repository.id === task.repository.id &&
          report.context.workItem.id === task.workItem.id,
        400,
        "linked_report_not_saved",
        "Linked validation must reference an existing report for this exact repository and work item.",
      );
    }
    const ref = {
      id: result.report.id,
      version: result.report.version,
      digest: result.report.logicalContentDigest,
    };
    this.store.transaction(() => {
      this.lease(worker, taskId, request.lease);
      const current = this.required<InvestigationLoopCheckpointV1>("checkpoints", taskId);
      requireCondition(
        current.digest === checkpoint.digest && current.version === checkpoint.version,
        409,
        "checkpoint_compare_and_swap_failed",
        "The report must seal the current accepted checkpoint.",
      );
      this.store.insert("reports", result.report.id, result);
      this.store.insert("idempotency", `finalize:${record.attempt.id}`, {
        digest: investigationContentDigest(request),
      });
      for (const finding of result.findings)
        this.store.insert("findings", `${result.report.id}:${finding.id}`, finding);
      for (const plan of result.plans)
        this.store.insert("plans", `${result.report.id}:${plan.id}`, plan);
      const finalized: InvestigationTaskV1 = {
        ...task,
        state: result.outcome,
        latestReportRef: ref,
        updatedAt: this.time(),
      };
      this.store.put("tasks", taskId, finalized);
      if (result.outcome === "completed") this.evidence.releaseParent(task);
      this.store.put("attempts", record.attempt.id, {
        ...record,
        attempt: {
          ...record.attempt,
          state: result.outcome,
          finishedAt: this.time(),
          terminationReason: result.report.loop.stopReason,
        },
      });
      this.resourceScheduler.terminate(record.attempt.id, result.outcome);
      this.options.onTaskStateChanged?.(finalized, result);
      this.options.onReportSealed?.(result, task);
    });
    return { reportRef: ref };
  }

  private requireArtifact(artifact: InvestigationArtifactV1): void {
    if (artifact.availability !== "available") return;
    this.evidence.requireAvailable(artifact);
  }
  workerArtifact(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: {
      lease: InvestigationWorkerLease;
      artifact: InvestigationArtifactV1;
      contentBase64: string;
    },
  ) {
    const { task, record } = this.lease(worker, taskId, request.lease);
    const { artifact } = request;
    requireCondition(
      artifact.taskId === task.id &&
        artifact.attemptId === record.attempt.id &&
        artifact.availability === "available",
      400,
      "artifact_scope_mismatch",
      "Artifact scope must match the active execution.",
    );
    const content = Buffer.from(request.contentBase64, "base64");
    requireCondition(
      content.toString("base64") === request.contentBase64 &&
        content.length === artifact.byteLength &&
        createHash("sha256").update(content).digest("hex") === artifact.digest,
      400,
      "artifact_integrity_mismatch",
      "Artifact bytes do not match the claimed content digest or length.",
    );
    this.evidence.upload(artifact, request.contentBase64, () => {
      this.lease(worker, taskId, request.lease);
    });
    return { accepted: true as const };
  }
  artifactMetadata(actor: InvestigationOperatorPrincipal, id: string) {
    this.task(actor, this.evidence.artifact(id).taskId);
    return this.evidence.current(id);
  }
  artifactContent(actor: InvestigationOperatorPrincipal, id: string) {
    this.task(actor, this.evidence.artifact(id).taskId);
    const record = this.evidence.content(id);
    return { artifact: record.artifact, content: Buffer.from(record.contentBase64, "base64") };
  }
  workerArtifactContent(
    worker: InvestigationWorkerPrincipal,
    taskId: string,
    request: { lease: InvestigationWorkerLease; artifactId: string },
  ) {
    const { task } = this.lease(worker, taskId, request.lease);
    const artifact = this.evidence.artifact(request.artifactId);
    const parent =
      task.parentReportRef === null
        ? undefined
        : this.store.get<InvestigationResultV1>("reports", task.parentReportRef.id);
    const isExactArtifact = (entry: InvestigationArtifactV1) =>
      investigationContentDigest(entry) === investigationContentDigest(artifact);
    const inheritedSourceAllowed =
      artifact.kind === "patch" &&
      task.sourceArtifacts?.some(isExactArtifact) === true &&
      task.subjects.some(
        (subject) =>
          subject.kind === "local_patch" &&
          (subject.id === task.subjectRef ||
            task.executionPolicy.allowedSubjectRefs.includes(subject.id)) &&
          subject.artifactRef === artifact.id &&
          subject.id === artifact.subjectRef &&
          subject.patchDigest === artifact.digest,
      );
    requireCondition(
      artifact.taskId === task.id ||
        (parent !== undefined &&
          parent.context.task.id === task.parentTaskId &&
          parent.context.repository.id === task.repository.id &&
          parent.context.workItem.id === task.workItem.id &&
          parent.report.version === task.parentReportRef?.version &&
          parent.report.logicalContentDigest === task.parentReportRef.digest &&
          (parent.artifacts.some(isExactArtifact) ||
            (inheritedSourceAllowed &&
              parent.context.sourceArtifacts?.some(isExactArtifact) === true))),
      403,
      "artifact_scope_mismatch",
      "The artifact must belong to this task, its exact parent report, or an explicitly authorized inherited patch source.",
    );
    return this.evidence.content(request.artifactId);
  }

  actionContext(...args: Parameters<InvestigationActions["actionContext"]>) {
    return this.actions.actionContext(...args);
  }
  createIntent(...args: Parameters<InvestigationActions["createIntent"]>) {
    return this.actions.createIntent(...args);
  }
  getIntent(...args: Parameters<InvestigationActions["getIntent"]>) {
    return this.actions.getIntent(...args);
  }
  confirmIntent(...args: Parameters<InvestigationActions["confirmIntent"]>) {
    return this.actions.confirmIntent(...args);
  }
  reconcileIntent(...args: Parameters<InvestigationActions["reconcileIntent"]>) {
    return this.actions.reconcileIntent(...args);
  }
}

export function resolveInvestigationSubject(
  store: InvestigationStore,
  repositoryId: string,
  workItemId: string,
  subjectRef: string,
): InvestigationSubjectV1 | undefined {
  const subjects = [
    ...store
      .list<InvestigationTaskV1>(
        "tasks",
        (task) => task.repository.id === repositoryId && task.workItem.id === workItemId,
      )
      .flatMap((task) => task.subjects),
    ...store
      .list<InvestigationResultV1>(
        "reports",
        (report) =>
          report.context.repository.id === repositoryId &&
          report.context.workItem.id === workItemId,
      )
      .flatMap((report) => report.context.subjects),
  ].filter(
    (subject) =>
      subject.id === subjectRef &&
      subject.repositoryId === repositoryId &&
      subject.workItemId === workItemId,
  );
  const first = subjects[0];
  if (
    first === undefined ||
    subjects.some(
      (subject) => investigationContentDigest(subject) !== investigationContentDigest(first),
    )
  )
    return undefined;
  return first;
}
