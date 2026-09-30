import type { InvestigationSessionUser } from "@agentic-review/contracts";
import type {
  InvestigationApi,
  RepositoryAutoReplySettings,
  UpdateRepositoryAutoReplySettingsInput,
} from "./api";

export const autoReplyTemplateTokens = [
  "identity",
  "conclusion",
  "summary",
  "findings",
  "details",
] as const;

export const issueAutoReplyTemplateTokens = [
  "identity",
  "conclusion",
  "next_steps",
  "details",
] as const;

export const autoReplyProgressStages = ["received", "started", "failed", "completed"] as const;
export type AutoReplyProgressStage = (typeof autoReplyProgressStages)[number];
export const autoReplyProgressTemplateTokens = {
  received: ["trigger", "updated_at"],
  started: ["trigger", "updated_at"],
  failed: ["trigger", "updated_at", "failure"],
  completed: ["trigger", "updated_at", "result"],
} as const;

export type AutoReplySettingsFormValues = Pick<
  RepositoryAutoReplySettings,
  "enabled" | "pullRequestTemplate" | "issueTemplate" | "progressEnabled" | "progressTemplates"
>;

export type AutoReplyTemplateKey = "pullRequest" | "issue" | AutoReplyProgressStage;

export interface AutoReplyAuthorization {
  renew: boolean;
  saved: RepositoryAutoReplySettings;
  form: AutoReplySettingsFormValues;
}

export function autoReplyAuthorizationSnapshot(
  form: AutoReplySettingsFormValues,
  saved: RepositoryAutoReplySettings,
  renew: boolean,
): AutoReplyAuthorization {
  return {
    renew,
    saved: { ...saved, progressTemplates: { ...saved.progressTemplates } },
    form: { ...form, progressTemplates: { ...form.progressTemplates } },
  };
}

export function autoReplyTemplateValue(
  form: AutoReplySettingsFormValues,
  key: AutoReplyTemplateKey,
): string {
  return key === "pullRequest"
    ? form.pullRequestTemplate
    : key === "issue"
      ? form.issueTemplate
      : form.progressTemplates[key];
}

export function autoReplySettingsFieldErrors(
  form: AutoReplySettingsFormValues,
): Partial<Record<AutoReplyTemplateKey | "progressEnabled", string>> {
  const errors: Partial<Record<AutoReplyTemplateKey | "progressEnabled", string>> = {};
  if (form.progressEnabled && !form.enabled)
    errors.progressEnabled =
      "Investigation progress comments require automatic replies to be enabled.";
  for (const key of ["pullRequest", "issue", ...autoReplyProgressStages] as const) {
    try {
      if (key === "pullRequest" || key === "issue")
        validateAutoReplyTemplate(
          autoReplyTemplateValue(form, key),
          key === "issue" ? "Issue reply template" : "PR reply template",
          key,
        );
      else validateAutoReplyProgressTemplate(form.progressTemplates[key], key);
    } catch (cause) {
      errors[key] = cause instanceof Error ? cause.message : "Review this template.";
    }
  }
  return errors;
}

export function autoReplySettingsFormValues(
  settings: RepositoryAutoReplySettings,
): AutoReplySettingsFormValues {
  return {
    enabled: settings.enabled,
    pullRequestTemplate: settings.pullRequestTemplate,
    issueTemplate: settings.issueTemplate,
    progressEnabled: settings.progressEnabled,
    progressTemplates: { ...settings.progressTemplates },
  };
}

export function autoReplySettingsPermissions(
  repositoryId: string,
  user: InvestigationSessionUser | null,
): { canRead: boolean; canManage: boolean; canAuthorize: boolean } {
  const canRead = !!user?.repositoryIds.includes(repositoryId);
  const canManage = canRead && !!user?.permissions.includes("repository:manage");
  const canAuthorize =
    canManage &&
    !!user?.permissions.includes("action:prepare") &&
    !!user?.permissions.includes("action:execute") &&
    !!user?.actionCapabilities.includes("comment");
  return { canRead, canManage, canAuthorize };
}

export function validateAutoReplyTemplate(
  template: string,
  label = "Template",
  kind: "pullRequest" | "issue" = "pullRequest",
): void {
  const tokens = kind === "issue" ? issueAutoReplyTemplateTokens : autoReplyTemplateTokens;
  if (new TextEncoder().encode(template).byteLength > 12_000) {
    throw new Error(`${label} must be no larger than 12,000 UTF-8 bytes.`);
  }
  if (/\{\{\{|\}\}\}/u.test(template)) {
    throw new Error(`${label} must use the exact {{token}} placeholder syntax.`);
  }
  const matches = [...template.matchAll(/\{\{([^{}]*)\}\}/gu)];
  const allowed = new Set<string>(tokens);
  if (matches.some((match) => !allowed.has(match[1] ?? ""))) {
    throw new Error(`${label} contains an unknown placeholder. Use only the listed placeholders.`);
  }
  for (const token of tokens) {
    if (matches.filter((match) => match[1] === token).length !== 1) {
      throw new Error(`${label} must include {{${token}}} exactly once.`);
    }
  }
  if (template.replace(/\{\{[^{}]*\}\}/gu, "").match(/\{\{|\}\}/u)) {
    throw new Error(`${label} contains an incomplete placeholder.`);
  }
  if (matches.some((match, index) => match[1] !== tokens[index])) {
    throw new Error(
      `${label} must order placeholders as ${tokens.slice(0, -1).join(", ")}, and details.`,
    );
  }
  if (!template.trimStart().startsWith("{{identity}}")) {
    throw new Error(`${label} must begin with {{identity}} as its first nonempty content.`);
  }
  if (!template.trimEnd().endsWith("{{details}}")) {
    throw new Error(`${label} must end with {{details}} as its last nonempty content.`);
  }
}

export function autoReplySettingsInput(
  form: AutoReplySettingsFormValues,
  version: number,
): UpdateRepositoryAutoReplySettingsInput {
  validateAutoReplyTemplate(form.pullRequestTemplate, "PR reply template", "pullRequest");
  validateAutoReplyTemplate(form.issueTemplate, "Issue reply template", "issue");
  if (form.progressEnabled && !form.enabled) {
    throw new Error("Investigation progress comments require automatic replies to be enabled.");
  }
  for (const stage of autoReplyProgressStages) {
    validateAutoReplyProgressTemplate(form.progressTemplates[stage], stage);
  }
  return {
    version,
    enabled: form.enabled,
    pullRequestTemplate: form.pullRequestTemplate,
    issueTemplate: form.issueTemplate,
    progressEnabled: form.progressEnabled,
    progressTemplates: { ...form.progressTemplates },
  };
}

export function validateAutoReplyProgressTemplate(
  template: string,
  stage: AutoReplyProgressStage,
  label = `${stage.charAt(0).toUpperCase()}${stage.slice(1)} progress template`,
): void {
  const tokens = autoReplyProgressTemplateTokens[stage];
  if (new TextEncoder().encode(template).byteLength > 12_000) {
    throw new Error(`${label} must be no larger than 12,000 UTF-8 bytes.`);
  }
  if (/\{\{\{|\}\}\}/u.test(template)) {
    throw new Error(`${label} must use the exact {{token}} placeholder syntax.`);
  }
  const matches = [...template.matchAll(/\{\{([^{}]*)\}\}/gu)];
  const allowed = new Set<string>([...tokens, "status"]);
  if (matches.some((match) => !allowed.has(match[1] ?? ""))) {
    throw new Error(`${label} contains an unknown placeholder. Use only the listed placeholders.`);
  }
  for (const token of tokens) {
    if (matches.filter((match) => match[1] === token).length !== 1) {
      throw new Error(`${label} must include {{${token}}} exactly once.`);
    }
  }
  if (template.replace(/\{\{[^{}]*\}\}/gu, "").match(/\{\{|\}\}/u)) {
    throw new Error(`${label} contains an incomplete placeholder.`);
  }
  if (matches.filter((match) => match[1] === "status").length > 1) {
    throw new Error(`${label} may include the optional {{status}} placeholder only once.`);
  }
  if (matches.some((match) => match[1] === "status") && matches[0]?.[1] !== "status") {
    throw new Error(`${label} must place the optional {{status}} before {{trigger}}.`);
  }
  if (
    matches
      .filter((match) => match[1] !== "status")
      .some((match, index) => match[1] !== tokens[index])
  ) {
    throw new Error(`${label} must order placeholders as ${tokens.join(", ")}.`);
  }
}

export async function submitAutoReplySettings(
  repositoryId: string,
  form: AutoReplySettingsFormValues,
  saved: RepositoryAutoReplySettings,
  conflict: boolean,
  permissions: { canManage: boolean; canAuthorize: boolean },
  update: InvestigationApi["updateRepositoryAutoReplySettings"],
  reauthorize = false,
): Promise<RepositoryAutoReplySettings> {
  if (!permissions.canManage || ((form.enabled || reauthorize) && !permissions.canAuthorize)) {
    throw new Error(
      "Your account does not have permission to save these automatic reply settings.",
    );
  }
  if (saved.repositoryId !== repositoryId) {
    throw new Error("Reload settings for the selected repository before saving.");
  }
  if (conflict) {
    throw new Error("Reload the latest saved settings before trying again.");
  }
  return update(repositoryId, {
    ...autoReplySettingsInput(form, saved.version),
    ...(reauthorize ? { reauthorize: true } : {}),
  });
}
