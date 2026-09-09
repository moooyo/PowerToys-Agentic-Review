import type {
  ActiveAuthorizedRequestEpoch,
  AuthorizationBasis,
  AuthorizationDecision,
  AuthorizationDecisionReason,
  AuthorizedRequestEpoch,
  ClosedAuthorizedRequestEpoch,
  NormalizedSchedulingEvent,
  SchedulingRequestClosedEvent,
  SchedulingRequestOpenedEvent,
  SchedulingRevisionObservedEvent,
  SchedulingWorkItemClosedEvent,
  SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";

export interface EvaluateSchedulingAuthorizationInput {
  event: NormalizedSchedulingEvent;
  policy: SelfOrAllowlistPolicy;
  evaluatedAt: string;
}

export function evaluateSchedulingAuthorization(
  input: EvaluateSchedulingAuthorizationInput,
): AuthorizationDecision {
  const { event, policy, evaluatedAt } = input;

  if (event.action !== "request_opened") {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_event_not_request_open",
      inheritedFromEpochId: null,
    });
  }

  if (!eventHasConsistentIdentity(event)) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_identity_mismatch",
      inheritedFromEpochId: null,
    });
  }

  if (event.workItem.state !== "open") {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_work_item_closed",
      inheritedFromEpochId: null,
    });
  }

  if (event.target === null) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_target_unknown",
      inheritedFromEpochId: null,
    });
  }

  if (event.target.githubUserId !== policy.schedulingTargetGithubUserId) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_wrong_target",
      inheritedFromEpochId: null,
    });
  }

  if (event.actor === null) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_actor_unknown",
      inheritedFromEpochId: null,
    });
  }

  if (
    event.workItem.kind === "pull_request" &&
    event.source !== "webhook" &&
    policy.newRevisionPolicy !== "inherit_authorized_epoch"
  ) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_revision_not_inheritable",
      inheritedFromEpochId: null,
    });
  }

  if (event.actor.githubUserId === policy.schedulingTargetGithubUserId) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "authorized",
      basis: "self",
      reason: "authorized_self",
      inheritedFromEpochId: null,
    });
  }

  if (policy.allowlistedActorGithubUserIds.includes(event.actor.githubUserId)) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "authorized",
      basis: "allowlist",
      reason: "authorized_allowlisted",
      inheritedFromEpochId: null,
    });
  }

  return createDecision({
    event,
    policyVersion: policy.policyVersion,
    evaluatedAt,
    outcome: "denied",
    basis: null,
    reason: "denied_actor_not_allowed",
    inheritedFromEpochId: null,
  });
}

export interface OpenAuthorizedRequestEpochInput {
  event: SchedulingRequestOpenedEvent;
  decision: AuthorizationDecision;
  requestEpochId: string;
  sequence: number;
}

export function openAuthorizedRequestEpoch(
  input: OpenAuthorizedRequestEpochInput,
): ActiveAuthorizedRequestEpoch {
  const { event, decision } = input;

  if (!eventHasConsistentIdentity(event)) {
    throw new Error("Cannot open an epoch from an event with inconsistent identity");
  }
  if (decision.eventId !== event.eventId) {
    throw new Error("Authorization decision does not belong to the request event");
  }
  if (
    decision.outcome !== "authorized" ||
    (decision.basis !== "self" && decision.basis !== "allowlist")
  ) {
    throw new Error("Cannot open an epoch from a denied or inherited authorization decision");
  }
  if (event.actor === null || event.target === null) {
    throw new Error("An authorized request must have a known actor and target");
  }
  if (
    decision.actorGithubUserId !== event.actor.githubUserId ||
    decision.targetGithubUserId !== event.target.githubUserId ||
    (decision.basis === "self" && decision.reason !== "authorized_self") ||
    (decision.basis === "allowlist" && decision.reason !== "authorized_allowlisted")
  ) {
    throw new Error("Authorization decision identity or basis does not match the request event");
  }
  assertPositiveSafeInteger(input.sequence, "sequence");

  return {
    requestEpochId: input.requestEpochId,
    githubRepositoryId: event.repository.githubRepositoryId,
    githubWorkItemId: event.workItem.githubWorkItemId,
    requestKind: event.requestKind,
    sequence: input.sequence,
    target: event.target,
    openedByActor: event.actor,
    authorizationBasis: decision.basis,
    authorizationPolicyVersion: decision.policyVersion,
    openedByEventId: event.eventId,
    openedAt: event.occurredAt,
    currentRevision: event.revision,
    status: "active",
    closedByEventId: null,
    closedAt: null,
    closeReason: null,
  };
}

export type EpochClosingEvent = SchedulingRequestClosedEvent | SchedulingWorkItemClosedEvent;

export type CloseAuthorizedRequestEpochResult =
  | { changed: false; epoch: AuthorizedRequestEpoch }
  | { changed: true; epoch: ClosedAuthorizedRequestEpoch };

export function closeAuthorizedRequestEpoch(
  epoch: AuthorizedRequestEpoch,
  event: EpochClosingEvent,
): CloseAuthorizedRequestEpochResult {
  if (
    epoch.status === "closed" ||
    !eventHasConsistentIdentity(event) ||
    !eventMatchesEpochWorkItem(epoch, event)
  ) {
    return { changed: false, epoch };
  }

  if (event.action === "request_closed") {
    if (
      event.requestKind !== epoch.requestKind ||
      event.target === null ||
      event.target.githubUserId !== epoch.target.githubUserId ||
      (event.requestKind === "assignment" && event.closeReason !== "assignment_removed") ||
      (event.requestKind === "review_request" && event.closeReason !== "review_request_removed")
    ) {
      return { changed: false, epoch };
    }
  } else if (event.workItem.state !== "closed") {
    return { changed: false, epoch };
  }

  return {
    changed: true,
    epoch: {
      ...epoch,
      status: "closed",
      closedByEventId: event.eventId,
      closedAt: event.occurredAt,
      closeReason: event.closeReason,
    },
  };
}

export interface EvaluateRevisionInheritanceInput {
  epoch: AuthorizedRequestEpoch | null;
  event: SchedulingRevisionObservedEvent;
  evaluatedAt: string;
  policy: SelfOrAllowlistPolicy;
  epochPolicy: SelfOrAllowlistPolicy | null;
}

export function evaluateRevisionInheritance(
  input: EvaluateRevisionInheritanceInput,
): AuthorizationDecision {
  const { epoch, event, evaluatedAt, policy, epochPolicy } = input;
  assertPositiveSafeInteger(policy.policyVersion, "policy.policyVersion");

  if (epoch === null || epoch.status !== "active") {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_no_active_epoch",
      inheritedFromEpochId: null,
    });
  }

  if (!eventHasConsistentIdentity(event)) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_identity_mismatch",
      inheritedFromEpochId: null,
    });
  }

  if (!eventMatchesEpochWorkItem(epoch, event)) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_epoch_work_item_mismatch",
      inheritedFromEpochId: null,
    });
  }

  if (event.workItem.state !== "open") {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_work_item_closed",
      inheritedFromEpochId: null,
    });
  }

  if (event.revision.revisionKey === epoch.currentRevision.revisionKey) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_revision_unchanged",
      inheritedFromEpochId: null,
    });
  }

  if (!policiesAllowRevisionInheritance(epoch, policy, epochPolicy)) {
    return createDecision({
      event,
      policyVersion: policy.policyVersion,
      evaluatedAt,
      outcome: "denied",
      basis: null,
      reason: "denied_revision_not_inheritable",
      inheritedFromEpochId: null,
      targetGithubUserId: epoch.target.githubUserId,
    });
  }

  return createDecision({
    event,
    policyVersion: policy.policyVersion,
    evaluatedAt,
    outcome: "authorized",
    basis: "active_epoch",
    reason: "inherited_active_epoch",
    inheritedFromEpochId: epoch.requestEpochId,
    targetGithubUserId: epoch.target.githubUserId,
  });
}

function policiesAllowRevisionInheritance(
  epoch: ActiveAuthorizedRequestEpoch,
  policy: SelfOrAllowlistPolicy,
  epochPolicy: SelfOrAllowlistPolicy | null,
): boolean {
  return (
    epochPolicy !== null &&
    epochPolicy.policyVersion === epoch.authorizationPolicyVersion &&
    (epoch.currentRevision.kind !== "pull_request" ||
      (policy.newRevisionPolicy === "inherit_authorized_epoch" &&
        epochPolicy.newRevisionPolicy === "inherit_authorized_epoch")) &&
    [policy, epochPolicy].every(
      (candidate) =>
        candidate.schedulingTargetGithubUserId === epoch.target.githubUserId &&
        (epoch.openedByActor.githubUserId === candidate.schedulingTargetGithubUserId ||
          candidate.allowlistedActorGithubUserIds.includes(epoch.openedByActor.githubUserId)),
    )
  );
}

export function advanceAuthorizedRequestEpochRevision(
  epoch: ActiveAuthorizedRequestEpoch,
  event: SchedulingRevisionObservedEvent,
  decision: AuthorizationDecision,
): ActiveAuthorizedRequestEpoch {
  if (
    decision.eventId !== event.eventId ||
    decision.outcome !== "authorized" ||
    decision.basis !== "active_epoch" ||
    decision.inheritedFromEpochId !== epoch.requestEpochId ||
    !eventMatchesEpochWorkItem(epoch, event)
  ) {
    throw new Error("Revision authorization is not fenced to the active request epoch");
  }

  return { ...epoch, currentRevision: event.revision };
}

interface CreateDecisionInput {
  event: NormalizedSchedulingEvent;
  policyVersion: number;
  evaluatedAt: string;
  outcome: AuthorizationDecision["outcome"];
  basis: AuthorizationBasis | null;
  reason: AuthorizationDecisionReason;
  inheritedFromEpochId: string | null;
  targetGithubUserId?: number;
}

function createDecision(input: CreateDecisionInput): AuthorizationDecision {
  return {
    eventId: input.event.eventId,
    outcome: input.outcome,
    basis: input.basis,
    reason: input.reason,
    policyKind: "self_or_allowlist",
    policyVersion: input.policyVersion,
    actorGithubUserId: input.event.actor?.githubUserId ?? null,
    targetGithubUserId: input.targetGithubUserId ?? input.event.target?.githubUserId ?? null,
    inheritedFromEpochId: input.inheritedFromEpochId,
    evaluatedAt: input.evaluatedAt,
  };
}

function eventHasConsistentIdentity(event: NormalizedSchedulingEvent): boolean {
  return (
    event.repository.githubRepositoryId === event.workItem.githubRepositoryId &&
    event.repository.githubRepositoryId === event.revision.githubRepositoryId &&
    event.workItem.githubWorkItemId === event.revision.githubWorkItemId &&
    event.workItem.kind === event.revision.kind &&
    event.author.githubUserId === event.workItem.author.githubUserId &&
    !(
      event.action === "request_opened" &&
      event.requestKind === "review_request" &&
      event.workItem.kind !== "pull_request"
    )
  );
}

function eventMatchesEpochWorkItem(
  epoch: AuthorizedRequestEpoch,
  event: NormalizedSchedulingEvent,
): boolean {
  return (
    epoch.githubRepositoryId === event.repository.githubRepositoryId &&
    epoch.githubWorkItemId === event.workItem.githubWorkItemId &&
    epoch.currentRevision.kind === event.revision.kind
  );
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
