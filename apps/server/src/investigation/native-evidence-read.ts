import { createHash } from "node:crypto";
import type {
  InvestigationCommentDelivery,
  InvestigationCommentPublicationSummary,
  InvestigationCurrentComment,
  InvestigationFindingSource,
  InvestigationResultV1,
} from "@agentic-review/contracts";
import { requireCondition } from "./errors.js";
import type { CommentPublication } from "./progress-publication.js";
import type { InvestigationStore } from "./store.js";
import type { InvestigationOperatorPrincipal, InvestigationRepositoryRecord } from "./types.js";

export interface InvestigationNativeEvidenceReadsOptions {
  readonly store: Pick<InvestigationStore, "get" | "pageCommentDeliveries">;
  readonly readComment: (
    actor: InvestigationOperatorPrincipal,
    id: string,
  ) => InvestigationCommentPublicationSummary;
  readonly readReport: (actor: InvestigationOperatorPrincipal, id: string) => InvestigationResultV1;
  readonly github?: { readonly token: string };
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
  readonly maximumBytes?: number;
}

class UpstreamReadError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new UpstreamReadError("invalid_github_response");
  return value as Record<string, unknown>;
};
const validRepository = (value: string): boolean =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) &&
  value.split("/").every((part) => part !== "." && part !== "..");
const repositoryPath = (value: string): string =>
  `/repos/${value.split("/").map(encodeURIComponent).join("/")}`;
const safePath = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 4_096 &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Saved source paths must reject ASCII control characters before constructing GitHub requests.
  !/[\\\x00-\x1f\x7f:*?[\]]/u.test(value) &&
  value.split("/").length <= 128 &&
  value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
const validSha = (value: string): boolean => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value);
const date = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

/** These readers issue GET requests only and never alter native publication or delivery records. */
export class InvestigationNativeEvidenceReads {
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly options: InvestigationNativeEvidenceReadsOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private async get(path: string): Promise<unknown> {
    if (this.options.github === undefined) throw new UpstreamReadError("github_not_configured");
    try {
      const response = await this.fetch(`https://api.github.com${path}`, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.options.github.token}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000),
      });
      if (!response.ok)
        throw new UpstreamReadError(
          response.status === 401
            ? "github_authentication_failed"
            : response.status === 403
              ? "github_access_denied"
              : response.status === 404
                ? "github_not_found_or_inaccessible"
                : response.status === 429
                  ? "github_rate_limited"
                  : "github_read_failed",
          response.status,
        );
      const maximum = this.options.maximumBytes ?? 2 * 1024 * 1024;
      const declared = Number(response.headers.get("content-length"));
      if (declared > maximum) throw new UpstreamReadError("github_response_too_large");
      if (response.body === null) throw new UpstreamReadError("invalid_github_response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > maximum) throw new UpstreamReadError("github_response_too_large");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        throw new UpstreamReadError("invalid_github_response");
      }
    } catch (error) {
      if (error instanceof UpstreamReadError) throw error;
      throw new UpstreamReadError("github_read_failed");
    }
  }

  private confirmedBody(summary: InvestigationCommentPublicationSummary): string | null {
    if (summary.externalId === null) return null;
    if (summary.mode === "progress") {
      const publication = this.options.store.get<CommentPublication>("idempotency", summary.id);
      const confirmed = publication?.confirmed;
      if (
        publication?.schemaVersion === 2 &&
        publication.id === summary.id &&
        publication.repository.id === summary.repositoryId &&
        publication.repository.fullName === summary.repositoryFullName &&
        publication.target.number === summary.workItemNumber &&
        publication.workItemId === summary.workItemId &&
        confirmed?.externalId === summary.externalId &&
        confirmed.confirmedAt === summary.lastConfirmedAt &&
        typeof confirmed.body === "string"
      )
        return confirmed.body;
    }
    let before: { startedAt: string; id: string } | undefined;
    for (let page = 0; page < 100; page++) {
      const attempts = this.options.store.pageCommentDeliveries<InvestigationCommentDelivery>({
        repositoryIds: [summary.repositoryId],
        commentId: summary.id,
        ...(before === undefined ? {} : { before }),
        limit: 100,
      });
      for (const attempt of attempts) {
        if (
          attempt.repositoryFullName !== summary.repositoryFullName ||
          attempt.workItemNumber !== summary.workItemNumber ||
          attempt.externalId !== summary.externalId ||
          attempt.body === null ||
          attempt.state !== "succeeded"
        )
          continue;
        const confirmedAt =
          attempt.observations.filter((entry) => entry.state === "succeeded").at(-1)?.at ??
          (attempt.state === "succeeded" ? attempt.finishedAt : null);
        if (
          (confirmedAt === null && summary.lastConfirmedAt === null) ||
          (confirmedAt !== null &&
            summary.lastConfirmedAt !== null &&
            Date.parse(confirmedAt) === Date.parse(summary.lastConfirmedAt))
        )
          return attempt.body;
      }
      const last = attempts.at(-1);
      if (attempts.length < 100 || last === undefined) break;
      before = { startedAt: last.startedAt, id: last.id };
    }
    return null;
  }

  private async verifyRepository(fullName: string, githubRepositoryId: number): Promise<void> {
    if (!Number.isSafeInteger(githubRepositoryId) || githubRepositoryId < 1)
      throw new UpstreamReadError("saved_repository_identity_unavailable");
    const repository = object(await this.get(repositoryPath(fullName)));
    if (
      repository.id !== githubRepositoryId ||
      typeof repository.full_name !== "string" ||
      repository.full_name.toLowerCase() !== fullName.toLowerCase()
    )
      throw new UpstreamReadError("repository_identity_changed");
  }

  private async sourceBlob(
    repository: string,
    commitSha: string,
    sourcePath: string,
  ): Promise<{ bytes: Buffer; blobSha: string }> {
    const base = repositoryPath(repository);
    const commit = object(await this.get(`${base}/git/commits/${commitSha}`));
    const tree = object(commit.tree);
    if (commit.sha !== commitSha || typeof tree.sha !== "string" || !validSha(tree.sha))
      throw new UpstreamReadError("source_commit_identity_invalid");
    let treeSha = tree.sha;
    const parts = sourcePath.split("/");
    let blobSha: string | null = null;
    for (const [index, part] of parts.entries()) {
      const directory = object(await this.get(`${base}/git/trees/${treeSha}`));
      if (
        directory.sha !== treeSha ||
        directory.truncated === true ||
        !Array.isArray(directory.tree)
      )
        throw new UpstreamReadError("source_tree_unavailable");
      const matches = directory.tree.map(object).filter((entry) => entry.path === part);
      if (matches.length !== 1) throw new UpstreamReadError("saved_source_path_unavailable");
      const entry = matches[0]!;
      if (typeof entry.sha !== "string" || !validSha(entry.sha))
        throw new UpstreamReadError("source_content_identity_invalid");
      if (index < parts.length - 1) {
        if (entry.type !== "tree" || entry.mode !== "040000")
          throw new UpstreamReadError("source_path_type_unsupported");
        treeSha = entry.sha;
      } else {
        if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755"))
          throw new UpstreamReadError("source_path_type_unsupported");
        blobSha = entry.sha;
      }
    }
    if (blobSha === null) throw new UpstreamReadError("saved_source_path_unavailable");
    const file = object(await this.get(`${base}/git/blobs/${blobSha}`));
    if (
      file.sha !== blobSha ||
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new UpstreamReadError("source_content_identity_invalid");
    const encoded = file.content.replace(/\s/gu, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded))
      throw new UpstreamReadError("source_content_invalid");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength !== file.size) throw new UpstreamReadError("source_content_size_mismatch");
    if (bytes.byteLength > (this.options.maximumBytes ?? 2 * 1024 * 1024))
      throw new UpstreamReadError("source_content_too_large");
    const blobHash = createHash(blobSha.length === 64 ? "sha256" : "sha1")
      .update(`blob ${bytes.byteLength}\0`)
      .update(bytes)
      .digest("hex");
    if (blobHash !== blobSha) throw new UpstreamReadError("source_content_digest_mismatch");
    return { bytes, blobSha };
  }

  async currentComment(
    actor: InvestigationOperatorPrincipal,
    id: string,
  ): Promise<InvestigationCurrentComment> {
    if (!id.startsWith("auto-reply:report:")) {
      const raw = this.options.store.get<{
        id?: unknown;
        schemaVersion?: unknown;
        repository?: InvestigationRepositoryRecord;
        workItem?: { id?: unknown; repositoryId?: unknown; number?: unknown };
        published?: { externalId?: unknown; body?: unknown } | null;
        operation?: { request?: { externalId?: unknown } } | null;
      }>("idempotency", id);
      requireCondition(
        raw !== undefined && raw.id === id && typeof raw.repository?.id === "string",
        404,
        "comment_not_found",
        "The saved comment publication is unavailable.",
      );
      requireCondition(
        actor.repositoryIds.includes(raw.repository.id),
        403,
        "repository_forbidden",
        "This identity has no access to the repository.",
      );
      if (raw.schemaVersion !== 2) {
        requireCondition(
          validRepository(raw.repository.fullName) &&
            typeof raw.workItem?.id === "string" &&
            raw.workItem.repositoryId === raw.repository.id &&
            typeof raw.workItem.number === "number" &&
            Number.isSafeInteger(raw.workItem.number) &&
            raw.workItem.number > 0,
          409,
          "comment_identity_mismatch",
          "The saved comment source identity is invalid.",
        );
        return {
          commentId: id,
          repositoryId: raw.repository.id,
          repositoryFullName: raw.repository.fullName,
          workItemId: raw.workItem.id,
          workItemNumber: raw.workItem.number,
          externalId:
            typeof raw.published?.externalId === "string"
              ? raw.published.externalId
              : typeof raw.operation?.request?.externalId === "string"
                ? raw.operation.request.externalId
                : null,
          checkedAt: this.now(),
          state: "unavailable",
          comparison: "unknown",
          reasonCode: "legacy_comment_readback_unavailable",
          body: null,
          commentUrl: null,
          upstreamUpdatedAt: null,
          lastConfirmedAt: null,
          lastConfirmedBody: typeof raw.published?.body === "string" ? raw.published.body : null,
        };
      }
    }
    const summary = this.options.readComment(actor, id);
    requireCondition(
      summary.id === id,
      409,
      "comment_identity_mismatch",
      "The saved comment identity does not match this request.",
    );
    requireCondition(
      actor.repositoryIds.includes(summary.repositoryId),
      403,
      "repository_forbidden",
      "This identity has no access to the repository.",
    );
    const base: InvestigationCurrentComment = {
      commentId: summary.id,
      repositoryId: summary.repositoryId,
      repositoryFullName: summary.repositoryFullName,
      workItemId: summary.workItemId,
      workItemNumber: summary.workItemNumber,
      externalId: summary.externalId,
      checkedAt: this.now(),
      state: "unavailable",
      comparison: "unknown",
      reasonCode: null,
      body: null,
      commentUrl: null,
      upstreamUpdatedAt: null,
      lastConfirmedAt: summary.lastConfirmedAt,
      lastConfirmedBody: this.confirmedBody(summary),
    };
    if (summary.externalId === null)
      return { ...base, state: "not_published", reasonCode: "no_saved_comment_identity" };
    if (
      !/^[1-9][0-9]*$/u.test(summary.externalId) ||
      !Number.isSafeInteger(Number(summary.externalId)) ||
      !validRepository(summary.repositoryFullName)
    )
      return { ...base, reasonCode: "invalid_saved_comment_identity" };
    const path = repositoryPath(summary.repositoryFullName);
    const issueUrl = `https://api.github.com${path}/issues/${summary.workItemNumber}`;
    const saved = this.options.store.get<{
      repository: InvestigationRepositoryRecord;
      target?: { githubWorkItemId?: number };
    }>("idempotency", summary.id);
    const repository =
      saved?.repository?.id === summary.repositoryId &&
      saved.repository.fullName === summary.repositoryFullName
        ? saved.repository
        : undefined;
    let commentReadStarted = false;
    try {
      if (
        repository === undefined ||
        repository.id !== summary.repositoryId ||
        repository.fullName !== summary.repositoryFullName
      )
        throw new UpstreamReadError("saved_repository_identity_unavailable");
      await this.verifyRepository(summary.repositoryFullName, repository.githubRepositoryId);
      commentReadStarted = true;
      const comment = object(await this.get(`${path}/issues/comments/${summary.externalId}`));
      if (
        comment.id !== Number(summary.externalId) ||
        comment.issue_url !== issueUrl ||
        typeof comment.body !== "string" ||
        comment.body.length > 120_000 ||
        date(comment.updated_at) === null
      )
        throw new UpstreamReadError("comment_identity_mismatch");
      const comparison =
        base.lastConfirmedBody === null
          ? "unknown"
          : comment.body === base.lastConfirmedBody
            ? "matches_confirmation"
            : "differs_from_confirmation";
      return {
        ...base,
        state: comparison === "differs_from_confirmation" ? "edited" : "present",
        comparison,
        reasonCode: comparison === "unknown" ? "confirmed_content_unavailable" : null,
        body: comment.body,
        commentUrl: `https://github.com/${summary.repositoryFullName}/${summary.workItemKind === "pull_request" ? "pull" : "issues"}/${summary.workItemNumber}#issuecomment-${summary.externalId}`,
        upstreamUpdatedAt: date(comment.updated_at),
      };
    } catch (error) {
      if (commentReadStarted && error instanceof UpstreamReadError && error.status === 404) {
        try {
          const issue = object(await this.get(`${path}/issues/${summary.workItemNumber}`));
          if (
            issue.number !== summary.workItemNumber ||
            issue.url !== issueUrl ||
            (saved?.target?.githubWorkItemId !== undefined &&
              issue.id !== saved.target.githubWorkItemId)
          )
            throw new UpstreamReadError("target_identity_mismatch");
          return { ...base, state: "deleted", reasonCode: "comment_deleted" };
        } catch (targetError) {
          return {
            ...base,
            reasonCode:
              targetError instanceof UpstreamReadError ? targetError.code : "github_read_failed",
          };
        }
      }
      return {
        ...base,
        reasonCode: error instanceof UpstreamReadError ? error.code : "github_read_failed",
      };
    }
  }

  async findingSource(
    actor: InvestigationOperatorPrincipal,
    reportId: string,
    findingId: string,
    locationIndex = 0,
  ): Promise<InvestigationFindingSource> {
    const report = this.options.readReport(actor, reportId);
    requireCondition(
      report.report.id === reportId,
      409,
      "report_identity_mismatch",
      "The saved report identity does not match this request.",
    );
    requireCondition(
      actor.repositoryIds.includes(report.context.repository.id),
      403,
      "repository_forbidden",
      "This identity has no access to the repository.",
    );
    const finding = report.findings.find((entry) => entry.id === findingId);
    requireCondition(
      finding !== undefined,
      404,
      "finding_not_found",
      "The selected report does not contain that finding.",
    );
    requireCondition(
      Number.isSafeInteger(locationIndex) &&
        locationIndex >= 0 &&
        locationIndex < Math.max(1, finding.locations.length),
      400,
      "finding_location_invalid",
      "Choose an exact saved finding location.",
    );
    const location = finding.locations[locationIndex];
    const subject =
      location === undefined
        ? undefined
        : report.context.subjects.find((entry) => entry.id === location.subjectRef);
    let commitSha =
      subject?.kind === "source_commit"
        ? subject.commitSha
        : subject?.kind === "original_pr" || subject?.kind === "remote_branch"
          ? subject.headSha
          : null;
    const sourceLocation = location?.kind === "source" ? location : null;
    let sourceRepository = report.context.repository.fullName;
    let sourcePath = sourceLocation?.path ?? null;
    const base: InvestigationFindingSource = {
      reportRef: {
        id: report.report.id,
        version: report.report.version,
        digest: report.report.logicalContentDigest,
      },
      findingId: finding.id,
      findingVersion: finding.version,
      locationIndex,
      repositoryId: report.context.repository.id,
      repositoryFullName: report.context.repository.fullName,
      workItemId: report.context.workItem.id,
      subjectRef: location?.subjectRef ?? null,
      revisionKey: subject?.revisionKey ?? null,
      commitSha,
      blobSha: null,
      contentDigest: null,
      path: sourceLocation?.path ?? null,
      startLine: sourceLocation?.startLine ?? null,
      endLine: sourceLocation?.endLine ?? null,
      sourceRepositoryFullName: null,
      sourcePath: null,
      availability: "unavailable",
      reasonCode: null,
      sourceUrl: null,
      checkedAt: this.now(),
      contextStartLine: null,
      contextEndLine: null,
      truncated: false,
      lines: [],
    };
    if (sourceLocation === null) return { ...base, reasonCode: "finding_has_no_source_location" };
    if (
      subject === undefined ||
      subject.repositoryId !== report.context.repository.id ||
      subject.workItemId !== report.context.workItem.id ||
      sourceLocation.subjectRef !== finding.subjectRef
    )
      return { ...base, reasonCode: "source_subject_binding_invalid" };
    if (commitSha === null || !validSha(commitSha))
      return { ...base, reasonCode: "immutable_source_revision_unavailable" };
    if (
      sourcePath === null ||
      !safePath(sourcePath) ||
      !Number.isSafeInteger(sourceLocation.startLine) ||
      !Number.isSafeInteger(sourceLocation.endLine) ||
      sourceLocation.startLine < 1 ||
      sourceLocation.endLine < sourceLocation.startLine
    )
      return { ...base, reasonCode: "saved_source_location_invalid" };
    const provenance = report.context.sourceProvenance;
    if (provenance?.subjectRef === subject.id && provenance.sourceSha === commitSha) {
      const submodule = provenance.submodules
        .filter((entry) => sourcePath!.startsWith(`${entry.path}/`))
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (submodule !== undefined) {
        sourceRepository = submodule.repository;
        sourcePath = sourcePath.slice(submodule.path.length + 1);
        commitSha = submodule.commitSha;
      }
    }
    if (!validRepository(sourceRepository) || !safePath(sourcePath) || !validSha(commitSha))
      return { ...base, reasonCode: "saved_source_location_invalid" };
    const bound = { ...base, commitSha, sourceRepositoryFullName: sourceRepository, sourcePath };
    try {
      await this.verifyRepository(
        report.context.repository.fullName,
        report.context.repository.githubRepositoryId,
      );
      const { bytes, blobSha } = await this.sourceBlob(sourceRepository, commitSha, sourcePath);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new UpstreamReadError("source_encoding_unsupported");
      }
      if (content.includes("\0")) throw new UpstreamReadError("source_encoding_unsupported");
      const lines = content.split(/\r?\n/u);
      if (lines.at(-1) === "") lines.pop();
      if (sourceLocation.startLine > lines.length || sourceLocation.endLine > lines.length)
        throw new UpstreamReadError("saved_source_range_unavailable");
      const first = Math.max(1, sourceLocation.startLine - 6);
      const last = Math.min(lines.length, sourceLocation.endLine + 6, first + 199);
      return {
        ...bound,
        blobSha,
        contentDigest: createHash("sha256").update(bytes).digest("hex"),
        availability: "available",
        reasonCode: null,
        sourceUrl: `https://github.com/${sourceRepository}/blob/${commitSha}/${sourcePath.split("/").map(encodeURIComponent).join("/")}#L${sourceLocation.startLine}-L${sourceLocation.endLine}`,
        contextStartLine: first,
        contextEndLine: last,
        truncated: last < sourceLocation.endLine,
        lines: lines.slice(first - 1, last).map((text, index) => ({
          number: first + index,
          text,
          inFinding:
            first + index >= sourceLocation.startLine && first + index <= sourceLocation.endLine,
        })),
      };
    } catch (error) {
      return {
        ...bound,
        reasonCode: error instanceof UpstreamReadError ? error.code : "github_read_failed",
      };
    }
  }
}
