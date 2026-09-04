import type { TrustedSchedulingPolicy } from "./trusted-config.js";

const staticReviewCapabilities = {
  operatingSystem: "windows",
  headless: true,
  labels: {
    execution: "enabled",
    processHost: "available",
  },
} as const;

const staticReviewCapabilityLabels = {
  execution: "enabled",
  processHost: "available",
} as const;

export const defaultTrustedSchedulingPolicy: TrustedSchedulingPolicy = {
  issueTriage: {
    priority: 50,
    intentVersion: 1,
    maxAttempts: 2,
    requiredCapabilities: staticReviewCapabilities,
    executionPolicy: {
      hardTimeoutMs: 10 * 60 * 1_000,
      noProgressTimeoutMs: 2 * 60 * 1_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: staticReviewCapabilityLabels,
    },
  },
  pullRequestReview: {
    priority: 100,
    intentVersion: 1,
    maxAttempts: 3,
    requiredCapabilities: staticReviewCapabilities,
    executionPolicy: {
      hardTimeoutMs: 60 * 60 * 1_000,
      noProgressTimeoutMs: 10 * 60 * 1_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: staticReviewCapabilityLabels,
    },
  },
};
