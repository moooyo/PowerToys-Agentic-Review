import {
  type ActionContextV1,
  type InvestigationActionGuard,
  type InvestigationActionIntentV1,
  type InvestigationActionKind,
  type InvestigationActionPayload,
  type InvestigationConfirmActionIntentRequest,
  InvestigationConfirmActionIntentRequestSchema,
  type InvestigationCreateActionIntentRequest,
  InvestigationCreateActionIntentRequestSchema,
  type InvestigationCreateTaskRequestV1,
  type InvestigationFeedbackDraft,
  type InvestigationLoopCheckpointV1,
  type InvestigationPlanV1,
  type InvestigationReportRef,
  type InvestigationResultV1,
  type InvestigationSubjectV1,
  type InvestigationTaskV1,
} from "@agentic-review/contracts";
import { evaluateInvestigationActions, investigationContentDigest } from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";
import { InvestigationRequestError, requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";
import type {
  InvestigationActionTransport,
  InvestigationOperatorPrincipal,
  InvestigationPrerequisiteResolver,
  InvestigationRepositoryRecord,
  InvestigationWorkItemRecord,
} from "./types.js";

export interface InvestigationActionsDependencies {
  readonly store: InvestigationStore;
  readonly now: () => Date;
  readonly idFactory: () => string;
  readonly transport?: InvestigationActionTransport;
  readonly enableExternalWrites: boolean;
  readonly resolvePlanPrerequisites?: InvestigationPrerequisiteResolver;
  readonly validateTaskAction?: (
    actor: InvestigationOperatorPrincipal,
    request: InvestigationCreateTaskRequestV1,
  ) => Promise<InvestigationActionGuard[]>;
  readonly createTask: (
    actor: InvestigationOperatorPrincipal,
    request: InvestigationCreateTaskRequestV1,
  ) => Promise<InvestigationTaskV1> | InvestigationTaskV1;
}

interface IntentBinding {
  readonly request: InvestigationCreateActionIntentRequest;
  readonly requestDigest: string;
}

interface IdempotencyRecord {
  readonly intentId: string;
  readonly requestDigest: string;
}

interface ActionData {
  readonly repository: InvestigationRepositoryRecord;
  readonly workItem: InvestigationWorkItemRecord;
  readonly reports: InvestigationResultV1[];
  readonly report: InvestigationResultV1 | null;
  readonly plans: InvestigationPlanV1[];
}

const externalActions = new Set<InvestigationActionKind>([
  "comment",
  "approve",
  "suggestion-comment",
  "request-changes",
  "close",
  "merge",
  "trigger-ci",
  "close-as-duplicate",
  "create-pr",
]);
const taskActions = new Set<InvestigationActionKind>(["start-task", "reviews.verify"]);
const navigationActions = new Set<InvestigationActionKind>([
  "view-validation",
  "view-changes",
  "view-evidence",
]);
const payloadKinds: Partial<Record<InvestigationActionKind, InvestigationActionPayload["kind"]>> = {
  comment: "feedback",
  approve: "feedback",
  "suggestion-comment": "feedback",
  "request-changes": "feedback",
  close: "close",
  "close-as-duplicate": "close",
  merge: "merge",
  "trigger-ci": "trigger-ci",
  "start-task": "task",
  "reviews.verify": "task",
  "create-pr": "create-pr",
  "view-validation": "navigate",
  "view-changes": "navigate",
  "view-evidence": "navigate",
};

function reportRef(report: InvestigationResultV1): InvestigationReportRef {
  return {
    id: report.report.id,
    version: report.report.version,
    digest: report.report.logicalContentDigest,
  };
}

function sameRef(
  left: InvestigationReportRef | null,
  right: InvestigationReportRef | null,
): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.id === right.id &&
        left.version === right.version &&
        left.digest === right.digest;
}

function targetFrom(workItem: InvestigationWorkItemRecord): ActionContextV1["target"] {
  return {
    kind: workItem.kind,
    state: workItem.state,
    headSha: workItem.subject.kind === "original_pr" ? workItem.subject.headSha : null,
    revisionKey: workItem.subject.revisionKey,
  };
}

function idempotencyId(actorId: string, key: string): string {
  return `action-request:${investigationContentDigest([actorId, key])}`;
}

function bindingId(intentId: string): string {
  return `action-intent-binding:${intentId}`;
}

function guard(code: string, satisfied: boolean, message: string): InvestigationActionGuard {
  return { code, satisfied, message };
}

/** Intent preparation is read-only; confirmation is the sole mutation boundary. */
export class InvestigationActions {
  constructor(private readonly dependencies: InvestigationActionsDependencies) {}

  async actionContext(
    actor: InvestigationOperatorPrincipal,
    workItemId: string,
    query: { reportId?: string } = {},
  ): Promise<ActionContextV1> {
    const data = this.readData(actor, workItemId, query.reportId);
    let target = targetFrom(data.workItem);
    let sourceAvailable = true;
    if (this.dependencies.transport !== undefined) {
      try {
        target = await this.dependencies.transport.readTarget(
          data.repository,
          data.workItem,
          actor,
        );
      } catch {
        sourceAvailable = false;
      }
    }
    requireCondition(
      target.kind === data.workItem.kind,
      409,
      "target_kind_changed",
      "The current work item kind has changed.",
    );
    const pending = this.pendingIntent(workItemId);
    let remoteCapabilities: readonly InvestigationActionKind[] = [];
    let permissionsAvailable = this.dependencies.transport?.readCapabilities !== undefined;
    if (sourceAvailable && this.dependencies.transport?.readCapabilities !== undefined) {
      try {
        remoteCapabilities = await this.dependencies.transport.readCapabilities(
          data.repository,
          data.workItem,
          actor,
        );
      } catch {
        permissionsAvailable = false;
      }
    }
    const capabilities = actor.permissions.includes("action:prepare")
      ? actor.actionCapabilities
          .filter(
            (action) =>
              !taskActions.has(action) ||
              (actor.permissions.includes("task:create") && actor.allowRepositoryExecution),
          )
          .filter((action) => !externalActions.has(action) || remoteCapabilities.includes(action))
      : [];
    const supportedActions: InvestigationActionKind[] = [
      "start-task",
      "reviews.verify",
      ...navigationActions,
    ];
    if (this.dependencies.enableExternalWrites && this.dependencies.transport !== undefined) {
      supportedActions.push(
        ...this.dependencies.transport.supportedActions.filter((action) =>
          externalActions.has(action),
        ),
      );
    }
    const checkpoints = this.readCheckpoints(data);
    const validatedSuggestionFindingIds = sourceAvailable
      ? await this.suggestionDefaults(actor, data, target)
      : [];
    const verifiedRemoteBranchSubjectIds: string[] = [];
    if (
      sourceAvailable &&
      data.report !== null &&
      this.dependencies.transport?.validateRemoteBranch !== undefined
    ) {
      for (const subject of data.report.context.subjects) {
        if (subject.kind !== "remote_branch") continue;
        try {
          await this.dependencies.transport.validateRemoteBranch(
            data.repository,
            data.workItem,
            subject,
            actor,
          );
          verifiedRemoteBranchSubjectIds.push(subject.id);
        } catch {
          // A branch proposal alone is never evidence of an existing verified remote branch.
        }
      }
    }
    const context = evaluateInvestigationActions({
      repositoryId: data.repository.id,
      workItemId,
      actor: { id: actor.id, displayName: actor.displayName },
      target,
      generatedAt: this.dependencies.now().toISOString(),
      result: data.report,
      capabilities,
      supportedActions,
      persistedPlans: data.plans,
      pendingSubmission:
        pending === undefined
          ? null
          : {
              intentId: pending.id,
              state: "unknown",
              message:
                pending.result?.message ??
                "Another submission is executing. Wait for its receipt before preparing another write.",
            },
      validatedReports: data.reports,
      validatedCheckpoints: checkpoints,
      linkedValidationReports: this.latestValidationReports(data),
      validatedSuggestionFindingIds,
      verifiedRemoteBranchSubjectIds,
    });
    const acknowledged = await this.acknowledgePlanPrerequisites(actor, data, context);
    return this.decorateContext(acknowledged, sourceAvailable, permissionsAvailable);
  }

  private async acknowledgePlanPrerequisites(
    actor: InvestigationOperatorPrincipal,
    data: ActionData,
    context: ActionContextV1,
  ): Promise<ActionContextV1> {
    if (data.report === null || this.dependencies.resolvePlanPrerequisites === undefined)
      return context;
    const nextActions: ActionContextV1["nextActions"] = [];
    for (const action of context.nextActions) {
      const plan = data.plans.find((entry) => sameRef(entry, action.planRef));
      if (plan === undefined || plan.prerequisites.length === 0) {
        nextActions.push(action);
        continue;
      }
      let acknowledged: readonly string[];
      try {
        acknowledged = await this.dependencies.resolvePlanPrerequisites(
          data.repository,
          data.workItem,
          data.report,
          plan,
          actor,
        );
      } catch {
        nextActions.push(action);
        continue;
      }
      const knownIds = new Set(plan.prerequisites.map((prerequisite) => prerequisite.id));
      if (!Array.isArray(acknowledged) || acknowledged.some((id) => !knownIds.has(id))) {
        nextActions.push(action);
        continue;
      }
      const acceptedGuards = new Set(acknowledged.map((id) => `prerequisite:${id}`));
      const guards = action.guards.map((entry) =>
        acceptedGuards.has(entry.code)
          ? {
              ...entry,
              satisfied: true,
              message:
                "This prerequisite is acknowledged by trusted configuration for the exact saved plan and profile.",
            }
          : entry,
      );
      const deferred = new Set(
        (taskActions.has(action.action) ? plan.prerequisites : [])
          .filter(
            (prerequisite) => prerequisite.kind === "source" || prerequisite.kind === "environment",
          )
          .map((prerequisite) => `prerequisite:${prerequisite.id}`),
      );
      const readyToExecute = guards.every((entry) => entry.satisfied);
      nextActions.push({
        ...action,
        guards,
        allowed: readyToExecute,
        readyToExecute,
        canPrepare: guards.every((entry) => entry.satisfied || deferred.has(entry.code)),
      });
    }
    return { ...context, nextActions };
  }

  async createIntent(
    actor: InvestigationOperatorPrincipal,
    body: InvestigationCreateActionIntentRequest,
    assertAuthorized?: (intent: InvestigationActionIntentV1) => void,
  ): Promise<InvestigationActionIntentV1> {
    requireCondition(
      Value.Check(InvestigationCreateActionIntentRequestSchema, body),
      400,
      "invalid_action_request",
      "The action request is invalid.",
    );
    const data = this.readData(actor, body.workItemId, body.reportRef?.id);
    this.authorize(actor, data.workItem.repositoryId, "action:prepare", body.action);
    const key = idempotencyId(actor.id, body.idempotencyKey);
    const requestDigest = investigationContentDigest(body);
    const previous = this.dependencies.store.get<IdempotencyRecord>("idempotency", key);
    if (previous !== undefined) {
      requireCondition(
        previous.requestDigest === requestDigest,
        409,
        "idempotency_conflict",
        "This idempotency key was already used with different action content.",
      );
      return this.getIntent(actor, previous.intentId);
    }
    const context = await this.actionContext(
      actor,
      body.workItemId,
      body.reportRef === null ? {} : { reportId: body.reportRef.id },
    );
    const guards = this.validateRequest(actor, body, data, context);
    const intent: InvestigationActionIntentV1 = {
      schemaVersion: "InvestigationActionIntentV1",
      id: this.dependencies.idFactory(),
      version: 1,
      idempotencyKey: body.idempotencyKey,
      action: body.action,
      repositoryId: data.repository.id,
      workItemId: body.workItemId,
      actorId: actor.id,
      subjectRef: body.subjectRef,
      expectedRevisionKey: body.expectedRevisionKey,
      expectedHeadSha: body.expectedHeadSha,
      reportRef: body.reportRef,
      payload: structuredClone(body.payload),
      payloadDigest: investigationContentDigest(body.payload),
      state: "prepared",
      guards,
      createdAt: this.dependencies.now().toISOString(),
      confirmedAt: null,
      result: null,
    };
    intent.guards = await this.taskActionGuards(actor, intent, data, guards);
    await this.validateTransportPayload(actor, intent, data);
    return this.dependencies.store.transaction(() => {
      const concurrent = this.dependencies.store.get<IdempotencyRecord>("idempotency", key);
      if (concurrent !== undefined) {
        requireCondition(
          concurrent.requestDigest === requestDigest,
          409,
          "idempotency_conflict",
          "This idempotency key was already used with different action content.",
        );
        return this.getIntent(actor, concurrent.intentId);
      }
      this.assertNoPendingWrite(intent);
      this.assertCurrentApprovalPolicy(actor, intent, context.target);
      assertAuthorized?.(intent);
      this.dependencies.store.insert("actionIntents", intent.id, intent);
      this.dependencies.store.insert("idempotency", key, {
        intentId: intent.id,
        requestDigest,
      } satisfies IdempotencyRecord);
      this.dependencies.store.insert("idempotency", bindingId(intent.id), {
        request: structuredClone(body),
        requestDigest,
      } satisfies IntentBinding);
      return intent;
    });
  }

  getIntent(actor: InvestigationOperatorPrincipal, id: string): InvestigationActionIntentV1 {
    const intent = this.dependencies.store.get<InvestigationActionIntentV1>("actionIntents", id);
    requireCondition(
      intent !== undefined,
      404,
      "action_intent_not_found",
      "The action intent does not exist.",
    );
    requireCondition(
      actor.repositoryIds.includes(intent.repositoryId) && intent.actorId === actor.id,
      403,
      "action_intent_forbidden",
      "This actor cannot access this action intent.",
    );
    return intent;
  }

  findIntentByIdempotencyKey(
    actor: InvestigationOperatorPrincipal,
    key: string,
  ): InvestigationActionIntentV1 | null {
    const record = this.dependencies.store.get<IdempotencyRecord>(
      "idempotency",
      idempotencyId(actor.id, key),
    );
    return record === undefined ? null : this.getIntent(actor, record.intentId);
  }

  async confirmIntent(
    actor: InvestigationOperatorPrincipal,
    id: string,
    body: InvestigationConfirmActionIntentRequest,
    assertAuthorized?: (intent: InvestigationActionIntentV1) => void,
    beforeTransportDispatch?: (intent: InvestigationActionIntentV1) => void,
  ): Promise<InvestigationActionIntentV1> {
    requireCondition(
      Value.Check(InvestigationConfirmActionIntentRequestSchema, body),
      400,
      "invalid_confirmation",
      "The action confirmation is invalid.",
    );
    let intent = this.getIntent(actor, id);
    this.authorize(actor, intent.repositoryId, "action:execute", intent.action);
    requireCondition(
      body.payloadDigest === intent.payloadDigest,
      409,
      "confirmation_digest_mismatch",
      "The reviewed payload does not match this action intent.",
    );
    if (["succeeded", "failed", "unknown", "executing"].includes(intent.state)) return intent;
    requireCondition(
      intent.state === "prepared" && body.version === intent.version,
      409,
      "confirmation_version_mismatch",
      "Prepare and review the current action intent before confirming it.",
    );
    const binding = this.readBinding(intent);
    const data = this.readData(actor, intent.workItemId, intent.reportRef?.id);
    const context = await this.actionContext(
      actor,
      intent.workItemId,
      intent.reportRef === null ? {} : { reportId: intent.reportRef.id },
    );
    const proposedGuards = this.validateRequest(actor, binding.request, data, context);
    const guards = await this.taskActionGuards(actor, intent, data, proposedGuards);
    requireCondition(
      guards.every((entry) => entry.satisfied),
      409,
      "action_guard_failed",
      guards
        .filter((entry) => !entry.satisfied)
        .map((entry) => entry.message)
        .join(" ") || "An action prerequisite is not satisfied.",
    );
    await this.validateTransportPayload(actor, intent, data);
    const acquired = this.dependencies.store.transaction(() => {
      const current = this.getIntent(actor, id);
      if (["succeeded", "failed", "unknown", "executing"].includes(current.state))
        return { intent: current, execute: false };
      requireCondition(
        current.state === "prepared" &&
          current.version === body.version &&
          current.payloadDigest === body.payloadDigest,
        409,
        "confirmation_version_mismatch",
        "The action intent changed while confirmation was being checked.",
      );
      this.assertNoPendingWrite(current);
      this.assertCurrentApprovalPolicy(actor, current, context.target);
      assertAuthorized?.(current);
      const executing: InvestigationActionIntentV1 = {
        ...current,
        version: current.version + 1,
        state: "executing",
        guards,
        confirmedAt: this.dependencies.now().toISOString(),
      };
      this.dependencies.store.put("actionIntents", id, executing);
      return { intent: executing, execute: true };
    });
    intent = acquired.intent;
    if (!acquired.execute) return intent;
    // The caller that persisted this transition owns execution. A second confirmation never sends again.
    return this.execute(actor, intent, data, assertAuthorized, beforeTransportDispatch);
  }

  async reconcileIntent(
    actor: InvestigationOperatorPrincipal,
    id: string,
  ): Promise<InvestigationActionIntentV1> {
    const intent = this.getIntent(actor, id);
    this.authorize(actor, intent.repositoryId, "action:execute", intent.action);
    if (intent.state === "succeeded" || intent.state === "failed") return intent;
    requireCondition(
      intent.state === "unknown" || intent.state === "executing",
      409,
      "intent_not_unknown",
      "Only an executing or unknown submission can be reconciled.",
    );
    this.readBinding(intent);
    const data = this.readData(actor, intent.workItemId, intent.reportRef?.id);
    if (taskActions.has(intent.action)) {
      const receipt = this.dependencies.store.get<{ digest: string; entityId: string }>(
        "idempotency",
        `task:${actor.id}:action:${intent.id}`,
      );
      const task =
        receipt === undefined
          ? undefined
          : this.dependencies.store.get<InvestigationTaskV1>("tasks", receipt.entityId);
      if (
        task !== undefined &&
        intent.payload.kind === "task" &&
        receipt?.digest === investigationContentDigest(this.taskRequest(intent)) &&
        task.repository.id === intent.repositoryId &&
        task.workItem.id === intent.workItemId &&
        task.kind === intent.payload.taskKind &&
        sameRef(task.parentReportRef, intent.reportRef) &&
        sameRef(task.planRef, intent.payload.planRef)
      ) {
        return this.finish(intent, "succeeded", {
          message: "The saved follow-up task was found by its idempotency receipt.",
          externalId: null,
          taskId: task.id,
        });
      }
      return intent.state === "unknown"
        ? intent
        : this.finish(intent, "unknown", {
            message: "No completed task receipt is available yet. The plan was not resubmitted.",
            externalId: null,
            taskId: null,
          });
    }
    if (!externalActions.has(intent.action)) return intent;
    requireCondition(
      this.dependencies.transport !== undefined,
      503,
      "action_transport_unavailable",
      "The action transport is unavailable for receipt reconciliation.",
    );
    try {
      const result = await this.dependencies.transport.reconcile(
        intent,
        data.repository,
        data.workItem,
        actor,
      );
      return this.finish(intent, result.state, { ...result, taskId: null });
    } catch {
      return this.finish(intent, "unknown", {
        message: "Receipt reconciliation failed. No operation was resubmitted.",
        externalId: intent.result?.externalId ?? null,
        taskId: null,
      });
    }
  }

  private readData(
    actor: InvestigationOperatorPrincipal,
    workItemId: string,
    selectedReportId?: string,
  ): ActionData {
    const workItem = this.dependencies.store.get<InvestigationWorkItemRecord>(
      "workItems",
      workItemId,
    );
    requireCondition(
      workItem !== undefined,
      404,
      "work_item_not_found",
      "The work item does not exist.",
    );
    requireCondition(
      actor.repositoryIds.includes(workItem.repositoryId),
      403,
      "repository_forbidden",
      "The actor is not authorized for this repository.",
    );
    const repository = this.dependencies.store.get<InvestigationRepositoryRecord>(
      "repositories",
      workItem.repositoryId,
    );
    requireCondition(
      repository !== undefined,
      404,
      "repository_not_found",
      "The repository does not exist.",
    );
    const reports = this.dependencies.store.list<InvestigationResultV1>(
      "reports",
      (entry) =>
        entry.context.repository.id === repository.id && entry.context.workItem.id === workItemId,
    );
    const tasks = new Map(
      this.dependencies.store
        .list<InvestigationTaskV1>(
          "tasks",
          (task) => task.repository.id === repository.id && task.workItem.id === workItemId,
        )
        .map((task) => [task.id, task]),
    );
    reports.sort(
      (left, right) =>
        (tasks.get(right.context.task.id)?.createdAt ?? "").localeCompare(
          tasks.get(left.context.task.id)?.createdAt ?? "",
        ) ||
        right.context.attempt.number - left.context.attempt.number ||
        right.report.version - left.report.version ||
        right.report.id.localeCompare(left.report.id),
    );
    const report =
      selectedReportId === undefined
        ? (reports[0] ?? null)
        : (reports.find((entry) => entry.report.id === selectedReportId) ?? null);
    requireCondition(
      selectedReportId === undefined || report !== null,
      404,
      "report_not_found",
      "The report does not belong to this work item.",
    );
    const plans =
      report === null
        ? []
        : report.plans.flatMap((plan) => {
            const saved = this.dependencies.store.get<InvestigationPlanV1>(
              "plans",
              `${report.report.id}:${plan.id}`,
            );
            return saved === undefined ? [] : [saved];
          });
    return { repository, workItem, reports, report, plans };
  }

  private authorize(
    actor: InvestigationOperatorPrincipal,
    repositoryId: string,
    permission: "action:prepare" | "action:execute",
    action: InvestigationActionKind,
  ): void {
    requireCondition(
      actor.repositoryIds.includes(repositoryId) &&
        actor.permissions.includes(permission) &&
        actor.actionCapabilities.includes(action),
      403,
      "action_forbidden",
      "The actor is not authorized for this action in this repository.",
    );
    if (taskActions.has(action))
      requireCondition(
        actor.permissions.includes("task:create") && actor.allowRepositoryExecution,
        403,
        "task_execution_not_authorized",
        "Starting this saved plan requires task creation and repository execution authorization.",
      );
  }

  private latestValidationReports(data: ActionData): InvestigationResultV1[] {
    if (data.report === null) return [];
    const parent = reportRef(data.report);
    const selected = new Set<string>();
    return data.reports.filter((report) => {
      if (!sameRef(report.context.parentReportRef, parent) || selected.has(report.context.task.id))
        return false;
      selected.add(report.context.task.id);
      return true;
    });
  }

  private readCheckpoints(
    data: ActionData,
  ): Array<{ task: InvestigationTaskV1; checkpoint: InvestigationLoopCheckpointV1 }> {
    return this.dependencies.store
      .list<InvestigationTaskV1>(
        "tasks",
        (task) =>
          task.repository.id === data.repository.id && task.workItem.id === data.workItem.id,
      )
      .flatMap((task) => {
        const checkpoint = this.dependencies.store.get<InvestigationLoopCheckpointV1>(
          "checkpoints",
          task.id,
        );
        return checkpoint === undefined ? [] : [{ task, checkpoint }];
      });
  }

  private assertCurrentApprovalPolicy(
    actor: InvestigationOperatorPrincipal,
    intent: InvestigationActionIntentV1,
    target: ActionContextV1["target"],
  ): void {
    if (intent.action !== "approve") return;
    const data = this.readData(actor, intent.workItemId, intent.reportRef?.id);
    const context = evaluateInvestigationActions({
      repositoryId: intent.repositoryId,
      workItemId: intent.workItemId,
      actor: { id: actor.id, displayName: actor.displayName },
      target,
      generatedAt: this.dependencies.now().toISOString(),
      result: data.report,
      capabilities: actor.actionCapabilities,
      persistedPlans: data.plans,
      validatedReports: data.reports,
      validatedCheckpoints: this.readCheckpoints(data),
    });
    requireCondition(
      context.hardContentBlockers.length === 0,
      409,
      "current_p0_prohibits_approval",
      "A confirmed unresolved P0 applies to the current original revision. Approval is prohibited.",
    );
  }

  private decorateContext(
    context: ActionContextV1,
    sourceAvailable: boolean,
    permissionsAvailable: boolean,
  ): ActionContextV1 {
    const additional = (action: InvestigationActionKind): InvestigationActionGuard[] => {
      const guards: InvestigationActionGuard[] = [];
      if (!navigationActions.has(action) && !sourceAvailable)
        guards.push(
          guard(
            "current_target_available",
            false,
            "The current upstream target could not be read. Retry source synchronization before preparing an operation.",
          ),
        );
      if (externalActions.has(action)) {
        if (!this.dependencies.enableExternalWrites)
          guards.push(
            guard(
              "external_writes_enabled",
              false,
              "External repository writes are disabled in this server configuration.",
            ),
          );
        if (!permissionsAvailable)
          guards.push(
            guard(
              "remote_permissions_available",
              false,
              "The authenticated account's current repository permissions could not be verified.",
            ),
          );
      }
      return guards;
    };
    return {
      ...context,
      ...(!sourceAvailable
        ? {
            recommendedActionId: null,
            recommendation: {
              action: "view-evidence" as const,
              reason:
                "The current upstream revision is unavailable. Inspect the existing evidence and restore source access before continuing.",
            },
          }
        : {}),
      fixedActions: context.fixedActions.map((entry) => {
        const guards = [...entry.guards, ...additional(entry.action)];
        return {
          ...entry,
          guards,
          allowed: guards.every((check) => check.satisfied),
          reason: guards.some((check) => !check.satisfied)
            ? guards
                .filter((check) => !check.satisfied)
                .map((check) => check.message)
                .join(" ")
            : entry.reason,
        };
      }),
      nextActions: context.nextActions.map((entry) => {
        const added = additional(entry.action);
        const guards = [...entry.guards, ...added];
        const readyToExecute = guards.every((check) => check.satisfied);
        return {
          ...entry,
          guards,
          allowed: readyToExecute,
          readyToExecute,
          canPrepare: entry.canPrepare && added.every((check) => check.satisfied),
        };
      }),
    };
  }

  private validateRequest(
    actor: InvestigationOperatorPrincipal,
    body: InvestigationCreateActionIntentRequest,
    data: ActionData,
    context: ActionContextV1,
  ): InvestigationActionGuard[] {
    requireCondition(
      payloadKinds[body.action] === body.payload.kind,
      400,
      "action_payload_mismatch",
      "The payload kind does not match the selected operation.",
    );
    requireCondition(
      context.target.revisionKey === body.expectedRevisionKey &&
        context.target.headSha === body.expectedHeadSha,
      409,
      "target_revision_changed",
      "The target revision changed. Prepare a new preview against the current revision.",
    );
    if (body.reportRef !== null)
      requireCondition(
        data.report !== null && sameRef(body.reportRef, reportRef(data.report)),
        409,
        "report_binding_changed",
        "The report version or content digest does not match the saved report.",
      );
    const savedAction =
      body.nextActionId === undefined
        ? undefined
        : context.nextActions.find((action) => action.id === body.nextActionId);
    if (body.nextActionId !== undefined)
      requireCondition(
        savedAction !== undefined &&
          savedAction.action === body.action &&
          savedAction.subjectRef === body.subjectRef &&
          body.reportRef !== null &&
          sameRef(body.reportRef, context.reportRef),
        400,
        "invalid_saved_action",
        "The selected saved action does not match this request and exact report binding.",
      );
    const fixedAction = context.fixedActions.find((action) => action.action === body.action);
    requireCondition(
      savedAction !== undefined || fixedAction !== undefined || navigationActions.has(body.action),
      400,
      "saved_action_required",
      "This operation requires an explicit, valid saved next action.",
    );
    const guards = [...(savedAction?.guards ?? fixedAction?.guards ?? [])];
    const deferredGuards = this.preparableTaskGuards(body.action, body.payload, data);
    const blockingGuards = guards.filter(
      (entry) => !entry.satisfied && !deferredGuards.has(entry.code),
    );
    requireCondition(
      blockingGuards.length === 0 &&
        (savedAction === undefined || !taskActions.has(body.action) || savedAction.canPrepare),
      409,
      "action_guard_failed",
      blockingGuards.map((entry) => entry.message).join(" ") ||
        "An action prerequisite is not satisfied.",
    );
    const subject = this.resolveSubject(data, body.subjectRef);
    requireCondition(
      subject !== undefined &&
        subject.repositoryId === data.repository.id &&
        subject.workItemId === data.workItem.id,
      400,
      "invalid_action_subject",
      "The action subject does not belong to this work item.",
    );
    if (body.action !== "create-pr" && !navigationActions.has(body.action)) {
      const currentOriginal =
        subject.revisionKey === context.target.revisionKey &&
        (context.target.kind === "pull_request"
          ? subject.kind === "original_pr" && subject.headSha === context.target.headSha
          : subject.kind === "issue_snapshot");
      const frozenIssueSource =
        taskActions.has(body.action) &&
        context.target.kind === "issue" &&
        subject.kind === "source_commit" &&
        savedAction !== undefined &&
        data.report !== null &&
        data.report.context.subjects.some(
          (candidate) =>
            candidate.kind === "issue_snapshot" &&
            candidate.repositoryId === data.repository.id &&
            candidate.workItemId === data.workItem.id &&
            candidate.revisionKey === context.target.revisionKey,
        );
      requireCondition(
        currentOriginal || frozenIssueSource,
        409,
        "action_subject_stale",
        "The action must bind to the current original work item revision or its explicitly frozen issue source.",
      );
      if (
        frozenIssueSource &&
        body.payload.kind === "task" &&
        body.payload.sourceCommit !== undefined
      ) {
        requireCondition(
          subject.kind === "source_commit" && subject.commitSha === body.payload.sourceCommit,
          409,
          "saved_source_commit_changed",
          "The selected source commit must match the source already frozen in this saved action.",
        );
      }
    }
    if (body.payload.kind === "feedback") this.validateFeedback(body, data);
    if (body.payload.kind === "task") {
      requireCondition(
        savedAction !== undefined &&
          body.reportRef !== null &&
          savedAction.taskKind === body.payload.taskKind &&
          sameRef(savedAction.planRef, body.payload.planRef),
        400,
        "invalid_task_plan_binding",
        "The follow-up task must exactly match the saved action and plan.",
      );
      requireCondition(
        actor.permissions.includes("task:create") && actor.allowRepositoryExecution,
        403,
        "task_execution_not_authorized",
        "The actor has not authorized repository execution for this task.",
      );
    }
    if (body.payload.kind === "close") {
      if (body.action === "close-as-duplicate") {
        requireCondition(
          data.workItem.kind === "issue" &&
            body.payload.reason === "duplicate" &&
            body.payload.duplicateNumber !== null &&
            body.payload.duplicateNumber !== data.workItem.number,
          400,
          "invalid_duplicate_target",
          "Closing as duplicate requires another issue in this repository.",
        );
        requireCondition(
          this.duplicateNumber(data) === body.payload.duplicateNumber,
          409,
          "duplicate_basis_mismatch",
          "The duplicate target must match the issue identified by the saved report and its evidence.",
        );
      } else
        requireCondition(
          body.payload.reason !== "duplicate" && body.payload.duplicateNumber === null,
          400,
          "invalid_close_payload",
          "Use the saved duplicate action to close an issue as duplicate.",
        );
    }
    if (body.payload.kind === "create-pr")
      requireCondition(
        savedAction !== undefined &&
          subject.kind === "remote_branch" &&
          body.payload.branchSubjectRef === subject.id,
        400,
        "remote_branch_required",
        "Creating a PR requires the saved existing remote branch subject.",
      );
    if (body.payload.kind === "navigate") {
      requireCondition(
        body.payload.reportRef !== null || body.payload.artifactRef !== null,
        400,
        "navigation_target_required",
        "Navigation requires a saved report or evidence artifact.",
      );
      if (body.payload.reportRef !== null)
        requireCondition(
          data.reports.some((entry) =>
            sameRef(
              reportRef(entry),
              body.payload.kind === "navigate" ? body.payload.reportRef : null,
            ),
          ),
          404,
          "navigation_report_not_found",
          "The navigation report does not belong to this work item.",
        );
      if (body.payload.artifactRef !== null)
        requireCondition(
          data.reports.some((entry) =>
            entry.artifacts.some(
              (artifact) =>
                body.payload.kind === "navigate" && artifact.id === body.payload.artifactRef,
            ),
          ),
          404,
          "navigation_artifact_not_found",
          "The artifact does not belong to this work item.",
        );
    }
    return guards;
  }

  private duplicateNumber(data: ActionData): number | null {
    const assessment = data.report?.assessment;
    const identifier =
      assessment?.kind === "bug"
        ? assessment.bugAssessment.duplicateOf?.identifier
        : assessment?.kind === "feature"
          ? assessment.featureAssessment.duplicateOf?.identifier
          : undefined;
    if (identifier === undefined) return null;
    const value = identifier.trim();
    const number =
      /^#?([1-9][0-9]*)$/u.exec(value)?.[1] ??
      (value.startsWith(`${data.repository.fullName}#`)
        ? /^([1-9][0-9]*)$/u.exec(value.slice(data.repository.fullName.length + 1))?.[1]
        : undefined);
    if (number !== undefined) return Number.isSafeInteger(Number(number)) ? Number(number) : null;
    try {
      const url = new URL(value);
      const prefix = `/${data.repository.fullName}/issues/`;
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(prefix)
      )
        return null;
      const suffix = url.pathname.slice(prefix.length);
      return /^[1-9][0-9]*$/u.test(suffix) && Number.isSafeInteger(Number(suffix))
        ? Number(suffix)
        : null;
    } catch {
      return null;
    }
  }

  private preparableTaskGuards(
    action: InvestigationActionKind,
    payload: InvestigationActionPayload,
    data: ActionData,
  ): Set<string> {
    if (!taskActions.has(action) || payload.kind !== "task") return new Set();
    const plan = data.plans.find((entry) => sameRef(entry, payload.planRef));
    return new Set(
      (plan?.prerequisites ?? [])
        .filter(
          (prerequisite) => prerequisite.kind === "source" || prerequisite.kind === "environment",
        )
        .map((prerequisite) => `prerequisite:${prerequisite.id}`),
    );
  }

  private async taskActionGuards(
    actor: InvestigationOperatorPrincipal,
    intent: InvestigationActionIntentV1,
    data: ActionData,
    proposedGuards: InvestigationActionGuard[],
  ): Promise<InvestigationActionGuard[]> {
    if (!taskActions.has(intent.action) || this.dependencies.validateTaskAction === undefined)
      return proposedGuards;
    let proof: InvestigationActionGuard[];
    try {
      proof = await this.dependencies.validateTaskAction(actor, this.taskRequest(intent));
      if (
        !Array.isArray(proof) ||
        proof.length === 0 ||
        proof.some(
          (entry) =>
            entry === null ||
            typeof entry !== "object" ||
            typeof entry.code !== "string" ||
            entry.code.trim().length === 0 ||
            typeof entry.satisfied !== "boolean" ||
            typeof entry.message !== "string" ||
            entry.message.trim().length === 0,
        )
      ) {
        proof = [
          guard(
            "task_execution_binding",
            false,
            "The trusted task preparation validator returned no valid execution readiness evidence.",
          ),
        ];
      }
    } catch (error) {
      proof = [
        guard(
          "task_execution_binding",
          false,
          error instanceof InvestigationRequestError
            ? error.message
            : "The trusted source and execution configuration could not be validated for this task request.",
        ),
      ];
    }
    const deferredGuards = this.preparableTaskGuards(intent.action, intent.payload, data);
    const ready = proof.every((entry) => entry.satisfied);
    return [
      ...proposedGuards.map((entry) =>
        ready && deferredGuards.has(entry.code)
          ? {
              ...entry,
              satisfied: true,
              message:
                "The source or environment prerequisite was verified against the reviewed task request and trusted execution configuration.",
            }
          : entry,
      ),
      ...proof,
    ];
  }

  private validateFeedback(body: InvestigationCreateActionIntentRequest, data: ActionData): void {
    if (body.payload.kind !== "feedback") return;
    const payload = body.payload;
    const report = body.reportRef === null ? null : data.report;
    const findings = new Map(report?.findings.map((finding) => [finding.id, finding]) ?? []);
    requireCondition(
      new Set(payload.findingIds).size === payload.findingIds.length &&
        new Set(payload.drafts.map((draft) => draft.id)).size === payload.drafts.length,
      400,
      "duplicate_feedback_selection",
      "Feedback selections and drafts must be unique.",
    );
    const allowedDrafts = new Map<string, InvestigationFeedbackDraft>();
    for (const id of payload.findingIds) {
      const finding = findings.get(id);
      requireCondition(
        finding !== undefined,
        400,
        "unknown_selected_finding",
        "A selected finding does not exist in the bound report.",
      );
      allowedDrafts.set(finding.feedbackDraft.id, finding.feedbackDraft);
    }
    const independentDrafts = new Map(
      report?.feedbackDrafts.map((draft) => [draft.id, draft]) ?? [],
    );
    for (const selectedDraft of payload.drafts) {
      const saved = independentDrafts.get(selectedDraft.id);
      if (saved !== undefined) allowedDrafts.set(saved.id, saved);
    }
    requireCondition(
      payload.drafts.length === allowedDrafts.size,
      400,
      "selected_feedback_incomplete",
      "Include exactly the feedback drafts selected for this operation.",
    );
    const ranges = new Map<string, Array<{ start: number; end: number }>>();
    for (const draft of payload.drafts) {
      const saved = allowedDrafts.get(draft.id);
      requireCondition(
        saved !== undefined,
        400,
        "unselected_feedback",
        "Only explicitly selected findings or independent drafts from the exact bound report may be included.",
      );
      if (draft.suggestion === null) continue;
      requireCondition(
        saved.suggestion !== null,
        400,
        "unsaved_code_suggestion",
        "A code suggestion must originate from the selected saved feedback draft.",
      );
      const { replacement: _replacement, ...binding } = draft.suggestion;
      const { replacement: _savedReplacement, ...savedBinding } = saved.suggestion;
      requireCondition(
        investigationContentDigest(binding) === investigationContentDigest(savedBinding) &&
          draft.suggestion.subjectRef === body.subjectRef &&
          draft.suggestion.headSha === body.expectedHeadSha,
        409,
        "suggestion_binding_mismatch",
        "Code suggestion source identity and range must match the saved feedback draft and current SHA.",
      );
      requireCondition(
        draft.suggestion.startLine <= draft.suggestion.endLine,
        400,
        "invalid_suggestion_range",
        "The code suggestion line range is invalid.",
      );
      const previous = ranges.get(draft.suggestion.path) ?? [];
      requireCondition(
        !previous.some(
          (range) =>
            range.start <= draft.suggestion!.endLine && draft.suggestion!.startLine <= range.end,
        ),
        400,
        "overlapping_suggestions",
        "Selected code suggestions must not overlap.",
      );
      previous.push({ start: draft.suggestion.startLine, end: draft.suggestion.endLine });
      ranges.set(draft.suggestion.path, previous);
    }
    const hasSuggestions = payload.drafts.some((draft) => draft.suggestion !== null);
    requireCondition(
      body.action !== "comment" || !hasSuggestions,
      400,
      "comment_contains_suggestion",
      "Choose suggestion-comment to include code suggestions.",
    );
    requireCondition(
      body.action !== "suggestion-comment" || hasSuggestions,
      400,
      "suggestion_required",
      "The selected operation requires at least one valid code suggestion.",
    );
    requireCondition(
      body.action === "approve" || payload.body.trim().length > 0 || payload.drafts.length > 0,
      400,
      "empty_feedback",
      "This feedback operation requires a message or selected drafts.",
    );
  }

  private resolveSubject(data: ActionData, id: string): InvestigationSubjectV1 | undefined {
    if (data.workItem.subject.id === id) return data.workItem.subject;
    return data.report?.context.subjects.find((subject) => subject.id === id);
  }

  private async suggestionDefaults(
    actor: InvestigationOperatorPrincipal,
    data: ActionData,
    target: ActionContextV1["target"],
  ): Promise<string[]> {
    if (
      data.report === null ||
      this.dependencies.transport?.validateSuggestions === undefined ||
      target.headSha === null
    )
      return [];
    const report = data.report;
    const findings = report.findings.filter((finding) => finding.feedbackDraft.suggestion !== null);
    const valid: string[] = [];
    for (const finding of findings) {
      const suggestion = finding.feedbackDraft.suggestion!;
      if (
        suggestion.headSha !== target.headSha ||
        findings.some((other) => {
          const replacement = other.feedbackDraft.suggestion;
          return (
            other.id !== finding.id &&
            replacement !== null &&
            replacement.path === suggestion.path &&
            replacement.startLine <= suggestion.endLine &&
            suggestion.startLine <= replacement.endLine
          );
        })
      )
        continue;
      const subject = report.context.subjects.find((entry) => entry.id === finding.subjectRef);
      if (
        subject?.kind !== "original_pr" ||
        subject.revisionKey !== target.revisionKey ||
        subject.headSha !== target.headSha
      )
        continue;
      const preview: InvestigationActionIntentV1 = {
        schemaVersion: "InvestigationActionIntentV1",
        id: `preview-${finding.id}`,
        version: 1,
        idempotencyKey: "read-only-suggestion-preview",
        action: "suggestion-comment",
        actorId: actor.id,
        repositoryId: data.repository.id,
        workItemId: data.workItem.id,
        subjectRef: finding.subjectRef,
        expectedRevisionKey: target.revisionKey,
        expectedHeadSha: target.headSha,
        reportRef: reportRef(report),
        payload: {
          kind: "feedback",
          body: "",
          findingIds: [finding.id],
          drafts: [finding.feedbackDraft],
        },
        payloadDigest: investigationContentDigest({
          kind: "feedback",
          body: "",
          findingIds: [finding.id],
          drafts: [finding.feedbackDraft],
        }),
        state: "prepared",
        guards: [],
        createdAt: this.dependencies.now().toISOString(),
        confirmedAt: null,
        result: null,
      };
      try {
        await this.dependencies.transport.validateSuggestions(
          data.repository,
          data.workItem,
          preview,
        );
        valid.push(finding.id);
      } catch {
        // Missing or stale source evidence must never select a replacement automatically.
      }
    }
    return valid;
  }

  private async validateTransportPayload(
    actor: InvestigationOperatorPrincipal,
    intent: InvestigationActionIntentV1,
    data: ActionData,
  ): Promise<void> {
    if (intent.action === "create-pr" && intent.payload.kind === "create-pr") {
      const subject = this.resolveSubject(data, intent.subjectRef);
      requireCondition(
        subject?.kind === "remote_branch" &&
          this.dependencies.transport?.validateRemoteBranch !== undefined,
        503,
        "remote_branch_validation_unavailable",
        "A source-aware transport is required to verify the existing remote branch.",
      );
      try {
        await this.dependencies.transport.validateRemoteBranch(
          data.repository,
          data.workItem,
          subject,
          actor,
          intent.payload.baseBranch,
        );
      } catch {
        throw new InvestigationRequestError(
          409,
          "remote_branch_validation_failed",
          "The existing remote branch or its verified base and head SHA could not be confirmed.",
        );
      }
    }
    if (
      intent.payload.kind !== "feedback" ||
      !intent.payload.drafts.some((draft) => draft.suggestion !== null)
    )
      return;
    requireCondition(
      this.dependencies.transport?.validateSuggestions !== undefined,
      503,
      "suggestion_validation_unavailable",
      "A source-aware transport is required to verify code suggestions.",
    );
    try {
      await this.dependencies.transport.validateSuggestions(data.repository, data.workItem, intent);
    } catch {
      throw new InvestigationRequestError(
        409,
        "suggestion_validation_failed",
        "The selected code suggestions could not be verified against the exact current source.",
      );
    }
  }

  private pendingIntent(
    workItemId: string,
    exceptId?: string,
  ): InvestigationActionIntentV1 | undefined {
    return this.dependencies.store.list<InvestigationActionIntentV1>(
      "actionIntents",
      (intent) =>
        intent.workItemId === workItemId &&
        intent.id !== exceptId &&
        !navigationActions.has(intent.action) &&
        (intent.state === "unknown" || intent.state === "executing"),
    )[0];
  }

  private assertNoPendingWrite(intent: InvestigationActionIntentV1): void {
    if (navigationActions.has(intent.action)) return;
    requireCondition(
      this.pendingIntent(intent.workItemId, intent.id) === undefined,
      409,
      "prior_submission_unknown",
      "Another submission is executing or has an unknown outcome. Resolve its receipt before another write.",
    );
  }

  private readBinding(intent: InvestigationActionIntentV1): IntentBinding {
    const binding = this.dependencies.store.get<IntentBinding>("idempotency", bindingId(intent.id));
    requireCondition(
      binding !== undefined &&
        binding.requestDigest === investigationContentDigest(binding.request) &&
        intent.payloadDigest === investigationContentDigest(binding.request.payload) &&
        intent.action === binding.request.action &&
        intent.workItemId === binding.request.workItemId &&
        intent.subjectRef === binding.request.subjectRef &&
        intent.expectedRevisionKey === binding.request.expectedRevisionKey &&
        intent.expectedHeadSha === binding.request.expectedHeadSha &&
        sameRef(intent.reportRef, binding.request.reportRef) &&
        investigationContentDigest(intent.payload) ===
          investigationContentDigest(binding.request.payload),
      409,
      "intent_binding_invalid",
      "The persisted action content no longer matches the reviewed binding.",
    );
    return binding;
  }

  private async execute(
    actor: InvestigationOperatorPrincipal,
    intent: InvestigationActionIntentV1,
    data: ActionData,
    assertAuthorized?: (intent: InvestigationActionIntentV1) => void,
    beforeTransportDispatch?: (intent: InvestigationActionIntentV1) => void,
  ): Promise<InvestigationActionIntentV1> {
    let dispatched = false;
    const checkDispatch = (recordDispatch: boolean) => {
      try {
        assertAuthorized?.(intent);
        if (recordDispatch) beforeTransportDispatch?.(intent);
      } catch (error) {
        // The transport invokes this only before issuing its mutation request.
        dispatched = false;
        if (error instanceof InvestigationRequestError) throw error;
        throw new InvestigationRequestError(
          403,
          "action_authorization_revoked",
          "The action is no longer authorized for dispatch.",
        );
      }
    };
    const beforeDispatch =
      assertAuthorized === undefined && beforeTransportDispatch === undefined
        ? undefined
        : () => checkDispatch(true);
    try {
      if (taskActions.has(intent.action)) {
        requireCondition(
          intent.payload.kind === "task" && intent.reportRef !== null,
          409,
          "task_binding_invalid",
          "The saved task binding is missing.",
        );
        dispatched = true;
        const task = await this.dependencies.createTask(actor, this.taskRequest(intent));
        return this.finish(intent, "succeeded", {
          message: "The saved follow-up plan was queued as a task.",
          externalId: null,
          taskId: task.id,
        });
      }
      if (navigationActions.has(intent.action))
        return this.finish(intent, "succeeded", {
          message: "The referenced evidence is available for navigation.",
          externalId: null,
          taskId: null,
        });
      requireCondition(
        externalActions.has(intent.action) &&
          this.dependencies.enableExternalWrites &&
          this.dependencies.transport !== undefined,
        503,
        "external_writes_unavailable",
        "External writes are disabled or no supported transport is installed.",
      );
      // The transport owns the final dispatch boundary; this earlier check grants no receipt.
      checkDispatch(false);
      dispatched = true;
      const result =
        beforeDispatch === undefined
          ? await this.dependencies.transport.execute(intent, data.repository, data.workItem, actor)
          : await this.dependencies.transport.execute(
              intent,
              data.repository,
              data.workItem,
              actor,
              beforeDispatch,
            );
      return this.finish(intent, result.state, {
        message: result.message,
        externalId: result.externalId,
        taskId: null,
      });
    } catch (error) {
      return this.finish(
        intent,
        !dispatched && error instanceof InvestigationRequestError ? "failed" : "unknown",
        {
          message:
            !dispatched && error instanceof InvestigationRequestError
              ? error.message
              : "Execution did not return a confirmed receipt. Reconcile this intent before attempting another write.",
          externalId: null,
          taskId: null,
        },
      );
    }
  }

  private taskRequest(intent: InvestigationActionIntentV1): InvestigationCreateTaskRequestV1 {
    requireCondition(
      intent.payload.kind === "task" && intent.reportRef !== null,
      409,
      "task_binding_invalid",
      "The saved task binding is missing.",
    );
    return {
      idempotencyKey: `action:${intent.id}`,
      workItemId: intent.workItemId,
      kind: intent.payload.taskKind,
      parentReportRef: intent.reportRef,
      planRef: intent.payload.planRef,
      executionMode: "execute",
      ...(intent.payload.sourceCommit === undefined
        ? {}
        : { sourceCommit: intent.payload.sourceCommit }),
    };
  }

  private finish(
    previous: InvestigationActionIntentV1,
    state: "succeeded" | "failed" | "unknown",
    result: NonNullable<InvestigationActionIntentV1["result"]>,
  ): InvestigationActionIntentV1 {
    return this.dependencies.store.transaction(() => {
      const current = this.dependencies.store.get<InvestigationActionIntentV1>(
        "actionIntents",
        previous.id,
      );
      requireCondition(
        current !== undefined,
        404,
        "action_intent_not_found",
        "The action intent does not exist.",
      );
      if (
        current.version !== previous.version ||
        current.state === "succeeded" ||
        current.state === "failed"
      )
        return current;
      const finished: InvestigationActionIntentV1 = {
        ...current,
        state,
        version: current.version + 1,
        result,
      };
      this.dependencies.store.put("actionIntents", finished.id, finished);
      return finished;
    });
  }
}
