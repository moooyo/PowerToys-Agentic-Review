import type {
  AuthorizationDecisionReason,
  DashboardAuthorization,
  DashboardJobOutcome,
  DashboardWorkItemFreshness,
  DashboardWorkItemPriority,
  DashboardWorkItemStage,
  ExecutionPhase,
  GitHubAccountType,
  GitHubWorkItemKind,
  JobState,
  SchedulingRequestKind,
  WorkerState,
  WorkItemState,
} from "@agentic-review/contracts";
import { ReviewControlProtocolError } from "./errors";
import type {
  HealthComponent,
  Job,
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

const workerStates = {
  disabled: true,
  draining: true,
  offline: true,
  online: true,
} satisfies Record<WorkerState, true>;

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

const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const workerNodeIdPattern =
  /^worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const workerTokenExposurePattern = /arw1_[A-Za-z0-9_-]{43}/u;
const workerTokenPattern = /^arw1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const gitObjectIdPattern = /^[a-f0-9]{40,64}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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
): number => {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail(operation, `${path}.${key}`, `an integer greater than or equal to ${minimum}`);
  }
  return value as number;
};

const readNullableInteger = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  minimum: number,
): number | null => {
  if (object[key] === null) {
    return null;
  }
  return readInteger(object, key, operation, path, minimum);
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

const readStringArray = (
  object: JsonObject,
  key: string,
  operation: string,
  path: string,
  maximumItems: number,
  entityIds = false,
): string[] => {
  const value = object[key];
  if (!Array.isArray(value) || value.length > maximumItems) {
    return fail(operation, `${path}.${key}`, `an array with at most ${maximumItems} items`);
  }
  const result = value.map((item, index) => {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      item.length > 128 ||
      (entityIds && !entityIdPattern.test(item))
    ) {
      return fail(operation, `${path}.${key}[${index}]`, "a valid string");
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    return fail(operation, `${path}.${key}`, "an array of unique strings");
  }
  return result;
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
  const revisionKey = readString(
    revision,
    "revisionKey",
    operation,
    path,
    kind === "issue" ? 64 : 40,
    64,
    kind === "issue" ? sha256Pattern : gitObjectIdPattern,
  );

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

const validateRequestEpoch = (value: unknown, operation: string, path: string): void => {
  if (value === null) {
    return;
  }
  const epoch = asObject(value, operation, path, requestEpochKeys);
  readEntityId(epoch, "requestEpochId", operation, path);
  readEnum(epoch, "requestKind", operation, path, schedulingRequestKinds);
  readInteger(epoch, "sequence", operation, path, 1);
  const status = readEnum(epoch, "status", operation, path, { active: true, closed: true });
  readEnum(epoch, "authorization", operation, path, { allowlisted: true, self: true });
  readDateTime(epoch, "openedAt", operation, path);
  const closedAt = readNullableDateTime(epoch, "closedAt", operation, path);
  if ((status === "active" && closedAt !== null) || (status === "closed" && closedAt === null)) {
    fail(operation, `${path}.closedAt`, `a value consistent with status ${status}`);
  }
};

const workItemKeys = [
  "id",
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
  "workerNodeId",
  "attentionReason",
  "updatedAt",
] as const;

const mapWorkItem = (value: unknown, operation: string, path: string): WorkItem => {
  const item = asObject(value, operation, path, workItemKeys);
  const id = readEntityId(item, "id", operation, path);
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
  readEnum(item, "state", operation, path, workItemStates);
  const stage = readEnum(item, "stage", operation, path, workItemStages);
  const freshness = readEnum(item, "freshness", operation, path, freshnessValues);
  const revision = readRevision(item.currentRevision, operation, `${path}.currentRevision`);
  if (revision.kind !== kind) {
    fail(operation, `${path}.currentRevision.kind`, `the work item kind ${kind}`);
  }
  const reviewedRevisionKey = readNullableString(item, "reviewedRevisionKey", operation, path);
  validateRequestEpoch(item.activeRequestEpoch, operation, `${path}.activeRequestEpoch`);
  readNullableEntityId(item, "latestJobId", operation, path);
  readNullableEnum(item, "latestJobStatus", operation, path, jobStates);
  const workerNodeId = readNullableEntityId(item, "workerNodeId", operation, path);
  const attentionReason = readNullableString(item, "attentionReason", operation, path);
  const updatedAt = readDateTime(item, "updatedAt", operation, path);

  return {
    id,
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
    stage,
    freshness,
    ...(revision.headSha === undefined ? {} : { headSha: revision.headSha }),
    ...(reviewedRevisionKey === null ? {} : { reviewedSha: reviewedRevisionKey }),
    ...(workerNodeId === null ? {} : { workerNodeId }),
    ...(attentionReason === null ? {} : { attentionReason }),
    updatedAt,
  };
};

const jobKeys = [
  "id",
  "workItemId",
  "workItemRef",
  "title",
  "generation",
  "status",
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
): JobStage => {
  switch (status) {
    case "queued":
    case "retry_waiting":
      return "queued";
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
  const workItemId = readEntityId(item, "workItemId", operation, path);
  const workItemRef = readString(item, "workItemRef", operation, path, 1, 256);
  const title = readString(item, "title", operation, path, 1, 256);
  const generation = readInteger(item, "generation", operation, path, 1);
  const status = readEnum(item, "status", operation, path, jobStates);
  const phase = readNullableEnum(item, "phase", operation, path, executionPhases);
  const attempt = readInteger(item, "attempt", operation, path, 0);
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
    workItemId,
    workItemRef,
    title,
    generation,
    status,
    stage: mapJobStage(status, phase, operation, path),
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
  const currentJobs = readStringArray(item, "currentJobIds", operation, path, 64, true);
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
