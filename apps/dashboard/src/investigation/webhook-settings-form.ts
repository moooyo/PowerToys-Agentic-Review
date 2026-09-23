import type {
  InvestigationApi,
  RepositoryWebhookSettings,
  UpdateRepositoryWebhookSettingsInput,
} from "./api";

export type WebhookSettingsFormValues = {
  enabled: boolean;
  e2eEnabled?: boolean;
  reviewerUserIdText: string;
  allowedActorUserIdsText: string;
};

export function webhookSettingsFormValues(
  settings: RepositoryWebhookSettings,
): WebhookSettingsFormValues {
  return {
    enabled: settings.enabled,
    ...(settings.e2eEnabled === undefined ? {} : { e2eEnabled: settings.e2eEnabled }),
    reviewerUserIdText: settings.reviewerUserId === null ? "" : String(settings.reviewerUserId),
    allowedActorUserIdsText: settings.allowedActorUserIds.join("\n"),
  };
}

function parseGitHubUserId(value: string): number {
  const id = Number(value);
  if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error("Enter positive numeric GitHub user IDs, not usernames.");
  }
  return id;
}

export function parseGitHubUserIds(value: string): number[] {
  const ids = [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .filter(Boolean)
        .map(parseGitHubUserId),
    ),
  ];
  if (ids.length > 1024) throw new Error("Enter up to 1,024 trusted GitHub user IDs.");
  return ids;
}

export function webhookSettingsFormIsDirty(
  form: WebhookSettingsFormValues,
  saved: RepositoryWebhookSettings,
): boolean {
  try {
    const reviewer = form.reviewerUserIdText.trim();
    const reviewerUserId = reviewer ? parseGitHubUserId(reviewer) : null;
    const actorIds = parseGitHubUserIds(form.allowedActorUserIdsText);
    const savedActorIds = new Set(saved.allowedActorUserIds);
    return (
      form.enabled !== saved.enabled ||
      form.e2eEnabled !== saved.e2eEnabled ||
      reviewerUserId !== saved.reviewerUserId ||
      actorIds.length !== savedActorIds.size ||
      actorIds.some((id) => !savedActorIds.has(id))
    );
  } catch {
    // Invalid text remains a draft that must be corrected or explicitly discarded.
    return true;
  }
}

export function webhookSettingsFieldErrors(
  form: WebhookSettingsFormValues,
): Partial<Record<"reviewerUserIdText" | "allowedActorUserIdsText", string>> {
  const errors: Partial<Record<"reviewerUserIdText" | "allowedActorUserIdsText", string>> = {};
  const intakeEnabled = form.enabled || form.e2eEnabled === true;
  try {
    if (form.reviewerUserIdText.trim()) parseGitHubUserId(form.reviewerUserIdText.trim());
    else if (intakeEnabled)
      errors.reviewerUserIdText = "Choose an assignment recipient before enabling intake.";
  } catch (cause) {
    errors.reviewerUserIdText =
      cause instanceof Error ? cause.message : "Enter a numeric GitHub user ID.";
  }
  try {
    const ids = parseGitHubUserIds(form.allowedActorUserIdsText);
    if (intakeEnabled && ids.length === 0)
      errors.allowedActorUserIdsText = "Add at least one trusted user before enabling intake.";
  } catch (cause) {
    errors.allowedActorUserIdsText =
      cause instanceof Error ? cause.message : "Enter numeric GitHub user IDs.";
  }
  return errors;
}

export function webhookSettingsInput(
  form: WebhookSettingsFormValues,
  version: number,
): UpdateRepositoryWebhookSettingsInput {
  const reviewer = form.reviewerUserIdText.trim();
  const reviewerUserId = reviewer ? parseGitHubUserId(reviewer) : null;
  const allowedActorUserIds = parseGitHubUserIds(form.allowedActorUserIdsText);
  if (
    (form.enabled || form.e2eEnabled === true) &&
    (reviewerUserId === null || allowedActorUserIds.length === 0)
  ) {
    throw new Error(
      "Choose a recipient and at least one trusted user before enabling assignments.",
    );
  }
  return {
    version,
    enabled: form.enabled,
    reviewerUserId,
    allowedActorUserIds,
    ...(form.e2eEnabled === undefined ? {} : { e2eEnabled: form.e2eEnabled }),
  };
}

export async function submitWebhookSettings(
  repositoryId: string,
  form: WebhookSettingsFormValues,
  saved: RepositoryWebhookSettings,
  conflict: boolean,
  update: InvestigationApi["updateRepositoryWebhookSettings"],
): Promise<RepositoryWebhookSettings> {
  if (saved.repositoryId !== repositoryId) {
    throw new Error("Reload settings for the selected repository before saving.");
  }
  if (conflict) {
    throw new Error("Reload the latest saved settings before trying again.");
  }
  if (!webhookSettingsFormIsDirty(form, saved)) return saved;
  return update(repositoryId, webhookSettingsInput(form, saved.version));
}
