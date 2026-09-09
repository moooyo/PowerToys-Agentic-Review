import {
  GitHubWorkItemSchema,
  getEvaluationValidationJobContextIssues,
  type JobExecutionEnvelope,
  JobExecutionEnvelopeSchema,
  type JobExecutionTemplate,
  JobExecutionTemplateSchema,
  maximumClaimLeaseResponseUtf8Bytes,
  workerModelExecutionDisabledLabel,
  workerModelExecutionDisabledValue,
} from "@agentic-review/contracts";
import {
  getReviewRunExecutorCapabilityLabels,
  jobRequiresModelExecution,
  validateEvaluationIssueReproductionBinding,
  validateFrozenIssueReproductionBinding,
} from "@agentic-review/domain";
import { Value } from "@sinclair/typebox/value";

export type ExecutionTemplateParseResult =
  | { readonly ok: true; readonly template: JobExecutionTemplate }
  | { readonly ok: false; readonly message: string };

/** Shared with claims; callers decide whether invalid stored data may be mutated. */
export function parseExecutionTemplate(serializedTemplate: string): ExecutionTemplateParseResult {
  let value: unknown;
  try {
    value = JSON.parse(serializedTemplate) as unknown;
  } catch {
    return { ok: false, message: "Stored execution_json is not valid JSON." };
  }
  if (!Value.Check(JobExecutionTemplateSchema, value)) {
    return {
      ok: false,
      message: "Stored execution_json does not match JobExecutionTemplateSchema.",
    };
  }
  if ("validation" in value) {
    const validation = value.validation;
    if (validation.schemaVersion === "ValidationJobContextV2") {
      if (getEvaluationValidationJobContextIssues(validation).length > 0) {
        return { ok: false, message: "Stored evaluation execution context is inconsistent." };
      }
      try {
        validateEvaluationIssueReproductionBinding(validation);
      } catch {
        return { ok: false, message: "Stored evaluation reproduction binding is invalid." };
      }
      return { ok: true, template: value };
    }
    if (validation.reproduction === undefined) return { ok: true, template: value };
    const snapshot = value.resource.canonicalSnapshot;
    try {
      if (!Value.Check(GitHubWorkItemSchema, snapshot)) throw new Error("Invalid work item.");
      validateFrozenIssueReproductionBinding(
        validation.reproduction,
        [validation],
        {
          activationId: validation.activationId,
          repositoryId: validation.repositoryId,
          githubRepositoryId: value.repository.githubRepositoryId,
          workItemId: validation.workItemId,
          githubWorkItemId: snapshot.githubWorkItemId,
          workItemKind: value.resource.kind,
          issueRevisionKey: validation.revisionKey,
          testedSourceRevision: validation.testedSourceRevision,
          testedSourceAuthorization: validation.testedSourceAuthorization,
        },
        validation.requestId,
      );
    } catch {
      return { ok: false, message: "Stored execution reproduction binding is invalid." };
    }
  }
  return { ok: true, template: value };
}

export function capabilityAtPath(capabilities: unknown, path: string): unknown {
  let current = capabilities;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Preserve the existing Legacy array, recursive object and primitive matching semantics. */
export function satisfiesRequirement(actual: unknown, required: unknown): boolean {
  if (Array.isArray(required)) {
    return required.every((requirement) => {
      if (typeof requirement !== "string") return false;
      const direct = capabilityAtPath(actual, requirement);
      if (direct === true || direct === requirement) return true;
      if (actual !== null && typeof actual === "object") {
        const actualRecord = actual as Record<string, unknown>;
        const labels = actualRecord.labels;
        if (
          labels !== null &&
          typeof labels === "object" &&
          !Array.isArray(labels) &&
          (labels as Record<string, unknown>)[requirement] === "1"
        )
          return true;
        const recipeIds = actualRecord.recipeIds;
        return Array.isArray(recipeIds) && recipeIds.includes(requirement);
      }
      return false;
    });
  }
  if (required !== null && typeof required === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(required as Record<string, unknown>).every(([key, expected]) =>
      satisfiesRequirement(actualRecord[key], expected),
    );
  }
  if (Array.isArray(actual)) return actual.includes(required);
  return Object.is(actual, required);
}

/** Applies the Worker's model selection before the existing three capability gates. */
export function evaluateJobWorkerCapabilities(
  template: JobExecutionTemplate,
  requiredCapabilities: unknown,
  capabilities: unknown,
): boolean {
  if (
    capabilityAtPath(capabilities, `labels.${workerModelExecutionDisabledLabel}`) ===
      workerModelExecutionDisabledValue &&
    jobRequiresModelExecution(template)
  )
    return false;
  if (!satisfiesRequirement(capabilities, requiredCapabilities)) return false;
  if (
    "validation" in template &&
    Object.entries(
      getReviewRunExecutorCapabilityLabels(template.validation, template.validation),
    ).some(([name, version]) => capabilityAtPath(capabilities, `labels.${name}`) !== version)
  )
    return false;
  return (
    !("validation" in template) ||
    satisfiesRequirement(
      capabilities,
      template.validation.profileVersion.config.requiredCapabilities,
    )
  );
}

export interface SchedulingClaimCandidate {
  readonly id: string;
  readonly job_kind: string;
  readonly generation: number;
  readonly intent_version: number;
  readonly semantic_key: string;
  readonly priority: number;
  readonly attempt_count: number;
  readonly max_attempts: number;
}

export interface SchedulingClaimAssignment {
  readonly protocolVersion: string;
  readonly assignedAt: string;
  readonly leaseExpiresAt: string;
  readonly executionDeadlineAt: string;
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly runAttemptId: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
}

/** Construct and validate the existing wire response without changing any scheduling state. */
export function prepareClaimExecutionEnvelope(
  template: JobExecutionTemplate,
  candidate: SchedulingClaimCandidate,
  assignment: SchedulingClaimAssignment,
):
  | { readonly ok: true; readonly envelope: JobExecutionEnvelope }
  | {
      readonly ok: false;
      readonly code: "invalid_execution_envelope" | "claim_response_too_large";
      readonly message: string;
    } {
  const envelopeCandidate = {
    ...template,
    protocolVersion: assignment.protocolVersion,
    envelopeVersion: "validation" in template ? 2 : 1,
    assignedAt: assignment.assignedAt,
    leaseExpiresAt: assignment.leaseExpiresAt,
    executionDeadlineAt: assignment.executionDeadlineAt,
    lease: {
      jobId: candidate.id,
      runAttemptId: assignment.runAttemptId,
      workerNodeId: assignment.workerNodeId,
      workerInstanceId: assignment.workerInstanceId,
      leaseToken: assignment.leaseToken,
      leaseGeneration: assignment.leaseGeneration,
    },
    job: {
      jobId: candidate.id,
      kind: candidate.job_kind,
      priority: candidate.priority,
      attempt: candidate.attempt_count + 1,
      maxAttempts: candidate.max_attempts,
      generation: candidate.generation,
      intentVersion: candidate.intent_version,
      semanticKey: candidate.semantic_key,
    },
  };
  if (!Value.Check(JobExecutionEnvelopeSchema, envelopeCandidate)) {
    return {
      ok: false,
      code: "invalid_execution_envelope",
      message: "Server-generated execution envelope does not match JobExecutionEnvelopeSchema.",
    };
  }
  const claimResponseBytes = Buffer.byteLength(
    JSON.stringify({
      outcome: "granted",
      envelope: envelopeCandidate,
      serverTime: assignment.assignedAt,
    }),
    "utf8",
  );
  if (claimResponseBytes > maximumClaimLeaseResponseUtf8Bytes) {
    return {
      ok: false,
      code: "claim_response_too_large",
      message: `Server-generated claim response is ${claimResponseBytes} bytes; maximum is ${maximumClaimLeaseResponseUtf8Bytes}.`,
    };
  }
  return { ok: true, envelope: envelopeCandidate };
}
