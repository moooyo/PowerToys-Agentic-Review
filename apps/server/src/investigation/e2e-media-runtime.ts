import { InvestigationE2eMediaPublications } from "./e2e-media-publication.js";
import { type InvestigationEvidencePolicy, InvestigationEvidenceStore } from "./evidence-store.js";
import { GitHubMediaUploader } from "./gh-media-upload.js";
import type { InvestigationStore } from "./store.js";

export interface InvestigationMediaRuntimeConfig {
  readonly enabled: boolean;
  readonly requestTimeoutMs: number;
}

/** Media uses the server's protected GitHub publisher credential, never a model environment. */
export function parseInvestigationMediaRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): InvestigationMediaRuntimeConfig {
  const enabled = environment.INVESTIGATION_MEDIA_UPLOADS_ENABLED ?? "true";
  const timeout = environment.INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS ?? "120000";
  if (enabled !== "true" && enabled !== "false")
    throw new Error("INVESTIGATION_MEDIA_UPLOADS_ENABLED must be true or false.");
  if (
    !/^[1-9]\d*$/u.test(timeout) ||
    !Number.isSafeInteger(Number(timeout)) ||
    Number(timeout) > 600_000
  )
    throw new Error("INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS must be between 1 and 600000.");
  return { enabled: enabled === "true", requestTimeoutMs: Number(timeout) };
}

export function createInvestigationE2eMediaPublications(options: {
  readonly store: InvestigationStore;
  readonly github?: { readonly token: string; readonly expectedGitHubUserId: number };
  readonly enableExternalWrites: boolean;
  readonly configuration?: InvestigationMediaRuntimeConfig;
  readonly evidencePolicy?: InvestigationEvidencePolicy;
  readonly evidence?: Pick<InvestigationEvidenceStore, "content">;
  readonly fetch?: typeof globalThis.fetch;
}): InvestigationE2eMediaPublications {
  const configuration = options.configuration ?? { enabled: true, requestTimeoutMs: 120_000 };
  return new InvestigationE2eMediaPublications({
    store: options.store,
    evidence:
      options.evidence ?? new InvestigationEvidenceStore(options.store, options.evidencePolicy),
    enableExternalWrites: options.enableExternalWrites && configuration.enabled,
    leaseDurationMs: configuration.requestTimeoutMs + 60_000,
    ...(options.github === undefined || !configuration.enabled
      ? {}
      : {
          uploader: new GitHubMediaUploader({
            ...options.github,
            requestTimeoutMs: configuration.requestTimeoutMs,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
        }),
  });
}
