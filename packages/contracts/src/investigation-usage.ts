import { type Static, type TProperties, Type } from "@sinclair/typebox";
import {
  DateTimeSchema,
  EntityIdSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common.js";

const object = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const count = Type.Union([NonNegativeIntegerSchema, Type.Null()]);

/** Cache reads are included in input; reasoning is included in output. Never add them twice. */
export const InvestigationTokenUsageSchema = object({
  inputTokens: count,
  cachedReadTokens: count,
  outputTokens: count,
  reasoningTokens: count,
  cacheWriteTokens: count,
  totalTokens: count,
  providerCounters: Type.Record(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,127}$" }), count),
});
export type InvestigationTokenUsage = Static<typeof InvestigationTokenUsageSchema>;
export const InvestigationUsageCompletenessSchema = Type.Union([
  Type.Literal("complete"),
  Type.Literal("partial"),
  Type.Literal("unavailable"),
]);
export type InvestigationUsageCompleteness = Static<typeof InvestigationUsageCompletenessSchema>;
export const InvestigationInvocationPurposeSchema = Type.Union([
  Type.Literal("analysis"),
  Type.Literal("model_edit"),
  Type.Literal("planning"),
  Type.Literal("e2e"),
  Type.Literal("recheck"),
]);
export type InvestigationInvocationPurpose = Static<typeof InvestigationInvocationPurposeSchema>;

const identity = {
  invocationId: EntityIdSchema,
  taskId: EntityIdSchema,
  attemptId: EntityIdSchema,
  purpose: InvestigationInvocationPurposeSchema,
  engine: Type.Union([Type.Literal("codex"), Type.Literal("copilot")]),
  model: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  startedAt: DateTimeSchema,
};
export const InvestigationModelInvocationIdentitySchema = object(identity);
export type InvestigationModelInvocationIdentity = Static<
  typeof InvestigationModelInvocationIdentitySchema
>;
export const InvestigationModelInvocationReceiptSchema = object({
  ...identity,
  revision: PositiveIntegerSchema,
  updatedAt: DateTimeSchema,
  state: Type.Union([
    Type.Literal("registered"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  disposition: Type.Union([
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("rejected"),
    Type.Literal("not_applicable"),
  ]),
  completeness: InvestigationUsageCompletenessSchema,
  usage: InvestigationTokenUsageSchema,
});
export type InvestigationModelInvocationReceipt = Static<
  typeof InvestigationModelInvocationReceiptSchema
>;
export const InvestigationUsageSummarySchema = object({
  usage: InvestigationTokenUsageSchema,
  /** Sum of known invocation totals, including the immutable pre-ledger baseline. */
  reportedTokens: NonNegativeIntegerSchema,
  completeness: InvestigationUsageCompletenessSchema,
  invocationCount: NonNegativeIntegerSchema,
  activeInvocationCount: NonNegativeIntegerSchema,
  unknownInvocationCount: NonNegativeIntegerSchema,
  legacyTokens: NonNegativeIntegerSchema,
});
export type InvestigationUsageSummary = Static<typeof InvestigationUsageSummarySchema>;

export function unavailableInvestigationTokenUsage(): InvestigationTokenUsage {
  return {
    inputTokens: null,
    cachedReadTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    providerCounters: {},
  };
}

/** Additional semantic checks used by both receipt ingestion and the durable Worker journal. */
export function validateInvestigationTokenUsage(usage: InvestigationTokenUsage): boolean {
  if (
    usage.inputTokens !== null &&
    usage.cachedReadTokens !== null &&
    usage.cachedReadTokens > usage.inputTokens
  )
    return false;
  if (
    usage.outputTokens !== null &&
    usage.reasoningTokens !== null &&
    usage.reasoningTokens > usage.outputTokens
  )
    return false;
  if (usage.inputTokens !== null && usage.outputTokens !== null) {
    const total = usage.inputTokens + usage.outputTokens;
    if (!Number.isSafeInteger(total) || (usage.totalTokens !== null && usage.totalTokens !== total))
      return false;
  }
  return true;
}
