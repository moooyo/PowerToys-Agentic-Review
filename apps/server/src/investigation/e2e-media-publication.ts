import { randomUUID } from "node:crypto";
import type {
  InvestigationArtifactV1,
  InvestigationResultV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { requireCondition } from "./errors.js";
import type { InvestigationEvidenceStore } from "./evidence-store.js";
import {
  type InvestigationMediaUploader,
  investigationMediaTypes,
  isGitHubMediaUrl,
  validateInvestigationMedia,
} from "./gh-media-upload.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationRepositoryRecord } from "./types.js";

export interface E2eMediaBinding {
  readonly featureId: string;
  readonly featureTitle: string;
  readonly scenario: string;
  readonly assertionIds: readonly string[];
}

export interface E2eMediaUploadReceipt {
  readonly id: string;
  readonly reportId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly subjectRef: string;
  readonly headSha: string;
  readonly artifact: InvestigationArtifactV1;
  readonly bindings: readonly E2eMediaBinding[];
  readonly requestDigest: string;
  readonly state: "prepared" | "uploading" | "uploaded" | "blocked" | "rejected" | "unknown";
  readonly url: string | null;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly claim?: { readonly ownerId: string; readonly expiresAt: number };
}

export interface E2eMediaPublicationReceipt {
  readonly reportId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly subjectRef: string;
  readonly headSha: string;
  readonly repository: InvestigationRepositoryRecord;
  readonly manifestDigest: string;
  readonly uploadIds: readonly string[];
  readonly blockers: readonly string[];
  readonly createdAt: string;
}

export interface InvestigationE2eMediaPublicationsOptions {
  readonly store: InvestigationStore;
  readonly evidence: Pick<InvestigationEvidenceStore, "content">;
  readonly uploader?: InvestigationMediaUploader;
  readonly enableExternalWrites: boolean;
  readonly now?: () => Date;
  readonly leaseDurationMs?: number;
}

export interface E2eMediaPublicationStatus {
  readonly state: "ready" | "pending" | "blocked" | "unknown";
  readonly retryable: boolean;
  readonly uploadedCount: number;
  readonly totalCount: number;
  readonly blockers: readonly string[];
}

const publicationKey = (reportId: string) =>
  `e2e-media:report:${investigationContentDigest(reportId)}`;
const uploadKey = (reportId: string, artifactId: string) =>
  `e2e-media:upload:${investigationContentDigest([reportId, artifactId])}`;
const equal = (left: unknown, right: unknown) =>
  investigationContentDigest(left) === investigationContentDigest(right);
const code = (value: string) => value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 256);

/** Upload receipts are durable independently of report and comment delivery retries. */
export class InvestigationE2eMediaPublications {
  readonly #now: () => Date;
  readonly #ownerId = randomUUID();

  constructor(private readonly options: InvestigationE2eMediaPublicationsOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  /** Called for the exact sealed report, never from model-supplied publication URLs. */
  prepare(report: InvestigationResultV1, task: InvestigationTaskV1): E2eMediaPublicationReceipt {
    requireCondition(
      task.kind === "pr-e2e" &&
        report.context.task.id === task.id &&
        report.context.task.kind === "pr-e2e" &&
        report.context.task.subjectRef === task.subjectRef &&
        equal(report.context.repository, task.repository),
      409,
      "e2e_media_task_mismatch",
      "E2E media must belong to the exact task and report.",
    );
    const subject = task.subjects.find((entry) => entry.id === task.subjectRef);
    requireCondition(
      subject?.kind === "original_pr",
      409,
      "e2e_media_subject_invalid",
      "E2E media requires the pinned PR subject.",
    );
    const e2e = report.context.e2e;
    const blockers: string[] = [];
    if (e2e === undefined) blockers.push("coverage_missing");
    else if (e2e.headSha !== subject.headSha) blockers.push("coverage_revision_mismatch");
    const artifacts = new Map(report.artifacts.map((artifact) => [artifact.id, artifact]));
    const allowedAttempts = new Set([
      report.context.attempt.id,
      ...report.context.adoptedAttemptIds,
    ]);
    const evidence = new Map(report.verificationEvidence.map((entry) => [entry.id, entry]));
    const trustedEvidence = (id: string) => {
      const entry = evidence.get(id);
      return entry !== undefined &&
        entry.authority === "worker" &&
        ["executor_observation", "visual_observation"].includes(entry.source) &&
        entry.subjectRef === task.subjectRef &&
        entry.provenance.taskId === task.id &&
        allowedAttempts.has(entry.provenance.attemptId)
        ? entry
        : undefined;
    };
    const observedArtifacts = new Map<string, Set<string>>();
    for (const entry of report.verificationEvidence) {
      if (trustedEvidence(entry.id) === undefined) continue;
      for (const artifactRef of entry.artifactRefs) {
        const attempts = observedArtifacts.get(artifactRef) ?? new Set<string>();
        attempts.add(entry.provenance.attemptId);
        observedArtifacts.set(artifactRef, attempts);
      }
    }
    const resolveEvidence = (refs: readonly string[]) => {
      const pending = [...refs];
      const visited = new Set<string>();
      const artifactRefs = new Set<string>();
      const attemptIds = new Set<string>();
      let trusted = refs.length > 0;
      while (pending.length > 0) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const entry = trustedEvidence(id);
        if (entry === undefined) {
          trusted = false;
          continue;
        }
        attemptIds.add(entry.provenance.attemptId);
        for (const ref of entry.artifactRefs) artifactRefs.add(ref);
        pending.push(...entry.evidenceRefs);
      }
      return { trusted, artifactRefs: [...artifactRefs], attemptIds };
    };
    const bindings = new Map<string, E2eMediaBinding[]>();
    for (const feature of e2e?.features ?? []) {
      const assertions = feature.assertions.map((assertion) => ({
        assertion,
        ...resolveEvidence(assertion.evidenceRefs),
      }));
      const refs = [
        ...new Set([
          ...feature.artifactRefs,
          ...assertions.filter((entry) => entry.trusted).flatMap((entry) => entry.artifactRefs),
        ]),
      ];
      const featureMedia: string[] = [];
      for (const id of refs) {
        const artifact = artifacts.get(id);
        if (artifact === undefined) {
          blockers.push(`missing_artifact:${code(feature.id)}:${code(id)}`);
          continue;
        }
        if (!investigationMediaTypes.has(artifact.mediaType)) continue;
        if (
          artifact.taskId !== task.id ||
          !allowedAttempts.has(artifact.attemptId) ||
          artifact.subjectRef !== task.subjectRef ||
          artifact.availability !== "available" ||
          observedArtifacts.get(id)?.has(artifact.attemptId) !== true
        ) {
          blockers.push(`media_provenance_mismatch:${code(id)}`);
          continue;
        }
        featureMedia.push(id);
        const entries = bindings.get(id) ?? [];
        entries.push({
          featureId: feature.id,
          featureTitle: feature.title,
          scenario: feature.scenario,
          assertionIds: assertions
            .filter(
              (entry) =>
                entry.trusted &&
                entry.attemptIds.size === 1 &&
                entry.attemptIds.has(artifact.attemptId),
            )
            .map((entry) => entry.assertion.id),
        });
        bindings.set(id, entries);
      }
      if (feature.outcome === "passed") {
        if (featureMedia.length === 0) blockers.push(`missing_feature_media:${code(feature.id)}`);
        if (
          assertions.length === 0 ||
          assertions.some(
            (entry) =>
              entry.assertion.outcome !== "passed" ||
              !entry.trusted ||
              entry.attemptIds.size !== 1 ||
              !featureMedia.some((id) => entry.attemptIds.has(artifacts.get(id)!.attemptId)),
          )
        )
          blockers.push(`missing_feature_assertion:${code(feature.id)}`);
      }
    }
    const manifest = {
      reportId: report.report.id,
      taskId: task.id,
      attemptId: report.context.attempt.id,
      subjectRef: task.subjectRef,
      headSha: subject.headSha,
      repository: task.repository,
      reportDigest: report.report.logicalContentDigest,
      bindings: [...bindings].map(([id, entries]) => ({
        artifact: artifacts.get(id)!,
        bindings: entries,
      })),
      blockers: [...new Set(blockers)].sort(),
    };
    const manifestDigest = investigationContentDigest(manifest);
    return this.options.store.transaction(() => {
      const existing = this.receipt(report.report.id);
      if (existing !== undefined) {
        requireCondition(
          existing.manifestDigest === manifestDigest,
          409,
          "e2e_media_manifest_conflict",
          "A media publication cannot change its sealed evidence manifest.",
        );
        return existing;
      }
      const createdAt = this.#now().toISOString();
      const uploadIds: string[] = [];
      for (const binding of manifest.bindings) {
        const id = uploadKey(report.report.id, binding.artifact.id);
        uploadIds.push(id);
        const requestDigest = investigationContentDigest({
          repository: task.repository,
          reportId: report.report.id,
          taskId: task.id,
          attemptId: report.context.attempt.id,
          subjectRef: task.subjectRef,
          headSha: subject.headSha,
          ...binding,
        });
        this.options.store.insert("idempotency", id, {
          id,
          reportId: report.report.id,
          taskId: task.id,
          attemptId: report.context.attempt.id,
          subjectRef: task.subjectRef,
          headSha: subject.headSha,
          ...binding,
          requestDigest,
          state: "prepared",
          url: null,
          code: null,
          retryable: false,
          createdAt,
          updatedAt: createdAt,
        } satisfies E2eMediaUploadReceipt);
      }
      const receipt: E2eMediaPublicationReceipt = {
        reportId: report.report.id,
        taskId: task.id,
        attemptId: report.context.attempt.id,
        subjectRef: task.subjectRef,
        headSha: subject.headSha,
        repository: task.repository,
        manifestDigest,
        uploadIds,
        blockers: manifest.blockers,
        createdAt,
      };
      this.options.store.insert("idempotency", publicationKey(report.report.id), receipt);
      return receipt;
    });
  }

  receipt(reportId: string): E2eMediaPublicationReceipt | undefined {
    return this.options.store.get<E2eMediaPublicationReceipt>(
      "idempotency",
      publicationKey(reportId),
    );
  }

  uploads(reportId: string): E2eMediaUploadReceipt[] {
    return (this.receipt(reportId)?.uploadIds ?? []).map((id) => this.#upload(id));
  }

  status(reportId: string): E2eMediaPublicationStatus {
    const publication = this.receipt(reportId);
    if (publication === undefined)
      return {
        state: "blocked",
        retryable: false,
        uploadedCount: 0,
        totalCount: 0,
        blockers: ["media_manifest_missing"],
      };
    const uploads = this.uploads(reportId);
    const blockers = [
      ...publication.blockers,
      ...uploads
        .filter((upload) => upload.state !== "uploaded")
        .map(
          (upload) =>
            `${upload.state}:${upload.code ?? "upload_pending"}:${code(upload.artifact.id)}`,
        ),
    ];
    const state = uploads.some((upload) => upload.state === "unknown")
      ? "unknown"
      : publication.blockers.length > 0 ||
          uploads.some((upload) => upload.state === "blocked" || upload.state === "rejected") ||
          uploads.length === 0
        ? "blocked"
        : uploads.every((upload) => upload.state === "uploaded")
          ? "ready"
          : "pending";
    return {
      state,
      retryable: state !== "unknown" && uploads.some((upload) => upload.retryable),
      uploadedCount: uploads.filter((upload) => upload.state === "uploaded").length,
      totalCount: uploads.length,
      blockers,
    };
  }

  async publish(
    reportId: string,
    signal?: AbortSignal,
    beforeDispatch?: () => void,
  ): Promise<E2eMediaPublicationReceipt> {
    const publication = this.receipt(reportId);
    requireCondition(
      publication !== undefined,
      404,
      "e2e_media_not_prepared",
      "The E2E media manifest has not been prepared.",
    );
    if (
      publication.blockers.some(
        (entry) => entry === "coverage_missing" || entry === "coverage_revision_mismatch",
      )
    )
      return publication;
    for (const id of publication.uploadIds) {
      if (signal?.aborted) break;
      const record = this.#claim(id);
      if (record === undefined) continue;
      if (!this.options.enableExternalWrites || this.options.uploader === undefined) {
        this.#settle(record, {
          state: "blocked",
          code: "media_publication_disabled",
          retryable: true,
          url: null,
        });
        continue;
      }
      let content: Uint8Array;
      try {
        const stored = this.options.evidence.content(record.artifact.id);
        if (!equal(stored.artifact, record.artifact)) throw new Error("media_evidence_changed");
        content = Buffer.from(stored.contentBase64, "base64");
        validateInvestigationMedia(record.artifact, content);
      } catch {
        this.#settle(record, {
          state: "blocked",
          code: "media_evidence_unavailable",
          retryable: false,
          url: null,
        });
        continue;
      }
      let dispatched = false;
      try {
        const result = await this.options.uploader.upload(
          { repository: publication.repository, artifact: record.artifact, content },
          () => {
            beforeDispatch?.();
            this.options.store.transaction(() => {
              const current = this.#upload(id);
              requireCondition(
                current.claim?.ownerId === record.claim?.ownerId &&
                  current.claim!.expiresAt > this.#now().getTime() &&
                  current.requestDigest === record.requestDigest,
                409,
                "e2e_media_claim_lost",
                "The media upload claim is no longer owned.",
              );
              this.options.store.put("idempotency", id, {
                ...current,
                state: "uploading",
                updatedAt: this.#now().toISOString(),
              });
              dispatched = true;
            });
          },
          signal,
        );
        if (result.state === "uploaded") {
          this.#settle(
            record,
            isGitHubMediaUrl(result.url) && dispatched
              ? { state: "uploaded", url: result.url, code: null, retryable: false }
              : {
                  state: dispatched ? "unknown" : "blocked",
                  url: null,
                  code: "media_upload_receipt_invalid",
                  retryable: false,
                },
          );
        } else this.#settle(record, { ...result, url: null });
      } catch {
        this.#settle(record, {
          state: dispatched ? "unknown" : "blocked",
          url: null,
          code: dispatched ? "media_upload_effect_unknown" : "media_upload_not_sent",
          retryable: !dispatched,
        });
      }
    }
    return publication;
  }

  /** Unknown uploads intentionally require reconciliation outside an automatic retry loop. */
  render(reportId: string): string {
    const publication = this.receipt(reportId);
    if (publication === undefined)
      return "### Evidence publication\n\nBlocked: the E2E evidence manifest is unavailable.";
    const uploads = this.uploads(reportId);
    const status = this.status(reportId);
    const lines = [
      "### Evidence publication",
      "",
      status.state === "ready"
        ? "Published. Test results and evidence delivery are tracked independently."
        : "Blocked or pending. Test results are unchanged; the evidence delivery is not complete.",
      "",
      `Revision: \`${publication.headSha}\`.`,
    ];
    for (const problem of status.blockers) lines.push("", `- \`${code(problem)}\``);
    if (uploads.some((upload) => upload.state === "unknown" || upload.state === "uploading"))
      lines.push(
        "",
        "An upload may have reached GitHub without a confirmed receipt. It will not be sent again automatically.",
      );
    for (const upload of uploads) {
      if (upload.state !== "uploaded" || !isGitHubMediaUrl(upload.url)) continue;
      const caption = upload.artifact.name.replace(/[\\[\]\r\n]/gu, "_");
      lines.push(
        "",
        `Features: ${upload.bindings.map((binding) => `\`${binding.featureTitle.replace(/[`\r\n]/gu, " ").slice(0, 160)}\``).join(", ")}. Artifact SHA-256: \`${upload.artifact.digest}\`.`,
        "",
        upload.artifact.mediaType === "image/png" ? `![${caption}](${upload.url})` : upload.url,
      );
    }
    return lines.join("\n");
  }

  #upload(id: string): E2eMediaUploadReceipt {
    const record = this.options.store.get<E2eMediaUploadReceipt>("idempotency", id);
    requireCondition(
      record !== undefined,
      409,
      "e2e_media_receipt_missing",
      "A media upload receipt is missing.",
    );
    return record;
  }

  #claim(id: string): E2eMediaUploadReceipt | undefined {
    return this.options.store.transaction(() => {
      const current = this.#upload(id);
      if (current.state === "uploaded" || current.state === "unknown") return undefined;
      if (current.claim !== undefined && current.claim.expiresAt > this.#now().getTime())
        return undefined;
      if (current.state === "uploading") {
        const { claim: _claim, ...rest } = current;
        this.options.store.put("idempotency", id, {
          ...rest,
          state: "unknown",
          code: "media_upload_interrupted",
          retryable: false,
          updatedAt: this.#now().toISOString(),
        });
        return undefined;
      }
      if ((current.state === "blocked" || current.state === "rejected") && !current.retryable)
        return undefined;
      const claimed: E2eMediaUploadReceipt = {
        ...current,
        claim: {
          ownerId: `${this.#ownerId}:${randomUUID()}`,
          expiresAt: this.#now().getTime() + (this.options.leaseDurationMs ?? 180_000),
        },
      };
      this.options.store.put("idempotency", id, claimed);
      return claimed;
    });
  }

  #settle(
    record: E2eMediaUploadReceipt,
    result: Pick<E2eMediaUploadReceipt, "state" | "url" | "code" | "retryable">,
  ): void {
    this.options.store.transaction(() => {
      const current = this.#upload(record.id);
      if (
        current.claim?.ownerId !== record.claim?.ownerId ||
        current.requestDigest !== record.requestDigest
      )
        return;
      const { claim: _claim, ...rest } = current;
      this.options.store.put("idempotency", record.id, {
        ...rest,
        ...result,
        updatedAt: this.#now().toISOString(),
      });
    });
  }
}
