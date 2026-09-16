import type {
  InvestigationApi,
  RepositoryWebhookSettings,
  UpdateRepositoryWebhookSettingsInput,
} from "./api";

export type WebhookSettingsFormValues = {
  enabled: boolean;
  reviewerUserIdText: string;
  allowedActorUserIdsText: string;
};

export function webhookSettingsFormValues(
  settings: RepositoryWebhookSettings,
): WebhookSettingsFormValues {
  return {
    enabled: settings.enabled,
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

export function webhookSettingsInput(
  form: WebhookSettingsFormValues,
  version: number,
): UpdateRepositoryWebhookSettingsInput {
  const reviewer = form.reviewerUserIdText.trim();
  const reviewerUserId = reviewer ? parseGitHubUserId(reviewer) : null;
  const allowedActorUserIds = parseGitHubUserIds(form.allowedActorUserIdsText);
  if (form.enabled && (reviewerUserId === null || allowedActorUserIds.length === 0)) {
    throw new Error(
      "Choose a recipient and at least one trusted user before enabling assignments.",
    );
  }
  return { version, enabled: form.enabled, reviewerUserId, allowedActorUserIds };
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
  return update(repositoryId, webhookSettingsInput(form, saved.version));
}
