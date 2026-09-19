import {
  type InvestigationTokenUsage,
  type InvestigationUsageCompleteness,
  unavailableInvestigationTokenUsage,
} from "@agentic-review/contracts";

type TokenField = Exclude<keyof InvestigationTokenUsage, "providerCounters">;
type ParsedUsage = { usage: InvestigationTokenUsage; invalid: boolean };

export interface ParsedCliModelUsage {
  usage: InvestigationTokenUsage;
  completeness: InvestigationUsageCompleteness;
  completedTurns: number;
}

const tokenFields = [
  "inputTokens",
  "cachedReadTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheWriteTokens",
  "totalTokens",
] as const satisfies readonly TokenField[];

const aliases: Record<TokenField, readonly string[]> = {
  inputTokens: ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"],
  cachedReadTokens: [
    "cached_input_tokens",
    "cachedInputTokens",
    "cache_read_tokens",
    "cacheReadTokens",
    "cached_read_tokens",
    "cachedReadTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cached_tokens",
    "cachedTokens",
    "input_tokens_details.cached_tokens",
    "inputTokensDetails.cachedTokens",
    "prompt_tokens_details.cached_tokens",
    "promptTokensDetails.cachedTokens",
  ],
  outputTokens: ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"],
  reasoningTokens: [
    "reasoning_tokens",
    "reasoningTokens",
    "reasoning_output_tokens",
    "reasoningOutputTokens",
    "output_tokens_details.reasoning_tokens",
    "outputTokensDetails.reasoningTokens",
    "completion_tokens_details.reasoning_tokens",
    "completionTokensDetails.reasoningTokens",
  ],
  cacheWriteTokens: [
    "cache_write_tokens",
    "cacheWriteTokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_write_input_tokens",
    "cacheWriteInputTokens",
    "cache_creation_tokens",
    "cacheCreationTokens",
  ],
  totalTokens: ["total_tokens", "totalTokens"],
};
const knownCounterPaths = new Set(Object.values(aliases).flat());

/** Parse only CLI-owned accounting records, independently of model-authored response text. */
export function parseCliModelUsage(
  engine: "codex" | "copilot",
  text: string,
  sidecarText?: string,
): ParsedCliModelUsage {
  const aggregate = new UsageAggregate();
  const seenTurns = new Map<string, string>();
  const pendingTurns = new Set<string>();
  let anonymousTurnPending = false;
  let completedTurns = 0;
  let incomplete = false;
  let baseline = zeroUsage();
  let copilotResultSeen = false;

  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const event = parseObject(line);
    if (event === null || typeof event.type !== "string") {
      incomplete = true;
      continue;
    }
    if (engine === "copilot" && !isRootCopilotEvent(event)) continue;
    if (
      [
        "error",
        "turn.failed",
        "turn.cancelled",
        "turn.canceled",
        "abort",
        "session.error",
      ].includes(event.type)
    ) {
      incomplete = true;
      continue;
    }
    if (engine === "codex") {
      const turnId = explicitTurnId(event);
      if (event.type === "turn.started") {
        if (turnId === null) anonymousTurnPending = true;
        else pendingTurns.add(turnId);
        continue;
      }
      // Item and tool events may repeat request metrics and are never billing records.
      if (event.type !== "turn.completed") continue;
      const data = object(event.data);
      const info = object(data?.info) ?? object(event.info);
      const deltaValue = event.usage ?? data?.usage ?? info?.last_token_usage;
      const cumulativeValue = info?.total_token_usage;
      const fingerprint = JSON.stringify([deltaValue, cumulativeValue]);
      if (turnId !== null && seenTurns.has(turnId)) {
        if (seenTurns.get(turnId) !== fingerprint) incomplete = true;
        pendingTurns.delete(turnId);
        continue;
      }
      if (turnId !== null) {
        seenTurns.set(turnId, fingerprint);
        pendingTurns.delete(turnId);
      }
      anonymousTurnPending = false;
      completedTurns++;

      const cumulative = cumulativeValue == null ? null : readUsage(cumulativeValue);
      let delta =
        deltaValue != null
          ? readUsage(deltaValue)
          : cumulative === null
            ? { usage: unavailableInvestigationTokenUsage(), invalid: false }
            : subtractSnapshot(cumulative, baseline);
      if (cumulative !== null) {
        incomplete ||= cumulative.invalid;
        if (!snapshotAgreesWithDelta(baseline, delta.usage, cumulative.usage)) {
          delta = boundDeltaToSnapshot(delta, baseline, cumulative.usage);
        }
      }
      aggregate.add(delta);
      // A cumulative snapshot supplies the baseline, never another additive receipt.
      baseline =
        cumulative === null
          ? addBaseline(baseline, delta.usage)
          : advanceSnapshotBaseline(baseline, cumulative.usage);
      continue;
    }

    if (event.type === "result") {
      if (copilotResultSeen) {
        // Copilot emits a session result, not a per-request usage delta.
        incomplete = true;
        continue;
      }
      copilotResultSeen = true;
      anonymousTurnPending = false;
      completedTurns++;
      incomplete ||= event.exitCode !== undefined && event.exitCode !== 0;
      aggregate.add(readUsage(event.usage));
    } else if (
      ["assistant.turn_start", "assistant.message_start", "assistant.message"].includes(event.type)
    ) {
      anonymousTurnPending = true;
    }
  }

  let selected = aggregate;
  if (engine === "copilot" && sidecarText !== undefined) {
    const sidecar = parseObject(sidecarText);
    const modelMetrics = object(sidecar?.modelMetrics);
    if (modelMetrics === null || Object.keys(modelMetrics).length === 0) {
      incomplete = true;
    } else {
      selected = new UsageAggregate();
      for (const model of Object.values(modelMetrics))
        selected.add(readUsage(object(model)?.usage));
      // agentMetrics and stream results describe subsets of these model totals.
    }
  }

  const result = selected.finish();
  if (selected !== aggregate) {
    const stream = aggregate.finish();
    for (const [key, value] of Object.entries(stream.usage.providerCounters)) {
      if (value !== null && !Object.hasOwn(result.usage.providerCounters, key))
        result.usage.providerCounters[key] = value;
    }
  }
  incomplete ||= anonymousTurnPending || pendingTurns.size > 0 || completedTurns === 0;
  const available =
    tokenFields.some((field) => result.usage[field] !== null) ||
    Object.values(result.usage.providerCounters).some((value) => value !== null);
  return {
    usage: result.usage,
    completeness: !available
      ? "unavailable"
      : incomplete || result.invalid
        ? "partial"
        : "complete",
    completedTurns,
  };
}

function readUsage(value: unknown): ParsedUsage {
  const source = object(value);
  const usage = unavailableInvestigationTokenUsage();
  if (source === null) return { usage, invalid: value != null };
  let invalid = false;
  for (const field of tokenFields) {
    let observed: number | null = null;
    let conflict = false;
    for (const path of aliases[field]) {
      const candidate = propertyPath(source, path);
      if (candidate == null) continue;
      if (!isCount(candidate)) {
        invalid = true;
        conflict = true;
      } else if (observed !== null && observed !== candidate) {
        invalid = true;
        conflict = true;
      } else {
        observed = candidate;
      }
    }
    usage[field] = conflict ? null : observed;
  }
  const counters = new Map<string, number | null>();
  function collectCounters(record: Record<string, unknown>, prefix = "", depth = 0): void {
    for (const [key, candidate] of Object.entries(record)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (knownCounterPaths.has(path) || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(path)) continue;
      if (typeof candidate === "number") {
        counters.set(path, isCount(candidate) ? candidate : null);
        invalid ||= !isCount(candidate);
      } else if (depth < 3 && object(candidate) !== null) {
        collectCounters(candidate as Record<string, unknown>, path, depth + 1);
      }
    }
  }
  collectCounters(source);
  usage.providerCounters = Object.fromEntries(counters);

  if (usage.inputTokens !== null && usage.outputTokens !== null) {
    const derivedTotal = sum(usage.inputTokens, usage.outputTokens);
    if (derivedTotal === null) {
      // The contract forbids an unrepresentable input/output sum even without a total.
      usage.inputTokens = null;
      usage.outputTokens = null;
      invalid = true;
    } else if (usage.totalTokens === null) {
      usage.totalTokens = derivedTotal;
    } else if (usage.totalTokens !== derivedTotal) {
      usage.totalTokens = null;
      invalid = true;
    }
  }
  invalid = enforceSubsets(usage) || invalid;
  return { usage, invalid };
}

class UsageAggregate {
  private readonly usage = unavailableInvestigationTokenUsage();
  private readonly overflows = new Set<string>();
  private readonly coverage = new Map<TokenField, number>();
  private readonly counterCoverage = new Map<string, number>();
  private readonly counters = new Map<string, number | null>();
  private records = 0;
  private invalid = false;

  add(record: ParsedUsage): void {
    this.records++;
    this.invalid ||= record.invalid || record.usage.totalTokens === null;
    for (const field of tokenFields) {
      const value = record.usage[field];
      if (value === null || this.overflows.has(field)) continue;
      this.coverage.set(field, (this.coverage.get(field) ?? 0) + 1);
      const next = this.usage[field] === null ? value : sum(this.usage[field], value);
      if (next === null) {
        this.overflows.add(field);
        this.invalid = true;
      }
      this.usage[field] = next;
    }
    for (const [key, value] of Object.entries(record.usage.providerCounters)) {
      const overflowKey = `providerCounters.${key}`;
      if (this.overflows.has(overflowKey)) continue;
      if (value === null) {
        if (!this.counters.has(key)) this.counters.set(key, null);
        continue;
      }
      this.counterCoverage.set(key, (this.counterCoverage.get(key) ?? 0) + 1);
      const previous = this.counters.get(key);
      const next = previous == null ? value : sum(previous, value);
      if (next === null) {
        this.overflows.add(overflowKey);
        this.invalid = true;
      }
      this.counters.set(key, next);
    }
  }

  finish(): ParsedUsage {
    const usage = {
      ...this.usage,
      providerCounters: Object.fromEntries(
        [...this.counters].map(([key, value]) => [
          key,
          (this.counterCoverage.get(key) ?? 0) < this.records ? null : value,
        ]),
      ),
    };
    // Optional detail counters describe the same complete scope as the total.
    // Missing detail in any receipt is unknown, never an implicit zero.
    for (const field of tokenFields) {
      if (field !== "totalTokens" && (this.coverage.get(field) ?? 0) < this.records)
        usage[field] = null;
    }
    // Partial totals are known lower bounds. Avoid combining incompatible coverage
    // into an apparently exact input/output breakdown of that lower bound.
    if (usage.inputTokens !== null && usage.outputTokens !== null) {
      const derivedTotal = sum(usage.inputTokens, usage.outputTokens);
      if (derivedTotal === null) {
        usage.inputTokens = null;
        usage.outputTokens = null;
        this.invalid = true;
      } else if (usage.totalTokens !== null && usage.totalTokens !== derivedTotal) {
        if ((this.coverage.get("inputTokens") ?? 0) < this.records) usage.inputTokens = null;
        if ((this.coverage.get("outputTokens") ?? 0) < this.records) usage.outputTokens = null;
        if (usage.inputTokens !== null && usage.outputTokens !== null) {
          usage.totalTokens = null;
          this.invalid = true;
        }
      }
    }
    this.invalid = enforceSubsets(usage) || this.invalid;
    return { usage, invalid: this.invalid || this.records === 0 };
  }
}

function subtractSnapshot(snapshot: ParsedUsage, baseline: InvestigationTokenUsage): ParsedUsage {
  const usage = unavailableInvestigationTokenUsage();
  let invalid = snapshot.invalid;
  for (const field of tokenFields) {
    const current = snapshot.usage[field],
      previous = baseline[field];
    if (current === null || previous === null) continue;
    if (current < previous) invalid = true;
    else usage[field] = current - previous;
  }
  const counters = new Map<string, number | null>();
  for (const [key, current] of Object.entries(snapshot.usage.providerCounters)) {
    const previous = ownCounter(baseline.providerCounters, key);
    if (previous === null) continue;
    if (current === null) counters.set(key, null);
    else if (current < (previous ?? 0)) {
      counters.set(key, null);
      invalid = true;
    } else counters.set(key, current - (previous ?? 0));
  }
  usage.providerCounters = Object.fromEntries(counters);
  invalid = enforceSubsets(usage) || invalid;
  return { usage, invalid };
}

function addBaseline(
  baseline: InvestigationTokenUsage,
  delta: InvestigationTokenUsage,
): InvestigationTokenUsage {
  const next = unavailableInvestigationTokenUsage();
  for (const field of tokenFields) {
    const previous = baseline[field],
      current = delta[field];
    next[field] = previous === null || current === null ? null : sum(previous, current);
  }
  const counters = new Map<string, number | null>();
  for (const key of new Set([
    ...Object.keys(baseline.providerCounters),
    ...Object.keys(delta.providerCounters),
  ])) {
    const previous = ownCounter(baseline.providerCounters, key);
    const current = ownCounter(delta.providerCounters, key);
    counters.set(key, previous === null || current == null ? null : sum(previous ?? 0, current));
  }
  next.providerCounters = Object.fromEntries(counters);
  return next;
}

function advanceSnapshotBaseline(
  previous: InvestigationTokenUsage,
  current: InvestigationTokenUsage,
): InvestigationTokenUsage {
  const next = { ...current, providerCounters: { ...current.providerCounters } };
  // A decreasing counter indicates a reset or another scope. Require a fresh
  // baseline before accepting another difference from that counter.
  for (const field of tokenFields) {
    const before = previous[field],
      after = current[field];
    if (before !== null && after !== null && after < before) next[field] = null;
  }
  for (const [key, after] of Object.entries(current.providerCounters)) {
    const before = ownCounter(previous.providerCounters, key);
    if (before != null && after !== null && after < before) next.providerCounters[key] = null;
  }
  for (const key of Object.keys(previous.providerCounters)) {
    if (!Object.hasOwn(current.providerCounters, key)) next.providerCounters[key] = null;
  }
  return next;
}

function snapshotAgreesWithDelta(
  baseline: InvestigationTokenUsage,
  delta: InvestigationTokenUsage,
  snapshot: InvestigationTokenUsage,
): boolean {
  for (const field of tokenFields) {
    const before = baseline[field],
      increment = delta[field],
      after = snapshot[field];
    if (before === null || after === null) continue;
    if (after < before || (increment !== null && sum(before, increment) !== after)) return false;
  }
  for (const [key, after] of Object.entries(snapshot.providerCounters)) {
    const previous = ownCounter(baseline.providerCounters, key);
    const increment = ownCounter(delta.providerCounters, key);
    if (previous === null || after === null) continue;
    const before = previous ?? 0;
    if (after < before || (increment != null && sum(before, increment) !== after)) return false;
  }
  return true;
}

function boundDeltaToSnapshot(
  delta: ParsedUsage,
  baseline: InvestigationTokenUsage,
  snapshot: InvestigationTokenUsage,
): ParsedUsage {
  const usage = { ...delta.usage, providerCounters: { ...delta.usage.providerCounters } };
  // Conflicting records cannot establish an exact charge. Preserve only a lower
  // bound supported by both the reported delta and the cumulative difference.
  for (const field of tokenFields) {
    const before = baseline[field],
      after = snapshot[field],
      increment = usage[field];
    if (before === null || after === null || increment === null) continue;
    usage[field] = after < before ? null : Math.min(increment, after - before);
  }
  for (const [key, increment] of Object.entries(usage.providerCounters)) {
    const previous = ownCounter(baseline.providerCounters, key);
    const after = ownCounter(snapshot.providerCounters, key);
    if (previous === null || after == null || increment === null) continue;
    const before = previous ?? 0;
    usage.providerCounters[key] = after < before ? null : Math.min(increment, after - before);
  }
  enforceSubsets(usage);
  return { usage, invalid: true };
}

function enforceSubsets(usage: InvestigationTokenUsage): boolean {
  let invalid = false;
  if (
    usage.inputTokens !== null &&
    usage.cachedReadTokens !== null &&
    usage.cachedReadTokens > usage.inputTokens
  ) {
    usage.cachedReadTokens = null;
    invalid = true;
  }
  if (
    usage.outputTokens !== null &&
    usage.reasoningTokens !== null &&
    usage.reasoningTokens > usage.outputTokens
  ) {
    usage.reasoningTokens = null;
    invalid = true;
  }
  return invalid;
}

function zeroUsage(): InvestigationTokenUsage {
  return {
    inputTokens: 0,
    cachedReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    providerCounters: {},
  };
}

function explicitTurnId(event: Record<string, unknown>): string | null {
  const data = object(event.data);
  const value = event.turn_id ?? event.turnId ?? data?.turn_id ?? data?.turnId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRootCopilotEvent(event: Record<string, unknown>): boolean {
  return event.agentId == null && object(event.data)?.parentToolCallId == null;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(text));
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function propertyPath(source: Record<string, unknown>, path: string): unknown {
  let value: unknown = source;
  for (const key of path.split(".")) value = object(value)?.[key];
  return value;
}

function ownCounter(
  counters: Record<string, number | null>,
  key: string,
): number | null | undefined {
  return Object.hasOwn(counters, key) ? counters[key] : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sum(first: number, second: number): number | null {
  const value = first + second;
  return Number.isSafeInteger(value) ? value : null;
}
