import type {
  ManagedRepository,
  NewRevisionAuthorizationPolicy,
  RepositoryUpdateRequest,
  SelfOrAllowlistPolicy,
} from "@agentic-review/contracts";
import {
  buildSchedulingLimits,
  type SchedulingLimitValues,
  schedulingLimitValues,
} from "../../components/SchedulingPolicy/form";

export interface RepositorySettingsValues extends SchedulingLimitValues {
  enabled: boolean;
  reviewerMode: "inherit" | "custom";
  reviewerGithubUserId: string;
  reviewerGithubLogin: string;
  policyMode: "inherit" | "custom";
  policyVersion: string;
  schedulingTargetGithubUserId: string;
  allowlistedActorGithubUserIds: string;
  newRevisionPolicy: "default" | NewRevisionAuthorizationPolicy;
}

export function parsePositiveSafeInteger(value: string, label: string): number {
  const text = value.trim();
  if (!/^[0-9]+$/u.test(text)) throw new Error(`${label} must be a positive whole number.`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be between 1 and ${Number.MAX_SAFE_INTEGER}.`);
  }
  return number;
}

export function parseAllowlistedActors(value: string): number[] {
  const parts = value.trim() ? value.trim().split(/[\s,]+/u) : [];
  if (parts.length > 1_024) throw new Error("The allowlist can contain at most 1,024 actors.");
  const ids = parts.map((part) => parsePositiveSafeInteger(part, "Actor ID"));
  if (new Set(ids).size !== ids.length) throw new Error("Each actor ID must appear only once.");
  return ids;
}

export function repositorySettingsValues(repository: ManagedRepository): RepositorySettingsValues {
  const policy = repository.authorizationPolicy;
  return {
    ...schedulingLimitValues(repository.schedulingLimits),
    enabled: repository.enabled,
    reviewerMode:
      repository.reviewerGithubUserId === null && repository.reviewerGithubLogin === null
        ? "inherit"
        : "custom",
    reviewerGithubUserId: repository.reviewerGithubUserId?.toString() ?? "",
    reviewerGithubLogin: repository.reviewerGithubLogin ?? "",
    policyMode: policy === null ? "inherit" : "custom",
    policyVersion: policy?.policyVersion.toString() ?? "1",
    schedulingTargetGithubUserId:
      policy?.schedulingTargetGithubUserId.toString() ??
      repository.reviewerGithubUserId?.toString() ??
      "",
    allowlistedActorGithubUserIds: policy?.allowlistedActorGithubUserIds.join("\n") ?? "",
    newRevisionPolicy: policy?.newRevisionPolicy ?? "default",
  };
}

export function buildRepositoryUpdate(
  values: RepositorySettingsValues,
  expectedVersion: number,
): RepositoryUpdateRequest {
  const reviewerLogin = values.reviewerGithubLogin.trim();
  const reviewerGithubUserId =
    values.reviewerMode === "inherit"
      ? null
      : parsePositiveSafeInteger(values.reviewerGithubUserId, "Reviewer ID");
  if (
    values.reviewerMode === "custom" &&
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(reviewerLogin)
  ) {
    throw new Error(
      "Reviewer login must start with a letter or number and use up to 39 letters, numbers, or hyphens.",
    );
  }
  let authorizationPolicy: SelfOrAllowlistPolicy | null = null;
  if (values.policyMode === "custom") {
    if (reviewerGithubUserId === null) {
      throw new Error(
        "Configure a reviewer for this repository before setting a custom authorization policy.",
      );
    }
    authorizationPolicy = {
      kind: "self_or_allowlist",
      policyVersion: parsePositiveSafeInteger(values.policyVersion, "Policy version"),
      schedulingTargetGithubUserId: parsePositiveSafeInteger(
        values.schedulingTargetGithubUserId,
        "Scheduling target ID",
      ),
      allowlistedActorGithubUserIds: parseAllowlistedActors(values.allowlistedActorGithubUserIds),
      unknownActorPolicy: "deny",
      ...(values.newRevisionPolicy === "default"
        ? {}
        : { newRevisionPolicy: values.newRevisionPolicy }),
    };
    if (authorizationPolicy.schedulingTargetGithubUserId !== reviewerGithubUserId) {
      throw new Error("The scheduling target ID must match the configured reviewer ID.");
    }
  }
  return {
    expectedVersion,
    enabled: values.enabled,
    reviewerGithubUserId,
    reviewerGithubLogin: values.reviewerMode === "inherit" ? null : reviewerLogin,
    authorizationPolicy,
    schedulingLimits: buildSchedulingLimits(values),
  };
}

export function isConfigurationConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}
