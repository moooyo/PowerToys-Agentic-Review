import type {
  InvestigationFindingSource,
  InvestigationFindingV1,
  InvestigationReportHeaderV1,
} from "@agentic-review/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { investigationApi } from "../investigation/api";
import { outputAccessDenied } from "../investigation/task-output";
import type { ConsoleText } from "./model";
import { ConsoleIcon, useConsolePreferences } from "./preferences";
import "./native-evidence.css";

export function findingSourceQueryKey(
  identity: string,
  header: InvestigationReportHeaderV1,
  finding: InvestigationFindingV1,
  locationIndex: number,
) {
  return [
    "console-finding-source",
    identity,
    header.id,
    header.version,
    header.report.logicalContentDigest,
    finding.id,
    finding.version,
    locationIndex,
  ];
}

export function assertFindingSourceBinding(
  value: InvestigationFindingSource,
  header: InvestigationReportHeaderV1,
  finding: InvestigationFindingV1,
  locationIndex: number,
): void {
  const location = finding.locations[locationIndex];
  const subject = header.context.subjects.find((entry) => entry.id === location?.subjectRef);
  if (
    value.reportRef.id !== header.id ||
    value.reportRef.version !== header.version ||
    value.reportRef.digest !== header.report.logicalContentDigest ||
    value.findingId !== finding.id ||
    value.findingVersion !== finding.version ||
    value.locationIndex !== locationIndex ||
    value.repositoryId !== header.context.repository.id ||
    value.repositoryFullName !== header.context.repository.fullName ||
    value.workItemId !== header.context.workItem.id ||
    value.subjectRef !== (location?.subjectRef ?? null) ||
    value.revisionKey !== (subject?.revisionKey ?? null) ||
    value.path !== (location?.kind === "source" ? location.path : null) ||
    value.startLine !== (location?.kind === "source" ? location.startLine : null) ||
    value.endLine !== (location?.kind === "source" ? location.endLine : null)
  )
    throw new Error(
      "The source context does not match the selected report, finding, and saved location.",
    );
  if (value.availability !== "available") return;
  let commit =
    subject?.kind === "source_commit"
      ? subject.commitSha
      : subject?.kind === "original_pr" || subject?.kind === "remote_branch"
        ? subject.headSha
        : null;
  let repository = header.context.repository.fullName;
  let path = location?.kind === "source" ? location.path : null;
  const provenance = header.context.sourceProvenance;
  if (provenance?.subjectRef === subject?.id && provenance?.sourceSha === commit && path !== null) {
    const submodule = provenance.submodules
      .filter((entry) => path!.startsWith(`${entry.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (submodule) {
      commit = submodule.commitSha;
      repository = submodule.repository;
      path = path.slice(submodule.path.length + 1);
    }
  }
  const url =
    path === null
      ? null
      : `https://github.com/${repository}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}#L${value.startLine}-L${value.endLine}`;
  if (
    value.commitSha !== commit ||
    value.sourceRepositoryFullName !== repository ||
    value.sourcePath !== path ||
    value.sourceUrl !== url ||
    value.blobSha === null ||
    value.contentDigest === null ||
    value.lines.length === 0 ||
    value.lines[0]?.number !== value.contextStartLine ||
    value.lines.at(-1)?.number !== value.contextEndLine ||
    value.lines.some(
      (line, index) =>
        line.number !== value.contextStartLine! + index ||
        line.inFinding !== (line.number >= value.startLine! && line.number <= value.endLine!),
    )
  )
    throw new Error(
      "The source content is not bound to the saved immutable revision and line range.",
    );
}

function sourceReason(code: string | null, text: ConsoleText): string {
  switch (code) {
    case "finding_has_no_source_location":
      return text("此发现未保存源码位置。", "This finding has no saved source location.");
    case "immutable_source_revision_unavailable":
      return text(
        "未保存可读取的不可变源码提交。",
        "No readable immutable source commit was saved.",
      );
    case "github_not_configured":
      return text(
        "GitHub 连接尚未配置，无法读取源码。",
        "The GitHub connection is not configured, so source cannot be read.",
      );
    case "github_authentication_failed":
      return text(
        "GitHub 身份验证失败，无法读取源码。",
        "GitHub authentication failed. Source cannot be read.",
      );
    case "github_access_denied":
      return text(
        "GitHub 拒绝访问，请检查读取权限或请求限制。",
        "GitHub denied access. Check read permissions or request limits.",
      );
    case "github_not_found_or_inaccessible":
      return text(
        "保存的提交或文件不存在，或当前身份无权读取。",
        "The saved commit or file is missing or inaccessible.",
      );
    case "source_subject_binding_invalid":
      return text(
        "保存的源码主体与发现来源不符。",
        "The saved source subject does not match the finding.",
      );
    case "repository_identity_changed":
      return text(
        "仓库名称对应的 GitHub 仓库身份已变化，无法读取原始源码。",
        "The repository name now resolves to a different GitHub repository. The original source cannot be read.",
      );
    case "saved_source_path_unavailable":
      return text(
        "保存的文件路径在该提交中不存在。",
        "The saved file path does not exist in this commit.",
      );
    case "source_path_type_unsupported":
      return text(
        "保存的路径不是可显示的普通源码文件。",
        "The saved path is not a regular source file that can be displayed.",
      );
    case "saved_source_range_unavailable":
      return text(
        "保存的行范围在该提交的文件中不可用。",
        "The saved line range is unavailable in this commit's file.",
      );
    case "source_encoding_unsupported":
      return text(
        "此文件的编码或内容无法作为文本显示。",
        "This file's encoding or content cannot be displayed as text.",
      );
    default:
      return text(
        "无法读取与报告绑定的原始源码。",
        "The original source bound to this report could not be read.",
      );
  }
}

export function FindingSourceView({
  value,
  text,
}: {
  value: InvestigationFindingSource;
  text: ConsoleText;
}) {
  const expectedUrl =
    value.commitSha && value.sourceRepositoryFullName && value.sourcePath
      ? `https://github.com/${value.sourceRepositoryFullName}/blob/${value.commitSha}/${value.sourcePath.split("/").map(encodeURIComponent).join("/")}#L${value.startLine}-L${value.endLine}`
      : null;
  return (
    <div className="rc-finding-source">
      <div className="rc-source-heading">
        <ConsoleIcon name="code" size={18} />
        <strong>{text("原始源码上下文", "Original source context")}</strong>
        {value.commitSha && <code title={value.commitSha}>{value.commitSha.slice(0, 12)}</code>}
      </div>
      {value.path && (
        <div className="rc-source-position">
          <code>
            {value.path}:{value.startLine}
            {value.endLine !== value.startLine ? `–${value.endLine}` : ""}
          </code>
        </div>
      )}
      {value.availability === "available" ? (
        <>
          <pre className="rc-source-lines">
            <code>
              {value.lines.map((line) => (
                <span
                  key={line.number}
                  className={`rc-source-line${line.inFinding ? " rc-source-line-selected" : ""}`}
                >
                  <span className="rc-source-line-number" aria-hidden="true">
                    {line.number}
                  </span>
                  <span>{line.text || " "}</span>
                </span>
              ))}
            </code>
          </pre>
          {value.truncated && (
            <p className="rc-native-message">
              {text(
                "行范围较长，当前显示前 200 行上下文。",
                "The range is long. The first 200 context lines are shown.",
              )}
            </p>
          )}
          {value.sourceUrl && value.sourceUrl === expectedUrl && (
            <a
              className="rc-source-link"
              href={value.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {text("在 GitHub 查看此提交", "View this commit on GitHub")}
              <ConsoleIcon name="open_in_new" size={16} />
            </a>
          )}
        </>
      ) : (
        <p className="rc-native-message" role="status">
          {sourceReason(value.reasonCode, text)}
        </p>
      )}
    </div>
  );
}

export function FindingSource({
  header,
  finding,
  identity,
}: {
  header: InvestigationReportHeaderV1;
  finding: InvestigationFindingV1;
  identity: string;
}) {
  const { text } = useConsolePreferences();
  const locationId = useId();
  const sourceLocations = finding.locations
    .map((location, index) => ({ location, index }))
    .filter(({ location }) => location.kind === "source");
  const [selected, setSelected] = useState(sourceLocations[0]?.index ?? 0);
  const locationIndex =
    finding.locations[selected]?.kind === "source" ? selected : (sourceLocations[0]?.index ?? 0);
  const query = useQuery({
    queryKey: findingSourceQueryKey(identity, header, finding, locationIndex),
    enabled: sourceLocations.length > 0,
    queryFn: async ({ signal }) => {
      const value = await investigationApi.findingSource(
        header.id,
        finding.id,
        { locationIndex },
        signal,
      );
      assertFindingSourceBinding(value, header, finding, locationIndex);
      return value;
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const value = outputAccessDenied(query.error) ? undefined : query.data;
  const suggestion = finding.feedbackDraft.suggestion;
  return (
    <section className="rc-source-reader" aria-label={text("发现的源码", "Finding source")}>
      {sourceLocations.length > 1 && (
        <div className="rc-source-picker">
          <label htmlFor={locationId}>{text("源码位置", "Source location")}</label>
          <select
            id={locationId}
            value={locationIndex}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {sourceLocations.map(({ location, index }) => (
              <option value={index} key={index}>
                {location.kind === "source"
                  ? `${location.path}:${location.startLine}–${location.endLine}`
                  : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      {sourceLocations.length === 0 ? (
        <p className="rc-native-message">{sourceReason("finding_has_no_source_location", text)}</p>
      ) : query.isError ? (
        <div className="rc-native-read-error" role="alert">
          {text("原始源码读取失败", "Original source could not be read")}
          <button
            type="button"
            className="rc-native-refresh"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {text("重试", "Retry")}
          </button>
        </div>
      ) : value ? (
        <FindingSourceView value={value} text={text} />
      ) : (
        <div className="rc-native-loading" role="status">
          {text("正在读取报告保存的源码提交…", "Reading the source commit saved in the report…")}
        </div>
      )}
      {suggestion && (
        <details className="rc-source-suggestion">
          <summary>{text("建议替换内容", "Proposed replacement")}</summary>
          <p className="rc-native-message">
            {text(
              "以下内容来自修复建议，尚未应用。",
              "This content is a suggested fix and has not been applied.",
            )}
          </p>
          <pre>{suggestion.replacement}</pre>
        </details>
      )}
    </section>
  );
}
