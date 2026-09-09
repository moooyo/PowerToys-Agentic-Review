import {
  maximumSchedulingActiveLeases,
  maximumSchedulingQueuedJobs,
  type SchedulingLimits,
} from "@agentic-review/contracts";

export interface SchedulingLimitValues {
  activeUnlimited: boolean;
  activeLimit: string;
  queueUnlimited: boolean;
  queueLimit: string;
}

export function schedulingLimitValues(limits: SchedulingLimits): SchedulingLimitValues {
  return {
    activeUnlimited: limits.maxActiveLeases === null,
    activeLimit: limits.maxActiveLeases?.toString() ?? "1",
    queueUnlimited: limits.maxQueuedJobs === null,
    queueLimit: limits.maxQueuedJobs?.toString() ?? "1",
  };
}

export function parseSchedulingLimit(value: string, maximum: number, label: string): number {
  const text = value.trim();
  const parsed = Number(text);
  if (!/^[0-9]+$/u.test(text) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error(
      `${label} must be a whole number between 1 and ${maximum.toLocaleString("en-US")}.`,
    );
  return parsed;
}

export function buildSchedulingLimits(values: SchedulingLimitValues): SchedulingLimits {
  return {
    maxActiveLeases: values.activeUnlimited
      ? null
      : parseSchedulingLimit(
          values.activeLimit,
          maximumSchedulingActiveLeases,
          "Active lease limit",
        ),
    maxQueuedJobs: values.queueUnlimited
      ? null
      : parseSchedulingLimit(
          values.queueLimit,
          maximumSchedulingQueuedJobs,
          "Admitted queue limit",
        ),
  };
}

export function schedulingLimitsLabel(value: number | null): string {
  return value === null ? "Unlimited at this scope" : value.toLocaleString("en-US");
}
