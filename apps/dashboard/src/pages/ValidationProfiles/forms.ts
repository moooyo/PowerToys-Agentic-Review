import {
  getValidationProfileConfigIssues,
  type RepositoryValidationProfileBinding,
  type RepositoryValidationProfileBindingSaveRequest,
  RepositoryValidationProfileBindingSaveRequestSchema,
  type TestProbeOutputDeclarationV1,
  type ValidationProfileConfig,
  ValidationProfileConfigSchema,
  type ValidationProfileCreateRequest,
  ValidationProfileCreateRequestSchema,
  type ValidationProfileVersion,
  type ValidationProfileVersionSummary,
  type ValidationTarget,
  type WebUiEvidencePolicy,
  type WorkflowKind,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type {
  ConfigurationPage,
  ConfigurationPageQuery,
} from "../../services/configuration/adapter";

export const workflowLabels: Record<WorkflowKind, string> = {
  pr_static_build: "Pull request review",
  pr_ui: "Pull request UI validation",
  issue_triage: "Issue triage",
  issue_validation: "Issue validation",
};

export const targetLabels: Record<ValidationTarget, string> = {
  headless: "Headless",
  windows_desktop: "Windows desktop",
  web: "Web",
};

export const profileOutputSchemas = {
  pr_static_build: "PrReviewPlanV2",
  pr_ui: "ValidationReportV1",
  issue_triage: "IssueTriageV2",
  issue_validation: "ValidationReportV1",
} as const satisfies Record<WorkflowKind, ValidationProfileVersion["outputSchemaVersion"]>;

export function profileTargets(workflowKind: WorkflowKind): ValidationTarget[] {
  switch (workflowKind) {
    case "pr_static_build":
    case "issue_triage":
      return ["headless"];
    case "pr_ui":
      return ["windows_desktop", "web"];
    case "issue_validation":
      return ["headless", "windows_desktop", "web"];
  }
}

export function defaultProfileConfig(): ValidationProfileConfig {
  return {
    schemaVersion: "ValidationProfileV1",
    setup: [],
    build: [],
    test: [],
    launch: [],
    cleanup: [],
    requiredCapabilities: [],
    hardTimeoutMs: 1_800_000,
    noProgressTimeoutMs: 300_000,
  };
}

export interface ProfileFormValues {
  name: string;
  workflowKind: WorkflowKind;
  target: ValidationTarget;
  required: boolean;
  configJson: string;
}

export function profileFormValues(profile?: ValidationProfileVersion): ProfileFormValues {
  return {
    name: profile?.name ?? "",
    workflowKind: profile?.workflowKind ?? "pr_static_build",
    target: profile?.target ?? "headless",
    required: profile?.required ?? true,
    configJson: JSON.stringify(profile?.config ?? defaultProfileConfig(), null, 2),
  };
}

export function parseProfileConfig(
  text: string,
  workflowKind: WorkflowKind,
  target?: ValidationTarget,
): ValidationProfileConfig {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("Enter valid JSON for the profile configuration.");
  }
  if (!Value.Check(ValidationProfileConfigSchema, config)) {
    const errors = [...Value.Errors(ValidationProfileConfigSchema, config)]
      .slice(0, 8)
      .map((issue) => `${issue.path || "/"}: ${issue.message}`);
    throw new Error(`Configuration does not match ValidationProfileV1. ${errors.join(" ")}`);
  }
  const issues = getValidationProfileConfigIssues(config, workflowKind, target);
  if (issues.length > 0) throw new Error(issues.join(" "));
  return config;
}

export type ProfileProbeField = TestProbeOutputDeclarationV1["fields"][number];

export const webTraceLabels: Record<WebUiEvidencePolicy["trace"], string> = {
  on_failure: "On failure",
  always: "Always",
  off: "Off",
};

export function updateProfileProbeFields(
  text: string,
  workflowKind: WorkflowKind,
  target: ValidationTarget,
  testStepId: string,
  fields: ProfileProbeField[],
): string {
  const config = parseProfileConfig(text, workflowKind, target);
  const testStep = config.test.find((step) => step.id === testStepId);
  if (!testStep) throw new Error("Select a test command from this configuration.");
  if (fields.length === 0) {
    delete testStep.probeOutput;
  } else {
    testStep.probeOutput = {
      schemaVersion: "TestProbeOutputDeclarationV1",
      fields: structuredClone(fields),
    };
  }
  const updated = JSON.stringify(config, null, 2);
  parseProfileConfig(updated, workflowKind, target);
  return updated;
}

export function updateProfileWebTrace(
  text: string,
  workflowKind: WorkflowKind,
  target: ValidationTarget,
  trace: WebUiEvidencePolicy["trace"],
): string {
  const config = parseProfileConfig(text, workflowKind, target);
  if (config.ui?.target !== "web") {
    throw new Error("Add Web UI scenarios before choosing browser trace capture.");
  }
  config.ui.evidence.trace = trace;
  const updated = JSON.stringify(config, null, 2);
  parseProfileConfig(updated, workflowKind, target);
  return updated;
}

export function buildProfilePublish(
  values: ProfileFormValues,
  repositoryId: string,
  latest?: ValidationProfileVersionSummary,
): ValidationProfileCreateRequest {
  if (latest) {
    if (latest.repositoryId !== repositoryId) {
      throw new Error("This profile belongs to another repository. Refresh before publishing.");
    }
    if (latest.workflowKind !== values.workflowKind || latest.target !== values.target) {
      throw new Error("A new version cannot change the profile workflow or execution target.");
    }
  }
  const request = {
    name: values.name.trim(),
    workflowKind: values.workflowKind,
    target: values.target,
    required: values.required,
    config: parseProfileConfig(values.configJson, values.workflowKind, values.target),
    outputSchemaVersion: profileOutputSchemas[values.workflowKind],
    ...(latest
      ? { profileId: latest.profileId, expectedVersion: latest.version }
      : { expectedVersion: 0 }),
  };
  if (!Value.Check(ValidationProfileCreateRequestSchema, request)) {
    throw new Error(
      "Enter a name of 1–128 characters without control characters and a supported workflow target.",
    );
  }
  return request;
}

export function buildProfileBinding(
  repositoryId: string,
  profileId: string,
  selected: ValidationProfileVersionSummary,
  enabled: boolean,
  current?: RepositoryValidationProfileBinding,
): RepositoryValidationProfileBindingSaveRequest {
  if (selected.repositoryId !== repositoryId || selected.profileId !== profileId) {
    throw new Error("Select a published version from this repository and profile.");
  }
  if (current && (current.repositoryId !== repositoryId || current.profileId !== profileId)) {
    throw new Error(
      "The binding does not match this repository and profile. Refresh before saving.",
    );
  }
  const request = {
    expectedVersion: current?.version ?? 0,
    profileVersionId: selected.id,
    enabled,
  };
  if (!Value.Check(RepositoryValidationProfileBindingSaveRequestSchema, request)) {
    throw new Error("The binding is invalid. Reload the published version and current binding.");
  }
  return request;
}

export async function collectProfileBindings(
  repositoryId: string,
  list: (
    repositoryId: string,
    query: ConfigurationPageQuery,
  ) => Promise<ConfigurationPage<RepositoryValidationProfileBinding>>,
): Promise<RepositoryValidationProfileBinding[]> {
  const result: RepositoryValidationProfileBinding[] = [];
  const identifiers = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page += 1) {
    const current = await list(repositoryId, { page, pageSize: 50 });
    if (total === undefined) total = current.total;
    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > 10_000 ||
      current.total !== total ||
      current.page !== page ||
      current.pageSize !== 50 ||
      current.items.length > 50
    ) {
      throw new Error(
        "The binding list changed or returned inconsistent pagination. Refresh and try again.",
      );
    }
    for (const item of current.items) {
      if (item.repositoryId !== repositoryId || identifiers.has(item.profileId)) {
        throw new Error(
          "The binding list returned a different scope or repeated profile. Refresh and try again.",
        );
      }
      identifiers.add(item.profileId);
      result.push(item);
    }
    if (result.length > total) throw new Error("The binding list exceeded its reported total.");
    if (result.length === total) return result;
    if (current.items.length < 50) {
      throw new Error(
        "The binding list ended before all bindings were loaded. Refresh and try again.",
      );
    }
  }
}

export function configurationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed. Try again.";
}

export function isProfileConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}
