import type { TrustedSchedulingPolicy } from "./trusted-config.js";

const createStaticReviewCapabilities = () => ({
  operatingSystem: "windows",
  headless: true,
  labels: createStaticReviewCapabilityLabels(),
});

const createStaticReviewCapabilityLabels = () => ({
  execution: "enabled",
  processHost: "available",
});

export const defaultTrustedSchedulingPolicy: TrustedSchedulingPolicy = {
  issueTriage: {
    priority: 50,
    intentVersion: 1,
    maxAttempts: 2,
    requiredCapabilities: createStaticReviewCapabilities(),
    executionPolicy: {
      hardTimeoutMs: 10 * 60 * 1_000,
      noProgressTimeoutMs: 2 * 60 * 1_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: createStaticReviewCapabilityLabels(),
    },
  },
  pullRequestReview: {
    priority: 100,
    intentVersion: 1,
    maxAttempts: 3,
    requiredCapabilities: createStaticReviewCapabilities(),
    executionPolicy: {
      hardTimeoutMs: 60 * 60 * 1_000,
      noProgressTimeoutMs: 10 * 60 * 1_000,
      allowedRecipeIds: [],
      requiredCapabilityLabels: createStaticReviewCapabilityLabels(),
    },
  },
};
