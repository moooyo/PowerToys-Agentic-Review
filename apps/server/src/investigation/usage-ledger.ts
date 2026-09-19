import {
  type InvestigationModelInvocationReceipt,
  InvestigationModelInvocationReceiptSchema,
  type InvestigationTokenUsage,
  type InvestigationUsageSummary,
  unavailableInvestigationTokenUsage,
  validateInvestigationTokenUsage,
} from "@agentic-review/contracts";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { InvestigationStore } from "./store.js";

const namespace = "model-usage:v1:";
export const investigationUsagePublicationPendingPrefix = `${namespace}publication-pending:`;
export const investigationUsagePublicationPendingKey = (taskId: string): string =>
  `${investigationUsagePublicationPendingPrefix}${encode(taskId)}`;
const tokenFields = [
  "inputTokens",
  "cachedReadTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheWriteTokens",
  "totalTokens",
] as const;
const identityFields = [
  "invocationId",
  "taskId",
  "attemptId",
  "purpose",
  "engine",
  "model",
  "startedAt",
] as const;
const activeStates = new Set(["registered", "running"]);
type Baseline = { readonly taskId: string; readonly tokens: number; readonly unknown?: boolean };

export class InvestigationUsageLedgerError extends Error {
  constructor(
    readonly code: "INVALID_USAGE" | "USAGE_CONFLICT" | "USAGE_SEQUENCE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "InvestigationUsageLedgerError";
  }
}

/** The caller authenticates the Worker and binds the receipt to the task and attempt. */
export function recordInvestigationUsage(
  store: InvestigationStore,
  receipt: InvestigationModelInvocationReceipt,
  legacyTokens: number,
  legacyUnknown = false,
): {
  receipt: InvestigationModelInvocationReceipt;
  summary: InvestigationUsageSummary;
  duplicate: boolean;
} {
  const write = () => {
    assertReceipt(receipt);
    assertCount(legacyTokens);
    const latestKey = `${namespace}invocation:${encode(receipt.invocationId)}`;
    const receiptKey = `${latestKey}:revision:${receipt.revision}`;
    const retained = store.get<InvestigationModelInvocationReceipt>("idempotency", receiptKey);
    if (retained !== undefined) {
      if (canonical(retained) !== canonical(receipt))
        conflict("The invocation revision was already recorded with different content.");
      return {
        receipt: structuredClone(retained),
        summary: investigationUsageSummary(store, receipt.taskId, legacyTokens, legacyUnknown),
        duplicate: true,
      };
    }
    const previous = store.get<InvestigationModelInvocationReceipt>("idempotency", latestKey);
    if (previous === undefined) {
      if (receipt.revision !== 1 || receipt.state !== "registered")
        throw new InvestigationUsageLedgerError(
          "USAGE_SEQUENCE_INVALID",
          "An invocation must be durably registered before execution.",
        );
    } else {
      if (identityFields.some((field) => previous[field] !== receipt[field]))
        conflict("An invocation cannot change its execution identity.");
      if (receipt.revision !== previous.revision + 1)
        throw new InvestigationUsageLedgerError(
          "USAGE_SEQUENCE_INVALID",
          "Invocation receipts must be delivered in revision order.",
        );
      assertTransition(previous, receipt);
    }
    const baselineKey = `${taskPrefix(receipt.taskId)}baseline`;
    if (!store.has("idempotency", baselineKey)) {
      store.insert<Baseline>("idempotency", baselineKey, {
        taskId: receipt.taskId,
        tokens: legacyTokens,
        unknown: legacyUnknown,
      });
    }
    store.insert("idempotency", receiptKey, receipt);
    store.put("idempotency", latestKey, receipt);
    store.put(
      "idempotency",
      `${taskPrefix(receipt.taskId)}latest:${encode(receipt.invocationId)}`,
      receipt,
    );
    const notificationId = investigationUsagePublicationPendingKey(receipt.taskId);
    store.put("idempotency", notificationId, { id: notificationId, taskId: receipt.taskId });
    return {
      receipt: structuredClone(receipt),
      summary: investigationUsageSummary(store, receipt.taskId, legacyTokens, legacyUnknown),
      duplicate: false,
    };
  };
  return store.inTransaction ? write() : store.transaction(write);
}

/** The pre-ledger checkpoint is frozen once, never added again after each analysis round. */
export function investigationUsageSummary(
  store: InvestigationStore,
  taskId: string,
  fallbackLegacyTokens = 0,
  fallbackLegacyUnknown = false,
  verifiedEmptyLegacyBaseline = false,
): InvestigationUsageSummary {
  assertCount(fallbackLegacyTokens);
  const baseline = store.get<Baseline>("idempotency", `${taskPrefix(taskId)}baseline`);
  const legacyTokens = baseline?.tokens ?? fallbackLegacyTokens;
  // Old receipts remain immutable. A caller may resolve the empty baseline only
  // after proving every uncovered attempt ended before any model dispatch.
  const legacyUnknown =
    legacyTokens === 0 && verifiedEmptyLegacyBaseline
      ? false
      : (baseline?.unknown ?? fallbackLegacyUnknown);
  const receipts = investigationUsageInvocations(store, taskId);
  const usage = unavailableInvestigationTokenUsage();
  let reportedTokens = legacyTokens;
  for (const receipt of receipts)
    reportedTokens = sum(reportedTokens, receipt.usage.totalTokens ?? 0);
  const activeInvocationCount = receipts.filter((receipt) =>
    activeStates.has(receipt.state),
  ).length;
  const unknownInvocationCount = receipts.filter(
    (receipt) => receipt.completeness !== "complete",
  ).length;
  for (const field of tokenFields) {
    if (field !== "totalTokens" && (legacyTokens > 0 || legacyUnknown)) continue;
    if (receipts.length === 0) continue;
    if (receipts.some((receipt) => receipt.usage[field] === null)) continue;
    usage[field] = receipts.reduce(
      (total, receipt) => sum(total, receipt.usage[field]!),
      field === "totalTokens" ? legacyTokens : 0,
    );
  }
  if (unknownInvocationCount !== 0 || activeInvocationCount !== 0 || legacyUnknown)
    usage.totalTokens = null;
  else if (receipts.length === 0) usage.totalTokens = legacyTokens;
  const counterNames = new Set(
    receipts.flatMap((receipt) => Object.keys(receipt.usage.providerCounters)),
  );
  for (const name of counterNames) {
    const values = receipts.map((receipt) =>
      Object.hasOwn(receipt.usage.providerCounters, name)
        ? (receipt.usage.providerCounters[name] ?? null)
        : null,
    );
    usage.providerCounters[name] =
      legacyTokens > 0 || legacyUnknown || values.some((value) => value === null)
        ? null
        : values.reduce<number>((total, value) => sum(total, value!), 0);
  }
  const anyReported =
    legacyTokens > 0 ||
    receipts.some((receipt) => tokenFields.some((field) => receipt.usage[field] !== null));
  return {
    usage,
    reportedTokens,
    legacyTokens,
    invocationCount: receipts.length,
    activeInvocationCount,
    unknownInvocationCount,
    completeness:
      unknownInvocationCount === 0 &&
      activeInvocationCount === 0 &&
      legacyTokens === 0 &&
      !legacyUnknown
        ? "complete"
        : anyReported
          ? "partial"
          : "unavailable",
  };
}

export function investigationUsageInvocations(
  store: InvestigationStore,
  taskId: string,
): InvestigationModelInvocationReceipt[] {
  const prefix = `${taskPrefix(taskId)}latest:`;
  const result: InvestigationModelInvocationReceipt[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = store.pagePrefix<InvestigationModelInvocationReceipt>(
      "idempotency",
      prefix,
      1_000,
      false,
      cursor,
    );
    result.push(...page);
    if (page.length < 1_000) return result;
    cursor = `${prefix}${encode(page[page.length - 1]!.invocationId)}`;
  }
}

function assertReceipt(receipt: InvestigationModelInvocationReceipt): void {
  // The usage endpoint can be the first TypeBox value check in a fresh Server.
  // Fastify's JSON schema formats do not initialize TypeBox's separate registry.
  if (!FormatRegistry.Has("date-time"))
    FormatRegistry.Set("date-time", (value) => Number.isFinite(Date.parse(value)));
  if (
    !Value.Check(InvestigationModelInvocationReceiptSchema, receipt) ||
    !validateInvestigationTokenUsage(receipt.usage)
  )
    throw new InvestigationUsageLedgerError(
      "INVALID_USAGE",
      "The invocation token receipt is invalid.",
    );
  if (Date.parse(receipt.updatedAt) < Date.parse(receipt.startedAt))
    conflict("An invocation update cannot precede its registration.");
  if (receipt.completeness === "complete" && receipt.usage.totalTokens === null)
    conflict("Complete usage requires a reported total.");
  if (
    receipt.completeness === "unavailable" &&
    (tokenFields.some((field) => receipt.usage[field] !== null) ||
      Object.values(receipt.usage.providerCounters).some((value) => value !== null))
  )
    conflict("Unavailable usage cannot claim reported counters.");
  if (
    receipt.state === "registered" &&
    (receipt.completeness !== "unavailable" ||
      tokenFields.some((field) => receipt.usage[field] !== null))
  )
    conflict("Registration cannot claim token usage before the model starts.");
}

function assertTransition(
  previous: InvestigationModelInvocationReceipt,
  next: InvestigationModelInvocationReceipt,
): void {
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt))
    conflict("Invocation timestamps cannot move backwards.");
  if (!activeStates.has(previous.state) && previous.state !== next.state)
    conflict("An invocation cannot change its terminal outcome.");
  if (previous.state === "running" && next.state === "registered")
    conflict("An invocation cannot return to registration.");
  if (previous.disposition !== "pending" && previous.disposition !== next.disposition)
    conflict("The recorded analysis disposition is immutable.");
  if (previous.completeness === "complete" && next.completeness !== "complete")
    conflict("A complete usage receipt cannot become incomplete.");
  const oldValues: Record<string, number | null> = { ...previous.usage.providerCounters };
  const newValues: Record<string, number | null> = { ...next.usage.providerCounters };
  for (const field of tokenFields) {
    oldValues[`token.${field}`] = previous.usage[field];
    newValues[`token.${field}`] = next.usage[field];
  }
  for (const [field, before] of Object.entries(oldValues)) {
    if (before === null) continue;
    const after = Object.hasOwn(newValues, field) ? newValues[field] : undefined;
    if (
      after === undefined ||
      after === null ||
      after < before ||
      (previous.completeness === "complete" && after !== before)
    )
      conflict("An invocation usage counter cannot lose or repeat already reported consumption.");
  }
}

function assertCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new InvestigationUsageLedgerError(
      "INVALID_USAGE",
      "Token counts must be nonnegative safe integers.",
    );
}
function sum(a: number, b: number): number {
  const total = a + b;
  assertCount(total);
  return total;
}
function conflict(message: string): never {
  throw new InvestigationUsageLedgerError("USAGE_CONFLICT", message);
}
function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}
function taskPrefix(taskId: string): string {
  return `${namespace}task:${encode(taskId)}:`;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}
