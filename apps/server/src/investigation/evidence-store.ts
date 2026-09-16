import type {
  InvestigationArtifactMetadataV1,
  InvestigationArtifactV1,
  InvestigationResultV1,
  InvestigationTaskV1,
} from "@agentic-review/contracts";
import { investigationContentDigest } from "@agentic-review/domain";
import { requireCondition } from "./errors.js";
import type { InvestigationStore } from "./store.js";

export interface InvestigationEvidencePolicy {
  readonly maximumBytes: number;
  readonly maximumCount: number;
  readonly retentionSeconds: number;
  readonly cleanupIntervalSeconds: number;
  readonly cleanupBatchSize: number;
}

export const defaultInvestigationEvidencePolicy: InvestigationEvidencePolicy = {
  maximumBytes: 1_024 * 1_024 * 1_024,
  maximumCount: 10_000,
  retentionSeconds: 30 * 24 * 60 * 60,
  cleanupIntervalSeconds: 60,
  cleanupBatchSize: 100,
};

interface EvidenceMetadata {
  artifact: InvestigationArtifactV1;
  storedAt: string;
  expiredAt: string | null;
  checkpointRetained: boolean;
}
interface EvidenceContent {
  contentBase64: string;
}
interface EvidenceUsage {
  bytes: number;
  count: number;
  cleanupCursor: string;
}

function parentPinPrefix(taskId: string): string {
  return `${encodeURIComponent(taskId)}:`;
}
function parentPinId(parentTaskId: string, childTaskId: string): string {
  return `${parentPinPrefix(parentTaskId)}${encodeURIComponent(childTaskId)}`;
}

function requiredPatchSubjects(task: InvestigationTaskV1): Set<string> {
  const required = new Set([task.subjectRef, ...task.executionPolicy.allowedSubjectRefs]);
  return new Set(
    task.subjects
      .filter((subject) => subject.kind === "local_patch" && required.has(subject.id))
      .map((subject) => subject.id),
  );
}

function pinnedSourceTasks(task: InvestigationTaskV1): Set<string> {
  const ids = new Set<string>();
  if (task.parentTaskId !== null) ids.add(task.parentTaskId);
  const subjects = requiredPatchSubjects(task);
  for (const artifact of task.sourceArtifacts ?? []) {
    if (subjects.has(artifact.subjectRef) && artifact.taskId !== task.id) ids.add(artifact.taskId);
  }
  return ids;
}

/** Mutable retention state is separate from immutable report and artifact identities. */
export class InvestigationEvidenceStore {
  readonly policy: InvestigationEvidencePolicy;

  constructor(
    private readonly store: InvestigationStore,
    policy: Partial<InvestigationEvidencePolicy> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.policy = { ...defaultInvestigationEvidencePolicy, ...policy };
    for (const [name, value] of Object.entries(this.policy))
      requireCondition(
        Number.isSafeInteger(value) && value > 0,
        500,
        "invalid_evidence_policy",
        `Evidence policy ${name} must be a positive safe integer.`,
      );
    requireCondition(
      this.policy.retentionSeconds <= 10 * 366 * 24 * 60 * 60 &&
        this.policy.cleanupIntervalSeconds <= 86_400 &&
        this.policy.cleanupBatchSize <= 1_000,
      500,
      "invalid_evidence_policy",
      "Evidence retention, cleanup interval, or batch size exceeds its supported bound.",
    );
  }

  private metadata(id: string): EvidenceMetadata {
    const record = this.store.get<EvidenceMetadata>("evidenceMetadata", id);
    requireCondition(record !== undefined, 404, "not_found", "The artifact does not exist.");
    return record;
  }

  private usage(): EvidenceUsage {
    return (
      this.store.get<EvidenceUsage>("evidenceUsage", "global") ?? {
        bytes: 0,
        count: 0,
        cleanupCursor: "",
      }
    );
  }

  artifact(id: string): InvestigationArtifactV1 {
    return this.metadata(id).artifact;
  }

  current(id: string): InvestigationArtifactMetadataV1 {
    const record = this.metadata(id);
    const availability: InvestigationArtifactV1["availability"] =
      record.expiredAt !== null
        ? "expired"
        : this.store.has("evidenceAssets", id)
          ? "available"
          : "missing";
    return {
      artifact: { ...record.artifact, availability },
      storedAt: record.storedAt,
      expiredAt: record.expiredAt,
      retentionProtected: record.expiredAt === null && this.isProtected(record),
    };
  }

  content(id: string): { artifact: InvestigationArtifactV1; contentBase64: string } {
    const record = this.metadata(id);
    requireCondition(
      record.expiredAt === null,
      410,
      "artifact_expired",
      "The artifact content expired under the configured evidence retention policy.",
    );
    const content = this.store.get<EvidenceContent>("evidenceAssets", id);
    requireCondition(
      content !== undefined,
      410,
      "artifact_missing",
      "The artifact content is no longer available.",
    );
    return { artifact: record.artifact, contentBase64: content.contentBase64 };
  }

  requireAvailable(artifact: InvestigationArtifactV1): void {
    const record = this.store.get<EvidenceMetadata>("evidenceMetadata", artifact.id);
    requireCondition(
      record !== undefined &&
        record.expiredAt === null &&
        this.store.has("evidenceAssets", artifact.id) &&
        investigationContentDigest(record.artifact) === investigationContentDigest(artifact),
      400,
      "artifact_not_registered",
      "Available evidence must have the exact verified stored identity before it can be referenced.",
    );
  }

  /** The lease recheck and aggregate quota reservation share one SQLite write transaction. */
  upload(artifact: InvestigationArtifactV1, contentBase64: string, assertLease: () => void): void {
    this.store.transaction(() => {
      assertLease();
      const previous = this.store.get<EvidenceMetadata>("evidenceMetadata", artifact.id);
      if (previous !== undefined) {
        requireCondition(
          investigationContentDigest(previous.artifact) === investigationContentDigest(artifact),
          409,
          "artifact_identity_conflict",
          "An artifact identity cannot be reused with different content.",
        );
        this.requireAvailable(artifact);
        return;
      }
      const usage = this.usage();
      requireCondition(
        artifact.byteLength <= this.policy.maximumBytes - usage.bytes &&
          usage.count < this.policy.maximumCount,
        409,
        "evidence_quota_exceeded",
        "The evidence storage quota is exhausted. Retention cleanup or a configured capacity increase is required before another upload.",
      );
      this.store.insert("evidenceAssets", artifact.id, { contentBase64 });
      this.store.insert("evidenceMetadata", artifact.id, {
        artifact,
        storedAt: this.now().toISOString(),
        expiredAt: null,
        checkpointRetained: false,
      } satisfies EvidenceMetadata);
      this.store.put("evidenceUsage", "global", {
        ...usage,
        bytes: usage.bytes + artifact.byteLength,
        count: usage.count + 1,
      });
    });
  }

  /** Called in the task admission transaction; historical unrelated patches are not prerequisites. */
  requireTaskSources(task: InvestigationTaskV1, parent: InvestigationResultV1 | null): void {
    const required = requiredPatchSubjects(task);
    const parentArtifacts = [
      ...(parent?.artifacts ?? []),
      ...(parent?.context.sourceArtifacts ?? []),
    ];
    for (const subject of task.subjects) {
      if (subject.kind !== "local_patch" || !required.has(subject.id)) continue;
      const artifact = this.artifact(subject.artifactRef);
      requireCondition(
        artifact.kind === "patch" &&
          artifact.subjectRef === subject.id &&
          artifact.digest === subject.patchDigest &&
          (artifact.taskId === task.id ||
            parentArtifacts.some(
              (entry) => investigationContentDigest(entry) === investigationContentDigest(artifact),
            )),
        409,
        "plan_patch_unavailable",
        "The selected patch must be available through this task or its exact saved parent report.",
      );
      this.requireAvailable(artifact);
    }
  }

  /** Retain the direct parent and required inherited source producers until the child completes. */
  pinParent(task: InvestigationTaskV1): void {
    for (const parentTaskId of pinnedSourceTasks(task))
      this.store.insert("evidencePins", parentPinId(parentTaskId, task.id), {
        parentTaskId,
        childTaskId: task.id,
      });
  }

  releaseParent(task: InvestigationTaskV1): void {
    for (const parentTaskId of pinnedSourceTasks(task))
      this.store.delete("evidencePins", parentPinId(parentTaskId, task.id));
  }

  /** Runs in the accepted checkpoint transaction; cleanup never needs to parse a checkpoint. */
  retainCheckpoint(artifacts: readonly InvestigationArtifactV1[]): void {
    for (const artifact of artifacts) {
      if (artifact.availability !== "available") continue;
      this.requireAvailable(artifact);
      const metadata = this.metadata(artifact.id);
      if (!metadata.checkpointRetained)
        this.store.put("evidenceMetadata", artifact.id, { ...metadata, checkpointRetained: true });
    }
  }

  private isProtected(record: EvidenceMetadata): boolean {
    const task = this.store.get<InvestigationTaskV1>("tasks", record.artifact.taskId);
    if (task === undefined || task.state === "queued" || task.state === "running") return true;
    if (this.store.hasPrefix("evidencePins", parentPinPrefix(task.id))) return true;
    if (task.state === "completed") return false;
    // Even a complete checkpoint may await durable final delivery after lease loss.
    return record.checkpointRetained;
  }

  /** Scans at most one configured metadata page; content bytes are never loaded by cleanup. */
  cleanup(): { scanned: number; expired: number; releasedBytes: number } {
    return this.store.transaction(() => {
      const usage = this.usage();
      const page = this.store.page<EvidenceMetadata>(
        "evidenceMetadata",
        usage.cleanupCursor,
        this.policy.cleanupBatchSize,
      );
      const now = this.now();
      let expired = 0;
      let releasedBytes = 0;
      for (const record of page) {
        if (record.expiredAt !== null || this.isProtected(record)) continue;
        const task = this.store.get<InvestigationTaskV1>("tasks", record.artifact.taskId);
        if (task === undefined) continue;
        const ageFrom = Math.max(Date.parse(record.storedAt), Date.parse(task.updatedAt));
        if (
          !Number.isFinite(ageFrom) ||
          now.getTime() - ageFrom < this.policy.retentionSeconds * 1_000
        )
          continue;
        this.store.delete("evidenceAssets", record.artifact.id);
        this.store.put("evidenceMetadata", record.artifact.id, {
          ...record,
          expiredAt: now.toISOString(),
        });
        expired++;
        releasedBytes += record.artifact.byteLength;
      }
      requireCondition(
        usage.count >= expired && usage.bytes >= releasedBytes,
        500,
        "evidence_usage_mismatch",
        "Evidence quota accounting is inconsistent; cleanup was rolled back.",
      );
      this.store.put("evidenceUsage", "global", {
        bytes: usage.bytes - releasedBytes,
        count: usage.count - expired,
        cleanupCursor: page.length < this.policy.cleanupBatchSize ? "" : page.at(-1)!.artifact.id,
      } satisfies EvidenceUsage);
      return { scanned: page.length, expired, releasedBytes };
    });
  }
}
