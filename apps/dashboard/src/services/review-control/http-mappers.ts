import type {
  AuthorizationDecisionReason,
  DashboardAuthorization,
  DashboardJobOutcome,
  DashboardRequestEpochSummary,
  DashboardWorkItemFreshness,
  DashboardWorkItemPriority,
  DashboardWorkItemStage,
  ExecutionPhase,
  GitHubAccountType,
  GitHubWorkItemKind,
  JobAdmission,
  JobState,
  ReviewExecutionEvidence,
  RunFailureDiagnostics,
  SchedulingRequestKind,
  VerificationReport,
  WorkerState,
  WorkItemState,
} from "@agentic-review/contracts";
import {
  getDashboardWorkItemAdmissionIssues,
  getJobAdmissionIssues,
} from "@agentic-review/contracts";
import { ReviewControlProtocolError } from "./errors";
import type {
  HealthComponent,
  Job,
  JobDetails,
  JobReviewResult,
  JobStage,
  PageResult,
  SystemSnapshot,
  WorkerCredential,
  WorkerCredentialRevocation,
  WorkerCredentialSecret,
  WorkerNode,
  WorkItem,
} from "./types";

type JsonObject = Record<string, unknown>;

const accountTypes = {
  app: true,
  bot: true,
  user: true,
} satisfies Record<GitHubAccountType, true>;

const workItemKinds = {
  issue: true,
  pull_request: true,
} satisfies Record<GitHubWorkItemKind, true>;

const schedulingRequestKinds = {
  assignment: true,
  review_request: true,
} satisfies Record<SchedulingRequestKind, true>;

const dashboardAuthorizations = {
  allowlisted: true,
  denied: true,
  self: true,
} satisfies Record<DashboardAuthorization, true>;

const authorizationReasons = {
  authorized_allowlisted: true,
  authorized_self: true,
  denied_actor_not_allowed: true,
  denied_actor_unknown: true,
  denied_epoch_work_item_mismatch: true,
  denied_event_not_request_open: true,
  denied_identity_mismatch: true,
  denied_no_active_epoch: true,
  denied_revision_not_inheritable: true,
  denied_revision_unchanged: true,
  denied_target_unknown: true,
  denied_work_item_closed: true,
  denied_wrong_target: true,
  inherited_active_epoch: true,
} satisfies Record<AuthorizationDecisionReason, true>;

const priorities = {
  high: true,
  low: true,
  normal: true,
  urgent: true,
} satisfies Record<DashboardWorkItemPriority, true>;

const workItemStates = {
  active: true,
  assigned: true,
  closed: true,
  open: true,
  unassigned: true,
} satisfies Record<WorkItemState, true>;

const workItemStages = {
  not_scheduled: true,
  awaiting_admission: true,
  done: true,
  preparing: true,
  publishing: true,
  queued: true,
  reviewing: true,
  validating: true,
  waiting_approval: true,
} satisfies Record<DashboardWorkItemStage, true>;

const freshnessValues = {
  current: true,
  superseded: true,
} satisfies Record<DashboardWorkItemFreshness, true>;

const jobStates = {
  cancel_requested: true,
  cancelled: true,
  dead_letter: true,
  failed: true,
  leased: true,
  queued: true,
  retry_waiting: true,
  running: true,
  stale: true,
  succeeded: true,
} satisfies Record<JobState, true>;

const executionPhases = {
  cancelling: true,
  codex_review: true,
  codex_revision: true,
  completing: true,
  leased: true,
  preparing: true,
  uploading: true,
  validation: true,
} satisfies Record<ExecutionPhase, true>;

const jobOutcomes = {
  cancelled: true,
  failed: true,
  success: true,
  timed_out: true,
} satisfies Record<DashboardJobOutcome, true>;

const verificationStatuses = {
  not_run: true,
  passed: true,
  failed: true,
  unknown: true,
} satisfies Record<VerificationReport["status"], true>;

const failureCategories = {
  workspace: true,
  launch: true,
  process: true,
  event_stream: true,
  result: true,
  internal: true,
} satisfies Record<RunFailureDiagnostics["category"], true>;

const workerStates = {
  disabled: true,
  draining: true,
  offline: true,
  online: true,
} satisfies Record<WorkerState, true>;

const issueCategories = {
  bug: true,
  documentation: true,
  feature_request: true,
  other: true,
  question: true,
  support: true,
} as const;

const healthStates = {
  degraded: true,
  healthy: true,
  unavailable: true,
} as const;

const workerCredentialAuthStates = {
  active: true,
  pending: true,
  revoked: true,
} as const;

const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\s\S])/u;
const workerNodeIdPattern =
  /^worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const workerTokenExposurePattern = /arw1_[A-Za-z0-9_-]{43}/u;
const workerTokenPattern = /^arw1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const gitObjectIdPattern = /^[a-f0-9]{40,64}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const requestedRecipeIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const maxSourceLine = 10_000_000;
const maxInt32 = 2_147_483_647;
const minExitCode = -2_147_483_648;
const maxExitCode = 4_294_967_295;

const fail = (operation: string, path: string, expectation: string): never => {
  throw new ReviewControlProtocolError(
    operation,
    `The ${operation} response has an invalid ${path}; expected ${expectation}.`,
    path,
  );
};

const asObject = (
  value: unknown,
  operation: string,
  path: string,
  allowedKeys: readonly string[],
): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(operation, path, "an object");
  }

  const object = value as JsonObject;
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(object).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    return fail(operation, path, "an object with no additional properties");
  }
  return object;
};

const readString = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  minimumLength = 1,
  maximumLength = Number.MAX_SAFE_INTEGER,
  pattern?: RegExp,
): string => {
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    return fail(operation, `${path}.${key}`, "a valid string");
  }
  return value;
};

const readNullableString = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  maximumLength = Number.MAX_SAFE_INTEGER,
): string | null => {
  if (object[key] === null) {
    return null;
  }
  return readString(object, key, operation, path, 0, maximumLength);
};

const readInteger = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(operation, `${path}.${key}`, `an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
};

const readNullableInteger = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null => {
  if (object[key] === null) {
    return null;
  }
  return readInteger(object, key, operation, path, minimum, maximum);
};

const readPriority = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
): 0 | 1 | 2 | 3 => {
  const priority = readInteger(object, key, operation, path, 0, 3);
  if (priority === 0 || priority === 1 || priority === 2 || priority === 3) {
    return priority;
  }
  return fail(operation, `${path}.${key}`, "an integer from 0 through 3");
};

const readEnum = <TValue extends string>(
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  values: Readonly<Record<TValue, true>>,
): TValue => {
  const value = object[key];
  if (typeof value !== "string" || !Object.hasOwn(values, value)) {
    return fail(operation, `${path}.${key}`, "a supported enum value");
  }
  return value as TValue;
};

const readNullableEnum = <TValue extends string>(
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  values: Readonly<Record<TValue, true>>,
): TValue | null => {
  if (object[key] === null) {
    return null;
  }
  return readEnum(object, key, operation, path, values);
};

const readDateTime = (object: JsonObject, key: string, operation: string, path: string): string => {
  const value = readString(object, key, operation, path);
  if (!dateTimePattern.test(value) || !Number.isFinite(Date.parse(value))) {
    return fail(operation, `${path}.${key}`, "an RFC 3339 date-time");
  }
  return value;
};

const readNullableDateTime = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
): string | null => {
  if (object[key] === null) {
    return null;
  }
  return readDateTime(object, key, operation, path);
};

const readUri = (object: JsonObject, key: string, operation: string, path: string): string => {
  const value = readString(object, key, operation, path, 1, 2_048);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return fail(operation, `${path}.${key}`, "an HTTPS URI");
    }
  } catch {
    return fail(operation, `${path}.${key}`, "an HTTPS URI");
  }
  return value;
};

const readEntityId = (object: JsonObject, key: string, operation: string, path: string): string =>
  readString(object, key, operation, path, 1, 128, entityIdPattern);

const readNullableEntityId = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
): string | null => {
  if (object[key] === null) {
    return null;
  }
  return readEntityId(object, key, operation, path);
};

interface ReadStringArrayOptions {
  readonly entityIds?: boolean;
  readonly maximumItemLength?: number;
  readonly minimumItemLength?: number;
  readonly pattern?: RegExp;
  readonly uniqueItems?: boolean;
}

const readStringArray = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  maximumItems: number,
  options: ReadStringArrayOptions = {},
): string[] => {
  const {
    entityIds = false,
    maximumItemLength = 128,
    minimumItemLength = 1,
    pattern,
    uniqueItems = true,
  } = options;
  const value = object[key];
  if (!Array.isArray(value) || value.length > maximumItems) {
    return fail(operation, `${path}.${key}`, `an array with at most ${maximumItems} items`);
  }
  const result = value.map((item, index) => {
    if (
      typeof item !== "string" ||
      item.length < minimumItemLength ||
      item.length > maximumItemLength ||
      (pattern !== undefined && !pattern.test(item)) ||
      (entityIds && !entityIdPattern.test(item))
    ) {
      return fail(operation, `${path}.${key}[${index}]`, "a valid string");
    }
    return item;
  });
  if (uniqueItems && new Set(result).size !== result.length) {
    return fail(operation, `${path}.${key}`, "an array of unique strings");
  }
  return result;
};

const readUnknownArray = (
  value: unknown,
  operation: string,
  path: string,
  maximumItems: number,
): unknown[] => {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return fail(operation, path, `an array with at most ${maximumItems} items`);
  }
  return value;
};

const readUnitIntervalNumber = (value: unknown, operation: string, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return fail(operation, path, "a number from 0 through 1");
  }
  return value;
};

const actorKeys = ["githubUserId", "login", "accountType", "githubNodeId", "avatarUrl"] as const;

const readActorLogin = (value: unknown, operation: string, path: string): string => {
  const actor = asObject(value, operation, path, actorKeys);
  readInteger(actor, "githubUserId", operation, path, 1);
  const login = readString(actor, "login", operation, path, 1, 128);
  if (actor.accountType !== undefined) {
    readEnum(actor, "accountType", operation, path, accountTypes);
  }
  if (actor.githubNodeId !== undefined) {
    readString(actor, "githubNodeId", operation, path, 1, 256);
  }
  if (actor.avatarUrl !== undefined) {
    readUri(actor, "avatarUrl", operation, path);
  }
  return login;
};

const readNullableActorLogin = (value: unknown, operation: string, path: string): string | null =>
  value === null ? null : readActorLogin(value, operation, path);

interface RevisionSummary {
  readonly headSha: string | undefined;
  readonly kind: GitHubWorkItemKind;
  readonly revisionKey: string;
}

const revisionBaseKeys = [
  "githubRepositoryId",
  "githubWorkItemId",
  "observedAt",
  "sourceUpdatedAt",
  "kind",
  "revisionKey",
] as const;

const readRevision = (value: unknown, operation: string, path: string): RevisionSummary => {
  const discriminator = asObject(value, operation, path, [
    ...revisionBaseKeys,
    "contentDigest",
    "baseSha",
    "headSha",
  ]);
  const kind = readEnum(discriminator, "kind", operation, path, workItemKinds);
  const expectedKeys =
    kind === "issue"
      ? [...revisionBaseKeys, "contentDigest"]
      : [...revisionBaseKeys, "baseSha", "headSha"];
  const revision = asObject(value, operation, path, expectedKeys);
  readInteger(revision, "githubRepositoryId", operation, path, 1);
  readInteger(revision, "githubWorkItemId", operation, path, 1);
  readDateTime(revision, "observedAt", operation, path);
  readDateTime(revision, "sourceUpdatedAt", operation, path);
  const revisionKey = readString(revision, "revisionKey", operation, path, 64, 64, sha256Pattern);

  if (kind === "issue") {
    readString(revision, "contentDigest", operation, path, 64, 64, sha256Pattern);
    return { headSha: undefined, kind, revisionKey };
  }

  readString(revision, "baseSha", operation, path, 40, 64, gitObjectIdPattern);
  const headSha = readString(revision, "headSha", operation, path, 40, 64, gitObjectIdPattern);
  return { headSha, kind, revisionKey };
};

const requestEpochKeys = [
  "requestEpochId",
  "requestKind",
  "sequence",
  "status",
  "authorization",
  "openedAt",
  "closedAt",
] as const;

const readRequestEpoch = (
  value: unknown,
  operation: string,
  path: string,
): DashboardRequestEpochSummary | null => {
  if (value === null) {
    return null;
  }
  const epoch = asObject(value, operation, path, requestEpochKeys);
  const requestEpochId = readEntityId(epoch, "requestEpochId", operation, path);
  const requestKind = readEnum(epoch, "requestKind", operation, path, schedulingRequestKinds);
  const sequence = readInteger(epoch, "sequence", operation, path, 1);
  const status = readEnum(epoch, "status", operation, path, { active: true, closed: true });
  const authorization = readEnum(epoch, "authorization", operation, path, {
    allowlisted: true,
    self: true,
  });
  const openedAt = readDateTime(epoch, "openedAt", operation, path);
  const closedAt = readNullableDateTime(epoch, "closedAt", operation, path);
  if ((status === "active" && closedAt !== null) || (status === "closed" && closedAt === null)) {
    fail(operation, `${path}.closedAt`, `a value consistent with status ${status}`);
  }
  return { requestEpochId, requestKind, sequence, status, authorization, openedAt, closedAt };
};

function readAdmission(
  item: JsonObject,
  key: string,
  status: JobState,
  attemptCount: number,
  operation: string,
  path: string,
): JobAdmission | null {
  let admission: JobAdmission | null = null;
  if (item[key] !== null) {
    const source = asObject(item[key], operation, `${path}.${key}`, [
      "state",
      "attemptBase",
      "requestedAt",
      "timestampBasis",
      "admittedAt",
    ]);
    const state = readEnum(source, "state", operation, `${path}.${key}`, {
      pending: true,
      admitted: true,
    });
    const attemptBase = readInteger(source, "attemptBase", operation, `${path}.${key}`, 0);
    const requestedAt = readDateTime(source, "requestedAt", operation, `${path}.${key}`);
    const timestampBasis = readEnum(source, "timestampBasis", operation, `${path}.${key}`, {
      recorded: true,
      migration_backfill: true,
    });
    const admittedAt = readNullableDateTime(source, "admittedAt", operation, `${path}.${key}`);
    if ((state === "pending") !== (admittedAt === null))
      fail(operation, `${path}.${key}`, "an admission timestamp matching its state");
    admission =
      state === "pending"
        ? { state, attemptBase, requestedAt, timestampBasis, admittedAt: null }
        : { state, attemptBase, requestedAt, timestampBasis, admittedAt: admittedAt as string };
  }
  if (getJobAdmissionIssues({ status, attemptCount, admission }).length > 0)
    fail(
      operation,
      `${path}.${key}`,
      "an exact waiting admission episode or null for a nonwaiting job",
    );
  return admission;
}

const workItemKeys = [
  "id",
  "repositoryId",
  "kind",
  "repository",
  "number",
  "title",
  "author",
  "githubUrl",
  "trigger",
  "schedulingActor",
  "schedulingTarget",
  "authorization",
  "authorizationReason",
  "priority",
  "state",
  "stage",
  "freshness",
  "currentRevision",
  "reviewedRevisionKey",
  "activeRequestEpoch",
  "latestJobId",
  "latestJobStatus",
  "latestJobAttemptCount",
  "latestJobAdmission",
  "workerNodeId",
  "attentionReason",
  "updatedAt",
] as const;

const mapWorkItem = (value: unknown, operation: string, path: string): WorkItem => {
  const item = asObject(value, operation, path, workItemKeys);
  const id = readEntityId(item, "id", operation, path);
  const repositoryId = readEntityId(item, "repositoryId", operation, path);
  const kind = readEnum(item, "kind", operation, path, workItemKinds);
  const repository = readString(item, "repository", operation, path, 3, 201);
  const number = readInteger(item, "number", operation, path, 1);
  const title = readString(item, "title", operation, path, 1, 1_024);
  const author = readActorLogin(item.author, operation, `${path}.author`);
  const githubUrl = readUri(item, "githubUrl", operation, path);
  const trigger = readNullableEnum(item, "trigger", operation, path, schedulingRequestKinds);
  const schedulingActor = readNullableActorLogin(
    item.schedulingActor,
    operation,
    `${path}.schedulingActor`,
  );
  readNullableActorLogin(item.schedulingTarget, operation, `${path}.schedulingTarget`);
  const authorization = readNullableEnum(
    item,
    "authorization",
    operation,
    path,
    dashboardAuthorizations,
  );
  readNullableEnum(item, "authorizationReason", operation, path, authorizationReasons);
  const priority = readEnum(item, "priority", operation, path, priorities);
  const state = readEnum(item, "state", operation, path, workItemStates);
  const stage = readEnum(item, "stage", operation, path, workItemStages);
  const freshness = readEnum(item, "freshness", operation, path, freshnessValues);
  const revision = readRevision(item.currentRevision, operation, `${path}.currentRevision`);
  if (revision.kind !== kind) {
    fail(operation, `${path}.currentRevision.kind`, `the work item kind ${kind}`);
  }
  const reviewedRevisionKey = readNullableString(item, "reviewedRevisionKey", operation, path);
  const activeRequestEpoch = readRequestEpoch(
    item.activeRequestEpoch,
    operation,
    `${path}.activeRequestEpoch`,
  );
  const latestJobId = readNullableEntityId(item, "latestJobId", operation, path);
  const latestJobStatus = readNullableEnum(item, "latestJobStatus", operation, path, jobStates);
  const latestJobAttemptCount = readNullableInteger(
    item,
    "latestJobAttemptCount",
    operation,
    path,
    0,
  );
  const latestJobAdmission =
    latestJobStatus === null
      ? (item.latestJobAdmission as null)
      : readAdmission(
          item,
          "latestJobAdmission",
          latestJobStatus,
          latestJobAttemptCount ?? -1,
          operation,
          path,
        );
  const workerNodeId = readNullableEntityId(item, "workerNodeId", operation, path);
  const attentionReason = readNullableString(item, "attentionReason", operation, path);
  const updatedAt = readDateTime(item, "updatedAt", operation, path);
  if (
    getDashboardWorkItemAdmissionIssues({
      latestJobId,
      latestJobStatus,
      latestJobAttemptCount,
      latestJobAdmission,
      stage,
    }).length > 0
  )
    fail(operation, path, "a work item with consistent latest-job admission identity and stage");

  return {
    id,
    repositoryId,
    revisionKey: revision.revisionKey,
    activeRequestEpoch,
    kind,
    repository,
    number,
    title,
    author,
    githubUrl,
    trigger:
      trigger === "assignment"
        ? "assigned"
        : trigger === "review_request"
          ? "review_requested"
          : "not_requested",
    scheduledBy: schedulingActor ?? "No scheduling actor",
    authorization: authorization ?? "pending",
    priority,
    state,
    stage,
    freshness,
    ...(latestJobId === null ? {} : { latestJobId }),
    ...(latestJobStatus === null ? {} : { latestJobStatus }),
    latestJobAttemptCount,
    latestJobAdmission,
    ...(revision.headSha === undefined ? {} : { headSha: revision.headSha }),
    ...(reviewedRevisionKey === null ? {} : { reviewedSha: reviewedRevisionKey }),
    ...(workerNodeId === null ? {} : { workerNodeId }),
    ...(attentionReason === null ? {} : { attentionReason }),
    updatedAt,
  };
};

const jobKeys = [
  "id",
  "repositoryId",
  "workItemId",
  "workItemRef",
  "title",
  "generation",
  "status",
  "admission",
  "phase",
  "attempt",
  "maxAttempts",
  "workerNodeId",
  "leaseGeneration",
  "leaseExpiresAt",
  "progressUpdatedAt",
  "elapsedSeconds",
  "targetRevisionKey",
  "outcome",
  "createdAt",
  "updatedAt",
] as const;

export const mapJobStage = (
  status: JobState,
  phase: ExecutionPhase | null,
  operation: string,
  path: string,
  admission: JobAdmission | null,
): JobStage => {
  switch (status) {
    case "queued":
    case "retry_waiting":
      if (admission == null)
        return fail(operation, `${path}.admission`, "a waiting admission episode");
      return admission.state === "pending" ? "awaiting_admission" : "queued";
    case "cancel_requested":
      return "cancelling";
    case "cancelled":
    case "dead_letter":
    case "failed":
    case "stale":
    case "succeeded":
      return "done";
    case "leased":
      return phase ?? "leased";
    case "running":
      if (phase === null) {
        return fail(operation, `${path}.phase`, "an execution phase for a running job");
      }
      return phase;
  }
};

const mapJob = (value: unknown, operation: string, path: string): Job => {
  const item = asObject(value, operation, path, jobKeys);
  const id = readEntityId(item, "id", operation, path);
  const repositoryId = readEntityId(item, "repositoryId", operation, path);
  const workItemId = readEntityId(item, "workItemId", operation, path);
  const workItemRef = readString(item, "workItemRef", operation, path, 1, 256);
  const title = readString(item, "title", operation, path, 1, 256);
  const generation = readInteger(item, "generation", operation, path, 1);
  const status = readEnum(item, "status", operation, path, jobStates);
  const phase = readNullableEnum(item, "phase", operation, path, executionPhases);
  const attempt = readInteger(item, "attempt", operation, path, 0);
  const admission = readAdmission(item, "admission", status, attempt, operation, path);
  const maxAttempts = readInteger(item, "maxAttempts", operation, path, 1);
  const workerNodeId = readNullableEntityId(item, "workerNodeId", operation, path);
  const leaseGeneration = readNullableInteger(item, "leaseGeneration", operation, path, 1);
  const leaseExpiresAt = readNullableDateTime(item, "leaseExpiresAt", operation, path);
  const progressUpdatedAt = readNullableDateTime(item, "progressUpdatedAt", operation, path);
  const elapsedSeconds = readInteger(item, "elapsedSeconds", operation, path, 0);
  const targetRevisionKey = readString(item, "targetRevisionKey", operation, path, 1, 128);
  const outcome = readNullableEnum(item, "outcome", operation, path, jobOutcomes);
  const createdAt = readDateTime(item, "createdAt", operation, path);
  readDateTime(item, "updatedAt", operation, path);

  return {
    id,
    repositoryId,
    workItemId,
    workItemRef,
    title,
    generation,
    status,
    admission,
    stage: mapJobStage(status, phase, operation, path, admission),
    attempt,
    maxAttempts,
    ...(workerNodeId === null ? {} : { workerNodeId }),
    ...(leaseGeneration === null ? {} : { leaseGeneration }),
    ...(leaseExpiresAt === null ? {} : { leaseExpiresAt }),
    ...(progressUpdatedAt === null ? {} : { progressUpdatedAt }),
    elapsedSeconds,
    targetSha: targetRevisionKey,
    ...(outcome === null ? {} : { outcome }),
    createdAt,
  };
};

const reviewFindingKeys = [
  "findingId",
  "ordinal",
  "priority",
  "title",
  "body",
  "path",
  "line",
  "endLine",
  "confidence",
] as const;

const mapReviewFinding = (value: unknown, operation: string, path: string) => {
  const finding = asObject(value, operation, path, reviewFindingKeys);
  const line = readInteger(finding, "line", operation, path, 1, maxSourceLine);
  const endLine = readNullableInteger(finding, "endLine", operation, path, 1, maxSourceLine);
  if (endLine !== null && endLine < line) {
    fail(operation, `${path}.endLine`, "a value greater than or equal to line");
  }
  return {
    findingId: readString(finding, "findingId", operation, path, 1, 128),
    ordinal: readInteger(finding, "ordinal", operation, path, 0),
    priority: readPriority(finding, "priority", operation, path),
    title: readString(finding, "title", operation, path, 1, 256),
    body: readString(finding, "body", operation, path, 1, 8_192),
    path: readString(finding, "path", operation, path, 1, 1_024),
    line,
    endLine,
    confidence: (() => {
      const confidence = finding.confidence;
      if (
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
      ) {
        return fail(operation, `${path}.confidence`, "a number from 0 through 1");
      }
      return confidence;
    })(),
  };
};

const mapVerificationReport = (
  value: unknown,
  operation: string,
  path: string,
): VerificationReport => {
  const report = asObject(value, operation, path, ["status", "summary", "commands"]);
  const commands = readUnknownArray(report.commands, operation, `${path}.commands`, 32);
  return {
    status: readEnum(report, "status", operation, path, verificationStatuses),
    summary: readString(report, "summary", operation, path, 1, 2_048),
    commands: commands.map((value, index) => {
      const commandPath = `${path}.commands[${index}]`;
      const command = asObject(value, operation, commandPath, ["command", "status"]);
      return {
        command: readString(command, "command", operation, commandPath, 1, 2_048),
        status: readEnum(command, "status", operation, commandPath, verificationStatuses),
      };
    }),
  };
};

const mapExecutionEvidence = (
  value: unknown,
  operation: string,
  path: string,
): ReviewExecutionEvidence => {
  const evidence = asObject(value, operation, path, [
    "schemaVersion",
    "source",
    "commandCapture",
    "commands",
    "worktree",
  ]);
  const commands = readUnknownArray(evidence.commands, operation, `${path}.commands`, 128);
  const worktreePath = `${path}.worktree`;
  const worktree = asObject(evidence.worktree, operation, worktreePath, ["status", "source"]);
  return {
    schemaVersion: readEnum(evidence, "schemaVersion", operation, path, {
      ReviewExecutionEvidenceV1: true,
    }),
    source: readEnum(evidence, "source", operation, path, { worker: true }),
    commandCapture: readEnum(evidence, "commandCapture", operation, path, {
      complete: true,
      incomplete: true,
    }),
    commands: commands.map((value, index) => {
      const commandPath = `${path}.commands[${index}]`;
      const command = asObject(value, operation, commandPath, [
        "itemId",
        "command",
        "status",
        "exitCode",
      ]);
      return {
        itemId: readString(command, "itemId", operation, commandPath, 1, 128),
        command: readString(command, "command", operation, commandPath, 1, 2_048),
        status: readEnum(command, "status", operation, commandPath, {
          completed: true,
          failed: true,
          unknown: true,
        }),
        exitCode: readNullableInteger(
          command,
          "exitCode",
          operation,
          commandPath,
          minExitCode,
          maxExitCode,
        ),
      };
    }),
    worktree: {
      status: readEnum(worktree, "status", operation, worktreePath, {
        clean: true,
        modified: true,
        unknown: true,
      }),
      source: readEnum(worktree, "source", operation, worktreePath, {
        git_status: true,
        not_observed: true,
      }),
    },
  };
};

const mapFailureDiagnostics = (
  value: unknown,
  operation: string,
  path: string,
): RunFailureDiagnostics | null => {
  if (value === null) {
    return null;
  }
  const diagnostics = asObject(value, operation, path, [
    "category",
    "exitCode",
    "summary",
    "correlationId",
  ]);
  return {
    category: readEnum(diagnostics, "category", operation, path, failureCategories),
    exitCode: readNullableInteger(
      diagnostics,
      "exitCode",
      operation,
      path,
      minExitCode,
      maxExitCode,
    ),
    summary: readString(diagnostics, "summary", operation, path, 1, 2_048),
    correlationId: readString(diagnostics, "correlationId", operation, path, 1, 128),
  };
};

const mapJobReviewResult = (
  value: unknown,
  operation: string,
  path: string,
): JobReviewResult | null => {
  if (value === null) {
    return null;
  }
  const result = asObject(value, operation, path, [
    "reviewResultId",
    "schemaId",
    "resultDigest",
    "summary",
    "requestedRecipeIds",
    "createdAt",
    "prReview",
    "issueTriage",
    "verification",
    "executionEvidence",
  ]);
  const schemaId = readEnum(result, "schemaId", operation, path, {
    IssueTriageV1: true,
    PrReviewPlanV1: true,
    IssueTriageV2: true,
    PrReviewPlanV2: true,
  });
  const requestedRecipeIds = readStringArray(result, "requestedRecipeIds", operation, path, 32, {
    pattern: requestedRecipeIdPattern,
  });
  const prReviewValue = result.prReview;
  const issueTriageValue = result.issueTriage;

  let prReview: JobReviewResult["prReview"];
  if (prReviewValue === null) {
    prReview = null;
  } else {
    const prReviewObject = asObject(prReviewValue, operation, `${path}.prReview`, [
      "assessment",
      "findings",
    ]);
    const findingsValue = readUnknownArray(
      prReviewObject.findings,
      operation,
      `${path}.prReview.findings`,
      100,
    );
    prReview = {
      assessment: readEnum(prReviewObject, "assessment", operation, `${path}.prReview`, {
        approve: true,
        comment: true,
        request_changes: true,
      }),
      findings: findingsValue.map((finding, index) =>
        mapReviewFinding(finding, operation, `${path}.prReview.findings[${index}]`),
      ),
    };
  }

  let issueTriage: JobReviewResult["issueTriage"];
  if (issueTriageValue === null) {
    issueTriage = null;
  } else {
    const issue = asObject(issueTriageValue, operation, `${path}.issueTriage`, [
      "category",
      "priority",
      "confidence",
      "suggestedLabels",
      "missingInformation",
      "duplicateCandidates",
    ]);
    const confidence = readUnitIntervalNumber(
      issue.confidence,
      operation,
      `${path}.issueTriage.confidence`,
    );
    const duplicateCandidates = readUnknownArray(
      issue.duplicateCandidates,
      operation,
      `${path}.issueTriage.duplicateCandidates`,
      20,
    );
    issueTriage = {
      category: readEnum(issue, "category", operation, `${path}.issueTriage`, issueCategories),
      priority: readPriority(issue, "priority", operation, `${path}.issueTriage`),
      confidence,
      suggestedLabels: readStringArray(
        issue,
        "suggestedLabels",
        operation,
        `${path}.issueTriage`,
        32,
        {
          maximumItemLength: 100,
        },
      ),
      missingInformation: readStringArray(
        issue,
        "missingInformation",
        operation,
        `${path}.issueTriage`,
        32,
        { maximumItemLength: 2_048 },
      ),
      duplicateCandidates: duplicateCandidates.map((candidate, index) => {
        const item = asObject(
          candidate,
          operation,
          `${path}.issueTriage.duplicateCandidates[${index}]`,
          ["number", "reason"],
        );
        return {
          number: readInteger(
            item,
            "number",
            operation,
            `${path}.issueTriage.duplicateCandidates[${index}]`,
            1,
            maxInt32,
          ),
          reason: readString(
            item,
            "reason",
            operation,
            `${path}.issueTriage.duplicateCandidates[${index}]`,
            1,
            2_048,
          ),
        };
      }),
    };
  }

  if (
    (schemaId === "PrReviewPlanV1" || schemaId === "PrReviewPlanV2") !== (prReview !== null) ||
    (schemaId === "IssueTriageV1" || schemaId === "IssueTriageV2") !== (issueTriage !== null)
  ) {
    fail(operation, `${path}.schemaId`, "a value consistent with the projected review result");
  }

  return {
    reviewResultId: readEntityId(result, "reviewResultId", operation, path),
    schemaId,
    resultDigest: readString(result, "resultDigest", operation, path, 64, 64, sha256Pattern),
    summary: readString(result, "summary", operation, path, 1, 8_192),
    requestedRecipeIds,
    createdAt: readDateTime(result, "createdAt", operation, path),
    prReview,
    issueTriage,
    ...(result.verification === undefined
      ? {}
      : {
          verification: mapVerificationReport(
            result.verification,
            operation,
            `${path}.verification`,
          ),
        }),
    ...(result.executionEvidence === undefined
      ? {}
      : {
          executionEvidence: mapExecutionEvidence(
            result.executionEvidence,
            operation,
            `${path}.executionEvidence`,
          ),
        }),
  };
};

const mapJobDetails = (value: unknown, operation: string): JobDetails => {
  const item = asObject(value, operation, "$", [
    ...jobKeys,
    "failureCode",
    "failureMessage",
    "failureDiagnostics",
    "resultDigest",
    "reviewResult",
  ]);
  const status = readEnum(item, "status", operation, "$", jobStates);
  const phase = readNullableEnum(item, "phase", operation, "$", executionPhases);
  const attempt = readInteger(item, "attempt", operation, "$", 0);
  const admission = readAdmission(item, "admission", status, attempt, operation, "$");
  return {
    id: readEntityId(item, "id", operation, "$"),
    repositoryId: readEntityId(item, "repositoryId", operation, "$"),
    workItemId: readEntityId(item, "workItemId", operation, "$"),
    workItemRef: readString(item, "workItemRef", operation, "$", 1, 256),
    title: readString(item, "title", operation, "$", 1, 256),
    generation: readInteger(item, "generation", operation, "$", 1),
    status,
    admission,
    stage: mapJobStage(status, phase, operation, "$", admission),
    attempt,
    maxAttempts: readInteger(item, "maxAttempts", operation, "$", 1),
    ...(item.workerNodeId === null
      ? {}
      : { workerNodeId: readEntityId(item, "workerNodeId", operation, "$") }),
    ...(item.leaseGeneration === null
      ? {}
      : { leaseGeneration: readInteger(item, "leaseGeneration", operation, "$", 1) }),
    ...(item.leaseExpiresAt === null
      ? {}
      : { leaseExpiresAt: readDateTime(item, "leaseExpiresAt", operation, "$") }),
    ...(item.progressUpdatedAt === null
      ? {}
      : { progressUpdatedAt: readDateTime(item, "progressUpdatedAt", operation, "$") }),
    elapsedSeconds: readInteger(item, "elapsedSeconds", operation, "$", 0),
    targetSha: readString(item, "targetRevisionKey", operation, "$", 1, 128),
    ...(item.outcome === null
      ? {}
      : { outcome: readEnum(item, "outcome", operation, "$", jobOutcomes) }),
    createdAt: readDateTime(item, "createdAt", operation, "$"),
    updatedAt: readDateTime(item, "updatedAt", operation, "$"),
    failureCode: readNullableString(item, "failureCode", operation, "$", 128),
    failureMessage: readNullableString(item, "failureMessage", operation, "$", 2_048),
    ...(item.failureDiagnostics === undefined
      ? {}
      : {
          failureDiagnostics: mapFailureDiagnostics(
            item.failureDiagnostics,
            operation,
            "$.failureDiagnostics",
          ),
        }),
    resultDigest:
      item.resultDigest === null
        ? null
        : readString(item, "resultDigest", operation, "$", 64, 64, sha256Pattern),
    reviewResult: mapJobReviewResult(item.reviewResult, operation, "$.reviewResult"),
  };
};

const workerKeys = [
  "id",
  "workerNodeId",
  "instanceId",
  "displayName",
  "status",
  "version",
  "location",
  "activeSlots",
  "maxSlots",
  "capabilities",
  "currentJobIds",
  "lastHeartbeatAt",
  "diskFreeBytes",
] as const;

const mapWorker = (value: unknown, operation: string, path: string): WorkerNode => {
  const item = asObject(value, operation, path, workerKeys);
  const serverId = readEntityId(item, "id", operation, path);
  const workerNodeId = readEntityId(item, "workerNodeId", operation, path);
  const instanceId = readEntityId(item, "instanceId", operation, path);
  const displayName = readString(item, "displayName", operation, path, 1, 128);
  const status = readEnum(item, "status", operation, path, workerStates);
  const version = readString(item, "version", operation, path, 1, 128);
  const location = readNullableString(item, "location", operation, path);
  const activeSlots = readInteger(item, "activeSlots", operation, path, 0);
  const maxSlots = readInteger(item, "maxSlots", operation, path, 1);
  if (activeSlots > maxSlots) {
    fail(operation, `${path}.activeSlots`, "a value no greater than maxSlots");
  }
  const capabilities = readStringArray(item, "capabilities", operation, path, 512);
  const currentJobs = readStringArray(item, "currentJobIds", operation, path, 64, {
    entityIds: true,
  });
  const lastHeartbeatAt = readDateTime(item, "lastHeartbeatAt", operation, path);
  const diskFreeBytes = readInteger(item, "diskFreeBytes", operation, path, 0);

  return {
    id: workerNodeId,
    serverId,
    displayName,
    instanceId,
    status,
    version,
    location: location ?? "Unspecified",
    activeSlots,
    maxSlots,
    capabilities,
    currentJobs,
    lastHeartbeatAt,
    diskFreeGb: Math.round((diskFreeBytes / 1_073_741_824) * 10) / 10,
  };
};

const workerCredentialKeys = [
  "workerNodeId",
  "displayName",
  "authState",
  "createdAt",
  "activatedAt",
  "rotatedAt",
  "revokedAt",
  "updatedAt",
] as const;

const mapWorkerCredential = (value: unknown, operation: string, path: string): WorkerCredential => {
  const item = asObject(value, operation, path, workerCredentialKeys);
  const workerNodeId = readEntityId(item, "workerNodeId", operation, path);
  const displayName = readString(item, "displayName", operation, path, 1, 512);
  if (
    workerTokenExposurePattern.test(workerNodeId) ||
    workerTokenExposurePattern.test(displayName)
  ) {
    fail(operation, path, "a credential record without secret material");
  }
  return {
    workerNodeId,
    displayName,
    authState: readEnum(item, "authState", operation, path, workerCredentialAuthStates),
    createdAt: readDateTime(item, "createdAt", operation, path),
    activatedAt: readNullableDateTime(item, "activatedAt", operation, path),
    rotatedAt: readNullableDateTime(item, "rotatedAt", operation, path),
    revokedAt: readNullableDateTime(item, "revokedAt", operation, path),
    updatedAt: readDateTime(item, "updatedAt", operation, path),
  };
};

const healthKeys = ["id", "name", "status", "summary", "checkedAt"] as const;

const mapHealth = (value: unknown, operation: string, path: string): HealthComponent => {
  const item = asObject(value, operation, path, healthKeys);
  return {
    id: readEntityId(item, "id", operation, path),
    name: readString(item, "name", operation, path, 1, 128),
    status: readEnum(item, "status", operation, path, healthStates),
    summary: readString(item, "summary", operation, path, 1, 2_048),
    checkedAt: readDateTime(item, "checkedAt", operation, path),
  };
};

const systemKeys = [
  "serverVersion",
  "protocolVersion",
  "nodeVersion",
  "sqliteVersion",
  "databaseSizeBytes",
  "oldestQueuedAt",
  "oldestAwaitingAdmissionAt",
  "queuedJobs",
  "awaitingAdmissionJobs",
  "pendingValidationRequests",
  "activeWorkers",
  "activeLeases",
  "pendingApprovals",
  "health",
] as const;

export const mapSystemSnapshotResponse = (
  value: unknown,
  operation = "getSystemSnapshot",
): SystemSnapshot => {
  const item = asObject(value, operation, "$", systemKeys);
  const databaseSizeBytes = readInteger(item, "databaseSizeBytes", operation, "$", 0);
  const oldestQueuedAt = readNullableDateTime(item, "oldestQueuedAt", operation, "$");
  const oldestAwaitingAdmissionAt = readNullableDateTime(
    item,
    "oldestAwaitingAdmissionAt",
    operation,
    "$",
  );
  const queuedJobs = readInteger(item, "queuedJobs", operation, "$", 0);
  const awaitingAdmissionJobs = readInteger(item, "awaitingAdmissionJobs", operation, "$", 0);
  if (
    (queuedJobs === 0) !== (oldestQueuedAt === null) ||
    (awaitingAdmissionJobs === 0) !== (oldestAwaitingAdmissionAt === null)
  )
    fail(operation, "$", "waiting counts with matching oldest timestamps");
  const health = item.health;
  if (!Array.isArray(health) || health.length > 128) {
    fail(operation, "$.health", "an array with at most 128 items");
  }
  const healthItems = health as unknown[];

  return {
    serverVersion: readString(item, "serverVersion", operation, "$", 1, 128),
    protocolVersion: readString(item, "protocolVersion", operation, "$", 1, 128),
    nodeVersion: readString(item, "nodeVersion", operation, "$", 1, 128),
    sqliteVersion: readString(item, "sqliteVersion", operation, "$", 1, 128),
    databaseSizeMb: databaseSizeBytes / 1_048_576,
    ...(oldestQueuedAt === null ? {} : { oldestQueuedAt }),
    ...(oldestAwaitingAdmissionAt === null ? {} : { oldestAwaitingAdmissionAt }),
    queuedJobs,
    awaitingAdmissionJobs,
    pendingValidationRequests: readInteger(item, "pendingValidationRequests", operation, "$", 0),
    activeWorkers: readInteger(item, "activeWorkers", operation, "$", 0),
    activeLeases: readInteger(item, "activeLeases", operation, "$", 0),
    pendingApprovals: readInteger(item, "pendingApprovals", operation, "$", 0),
    health: healthItems.map((entry, index) => mapHealth(entry, operation, `$.health[${index}]`)),
  };
};

const mapPage = <TValue>(
  value: unknown,
  operation: string,
  mapper: (item: unknown, operation: string, path: string) => TValue,
): PageResult<TValue> => {
  const result = asObject(value, operation, "$", ["items", "total"]);
  const items = result.items;
  if (!Array.isArray(items)) {
    fail(operation, "$.items", "an array");
  }
  const pageItems = items as unknown[];
  const total = readInteger(result, "total", operation, "$", 0);
  if (total < pageItems.length) {
    fail(operation, "$.total", "a value no smaller than the returned item count");
  }
  return {
    items: pageItems.map((item, index) => mapper(item, operation, `$.items[${index}]`)),
    total,
  };
};

export const mapWorkItemListResponse = (
  value: unknown,
  operation = "listWorkItems",
): PageResult<WorkItem> => mapPage(value, operation, mapWorkItem);

export const mapJobListResponse = (value: unknown, operation = "listJobs"): PageResult<Job> =>
  mapPage(value, operation, mapJob);

export const mapJobDetailsResponse = (value: unknown, operation = "getJob"): JobDetails =>
  mapJobDetails(value, operation);

export const mapWorkerListResponse = (
  value: unknown,
  operation = "listWorkers",
): PageResult<WorkerNode> => mapPage(value, operation, mapWorker);

export const mapWorkerCredentialListResponse = (
  value: unknown,
  operation = "listWorkerCredentials",
): PageResult<WorkerCredential> => {
  const result = mapPage(value, operation, mapWorkerCredential);
  if (result.items.length > 200) {
    fail(operation, "$.items", "an array with at most 200 items");
  }
  return result;
};

const mapWorkerCredentialSecret = (value: unknown, operation: string): WorkerCredentialSecret => {
  const result = asObject(value, operation, "$", ["workerNodeId", "authState", "token"]);
  return {
    workerNodeId: readString(result, "workerNodeId", operation, "$", 43, 43, workerNodeIdPattern),
    authState: readEnum(result, "authState", operation, "$", {
      active: true,
      pending: true,
    }),
    token: readString(result, "token", operation, "$", 48, 48, workerTokenPattern),
  };
};

export const mapCreatedWorkerCredentialResponse = (
  value: unknown,
  operation = "createWorkerCredential",
): WorkerCredentialSecret => {
  const result = mapWorkerCredentialSecret(value, operation);
  if (result.authState !== "pending") {
    fail(operation, "$.authState", "pending");
  }
  return result;
};

export const mapRotatedWorkerCredentialResponse = (
  value: unknown,
  operation = "rotateWorkerToken",
): WorkerCredentialSecret => mapWorkerCredentialSecret(value, operation);

export const mapRevokedWorkerCredentialResponse = (
  value: unknown,
  operation = "revokeWorkerToken",
): WorkerCredentialRevocation => {
  const result = asObject(value, operation, "$", ["workerNodeId", "authState"]);
  return {
    workerNodeId: readString(result, "workerNodeId", operation, "$", 43, 43, workerNodeIdPattern),
    authState: readEnum(result, "authState", operation, "$", { revoked: true }),
  };
};
