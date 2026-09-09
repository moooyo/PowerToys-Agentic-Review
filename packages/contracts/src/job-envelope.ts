import { type Static, Type } from "@sinclair/typebox";

import {
  DateTimeSchema,
  EntityIdSchema,
  GitHubRepositoryNameSchema,
  GitObjectIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  ProtocolVersionSchema,
  Sha256Schema,
} from "./common.js";
import { ValidationJobContextV2Schema } from "./evaluation-execution.js";
import { GitHubActorSchema } from "./github.js";
import { JobKindSchema } from "./states.js";
import { ValidationJobContextSchema } from "./validation-job.js";
import { LeaseIdentitySchema } from "./worker.js";

export const RepositoryTargetSchema = Type.Object(
  {
    githubRepositoryId: PositiveIntegerSchema,
    fullName: GitHubRepositoryNameSchema,
  },
  { additionalProperties: false },
);
export type RepositoryTarget = Static<typeof RepositoryTargetSchema>;

const ResourceBaseProperties = {
  githubNodeId: Type.String({ minLength: 1, maxLength: 256 }),
  number: PositiveIntegerSchema,
  title: Type.String({ minLength: 1, maxLength: 1_024 }),
  author: GitHubActorSchema,
  canonicalSnapshot: Type.Unknown(),
};

export const IssueTargetSchema = Type.Object(
  {
    ...ResourceBaseProperties,
    kind: Type.Literal("issue"),
    revisionDigest: Sha256Schema,
  },
  { additionalProperties: false },
);
export type IssueTarget = Static<typeof IssueTargetSchema>;

export const PullRequestTargetSchema = Type.Object(
  {
    ...ResourceBaseProperties,
    kind: Type.Literal("pull_request"),
    baseSha: GitObjectIdSchema,
    headSha: GitObjectIdSchema,
    isDraft: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type PullRequestTarget = Static<typeof PullRequestTargetSchema>;

export const ResourceTargetSchema = Type.Union([IssueTargetSchema, PullRequestTargetSchema]);
export type ResourceTarget = Static<typeof ResourceTargetSchema>;

// Producers must additionally enforce this limit against the encoded UTF-8 byte length.
export const maximumRenderedPromptUtf8Bytes = 512 * 1024;
// The Server must enforce this against the complete granted response before committing a lease.
export const maximumClaimLeaseResponseUtf8Bytes = 16 * 1024 * 1024;

export const PromptEnvelopeSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    renderedPrompt: Type.String({ minLength: 1, maxLength: maximumRenderedPromptUtf8Bytes }),
    promptSha256: Sha256Schema,
    outputSchema: Type.Unknown(),
    outputSchemaSha256: Sha256Schema,
  },
  { additionalProperties: false },
);
export type PromptEnvelope = Static<typeof PromptEnvelopeSchema>;

export const ExecutionPolicySchema = Type.Object(
  {
    hardTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
    noProgressTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
    allowedRecipeIds: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._+-]*$",
      }),
      {
        maxItems: 256,
        uniqueItems: true,
      },
    ),
    requiredCapabilityLabels: Type.Record(
      Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
      Type.String({ maxLength: 256 }),
      { additionalProperties: false, maxProperties: 64 },
    ),
  },
  { additionalProperties: false },
);
export type ExecutionPolicy = Static<typeof ExecutionPolicySchema>;

const JobExecutionTemplateProperties = {
  repository: RepositoryTargetSchema,
  resource: ResourceTargetSchema,
  prompt: PromptEnvelopeSchema,
  executionPolicy: ExecutionPolicySchema,
};

export const JobExecutionTemplateV1Schema = Type.Object(JobExecutionTemplateProperties, {
  additionalProperties: false,
});
export const ValidationExecutionContextSchema = Type.Union([
  ValidationJobContextSchema,
  ValidationJobContextV2Schema,
]);
export type ValidationExecutionContext = Static<typeof ValidationExecutionContextSchema>;
export const JobExecutionTemplateV2Schema = Type.Object(
  { ...JobExecutionTemplateProperties, validation: ValidationExecutionContextSchema },
  { additionalProperties: false },
);
export const JobExecutionTemplateSchema = Type.Union([
  JobExecutionTemplateV1Schema,
  JobExecutionTemplateV2Schema,
]);
export type JobExecutionTemplate = Static<typeof JobExecutionTemplateSchema>;
export type JobExecutionTemplateV2 = Static<typeof JobExecutionTemplateV2Schema>;

const JobExecutionEnvelopeProperties = {
  protocolVersion: ProtocolVersionSchema,
  assignedAt: DateTimeSchema,
  leaseExpiresAt: DateTimeSchema,
  executionDeadlineAt: DateTimeSchema,
  lease: LeaseIdentitySchema,
  job: Type.Object(
    {
      jobId: EntityIdSchema,
      kind: JobKindSchema,
      priority: Type.Integer(),
      attempt: PositiveIntegerSchema,
      maxAttempts: PositiveIntegerSchema,
      generation: NonNegativeIntegerSchema,
      intentVersion: PositiveIntegerSchema,
      semanticKey: Type.String({ minLength: 1, maxLength: 1_024 }),
    },
    { additionalProperties: false },
  ),
  ...JobExecutionTemplateProperties,
};

export const JobExecutionEnvelopeV1Schema = Type.Object(
  { ...JobExecutionEnvelopeProperties, envelopeVersion: Type.Literal(1) },
  { additionalProperties: false },
);
export const JobExecutionEnvelopeV2Schema = Type.Object(
  {
    ...JobExecutionEnvelopeProperties,
    envelopeVersion: Type.Literal(2),
    validation: ValidationExecutionContextSchema,
  },
  { additionalProperties: false },
);
export const JobExecutionEnvelopeSchema = Type.Union([
  JobExecutionEnvelopeV1Schema,
  JobExecutionEnvelopeV2Schema,
]);
export type JobExecutionEnvelope = Static<typeof JobExecutionEnvelopeSchema>;
export type JobExecutionEnvelopeV2 = Static<typeof JobExecutionEnvelopeV2Schema>;

export const ClaimLeaseGrantedSchema = Type.Object(
  {
    outcome: Type.Literal("granted"),
    serverTime: DateTimeSchema,
    envelope: JobExecutionEnvelopeSchema,
  },
  { additionalProperties: false },
);

export const ClaimLeaseNoWorkSchema = Type.Object(
  {
    outcome: Type.Literal("no_work"),
    serverTime: DateTimeSchema,
    retryAfterMs: Type.Optional(NonNegativeIntegerSchema),
  },
  { additionalProperties: false },
);

export const ClaimLeaseUnavailableSchema = Type.Object(
  {
    outcome: Type.Literal("worker_unavailable"),
    serverTime: DateTimeSchema,
    reason: Type.Union([
      Type.Literal("not_registered"),
      Type.Literal("not_online"),
      Type.Literal("capabilities_changed"),
      Type.Literal("no_available_slots"),
      Type.Literal("draining"),
      Type.Literal("disabled"),
    ]),
    retryAfterMs: Type.Optional(NonNegativeIntegerSchema),
  },
  { additionalProperties: false },
);

export const ClaimLeaseResponseSchema = Type.Union([
  ClaimLeaseGrantedSchema,
  ClaimLeaseNoWorkSchema,
  ClaimLeaseUnavailableSchema,
]);
export type ClaimLeaseResponse = Static<typeof ClaimLeaseResponseSchema>;
