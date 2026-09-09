import type {
  DashboardReviewRunDetail,
  OperatorPrincipal,
  ReviewRunDecisionChangeRequest,
  ReviewRunDecisionContext,
  ReviewRunDecisionEvent,
  ReviewRunDecisionPolicySnapshot,
} from "@agentic-review/contracts";
import type { AccessAdapter } from "../access/adapter";
import { MockAccessAdapter } from "../access/mock-adapter";
import { readAccessContext, samePrincipal } from "../access/validation";
import { ReviewControlHttpError, ReviewControlRequestError } from "../review-control/errors";
import type { ReviewRunAdapter } from "../runs/adapter";
import { MockReviewRunAdapter } from "../runs/mock-adapter";
import { validateRunDetail } from "../runs/validation";
import type { DecisionAdapter, DecisionPageQuery } from "./adapter";
import {
  decisionState,
  normalizeDecisionPage,
  readDecisionChange,
  readDecisionContext,
  readDecisionHistory,
  validateDecisionActor,
  validateDecisionChange,
  validateDecisionScope,
} from "./validation";

export interface MockDecisionAdapterOptions {
  readonly runs?: Pick<ReviewRunAdapter, "mode" | "get">;
  readonly access?: Pick<AccessAdapter, "mode" | "context">;
  readonly now?: () => Date;
}

function failure(operation: string, status: 403 | 404 | 409, message: string): never {
  throw new ReviewControlHttpError(message, {
    operation,
    status,
    retryable: false,
    serverCode:
      status === 403
        ? "PLATFORM_FORBIDDEN"
        : status === 404
          ? "PLATFORM_NOT_FOUND"
          : "PLATFORM_CONFLICT",
  });
}

function key(repositoryId: string, reviewRunId: string): string {
  return JSON.stringify([repositoryId, reviewRunId]);
}

function intent(input: ReviewRunDecisionChangeRequest, actor: OperatorPrincipal): string {
  return JSON.stringify([
    actor.issuer,
    actor.subject,
    input.changeId,
    input.expectedVersion,
    input.expectedRevisionKey,
    input.expectedPlanDigest,
    input.expectedResultSetDigest,
    input.action,
    input.reason,
    input.action === "withdraw" ? input.targetDecisionId : null,
  ]);
}

async function sampleDigest(run: DashboardReviewRunDetail): Promise<string> {
  // Sample-only identity follows visible run/job facts. Production digests come solely from the server.
  const value = JSON.stringify({
    repositoryId: run.repositoryId,
    reviewRunId: run.id,
    revisionKey: run.revisionKey,
    currentRevisionKey: run.currentRevisionKey,
    planDigest: run.planDigest,
    requestEpochId: run.requestEpochId,
    freshness: run.freshness,
    ...(run.policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
      ? {
          policyVersion: run.policy.policyVersion,
          findingDispositionDigest: run.policy.findingDispositionDigest,
        }
      : {}),
    requests: [...run.requests]
      .sort((left, right) => left.requestId.localeCompare(right.requestId))
      .map((entry) => ({
        requestId: entry.requestId,
        required: entry.required,
        profileVersionId: entry.profile?.id ?? null,
        promptVersionId: entry.prompt?.id ?? null,
        job:
          entry.latestJob === null
            ? null
            : {
                id: entry.latestJob.jobId,
                activation: entry.latestJob.activationNumber,
                status: entry.latestJob.status,
                attemptCount: entry.latestJob.attemptCount,
                runAttemptId: entry.latestJob.runAttemptId,
                resultId: entry.latestJob.resultId,
                resultDigest: entry.latestJob.resultDigest,
              },
      })),
  });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function policySnapshot(context: ReviewRunDecisionContext): ReviewRunDecisionPolicySnapshot {
  const policy = context.policy;
  const codes = [...new Set(policy.reasons.map((reason) => reason.code))];
  return {
    ...(policy.policyVersion === "required-checks-and-unresolved-p0-p1-v2"
      ? {
          policyVersion: policy.policyVersion,
          unresolvedBlockingFindingCount: policy.unresolvedBlockingFindingCount,
          findingDispositionDigest: policy.findingDispositionDigest,
        }
      : { policyVersion: policy.policyVersion }),
    blockingFindingCount: policy.blockingFindingCount,
    reasonCount: policy.reasonCount,
    reasonCodes: codes.slice(0, 128),
    reasonCodesTruncated: codes.length > 128,
    ...(policy.applicable
      ? { applicable: true, eligible: policy.eligible }
      : { applicable: false, eligible: null }),
  };
}

export class MockDecisionAdapter implements DecisionAdapter {
  readonly mode = "sample" as const;
  private readonly runs: Pick<ReviewRunAdapter, "mode" | "get">;
  private readonly access: Pick<AccessAdapter, "mode" | "context">;
  private readonly now: () => Date;
  private readonly events = new Map<string, ReviewRunDecisionEvent[]>();
  private readonly intents = new Map<string, { intent: string; event: ReviewRunDecisionEvent }>();

  constructor(options: MockDecisionAdapterOptions = {}) {
    this.runs = options.runs ?? new MockReviewRunAdapter();
    this.access = options.access ?? new MockAccessAdapter();
    this.now = options.now ?? (() => new Date());
    if (this.runs.mode !== "sample" || this.access.mode !== "sample")
      throw new ReviewControlRequestError(
        "initialize sample decisions",
        "mode",
        "Sample decisions require explicit sample run and access adapters.",
      );
  }

  private async permission(
    repositoryId: string,
    operation: string,
    action?: ReviewRunDecisionChangeRequest["action"],
    actor?: OperatorPrincipal,
  ) {
    const context = readAccessContext(
      await this.access.context(repositoryId),
      operation,
      repositoryId,
    );
    if (context.repository === null || !context.repository.permissions.includes("read"))
      failure(operation, 404, "The review run was not found.");
    if (actor !== undefined && !samePrincipal(context.principal, actor))
      failure(operation, 403, "The current operator does not match this decision intent.");
    if (
      action !== undefined &&
      !context.repository.permissions.includes(
        action === "override_approve" ? "configure" : "review",
      )
    )
      failure(operation, 403, "The current operator cannot record this decision.");
    return context;
  }

  private withEvents(base: ReviewRunDecisionContext): ReviewRunDecisionContext {
    const history = this.events.get(key(base.repositoryId, base.reviewRunId)) ?? [];
    const recordedDecision =
      [...history].reverse().find((event) => event.action !== "comment") ?? null;
    const context = {
      ...base,
      version: history.length,
      recordedDecision,
    } as ReviewRunDecisionContext;
    return { ...context, ...decisionState(context) };
  }

  async getContext(repositoryId: string, reviewRunId: string): Promise<ReviewRunDecisionContext> {
    const operation = "get review run decision context";
    validateDecisionScope(repositoryId, reviewRunId, operation);
    await this.permission(repositoryId, operation);
    const run = validateRunDetail(await this.runs.get(repositoryId, reviewRunId), operation, {
      repositoryId,
      id: reviewRunId,
    });
    const resultSetDigest = await sampleDigest(run);
    await this.permission(repositoryId, operation);
    const sourceCurrent = run.freshness === "current";
    const base = {
      repositoryId,
      reviewRunId,
      workItemId: run.workItemId,
      revisionKey: run.revisionKey,
      currentRevisionKey: run.currentRevisionKey,
      planDigest: run.planDigest,
      resultSetDigest,
      sourceCurrent,
      version: 0,
      recordedDecision: null,
      recordedDecisionState: "none",
      stateReasons: [],
      ...(run.workItemKind === "pull_request"
        ? {
            workItemKind: "pull_request",
            policy: run.policy,
            canApprove: sourceCurrent && run.policy.eligible,
          }
        : { workItemKind: "issue", policy: run.policy, canApprove: false }),
    } as ReviewRunDecisionContext;
    return structuredClone(
      readDecisionContext(this.withEvents(base), repositoryId, reviewRunId, operation),
    );
  }

  async listHistory(repositoryId: string, reviewRunId: string, query?: DecisionPageQuery) {
    const operation = "list review run decision history";
    const normalized = normalizeDecisionPage(query, operation);
    await this.getContext(repositoryId, reviewRunId);
    const events = [...(this.events.get(key(repositoryId, reviewRunId)) ?? [])].reverse();
    const offset = (normalized.page - 1) * normalized.pageSize;
    return structuredClone(
      readDecisionHistory(
        {
          repositoryId,
          reviewRunId,
          ...normalized,
          total: events.length,
          items: events.slice(offset, offset + normalized.pageSize),
        },
        repositoryId,
        reviewRunId,
        normalized,
        operation,
      ),
    );
  }

  async change(
    repositoryId: string,
    reviewRunId: string,
    input: ReviewRunDecisionChangeRequest,
    actor: OperatorPrincipal,
  ) {
    const operation = "change review run decision";
    validateDecisionScope(repositoryId, reviewRunId, operation);
    const request = structuredClone(validateDecisionChange(input, operation));
    const principal = structuredClone(validateDecisionActor(actor, operation));
    await this.permission(repositoryId, operation, request.action, principal);
    const base = await this.getContext(repositoryId, reviewRunId);
    const access = await this.permission(repositoryId, operation, request.action, principal);
    const context = this.withEvents(base);
    const changeKey = JSON.stringify([repositoryId, reviewRunId, request.changeId]);
    const requestIntent = intent(request, principal);
    const existing = this.intents.get(changeKey);
    if (existing !== undefined) {
      if (existing.intent !== requestIntent)
        failure(operation, 409, "The change ID was already used for another decision intent.");
      if (request.action === "withdraw") {
        const target = (this.events.get(key(repositoryId, reviewRunId)) ?? []).find(
          (event) => event.id === request.targetDecisionId,
        );
        if (
          target === undefined ||
          (!samePrincipal(target.actor, principal) &&
            !access.repository?.permissions.includes("configure"))
        )
          failure(operation, 403, "The current operator cannot withdraw the original decision.");
      }
      return structuredClone(
        readDecisionChange(
          { change: existing.event, replayed: true },
          repositoryId,
          reviewRunId,
          request,
          principal,
          operation,
        ),
      );
    }
    if (
      context.version !== request.expectedVersion ||
      context.revisionKey !== request.expectedRevisionKey ||
      context.planDigest !== request.expectedPlanDigest ||
      context.resultSetDigest !== request.expectedResultSetDigest
    )
      failure(
        operation,
        409,
        "The run or decisions changed. Refresh before submitting a new decision.",
      );
    if (context.policy.reasonsTruncated)
      failure(
        operation,
        409,
        "Sample decisions require a complete policy preview. Connect to the server to record this decision.",
      );
    if (
      (request.action === "approve" || request.action === "override_approve") &&
      context.workItemKind !== "pull_request"
    )
      failure(operation, 409, "Approval actions apply only to pull requests.");
    if (request.action !== "comment" && request.action !== "withdraw" && !context.sourceCurrent)
      failure(operation, 409, "The current source does not permit a new handling decision.");
    if (request.action === "approve" && !context.canApprove)
      failure(
        operation,
        409,
        "The current source and required validation policy do not permit approval.",
      );
    const current =
      context.recordedDecision?.action === "withdraw" ? null : context.recordedDecision;
    if (
      request.action === "withdraw" &&
      (current === null || current.id !== request.targetDecisionId)
    )
      failure(operation, 409, "Only the currently recorded decision can be withdrawn.");
    if (
      request.action === "withdraw" &&
      current !== null &&
      !samePrincipal(current.actor, principal) &&
      !access.repository?.permissions.includes("configure")
    )
      failure(
        operation,
        403,
        "Only the decision author or a repository maintainer can withdraw this decision.",
      );
    const event = {
      repositoryId,
      reviewRunId,
      workItemId: context.workItemId,
      workItemKind: context.workItemKind,
      id: globalThis.crypto.randomUUID(),
      changeId: request.changeId,
      actor: principal,
      previousVersion: context.version,
      version: context.version + 1,
      createdAt: this.now().toISOString(),
      action: request.action,
      reason: request.reason,
      revisionKey: context.revisionKey,
      planDigest: context.planDigest,
      resultSetDigest: context.resultSetDigest,
      targetDecisionId: request.action === "withdraw" ? request.targetDecisionId : null,
      supersedesDecisionId: request.action === "comment" ? null : (current?.id ?? null),
      policyAtDecision: policySnapshot(context),
    } as ReviewRunDecisionEvent;
    const receipt = readDecisionChange(
      { change: event, replayed: false },
      repositoryId,
      reviewRunId,
      request,
      principal,
      operation,
    );
    const historyKey = key(repositoryId, reviewRunId);
    this.events.set(historyKey, [...(this.events.get(historyKey) ?? []), structuredClone(event)]);
    this.intents.set(changeKey, { intent: requestIntent, event: structuredClone(event) });
    return structuredClone(receipt);
  }
}
