import {
  type InvestigationCommentPublicationSummary,
  type InvestigationCurrentComment,
  type InvestigationFindingSource,
  type InvestigationGitHubUser,
  type InvestigationNativePromptBinding,
  InvestigationNativePromptBindRequestSchema,
  type InvestigationNativePromptCatalog,
  type InvestigationNativePromptKind,
  InvestigationNativePromptKindSchema,
  InvestigationNativePromptPublishRequestSchema,
  type InvestigationNativePromptVersion,
  InvestigationPublicationRecoveryRequestSchema,
  type InvestigationPublicationRecoveryStatus,
  type InvestigationResultV1,
  type InvestigationWorkItemAuthor,
  maximumNativePromptContentBytes,
  nativePromptBuiltInContent,
  nativePromptRuntimeConstraints,
} from "@agentic-review/contracts";
import { Value } from "@sinclair/typebox/value";
import type { InvestigationApi, Repository, TaskDetail, WorkItem } from "./api";
import { InvestigationHttpError } from "./transport";

interface SampleConsoleState {
  repository(): Repository;
  workItems(): readonly WorkItem[];
  tasks(): readonly TaskDetail[];
  reports(): readonly InvestigationResultV1[];
  comments(): readonly InvestigationCommentPublicationSummary[];
  commentBodies(): ReadonlyMap<string, string>;
}

type ConsoleCapabilities = Pick<
  InvestigationApi,
  | "nativePrompts"
  | "publishNativePrompt"
  | "bindNativePrompt"
  | "repositoryIntakeDetails"
  | "repositoryGitHubUser"
  | "currentComment"
  | "findingSource"
  | "workItemAuthor"
  | "publicationRecovery"
  | "recoverPublication"
>;

const sampleTime = "2026-09-15T03:00:00.000Z";
const kinds = ["pr-review", "issue-investigate"] as const;
const sampleProfiles: readonly InvestigationGitHubUser[] = [
  { githubUserId: 910_001, login: "sample-reviewer", avatarUrl: null, htmlUrl: null },
  { githubUserId: 910_002, login: "sample-requester", avatarUrl: null, htmlUrl: null },
  { githubUserId: 910_003, login: "sample-author", avatarUrl: null, htmlUrl: null },
];

export function sampleWorkItemAuthor(): InvestigationGitHubUser {
  return structuredClone(sampleProfiles[2]!);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new InvestigationHttpError(404, `The development sample ${label} was not found.`);
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

async function contentDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonicalValue(value))),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function promptRef({ id, version, digest }: InvestigationNativePromptVersion) {
  return { id, version, digest };
}

/** Console samples retain isolated synthetic state and never contact GitHub or a Worker. */
export function createSampleConsoleCapabilities(state: SampleConsoleState): ConsoleCapabilities {
  let catalogPromise: Promise<InvestigationNativePromptCatalog> | undefined;

  function repository(repositoryId: string): Repository {
    const value = state.repository();
    if (value.id !== repositoryId) {
      throw new InvestigationHttpError(404, "The development sample repository was not found.");
    }
    return value;
  }

  function kindInput(kind: InvestigationNativePromptKind): void {
    if (!Value.Check(InvestigationNativePromptKindSchema, kind)) {
      throw new InvestigationHttpError(
        400,
        "Choose a native PR review or Issue investigation prompt.",
      );
    }
  }

  function catalog(): Promise<InvestigationNativePromptCatalog> {
    catalogPromise ??= (async () => ({
      repositoryId: state.repository().id,
      items: await Promise.all(
        kinds.map(async (kind) => {
          const content = nativePromptBuiltInContent(kind);
          const version: InvestigationNativePromptVersion = {
            repositoryId: state.repository().id,
            kind,
            id: `sample-native-${kind}-v1`,
            version: 1,
            digest: await contentDigest(content),
            name: "Built-in review prompt",
            content,
            createdAt: sampleTime,
            createdBy: null,
          };
          return {
            kind,
            versions: [version],
            binding: {
              version: 0,
              promptRef: promptRef(version),
              updatedAt: null,
              updatedBy: null,
            },
            runtimeConstraints: nativePromptRuntimeConstraints({
              kind,
              analysisTask: true,
              snapshotOnly: true,
              autonomousSnapshot: kind === "issue-investigate",
              recipeGuidance: ["{{task_recipe_guidance}}"],
              baselineGuidance: ["{{frozen_prior_review_baseline_guidance}}"],
            }),
          };
        }),
      ),
    }))();
    return catalogPromise;
  }

  async function entry(repositoryId: string, kind: InvestigationNativePromptKind) {
    repository(repositoryId);
    kindInput(kind);
    return required(
      (await catalog()).items.find((item) => item.kind === kind),
      "prompt kind",
    );
  }

  async function publicationRecovery(
    taskId: string,
  ): Promise<InvestigationPublicationRecoveryStatus> {
    const detail = required(
      state.tasks().find((item) => item.task.id === taskId),
      "task",
    );
    repository(detail.task.repository.id);
    const publication = state.comments().find((item) => item.taskId === taskId) ?? null;
    const reportId = detail.task.latestReportRef?.id ?? null;
    const status = {
      taskId,
      reportId,
      state: "blocked" as const,
      blocker: "publisher_unavailable" as const,
      publication,
      availableActions: [],
    };
    return structuredClone({
      ...status,
      version: await contentDigest({ ...status, reportRef: detail.task.latestReportRef }),
    });
  }

  return {
    async workItemAuthor(id, signal) {
      signal?.throwIfAborted();
      const item = required(
        state.workItems().find((value) => value.id === id),
        "work item",
      );
      repository(item.repositoryId);
      const value: InvestigationWorkItemAuthor = {
        workItemId: item.id,
        repositoryId: item.repositoryId,
        author: item.author ?? null,
        source: item.author ? "stored" : "unavailable",
        ...(item.author ? {} : { reason: "sample_author_unavailable" }),
      };
      signal?.throwIfAborted();
      return structuredClone(value);
    },
    async publicationRecovery(taskId, signal) {
      signal?.throwIfAborted();
      const value = await publicationRecovery(taskId);
      signal?.throwIfAborted();
      return value;
    },
    async recoverPublication(taskId, input) {
      required(
        state.tasks().find((item) => item.task.id === taskId),
        "task",
      );
      const request = structuredClone(input);
      if (!Value.Check(InvestigationPublicationRecoveryRequestSchema, request)) {
        throw new InvestigationHttpError(
          400,
          "Use an exact sample report, recovery version, and idempotency key.",
        );
      }
      const current = await publicationRecovery(taskId);
      if (current.version !== request.version || current.reportId !== request.reportId) {
        throw new InvestigationHttpError(
          409,
          "The sample task or publication changed. Refresh before retrying.",
        );
      }
      throw new InvestigationHttpError(
        409,
        "Saved report publication is unavailable in isolated development samples. No publisher was started.",
      );
    },
    async nativePrompts(repositoryId, signal) {
      signal?.throwIfAborted();
      repository(repositoryId);
      const value = await catalog();
      signal?.throwIfAborted();
      return structuredClone(value);
    },
    async publishNativePrompt(repositoryId, kind, input) {
      repository(repositoryId);
      kindInput(kind);
      const request = structuredClone(input);
      if (
        !Value.Check(InvestigationNativePromptPublishRequestSchema, request) ||
        request.name.trim().length === 0 ||
        Object.values(request.content).some((content) => content.trim().length === 0) ||
        new TextEncoder().encode(JSON.stringify(request.content)).byteLength >
          maximumNativePromptContentBytes
      ) {
        throw new InvestigationHttpError(
          400,
          "Use a name and non-empty native prompt templates within the content limit.",
        );
      }
      const item = await entry(repositoryId, kind);
      const digest = await contentDigest(request.content);
      if (item.versions[0]!.version !== request.expectedVersion) {
        throw new InvestigationHttpError(
          409,
          "The sample native prompt catalog changed. Refresh before publishing.",
        );
      }
      if (item.versions.length >= 250) {
        throw new InvestigationHttpError(
          409,
          "The sample native prompt catalog reached its version limit.",
        );
      }
      const version: InvestigationNativePromptVersion = {
        repositoryId,
        kind,
        id: `sample-native-${kind}-v${request.expectedVersion + 1}`,
        version: request.expectedVersion + 1,
        digest,
        name: request.name.trim(),
        content: request.content,
        createdAt: sampleTime,
        createdBy: "sample-operator",
      };
      item.versions.unshift(version);
      return structuredClone(version);
    },
    async bindNativePrompt(repositoryId, kind, input) {
      const request = structuredClone(input);
      if (!Value.Check(InvestigationNativePromptBindRequestSchema, request)) {
        throw new InvestigationHttpError(
          400,
          "Use an exact sample prompt reference and binding version.",
        );
      }
      const item = await entry(repositoryId, kind);
      if (item.binding.version !== request.expectedVersion) {
        throw new InvestigationHttpError(
          409,
          "The sample native prompt binding changed. Refresh before switching.",
        );
      }
      if (
        !item.versions.some(
          (version) =>
            version.id === request.promptRef.id &&
            version.version === request.promptRef.version &&
            version.digest === request.promptRef.digest,
        )
      ) {
        throw new InvestigationHttpError(
          409,
          "The exact sample prompt version is unavailable for this repository and review type.",
        );
      }
      const binding: InvestigationNativePromptBinding = {
        version: item.binding.version + 1,
        promptRef: request.promptRef,
        updatedAt: sampleTime,
        updatedBy: "sample-operator",
      };
      item.binding = binding;
      return structuredClone(binding);
    },
    async repositoryIntakeDetails(repositoryId) {
      repository(repositoryId);
      return {
        repositoryId,
        canonicalWebhookUrl: "https://sample.invalid/api/github/webhook",
        webhookUrlSource: "explicit",
        receiverConfigured: false,
        lastDelivery: null,
        observedAt: sampleTime,
      };
    },
    async repositoryGitHubUser(repositoryId, lookup) {
      repository(repositoryId);
      const value = lookup.trim();
      if (!/^(?:[1-9]\d*|[a-z\d](?:[a-z\d-]{0,38}))$/iu.test(value)) {
        throw new InvestigationHttpError(400, "Use a synthetic sample login or numeric user ID.");
      }
      return structuredClone(
        required(
          sampleProfiles.find(
            (profile) =>
              profile.login.toLowerCase() === value.toLowerCase() ||
              String(profile.githubUserId) === value,
          ),
          "GitHub profile",
        ),
      );
    },
    async currentComment(id, signal) {
      signal?.throwIfAborted();
      const comment = required(
        state.comments().find((item) => item.id === id),
        "comment",
      );
      repository(comment.repositoryId);
      const confirmedBody =
        comment.state === "synced" && comment.lastConfirmedAt !== null
          ? (state.commentBodies().get(id) ?? null)
          : null;
      const value: InvestigationCurrentComment = {
        commentId: comment.id,
        repositoryId: comment.repositoryId,
        repositoryFullName: comment.repositoryFullName,
        workItemId: comment.workItemId,
        workItemNumber: comment.workItemNumber,
        externalId: comment.externalId,
        checkedAt: sampleTime,
        state:
          comment.externalId === null
            ? "not_published"
            : confirmedBody === null
              ? "unavailable"
              : "present",
        comparison: confirmedBody === null ? "unknown" : "matches_confirmation",
        reasonCode:
          comment.externalId === null
            ? "sample_not_published"
            : confirmedBody === null
              ? "sample_current_comment_unavailable"
              : "sample_retained_confirmation",
        body: confirmedBody,
        commentUrl: null,
        upstreamUpdatedAt: null,
        lastConfirmedAt: comment.lastConfirmedAt,
        lastConfirmedBody: confirmedBody,
      };
      signal?.throwIfAborted();
      return structuredClone(value);
    },
    async findingSource(reportId, findingId, query = {}, signal) {
      signal?.throwIfAborted();
      const locationIndex = query.locationIndex ?? 0;
      if (
        !Number.isSafeInteger(locationIndex) ||
        locationIndex < 0 ||
        Object.keys(query).some((key) => key !== "locationIndex")
      ) {
        throw new InvestigationHttpError(400, "Use a valid sample finding location index.");
      }
      const report = required(
        state.reports().find((item) => item.id === reportId),
        "report",
      );
      repository(report.context.repository.id);
      required(
        state
          .workItems()
          .find(
            (item) =>
              item.id === report.context.workItem.id &&
              item.repositoryId === report.context.repository.id,
          ),
        "work item",
      );
      required(
        state
          .tasks()
          .find(
            (item) =>
              item.task.id === report.context.task.id &&
              item.task.repository.id === report.context.repository.id,
          ),
        "task",
      );
      const finding = required(
        report.findings.find((item) => item.id === findingId),
        "finding",
      );
      const location = required(finding.locations[locationIndex], "finding location");
      const subject = report.context.subjects.find((item) => item.id === location.subjectRef);
      const source = location.kind === "source" ? location : null;
      const commitSha =
        subject?.kind === "original_pr" || subject?.kind === "remote_branch"
          ? subject.headSha
          : subject?.kind === "source_commit"
            ? subject.commitSha
            : null;
      const value: InvestigationFindingSource = {
        reportRef: {
          id: report.id,
          version: report.version,
          digest: report.report.logicalContentDigest,
        },
        findingId: finding.id,
        findingVersion: finding.version,
        locationIndex,
        repositoryId: report.context.repository.id,
        repositoryFullName: report.context.repository.fullName,
        workItemId: report.context.workItem.id,
        subjectRef: location.subjectRef,
        revisionKey: subject?.revisionKey ?? null,
        commitSha,
        blobSha: null,
        contentDigest: null,
        path: source?.path ?? null,
        startLine: source?.startLine ?? null,
        endLine: source?.endLine ?? null,
        sourceRepositoryFullName: null,
        sourcePath: null,
        availability: "unavailable",
        reasonCode: "sample_source_unavailable",
        sourceUrl: null,
        checkedAt: sampleTime,
        contextStartLine: null,
        contextEndLine: null,
        truncated: false,
        lines: [],
      };
      signal?.throwIfAborted();
      return structuredClone(value);
    },
  };
}
