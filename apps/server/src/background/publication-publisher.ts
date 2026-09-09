import { randomUUID } from "node:crypto";
import type { PublicationFailure } from "@agentic-review/contracts";
import type { FastifyBaseLogger } from "fastify";
import type { DatabaseClient } from "../database/database-client.js";
import type { PublicationLease } from "../database/publications.js";
import type {
  GitHubPublicationOutcome,
  GitHubPublicationTransport,
} from "../github/publication-client.js";

export const publicationPublisherPolicy = Object.freeze({
  intervalMs: 1000,
  leaseDurationMs: 30_000,
  renewIntervalMs: 10_000,
  operationTimeoutMs: 120_000,
  recoveryBatchSize: 32,
});
export interface PublicationPublisher {
  wake(): void;
  stop(): Promise<void>;
}

/** Only confirmed database intents can reach this independently configured transport. */
export function startPublicationPublisher(
  database: Pick<DatabaseClient, "request">,
  transport: GitHubPublicationTransport,
  logger: Pick<FastifyBaseLogger, "warn" | "error">,
  shutdown: AbortSignal,
): PublicationPublisher {
  const ownerId = `publication-publisher-${randomUUID()}`;
  let stopping = shutdown.aborted;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let operationController: AbortController | undefined;
  let lastCycleAt = 0;
  let deferUntil = 0;
  let preferReconciliation = false;

  function defer(outcome: GitHubPublicationOutcome): void {
    if (
      outcome.status !== "published" &&
      outcome.retryAfterMs !== undefined &&
      Number.isSafeInteger(outcome.retryAfterMs) &&
      outcome.retryAfterMs > 0
    )
      deferUntil = Math.max(deferUntil, Date.now() + Math.min(outcome.retryAfterMs, 86_400_000));
  }
  async function operate(lease: PublicationLease): Promise<void> {
    const intent = lease.publication.intent;
    const identity = {
      publicationId: intent.publicationId,
      ownerId: lease.ownerId,
      fence: lease.fence,
    };
    const controller = new AbortController();
    operationController = controller;
    let finished = false,
      sendBoundaryRequested = false;
    let renewal: Promise<void> | undefined, renewalTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(
      () => controller.abort(),
      publicationPublisherPolicy.operationTimeoutMs,
    );
    deadline.unref();
    const renew = () => {
      if (finished || controller.signal.aborted) return;
      renewalTimer = setTimeout(() => {
        renewalTimer = undefined;
        renewal = database
          .request("renewPublicationLease", {
            ...identity,
            leaseDurationMs: publicationPublisherPolicy.leaseDurationMs,
          })
          .then((value) => {
            if (value === null) controller.abort();
          })
          .catch(() => controller.abort())
          .finally(() => {
            renewal = undefined;
            renew();
          });
      }, publicationPublisherPolicy.renewIntervalMs);
      renewalTimer.unref();
    };
    const complete = async (outcome: GitHubPublicationOutcome) => {
      defer(outcome);
      const result =
        outcome.status === "published"
          ? { failure: null, remoteReceipt: outcome.remoteReceipt }
          : { failure: outcome.failure, remoteReceipt: null };
      if (lease.kind === "reconciliation") {
        await database.request("completePublicationReconciliation", {
          ...identity,
          ...result,
          outcome: outcome.status === "published" ? "published" : "unknown",
        });
      } else {
        let status = outcome.status;
        let failure = result.failure;
        if (sendBoundaryRequested && (status === "blocked" || status === "failed")) {
          if (failure?.code === "github_rejected" || failure?.code === "rate_limited")
            status = "failed";
          else {
            status = "unknown";
            failure = {
              code: "ambiguous_delivery",
              message: "The send boundary was entered without a verified delivery outcome.",
            };
          }
        }
        await database.request("completePublicationDelivery", {
          ...identity,
          ...result,
          failure,
          outcome: status,
        });
      }
    };
    renew();
    try {
      if (stopping) controller.abort();
      controller.signal.throwIfAborted();
      if (lease.kind === "reconciliation") {
        await complete(await transport.reconcile(intent, controller.signal));
        return;
      }
      const preflight = await transport.preflight(intent, controller.signal);
      controller.signal.throwIfAborted();
      if (preflight.status !== "ready") {
        await complete(
          preflight.status === "unknown"
            ? {
                status: "failed",
                failure: {
                  code: "preflight_failed",
                  message: "GitHub preflight did not complete; no publication was sent.",
                },
              }
            : preflight,
        );
        return;
      }
      // A lost owner RPC acknowledgement is conservative too: sending may have been recorded.
      sendBoundaryRequested = true;
      const sending = await database.request("beginPublicationSend", {
        ...identity,
        expectedPayloadSha256: intent.payloadSha256,
      });
      if (sending === null) return;
      controller.signal.throwIfAborted();
      await complete(await transport.publish(sending.publication.intent, controller.signal));
    } catch {
      const failure: PublicationFailure =
        lease.kind === "reconciliation"
          ? {
              code: "reconciliation_incomplete",
              message:
                "Read-only reconciliation was interrupted before a complete verified result.",
            }
          : sendBoundaryRequested
            ? {
                code: "delivery_interrupted",
                message:
                  "Delivery may have started. Reconcile the remote state before taking further action.",
              }
            : {
                code: "preflight_failed",
                message: "Publication preflight was interrupted. No publication was sent.",
              };
      try {
        await complete({
          status: lease.kind === "reconciliation" || sendBoundaryRequested ? "unknown" : "failed",
          failure,
        });
      } catch {
        // A newer fence wins. Persisted lease recovery determines the safe state; never resend.
        logger.warn(
          { publicationId: intent.publicationId, kind: lease.kind },
          "Publication completion could not be recorded under its lease; recovery is required.",
        );
      }
    } finally {
      finished = true;
      clearTimeout(deadline);
      if (renewalTimer) clearTimeout(renewalTimer);
      await renewal;
      operationController = undefined;
    }
  }
  async function cycle(): Promise<void> {
    lastCycleAt = Date.now();
    await database.request("recoverExpiredPublications", {
      limit: publicationPublisherPolicy.recoveryBatchSize,
    });
    if (stopping || Date.now() < deferUntil) return;
    const input = { ownerId, leaseDurationMs: publicationPublisherPolicy.leaseDurationMs };
    const first = preferReconciliation
      ? "claimPublicationReconciliation"
      : "claimPublicationDelivery";
    const second = preferReconciliation
      ? "claimPublicationDelivery"
      : "claimPublicationReconciliation";
    preferReconciliation = !preferReconciliation;
    let lease = await database.request(first, input);
    if (lease === null && !stopping) lease = await database.request(second, input);
    if (lease !== null) await operate(lease);
  }
  function schedule(): void {
    if (stopping || timer !== undefined || active !== undefined) return;
    const delay = Math.max(0, lastCycleAt + publicationPublisherPolicy.intervalMs - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      if (stopping) return;
      active = cycle()
        .catch(() =>
          logger.error(
            "The publication publisher cycle failed; no automatic send retry was requested.",
          ),
        )
        .finally(() => {
          active = undefined;
          schedule();
        });
    }, delay);
    timer.unref();
  }
  const abort = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    operationController?.abort();
  };
  shutdown.addEventListener("abort", abort, { once: true });
  schedule();
  return Object.freeze({
    wake: schedule,
    async stop() {
      abort();
      shutdown.removeEventListener("abort", abort);
      await active;
    },
  });
}
