import type { DatabaseSync } from "node:sqlite";
import {
  EntityIdSchema,
  type OperatorPrincipal,
  OperatorPrincipalSchema,
  type OperatorRepositoryPermission,
  OperatorRepositoryPermissionSchema,
} from "@agentic-review/contracts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  assertPlatformAdministrator,
  assertRepositoryPermission,
  isPlatformAdministrator,
  OperatorAccessError,
  type OperatorReadContext,
} from "./operator-access.js";

export interface OperatorRequestContext {
  readonly kind: "operator";
  readonly actor: OperatorPrincipal;
}
export interface OperatorRequestInput {
  readonly context: OperatorRequestContext;
  readonly operation: string;
  readonly input: unknown;
}

type Rule =
  | { readonly kind: "platform" }
  | { readonly kind: "repository"; readonly permission: OperatorRepositoryPermission }
  | { readonly kind: "list" }
  | { readonly kind: "prompt_binding"; readonly permission: "read" | "configure" }
  | { readonly kind: "work_item" }
  | { readonly kind: "job" }
  | { readonly kind: "access_context" }
  | { readonly kind: "permission_check" };

// This is deliberately independent of the database operation registry. New internal RPCs do
// not become operator-accessible merely because a handler was added to the Worker switch.
const operatorRules = {
  createEvaluationBatch: { kind: "repository", permission: "configure" },
  cancelEvaluationBatch: { kind: "repository", permission: "configure" },
  listEvaluationBatches: { kind: "repository", permission: "read" },
  getEvaluationBatch: { kind: "repository", permission: "read" },
  getEvaluationBatchMatrix: { kind: "repository", permission: "read" },
  getEvaluationCellResult: { kind: "repository", permission: "read" },
  getEvaluationSourceReproduction: { kind: "repository", permission: "read" },
  getEvaluationReproductionPlan: { kind: "repository", permission: "read" },
  getEvaluationReproductionCell: { kind: "repository", permission: "read" },
  previewEvaluationReproduction: { kind: "repository", permission: "configure" },
  getEvaluationAdjudicationContext: { kind: "repository", permission: "read" },
  listEvaluationAdjudicationHistory: { kind: "repository", permission: "read" },
  changeEvaluationAdjudication: { kind: "repository", permission: "review" },
  getEvaluationScorePreview: { kind: "repository", permission: "read" },
  publishEvaluationAssessment: { kind: "repository", permission: "review" },
  listEvaluationAssessments: { kind: "repository", permission: "read" },
  getEvaluationAssessment: { kind: "repository", permission: "read" },
  getEvaluationAssessmentCase: { kind: "repository", permission: "read" },
  listEvaluationResultEvidence: { kind: "repository", permission: "read" },
  getEvaluationResultEvidenceAsset: { kind: "repository", permission: "read" },
  readEvaluationResultEvidenceChunk: { kind: "repository", permission: "read" },
  listEvaluationPromptOptions: { kind: "repository", permission: "configure" },
  captureEvaluationSource: { kind: "repository", permission: "configure" },
  getEvaluationSource: { kind: "repository", permission: "read" },
  listEvaluationSources: { kind: "repository", permission: "read" },
  createEvaluationSuite: { kind: "repository", permission: "configure" },
  getEvaluationSuite: { kind: "repository", permission: "read" },
  listEvaluationSuites: { kind: "repository", permission: "read" },
  saveEvaluationSuiteDraft: { kind: "repository", permission: "configure" },
  publishEvaluationSuite: { kind: "repository", permission: "configure" },
  listEvaluationSuiteVersions: { kind: "repository", permission: "read" },
  getEvaluationSuiteVersion: { kind: "repository", permission: "read" },
  listEvaluationSuiteCases: { kind: "repository", permission: "read" },
  getEvaluationSuiteCase: { kind: "repository", permission: "read" },
  listNotificationOverview: { kind: "list" },
  getNotificationSummary: { kind: "list" },
  listRepositoryNotifications: { kind: "repository", permission: "read" },
  changeNotificationStates: { kind: "repository", permission: "read" },
  listManagedRepositories: { kind: "list" },
  getManagedRepository: { kind: "repository", permission: "read" },
  listRepositoryConfigurationAudit: { kind: "repository", permission: "read" },
  getRepositoryConfigurationAudit: { kind: "repository", permission: "read" },
  listGlobalConfigurationAudit: { kind: "platform" },
  getGlobalConfigurationAudit: { kind: "platform" },
  getRepositoryJobScheduling: { kind: "repository", permission: "read" },
  getValidationRequestScheduling: { kind: "repository", permission: "read" },
  getPlatformJobScheduling: { kind: "platform" },
  getRepositorySchedulingStatus: { kind: "repository", permission: "read" },
  getPlatformSchedulingStatus: { kind: "platform" },
  getRepositoryPublicationPolicy: { kind: "repository", permission: "read" },
  updateRepositoryPublicationPolicy: { kind: "repository", permission: "configure" },
  listRepositoryPublicationPolicyAudit: { kind: "repository", permission: "read" },
  getRepositoryPublicationPolicyAudit: { kind: "repository", permission: "read" },
  getPublicationPreview: { kind: "repository", permission: "read" },
  confirmPublication: { kind: "repository", permission: "configure" },
  listPublications: { kind: "repository", permission: "read" },
  getPublication: { kind: "repository", permission: "read" },
  listPublicationAttempts: { kind: "repository", permission: "read" },
  cancelPublication: { kind: "repository", permission: "configure" },
  retryPublication: { kind: "repository", permission: "configure" },
  requestPublicationReconciliation: { kind: "repository", permission: "configure" },
  updatePlatformSchedulingConfiguration: { kind: "platform" },
  listPlatformSchedulingConfigurationAudit: { kind: "platform" },
  getPlatformSchedulingConfigurationAudit: { kind: "platform" },
  getPromptWorkItemContext: { kind: "work_item" },
  createManagedRepository: { kind: "platform" },
  updateManagedRepository: { kind: "repository", permission: "configure" },
  updateRepositoryConnection: { kind: "repository", permission: "configure" },
  listPromptTemplates: { kind: "platform" },
  getPromptTemplate: { kind: "platform" },
  createPromptTemplate: { kind: "platform" },
  savePromptDraft: { kind: "platform" },
  publishPromptDraft: { kind: "platform" },
  listPromptVersions: { kind: "platform" },
  getPromptVersion: { kind: "platform" },
  listPromptBindings: { kind: "prompt_binding", permission: "read" },
  savePromptBinding: { kind: "prompt_binding", permission: "configure" },
  listPromptBindingHistory: { kind: "prompt_binding", permission: "read" },
  listValidationProfiles: { kind: "repository", permission: "read" },
  publishValidationProfile: { kind: "repository", permission: "configure" },
  listValidationProfileVersions: { kind: "repository", permission: "read" },
  getValidationProfileVersion: { kind: "repository", permission: "read" },
  listValidationProfileBindings: { kind: "repository", permission: "read" },
  saveValidationProfileBinding: { kind: "repository", permission: "configure" },
  listValidationProfileBindingHistory: { kind: "repository", permission: "read" },
  listDashboardReviewRuns: { kind: "repository", permission: "read" },
  getDashboardReviewRun: { kind: "repository", permission: "read" },
  listDashboardReviewRunJobs: { kind: "repository", permission: "read" },
  getDashboardReviewRunJobResult: { kind: "repository", permission: "read" },
  getDashboardReviewRunReproductionCase: { kind: "repository", permission: "read" },
  getReviewRunDecisionContext: { kind: "repository", permission: "read" },
  listReviewRunDecisionHistory: { kind: "repository", permission: "read" },
  changeReviewRunDecision: { kind: "repository", permission: "review" },
  listFindingOccurrences: { kind: "repository", permission: "read" },
  getFindingDispositionHistory: { kind: "repository", permission: "read" },
  compareFindingResults: { kind: "repository", permission: "read" },
  changeFindingDisposition: { kind: "repository", permission: "review" },
  createOperatorReviewRun: { kind: "repository", permission: "review" },
  rerunValidationRequest: { kind: "repository", permission: "review" },
  cancelValidationJob: { kind: "repository", permission: "review" },
  listEvidenceAssets: { kind: "repository", permission: "read" },
  getEvidenceAsset: { kind: "repository", permission: "read" },
  readEvidenceAssetChunk: { kind: "repository", permission: "read" },
  listWorkItems: { kind: "list" },
  listJobs: { kind: "list" },
  getJob: { kind: "job" },
  listWorkers: { kind: "platform" },
  getSystemSnapshot: { kind: "platform" },
  listWorkerNodeCredentials: { kind: "platform" },
  createWorkerNodeCredential: { kind: "platform" },
  rotateWorkerToken: { kind: "platform" },
  revokeWorkerToken: { kind: "platform" },
  getOperatorAccessContext: { kind: "access_context" },
  listRepositoryAccessGrants: { kind: "repository", permission: "manage_access" },
  listRepositoryAccessAudit: { kind: "repository", permission: "manage_access" },
  changeRepositoryAccess: { kind: "repository", permission: "manage_access" },
  operatorCheckPermission: { kind: "permission_check" },
} as const satisfies Record<string, Rule>;
export type OperatorRequestOperation = keyof typeof operatorRules;

export function isOperatorRequestOperation(
  operation: string,
): operation is OperatorRequestOperation {
  return Object.hasOwn(operatorRules, operation);
}

const actorOperations = new Set<OperatorRequestOperation>([
  "createEvaluationBatch",
  "cancelEvaluationBatch",
  "listEvaluationBatches",
  "getEvaluationBatch",
  "getEvaluationBatchMatrix",
  "getEvaluationCellResult",
  "getEvaluationSourceReproduction",
  "getEvaluationReproductionPlan",
  "getEvaluationReproductionCell",
  "previewEvaluationReproduction",
  "getEvaluationAdjudicationContext",
  "listEvaluationAdjudicationHistory",
  "changeEvaluationAdjudication",
  "getEvaluationScorePreview",
  "publishEvaluationAssessment",
  "listEvaluationAssessments",
  "getEvaluationAssessment",
  "getEvaluationAssessmentCase",
  "listEvaluationResultEvidence",
  "getEvaluationResultEvidenceAsset",
  "readEvaluationResultEvidenceChunk",
  "listEvaluationPromptOptions",
  "captureEvaluationSource",
  "getEvaluationSource",
  "listEvaluationSources",
  "createEvaluationSuite",
  "getEvaluationSuite",
  "listEvaluationSuites",
  "saveEvaluationSuiteDraft",
  "publishEvaluationSuite",
  "listEvaluationSuiteVersions",
  "getEvaluationSuiteVersion",
  "listEvaluationSuiteCases",
  "getEvaluationSuiteCase",
  "listNotificationOverview",
  "getNotificationSummary",
  "listRepositoryNotifications",
  "changeNotificationStates",
  "getRepositoryPublicationPolicy",
  "updateRepositoryPublicationPolicy",
  "listRepositoryPublicationPolicyAudit",
  "getRepositoryPublicationPolicyAudit",
  "getPublicationPreview",
  "confirmPublication",
  "listPublications",
  "getPublication",
  "listPublicationAttempts",
  "cancelPublication",
  "retryPublication",
  "requestPublicationReconciliation",
  "createManagedRepository",
  "updateManagedRepository",
  "updatePlatformSchedulingConfiguration",
  "createPromptTemplate",
  "savePromptDraft",
  "publishPromptDraft",
  "savePromptBinding",
  "publishValidationProfile",
  "saveValidationProfileBinding",
  "createOperatorReviewRun",
  "rerunValidationRequest",
  "cancelValidationJob",
  "getReviewRunDecisionContext",
  "listReviewRunDecisionHistory",
  "changeReviewRunDecision",
  "listFindingOccurrences",
  "getFindingDispositionHistory",
  "compareFindingResults",
  "changeFindingDisposition",
  "getOperatorAccessContext",
  "listRepositoryAccessGrants",
  "listRepositoryAccessAudit",
  "changeRepositoryAccess",
]);
const credentialActorFields: Partial<Record<OperatorRequestOperation, readonly [string, string]>> =
  {
    createWorkerNodeCredential: ["createdByIssuer", "createdBySubject"],
    rotateWorkerToken: ["rotatedByIssuer", "rotatedBySubject"],
    revokeWorkerToken: ["revokedByIssuer", "revokedBySubject"],
  };
const contextSchema = Type.Object(
  { kind: Type.Literal("operator"), actor: OperatorPrincipalSchema },
  { additionalProperties: false },
);
const permissionCheckSchema = Type.Object(
  {
    repositoryId: Type.Optional(EntityIdSchema),
    permission: Type.Optional(OperatorRepositoryPermissionSchema),
  },
  { additionalProperties: false },
);

function invalid(message: string): never {
  throw new OperatorAccessError("PLATFORM_INVALID", message);
}
function forbidden(message = "This database operation is not available to operators."): never {
  throw new OperatorAccessError("PLATFORM_FORBIDDEN", message);
}
function notFound(): never {
  throw new OperatorAccessError("PLATFORM_NOT_FOUND", "The requested resource was not found.");
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
export function cloneOperatorInput<T>(value: T): T {
  try {
    return freeze(structuredClone(value));
  } catch {
    return invalid("The operator request cannot be copied safely.");
  }
}
export function createOperatorRequestContext(actor: OperatorPrincipal): OperatorRequestContext {
  const context = cloneOperatorInput({ kind: "operator" as const, actor });
  if (!Value.Check(contextSchema, context))
    invalid("The authenticated operator context is invalid.");
  isPlatformAdministrator(context.actor, []);
  return context;
}
function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid("An operator operation requires an input object.");
  return value as Record<string, unknown>;
}
function entity(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (!Value.Check(EntityIdSchema, value)) invalid(`The ${name} scope is invalid.`);
  return value;
}
function authenticatedInput(
  operation: OperatorRequestOperation,
  input: unknown,
  actor: OperatorPrincipal,
): Record<string, unknown> {
  const captured = { ...record(cloneOperatorInput(input)) };
  if (Object.hasOwn(captured, "actor")) {
    if (!Value.Check(OperatorPrincipalSchema, captured.actor))
      invalid("The input actor is invalid.");
    if (captured.actor.issuer !== actor.issuer || captured.actor.subject !== actor.subject)
      forbidden("The input actor does not match the authenticated operator.");
  }
  if (actorOperations.has(operation)) captured.actor = actor;
  const fields = credentialActorFields[operation];
  if (fields !== undefined) {
    for (const [field, expected] of [
      [fields[0], actor.issuer],
      [fields[1], actor.subject],
    ] as const) {
      if (Object.hasOwn(captured, field) && captured[field] !== expected)
        forbidden("The credential audit actor does not match the authenticated operator.");
      captured[field] = expected;
    }
  }
  return freeze(captured);
}

export interface AuthorizedOperatorRequest {
  readonly request: {
    readonly operation: OperatorRequestOperation;
    readonly input: Record<string, unknown>;
  };
  readonly readContext: OperatorReadContext;
  /** Repeat immediately before a mutation or projection after every asynchronous boundary. */
  revalidate(): void;
}

/** The caller supplies context only from an authenticated server session, never an HTTP body. */
export function authorizeOperatorRequest(
  database: DatabaseSync,
  input: OperatorRequestInput,
  administrators: readonly OperatorPrincipal[],
): AuthorizedOperatorRequest {
  const raw = record(input);
  if (
    Object.keys(raw).length !== 3 ||
    !Object.hasOwn(raw, "context") ||
    !Object.hasOwn(raw, "operation") ||
    !Object.hasOwn(raw, "input") ||
    !Value.Check(contextSchema, raw.context) ||
    typeof raw.operation !== "string"
  )
    invalid("The operator request envelope is invalid.");
  const context = createOperatorRequestContext(raw.context.actor);
  if (!isOperatorRequestOperation(raw.operation)) forbidden();
  const operation = raw.operation;
  const captured = authenticatedInput(operation, raw.input, context.actor);
  const platformAdministrator = isPlatformAdministrator(context.actor, administrators);
  const readContext: OperatorReadContext = freeze({
    actor: context.actor,
    administrators: cloneOperatorInput(administrators),
  });
  const rule: Rule = operatorRules[operation];
  const assertRepository = (repositoryId: string, permission: OperatorRepositoryPermission) =>
    assertRepositoryPermission(database, context.actor, repositoryId, permission, administrators);
  const assertPlatform = () => assertPlatformAdministrator(context.actor, administrators);
  const check = (): string | undefined => {
    if (isPlatformAdministrator(context.actor, administrators) !== platformAdministrator)
      forbidden("The platform administrator context changed during this operation.");
    switch (rule.kind) {
      case "platform":
        assertPlatform();
        return;
      case "repository":
        assertRepository(entity(captured, "repositoryId"), rule.permission);
        return;
      case "list":
      case "access_context":
        if (captured.repositoryId !== undefined)
          assertRepository(entity(captured, "repositoryId"), "read");
        return;
      case "prompt_binding":
        if (captured.repositoryId === null) assertPlatform();
        else assertRepository(entity(captured, "repositoryId"), rule.permission);
        return;
      case "permission_check":
        if (!Value.Check(permissionCheckSchema, captured))
          invalid("The requested operator permission is invalid.");
        if (captured.repositoryId === undefined) assertPlatform();
        else assertRepository(captured.repositoryId, captured.permission ?? "read");
        return;
      case "work_item": {
        const workItemId = entity(captured, "workItemId");
        const row = database
          .prepare("SELECT repository_id FROM work_items WHERE id = ?")
          .get(workItemId) as { repository_id: string } | undefined;
        if (!row) notFound();
        assertRepository(row.repository_id, "read");
        return `${workItemId}\0${row.repository_id}`;
      }
      case "job": {
        const jobId = entity(captured, "jobId");
        const row = database
          .prepare(`SELECT job.work_item_id, item.repository_id FROM jobs AS job
          LEFT JOIN work_items AS item ON item.id = job.work_item_id WHERE job.id = ?`)
          .get(jobId) as { work_item_id: string | null; repository_id: string | null } | undefined;
        if (!row) notFound();
        if (row.work_item_id === null) {
          assertPlatform();
          return `${jobId}\0legacy`;
        }
        if (row.repository_id === null) notFound();
        assertRepository(row.repository_id, "read");
        return `${jobId}\0${row.work_item_id}\0${row.repository_id}`;
      }
    }
  };
  const relation = check();
  return Object.freeze({
    request: Object.freeze({ operation, input: captured }),
    readContext,
    revalidate() {
      if (check() !== relation) notFound();
    },
  });
}
