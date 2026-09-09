import {
  validationExecutorCapabilityLabels,
  type WorkerCapabilities,
  WorkerCapabilitiesSchema,
  workerModelExecutionDisabledLabel,
  workerModelExecutionDisabledValue,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { WorkerExecutionConfig } from "../config.js";
import {
  type ProcessResourceLimits,
  ProcessResourceLimitsSchema,
} from "./process-host-protocol.js";

export interface ExecutionRuntimeReadiness {
  readonly execution: boolean;
  readonly envelopeV2: boolean;
  readonly headless: boolean;
  readonly web: boolean;
  readonly windowsDesktop: boolean;
  readonly evidenceDelivery: boolean;
  readonly reproduction?: boolean;
  readonly structuredProbes?: boolean;
  readonly uiObservations?: boolean;
  readonly modelExecution?: boolean;
}

const reserved = new Set([
  "execution",
  "processhost",
  "executionenvelope",
  "validationheadless",
  "validationweb",
  "validationwindowsdesktop",
  "validationevaluation",
  "evidencedelivery",
  "issuereproduction",
  "structuredprobeoutput",
  "uiassertionobservation",
  workerModelExecutionDisabledLabel.toLowerCase(),
]);

/** Deployment labels cannot claim executable support or an available interactive desktop. */
export function createRuntimeCapabilities(
  base: WorkerCapabilities,
  readiness: ExecutionRuntimeReadiness,
): WorkerCapabilities {
  const labels = Object.fromEntries(
    Object.entries(base.labels).filter(([name]) => {
      const key = name.toLowerCase();
      return !reserved.has(key) && !key.startsWith("ui:");
    }),
  );
  labels.execution = readiness.execution ? "enabled" : "disabled";
  labels.processHost = readiness.execution ? "available" : "unavailable";
  if (readiness.modelExecution === false)
    labels[workerModelExecutionDisabledLabel] = workerModelExecutionDisabledValue;
  const envelopeV2 = readiness.execution && readiness.envelopeV2;
  const headless = envelopeV2 && readiness.headless;
  const evidenceDelivery = envelopeV2 && readiness.evidenceDelivery;
  const web = envelopeV2 && evidenceDelivery && readiness.web;
  const windowsDesktop = envelopeV2 && evidenceDelivery && readiness.windowsDesktop;
  if (envelopeV2) labels[validationExecutorCapabilityLabels.envelope] = "2";
  if (envelopeV2 && readiness.reproduction)
    labels[validationExecutorCapabilityLabels.reproduction] = "1";
  if (envelopeV2 && readiness.structuredProbes)
    labels[validationExecutorCapabilityLabels.probes] = "1";
  if ((web || windowsDesktop) && readiness.uiObservations)
    labels[validationExecutorCapabilityLabels.uiObservations] = "1";
  if (headless) labels[validationExecutorCapabilityLabels.headless] = "1";
  if (evidenceDelivery) labels.evidenceDelivery = "1";
  if (web) {
    labels[validationExecutorCapabilityLabels.web] = "1";
    labels["ui:web"] = "1";
  }
  if (windowsDesktop) {
    labels[validationExecutorCapabilityLabels.windows_desktop] = "1";
    labels["ui:windows_desktop"] = "1";
  }
  const capabilities: WorkerCapabilities = {
    ...base,
    ...(readiness.modelExecution === false ? { codexVersion: "not-configured" } : {}),
    headless: readiness.execution && (base.headless || headless || web),
    interactiveDesktop: windowsDesktop,
    recipeIds: [...base.recipeIds],
    labels,
  };
  if (!Value.Check(WorkerCapabilitiesSchema, capabilities)) {
    throw new TypeError("Prepared Worker capabilities exceed the registration contract limits.");
  }
  Object.freeze(capabilities.recipeIds);
  Object.freeze(capabilities.labels);
  return Object.freeze(capabilities);
}

export function validationProcessLimits(
  execution: WorkerExecutionConfig,
  maxSlots: number,
  concurrentTreesPerSlot: 1 | 2,
  requested: ProcessResourceLimits = execution.modelExecutionEnabled === false
    ? {
        hardTimeoutMs: execution.validationMaximumHardTimeoutMs,
        ...execution.validationResourceLimits,
      }
    : { hardTimeoutMs: execution.codexMaximumHardTimeoutMs, ...execution.codexResourceLimits },
): ProcessResourceLimits {
  if (!Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots * concurrentTreesPerSlot > 64) {
    throw new RangeError("Validation slots exceed the 64 concurrent ProcessHost request limit.");
  }
  const concurrentTrees = maxSlots * concurrentTreesPerSlot;
  const limits = {
    hardTimeoutMs: requested.hardTimeoutMs,
    maximumProcessCount: Math.min(
      requested.maximumProcessCount,
      Math.floor(execution.totalResourceBudget.maximumProcessCount / concurrentTrees),
    ),
    maximumMemoryBytes: Math.min(
      requested.maximumMemoryBytes,
      Math.floor(execution.totalResourceBudget.maximumMemoryBytes / concurrentTrees),
    ),
    maximumOutputBytes: Math.min(
      requested.maximumOutputBytes,
      Math.floor(execution.totalResourceBudget.maximumOutputBytes / concurrentTrees),
    ),
  };
  if (!Value.Check(ProcessResourceLimitsSchema, limits)) {
    throw new RangeError(
      "The Worker execution budget cannot support the configured validation concurrency.",
    );
  }
  return Object.freeze(limits);
}
