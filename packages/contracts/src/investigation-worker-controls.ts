import { type Static, Type } from "@sinclair/typebox";
import { DateTimeSchema, EntityIdSchema, PositiveIntegerSchema } from "./common.js";
import {
  type InvestigationTaskKind,
  InvestigationTaskKindSchema,
  type InvestigationTaskV1,
} from "./investigation.js";

const kinds = Type.Array(InvestigationTaskKindSchema, { uniqueItems: true });

/** Worker controls constrain task assignment, not local model tools or screen capture. */
export const InvestigationWorkerControlSchema = Type.Object(
  {
    id: EntityIdSchema,
    repositoryIds: Type.Array(EntityIdSchema, { uniqueItems: true }),
    e2eEnabled: Type.Boolean(),
    version: PositiveIntegerSchema,
    updatedAt: DateTimeSchema,
    updatedBy: Type.Union([EntityIdSchema, Type.Null()]),
    lastSeenAt: Type.Union([DateTimeSchema, Type.Null()]),
    advertisedKinds: Type.Union([kinds, Type.Null()]),
    effectiveKinds: kinds,
    status: Type.Union([
      Type.Literal("e2e_enabled"),
      Type.Literal("static_only"),
      Type.Literal("disabling"),
      Type.Literal("awaiting_confirmation"),
    ]),
    activeE2eTaskIds: Type.Array(EntityIdSchema, { uniqueItems: true }),
    cleanupPendingAttemptIds: Type.Array(EntityIdSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);
export type InvestigationWorkerControl = Static<typeof InvestigationWorkerControlSchema>;
export const InvestigationWorkerControlListSchema = Type.Object(
  { items: Type.Array(InvestigationWorkerControlSchema) },
  { additionalProperties: false },
);
export type InvestigationWorkerControlList = Static<typeof InvestigationWorkerControlListSchema>;

export const InvestigationWorkerControlUpdateSchema = Type.Object(
  { version: PositiveIntegerSchema, e2eEnabled: Type.Boolean() },
  { additionalProperties: false },
);
export type InvestigationWorkerControlUpdate = Static<
  typeof InvestigationWorkerControlUpdateSchema
>;

export const InvestigationWorkerPolicyRequestSchema = Type.Object(
  { supportedKinds: Type.Array(InvestigationTaskKindSchema, { minItems: 1, uniqueItems: true }) },
  { additionalProperties: false },
);
export type InvestigationWorkerPolicyRequest = Static<
  typeof InvestigationWorkerPolicyRequestSchema
>;
export const InvestigationWorkerPolicySchema = Type.Object(
  {
    workerId: EntityIdSchema,
    version: PositiveIntegerSchema,
    e2eEnabled: Type.Boolean(),
    effectiveKinds: kinds,
  },
  { additionalProperties: false },
);
export type InvestigationWorkerPolicy = Static<typeof InvestigationWorkerPolicySchema>;

export function isInvestigationStaticTaskKind(kind: InvestigationTaskKind): boolean {
  return kind === "pr-review" || kind === "issue-investigate";
}

/** Saved execution tasks and malformed static tasks must use the execution admission boundary. */
export function investigationTaskRequiresE2e(
  task: Pick<InvestigationTaskV1, "kind" | "executionPolicy">,
): boolean {
  return !isInvestigationStaticTaskKind(task.kind) || task.executionPolicy.mode === "execute";
}
