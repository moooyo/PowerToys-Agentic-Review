import type { InvestigationIntakeDetails } from "@agentic-review/contracts";
import type { InvestigationE2eReceipt } from "./e2e-intake.js";
import { requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal } from "./types.js";
import type { InvestigationWebhookReceipt } from "./webhook-intake.js";
import type { InvestigationWebhookSettings } from "./webhook-settings.js";

export function canonicalInvestigationWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The public webhook URL must be an absolute HTTP(S) URL.");
  }
  if (
    value.trim() !== value ||
    value.length > 2_048 ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "The public webhook URL must be an absolute HTTP(S) URL without credentials, query, or fragment.",
    );
  return url.href;
}

/** Reports configuration and retained receipts without probing or synthesizing health. */
export class InvestigationIntakeDetailsService {
  readonly #url: string;

  constructor(
    private readonly options: {
      readonly store: InvestigationStore;
      readonly settings: Pick<InvestigationWebhookSettings, "read">;
      readonly publicOrigin: string;
      readonly webhookPublicUrl?: string;
      readonly now?: () => Date;
    },
  ) {
    this.#url = canonicalInvestigationWebhookUrl(
      options.webhookPublicUrl ?? new URL("/api/github/webhook", options.publicOrigin).href,
    );
  }

  read(actor: InvestigationOperatorPrincipal, repositoryId: string): InvestigationIntakeDetails {
    const settings = this.options.settings.read(actor, repositoryId);
    let latest: InvestigationIntakeDetails["lastDelivery"] = null;
    for (const prefix of ["webhook:delivery:", "e2e:webhook:"]) {
      let cursor: string | undefined;
      for (;;) {
        const page = this.options.store.pagePrefix<
          InvestigationWebhookReceipt | InvestigationE2eReceipt
        >("idempotency", prefix, 500, false, cursor);
        for (const receipt of page) {
          const repository =
            "assignment" in receipt ? receipt.assignment.repository : receipt.repository;
          if (repository.id !== repositoryId) continue;
          if (!latest || receipt.receivedAt > latest.receivedAt)
            latest = {
              deliveryId: receipt.deliveryId,
              receivedAt: receipt.receivedAt,
              eventName: receipt.eventName,
            };
        }
        if (page.length < 500) break;
        cursor = page.at(-1)!.id;
      }
    }
    return {
      repositoryId,
      canonicalWebhookUrl: this.#url,
      webhookUrlSource: this.options.webhookPublicUrl === undefined ? "public_origin" : "explicit",
      receiverConfigured: settings.receiverConfigured,
      lastDelivery: latest,
      observedAt: (this.options.now ?? (() => new Date()))().toISOString(),
    };
  }

  authorizeIdentityRead(actor: InvestigationOperatorPrincipal, repositoryId: string): void {
    requireCondition(
      actor.repositoryIds.includes(repositoryId),
      403,
      "repository_forbidden",
      "This identity has no access to the repository.",
    );
    this.options.settings.read(actor, repositoryId);
  }
}
