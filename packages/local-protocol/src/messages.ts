import { createHash, timingSafeEqual } from "node:crypto";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  createCanonicalJsonDocument,
  parseCanonicalJson,
  serializeCanonicalJson,
} from "./canonical.js";
import {
  type ExecutionCapabilityV1,
  LocalRepositoryIdentitySchema,
  type RenewalGrantV1,
  SignedExecutionCapabilityV1Schema,
  SignedRenewalGrantV1Schema,
  sha256Hex,
  validateExecutionCapability,
  validateRenewalGrant,
} from "./capability.js";
import {
  LOCAL_PROTOCOL_MAJOR_VERSION,
  LOCAL_PROTOCOL_MINOR_VERSION,
  LocalMessageType,
  type LocalMessageTypeId,
} from "./framing.js";
export const LOCAL_ARTIFACT_CHUNK_MAXIMUM_BYTES = 256 * 1024;
export const LOCAL_ARTIFACT_MAXIMUM_BYTES = 64n * 1024n * 1024n * 1024n;
export const LOCAL_START_PROMPT_MAXIMUM_UTF8_BYTES = 512 * 1024;
export const LOCAL_START_SCHEMA_MAXIMUM_UTF8_BYTES = 256 * 1024;
export const LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES = 256 * 1024;
export const LOCAL_START_ENVELOPE_MAXIMUM_UTF8_BYTES = 900 * 1024;
export const LOCAL_PROGRESS_STATUS_MAXIMUM_UTF8_BYTES = 2 * 1024;

const safeIntegerMaximum = Number.MAX_SAFE_INTEGER;
const uuidV4Pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const sha256Pattern = "^[a-f0-9]{64}$";
const decimalPattern = "^(?:0|[1-9][0-9]{0,20})$";
const base64UrlPattern = "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$";
const entityPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
const codePattern = "^[A-Z][A-Z0-9_]{0,127}$";
const artifactNamePattern = "^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$";
const mediaTypePattern = "^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$";

const UuidV4Schema = Type.String({ minLength: 36, maxLength: 36, pattern: uuidV4Pattern });
const Sha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });
const Random256BitSchema = Type.String({ minLength: 64, maxLength: 64, pattern: sha256Pattern });
const SafeNonNegativeIntegerSchema = Type.Integer({ minimum: 0, maximum: safeIntegerMaximum });
const SafePositiveIntegerSchema = Type.Integer({ minimum: 1, maximum: safeIntegerMaximum });
const DecimalSchema = Type.String({ minLength: 1, maxLength: 21, pattern: decimalPattern });
const WorkerNodeIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: entityPattern,
});
const EntityIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: entityPattern });

const SessionProperties = {
  protocolMajor: Type.Literal(LOCAL_PROTOCOL_MAJOR_VERSION),
  protocolMinor: Type.Literal(LOCAL_PROTOCOL_MINOR_VERSION),
  workerNodeId: WorkerNodeIdSchema,
  workerInstanceId: EntityIdSchema,
  executorBootId: UuidV4Schema,
  sessionId: UuidV4Schema,
};

const AttemptProperties = {
  ...SessionProperties,
  attemptCorrelationId: UuidV4Schema,
  runAttemptId: EntityIdSchema,
};

export const HelloMessageSchema = Type.Object(
  {
    protocolMajor: Type.Literal(LOCAL_PROTOCOL_MAJOR_VERSION),
    minimumMinor: Type.Literal(LOCAL_PROTOCOL_MINOR_VERSION),
    maximumMinor: Type.Literal(LOCAL_PROTOCOL_MINOR_VERSION),
    workerNodeId: WorkerNodeIdSchema,
    workerInstanceId: EntityIdSchema,
    executorBootId: Type.Null(),
    sessionId: UuidV4Schema,
    controlNonce: Random256BitSchema,
    controlManifestSha256: Sha256Schema,
    controlPreflightSha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type HelloMessage = Static<typeof HelloMessageSchema>;

export const HelloAckMessageSchema = Type.Object(
  {
    ...SessionProperties,
    controlNonce: Random256BitSchema,
    executorNonce: Random256BitSchema,
    executorManifestSha256: Sha256Schema,
    executorPolicySha256: Sha256Schema,
    executorPreflightSha256: Sha256Schema,
    maximumSlots: Type.Integer({ minimum: 1, maximum: 64 }),
  },
  { additionalProperties: false },
);
export type HelloAckMessage = Static<typeof HelloAckMessageSchema>;

export const ReadyMessageSchema = Type.Object(
  {
    ...SessionProperties,
    controlNonce: Random256BitSchema,
    executorNonce: Random256BitSchema,
    executorManifestSha256: Sha256Schema,
    executorPolicySha256: Sha256Schema,
    executorPreflightSha256: Sha256Schema,
    isolationMode: Type.Literal("split-service-v1"),
    ready: Type.Boolean(),
    availableSlots: Type.Integer({ minimum: 0, maximum: 64 }),
    reasonCode: Type.Union([
      Type.Null(),
      Type.String({ minLength: 1, maxLength: 128, pattern: codePattern }),
    ]),
  },
  { additionalProperties: false },
);
export type ReadyMessage = Static<typeof ReadyMessageSchema>;

export const LocalExecutionPolicyV1Schema = Type.Object(
  {
    hardTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
    noProgressTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
    maxCodexTurns: Type.Integer({ minimum: 1, maximum: 128 }),
    allowedRecipeIds: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._+-]*$",
      }),
      { maxItems: 256, uniqueItems: true },
    ),
    requiredCapabilityLabels: Type.Record(
      Type.String({
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
      }),
      Type.String({ maxLength: 256 }),
      { additionalProperties: false, maxProperties: 64 },
    ),
  },
  { additionalProperties: false },
);
export type LocalExecutionPolicyV1 = Static<typeof LocalExecutionPolicyV1Schema>;

const LocalGitHubActorSchema = Type.Object(
  {
    githubUserId: SafePositiveIntegerSchema,
    login: Type.String({ minLength: 1, maxLength: 128 }),
    accountType: Type.Union([
      Type.Literal("user"),
      Type.Literal("bot"),
      Type.Literal("app"),
      Type.Null(),
    ]),
    githubNodeId: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const LocalResourceBaseProperties = {
  githubNodeId: Type.String({ minLength: 1, maxLength: 256 }),
  number: SafePositiveIntegerSchema,
  title: Type.String({ minLength: 1, maxLength: 1_024 }),
  author: LocalGitHubActorSchema,
  canonicalSnapshotJson: Type.String({
    minLength: 2,
    maxLength: LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES,
  }),
  canonicalSnapshotSha256: Sha256Schema,
};

export const LocalExecutionResourceV1Schema = Type.Union([
  Type.Object(
    {
      ...LocalResourceBaseProperties,
      kind: Type.Literal("issue"),
      revisionDigest: Sha256Schema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...LocalResourceBaseProperties,
      kind: Type.Literal("pull_request"),
      baseSha: Type.String({ minLength: 40, maxLength: 64, pattern: "^[a-f0-9]{40,64}$" }),
      headSha: Type.String({ minLength: 40, maxLength: 64, pattern: "^[a-f0-9]{40,64}$" }),
      isDraft: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
]);
export type LocalExecutionResourceV1 = Static<typeof LocalExecutionResourceV1Schema>;

export const ExecutorJobEnvelopeV1Schema = Type.Object(
  {
    envelopeVersion: Type.Literal(1),
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    jobKind: Type.Union([Type.Literal("issue_triage"), Type.Literal("pull_request_review")]),
    priority: Type.Integer({ minimum: -1_000_000, maximum: 1_000_000 }),
    attempt: SafePositiveIntegerSchema,
    maxAttempts: SafePositiveIntegerSchema,
    generation: SafeNonNegativeIntegerSchema,
    intentVersion: SafePositiveIntegerSchema,
    semanticKey: Type.String({ minLength: 1, maxLength: 1_024 }),
    repository: LocalRepositoryIdentitySchema,
    resource: LocalExecutionResourceV1Schema,
    prompt: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 128 }),
        version: Type.String({ minLength: 1, maxLength: 128 }),
        renderedPrompt: Type.String({
          minLength: 1,
          maxLength: LOCAL_START_PROMPT_MAXIMUM_UTF8_BYTES,
        }),
        promptSha256: Sha256Schema,
        outputSchemaJson: Type.String({
          minLength: 2,
          maxLength: LOCAL_START_SCHEMA_MAXIMUM_UTF8_BYTES,
        }),
        outputSchemaSha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
    policy: LocalExecutionPolicyV1Schema,
  },
  { additionalProperties: false },
);
export type ExecutorJobEnvelopeV1 = Static<typeof ExecutorJobEnvelopeV1Schema>;

export const StartAttemptMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    signedAuthorization: SignedExecutionCapabilityV1Schema,
    executorEnvelope: ExecutorJobEnvelopeV1Schema,
  },
  { additionalProperties: false },
);
export type StartAttemptMessage = Static<typeof StartAttemptMessageSchema>;

export const RenewGrantMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    authorization: SignedRenewalGrantV1Schema,
  },
  { additionalProperties: false },
);
export type RenewGrantMessage = Static<typeof RenewGrantMessageSchema>;

export const CancelAttemptMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    reason: Type.Union([
      Type.Literal("server_cancelled"),
      Type.Literal("stale_revision"),
      Type.Literal("lease_lost"),
      Type.Literal("worker_draining"),
      Type.Literal("shutdown"),
      Type.Literal("operator_cancelled"),
    ]),
    requestedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type CancelAttemptMessage = Static<typeof CancelAttemptMessageSchema>;

export const CancelAckMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    outcome: Type.Union([
      Type.Literal("terminated"),
      Type.Literal("already_terminal"),
      Type.Literal("not_found"),
    ]),
    processCount: Type.Literal(0),
    acknowledgedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type CancelAckMessage = Static<typeof CancelAckMessageSchema>;

const ExecutionPhaseSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("codex_review"),
  Type.Literal("validation"),
  Type.Literal("codex_revision"),
  Type.Literal("uploading"),
  Type.Literal("completing"),
  Type.Literal("cancelling"),
]);

export const ProgressMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    progressSequence: SafePositiveIntegerSchema,
    phase: ExecutionPhaseSchema,
    elapsedMs: SafeNonNegativeIntegerSchema,
    processCount: Type.Integer({ minimum: 0, maximum: 1_024 }),
    status: Type.String({ maxLength: LOCAL_PROGRESS_STATUS_MAXIMUM_UTF8_BYTES }),
  },
  { additionalProperties: false },
);
export type ProgressMessage = Static<typeof ProgressMessageSchema>;

export const ArtifactStartMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    artifactId: UuidV4Schema,
    purpose: Type.Union([
      Type.Literal("result"),
      Type.Literal("log"),
      Type.Literal("validation_result"),
      Type.Literal("attachment"),
    ]),
    name: Type.String({ minLength: 1, maxLength: 128, pattern: artifactNamePattern }),
    mediaType: Type.String({ minLength: 3, maxLength: 128, pattern: mediaTypePattern }),
    totalBytes: DecimalSchema,
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type ArtifactStartMessage = Static<typeof ArtifactStartMessageSchema>;

export const ArtifactChunkMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    artifactId: UuidV4Schema,
    chunkIndex: SafeNonNegativeIntegerSchema,
    offsetBytes: DecimalSchema,
    chunkBytes: Type.Integer({ minimum: 1, maximum: LOCAL_ARTIFACT_CHUNK_MAXIMUM_BYTES }),
    chunkSha256: Sha256Schema,
    data: Type.String({
      minLength: 2,
      maxLength: Math.ceil((LOCAL_ARTIFACT_CHUNK_MAXIMUM_BYTES * 4) / 3),
      pattern: base64UrlPattern,
    }),
  },
  { additionalProperties: false },
);
export type ArtifactChunkMessage = Static<typeof ArtifactChunkMessageSchema>;

export const ArtifactEndMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    artifactId: UuidV4Schema,
    chunkCount: SafePositiveIntegerSchema,
    totalBytes: DecimalSchema,
    sha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type ArtifactEndMessage = Static<typeof ArtifactEndMessageSchema>;

// Results use the artifact stream because the Server permits results larger than a single frame.
export const CompleteMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    resultArtifactId: UuidV4Schema,
    resultBytes: DecimalSchema,
    resultSha256: Sha256Schema,
    outputSchemaSha256: Sha256Schema,
    completedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type CompleteMessage = Static<typeof CompleteMessageSchema>;

export const FailedMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    code: Type.String({ minLength: 1, maxLength: 128, pattern: codePattern }),
    message: Type.String({ minLength: 1, maxLength: 2_048 }),
    retryable: Type.Boolean(),
    failedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type FailedMessage = Static<typeof FailedMessageSchema>;

export const DrainMessageSchema = Type.Object(
  {
    ...SessionProperties,
    reasonCode: Type.String({ minLength: 1, maxLength: 128, pattern: codePattern }),
    requestedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DrainMessage = Static<typeof DrainMessageSchema>;

export const DrainedMessageSchema = Type.Object(
  {
    ...SessionProperties,
    activeAttemptCount: Type.Literal(0),
    drainedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type DrainedMessage = Static<typeof DrainedMessageSchema>;

export const PingMessageSchema = Type.Object(
  {
    ...SessionProperties,
    probeId: Random256BitSchema,
    sentAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type PingMessage = Static<typeof PingMessageSchema>;

export const PongMessageSchema = Type.Object(
  {
    ...SessionProperties,
    probeId: Random256BitSchema,
    sentAtUnixMs: SafeNonNegativeIntegerSchema,
    observedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type PongMessage = Static<typeof PongMessageSchema>;

// Control sends this only after its Server terminal submission has reached a definitive outcome.
export const TerminalDispositionMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    dispositionId: Random256BitSchema,
    terminalPayloadSha256: Sha256Schema,
    outcome: Type.Union([
      Type.Literal("committed"),
      Type.Literal("retry_scheduled"),
      Type.Literal("cancelled"),
      Type.Literal("fenced"),
      Type.Literal("rejected"),
    ]),
    workspaceDisposition: Type.Union([Type.Literal("delete"), Type.Literal("retain_for_janitor")]),
    decidedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type TerminalDispositionMessage = Static<typeof TerminalDispositionMessageSchema>;

export const TerminalAckMessageSchema = Type.Object(
  {
    ...AttemptProperties,
    dispositionId: Random256BitSchema,
    processCount: Type.Literal(0),
    cleanupOutcome: Type.Union([
      Type.Literal("deleted"),
      Type.Literal("retained"),
      Type.Literal("janitor_required"),
    ]),
    acknowledgedAtUnixMs: SafeNonNegativeIntegerSchema,
  },
  { additionalProperties: false },
);
export type TerminalAckMessage = Static<typeof TerminalAckMessageSchema>;

export const localMessageSchemas = Object.freeze({
  [LocalMessageType.Hello]: HelloMessageSchema,
  [LocalMessageType.HelloAck]: HelloAckMessageSchema,
  [LocalMessageType.Ready]: ReadyMessageSchema,
  [LocalMessageType.StartAttempt]: StartAttemptMessageSchema,
  [LocalMessageType.RenewGrant]: RenewGrantMessageSchema,
  [LocalMessageType.CancelAttempt]: CancelAttemptMessageSchema,
  [LocalMessageType.CancelAck]: CancelAckMessageSchema,
  [LocalMessageType.Progress]: ProgressMessageSchema,
  [LocalMessageType.ArtifactStart]: ArtifactStartMessageSchema,
  [LocalMessageType.ArtifactChunk]: ArtifactChunkMessageSchema,
  [LocalMessageType.ArtifactEnd]: ArtifactEndMessageSchema,
  [LocalMessageType.Complete]: CompleteMessageSchema,
  [LocalMessageType.Failed]: FailedMessageSchema,
  [LocalMessageType.Drain]: DrainMessageSchema,
  [LocalMessageType.Drained]: DrainedMessageSchema,
  [LocalMessageType.Ping]: PingMessageSchema,
  [LocalMessageType.Pong]: PongMessageSchema,
  [LocalMessageType.TerminalDisposition]: TerminalDispositionMessageSchema,
  [LocalMessageType.TerminalAck]: TerminalAckMessageSchema,
} satisfies Record<LocalMessageTypeId, TSchema>);

export type LocalProtocolPeerRole = "control" | "executor" | "either";

export const localMessageSender = Object.freeze({
  [LocalMessageType.Hello]: "control",
  [LocalMessageType.HelloAck]: "executor",
  [LocalMessageType.Ready]: "executor",
  [LocalMessageType.StartAttempt]: "control",
  [LocalMessageType.RenewGrant]: "control",
  [LocalMessageType.CancelAttempt]: "control",
  [LocalMessageType.CancelAck]: "executor",
  [LocalMessageType.Progress]: "executor",
  [LocalMessageType.ArtifactStart]: "executor",
  [LocalMessageType.ArtifactChunk]: "executor",
  [LocalMessageType.ArtifactEnd]: "executor",
  [LocalMessageType.Complete]: "executor",
  [LocalMessageType.Failed]: "executor",
  [LocalMessageType.Drain]: "control",
  [LocalMessageType.Drained]: "executor",
  [LocalMessageType.Ping]: "either",
  [LocalMessageType.Pong]: "either",
  [LocalMessageType.TerminalDisposition]: "control",
  [LocalMessageType.TerminalAck]: "executor",
} as const satisfies Record<LocalMessageTypeId, LocalProtocolPeerRole>);

export type LocalMessagePayload =
  | HelloMessage
  | HelloAckMessage
  | ReadyMessage
  | StartAttemptMessage
  | RenewGrantMessage
  | CancelAttemptMessage
  | CancelAckMessage
  | ProgressMessage
  | ArtifactStartMessage
  | ArtifactChunkMessage
  | ArtifactEndMessage
  | CompleteMessage
  | FailedMessage
  | DrainMessage
  | DrainedMessage
  | PingMessage
  | PongMessage
  | TerminalDispositionMessage
  | TerminalAckMessage;

export class LocalMessageValidationError extends Error {
  public constructor(
    public readonly code:
      | "MESSAGE_SCHEMA_INVALID"
      | "MESSAGE_CONTEXT_MISMATCH"
      | "MESSAGE_DIGEST_MISMATCH"
      | "MESSAGE_LIMIT_EXCEEDED"
      | "MESSAGE_ENCODING_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "LocalMessageValidationError";
  }
}

export function assertLocalMessageSender(
  messageType: LocalMessageTypeId,
  sender: Exclude<LocalProtocolPeerRole, "either">,
): void {
  const expected = localMessageSender[messageType];
  if (expected !== "either" && expected !== sender) {
    throw messageError(
      "MESSAGE_CONTEXT_MISMATCH",
      `Local message type ${messageType} is not valid from the ${sender} peer.`,
    );
  }
}

export function validateLocalMessagePayload(
  messageType: LocalMessageTypeId,
  value: unknown,
  correlationId: string,
): Readonly<LocalMessagePayload> {
  const schema = localMessageSchemas[messageType];
  let canonical: string;
  try {
    canonical = serializeCanonicalJson(value);
  } catch {
    throw messageError("MESSAGE_SCHEMA_INVALID", "Local message is not valid canonical JSON data.");
  }
  const normalized = JSON.parse(canonical) as unknown;
  if (!Value.Check(schema, normalized)) {
    throw messageError("MESSAGE_SCHEMA_INVALID", "Local message does not match its strict schema.");
  }
  const message = normalized as LocalMessagePayload;
  validateCorrelation(messageType, message, correlationId);
  validateSemanticRules(messageType, message);
  return Object.freeze(message);
}

export function digestExecutorJobEnvelope(envelope: unknown): string {
  const normalized = validateSchemaValue<ExecutorJobEnvelopeV1>(
    envelope,
    ExecutorJobEnvelopeV1Schema,
  );
  return createCanonicalJsonDocument(normalized).sha256;
}

function validateSemanticRules(
  messageType: LocalMessageTypeId,
  message: LocalMessagePayload,
): void {
  if (messageType === LocalMessageType.Ready) {
    const ready = message as ReadyMessage;
    if (
      (ready.ready && (ready.availableSlots < 1 || ready.reasonCode !== null)) ||
      (!ready.ready && (ready.availableSlots !== 0 || ready.reasonCode === null))
    ) {
      throw messageError("MESSAGE_CONTEXT_MISMATCH", "Ready state fields are inconsistent.");
    }
  }
  if (messageType === LocalMessageType.StartAttempt) {
    validateStartAttempt(message as StartAttemptMessage);
  }
  if (messageType === LocalMessageType.RenewGrant) {
    const renewalMessage = message as RenewGrantMessage;
    let grant: Readonly<RenewalGrantV1>;
    try {
      grant = validateRenewalGrant(renewalMessage.authorization.grant);
    } catch {
      throw messageError("MESSAGE_SCHEMA_INVALID", "Renewal grant authority is invalid.");
    }
    assertSessionMatchesCapability(renewalMessage, grant);
  }
  if (messageType === LocalMessageType.Progress) {
    assertUtf8Bound((message as ProgressMessage).status, LOCAL_PROGRESS_STATUS_MAXIMUM_UTF8_BYTES);
  }
  if (messageType === LocalMessageType.ArtifactStart) {
    parseArtifactByteCount((message as ArtifactStartMessage).totalBytes);
  }
  if (messageType === LocalMessageType.ArtifactChunk) {
    validateArtifactChunk(message as ArtifactChunkMessage);
  }
  if (messageType === LocalMessageType.ArtifactEnd) {
    parseArtifactByteCount((message as ArtifactEndMessage).totalBytes);
  }
  if (messageType === LocalMessageType.Complete) {
    parseArtifactByteCount((message as CompleteMessage).resultBytes);
  }
  if (messageType === LocalMessageType.Pong) {
    const pong = message as PongMessage;
    if (pong.observedAtUnixMs < pong.sentAtUnixMs) {
      throw messageError("MESSAGE_CONTEXT_MISMATCH", "Pong timestamps are inconsistent.");
    }
  }
}

function validateStartAttempt(message: StartAttemptMessage): void {
  let capability: Readonly<ExecutionCapabilityV1>;
  try {
    capability = validateExecutionCapability(message.signedAuthorization.capability);
  } catch {
    throw messageError("MESSAGE_SCHEMA_INVALID", "Execution capability authority is invalid.");
  }
  assertSessionMatchesCapability(message, capability);
  if (
    message.executorEnvelope.runAttemptId !== message.runAttemptId ||
    message.executorEnvelope.jobId !== capability.jobId ||
    message.executorEnvelope.repository.githubRepositoryId !==
      capability.repository.githubRepositoryId ||
    message.executorEnvelope.repository.fullName !== capability.repository.fullName ||
    message.executorEnvelope.attempt > message.executorEnvelope.maxAttempts ||
    message.executorEnvelope.policy.hardTimeoutMs > capability.resources.hardTimeoutMs ||
    message.executorEnvelope.policy.noProgressTimeoutMs >
      message.executorEnvelope.policy.hardTimeoutMs
  ) {
    throw messageError("MESSAGE_CONTEXT_MISMATCH", "StartAttempt identity is inconsistent.");
  }
  assertUtf8Bound(
    message.executorEnvelope.prompt.renderedPrompt,
    LOCAL_START_PROMPT_MAXIMUM_UTF8_BYTES,
  );
  assertUtf8Bound(
    message.executorEnvelope.prompt.outputSchemaJson,
    LOCAL_START_SCHEMA_MAXIMUM_UTF8_BYTES,
  );
  assertUtf8Bound(
    message.executorEnvelope.resource.canonicalSnapshotJson,
    LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES,
  );
  const envelopeBytes = Buffer.byteLength(serializeCanonicalJson(message.executorEnvelope), "utf8");
  if (envelopeBytes > LOCAL_START_ENVELOPE_MAXIMUM_UTF8_BYTES) {
    throw messageError(
      "MESSAGE_LIMIT_EXCEEDED",
      "Local execution envelope exceeds its byte limit.",
    );
  }
  const schemaValue = parseEmbeddedCanonicalJson(
    message.executorEnvelope.prompt.outputSchemaJson,
    LOCAL_START_SCHEMA_MAXIMUM_UTF8_BYTES,
    "Output schema",
  );
  const snapshotValue = parseEmbeddedCanonicalJson(
    message.executorEnvelope.resource.canonicalSnapshotJson,
    LOCAL_START_SNAPSHOT_MAXIMUM_UTF8_BYTES,
    "Canonical snapshot",
  );
  validateTargetRevision(message.executorEnvelope, capability);
  const recipeSet = [...message.executorEnvelope.policy.allowedRecipeIds].sort();
  if (
    !secureDigestEqual(
      sha256Hex(message.executorEnvelope.prompt.renderedPrompt),
      capability.digests.promptSha256,
    ) ||
    !secureDigestEqual(
      message.executorEnvelope.prompt.promptSha256,
      capability.digests.promptSha256,
    ) ||
    !secureDigestEqual(
      createCanonicalJsonDocument(schemaValue).sha256,
      capability.digests.outputSchemaSha256,
    ) ||
    !secureDigestEqual(
      message.executorEnvelope.prompt.outputSchemaSha256,
      capability.digests.outputSchemaSha256,
    ) ||
    !secureDigestEqual(
      createCanonicalJsonDocument(snapshotValue).sha256,
      message.executorEnvelope.resource.canonicalSnapshotSha256,
    ) ||
    !secureDigestEqual(
      digestExecutorJobEnvelope(message.executorEnvelope),
      capability.digests.executorEnvelopeSha256,
    ) ||
    !secureDigestEqual(
      createCanonicalJsonDocument(message.executorEnvelope.policy).sha256,
      capability.digests.policySha256,
    ) ||
    !secureDigestEqual(
      createCanonicalJsonDocument(recipeSet).sha256,
      capability.digests.recipeSetSha256,
    )
  ) {
    throw messageError(
      "MESSAGE_DIGEST_MISMATCH",
      "StartAttempt signed digests do not match its data.",
    );
  }
  const uniqueRecipes = new Set(message.executorEnvelope.policy.allowedRecipeIds);
  if (uniqueRecipes.size !== message.executorEnvelope.policy.allowedRecipeIds.length) {
    throw messageError("MESSAGE_SCHEMA_INVALID", "Recipe identifiers must be unique.");
  }
  if (capability.operation.kind === "recipe" && !uniqueRecipes.has(capability.operation.recipeId)) {
    throw messageError(
      "MESSAGE_CONTEXT_MISMATCH",
      "Authorized recipe is absent from the local policy.",
    );
  }
}

function assertSessionMatchesCapability(
  message: {
    readonly workerNodeId: string;
    readonly workerInstanceId: string;
    readonly executorBootId: string;
    readonly sessionId: string;
    readonly attemptCorrelationId: string;
    readonly runAttemptId: string;
  },
  capability: Pick<
    ExecutionCapabilityV1,
    | "workerNodeId"
    | "workerInstanceId"
    | "executorBootId"
    | "sessionId"
    | "attemptCorrelationId"
    | "runAttemptId"
  >,
): void {
  if (
    message.workerNodeId !== capability.workerNodeId ||
    message.workerInstanceId !== capability.workerInstanceId ||
    message.executorBootId !== capability.executorBootId ||
    message.sessionId !== capability.sessionId ||
    message.attemptCorrelationId !== capability.attemptCorrelationId ||
    message.runAttemptId !== capability.runAttemptId
  ) {
    throw messageError("MESSAGE_CONTEXT_MISMATCH", "Message and signed authority context differ.");
  }
}

function validateTargetRevision(
  envelope: ExecutorJobEnvelopeV1,
  capability: ExecutionCapabilityV1,
): void {
  const resource = envelope.resource;
  const target = capability.targetRevision;
  if (envelope.jobKind === "issue_triage") {
    if (
      resource.kind !== "issue" ||
      target.kind !== "issue" ||
      resource.revisionDigest !== target.revisionDigest
    ) {
      throw messageError(
        "MESSAGE_CONTEXT_MISMATCH",
        "Issue job and signed revision identity are inconsistent.",
      );
    }
    return;
  }
  if (
    resource.kind !== "pull_request" ||
    target.kind !== "pull_request" ||
    resource.baseSha !== target.baseSha ||
    resource.headSha !== target.headSha
  ) {
    throw messageError(
      "MESSAGE_CONTEXT_MISMATCH",
      "Pull request job and signed revision identity are inconsistent.",
    );
  }
}

function validateCorrelation(
  messageType: LocalMessageTypeId,
  message: LocalMessagePayload,
  correlationId: string,
): void {
  if (isAttemptMessageType(messageType)) {
    if (
      (message as { readonly attemptCorrelationId: string }).attemptCorrelationId !== correlationId
    ) {
      throw messageError(
        "MESSAGE_CONTEXT_MISMATCH",
        "Attempt correlation ID does not match attemptCorrelationId.",
      );
    }
  } else if (correlationId !== "00000000-0000-0000-0000-000000000000") {
    throw messageError(
      "MESSAGE_CONTEXT_MISMATCH",
      "Session message must use the nil correlation ID.",
    );
  }
}

function isAttemptMessageType(messageType: LocalMessageTypeId): boolean {
  return (
    (messageType >= LocalMessageType.StartAttempt && messageType <= LocalMessageType.Failed) ||
    messageType === LocalMessageType.TerminalDisposition ||
    messageType === LocalMessageType.TerminalAck
  );
}

function validateArtifactChunk(message: ArtifactChunkMessage): void {
  if (message.data.length % 4 === 1 || !new RegExp(base64UrlPattern, "u").test(message.data)) {
    throw messageError(
      "MESSAGE_ENCODING_INVALID",
      "Artifact chunk data is not canonical base64url.",
    );
  }
  const bytes = Buffer.from(message.data, "base64url");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > LOCAL_ARTIFACT_CHUNK_MAXIMUM_BYTES ||
    bytes.byteLength !== message.chunkBytes ||
    bytes.toString("base64url") !== message.data
  ) {
    throw messageError("MESSAGE_LIMIT_EXCEEDED", "Artifact chunk byte count is invalid.");
  }
  if (!secureDigestEqual(sha256Hex(bytes), message.chunkSha256)) {
    throw messageError("MESSAGE_DIGEST_MISMATCH", "Artifact chunk digest is invalid.");
  }
  parseArtifactByteCount(message.offsetBytes);
}

function parseArtifactByteCount(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > LOCAL_ARTIFACT_MAXIMUM_BYTES) {
    throw messageError("MESSAGE_LIMIT_EXCEEDED", "Artifact byte count exceeds the protocol limit.");
  }
  return parsed;
}

function assertUtf8Bound(value: string, maximumBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw messageError("MESSAGE_LIMIT_EXCEEDED", "Message text exceeds its UTF-8 byte limit.");
  }
}

function parseEmbeddedCanonicalJson(value: string, maximumBytes: number, name: string): unknown {
  try {
    return parseCanonicalJson(Buffer.from(value, "utf8"), maximumBytes);
  } catch {
    throw messageError(
      "MESSAGE_ENCODING_INVALID",
      `${name} is not valid canonical JSON within its protocol limit.`,
    );
  }
}

function validateSchemaValue<T>(value: unknown, schema: TSchema): T {
  let canonical: string;
  try {
    canonical = serializeCanonicalJson(value);
  } catch {
    throw messageError("MESSAGE_SCHEMA_INVALID", "Value is not valid canonical JSON data.");
  }
  const normalized = JSON.parse(canonical) as unknown;
  if (!Value.Check(schema, normalized)) {
    throw messageError("MESSAGE_SCHEMA_INVALID", "Value does not match its strict schema.");
  }
  return normalized as T;
}

function secureDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function messageError(
  code: LocalMessageValidationError["code"],
  message: string,
): LocalMessageValidationError {
  return new LocalMessageValidationError(code, message);
}

export function encodeArtifactChunkData(bytes: Uint8Array): Readonly<{
  data: string;
  chunkBytes: number;
  chunkSha256: string;
}> {
  if (bytes.byteLength === 0 || bytes.byteLength > LOCAL_ARTIFACT_CHUNK_MAXIMUM_BYTES) {
    throw messageError("MESSAGE_LIMIT_EXCEEDED", "Artifact chunk byte count is invalid.");
  }
  return Object.freeze({
    data: Buffer.from(bytes).toString("base64url"),
    chunkBytes: bytes.byteLength,
    chunkSha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
