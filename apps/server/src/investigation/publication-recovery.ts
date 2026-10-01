import {
  type InvestigationPublicationRecoveryBlocker,
  type InvestigationPublicationRecoveryRequest,
  InvestigationPublicationRecoveryRequestSchema,
  type InvestigationPublicationRecoveryStatus,
  type InvestigationResultV1,
  InvestigationResultV1Schema,
  type InvestigationTaskV1,
  InvestigationTaskV1Schema,
  validateInvestigationResult,
  validateInvestigationTask,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { requireCondition } from "./errors.js";
import type { InvestigationProgressReplies } from "./progress-reply.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal, InvestigationWorkItemRecord } from "./types.js";

const equal = (left: unknown, right: unknown) =>
  investigationContentDigest(left ?? null) === investigationContentDigest(right ?? null);

/** Recovers only an exact native saved report; it never schedules investigation execution. */
export class InvestigationPublicationRecovery {
  constructor(
    private readonly options: {
      readonly store: InvestigationStore;
      readonly progress: InvestigationProgressReplies;
    },
  ) {
    if (!FormatRegistry.Has("date-time"))
      FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  }

  read(
    actor: InvestigationOperatorPrincipal,
    taskId: string,
  ): InvestigationPublicationRecoveryStatus {
    const task = this.#task(actor, taskId);
    const report =
      task.latestReportRef === null
        ? undefined
        : this.options.store.get<InvestigationResultV1>("reports", task.latestReportRef.id);
    const recovery = this.options.progress.savedReportRecovery(actor, task);
    let blocker: InvestigationPublicationRecoveryBlocker | null = null;
    if (
      !Value.Check(InvestigationTaskV1Schema, task) ||
      !validateInvestigationTask(task).valid ||
      task.state !== "completed" ||
      task.parentTaskId !== null ||
      task.parentReportRef !== null ||
      task.planRef !== null ||
      !["pr-review", "pr-e2e", "issue-investigate"].includes(task.kind)
    )
      blocker = "unsupported_task";
    else if (!this.#reportMatches(task, report)) blocker = "report_unavailable";
    else if (!equal(this.options.store.get("repositories", task.repository.id), task.repository))
      blocker = "repository_identity_changed";
    else {
      const item = this.options.store.get<InvestigationWorkItemRecord>(
        "workItems",
        task.workItem.id,
      );
      if (
        item === undefined ||
        item.repositoryId !== task.repository.id ||
        item.kind !== task.workItem.kind ||
        item.number !== task.workItem.number
      )
        blocker = "work_item_identity_changed";
      else if (
        this.options.store.list<InvestigationTaskV1>(
          "tasks",
          (candidate) =>
            candidate.id !== task.id &&
            candidate.parentTaskId === null &&
            candidate.repository.id === task.repository.id &&
            candidate.workItem.kind === task.workItem.kind &&
            candidate.workItem.number === task.workItem.number &&
            (candidate.kind === "pr-e2e") === (task.kind === "pr-e2e") &&
            candidate.createdAt >= task.createdAt,
        ).length > 0
      )
        blocker = "newer_task";
      else blocker = recovery.blocker;
    }
    const existing =
      blocker === null &&
      recovery.publication?.taskId === task.id &&
      recovery.publication.reportId === task.latestReportRef?.id;
    const state = blocker !== null ? "blocked" : existing ? "existing" : "missing";
    return {
      taskId,
      reportId: task.latestReportRef?.id ?? null,
      version: investigationContentDigest({
        task,
        report: report ?? null,
        recovery,
        state,
        blocker,
      }),
      state,
      blocker,
      publication: recovery.publication,
      availableActions: state === "missing" ? ["enqueue"] : [],
    };
  }

  enqueue(
    actor: InvestigationOperatorPrincipal,
    taskId: string,
    request: InvestigationPublicationRecoveryRequest,
  ): InvestigationPublicationRecoveryStatus {
    return this.options.store.transaction(() => {
      const task = this.#task(actor, taskId);
      requireCondition(
        Value.Check(InvestigationPublicationRecoveryRequestSchema, request) &&
          request.idempotencyKey.trim().length > 0,
        400,
        "invalid_publication_recovery_request",
        "Saved report recovery requires an exact version, report ID, and idempotency key.",
      );
      requireCondition(
        actor.permissions.includes("action:prepare") &&
          actor.permissions.includes("action:execute") &&
          actor.actionCapabilities.includes("comment"),
        403,
        "publication_recovery_forbidden",
        "This identity cannot request saved report publication.",
      );
      const key = `publication-recovery:command:${investigationContentDigest([taskId, actor.id, request.idempotencyKey])}`;
      const digest = investigationContentDigest({ taskId, request });
      const previous = this.options.store.get<{
        digest: string;
        result: InvestigationPublicationRecoveryStatus;
      }>("idempotency", key);
      if (previous !== undefined) {
        requireCondition(
          previous.digest === digest,
          409,
          "publication_recovery_command_conflict",
          "This idempotency key already belongs to another recovery request.",
        );
        return previous.result;
      }
      const current = this.read(actor, taskId);
      requireCondition(
        current.version === request.version && current.reportId === request.reportId,
        409,
        "publication_recovery_version_conflict",
        "The task or publication changed; refresh before retrying.",
      );
      requireCondition(
        current.availableActions.includes("enqueue"),
        409,
        "publication_recovery_unavailable",
        "Saved report publication is unavailable under the current conditions.",
      );
      const report = this.options.store.get<InvestigationResultV1>("reports", request.reportId)!;
      this.options.progress.enqueueSavedReport(actor, task, report);
      const result = this.read(actor, taskId);
      requireCondition(
        result.state === "existing",
        409,
        "publication_recovery_not_enrolled",
        "The saved report could not be attached to its publication.",
      );
      this.options.store.insert("idempotency", key, { digest, result });
      return result;
    });
  }

  #task(actor: InvestigationOperatorPrincipal, id: string): InvestigationTaskV1 {
    const task = this.options.store.get<InvestigationTaskV1>("tasks", id);
    requireCondition(task !== undefined, 404, "task_not_found", "The task is unavailable.");
    requireCondition(
      actor.repositoryIds.includes(task.repository.id),
      403,
      "repository_forbidden",
      "This identity cannot read this repository's tasks.",
    );
    return task;
  }

  #reportMatches(task: InvestigationTaskV1, report: InvestigationResultV1 | undefined): boolean {
    if (
      report === undefined ||
      !Value.Check(InvestigationResultV1Schema, report) ||
      !validateInvestigationResult(report).valid
    )
      return false;
    const { logicalContentDigest, ...content } = report.report;
    return (
      task.latestReportRef !== null &&
      task.latestReportRef.id === report.id &&
      report.id === report.report.id &&
      task.latestReportRef.version === report.version &&
      report.version === report.report.version &&
      task.latestReportRef.digest === logicalContentDigest &&
      investigationContentDigest({ ...report, report: content }) === logicalContentDigest &&
      report.outcome === "completed" &&
      report.report.delivery === "final" &&
      report.report.completeness === "complete" &&
      report.report.loop.stopReason === "complete" &&
      report.context.task.id === task.id &&
      report.context.task.kind === task.kind &&
      report.context.task.parentTaskId === null &&
      report.context.parentReportRef === null &&
      report.context.task.subjectRef === task.subjectRef &&
      equal(report.context.repository, task.repository) &&
      equal(report.context.workItem, task.workItem) &&
      task.subjects.every((subject) =>
        equal(
          report.context.subjects.find((candidate) => candidate.id === subject.id),
          subject,
        ),
      ) &&
      report.context.subjects.every(
        (subject) =>
          subject.repositoryId === task.repository.id && subject.workItemId === task.workItem.id,
      ) &&
      equal(report.context.reviewBaseline ?? null, task.reviewBaseline ?? null) &&
      equal(report.context.sourceArtifacts ?? null, task.sourceArtifacts ?? null) &&
      equal(report.context.profileRef, task.profileRef) &&
      equal(report.context.promptRef, task.promptRef)
    );
  }
}
