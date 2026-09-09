import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DateTimeSchema, EntityIdSchema, Sha256Schema } from "./common.js";
import {
  EvaluationBatchCancellationV1Schema,
  EvaluationBatchCancelRequestSchema,
  EvaluationBatchSummaryV1Schema,
} from "./evaluation-batches.js";
import { EvaluationModelRequirementsV1Schema } from "./evaluation-execution.js";
import {
  EvaluationArmSchema,
  EvaluationExecutionStateSchema,
  maximumEvaluationCaseCount,
} from "./evaluation-scoring.js";
import {
  EvaluationSourceSummaryV1Schema,
  getEvaluationSourceSummaryIssues,
} from "./evaluation-source.js";
import {
  EvaluationSuiteVersionV1Schema,
  getEvaluationSuiteVersionIssues,
} from "./evaluation-suites.js";
import { getJobAdmissionIssues, NullableJobAdmissionSchema } from "./job-admission.js";
import { type OperatorPrincipal, OperatorPrincipalSchema } from "./operator-access.js";
import {
  PromptVersionSummarySchema,
  ValidationProfileVersionSummarySchema,
  WorkflowKindSchema,
  WorkflowOutputSchemaVersions,
} from "./platform-configuration.js";
import { ReviewRunBlockedReasonSchema } from "./review-run.js";
import { JobStateSchema } from "./states.js";

export const maximumEvaluationReadUtf8Bytes = 2 * 1024 * 1024;
const strict = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0, maximum: maximumEvaluationCaseCount * 2 });
const page = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const pageSize = Type.Integer({ minimum: 1, maximum: 50 });
const queryPages = { page: Type.Optional(page), pageSize: Type.Optional(pageSize) };
const responsePages = {
  page,
  pageSize,
  total: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
};
const nullableTime = Type.Union([DateTimeSchema, Type.Null()]);
export const EvaluationBatchListQuerySchema = Type.Object(
  {
    ...queryPages,
    suiteId: Type.Optional(EntityIdSchema),
    workflowKind: Type.Optional(WorkflowKindSchema),
  },
  strict,
);
export type EvaluationBatchListQuery = Static<typeof EvaluationBatchListQuerySchema>;
export const EvaluationPromptOptionsQuerySchema = Type.Object(
  { ...queryPages, workflowKind: WorkflowKindSchema },
  strict,
);
export type EvaluationPromptOptionsQuery = Static<typeof EvaluationPromptOptionsQuerySchema>;
export const EvaluationBatchProgressSchema = Type.Object(
  {
    totalCells: count,
    applicableCells: count,
    notApplicableCells: count,
    not_run: count,
    awaiting_admission: count,
    queued: count,
    running: count,
    completed: count,
    failed: count,
    blocked: count,
    cancelled: count,
    invalid: count,
  },
  strict,
);
export type EvaluationBatchProgress = Static<typeof EvaluationBatchProgressSchema>;
export const EvaluationBatchStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("awaiting_admission"),
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("cancelling"),
  Type.Literal("cancelled"),
]);
export type EvaluationBatchStatus = Static<typeof EvaluationBatchStatusSchema>;
export const EvaluationBatchListItemV1Schema = Type.Object(
  {
    summary: EvaluationBatchSummaryV1Schema,
    suiteName: Type.String({ minLength: 1, maxLength: 128 }),
    status: EvaluationBatchStatusSchema,
    controlStatus: Type.Union([Type.Literal("active"), Type.Literal("cancelled")]),
    controlVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
    progress: EvaluationBatchProgressSchema,
  },
  strict,
);
export type EvaluationBatchListItemV1 = Static<typeof EvaluationBatchListItemV1Schema>;
export const EvaluationBatchListV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationBatchListV1"),
    repositoryId: EntityIdSchema,
    ...responsePages,
    items: Type.Array(EvaluationBatchListItemV1Schema, { maxItems: 50 }),
  },
  strict,
);
export type EvaluationBatchListV1 = Static<typeof EvaluationBatchListV1Schema>;
const control = Type.Union([
  Type.Object(
    {
      status: Type.Literal("active"),
      version: Type.Literal(1),
      reason: Type.Null(),
      updatedAt: DateTimeSchema,
      updatedBy: OperatorPrincipalSchema,
    },
    strict,
  ),
  Type.Object(
    {
      status: Type.Literal("cancelled"),
      version: Type.Literal(2),
      reason: EvaluationBatchCancelRequestSchema.properties.reason,
      updatedAt: DateTimeSchema,
      updatedBy: OperatorPrincipalSchema,
    },
    strict,
  ),
]);
const configuration = Type.Object(
  {
    profile: ValidationProfileVersionSummarySchema,
    prompt: PromptVersionSummarySchema,
    modelRequirements: EvaluationModelRequirementsV1Schema,
  },
  strict,
);
export const EvaluationBatchDetailV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationBatchDetailV1"),
    ...EvaluationBatchListItemV1Schema.properties,
    suiteVersion: EvaluationSuiteVersionV1Schema,
    control,
    configurations: Type.Object({ baseline: configuration, candidate: configuration }, strict),
  },
  strict,
);
export type EvaluationBatchDetailV1 = Static<typeof EvaluationBatchDetailV1Schema>;
export const EvaluationDispatchBlockerSchema = Type.Union([
  ReviewRunBlockedReasonSchema,
  Type.Object(
    {
      code: Type.Union([
        Type.Literal("authorization_changed"),
        Type.Literal("job_association_limit"),
      ]),
    },
    strict,
  ),
]);
const cellJob = Type.Object(
  {
    jobId: EntityIdSchema,
    status: JobStateSchema,
    attemptCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    admission: NullableJobAdmissionSchema,
    createdAt: DateTimeSchema,
    startedAt: nullableTime,
    completedAt: nullableTime,
    failureCode: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  },
  strict,
);
const resultIdentity = Type.Object(
  {
    resultId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    resultDigest: Sha256Schema,
    createdAt: DateTimeSchema,
  },
  strict,
);
export const EvaluationCellExecutionStateSchema = Type.Union([
  EvaluationExecutionStateSchema,
  Type.Literal("awaiting_admission"),
]);
export type EvaluationCellExecutionState = Static<typeof EvaluationCellExecutionStateSchema>;
export const EvaluationCellSummaryV1Schema = Type.Object(
  {
    cellId: EntityIdSchema,
    caseId: EntityIdSchema,
    arm: EvaluationArmSchema,
    trial: Type.Literal(1),
    runId: EntityIdSchema,
    requestId: EntityIdSchema,
    sourceId: EntityIdSchema,
    sourceDigest: Sha256Schema,
    profileVersionId: EntityIdSchema,
    promptVersionId: EntityIdSchema,
    state: EvaluationCellExecutionStateSchema,
    job: Type.Union([cellJob, Type.Null()]),
    result: Type.Union([resultIdentity, Type.Null()]),
    blockerCount: Type.Integer({ minimum: 0, maximum: 140 }),
    // The matrix is a bounded summary. All blockers remain in the owner's dispatch/readiness rows.
    blockers: Type.Array(EvaluationDispatchBlockerSchema, { maxItems: 16 }),
  },
  strict,
);
export type EvaluationCellSummaryV1 = Static<typeof EvaluationCellSummaryV1Schema>;
const matrixCase = Type.Object(
  {
    caseId: EntityIdSchema,
    title: Type.String({ minLength: 1, maxLength: 1024 }),
    applicability: Type.Union([
      Type.Object({ state: Type.Literal("applicable") }, strict),
      Type.Object(
        {
          state: Type.Literal("not_applicable"),
          reason: Type.String({ minLength: 1, maxLength: 2048 }),
        },
        strict,
      ),
    ]),
    source: EvaluationSourceSummaryV1Schema,
    baseline: EvaluationCellSummaryV1Schema,
    candidate: EvaluationCellSummaryV1Schema,
  },
  strict,
);
export const EvaluationBatchMatrixV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationBatchMatrixV1"),
    repositoryId: EntityIdSchema,
    evaluationId: EntityIdSchema,
    suiteVersionId: EntityIdSchema,
    status: EvaluationBatchStatusSchema,
    progress: EvaluationBatchProgressSchema,
    cases: Type.Array(matrixCase, { minItems: 1, maxItems: maximumEvaluationCaseCount }),
  },
  strict,
);
export type EvaluationBatchMatrixV1 = Static<typeof EvaluationBatchMatrixV1Schema>;
export const EvaluationPromptOptionV1Schema = Type.Object(
  {
    ...PromptVersionSummarySchema.properties,
    templateName: Type.String({ minLength: 1, maxLength: 128 }),
    visibility: Type.Union([
      Type.Literal("platform"),
      Type.Literal("binding"),
      Type.Literal("frozen_run"),
    ]),
  },
  strict,
);
export type EvaluationPromptOptionV1 = Static<typeof EvaluationPromptOptionV1Schema>;
export const EvaluationPromptOptionsV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("EvaluationPromptOptionsV1"),
    repositoryId: EntityIdSchema,
    workflowKind: WorkflowKindSchema,
    ...responsePages,
    items: Type.Array(EvaluationPromptOptionV1Schema, { maxItems: 50 }),
  },
  strict,
);
export type EvaluationPromptOptionsV1 = Static<typeof EvaluationPromptOptionsV1Schema>;

function wellFormed(value: unknown, parents = new Set<object>(), field = ""): boolean {
  if (typeof value === "string")
    return (
      value.isWellFormed() &&
      (!(
        field === "id" ||
        field.endsWith("Id") ||
        ["issuer", "subject", "createdBy"].includes(field)
      ) ||
        (value.trim() === value &&
          [...value].every(
            (character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f,
          )))
    );
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || parents.has(value) || parents.size > 64) return false;
  if (
    (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ||
    Object.getOwnPropertySymbols(value).length
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries = Object.entries(descriptors).filter(
    ([key]) => !Array.isArray(value) || key !== "length",
  );
  if (
    Array.isArray(value) &&
    (entries.length !== value.length || entries.some(([key], index) => key !== String(index)))
  )
    return false;
  parents.add(value);
  const result = entries.every(
    ([key, descriptor]) =>
      key.isWellFormed() &&
      descriptor.enumerable &&
      "value" in descriptor &&
      wellFormed(descriptor.value, parents, key),
  );
  parents.delete(value);
  return result;
}
function shape(
  schema: TSchema,
  value: unknown,
  maximum = maximumEvaluationReadUtf8Bytes,
): string[] {
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set(
      "date-time",
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
        Number.isFinite(Date.parse(value)),
    );
  if (!wellFormed(value) || !Value.Check(schema, value))
    return ["The evaluation read model must match its strict JSON contract."];
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum)
    return ["The evaluation read model exceeds its UTF-8 byte limit."];
  return [];
}
function pagination(value: { page?: number; pageSize?: number }): string[] {
  return Number.isSafeInteger(((value.page ?? 1) - 1) * (value.pageSize ?? 20))
    ? []
    : ["The evaluation page offset is not a safe integer."];
}
function pageIssues(value: {
  page: number;
  pageSize: number;
  total: number;
  items: unknown[];
}): string[] {
  const issues = pagination(value),
    offset = (value.page - 1) * value.pageSize;
  if (value.items.length !== Math.min(value.pageSize, Math.max(0, value.total - offset)))
    issues.push("The evaluation page must include every available item in its requested window.");
  return issues;
}
export function getEvaluationBatchListQueryIssues(value: unknown): string[] {
  const issues = shape(EvaluationBatchListQuerySchema, value, 8192);
  return issues.length ? issues : pagination(value as EvaluationBatchListQuery);
}
export function getEvaluationPromptOptionsQueryIssues(value: unknown): string[] {
  const issues = shape(EvaluationPromptOptionsQuerySchema, value, 8192);
  return issues.length ? issues : pagination(value as EvaluationPromptOptionsQuery);
}
export function getEvaluationBatchProgressIssues(value: unknown): string[] {
  const issues = shape(EvaluationBatchProgressSchema, value);
  if (issues.length) return issues;
  const progress = value as EvaluationBatchProgress;
  const states = [
    "not_run",
    "awaiting_admission",
    "queued",
    "running",
    "completed",
    "failed",
    "blocked",
    "cancelled",
    "invalid",
  ] as const;
  if (
    progress.totalCells !== progress.applicableCells + progress.notApplicableCells ||
    progress.applicableCells !== states.reduce((total, state) => total + progress[state], 0) ||
    progress.totalCells % 2 !== 0 ||
    progress.applicableCells % 2 !== 0 ||
    progress.totalCells < 2 ||
    progress.applicableCells < 2
  )
    issues.push(
      "Evaluation progress must retain all paired cells and applicable execution states.",
    );
  return issues;
}
export function getEvaluationBatchStatus(
  progress: EvaluationBatchProgress,
  cancelled: boolean,
): EvaluationBatchStatus {
  if (cancelled) return progress.running > 0 ? "cancelling" : "cancelled";
  if (progress.running > 0) return "running";
  if (progress.queued > 0) return "queued";
  if (progress.awaiting_admission > 0) return "awaiting_admission";
  if (progress.not_run > 0) return "pending";
  if (progress.blocked > 0 || progress.invalid > 0) return "blocked";
  return "completed";
}
function itemIssues(item: EvaluationBatchListItemV1): string[] {
  const issues = [
    ...getEvaluationBatchSummaryIssues(item.summary),
    ...getEvaluationBatchProgressIssues(item.progress),
  ];
  if (
    item.summary.cellCount !== item.summary.caseCount * 2 ||
    item.progress.totalCells !== item.summary.cellCount ||
    item.controlVersion !== (item.controlStatus === "active" ? 1 : 2) ||
    item.status !== getEvaluationBatchStatus(item.progress, item.controlStatus === "cancelled")
  )
    issues.push("The evaluation summary, status and progress are inconsistent.");
  return issues;
}
export function getEvaluationBatchSummaryIssues(value: unknown): string[] {
  const issues = shape(EvaluationBatchSummaryV1Schema, value);
  if (issues.length) return issues;
  const summary = value as Static<typeof EvaluationBatchSummaryV1Schema>;
  if (summary.cellCount !== summary.caseCount * 2)
    issues.push("Evaluation summaries require two cells per case.");
  if (
    summary.workflowKind !== "issue_validation" &&
    (summary.workflowKind === "pr_ui"
      ? summary.target === "headless"
      : summary.target !== "headless")
  )
    issues.push("The evaluation workflow and target are incompatible.");
  issues.push(...actorIssues(summary.createdBy));
  return issues;
}
function actorIssues(actor: OperatorPrincipal): string[] {
  return [actor.issuer, actor.subject].some(
    (value) =>
      value.trim() !== value ||
      [...value].some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      ),
  )
    ? ["An evaluation operator must have an exact nonempty identity."]
    : [];
}
export function getEvaluationBatchCancelRequestIssues(value: unknown): string[] {
  return shape(EvaluationBatchCancelRequestSchema, value, 32_768);
}
export function getEvaluationBatchCancellationIssues(value: unknown): string[] {
  const issues = shape(EvaluationBatchCancellationV1Schema, value, 32_768);
  if (!issues.length) {
    const result = value as Static<typeof EvaluationBatchCancellationV1Schema>;
    issues.push(...actorIssues(result.cancelledBy));
    if (
      result.cancelledJobCount + result.cancellationRequestedJobCount >
      maximumEvaluationCaseCount * 2
    )
      issues.push("Cancellation cannot affect more Jobs than the complete evaluation matrix.");
  }
  return issues;
}
export function getEvaluationBatchListIssues(value: unknown): string[] {
  const issues = shape(EvaluationBatchListV1Schema, value);
  if (issues.length) return issues;
  const result = value as EvaluationBatchListV1;
  issues.push(...pageIssues(result));
  if (new Set(result.items.map((item) => item.summary.id)).size !== result.items.length)
    issues.push("Evaluation list identities must be unique.");
  for (const item of result.items) {
    issues.push(...itemIssues(item));
    if (item.summary.repositoryId !== result.repositoryId)
      issues.push("Evaluation list items must belong to the requested repository.");
  }
  return issues;
}
export function getEvaluationBatchDetailIssues(value: unknown): string[] {
  const issues = shape(EvaluationBatchDetailV1Schema, value);
  if (issues.length) return issues;
  const result = value as EvaluationBatchDetailV1;
  issues.push(
    ...itemIssues(result),
    ...getEvaluationSuiteVersionIssues(result.suiteVersion),
    ...actorIssues(result.control.updatedBy),
  );
  if (
    result.suiteVersion.id !== result.summary.suiteVersionId ||
    result.suiteVersion.suiteId !== result.summary.suiteId ||
    result.suiteVersion.repositoryId !== result.summary.repositoryId ||
    result.suiteVersion.name !== result.suiteName ||
    result.suiteVersion.caseCount !== result.summary.caseCount ||
    result.suiteVersion.workflowKind !== result.summary.workflowKind ||
    result.suiteVersion.target !== result.summary.target ||
    result.control.status !== result.controlStatus ||
    result.control.version !== result.controlVersion
  )
    issues.push("The evaluation detail must retain its frozen suite and current control identity.");
  for (const arm of ["baseline", "candidate"] as const) {
    const selected = result.configurations[arm];
    if (
      selected.profile.id !== result.summary[arm].profileVersionId ||
      selected.prompt.id !== result.summary[arm].promptVersionId ||
      selected.profile.repositoryId !== result.summary.repositoryId ||
      selected.profile.workflowKind !== result.summary.workflowKind ||
      selected.profile.target !== result.summary.target ||
      selected.prompt.outputSchemaVersion !==
        WorkflowOutputSchemaVersions[result.summary.workflowKind] ||
      selected.modelRequirements.required !== (result.summary.mode === "prompt_and_profile")
    )
      issues.push("The evaluation configuration summary does not match its frozen selection.");
  }
  return issues;
}
function truthfulCellState(cell: EvaluationCellSummaryV1): boolean {
  if (cell.job === null)
    return cell.result === null && ["not_run", "blocked", "cancelled"].includes(cell.state);
  switch (cell.job.status) {
    case "queued":
    case "retry_waiting":
      return (
        cell.result === null &&
        ((cell.job.admission?.state === "admitted" && cell.state === "queued") ||
          (cell.job.admission?.state === "pending" && cell.state === "awaiting_admission"))
      );
    case "leased":
    case "running":
    case "cancel_requested":
      return cell.state === "running" && cell.result === null;
    case "succeeded":
      return cell.state === "completed" && cell.result !== null;
    case "failed":
    case "dead_letter":
      return (
        cell.state ===
          (cell.job.failureCode === "EVALUATION_EXECUTION_BOUNDARY_UNAVAILABLE"
            ? "blocked"
            : "failed") && cell.result === null
      );
    case "cancelled":
      return cell.state === "cancelled" && cell.result === null;
    case "stale":
      return cell.state === "invalid" && cell.result === null;
  }
}
export function getEvaluationBatchMatrixIssues(value: unknown): string[] {
  const issues = shape(EvaluationBatchMatrixV1Schema, value);
  if (issues.length) return issues;
  const result = value as EvaluationBatchMatrixV1;
  issues.push(...getEvaluationBatchProgressIssues(result.progress));
  const totals: EvaluationBatchProgress = {
    totalCells: result.cases.length * 2,
    applicableCells: 0,
    notApplicableCells: 0,
    not_run: 0,
    awaiting_admission: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    invalid: 0,
  };
  const ids = new Set<string>(),
    runs = new Set<string>(),
    requests = new Set<string>(),
    jobs = new Set<string>(),
    results = new Set<string>(),
    attempts = new Set<string>(),
    cases = new Set<string>();
  const selected = result.cases[0];
  for (const entry of result.cases) {
    issues.push(...getEvaluationSourceSummaryIssues(entry.source));
    if (cases.has(entry.caseId) || entry.source.repositoryId !== result.repositoryId)
      issues.push("Evaluation matrix case/source scope is inconsistent.");
    cases.add(entry.caseId);
    const applicable = entry.applicability.state === "applicable";
    for (const arm of ["baseline", "candidate"] as const) {
      const cell = entry[arm];
      if (cell.job !== null) issues.push(...getJobAdmissionIssues(cell.job));
      if (
        cell.caseId !== entry.caseId ||
        cell.arm !== arm ||
        cell.sourceId !== entry.source.id ||
        cell.sourceDigest !== entry.source.sourceDigest ||
        ids.has(cell.cellId) ||
        runs.has(cell.runId) ||
        requests.has(cell.requestId) ||
        (cell.job !== null && jobs.has(cell.job.jobId)) ||
        (cell.result !== null &&
          (results.has(cell.result.resultId) || attempts.has(cell.result.runAttemptId))) ||
        cell.profileVersionId !== selected?.[arm].profileVersionId ||
        cell.promptVersionId !== selected?.[arm].promptVersionId ||
        cell.blockers.length !== Math.min(16, cell.blockerCount) ||
        !truthfulCellState(cell) ||
        (!applicable && (cell.job !== null || cell.result !== null || cell.state !== "not_run"))
      )
        issues.push(
          "Evaluation matrix cells must retain unique paired identities and truthful state.",
        );
      ids.add(cell.cellId);
      runs.add(cell.runId);
      requests.add(cell.requestId);
      if (cell.job !== null) jobs.add(cell.job.jobId);
      if (cell.result !== null) {
        results.add(cell.result.resultId);
        attempts.add(cell.result.runAttemptId);
      }
      if (applicable) {
        totals.applicableCells += 1;
        totals[cell.state] += 1;
      } else totals.notApplicableCells += 1;
    }
  }
  if (
    Object.keys(totals).some(
      (key) =>
        totals[key as keyof EvaluationBatchProgress] !==
        result.progress[key as keyof EvaluationBatchProgress],
    ) ||
    result.status !==
      getEvaluationBatchStatus(
        result.progress,
        result.status === "cancelled" || result.status === "cancelling",
      )
  )
    issues.push("The matrix progress must describe every declared cell.");
  return issues;
}
export function getEvaluationPromptOptionsIssues(value: unknown): string[] {
  const issues = shape(EvaluationPromptOptionsV1Schema, value);
  if (issues.length) return issues;
  const result = value as EvaluationPromptOptionsV1;
  issues.push(...pageIssues(result));
  if (new Set(result.items.map((item) => item.id)).size !== result.items.length)
    issues.push("Prompt option identities must be unique.");
  if (
    result.items.some(
      (item) => item.outputSchemaVersion !== WorkflowOutputSchemaVersions[result.workflowKind],
    )
  )
    issues.push("Prompt options must match the requested workflow output schema.");
  return issues;
}
