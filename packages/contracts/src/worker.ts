import { type Static, Type } from "@sinclair/typebox";

import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  ProtocolVersionSchema,
  Sha256Schema,
} from "./common.js";
import { ExecutionPhaseSchema, WorkerStateSchema } from "./states.js";

export const WorkerArchitectureSchema = Type.Union([Type.Literal("x64"), Type.Literal("arm64")]);
export type WorkerArchitecture = Static<typeof WorkerArchitectureSchema>;

export const WorkerCapabilitiesSchema = Type.Object(
  {
    operatingSystem: Type.Literal("windows"),
    architecture: WorkerArchitectureSchema,
    headless: Type.Boolean(),
    interactiveDesktop: Type.Boolean(),
    codexVersion: Type.String({ minLength: 1, maxLength: 128 }),
    recipeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 256,
      uniqueItems: true,
    }),
    labels: Type.Record(
      Type.String({ minLength: 1, maxLength: 64 }),
      Type.String({ maxLength: 256 }),
      { maxProperties: 64 },
    ),
  },
  { additionalProperties: false },
);
export type WorkerCapabilities = Static<typeof WorkerCapabilitiesSchema>;

export const WorkerRegistrationRequestSchema = Type.Object(
  {
    protocolVersion: ProtocolVersionSchema,
    workerNodeId: EntityIdSchema,
    workerInstanceId: EntityIdSchema,
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    workerVersion: Type.String({ minLength: 1, maxLength: 128 }),
    maxSlots: PositiveIntegerSchema,
    capabilities: WorkerCapabilitiesSchema,
  },
  { additionalProperties: false },
);
export type WorkerRegistrationRequest = Static<typeof WorkerRegistrationRequestSchema>;

export const WorkerRegistrationResponseSchema = Type.Object(
  {
    protocolVersion: ProtocolVersionSchema,
    workerId: EntityIdSchema,
    state: WorkerStateSchema,
    heartbeatIntervalMs: PositiveIntegerSchema,
    leaseTtlMs: PositiveIntegerSchema,
    serverTime: DateTimeSchema,
  },
  { additionalProperties: false },
);
export type WorkerRegistrationResponse = Static<typeof WorkerRegistrationResponseSchema>;

export const LeaseIdentitySchema = Type.Object(
  {
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    workerNodeId: EntityIdSchema,
    workerInstanceId: EntityIdSchema,
    leaseToken: Type.String({ minLength: 32, maxLength: 1_024 }),
    leaseGeneration: PositiveIntegerSchema,
  },
  { additionalProperties: false },
);
export type LeaseIdentity = Static<typeof LeaseIdentitySchema>;

export const ActiveLeaseHeartbeatSchema = Type.Composite(
  [
    LeaseIdentitySchema,
    Type.Object(
      {
        phase: ExecutionPhaseSchema,
        progressSequence: NonNegativeIntegerSchema,
        lastProgressAt: DateTimeSchema,
        elapsedMs: NonNegativeIntegerSchema,
        processCount: NonNegativeIntegerSchema,
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type ActiveLeaseHeartbeat = Static<typeof ActiveLeaseHeartbeatSchema>;

export const WorkerHeartbeatRequestSchema = Type.Object(
  {
    protocolVersion: ProtocolVersionSchema,
    workerNodeId: EntityIdSchema,
    workerInstanceId: EntityIdSchema,
    heartbeatSequence: NonNegativeIntegerSchema,
    observedAt: DateTimeSchema,
    availableSlots: NonNegativeIntegerSchema,
    activeLeases: Type.Array(ActiveLeaseHeartbeatSchema, { maxItems: 64 }),
    health: Type.Object(
      {
        state: WorkerStateSchema,
        freeDiskBytes: NonNegativeIntegerSchema,
        memoryUsageBytes: NonNegativeIntegerSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type WorkerHeartbeatRequest = Static<typeof WorkerHeartbeatRequestSchema>;

export const LeaseCommandActionSchema = Type.Union([
  Type.Literal("continue"),
  Type.Literal("cancel"),
  Type.Literal("stale"),
  Type.Literal("drain"),
  Type.Literal("upgrade_required"),
]);
export type LeaseCommandAction = Static<typeof LeaseCommandActionSchema>;

export const LeaseCommandSchema = Type.Object(
  {
    runAttemptId: EntityIdSchema,
    leaseGeneration: PositiveIntegerSchema,
    action: LeaseCommandActionSchema,
    leaseExpiresAt: Type.Union([DateTimeSchema, Type.Null()]),
    reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type LeaseCommand = Static<typeof LeaseCommandSchema>;

export const WorkerHeartbeatResponseSchema = Type.Object(
  {
    serverTime: DateTimeSchema,
    nextHeartbeatInMs: PositiveIntegerSchema,
    workerState: WorkerStateSchema,
    commands: Type.Array(LeaseCommandSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
);
export type WorkerHeartbeatResponse = Static<typeof WorkerHeartbeatResponseSchema>;

export const ClaimLeaseRequestSchema = Type.Object(
  {
    protocolVersion: ProtocolVersionSchema,
    workerNodeId: EntityIdSchema,
    workerInstanceId: EntityIdSchema,
    availableSlots: PositiveIntegerSchema,
    waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
    capabilitiesDigest: Sha256Schema,
  },
  { additionalProperties: false },
);
export type ClaimLeaseRequest = Static<typeof ClaimLeaseRequestSchema>;

export const RunCompletionSubmissionSchema = Type.Composite(
  [
    LeaseIdentitySchema,
    Type.Object(
      {
        resultDigest: Sha256Schema,
        result: Type.Unknown(),
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type RunCompletionSubmission = Static<typeof RunCompletionSubmissionSchema>;

export const RunFailureSubmissionSchema = Type.Composite(
  [
    LeaseIdentitySchema,
    Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 128 }),
        message: Type.String({ minLength: 1, maxLength: 2_048 }),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  ],
  { additionalProperties: false },
);
export type RunFailureSubmission = Static<typeof RunFailureSubmissionSchema>;

export const RunTerminalResponseSchema = Type.Object(
  {
    jobId: EntityIdSchema,
    runAttemptId: EntityIdSchema,
    jobState: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("retry_waiting"),
      Type.Literal("cancelled"),
      Type.Literal("failed"),
      Type.Literal("dead_letter"),
    ]),
    runState: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
  },
  { additionalProperties: false },
);
export type RunTerminalResponse = Static<typeof RunTerminalResponseSchema>;
