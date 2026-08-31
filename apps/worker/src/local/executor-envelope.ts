import type { JobExecutionEnvelope } from "@agentic-review/contracts";
import { JobExecutionEnvelopeSchema } from "@agentic-review/contracts";
import {
  createCanonicalJsonDocument,
  type DeepReadonly,
  deepFreezeJson,
  digestExecutorJobEnvelope,
  type ExecutorJobEnvelopeV1,
  LOCAL_SNAPSHOT_PROJECTION_VERSION,
  LOCAL_SNAPSHOT_TRUNCATION_MARKER,
  LOCAL_START_ENVELOPE_MAXIMUM_UTF8_BYTES,
  LOCAL_START_PROMPT_MAXIMUM_UTF8_BYTES,
  LOCAL_START_SCHEMA_MAXIMUM_UTF8_BYTES,
  LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES,
  type LocalSnapshotProjectionV1,
  serializeCanonicalJson,
  sha256Hex,
} from "@agentic-review/local-protocol";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export type { DeepReadonly, LocalSnapshotProjectionV1 } from "@agentic-review/local-protocol";

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const localPriorityMinimum = -1_000_000;
const localPriorityMaximum = 1_000_000;
const localTimeoutMinimumMs = 1_000;
const localTimeoutMaximumMs = 86_400_000;
const localMaxCodexTurnsMinimum = 1;
const localMaxCodexTurnsMaximum = 128;
const localRepositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const localRecipeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const localCapabilityLabelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const serverPromptTruncationMetadataPattern =
  /\[UNTRUSTED_BODY_TRUNCATED originalUtf16Length=(?:0|[1-9][0-9]*) originalUtf8Bytes=(?:0|[1-9][0-9]*) sha256=[a-f0-9]{64}\]/gu;
const localPromptTruncationMarker = LOCAL_SNAPSHOT_TRUNCATION_MARKER.slice(1);

export type SanitizedExecutorJobEnvelopeV1 = DeepReadonly<ExecutorJobEnvelopeV1>;

export type LocalSnapshotProjectionBodyV1 = LocalSnapshotProjectionV1["body"];

declare const preparedLocalExecutionStartBrand: unique symbol;
const preparedLocalExecutionStarts = new WeakSet<object>();

export interface PreparedLocalExecutionStart {
  readonly attemptCorrelationId: string;
  readonly authorityBasis: DeepReadonly<LocalExecutionAuthorityBasis>;
  readonly executorEnvelope: SanitizedExecutorJobEnvelopeV1;
  readonly [preparedLocalExecutionStartBrand]: true;
}

export function isPreparedLocalExecutionStart(
  value: unknown,
): value is PreparedLocalExecutionStart {
  return typeof value === "object" && value !== null && preparedLocalExecutionStarts.has(value);
}

export interface LocalExecutionClaimTiming {
  readonly observedAtMonotonicMilliseconds: number;
  readonly remainingLeaseMilliseconds: number;
  readonly remainingHardDeadlineMilliseconds: number;
}

export interface LocalExecutionAuthorityBasis {
  readonly authorityBasisVersion: 2;
  readonly workerNodeId: string;
  readonly workerInstanceId: string;
  readonly leaseGeneration: number;
  readonly observedAtMonotonicMilliseconds: number;
  readonly remainingLeaseMilliseconds: number;
  readonly remainingHardDeadlineMilliseconds: number;
}

export type LocalExecutionBoundaryErrorCode =
  | "ATTEMPT_CORRELATION_ID_INVALID"
  | "SERVER_ENVELOPE_INVALID"
  | "JOB_ID_MISMATCH"
  | "JOB_RESOURCE_KIND_MISMATCH"
  | "SNAPSHOT_IDENTITY_MISMATCH"
  | "ATTEMPT_COUNT_INVALID"
  | "LEASE_GENERATION_INVALID"
  | "LEASE_TIME_INVALID"
  | "POLICY_TIMEOUT_INCONSISTENT"
  | "LOCAL_PRIORITY_OUT_OF_RANGE"
  | "LOCAL_HARD_TIMEOUT_OUT_OF_RANGE"
  | "LOCAL_NO_PROGRESS_TIMEOUT_OUT_OF_RANGE"
  | "LOCAL_MAX_CODEX_TURNS_OUT_OF_RANGE"
  | "LOCAL_REPOSITORY_INVALID"
  | "LOCAL_RECIPE_ID_INVALID"
  | "LOCAL_CAPABILITY_LABEL_INVALID"
  | "CANONICAL_VALUE_INVALID"
  | "PROMPT_DIGEST_MISMATCH"
  | "OUTPUT_SCHEMA_DIGEST_MISMATCH"
  | "PROMPT_LIMIT_EXCEEDED"
  | "OUTPUT_SCHEMA_LIMIT_EXCEEDED"
  | "SNAPSHOT_PROJECTION_LIMIT_EXCEEDED"
  | "ENVELOPE_LIMIT_EXCEEDED"
  | "LOCAL_PROTOCOL_SCHEMA_INVALID";

export class LocalExecutionBoundaryError extends Error {
  public constructor(
    public readonly code: LocalExecutionBoundaryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalExecutionBoundaryError";
  }
}

interface SnapshotCandidate {
  readonly document: Readonly<{ readonly json: string; readonly sha256: string }>;
  readonly envelope: ExecutorJobEnvelopeV1;
  readonly envelopeJson: string;
}

registerContractFormats();

/** Creates the only value that Control may submit to a local execution broker. */
export function prepareLocalExecutionStart(
  serverEnvelope: JobExecutionEnvelope,
  attemptCorrelationId: string,
  timing: LocalExecutionClaimTiming,
): PreparedLocalExecutionStart {
  const executorEnvelope = createExecutorJobEnvelopeV1(serverEnvelope, attemptCorrelationId);
  const authorityBasis = createAuthorityBasis(serverEnvelope, timing);
  const prepared = deepFreezeJson({
    attemptCorrelationId,
    authorityBasis,
    executorEnvelope,
  }) as PreparedLocalExecutionStart;
  preparedLocalExecutionStarts.add(prepared);
  return prepared;
}

function createAuthorityBasis(
  envelope: JobExecutionEnvelope,
  timing: LocalExecutionClaimTiming,
): LocalExecutionAuthorityBasis {
  if (!Number.isSafeInteger(envelope.lease.leaseGeneration) || envelope.lease.leaseGeneration < 1) {
    throw boundaryError(
      "LEASE_GENERATION_INVALID",
      "Server lease generation is not a safe positive integer.",
    );
  }
  const assignedAtUnixMs = parseServerTimestamp(envelope.assignedAt, "assignedAt");
  const serverLeaseExpiresAtUnixMs = parseServerTimestamp(
    envelope.leaseExpiresAt,
    "leaseExpiresAt",
  );
  const hardDeadlineUnixMs = parseServerTimestamp(
    envelope.executionDeadlineAt,
    "executionDeadlineAt",
  );
  if (
    assignedAtUnixMs >= serverLeaseExpiresAtUnixMs ||
    assignedAtUnixMs >= hardDeadlineUnixMs ||
    serverLeaseExpiresAtUnixMs > hardDeadlineUnixMs
  ) {
    throw boundaryError(
      "LEASE_TIME_INVALID",
      "Server lease and execution deadline timestamps are inconsistent.",
    );
  }
  let observedAtMonotonicMilliseconds: number;
  let remainingLeaseMilliseconds: number;
  let remainingHardDeadlineMilliseconds: number;
  try {
    observedAtMonotonicMilliseconds = normalizeLocalMonotonicObservationMilliseconds(
      timing.observedAtMonotonicMilliseconds,
    );
    remainingLeaseMilliseconds = normalizeLocalRemainingBudgetMilliseconds(
      timing.remainingLeaseMilliseconds,
    );
    remainingHardDeadlineMilliseconds = normalizeLocalRemainingBudgetMilliseconds(
      timing.remainingHardDeadlineMilliseconds,
    );
  } catch (error) {
    throw boundaryError(
      "LEASE_TIME_INVALID",
      "Conservative local lease and hard-deadline timing evidence is invalid.",
      error,
    );
  }
  if (
    remainingLeaseMilliseconds > remainingHardDeadlineMilliseconds ||
    remainingLeaseMilliseconds > serverLeaseExpiresAtUnixMs - assignedAtUnixMs ||
    remainingHardDeadlineMilliseconds > hardDeadlineUnixMs - assignedAtUnixMs ||
    remainingHardDeadlineMilliseconds > envelope.executionPolicy.hardTimeoutMs
  ) {
    throw boundaryError(
      "LEASE_TIME_INVALID",
      "Conservative local lease and hard-deadline timing evidence is invalid.",
    );
  }
  return {
    authorityBasisVersion: 2,
    workerNodeId: envelope.lease.workerNodeId,
    workerInstanceId: envelope.lease.workerInstanceId,
    leaseGeneration: envelope.lease.leaseGeneration,
    observedAtMonotonicMilliseconds,
    remainingLeaseMilliseconds,
    remainingHardDeadlineMilliseconds,
  };
}

export function normalizeLocalMonotonicObservationMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Monotonic observation is outside the supported range.");
  }
  const normalized = Math.floor(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new RangeError("Monotonic observation is outside the supported range.");
  }
  return normalized;
}

export function normalizeLocalRemainingBudgetMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Remaining monotonic budget is outside the supported range.");
  }
  const normalized = Math.floor(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new RangeError("Remaining monotonic budget is outside the supported range.");
  }
  return normalized;
}

function parseServerTimestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw boundaryError("LEASE_TIME_INVALID", `Server ${name} is not a supported timestamp.`);
  }
  return parsed;
}

/**
 * Creates the only job envelope that may cross from Control to Executor.
 *
 * The correlation ID remains message metadata and is intentionally absent from the returned
 * envelope. Requiring it here prevents callers from substituting a Server entity ID for the
 * protocol's independent canonical UUID v4 correlation identity.
 */
function createExecutorJobEnvelopeV1(
  serverEnvelope: JobExecutionEnvelope,
  attemptCorrelationId: string,
): SanitizedExecutorJobEnvelopeV1 {
  assertAttemptCorrelationId(attemptCorrelationId);
  assertLocalProtocolBounds(serverEnvelope);
  assertCompleteServerEnvelope(serverEnvelope);
  assertIndependentAttemptCorrelationId(attemptCorrelationId, serverEnvelope);
  assertServerEnvelopeConsistency(serverEnvelope);

  const originalSnapshotJson = canonicalJson(
    serverEnvelope.resource.canonicalSnapshot,
    "canonical snapshot",
  );
  const normalizedSnapshot = JSON.parse(originalSnapshotJson) as unknown;
  assertSnapshotIdentity(serverEnvelope, normalizedSnapshot);

  const outputSchema = canonicalDocument(serverEnvelope.prompt.outputSchema, "output schema");
  assertUtf8Limit(
    outputSchema.json,
    LOCAL_START_SCHEMA_MAXIMUM_UTF8_BYTES,
    "OUTPUT_SCHEMA_LIMIT_EXCEEDED",
    "Output schema",
  );

  const serverPromptSha256 = sha256Hex(serverEnvelope.prompt.renderedPrompt);
  if (serverPromptSha256 !== serverEnvelope.prompt.promptSha256) {
    throw boundaryError(
      "PROMPT_DIGEST_MISMATCH",
      "Rendered prompt digest does not match the Server envelope.",
    );
  }
  if (outputSchema.sha256 !== serverEnvelope.prompt.outputSchemaSha256) {
    throw boundaryError(
      "OUTPUT_SCHEMA_DIGEST_MISMATCH",
      "Output schema digest does not match the Server envelope.",
    );
  }
  assertUtf8Limit(
    serverEnvelope.prompt.renderedPrompt,
    LOCAL_START_PROMPT_MAXIMUM_UTF8_BYTES,
    "PROMPT_LIMIT_EXCEEDED",
    "Rendered prompt",
  );
  const renderedPrompt = sanitizeRenderedPrompt(serverEnvelope.prompt.renderedPrompt);
  const promptSha256 = sha256Hex(renderedPrompt);

  const candidateFactory = (body: LocalSnapshotProjectionBodyV1): SnapshotCandidate => {
    const projection = createSnapshotProjection(serverEnvelope, attemptCorrelationId, body);
    const document = canonicalDocument(projection, "snapshot projection");
    const envelope = buildExecutorEnvelope(
      serverEnvelope,
      attemptCorrelationId,
      document,
      outputSchema,
      renderedPrompt,
      promptSha256,
    );
    let envelopeJson: string;
    try {
      envelopeJson = serializeCanonicalJson(envelope);
    } catch (error) {
      throw boundaryError(
        "LOCAL_PROTOCOL_SCHEMA_INVALID",
        "Executor job envelope cannot be represented by the local canonical protocol.",
        error,
      );
    }
    return { document, envelope, envelopeJson };
  };

  const selected = selectSnapshotProjection(normalizedSnapshot, candidateFactory);
  try {
    digestExecutorJobEnvelope(selected.envelope);
  } catch (error) {
    throw boundaryError(
      "LOCAL_PROTOCOL_SCHEMA_INVALID",
      "Executor job envelope does not satisfy the local protocol schema.",
      error,
    );
  }
  return deepFreezeJson(selected.envelope);
}

function selectSnapshotProjection(
  normalizedSnapshot: unknown,
  createCandidate: (body: LocalSnapshotProjectionBodyV1) => SnapshotCandidate,
): SnapshotCandidate {
  const snapshotRecord = asRecord(normalizedSnapshot);
  if (snapshotRecord === undefined || !Object.hasOwn(snapshotRecord, "body")) {
    return requireCandidateFits(createCandidate({ state: "absent" }));
  }

  const body = snapshotRecord.body;
  if (body === null) {
    return requireCandidateFits(createCandidate({ state: "null" }));
  }
  if (typeof body !== "string") {
    throw boundaryError(
      "SERVER_ENVELOPE_INVALID",
      "Canonical snapshot body must be a string or null when present.",
    );
  }

  const completeCandidate = createCandidate({
    state: "complete",
    text: body,
  });
  if (candidateFits(completeCandidate)) {
    return completeCandidate;
  }

  const truncatedCandidate = (end: number): SnapshotCandidate =>
    createCandidate({
      state: "truncated",
      text: `${body.slice(0, end)}${LOCAL_SNAPSHOT_TRUNCATION_MARKER}`,
    });
  const boundaries = unicodeCodePointBoundaries(body);
  let selected = requireCandidateFits(truncatedCandidate(0));
  let lower = 1;
  let upper = boundaries.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const boundary = boundaries[middle];
    if (boundary === undefined) {
      throw boundaryError(
        "CANONICAL_VALUE_INVALID",
        "Unable to select a Unicode-safe snapshot body boundary.",
      );
    }
    const candidate = truncatedCandidate(boundary);
    if (candidateFits(candidate)) {
      selected = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return selected;
}

function createSnapshotProjection(
  envelope: JobExecutionEnvelope,
  attemptCorrelationId: string,
  body: LocalSnapshotProjectionBodyV1,
): LocalSnapshotProjectionV1 {
  const actor = createLocalActor(envelope.resource.author);
  const repository = {
    githubRepositoryId: envelope.repository.githubRepositoryId,
    fullName: envelope.repository.fullName,
  };
  const resourceIdentity = {
    githubNodeId: envelope.resource.githubNodeId,
    number: envelope.resource.number,
    title: envelope.resource.title,
    author: actor,
  };
  const common = {
    projectionVersion: LOCAL_SNAPSHOT_PROJECTION_VERSION,
    repository,
    body,
  };
  return envelope.resource.kind === "issue"
    ? {
        ...common,
        resource: {
          ...resourceIdentity,
          kind: "issue",
          revision: {
            kind: "issue",
            revisionDigest: createLocalIssueRevisionBinding(
              envelope.job.jobId,
              envelope.lease.runAttemptId,
              attemptCorrelationId,
            ),
          },
        },
      }
    : {
        ...common,
        resource: {
          ...resourceIdentity,
          kind: "pull_request",
          revision: {
            kind: "pull_request",
            baseSha: envelope.resource.baseSha,
            headSha: envelope.resource.headSha,
          },
        },
      };
}

function buildExecutorEnvelope(
  serverEnvelope: JobExecutionEnvelope,
  attemptCorrelationId: string,
  snapshot: Readonly<{ readonly json: string; readonly sha256: string }>,
  outputSchema: Readonly<{ readonly json: string; readonly sha256: string }>,
  renderedPrompt: string,
  promptSha256: string,
): ExecutorJobEnvelopeV1 {
  const resource: ExecutorJobEnvelopeV1["resource"] =
    serverEnvelope.resource.kind === "issue"
      ? {
          kind: "issue",
          githubNodeId: serverEnvelope.resource.githubNodeId,
          number: serverEnvelope.resource.number,
          title: serverEnvelope.resource.title,
          author: createLocalActor(serverEnvelope.resource.author),
          canonicalSnapshotJson: snapshot.json,
          canonicalSnapshotSha256: snapshot.sha256,
          revisionDigest: createLocalIssueRevisionBinding(
            serverEnvelope.job.jobId,
            serverEnvelope.lease.runAttemptId,
            attemptCorrelationId,
          ),
        }
      : {
          kind: "pull_request",
          githubNodeId: serverEnvelope.resource.githubNodeId,
          number: serverEnvelope.resource.number,
          title: serverEnvelope.resource.title,
          author: createLocalActor(serverEnvelope.resource.author),
          canonicalSnapshotJson: snapshot.json,
          canonicalSnapshotSha256: snapshot.sha256,
          baseSha: serverEnvelope.resource.baseSha,
          headSha: serverEnvelope.resource.headSha,
          isDraft: serverEnvelope.resource.isDraft,
        };

  // Every property is selected explicitly. No lease, Server time, URL, credential, or
  // Authorization-bearing property is spread into this value.
  return {
    envelopeVersion: 1,
    jobId: serverEnvelope.job.jobId,
    runAttemptId: serverEnvelope.lease.runAttemptId,
    jobKind: serverEnvelope.job.kind,
    priority: serverEnvelope.job.priority,
    attempt: serverEnvelope.job.attempt,
    maxAttempts: serverEnvelope.job.maxAttempts,
    generation: serverEnvelope.job.generation,
    intentVersion: serverEnvelope.job.intentVersion,
    semanticKey: serverEnvelope.job.semanticKey,
    repository: {
      githubRepositoryId: serverEnvelope.repository.githubRepositoryId,
      fullName: serverEnvelope.repository.fullName,
    },
    resource,
    prompt: {
      name: serverEnvelope.prompt.name,
      version: serverEnvelope.prompt.version,
      renderedPrompt,
      promptSha256,
      outputSchemaJson: outputSchema.json,
      outputSchemaSha256: outputSchema.sha256,
    },
    policy: {
      hardTimeoutMs: serverEnvelope.executionPolicy.hardTimeoutMs,
      noProgressTimeoutMs: serverEnvelope.executionPolicy.noProgressTimeoutMs,
      maxCodexTurns: serverEnvelope.executionPolicy.maxCodexTurns,
      allowedRecipeIds: [...serverEnvelope.executionPolicy.allowedRecipeIds],
      requiredCapabilityLabels: Object.fromEntries(
        Object.entries(serverEnvelope.executionPolicy.requiredCapabilityLabels),
      ),
    },
  };
}

function createLocalActor(
  actor: JobExecutionEnvelope["resource"]["author"],
): ExecutorJobEnvelopeV1["resource"]["author"] {
  return {
    githubUserId: actor.githubUserId,
    login: actor.login,
    accountType: actor.accountType ?? null,
    githubNodeId: actor.githubNodeId ?? null,
  };
}

function createLocalIssueRevisionBinding(
  jobId: string,
  runAttemptId: string,
  attemptCorrelationId: string,
): string {
  return sha256Hex(
    `AgenticReview.LocalIssueRevisionBindingV1\u0000${jobId}\u0000${runAttemptId}\u0000${attemptCorrelationId}`,
  );
}

function assertAttemptCorrelationId(value: string): void {
  if (!uuidV4Pattern.test(value)) {
    throw boundaryError(
      "ATTEMPT_CORRELATION_ID_INVALID",
      "attemptCorrelationId must be an independent canonical lowercase UUID v4.",
    );
  }
}

function assertIndependentAttemptCorrelationId(
  value: string,
  envelope: JobExecutionEnvelope,
): void {
  const serverIdentities = [
    envelope.job.jobId,
    envelope.lease.runAttemptId,
    envelope.lease.workerNodeId,
    envelope.lease.workerInstanceId,
    envelope.lease.leaseToken,
  ];
  if (serverIdentities.includes(value)) {
    throw boundaryError(
      "ATTEMPT_CORRELATION_ID_INVALID",
      "attemptCorrelationId must not reuse a Server or Worker entity identity.",
    );
  }
}

function assertCompleteServerEnvelope(value: JobExecutionEnvelope): void {
  try {
    if (Value.Check(JobExecutionEnvelopeSchema, value)) {
      return;
    }
    const firstError = Value.Errors(JobExecutionEnvelopeSchema, value).First();
    const path = firstError?.path === undefined || firstError.path === "" ? "/" : firstError.path;
    const detail = firstError?.message ?? "unknown schema violation";
    throw boundaryError(
      "SERVER_ENVELOPE_INVALID",
      `Server job envelope failed schema validation at ${path}: ${detail}`,
    );
  } catch (error) {
    if (error instanceof LocalExecutionBoundaryError) {
      throw error;
    }
    throw boundaryError(
      "SERVER_ENVELOPE_INVALID",
      "Server job envelope could not be validated.",
      error,
    );
  }
}

function assertServerEnvelopeConsistency(envelope: JobExecutionEnvelope): void {
  if (envelope.job.jobId !== envelope.lease.jobId) {
    throw boundaryError("JOB_ID_MISMATCH", "Job identity does not match the leased job identity.");
  }
  if (envelope.job.attempt > envelope.job.maxAttempts) {
    throw boundaryError("ATTEMPT_COUNT_INVALID", "Job attempt exceeds maxAttempts.");
  }
  if (envelope.executionPolicy.noProgressTimeoutMs > envelope.executionPolicy.hardTimeoutMs) {
    throw boundaryError(
      "POLICY_TIMEOUT_INCONSISTENT",
      "Execution policy no-progress timeout exceeds its hard timeout.",
    );
  }
  if (
    (envelope.job.kind === "issue_triage" && envelope.resource.kind !== "issue") ||
    (envelope.job.kind === "pull_request_review" && envelope.resource.kind !== "pull_request")
  ) {
    throw boundaryError(
      "JOB_RESOURCE_KIND_MISMATCH",
      "Job kind and resource kind are inconsistent.",
    );
  }
}

function assertLocalProtocolBounds(value: unknown): void {
  const envelope = asRecord(value);
  const job = asRecord(envelope?.job);
  const policy = asRecord(envelope?.executionPolicy);
  const lease = asRecord(envelope?.lease);
  const repository = asRecord(envelope?.repository);
  const priority = job?.priority;
  const leaseGeneration = lease?.leaseGeneration;
  if (
    typeof leaseGeneration === "number" &&
    (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1)
  ) {
    throw boundaryError(
      "LEASE_GENERATION_INVALID",
      "Server lease generation is not a safe positive integer.",
    );
  }
  if (
    typeof priority === "number" &&
    Number.isInteger(priority) &&
    (priority < localPriorityMinimum || priority > localPriorityMaximum)
  ) {
    throw boundaryError(
      "LOCAL_PRIORITY_OUT_OF_RANGE",
      "Job priority is outside the local protocol range.",
    );
  }
  const hardTimeoutMs = policy?.hardTimeoutMs;
  if (
    typeof hardTimeoutMs === "number" &&
    Number.isInteger(hardTimeoutMs) &&
    (hardTimeoutMs < localTimeoutMinimumMs || hardTimeoutMs > localTimeoutMaximumMs)
  ) {
    throw boundaryError(
      "LOCAL_HARD_TIMEOUT_OUT_OF_RANGE",
      "Execution hard timeout is outside the local protocol range.",
    );
  }
  const noProgressTimeoutMs = policy?.noProgressTimeoutMs;
  if (
    typeof noProgressTimeoutMs === "number" &&
    Number.isInteger(noProgressTimeoutMs) &&
    (noProgressTimeoutMs < localTimeoutMinimumMs || noProgressTimeoutMs > localTimeoutMaximumMs)
  ) {
    throw boundaryError(
      "LOCAL_NO_PROGRESS_TIMEOUT_OUT_OF_RANGE",
      "Execution no-progress timeout is outside the local protocol range.",
    );
  }
  const maxCodexTurns = policy?.maxCodexTurns;
  if (
    typeof maxCodexTurns === "number" &&
    Number.isInteger(maxCodexTurns) &&
    (maxCodexTurns < localMaxCodexTurnsMinimum || maxCodexTurns > localMaxCodexTurnsMaximum)
  ) {
    throw boundaryError(
      "LOCAL_MAX_CODEX_TURNS_OUT_OF_RANGE",
      "Execution maxCodexTurns is outside the local protocol range.",
    );
  }
  const fullName = repository?.fullName;
  if (typeof fullName === "string" && !localRepositoryPattern.test(fullName)) {
    throw boundaryError(
      "LOCAL_REPOSITORY_INVALID",
      "Repository full name is outside the local protocol identifier grammar.",
    );
  }
  const allowedRecipeIds = policy?.allowedRecipeIds;
  if (
    Array.isArray(allowedRecipeIds) &&
    allowedRecipeIds.some(
      (recipeId) => typeof recipeId === "string" && !localRecipeIdPattern.test(recipeId),
    )
  ) {
    throw boundaryError(
      "LOCAL_RECIPE_ID_INVALID",
      "Execution policy contains a recipe ID outside the local protocol grammar.",
    );
  }
  const requiredCapabilityLabels = asRecord(policy?.requiredCapabilityLabels);
  if (
    requiredCapabilityLabels !== undefined &&
    Object.keys(requiredCapabilityLabels).some((label) => !localCapabilityLabelPattern.test(label))
  ) {
    throw boundaryError(
      "LOCAL_CAPABILITY_LABEL_INVALID",
      "Execution policy contains a capability label outside the local protocol grammar.",
    );
  }
}

function assertSnapshotIdentity(envelope: JobExecutionEnvelope, snapshotValue: unknown): void {
  const snapshot = asRecord(snapshotValue);
  if (snapshot === undefined) {
    throw snapshotMismatch("Canonical snapshot must be an object.");
  }
  assertRequiredMatchingProperty(snapshot, "kind", envelope.resource.kind, "resource kind");
  assertRequiredMatchingProperty(
    snapshot,
    "githubRepositoryId",
    envelope.repository.githubRepositoryId,
    "repository ID",
  );
  assertRequiredMatchingProperty(
    snapshot,
    "githubNodeId",
    envelope.resource.githubNodeId,
    "resource node ID",
  );
  assertRequiredMatchingProperty(snapshot, "number", envelope.resource.number, "resource number");
  assertRequiredMatchingProperty(snapshot, "title", envelope.resource.title, "resource title");

  const snapshotAuthor = asRecord(snapshot.author);
  if (snapshotAuthor === undefined) {
    throw snapshotMismatch("Canonical snapshot author must be an object.");
  }
  assertRequiredMatchingProperty(
    snapshotAuthor,
    "githubUserId",
    envelope.resource.author.githubUserId,
    "author GitHub user ID",
  );
  assertRequiredMatchingProperty(
    snapshotAuthor,
    "login",
    envelope.resource.author.login,
    "author login",
  );

  if (Object.hasOwn(snapshot, "repository")) {
    const snapshotRepository = asRecord(snapshot.repository);
    if (snapshotRepository === undefined) {
      throw snapshotMismatch("Canonical snapshot repository must be an object when present.");
    }
    assertMatchingProperty(
      snapshotRepository,
      "githubRepositoryId",
      envelope.repository.githubRepositoryId,
      "repository ID",
    );
    assertMatchingProperty(
      snapshotRepository,
      "fullName",
      envelope.repository.fullName,
      "repository full name",
    );
  }
  assertMatchingProperty(
    snapshot,
    "repositoryFullName",
    envelope.repository.fullName,
    "repository full name",
  );

  if (envelope.resource.kind === "issue") {
    assertMatchingProperty(
      snapshot,
      "revisionDigest",
      envelope.resource.revisionDigest,
      "issue revision digest",
    );
    if (Object.hasOwn(snapshot, "baseSha") || Object.hasOwn(snapshot, "headSha")) {
      throw snapshotMismatch("Issue snapshot contains pull request revision fields.");
    }
    return;
  }

  assertMatchingProperty(snapshot, "baseSha", envelope.resource.baseSha, "base revision");
  assertMatchingProperty(snapshot, "headSha", envelope.resource.headSha, "head revision");
  if (Object.hasOwn(snapshot, "revisionDigest")) {
    throw snapshotMismatch("Pull request snapshot contains an issue revision field.");
  }
}

function assertMatchingProperty(
  record: Readonly<Record<string, unknown>>,
  property: string,
  expected: unknown,
  description: string,
): void {
  if (Object.hasOwn(record, property) && record[property] !== expected) {
    throw snapshotMismatch(`Canonical snapshot ${description} does not match the Server envelope.`);
  }
}

function assertRequiredMatchingProperty(
  record: Readonly<Record<string, unknown>>,
  property: string,
  expected: unknown,
  description: string,
): void {
  if (!Object.hasOwn(record, property) || record[property] !== expected) {
    throw snapshotMismatch(
      `Canonical snapshot ${description} is absent or does not match the Server envelope.`,
    );
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function canonicalDocument(
  value: unknown,
  description: string,
): Readonly<{ readonly json: string; readonly sha256: string }> {
  try {
    return createCanonicalJsonDocument(value);
  } catch (error) {
    throw boundaryError(
      "CANONICAL_VALUE_INVALID",
      `Server ${description} is not valid local canonical JSON data.`,
      error,
    );
  }
}

function canonicalJson(value: unknown, description: string): string {
  try {
    return serializeCanonicalJson(value);
  } catch (error) {
    throw boundaryError(
      "CANONICAL_VALUE_INVALID",
      `Server ${description} is not valid local canonical JSON data.`,
      error,
    );
  }
}

function sanitizeRenderedPrompt(value: string): string {
  return value.replace(serverPromptTruncationMetadataPattern, localPromptTruncationMarker);
}

function candidateFits(candidate: SnapshotCandidate): boolean {
  return (
    Buffer.byteLength(candidate.document.json, "utf8") <= LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES &&
    Buffer.byteLength(candidate.envelopeJson, "utf8") <= LOCAL_START_ENVELOPE_MAXIMUM_UTF8_BYTES
  );
}

function requireCandidateFits(candidate: SnapshotCandidate): SnapshotCandidate {
  if (
    Buffer.byteLength(candidate.document.json, "utf8") > LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES
  ) {
    throw boundaryError(
      "SNAPSHOT_PROJECTION_LIMIT_EXCEEDED",
      "Minimum canonical snapshot projection exceeds the local protocol byte limit.",
    );
  }
  if (Buffer.byteLength(candidate.envelopeJson, "utf8") > LOCAL_START_ENVELOPE_MAXIMUM_UTF8_BYTES) {
    throw boundaryError(
      "ENVELOPE_LIMIT_EXCEEDED",
      "Prompt, schema, and minimum snapshot projection exceed the local envelope byte limit.",
    );
  }
  return candidate;
}

function assertUtf8Limit(
  value: string,
  maximumBytes: number,
  code: "PROMPT_LIMIT_EXCEEDED" | "OUTPUT_SCHEMA_LIMIT_EXCEEDED",
  description: string,
): void {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw boundaryError(code, `${description} exceeds its local protocol UTF-8 byte limit.`);
  }
}

function snapshotMismatch(message: string): LocalExecutionBoundaryError {
  return boundaryError("SNAPSHOT_IDENTITY_MISMATCH", message);
}

function boundaryError(
  code: LocalExecutionBoundaryErrorCode,
  message: string,
  cause?: unknown,
): LocalExecutionBoundaryError {
  return new LocalExecutionBoundaryError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function unicodeCodePointBoundaries(value: string): number[] {
  const boundaries = [0];
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    boundaries.push(offset);
  }
  return boundaries;
}

function registerContractFormats(): void {
  if (!FormatRegistry.Has("date-time")) {
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  }
  if (!FormatRegistry.Has("uri")) {
    FormatRegistry.Set("uri", (value) => URL.canParse(value));
  }
}
