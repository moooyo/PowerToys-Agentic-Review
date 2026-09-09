import { createHash } from "node:crypto";

import {
  assertEvaluationReviewRunPlan,
  assertReviewRunExecutionPlan,
  assertReviewRunPlanInput,
  evaluationExecutionCapabilityLabel,
  evaluationExecutionRequiredCapabilityLabels,
  evaluationModelExecutionCapabilityLabels,
  getEvaluationModelRequiredCapabilityLabels,
  getValidationProfileConfigIssues,
  isUiAssertionAction,
  maximumPromptContentUtf8Bytes,
  maximumReviewRunPlanUtf8Bytes,
  type ReviewRunBlockedReason,
  type ReviewRunExecutionPlanV1,
  type ReviewRunExecutionPlanV2,
  type ReviewRunPlanInput,
  type ReviewRunPlannedJob,
  type ReviewRunPlanResult,
  type ReviewRunReadiness,
  type ReviewRunRunnerSupport,
  UiDriverCapabilities,
  type ValidationTarget,
  validationExecutorCapabilityLabels,
  type WorkflowKind,
  WorkflowOutputSchemaVersions,
} from "@agentic-review/contracts";
import { freezeIssueReproductionBinding } from "./issue-reproduction.js";

const exactCommitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Creates a frozen execution plan only. It does not grant authorization, dispatch jobs, or run tools. */
export function createReviewRunPlan(input: ReviewRunPlanInput): ReviewRunPlanResult {
  assertReviewRunPlanInput(input);
  assertSourceAndAuthorization(input);
  const requestIds = new Set<string>();
  const profileIds = new Set<string>();
  const allCheckIds = new Set<string>();
  const jobs: ReviewRunPlannedJob[] = [];

  for (const request of input.requests) {
    if (requestIds.has(request.requestId))
      throw new TypeError("Review run request IDs must be unique.");
    requestIds.add(request.requestId);
    assertWorkflowTarget(request.workflowKind, request.target, input.workItem.kind);
    const { profileVersion: profile, prompt } = request;
    if (profile !== null) {
      if (
        profile.repositoryId !== input.repository.id ||
        profile.workflowKind !== request.workflowKind ||
        profile.target !== request.target
      ) {
        throw new TypeError(
          "The profile does not belong to this repository, workflow, and target.",
        );
      }
      if (profileIds.has(profile.id))
        throw new TypeError("A profile version may appear only once in a review run.");
      profileIds.add(profile.id);
      if (sha256(canonicalJson(profile.config)) !== profile.configSha256) {
        throw new TypeError("The profile configuration digest does not match its frozen content.");
      }
      const issues = getValidationProfileConfigIssues(
        profile.config,
        profile.workflowKind,
        profile.target,
      );
      if (issues.length > 0)
        throw new TypeError(`The profile configuration is invalid: ${issues[0]}`);
    }
    if (prompt !== null) {
      if (
        prompt.workflowKind !== request.workflowKind ||
        prompt.version.outputSchemaVersion !== WorkflowOutputSchemaVersions[request.workflowKind]
      ) {
        throw new TypeError("The prompt does not match the requested workflow and output schema.");
      }
      if (
        !prompt.version.content.isWellFormed() ||
        Buffer.byteLength(prompt.version.content, "utf8") > maximumPromptContentUtf8Bytes ||
        sha256(prompt.version.content) !== prompt.version.contentSha256
      ) {
        throw new TypeError("The prompt content is invalid or its digest does not match.");
      }
    }

    const required = request.required || profile?.required === true;
    const validationSteps =
      profile === null
        ? []
        : [
            ...profile.config.build,
            ...profile.config.test,
            ...(profile.config.ui?.scenarios ?? []),
          ];
    for (const step of validationSteps) {
      const id = `${profile?.id}:${step.id}`;
      if (allCheckIds.has(id))
        throw new TypeError("Qualified validation check IDs must be unique across profiles.");
      allCheckIds.add(id);
    }
    const requiredCheckIds =
      required && profile !== null
        ? validationSteps
            .filter((step) => step.required)
            .map((step) => `${profile.id}:${step.id}`)
            .sort()
        : [];
    jobs.push({ ...request, required, requiredCheckIds });
  }
  jobs.sort((left, right) =>
    left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0,
  );

  const {
    observedAt: _observedAt,
    sourceUpdatedAt: _sourceUpdatedAt,
    ...revision
  } = input.revision;
  const reproduction = freezeIssueReproductionBinding(input);
  const plan: ReviewRunExecutionPlanV1 = {
    schemaVersion: "ReviewRunExecutionPlanV1",
    activationId: input.activationId,
    ...(reproduction === undefined ? {} : { reproduction }),
    repository: input.repository,
    workItemId: input.workItemId,
    workItem: input.workItem,
    revision,
    testedSourceRevision: input.testedSourceRevision,
    testedSourceAuthorization: input.testedSourceAuthorization,
    authorization: {
      requestEpochId: input.authorization.requestEpochId,
      sequence: input.authorization.sequence,
      basis: input.authorization.authorizationBasis,
      actorGithubUserId: input.authorization.openedByActor.githubUserId,
      targetGithubUserId: input.authorization.target.githubUserId,
      policy: input.authorizationPolicy,
    },
    jobs,
    requiredCheckIds: jobs.flatMap((job) => job.requiredCheckIds).sort(),
  };
  assertReviewRunExecutionPlan(plan);
  const json = canonicalJson(plan);
  if (Buffer.byteLength(json, "utf8") > maximumReviewRunPlanUtf8Bytes) {
    throw new RangeError("The review run plan exceeds its UTF-8 byte limit.");
  }
  const snapshot = deepFreeze(JSON.parse(json) as ReviewRunExecutionPlanV1);
  const readiness = evaluateReviewRunPlanReadiness(snapshot, input.runnerSupport);
  return {
    plan: snapshot,
    planDigest: sha256(json),
    readiness,
    requiredRequestBlockers: getRequiredReviewRunRequestBlockers(readiness),
  };
}

/** Protocol requirements come from frozen execution intent, never from configurable profiles. */
export function getReviewRunExecutorCapabilityLabels(
  plan: Pick<ReviewRunExecutionPlanV1, "reproduction"> & {
    readonly schemaVersion?: string;
    readonly modelRequirements?: ReviewRunExecutionPlanV2["modelRequirements"];
  },
  job: Pick<ReviewRunPlannedJob, "requestId" | "target" | "profileVersion" | "workflowKind">,
): Record<string, string> {
  const labels: Record<string, string> = {
    [validationExecutorCapabilityLabels.envelope]: "2",
    [validationExecutorCapabilityLabels[job.target]]: "1",
  };
  if (
    plan.schemaVersion === "ReviewRunExecutionPlanV2" ||
    plan.schemaVersion === "ValidationJobContextV2"
  ) {
    Object.assign(labels, evaluationExecutionRequiredCapabilityLabels);
    Object.assign(
      labels,
      getEvaluationModelRequiredCapabilityLabels(
        job.workflowKind,
        plan.modelRequirements?.required === true,
      ),
    );
  }
  if (plan.reproduction?.binding.cases.some((entry) => entry.requestId === job.requestId)) {
    labels[validationExecutorCapabilityLabels.reproduction] = "1";
  }
  if (job.profileVersion?.config.test.some((step) => step.probeOutput !== undefined)) {
    labels[validationExecutorCapabilityLabels.probes] = "1";
  }
  const ui = job.profileVersion?.config.ui;
  const mappedUi = plan.reproduction?.binding.cases.some(
    (entry) => entry.requestId === job.requestId && entry.target !== "headless",
  );
  if (mappedUi || (ui?.target === "web" && ui.evidence.trace === "off")) {
    labels[validationExecutorCapabilityLabels.uiObservations] = "1";
  }
  return labels;
}

/** A single executor must satisfy profile capabilities and every applicable protocol extension. */
export function getReviewRunRequiredCapabilities(
  plan: Pick<ReviewRunExecutionPlanV1, "reproduction"> & {
    readonly schemaVersion?: string;
    readonly modelRequirements?: ReviewRunExecutionPlanV2["modelRequirements"];
  },
  job: Pick<ReviewRunPlannedJob, "requestId" | "target" | "profileVersion" | "workflowKind">,
): string[] {
  const labels = getReviewRunExecutorCapabilityLabels(plan, job);
  return [
    ...new Set([
      ...(job.profileVersion?.config.requiredCapabilities ?? []),
      ...(job.target === "headless" ? [] : [UiDriverCapabilities[job.target]]),
      ...[
        validationExecutorCapabilityLabels.reproduction,
        validationExecutorCapabilityLabels.probes,
        validationExecutorCapabilityLabels.uiObservations,
        evaluationExecutionCapabilityLabel,
        ...Object.values(evaluationModelExecutionCapabilityLabels),
      ].filter((label) => labels[label] === "1"),
    ]),
  ];
}

/** Recompute blockers together with readiness; do not reuse blockers from an older inventory. */
export function getRequiredReviewRunRequestBlockers(
  readiness: readonly ReviewRunReadiness[],
): ReviewRunPlanResult["requiredRequestBlockers"] {
  return readiness.flatMap((entry) =>
    entry.required
      ? entry.reasons.map((reason) => ({ requestId: entry.requestId, reason: reason.code }))
      : [],
  );
}

/** Evaluates frozen prerequisites without asserting that a compatible executor is available. */
export function evaluateReviewRunStructuralReadiness(
  plan: ReviewRunExecutionPlanV1,
): ReviewRunReadiness[] {
  return evaluateReviewRunPlanReadiness(plan, []).map((entry) => {
    const reasons = entry.reasons.filter((reason) => reason.code !== "unsupported_target");
    return { ...entry, state: reasons.length === 0 ? "ready" : "blocked", reasons };
  });
}

/** Re-evaluates executor availability without changing an already frozen plan or its digest. */
export function evaluateReviewRunPlanReadiness(
  plan: ReviewRunExecutionPlanV1,
  runnerSupport: readonly ReviewRunRunnerSupport[],
): ReviewRunReadiness[] {
  return evaluateRunReadiness(plan, runnerSupport, false);
}

/** Evaluation authority covers historical sources independently of ordinary GitHub epochs. */
export function evaluateEvaluationRunReadiness(
  plan: ReviewRunExecutionPlanV2,
  runnerSupport: readonly ReviewRunRunnerSupport[],
): ReviewRunReadiness[] {
  assertEvaluationReviewRunPlan(plan);
  return evaluateRunReadiness(plan, runnerSupport, true);
}

function evaluateRunReadiness(
  plan: Pick<
    ReviewRunExecutionPlanV1,
    "jobs" | "testedSourceRevision" | "testedSourceAuthorization" | "reproduction"
  >,
  runnerSupport: readonly ReviewRunRunnerSupport[],
  evaluation: boolean,
): ReviewRunReadiness[] {
  return plan.jobs.map((job) => {
    const reasons: ReviewRunBlockedReason[] = [];
    const profile = job.profileVersion;
    if (profile === null) reasons.push({ code: "missing_profile" });
    if (job.prompt === null) reasons.push({ code: "missing_prompt" });
    const support = runnerSupport.filter(
      (candidate) => candidate.workflowKind === job.workflowKind && candidate.target === job.target,
    );
    if (support.length === 0) reasons.push({ code: "unsupported_target" });
    if (profile !== null && support.length > 0) {
      const requiredCapabilities = [
        ...new Set([
          ...getReviewRunRequiredCapabilities(plan, job),
          ...(evaluation ? [evaluationExecutionCapabilityLabel] : []),
        ]),
      ];
      const matching = support.filter((candidate) =>
        requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)),
      );
      if (matching.length === 0) {
        // A single executor must satisfy the whole profile. Never combine capabilities across hosts.
        const best = [...support].sort(
          (left, right) =>
            requiredCapabilities.filter((capability) => !left.capabilities.includes(capability))
              .length -
            requiredCapabilities.filter((capability) => !right.capabilities.includes(capability))
              .length,
        )[0];
        for (const capability of requiredCapabilities) {
          if (!best?.capabilities.includes(capability))
            reasons.push({ code: "missing_capability", capability });
        }
      }
      if (job.target !== "headless" && !matching.some((candidate) => candidate.evidenceDelivery)) {
        reasons.push({ code: "evidence_delivery_unavailable" });
      }
    }
    if (job.workflowKind === "issue_validation" && plan.testedSourceRevision === null) {
      reasons.push({ code: "missing_tested_source_revision" });
    }
    if (
      !evaluation &&
      job.workflowKind === "issue_validation" &&
      plan.testedSourceAuthorization === null
    ) {
      reasons.push({ code: "missing_source_authorization" });
    }
    if (
      profile !== null &&
      job.workflowKind !== "issue_triage" &&
      job.requiredCheckIds.length === 0 &&
      job.required
    ) {
      reasons.push({ code: "missing_validation_checks" });
    }
    if (job.target === "windows_desktop" || job.target === "web") {
      // Legacy command-only profiles remain readable, but cannot stand in for typed UI checks.
      const ui = profile?.config.ui;
      const hasScenarios =
        ui !== undefined &&
        ui.scenarios.length > 0 &&
        ui.scenarios.every((scenario) =>
          scenario.steps.some((step) => isUiAssertionAction(step.action)),
        );
      if (!hasScenarios) reasons.push({ code: "missing_scenarios" });
      else if (job.required && !ui.scenarios.some((scenario) => scenario.required)) {
        reasons.push({ code: "missing_required_scenarios" });
      }
      if (profile !== null && profile.config.build.length === 0)
        reasons.push({ code: "missing_build" });
      if (profile !== null && profile.config.launch.length === 0)
        reasons.push({ code: "missing_launch" });
    }
    return {
      requestId: job.requestId,
      required: job.required,
      state: reasons.length === 0 ? "ready" : "blocked",
      reasons,
    };
  });
}

function assertSourceAndAuthorization(input: ReviewRunPlanInput): void {
  const {
    repository,
    workItem,
    revision,
    authorization: epoch,
    authorizationPolicy: policy,
    testedSourceRevision: source,
    testedSourceAuthorization: sourceAuthorization,
  } = input;
  if (
    workItem.state !== "open" ||
    workItem.githubRepositoryId !== repository.githubRepositoryId ||
    revision.githubRepositoryId !== repository.githubRepositoryId ||
    revision.githubWorkItemId !== workItem.githubWorkItemId ||
    revision.kind !== workItem.kind
  ) {
    throw new TypeError("The review run work item and immutable revision identities do not match.");
  }
  if (
    epoch.githubRepositoryId !== repository.githubRepositoryId ||
    epoch.githubWorkItemId !== workItem.githubWorkItemId ||
    epoch.currentRevision.kind !== revision.kind ||
    epoch.currentRevision.revisionKey !== revision.revisionKey ||
    epoch.currentRevision.githubRepositoryId !== repository.githubRepositoryId ||
    epoch.currentRevision.githubWorkItemId !== workItem.githubWorkItemId
  ) {
    throw new TypeError("The authorization does not cover this exact work item revision.");
  }
  if (
    epoch.authorizationPolicyVersion !== policy.policyVersion ||
    epoch.target.githubUserId !== policy.schedulingTargetGithubUserId ||
    (epoch.authorizationBasis === "self"
      ? epoch.openedByActor.githubUserId !== epoch.target.githubUserId
      : !policy.allowlistedActorGithubUserIds.includes(epoch.openedByActor.githubUserId))
  ) {
    throw new TypeError(
      "The authorization policy snapshot does not match the authorized activation.",
    );
  }
  if (revision.kind === "pull_request") {
    if (sourceAuthorization !== null) {
      throw new TypeError(
        "PR source authorization must come from its active GitHub request epoch.",
      );
    }
    if (
      !exactCommitPattern.test(revision.baseSha) ||
      !exactCommitPattern.test(revision.headSha) ||
      sha256(`${revision.baseSha}\0${revision.headSha}`) !== revision.revisionKey ||
      epoch.currentRevision.kind !== "pull_request" ||
      epoch.currentRevision.baseSha !== revision.baseSha ||
      epoch.currentRevision.headSha !== revision.headSha ||
      source?.kind !== "pull_request" ||
      source.baseSha !== revision.baseSha ||
      source.headSha !== revision.headSha
    ) {
      throw new TypeError("PR validation must use the exact authorized base and head commits.");
    }
  } else {
    const contentDigest = sha256(
      JSON.stringify([workItem.title, workItem.body, workItem.state, workItem.updatedAt]),
    );
    if (
      revision.revisionKey !== contentDigest ||
      revision.contentDigest !== contentDigest ||
      epoch.currentRevision.kind !== "issue" ||
      epoch.currentRevision.contentDigest !== contentDigest ||
      source?.kind === "pull_request"
    ) {
      throw new TypeError(
        "Issue content revision and selected source commit must remain distinct.",
      );
    }
    if (
      sourceAuthorization !== null &&
      (source?.kind !== "commit" ||
        sourceAuthorization.activationId !== input.activationId ||
        sourceAuthorization.githubRepositoryId !== repository.githubRepositoryId ||
        sourceAuthorization.githubWorkItemId !== workItem.githubWorkItemId ||
        sourceAuthorization.issueRevisionKey !== revision.revisionKey ||
        sourceAuthorization.headSha !== source.headSha ||
        sourceAuthorization.issuer.trim() !== sourceAuthorization.issuer ||
        sourceAuthorization.subject.trim() !== sourceAuthorization.subject)
    ) {
      throw new TypeError(
        "The operator source authorization does not cover this activation, issue revision, and commit.",
      );
    }
  }
}

function assertWorkflowTarget(
  workflow: WorkflowKind,
  target: ValidationTarget,
  kind: "issue" | "pull_request",
): void {
  if (
    (workflow === "pr_static_build" || workflow === "pr_ui") !== (kind === "pull_request") ||
    ((workflow === "pr_static_build" || workflow === "issue_triage") && target !== "headless") ||
    (workflow === "pr_ui" && target === "headless")
  ) {
    throw new TypeError("The requested workflow and target do not match the work item.");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
